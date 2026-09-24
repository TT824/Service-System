import { describe, expect, it } from 'vitest';
import {
  CHANNEL_PROVIDER_WECOM,
  WECOM_SYNC_LEASE_MS,
  createUnifiedMessage,
  resolveWecomCredentials,
  type ChannelAdapter,
  type ChannelResult,
  type UnifiedMessage,
  type WeComChannelBinding,
  type WebhookVerificationInput,
} from '@kefu/core';
import type { WecomCredentialReader } from '@kefu/wecom';
import { HttpStatus } from '@nestjs/common';
import {
  ChannelDeliveryService,
  type InboundIngestResult,
  type ProviderWebhookInput,
} from './channel-delivery.service';
import type { ChannelFailure, ChannelOutcome } from './channel-outcome';
import type {
  AdvanceCursorInput,
  ClaimCursorInput,
  CursorLeaseInput,
  RenewCursorInput,
  WecomActiveBinding,
  WecomBindingRepository,
  WecomCursorClaim,
} from './wecom-binding.repository';
import type {
  WecomCallbackKind,
  WecomCallbackUrlInput,
  WecomRealTransport,
  WecomSyncPage,
  WecomSyncPullInput,
} from './real-wecom.adapter';
import { WecomSyncService } from './wecom-sync.service';
import { TEST_CORP_ID, TEST_OPEN_KF_ID, realWecomConfig } from '../../test/wecom-callback-support';

/** The scope the fake binding resolves the account into. */
const TENANT_ID = 'tenant-acme';
const STORE_ID = 'store-acme-flagship';

/** The pull credential the notification carries; it must never surface anywhere. */
const NOTIFICATION_TOKEN = 'notification-token-1';

/** The access token the transport is expected to use; likewise never surfaced. */
const ACCESS_TOKEN = 'access-token-1';

/** One authenticated callback body. The service never reads it itself. */
const CALLBACK: ProviderWebhookInput = {
  signature: 'signature-1',
  timestamp: '1770000000',
  nonce: 'nonce-9',
  rawBody: '<xml><Encrypt>ciphertext</Encrypt></xml>',
};

/** The binding the account resolves to unless a test says otherwise. */
const BINDING: WecomActiveBinding = {
  id: 'binding-1',
  tenantId: TENANT_ID,
  storeId: STORE_ID,
  corpId: TEST_CORP_ID,
  openKfId: TEST_OPEN_KF_ID,
};

/** One mapped customer message, shaped exactly as a pulled record maps. */
function pulledMessage(id: string): UnifiedMessage {
  return createUnifiedMessage({
    channel: CHANNEL_PROVIDER_WECOM,
    externalEventId: id,
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    externalCustomerId: 'wm-customer-1',
    externalConversationId: `${TEST_OPEN_KF_ID}:wm-customer-1`,
    externalMessageId: id,
    direction: 'inbound',
    messageType: 'text',
    content: `消息 ${id}`,
    dedupKey: `wecom:${id}`,
    media: null,
    receivedAt: '2026-02-02T02:40:00.000Z',
  });
}

/**
 * One successful page.
 *
 * The position is never blank: a page the transport accepted always reports
 * where it stopped, so the cursor a pull advances to is always a real one.
 */
function page(
  messages: ReadonlyArray<UnifiedMessage>,
  hasMore = false,
  nextCursor = 'cursor-page',
): ChannelResult<WecomSyncPage> {
  return { ok: true, value: { messages, nextCursor, hasMore } };
}

/**
 * `count` pages that each report more to fetch and each stop somewhere new.
 *
 * Distinct positions on purpose: a provider that kept answering with the same
 * position would be reporting progress it did not make, which the transport
 * refuses before the cursor is ever advanced.
 */
function progressPages(
  count: number,
  messages: ReadonlyArray<UnifiedMessage> = [],
): Array<ChannelResult<WecomSyncPage>> {
  return Array.from({ length: count }, (_unused, index) =>
    page(messages, true, `cursor-${index + 1}`),
  );
}

/**
 * A scripted {@link WecomRealTransport}.
 *
 * Pages are answered in order and then by an empty page, so a test states the
 * provider's answers explicitly and can assert how many pulls were made. The
 * unused members exist only because the service asks for the whole real-transport
 * shape through one token.
 */
class FakeTransport implements WecomRealTransport {
  readonly pulls: WecomSyncPullInput[] = [];
  readonly notifications: string[] = [];
  /** The classification the next `readNotification` answers with. */
  kind: ChannelResult<WecomCallbackKind> = {
    ok: true,
    value: {
      kind: 'notification',
      openKfId: TEST_OPEN_KF_ID,
      notificationToken: NOTIFICATION_TOKEN,
    },
  };
  #pages: Array<ChannelResult<WecomSyncPage>> = [];

  /** Queue the provider's page answers, in order. */
  answer(...pages: Array<ChannelResult<WecomSyncPage>>): void {
    this.#pages = [...pages];
  }

  async verifyCallbackUrl(_input: WecomCallbackUrlInput): Promise<ChannelResult<string>> {
    return { ok: false, code: 'channel_disabled', message: 'not used here', retryable: false };
  }

  async probeConnection(): Promise<boolean> {
    return true;
  }

  /** The pull never reconnects; the shape exists for the port. */
  async reconnect(): Promise<boolean> {
    return true;
  }

  async readNotification(input: {
    readonly rawBody: string;
  }): Promise<ChannelResult<WecomCallbackKind>> {
    this.notifications.push(input.rawBody);
    return this.kind;
  }

  async pullSyncMessages(input: WecomSyncPullInput): Promise<ChannelResult<WecomSyncPage>> {
    this.pulls.push(input);
    return this.#pages.shift() ?? page([]);
  }
}

/**
 * When a lease taken at `now` runs out.
 *
 * The duration is Core's, so this fake expires a dead pull at the same instant
 * the in-process and the durable stores do.
 */
function leaseEndingAt(now: string): string {
  return new Date(Date.parse(now) + WECOM_SYNC_LEASE_MS).toISOString();
}

/** A {@link WecomBindingRepository} whose lease behaves like the durable one. */
class FakeBindings implements WecomBindingRepository {
  readonly lookups: Array<{ corpId: string; openKfId: string }> = [];
  readonly claims: ClaimCursorInput[] = [];
  readonly renewals: RenewCursorInput[] = [];
  readonly advances: AdvanceCursorInput[] = [];
  readonly releases: CursorLeaseInput[] = [];

  /** The binding the account resolves to, or `undefined` for an unbound account. */
  binding: WecomActiveBinding | undefined = BINDING;
  /** Persisted cursor a claim comes back with. */
  cursor: string | null = null;
  /** Owner currently holding the lease, as the durable row would record it. */
  heldBy: string | null = null;
  /** When that owner's lease runs out. */
  heldUntil: string | null = null;
  /** Expiry of the last lease granted, kept past a release so it stays readable. */
  lastLeaseExpiresAt: string | null = null;
  /** Force `renewCursor` to report a lost lease. */
  refuseRenew = false;

  async findActiveBinding(
    corpId: string,
    openKfId: string,
  ): Promise<WecomActiveBinding | undefined> {
    this.lookups.push({ corpId, openKfId });
    return this.binding;
  }

  // The pull only ever reads a binding, so the writing half answers as a store
  // no binding is written to through this path: what this spec exercises is
  // which account a notification resolves and how the lease behaves.
  async createBinding(_binding: WeComChannelBinding): Promise<boolean> {
    return false;
  }

  async listBindings(): Promise<ReadonlyArray<WeComChannelBinding>> {
    return [];
  }

  async claimCursor(input: ClaimCursorInput): Promise<WecomCursorClaim | undefined> {
    this.claims.push(input);
    if (this.#live()) {
      return undefined;
    }
    this.heldBy = input.owner;
    const leaseExpiresAt = this.grant(input.now);
    return {
      bindingId: input.bindingId,
      tenantId: input.tenantId,
      cursor: this.cursor,
      owner: input.owner,
      leaseExpiresAt,
    };
  }

  async renewCursor(input: RenewCursorInput): Promise<boolean> {
    this.renewals.push(input);
    if (this.refuseRenew || !this.#held(input)) {
      return false;
    }
    this.grant(input.now);
    return true;
  }

  async advanceCursor(input: AdvanceCursorInput): Promise<boolean> {
    this.advances.push(input);
    // The store refuses a blank position before it writes anything, exactly as
    // the in-process and the durable implementations do, so a page that produced
    // no position can never claim forward progress.
    if (input.cursor.trim().length === 0) {
      throw new Error('channel invariant: a kf/sync_msg position must not be blank');
    }
    if (!this.#held(input)) {
      return false;
    }
    this.cursor = input.cursor;
    // Advancing keeps the lease, exactly as the durable statement does, so a
    // pull with more pages can renew for the next one.
    return true;
  }

  async releaseCursor(input: CursorLeaseInput): Promise<boolean> {
    this.releases.push(input);
    if (!this.#held(input)) {
      return false;
    }
    this.#clear();
    return true;
  }

  /** Seed a lease some other attempt already holds. */
  seedLease(owner: string, expiresAt: string): void {
    this.heldBy = owner;
    this.heldUntil = expiresAt;
  }

  /** Record a lease granted at `now`, which the store ends on Core's schedule. */
  private grant(now: string): string {
    const expiresAt = leaseEndingAt(now);
    this.heldUntil = expiresAt;
    this.lastLeaseExpiresAt = expiresAt;
    return expiresAt;
  }

  #live(): boolean {
    return (
      this.heldBy !== null && this.heldUntil !== null && Date.parse(this.heldUntil) > Date.now()
    );
  }

  #held(input: CursorLeaseInput): boolean {
    return this.heldBy === input.owner;
  }

  #clear(): void {
    this.heldBy = null;
    this.heldUntil = null;
  }
}

/** A {@link ChannelDeliveryService} that records what the pull handed it. */
class FakeDelivery {
  readonly ingested: Array<{ message: UnifiedMessage; payload: string }> = [];
  readonly webhooks: ProviderWebhookInput[] = [];
  /** Answer strategy; defaults to "the message was newly written". */
  handler: (message: UnifiedMessage) => ChannelOutcome<InboundIngestResult> = (message) => ({
    ok: true,
    value: ingestResult(message, 'processed'),
  });

  async ingestProviderMessage(
    message: UnifiedMessage,
    payload: string,
  ): Promise<ChannelOutcome<InboundIngestResult>> {
    this.ingested.push({ message, payload });
    return this.handler(message);
  }

  async ingestProviderWebhook(
    input: ProviderWebhookInput,
  ): Promise<ChannelOutcome<InboundIngestResult>> {
    this.webhooks.push(input);
    return { ok: true, value: ingestResult(pulledMessage('direct-1'), 'processed') };
  }
}

/** One ingestion result for a message the fake delivery accepted. */
function ingestResult(
  message: UnifiedMessage,
  status: 'processed' | 'duplicate',
): InboundIngestResult {
  return {
    status,
    eventId: message.externalEventId,
    conversationId: message.externalConversationId,
    messageId: message.externalEventId,
    messageType: message.messageType,
    created: status === 'processed',
  };
}

/** A {@link ChannelAdapter} answering only what this service asks it. */
class FakeAdapter {
  readonly channel = CHANNEL_PROVIDER_WECOM;
  readonly verifications: WebhookVerificationInput[] = [];
  verification: ChannelResult<{ verified: boolean }> = { ok: true, value: { verified: true } };

  async verifyWebhook(
    input: WebhookVerificationInput,
  ): Promise<ChannelResult<{ verified: boolean }>> {
    this.verifications.push(input);
    return this.verification;
  }
}

/**
 * Everything one test needs to drive the service.
 *
 * `noTransport` is the Mock build: the service is wired with `null` where the
 * real transport would be, which is what the module does when `WECOM_TRANSPORT`
 * is not `real`.
 */
function build(
  options: {
    readonly transport?: FakeTransport;
    readonly noTransport?: boolean;
    readonly credentials?: WecomCredentialReader;
  } = {},
) {
  const adapter = new FakeAdapter();
  const transport = options.transport ?? new FakeTransport();
  const bindings = new FakeBindings();
  const delivery = new FakeDelivery();
  const config = realWecomConfig();
  const service = new WecomSyncService(
    // The environment half of the API's reader, with nothing stored: this
    // suite's account is bound under `TEST_CORP_ID`, so the two agree. The
    // stored half has its own test below.
    options.credentials ??
      (async () => resolveWecomCredentials({ stored: undefined, environment: config.wecom })),
    // The casts are the price of the service depending on the two collaborators
    // it uses rather than on the whole adapter port: this spec asserts the pull
    // loop, and the adapter and the delivery loop have their own specs.
    adapter as unknown as ChannelAdapter,
    options.noTransport === true ? null : transport,
    bindings,
    delivery as unknown as ChannelDeliveryService,
  );
  return { service, adapter, transport, bindings, delivery };
}

/** A refusal assertion that also keeps the failure's type usable. */
function expectFailure(
  outcome: ChannelOutcome<unknown>,
  match: Partial<ChannelFailure>,
): ChannelFailure {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    throw new Error('expected a refusal');
  }
  expect(outcome).toMatchObject(match);
  return outcome;
}

describe('WecomSyncService callback authentication', () => {
  it('refuses a callback the provider did not sign, before reading any binding', async () => {
    const { service, adapter, bindings, transport } = build();
    adapter.verification = {
      ok: false,
      code: 'channel_invalid_request',
      message: 'the callback signature does not match',
      retryable: false,
    };

    const outcome = expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.UNAUTHORIZED,
      code: 'unauthorized',
      message: 'the callback signature does not match',
    });
    // A forged digest is the caller's mistake and never reaches the provider or
    // the durable binding.
    expect(outcome.ok).toBe(false);
    expect(bindings.lookups).toEqual([]);
    expect(transport.notifications).toEqual([]);
    expect(adapter.verifications).toHaveLength(1);
  });

  it('answers a channel-level verification refusal with the same stable code', async () => {
    const { service, adapter } = build();
    adapter.verification = {
      ok: false,
      code: 'channel_not_configured',
      message: 'the WeCom customer-service transport is not configured: WECOM_KF_SECRET',
      retryable: false,
    };

    expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'channel_not_configured',
    });
  });

  it('refuses a callback when no real transport is bound', async () => {
    const { service, bindings } = build({ noTransport: true });

    expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'channel_disabled',
    });
    expect(bindings.lookups).toEqual([]);
  });

  it('routes a direct message callback through the ingestion path it has always had', async () => {
    const transport = new FakeTransport();
    transport.kind = { ok: true, value: { kind: 'message', message: pulledMessage('direct-1') } };
    const { service, delivery, bindings } = build({ transport });

    const outcome = await service.ingestProviderCallback(CALLBACK);

    expect(outcome).toMatchObject({ ok: true, value: { status: 'processed' } });
    expect(delivery.webhooks).toEqual([CALLBACK]);
    expect(delivery.ingested).toEqual([]);
    // A direct callback carries its own scope, so no binding is consulted and no
    // cursor is ever claimed for it.
    expect(bindings.lookups).toEqual([]);
    expect(bindings.claims).toEqual([]);
  });
});

describe('WecomSyncService binding resolution', () => {
  it('refuses an account no active binding resolves, before writing anything', async () => {
    const { service, bindings, transport, delivery } = build();
    bindings.binding = undefined;

    expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'channel_not_configured',
      message: 'the WeCom customer-service account is not bound to a platform tenant/store',
    });
    expect(bindings.lookups).toEqual([{ corpId: TEST_CORP_ID, openKfId: TEST_OPEN_KF_ID }]);
    expect(bindings.claims).toEqual([]);
    expect(transport.pulls).toEqual([]);
    expect(delivery.ingested).toEqual([]);
  });

  it('refuses a notification that names no account to pull for', async () => {
    const transport = new FakeTransport();
    transport.kind = {
      ok: true,
      value: { kind: 'notification', openKfId: null, notificationToken: NOTIFICATION_TOKEN },
    };
    const { service, bindings } = build({ transport });

    expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'channel_not_configured',
    });
    expect(bindings.lookups).toEqual([]);
  });

  it('looks the account up under the company the transport is configured as', async () => {
    // The company need not be the environment's. A deployment connected from the
    // console carries the corp id that was typed into it, and reading `.env`
    // here would look for the account under a different — possibly empty —
    // company and refuse a notification for an account that is bound.
    const { service, bindings } = build({
      credentials: async () => ({
        _tag: 'ready',
        values: {
          corpId: 'ww-from-the-console',
          kfSecret: 'secret-from-the-console',
          callbackToken: 'token-from-the-console',
          aesKey: 'a'.repeat(43),
          openKfId: TEST_OPEN_KF_ID,
        },
        origin: 'console',
      }),
    });

    expect(await service.ingestProviderCallback(CALLBACK)).toMatchObject({ ok: true });
    expect(bindings.lookups).toEqual([
      { corpId: 'ww-from-the-console', openKfId: TEST_OPEN_KF_ID },
    ]);
  });

  it('refuses a notification when the credentials went away after the callback was verified', async () => {
    // The digest was verified against a set that has since been cleared, so
    // there is no company to look the account up under. Nothing is written, and
    // the refusal is the same one an unbound account gets.
    const { service, bindings } = build({
      credentials: async () => ({
        _tag: 'unconfigured',
        origin: 'console',
        problems: [{ variable: 'WECOM_KF_SECRET', code: 'missing' }],
      }),
    });

    expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'channel_not_configured',
    });
    expect(bindings.lookups).toEqual([]);
    expect(bindings.claims).toEqual([]);
  });
});

describe('WecomSyncService pull loop', () => {
  it('claims the cursor, pulls, ingests and advances it once the page is durable', async () => {
    const transport = new FakeTransport();
    transport.answer(page([pulledMessage('sync-1'), pulledMessage('sync-2')], false, 'cursor-8'));
    const { service, bindings, delivery } = build({ transport });

    const outcome = await service.ingestProviderCallback(CALLBACK);

    expect(outcome).toEqual({
      ok: true,
      value: { status: 'synced', ingested: 2, pages: 1, hasMore: false },
    });
    expect(transport.pulls).toHaveLength(1);
    expect(transport.pulls[0]).toMatchObject({
      openKfId: TEST_OPEN_KF_ID,
      cursor: null,
      notificationToken: NOTIFICATION_TOKEN,
      scope: { tenantId: TENANT_ID, storeId: STORE_ID },
    });
    expect(delivery.ingested.map((entry) => entry.message.externalEventId)).toEqual([
      'sync-1',
      'sync-2',
    ]);
    // The receipt's diagnostic digest is derived from the message's own identity,
    // never from the provider payload.
    expect(delivery.ingested[0]?.payload).toBe('wecom:sync-1');
    expect(bindings.advances).toEqual([
      expect.objectContaining({ cursor: 'cursor-8', tenantId: TENANT_ID, bindingId: 'binding-1' }),
    ]);
    // The cursor has moved and the claim is handed back, so the next
    // notification can pull at once instead of waiting for the lease to expire.
    expect(bindings.releases).toHaveLength(1);
    expect(bindings.heldBy).toBeNull();
    expect(bindings.cursor).toBe('cursor-8');
  });

  it('claims with an opaque owner and a bounded lease, and resumes from the stored cursor', async () => {
    const transport = new FakeTransport();
    transport.answer(page([]));
    const { service, bindings } = build({ transport });
    bindings.cursor = 'cursor-3';

    await service.ingestProviderCallback(CALLBACK);

    const [claim] = bindings.claims;
    expect(claim?.owner).toMatch(/^wecom-sync-[0-9a-f-]{36}$/);
    expect(claim?.tenantId).toBe(TENANT_ID);
    expect(claim?.bindingId).toBe('binding-1');
    // The lease is bounded by Core's one duration, so a pull that dies without
    // releasing becomes recoverable at the same instant in either store.
    expect(Date.parse(bindings.lastLeaseExpiresAt ?? '') - Date.parse(claim?.now ?? '')).toBe(
      WECOM_SYNC_LEASE_MS,
    );
    // The pull resumes from the position the durable row already held.
    expect(transport.pulls[0]?.cursor).toBe('cursor-3');
  });

  it('refuses to pull when another attempt already holds a live lease', async () => {
    const transport = new FakeTransport();
    const { service, bindings, delivery } = build({ transport });
    bindings.seedLease(
      'wecom-sync-other',
      new Date(Date.now() + WECOM_SYNC_LEASE_MS).toISOString(),
    );

    expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'service_unavailable',
    });
    expect(bindings.claims).toHaveLength(1);
    expect(transport.pulls).toEqual([]);
    expect(delivery.ingested).toEqual([]);
  });

  it('takes over a lease whose owner died, and resumes from the persisted cursor', async () => {
    const transport = new FakeTransport();
    transport.answer(page([]));
    const { service, bindings } = build({ transport });
    bindings.cursor = 'cursor-4';
    bindings.seedLease('wecom-sync-dead', '2020-01-01T00:00:00.000Z');

    await expect(service.ingestProviderCallback(CALLBACK)).resolves.toMatchObject({ ok: true });
    expect(bindings.heldBy).toBeNull();
    expect(transport.pulls[0]?.cursor).toBe('cursor-4');
  });

  it('reports a lost lease instead of advancing a cursor it no longer owns', async () => {
    const transport = new FakeTransport();
    transport.answer(page([pulledMessage('sync-1')], false, 'cursor-8'));
    const { service, bindings } = build({ transport });
    // Somebody else took the lease over between the claim and the advance.
    bindings.claimCursor = async (input: ClaimCursorInput) => {
      bindings.claims.push(input);
      bindings.seedLease(
        'wecom-sync-rival',
        new Date(Date.now() + WECOM_SYNC_LEASE_MS).toISOString(),
      );
      return {
        bindingId: input.bindingId,
        tenantId: input.tenantId,
        cursor: null,
        owner: input.owner,
        leaseExpiresAt: leaseEndingAt(input.now),
      };
    };

    expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'service_unavailable',
    });
    // The newer claim keeps its cursor: this attempt never moved it.
    expect(bindings.cursor).toBeNull();
    // And it must not release what is no longer its own lease either.
    expect(bindings.releases).toEqual([]);
  });

  it('refuses a page with no position instead of advancing the cursor to a blank one', async () => {
    const transport = new FakeTransport();
    // A transport that somehow offered a blank position — the transport in this
    // build refuses one first, and this proves the store refuses it too, so no
    // successful pull can ever persist "no position".
    transport.answer(page([], false, '   '));
    const { service, bindings } = build({ transport });

    const failure = expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.BAD_GATEWAY,
      code: 'bad_gateway',
    });
    expect(failure.message).not.toContain('invariant');
    expect(bindings.cursor).toBeNull();
    expect(bindings.releases).toHaveLength(1);
    expect(bindings.heldBy).toBeNull();
  });

  it('releases without advancing when a page cannot be pulled', async () => {
    const transport = new FakeTransport();
    transport.answer({
      ok: false,
      code: 'channel_provider_error',
      message: 'token expired',
      retryable: false,
    });
    const { service, bindings } = build({ transport });

    expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.BAD_GATEWAY,
      code: 'bad_gateway',
      message: 'token expired',
    });
    expect(bindings.advances).toEqual([]);
    expect(bindings.releases).toHaveLength(1);
    expect(bindings.heldBy).toBeNull();
    expect(bindings.cursor).toBeNull();
  });

  it('releases without advancing when a pulled message cannot be ingested', async () => {
    const transport = new FakeTransport();
    transport.answer(page([pulledMessage('sync-1'), pulledMessage('sync-2')], false, 'cursor-8'));
    const { service, bindings, delivery } = build({ transport });
    delivery.handler = (message) =>
      message.externalEventId === 'sync-2'
        ? {
            ok: false,
            status: HttpStatus.BAD_REQUEST,
            code: 'bad_request',
            message: 'out of scope',
          }
        : { ok: true, value: ingestResult(message, 'processed') };

    expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.BAD_REQUEST,
      code: 'bad_request',
      message: 'out of scope',
    });
    // The page is not durable as a whole, so the cursor stays where it was and a
    // retry re-pulls it; the message already written is absorbed by its dedup key.
    expect(bindings.advances).toEqual([]);
    expect(bindings.releases).toHaveLength(1);
    expect(bindings.cursor).toBeNull();
  });

  it('releases without advancing when the durable store throws mid-pull', async () => {
    const transport = new FakeTransport();
    transport.answer(page([pulledMessage('sync-1')], false, 'cursor-8'));
    const { service, bindings } = build({ transport });
    bindings.advanceCursor = async (input: AdvanceCursorInput) => {
      bindings.advances.push(input);
      throw new Error('connection terminated unexpectedly');
    };

    const failure = expectFailure(await service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.BAD_GATEWAY,
      code: 'bad_gateway',
    });
    // A driver message is not a channel error, so it never reaches the caller.
    expect(failure.message).not.toContain('connection terminated');
    expect(bindings.releases).toHaveLength(1);
    expect(bindings.cursor).toBeNull();
  });

  it('ingests a duplicate provider id without writing a second message', async () => {
    const transport = new FakeTransport();
    // The provider hands the same message back in two consecutive notifications,
    // which is exactly what a retried or replayed push looks like.
    transport.answer(
      page([pulledMessage('sync-1')], false, 'cursor-8'),
      page([pulledMessage('sync-1')], false, 'cursor-9'),
    );
    const { service, bindings, delivery } = build({ transport });
    // The idempotent path recognises the replay and answers `duplicate`, which is
    // a completed ingest rather than a failure.
    delivery.handler = (message) => ({
      ok: true,
      value: ingestResult(message, 'duplicate'),
    });

    await expect(service.ingestProviderCallback(CALLBACK)).resolves.toMatchObject({
      ok: true,
      value: { status: 'synced', ingested: 1, pages: 1 },
    });
    await expect(service.ingestProviderCallback(CALLBACK)).resolves.toMatchObject({
      ok: true,
      value: { status: 'synced', ingested: 1, pages: 1 },
    });

    expect(delivery.ingested.map((entry) => entry.message.dedupKey)).toEqual([
      'wecom:sync-1',
      'wecom:sync-1',
    ]);
    // Both pulls advanced the cursor, so the provider's position moved forward
    // even though the second page held nothing new.
    expect(bindings.cursor).toBe('cursor-9');
  });

  it('follows has_more but stops at its page bound instead of looping forever', async () => {
    const transport = new FakeTransport();
    // Eight pages offered, only the bound may be consumed.
    transport.answer(...progressPages(8, [pulledMessage('sync-1')]));
    const { service, bindings } = build({ transport });

    const outcome = await service.ingestProviderCallback(CALLBACK);

    expect(outcome).toEqual({
      ok: true,
      value: { status: 'synced', ingested: 5, pages: 5, hasMore: true },
    });
    expect(transport.pulls).toHaveLength(5);
    expect(bindings.advances).toHaveLength(5);
    // The stored position is the end of the last durable page, so the next
    // notification resumes exactly there rather than from the top.
    expect(bindings.cursor).toBe('cursor-5');
    expect(bindings.releases).toHaveLength(1);
  });

  it('renews the lease between pages and refuses to continue without it', async () => {
    const transport = new FakeTransport();
    transport.answer(...progressPages(5));
    const { service, bindings } = build({ transport });

    await expect(service.ingestProviderCallback(CALLBACK)).resolves.toMatchObject({ ok: true });
    // Five pages were consumed before the bound stopped the pull, and the first
    // page needed no renewal — the claim had just happened — so four were made.
    expect(transport.pulls).toHaveLength(5);
    expect(bindings.renewals).toHaveLength(4);
    expect(bindings.cursor).toBe('cursor-5');

    const lost = build();
    lost.transport.answer(...progressPages(5));
    lost.bindings.refuseRenew = true;

    expectFailure(await lost.service.ingestProviderCallback(CALLBACK), {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'service_unavailable',
      message: 'the kf/sync_msg lease was lost before the cursor could advance',
    });
    // The page that could not be renewed is never pulled, so nothing is ingested
    // against a lease this attempt no longer holds.
    expect(lost.transport.pulls).toHaveLength(1);
    expect(lost.bindings.advances).toHaveLength(1);
  });

  it('keeps the pull credential and every provider payload out of what it returns', async () => {
    const transport = new FakeTransport();
    transport.answer({
      ok: false,
      code: 'channel_provider_error',
      message: 'WeCom rejected the sync request (errcode 95001)',
      retryable: false,
    });
    const { service } = build({ transport });

    const outcome = await service.ingestProviderCallback(CALLBACK);
    const serialized = JSON.stringify(outcome);

    for (const secret of [NOTIFICATION_TOKEN, ACCESS_TOKEN, CALLBACK.rawBody, 'ciphertext']) {
      expect(serialized).not.toContain(secret);
    }
  });
});
