/**
 * Channel configuration surface.
 *
 * The service reports which transport the environment bound and what it has
 * actually proven, and it serves the one callback step that must work *before*
 * a transport can be configured at all: WeCom's callback URL handshake. That
 * handshake is deliberately answered here rather than on the delivery service,
 * because it creates no message, no receipt and no conversation — it only
 * proves the platform holds the right token, key and corp id.
 *
 * The callback paths are declared here so the UI and the documentation cannot
 * drift from the routes the controller actually serves.
 *
 * It also owns the one administrative fact a deployment cannot derive: which
 * provider account maps to which platform scope. The binding is read for the
 * overview and written by {@link ChannelsService.createBinding}, through the
 * same store the callbacks resolve against — so what the console shows and what
 * a callback does are the same row rather than two accounts of it.
 *
 * Since 2026-09-22 it owns the second such fact as well: the credential itself.
 * {@link ChannelsService.connectWecom} is what the console's 连接 button calls,
 * and it is the one writer of `wecom_channel_credentials` — it binds the account
 * if this deployment has not bound it yet, stores the five typed values, and
 * then *proves* them with a real token fetch, writing down what it learned. The
 * values are never returned by anything here; what comes back is a verdict.
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable, HttpStatus } from '@nestjs/common';
import {
  CHANNEL_PROVIDER_WECOM,
  RandomAuthIdGenerator,
  createWeComBinding,
  isWeComBindingActive,
  resolveServingStore,
  wecomCredentialProblems,
  wecomProblemVariables,
  type AppConfig,
  type AuthRepository,
  type ChannelAdapter,
  type ChannelCapabilities,
  type Member,
  type WeComChannelBinding,
  type WecomCredentialOrigin,
  type WecomCredentialValues,
} from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { AUTH_REPOSITORY } from '../auth/auth.tokens';
import { CHANNEL_ADAPTER } from './channel-adapter.port';
import { ChannelDisabledException } from './channel-disabled.exception';
import {
  channelFailure,
  channelFailureFromCallbackVerification,
  type ChannelOutcome,
} from './channel-outcome';
import { WECOM_BINDING_REPOSITORY, type WecomBindingRepository } from './wecom-binding.repository';
import {
  WECOM_CREDENTIAL_REPOSITORY,
  type WecomCredentialRepository,
} from './wecom-credential.repository';
import { WECOM_CREDENTIAL_READER } from './wecom-credential.source';
import type { WecomCredentialReader } from '@kefu/wecom';
import {
  WECOM_REAL_TRANSPORT,
  type WecomCallbackUrlInput,
  type WecomRealTransport,
} from './real-wecom.adapter';
import {
  WECOM_PROBE_FAILED_MESSAGE,
  describeWecomTransport,
  markWecomConnected,
  type WecomTransportStatus,
} from './wecom-transport';

/** Path accepting one WeCom inbound message callback. */
export const MOCK_WECOM_WEBHOOK_PATH = '/api/v1/channels/wecom/webhook';

/** Path accepting one platform delivery status notification. */
export const MOCK_WECOM_STATUS_PATH = '/api/v1/channels/wecom/status';

/** Callback path WeCom calls to verify the callback URL. */
export const WECOM_CALLBACK_VERIFY_PATH = '/api/v1/channels/wecom/callback';

/** Request header carrying the Mock callback signature. */
export const MOCK_WECOM_SIGNATURE_HEADER = 'x-mock-signature';

/**
 * Query parameter carrying the real callback signature.
 *
 * Published as a named constant because it is part of the documented callback
 * contract an operator configures inside WeCom, not because any status field
 * carries it.
 */
export const WECOM_SIGNATURE_PARAMETER = 'msg_signature';

/**
 * Operational status of one channel provider.
 *
 * Extends {@link WecomTransportStatus} — the same description `GET /access/status`
 * reports — with the transport-specific capabilities and callback paths, so the
 * account page and the channel page can never describe the channel differently.
 */
export type ChannelStatus = WecomTransportStatus & {
  readonly capabilities: ChannelCapabilities;
  /** Path of the inbound callback this transport accepts. */
  readonly webhookPath: string;
  /** Path accepting a provider delivery status notification. */
  readonly statusPath: string;
  /** Path WeCom calls to verify the callback URL before it stores one. */
  readonly callbackVerifyPath: string;
  /**
   * Reserved for non-production diagnostic controls. The MVP product surface
   * always receives `null` here so operators are not offered a simulated WeCom
   * path while they are preparing the real customer-service integration.
   */
  readonly mockControls: MockCallbackControls | null;
};

/** Diagnostic callback controls, currently withheld from the product overview. */
export type MockCallbackControls = {
  /** Header a diagnostic callback transport reads its shared secret from. */
  readonly signatureHeader: string;
  /** Send triggers that reproduce diagnostic provider failure paths. */
  readonly failureTriggers: ReadonlyArray<string>;
};

/** List response for the channels surface. */
export type ChannelsOverview = {
  readonly providers: ReadonlyArray<ChannelStatus>;
  /**
   * Provider accounts this deployment has bound, newest first.
   *
   * Read from the same store a callback resolves through, so the console can
   * never describe a binding the platform would not resolve, and the account
   * that is the reason a create was refused is visible rather than inferred.
   * Narrowed to the caller's tenant; empty for a seat, which administers none.
   */
  readonly bindings: ReadonlyArray<WeComChannelBinding>;
  /**
   * What the last connection attempt on the stored credential concluded, or
   * `null` when the console has never stored one.
   *
   * The verdict belongs to the stored values — the same fact
   * `wecom_channel_credentials.verified_at`/`verified_error` hold — and it is
   * reported here rather than only in the connect response so a page reload can
   * still say 「上次验证：成功/失败于某时刻」. It is read from a credential set the
   * caller's own deployment holds; nothing in it is a value.
   */
  readonly credentialVerdict: WecomCredentialVerdict | null;
};

/**
 * What one 连接 attempt concluded, in the terms a console renders.
 *
 * A stored verdict and a connect response are the same shape on purpose: the
 * line under the button after a click and the line under it after a reload are
 * the same sentence about the same fact, and neither is allowed to be a value.
 */
export type WecomConnectionVerdict = {
  /** The binding the credentials were stored against. */
  readonly bindingId: string;
  /** Whether WeCom answered with a token for these values. */
  readonly connected: boolean;
  /** Which set was written. Always the console's, since this route wrote it. */
  readonly credentialSource: WecomCredentialOrigin;
  /** When the attempt was made, as an ISO-8601 instant. */
  readonly verifiedAt: string;
  /**
   * The platform-authored reason the attempt failed, or `null` when it did not.
   * Never the provider's own text and never part of a credential.
   */
  readonly verifiedError: string | null;
};

/** A verdict as it may be read back later, which is without a binding id. */
export type WecomCredentialVerdict = Omit<WecomConnectionVerdict, 'bindingId'>;

/**
 * Channel configuration surface.
 *
 * The overview is the single place the UI reads the channel's state from, and it
 * never reports more than was checked: a real boot claims a connection only
 * after the probe in
 * {@link ChannelsService.overview} returned a token, and a failed probe leaves
 * the platform's own safe account of it in `lastConnectionError`.
 */
@Injectable()
export class ChannelsService {
  /**
   * @param config - Application configuration, whose `wecom` slice is the
   * credential fallback and the source of the transport switch.
   * @param adapter - The bound transport, used to report its real capabilities.
   * @param realTransport - The real customer-service transport, or `null` when
   * the Mock is bound. Only this optional face can answer the URL handshake,
   * probe connectivity and prove a freshly written credential, so the Mock never
   * has to fake any of them.
   * @param bindings - The persistent account bindings, read for the overview and
   * written by {@link ChannelsService.createBinding}.
   * @param credentialStore - The stored credential sets, written by
   * {@link ChannelsService.connectWecom} and read for the verdict in the
   * overview. Never read for a value here: no method of this service returns one.
   * @param credentials - The same sets as a transport reads them, which is how
   * the status learns which set this deployment authenticates with.
   * @param directory - The tenant directory, read only to decide which store a
   * newly bound account belongs to.
   */
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CHANNEL_ADAPTER) private readonly adapter: ChannelAdapter,
    @Inject(WECOM_REAL_TRANSPORT) private readonly realTransport: WecomRealTransport | null,
    @Inject(WECOM_BINDING_REPOSITORY) private readonly bindings: WecomBindingRepository,
    @Inject(WECOM_CREDENTIAL_REPOSITORY) private readonly credentialStore: WecomCredentialRepository,
    @Inject(WECOM_CREDENTIAL_READER) private readonly credentials: WecomCredentialReader,
    @Inject(AUTH_REPOSITORY) private readonly directory: AuthRepository,
  ) {}

  /**
   * Report the operational status of each channel provider.
   *
   * The credential is resolved first, because what the status says depends on
   * which set this deployment authenticates with and whether that set is usable
   * at all: a stored set missing a field is a different diagnosis from a stored
   * set WeCom refuses, and the console has to be able to tell them apart.
   *
   * In real mode this then probes the provider, so `realTransportConnected`
   * reflects something that was actually checked rather than something that was
   * merely configured, and a probe that fails is recorded as the safe
   * `lastConnectionError` an operator sees.
   *
   * Only a usable credential is probed. An unusable one refuses before any
   * network call, and recording a "probe failed" for a request that was never
   * attempted would misreport a configuration problem as a connectivity problem.
   */
  async overview(member: Member): Promise<ChannelsOverview> {
    const resolution = await this.credentials();
    if (
      describeWecomTransport(this.config, resolution).mode === 'real' &&
      this.realTransport !== null
    ) {
      markWecomConnected(await this.realTransport.probeConnection());
    }
    const status = describeWecomTransport(this.config, resolution);
    return {
      providers: [
        {
          ...status,
          capabilities: this.adapter.capabilities,
          webhookPath: MOCK_WECOM_WEBHOOK_PATH,
          statusPath: MOCK_WECOM_STATUS_PATH,
          callbackVerifyPath: WECOM_CALLBACK_VERIFY_PATH,
          mockControls: null,
        },
      ],
      bindings: await this.#visibleBindings(member),
      credentialVerdict: await this.#storedVerdict(),
    };
  }

  /**
   * Bind one provider account to the tenant and store a callback may write to.
   *
   * This is the step that ends the deployment period in which a real account
   * could only be brought in by inserting the row by hand: the account pair is
   * read out of WeCom's own console and stored here, and the very next callback
   * on it resolves the scope it names.
   *
   * The store is checked against the tenant before this is reached, so a
   * binding can never name a scope the caller could not already act in — the
   * tenant a request acts for is the tenant it binds into.
   *
   * The binding is written **active**, and that is the only state this surface
   * creates. A binding born disabled would be a state the console could not
   * leave: there is no update route, so the operator's next act on it could only
   * be SQL — the exact situation this route exists to replace. Disabling is a
   * separate decision with its own transition, and until that exists this
   * surface does not offer the one-way door.
   *
   * @param input - Scope and provider identity of the account to bind.
   * @returns The stored binding, or a stable refusal: `bad_request` when a scope
   * field is blank, `conflict` when the account already has a live binding.
   */
  async createBinding(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly corpId: string;
    readonly openKfId: string;
  }): Promise<ChannelOutcome<WeComChannelBinding>> {
    const now = new Date().toISOString();
    // The row is built by the shared rule, not assembled here: what a binding is
    // cannot differ between the API that writes it and the store that keeps it.
    const binding = createWeComBinding({
      id: `wecom-binding-${randomUUID()}`,
      now,
      draft: { ...input, enabled: true },
    });
    if (binding === undefined) {
      return channelFailure(
        HttpStatus.BAD_REQUEST,
        'bad_request',
        'corp_id, open_kfid and store_id must not be blank',
      );
    }
    if (!(await this.bindings.createBinding(binding))) {
      // The account already resolves a callback somewhere. Refusing is what
      // keeps "which scope does this account write into" answerable, so the
      // message names the account and the act that would change it.
      return channelFailure(
        HttpStatus.CONFLICT,
        'conflict',
        `the account (${binding.corpId}, ${binding.openKfId}) already has an active binding`,
      );
    }
    return { ok: true, value: binding };
  }

  /**
   * Store one typed credential set and prove it against WeCom.
   *
   * This is what the console's 连接 button calls, and it is the only writer of a
   * stored credential. Four things happen, in this order, and the order is the
   * design:
   *
   * 1. **The values are checked** by `@kefu/core`'s one rule, before anything is
   *    written. A set the platform would refuse to authenticate with is a
   *    `bad_request` naming the fields, not a row that fails at three in the
   *    morning.
   * 2. **The account is bound if it is not bound yet.** The console offers no
   *    binding form, so an operator connecting a fresh deployment has no other
   *    way to say which tenant and store this account's callbacks write into —
   *    and a credential no callback can resolve is a credential that can only
   *    ever receive nothing. The store is the platform's own serving-store rule,
   *    not a choice made here.
   * 3. **The values are written.** That clears whatever verdict the previous set
   *    carried, because a verdict belongs to the values it was reached on.
   * 4. **WeCom is asked for a token**, after the transport has forgotten what the
   *    previous credential proved, and the result is recorded beside the values
   *    and returned. `connected: false` is an ordinary answer and not an error:
   *    the set is stored and will be used, and what failed is the *connection*,
   *    which is exactly what the operator needs told.
   *
   * Nothing in the answer is a credential: a binding id, a boolean, an origin,
   * an instant, and a reason this platform wrote.
   *
   * @param input - Tenant to connect for, the typed values, and who typed them.
   * @returns The verdict, or a stable refusal.
   */
  async connectWecom(input: {
    readonly tenantId: string;
    readonly values: WecomCredentialValues;
    readonly updatedBy: string | null;
  }): Promise<ChannelOutcome<WecomConnectionVerdict>> {
    const transport = this.realTransport;
    if (transport === null) {
      // A Mock boot has no provider to prove anything against, so storing the
      // values would let 连接 report a connection this build cannot make.
      return channelFailure(
        HttpStatus.SERVICE_UNAVAILABLE,
        'channel_disabled',
        'no real WeCom customer-service transport is bound in this build',
      );
    }
    const problems = wecomCredentialProblems(input.values);
    if (problems.length > 0) {
      // The fields, never the values: this message reaches a browser.
      return channelFailure(
        HttpStatus.BAD_REQUEST,
        'bad_request',
        `the WeCom credential is not usable: ${wecomProblemVariables(problems).join(', ')}`,
      );
    }

    const binding = await this.#bindingFor(input.tenantId, input.values);
    if (!binding.ok) {
      return binding;
    }
    const now = new Date().toISOString();
    const stored = await this.credentialStore.saveCredentials({
      tenantId: input.tenantId,
      bindingId: binding.value.id,
      values: input.values,
      now,
      updatedBy: input.updatedBy,
    });
    if (!stored) {
      // The write guard is the read's own guard plus "no other live set". A
      // refusal here means either that the binding stopped resolving between
      // the two, or that this deployment is already connected to another
      // account — and both are refusals to connect a second one, not a fault.
      return channelFailure(
        HttpStatus.CONFLICT,
        'conflict',
        'this deployment is already connected to another customer-service account',
      );
    }

    const connected = await transport.reconnect();
    const verifiedAt = new Date().toISOString();
    markWecomConnected(connected, verifiedAt);
    const verifiedError = connected ? null : WECOM_PROBE_FAILED_MESSAGE;
    await this.credentialStore.recordVerification({
      tenantId: input.tenantId,
      bindingId: binding.value.id,
      now: verifiedAt,
      error: verifiedError,
    });
    return {
      ok: true,
      value: {
        bindingId: binding.value.id,
        connected,
        credentialSource: 'console',
        verifiedAt,
        verifiedError,
      },
    };
  }

  /**
   * The binding this account connects through, created when absent.
   *
   * Matching on the account pair rather than on the caller's store: an operator
   * who typed the same `corp_id`/`open_kfid` a second time means "connect this
   * account", not "bind it again somewhere else", and a second binding for one
   * account would be two rows resolving the same callback.
   *
   * @param tenantId - Tenant the connection is made for.
   * @param values - The typed values, whose account pair identifies the binding.
   * @returns The binding, or the refusal `createBinding` gave for it.
   */
  async #bindingFor(
    tenantId: string,
    values: WecomCredentialValues,
  ): Promise<ChannelOutcome<WeComChannelBinding>> {
    const existing = (await this.bindings.listBindings()).find(
      (binding) =>
        binding.tenantId === tenantId &&
        isWeComBindingActive(binding) &&
        binding.corpId === values.corpId &&
        binding.openKfId === values.openKfId,
    );
    if (existing !== undefined) {
      return { ok: true, value: existing };
    }
    // The store is decided by the platform's own rule instead of being asked
    // for: there is no store screen, so an operator has no way to name one, and
    // the rule that places a seat is the rule that places an account.
    const store = await resolveServingStore({
      repository: this.directory,
      ids: new RandomAuthIdGenerator(),
      now: new Date().toISOString(),
      tenantId,
    });
    return this.createBinding({
      tenantId,
      storeId: store.id,
      corpId: values.corpId,
      openKfId: values.openKfId,
    });
  }

  /**
   * The verdict recorded against the stored credential set, or `null`.
   *
   * Read from the same row the transport authenticates with, so the line under
   * the button after a reload is about the values that are actually in effect.
   * A set nothing has been proven against — no row, or a row written but never
   * probed — has no verdict to report, which is not the same as a failure.
   */
  async #storedVerdict(): Promise<WecomCredentialVerdict | null> {
    const stored = await this.credentialStore.readCurrentCredentials();
    if (stored === undefined || stored.verifiedAt === null) {
      return null;
    }
    return {
      connected: stored.verifiedError === null,
      // Only a set typed into the console can hold a verdict: nothing writes one
      // for the environment's set, because nothing here proves it.
      credentialSource: 'console',
      verifiedAt: stored.verifiedAt,
      verifiedError: stored.verifiedError,
    };
  }

  /**
   * The bindings one member may see.
   *
   * A platform administrator acts for no single tenant and sees every binding;
   * an administrator of one tenant sees that tenant's; a seat sees none, because
   * which store a provider account writes into is an administrative fact and a
   * seat administers nothing. The store is unscoped on purpose — see
   * {@link WecomBindingRepository.listBindings} — so the narrowing is here.
   */
  async #visibleBindings(member: Member): Promise<ReadonlyArray<WeComChannelBinding>> {
    if (member.role === 'agent') {
      return [];
    }
    const all = await this.bindings.listBindings();
    return member.tenantId === null
      ? all
      : all.filter((binding) => binding.tenantId === member.tenantId);
  }

  /**
   * Answer WeCom's callback URL handshake.
   *
   * The plaintext this returns is what WeCom echoes back as proof; it is never
   * wrapped, quoted or decorated, so the caller must write it verbatim.
   *
   * @param input - Handshake query parameters.
   * @returns The plaintext to answer with, or a stable refusal.
   */
  async verifyCallbackUrl(input: WecomCallbackUrlInput): Promise<ChannelOutcome<string>> {
    if (this.realTransport === null) {
      return channelFailure(
        HttpStatus.SERVICE_UNAVAILABLE,
        'channel_disabled',
        'no real WeCom customer-service transport is bound in this build',
      );
    }
    const result = await this.realTransport.verifyCallbackUrl(input);
    if (result.ok) {
      return { ok: true, value: result.value };
    }
    // The handshake and the webhook share one projection, so a signature this
    // transport refuses and a transport that is not configured cannot answer
    // with the same status as each other or differently per route.
    return channelFailureFromCallbackVerification(result);
  }

  /** Push outbound messages to real customers; unavailable without a real transport. */
  syncMessages(): never {
    throw new ChannelDisabledException(CHANNEL_PROVIDER_WECOM, 'sync');
  }
}
