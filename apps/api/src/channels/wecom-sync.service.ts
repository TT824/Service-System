/**
 * The crash-safe `kf/sync_msg` pull behind a WeCom notification.
 *
 * A WeCom customer-service callback is one of two shapes, and both arrive on one
 * URL with one authentication:
 *
 * - a **direct message callback**, which carries the message itself and keeps the
 *   ingestion path it has always had; and
 * - a **`kf_msg_or_event` notification**, which carries no message at all — only
 *   a short-lived `Token` and an `OpenKfId` — and requires the platform to pull
 *   the backlog from `kf/sync_msg` with a cursor it must persist.
 *
 * Both shapes name the same account, and both resolve its tenant and store from
 * the same durable binding: the direct shape through the adapter's scope
 * resolver, which the module wires to `WecomBindingRepository`, and the
 * notification here.
 *
 * This service owns that second shape. Its order is deliberate:
 *
 * 1. **authenticate** — the provider's digest over the raw bytes is checked
 *    before anything is decrypted, so a notification can never be recognised
 *    from bytes the provider did not sign;
 * 2. **classify** — the transport decrypts once and says which shape it is;
 * 3. **resolve the persistent scope** — the account's *active* binding decides
 *    which tenant and store the pulled messages belong to. An unbound, disabled,
 *    ambiguous, missing-tenant, missing-store or cross-tenant binding resolves
 *    nothing and is refused with `503 channel_not_configured` before any pull,
 *    any receipt, any conversation and any message;
 * 4. **claim the cursor** — one atomic write creates or takes over the binding's
 *    cursor with an opaque owner and a bounded lease. The claim commits on its
 *    own, which is what keeps a provider round trip out of a database
 *    transaction;
 * 5. **pull bounded pages** — each page goes through the shared token provider
 *    and HTTP client, which recovers from a rejected cached token with the same
 *    single invalidate-and-replay the send path uses. Every customer
 *    text/image/link record is ingested through the same idempotent path a
 *    pushed callback uses, and the cursor advances only after the whole page is
 *    durable, only to a position the page actually produced, and only for the
 *    owner that still holds the lease (compare-by-owner). Because the transport
 *    refuses a page that reports more records without a new position, a page
 *    that is accepted always moves the cursor forward. A page that cannot be
 *    pulled or ingested releases the lease *without* advancing, so nothing is
 *    skipped and a retry resumes from the same position; a pull that finishes
 *    releases it too, so the next notification can resume at once rather than
 *    waiting for the lease to expire.
 *
 * Every failure is a stable {@link ChannelOutcome} carrying a safe message. The
 * notification token, the access token and the raw provider payload never reach
 * a response, a log line or a persisted column.
 */

import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ChannelAdapter, UnifiedMessage } from '@kefu/core';
import type { WecomCredentialReader } from '@kefu/wecom';
import { CHANNEL_ADAPTER } from './channel-adapter.port';
import { WECOM_CREDENTIAL_READER } from './wecom-credential.source';
import {
  ChannelDeliveryService,
  type InboundIngestResult,
  type ProviderWebhookInput,
} from './channel-delivery.service';
import {
  channelFailure,
  channelFailureFromAdapter,
  channelFailureFromCallbackVerification,
  type ChannelOutcome,
} from './channel-outcome';
import {
  WECOM_REAL_TRANSPORT,
  type WecomCallbackNotification,
  type WecomRealTransport,
  type WecomScope,
} from './real-wecom.adapter';
import {
  WECOM_BINDING_REPOSITORY,
  type CursorLeaseInput,
  type WecomBindingRepository,
} from './wecom-binding.repository';

/**
 * The part of a lease that identifies *who* holds it.
 *
 * Kept apart from {@link CursorLeaseInput} because the instant is stamped at each
 * statement rather than carried around: one pull's lease is a series of writes,
 * and every one of them has to be timed by the clock at the moment it runs.
 */
type LeaseIdentity = Pick<CursorLeaseInput, 'tenantId' | 'bindingId' | 'owner'>;

/**
 * Pages one notification may consume before it stops.
 *
 * A bound, not a policy: `has_more` comes from the provider, so a pull that
 * followed it without a limit could loop forever on a provider that always
 * reports more. Stopping at the bound is safe because the cursor has advanced to
 * the end of the last durable page and the next notification resumes there.
 */
const MAX_SYNC_PAGES = 5;

/** Records asked for per page. Provider-side, so it stays well inside a page. */
const SYNC_PAGE_LIMIT = 100;

/** Result of one completed pull, safe to return to the provider. */
export type WecomSyncPullResult = {
  readonly status: 'synced';
  /** Provider records handed to the idempotent ingestion path. */
  readonly ingested: number;
  /** Provider pages consumed by this notification. */
  readonly pages: number;
  /** `true` when the pull stopped at its page bound with more still to fetch. */
  readonly hasMore: boolean;
};

/** What one authenticated real-provider callback produced. */
export type ProviderCallbackResult = InboundIngestResult | WecomSyncPullResult;

/**
 * Routes real WeCom callbacks and performs the `kf/sync_msg` pull.
 *
 * Only ever asked to work when the real transport is bound: the application asks
 * this service to ingest a provider callback, and it refuses with the same stable
 * `channel_disabled` a Mock build answers when no real transport exists.
 */
@Injectable()
export class WecomSyncService {
  /**
   * @param credentials - Read once per pull for the corp id the account is
   * bound under. It is the *configured* corp id and not the environment's: a
   * deployment set up from the console may carry no `WECOM_CORP_ID` at all, and
   * reading the environment here would then look for a binding under an empty
   * company and refuse every notification for an account that is bound.
   * @param adapter - The bound transport, used to authenticate the callback
   * before its payload is read.
   * @param transport - The real customer-service transport, or `null` when the
   * Mock is bound.
   * @param bindings - Durable account bindings and sync cursors.
   * @param delivery - The shared idempotent ingestion path.
   */
  constructor(
    @Inject(WECOM_CREDENTIAL_READER) private readonly credentials: WecomCredentialReader,
    @Inject(CHANNEL_ADAPTER) private readonly adapter: ChannelAdapter,
    @Inject(WECOM_REAL_TRANSPORT) private readonly transport: WecomRealTransport | null,
    @Inject(WECOM_BINDING_REPOSITORY) private readonly bindings: WecomBindingRepository,
    private readonly delivery: ChannelDeliveryService,
  ) {}

  /**
   * Ingest one callback a real provider authenticated on its own.
   *
   * The body is authenticated before it is classified, so an unsigned body is
   * refused before it is decrypted. A notification is then pulled; a direct
   * message callback takes the ingestion path it has always taken, unchanged —
   * the classification only *reads* provider fields and cannot alter what a
   * direct callback does.
   *
   * The classification and the direct path each read the envelope, which is one
   * extra digest and one extra AES block over a few hundred bytes spent to leave
   * the direct path exactly as it was.
   *
   * @param input - Raw callback body, its signature triple, and nothing else: a
   * real callback carries no platform session and cannot name a tenant.
   * @returns The ingestion result, the pull result, or a stable refusal value.
   */
  async ingestProviderCallback(
    input: ProviderWebhookInput,
  ): Promise<ChannelOutcome<ProviderCallbackResult>> {
    const verification = await this.adapter.verifyWebhook({
      channel: this.adapter.channel,
      signature: input.signature,
      timestamp: input.timestamp ?? null,
      nonce: input.nonce ?? null,
      rawBody: input.rawBody,
    });
    if (!verification.ok) {
      // The same projection the callback URL handshake answers with, so a forged
      // digest is `401` on both routes and a missing credential is `503` on both.
      return channelFailureFromCallbackVerification(verification);
    }

    const transport = this.transport;
    if (transport === null) {
      return channelFailureFromAdapter({
        code: 'channel_disabled',
        message: 'no real WeCom customer-service transport is bound in this build',
      });
    }
    const classified = await transport.readNotification({ rawBody: input.rawBody });
    if (!classified.ok) {
      return channelFailureFromAdapter(classified);
    }
    return classified.value.kind === 'notification'
      ? this.#pull(classified.value)
      : this.delivery.ingestProviderWebhook(input);
  }

  /**
   * Resolve the persistent scope, claim the cursor and pull bounded pages.
   *
   * @param notification - The account and short-lived pull token.
   * @returns The pull result, or a stable refusal value.
   */
  async #pull(
    notification: WecomCallbackNotification,
  ): Promise<ChannelOutcome<WecomSyncPullResult>> {
    const transport = this.transport;
    if (transport === null) {
      return channelFailureFromAdapter({
        code: 'channel_disabled',
        message: 'no real WeCom customer-service transport is bound in this build',
      });
    }
    const openKfId = notification.openKfId;
    if (openKfId === null) {
      return channelFailureFromAdapter({
        code: 'channel_not_configured',
        message: 'the customer-service notification names no account to pull for',
      });
    }

    // The account is found by the company the transport is *currently*
    // authenticating as. The callback already proved it resolves — this method
    // is only reached after {@link ingestProviderCallback} verified the digest —
    // so an unconfigured read here is the case where the credential was cleared
    // between the two, and it is answered as unbound rather than guessed at.
    const resolution = await this.credentials();
    const binding =
      resolution._tag === 'ready'
        ? await this.bindings.findActiveBinding(resolution.values.corpId, openKfId)
        : undefined;
    if (binding === undefined) {
      // Unbound, disabled, ambiguous, unknown tenant, unknown store, or a store
      // that belongs to another tenant — one refusal, and nothing is written.
      return channelFailureFromAdapter({
        code: 'channel_not_configured',
        message: 'the WeCom customer-service account is not bound to a platform tenant/store',
      });
    }

    const lease: LeaseIdentity = {
      tenantId: binding.tenantId,
      bindingId: binding.id,
      // Opaque per attempt: not a member, not a session, not a credential, so a
      // stored owner can never be replayed as an identity.
      owner: `wecom-sync-${randomUUID()}`,
    };
    // The lease length is the store's, taken from Core's `WECOM_SYNC_LEASE_MS`:
    // one duration decides when a dead pull becomes recoverable, whichever store
    // the environment selected.
    const claim = await this.bindings.claimCursor({ ...lease, now: nowIso() });
    if (claim === undefined) {
      // A live lease means another notification for this same account is already
      // pulling the same window, so this one has nothing to add and must not
      // take the cursor away from it.
      return channelFailure(
        HttpStatus.SERVICE_UNAVAILABLE,
        'service_unavailable',
        'another pull already holds the sync cursor for this customer-service account',
      );
    }

    let cursor = claim.cursor;
    let pages = 0;
    let ingested = 0;
    let hasMore = false;
    try {
      while (pages < MAX_SYNC_PAGES) {
        if (pages > 0 && !(await this.#renew(lease))) {
          return this.#leaseLost();
        }
        const page = await transport.pullSyncMessages({
          openKfId,
          cursor,
          notificationToken: notification.notificationToken,
          limit: SYNC_PAGE_LIMIT,
          scope: { tenantId: binding.tenantId, storeId: binding.storeId },
        });
        if (!page.ok) {
          await this.#release(lease);
          return channelFailureFromAdapter(page);
        }
        for (const message of page.value.messages) {
          const result = await this.delivery.ingestProviderMessage(message, pullPayloadOf(message));
          if (!result.ok) {
            // Nothing is skipped: the cursor stays where it was, so a retry
            // re-pulls this page and the dedup key absorbs what was already
            // written.
            await this.#release(lease);
            return result;
          }
          ingested += 1;
        }
        // The cursor moves only once the whole page is durable, and only for the
        // owner that still holds the lease — a stale owner cannot advance a
        // claim somebody else took over.
        if (!(await this.#advance(lease, page.value.nextCursor))) {
          return this.#leaseLost();
        }
        cursor = page.value.nextCursor;
        pages += 1;
        hasMore = page.value.hasMore;
        if (!hasMore) {
          break;
        }
      }
      // The pull is over, so the claim is handed back at once instead of being
      // left to expire: the next notification resumes from the stored cursor
      // immediately.
      await this.#release(lease);
      return { ok: true, value: { status: 'synced', ingested, pages, hasMore } };
    } catch {
      // A durable-store failure mid-page is not a caller mistake and must not
      // leak a driver message, so it becomes one stable channel error.
      await this.#release(lease);
      return channelFailureFromAdapter({
        code: 'channel_provider_error',
        message: 'the WeCom customer-service pull failed before it completed',
      });
    }
  }

  /** Extend the lease for another page, reporting whether it is still ours. */
  async #renew(lease: LeaseIdentity): Promise<boolean> {
    return this.bindings.renewCursor({ ...lease, now: nowIso() });
  }

  /**
   * Move the cursor forward, reporting whether the lease was still ours.
   *
   * The position is a `string`, and a blank one is refused by the store: the
   * transport already refuses a page that produced no position, and the store
   * refuses to persist one even if some other transport ever offered it.
   */
  async #advance(lease: LeaseIdentity, cursor: string): Promise<boolean> {
    return this.bindings.advanceCursor({ ...lease, cursor, now: nowIso() });
  }

  /**
   * Give the lease back without moving the cursor.
   *
   * Best effort on purpose: a release that cannot be written still expires on
   * its own, which is what makes a dead pull recoverable rather than fatal.
   */
  async #release(lease: LeaseIdentity): Promise<void> {
    try {
      await this.bindings.releaseCursor({ ...lease, now: nowIso() });
    } catch {
      // The bounded lease is the backstop.
    }
  }

  /** The refusal for a lease this pull no longer holds. */
  #leaseLost(): ChannelOutcome<never> {
    return channelFailure(
      HttpStatus.SERVICE_UNAVAILABLE,
      'service_unavailable',
      'the kf/sync_msg lease was lost before the cursor could advance',
    );
  }
}

/** Text identifying one pulled record, hashed into the receipt's diagnostic digest. */
function pullPayloadOf(message: UnifiedMessage): string {
  return message.dedupKey ?? message.externalEventId;
}

/** Current instant, as the durable stores record it. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Re-exported so a reader of this module sees the scope type the pull maps into. */
export type { WecomScope };
