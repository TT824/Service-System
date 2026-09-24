/**
 * The WeChat Customer Service adapter.
 *
 * It speaks the customer-service interface (`/cgi-bin/kf/*`), never the group
 * robot webhook: the two share a callback envelope but nothing else, and a robot
 * webhook cannot send to a customer service session.
 *
 * What this slice owns:
 *
 * - **callback URL verification** — decrypt `echostr` and answer with the
 *   plaintext, which is the handshake WeCom requires before it stores a callback
 *   URL at all ({@link RealWecomAdapter.verifyCallbackUrl});
 * - **callback authentication** — `sha1(sort(Token, timestamp, nonce, Encrypt))`
 *   over the *raw* request body, so nothing the platform re-serialized can be
 *   mistaken for what WeCom signed;
 * - **payload decryption and mapping** — AES-256-CBC with the corp id checked,
 *   then a text/image/link callback mapped into a provider-neutral
 *   {@link UnifiedMessage} ({@link mapWecomInboundMessage});
 * - **outbound sending** — delegated to `@kefu/wecom`'s `WecomOutboundSender`,
 *   the one implementation of `kf/send_msg` in this repository: the Worker
 *   delivers the outbox entries the API queued through that same sender, so a
 *   retry and a first attempt cannot disagree about what the provider was asked
 *   or what its answer meant. The `kf/sync_msg` pull, which stays here, recovers
 *   from a rejected cached token the same way the sender does.
 * - **media upload** — delegated to `@kefu/wecom`'s `WecomMediaUploader`, which
 *   turns image bytes into a provider `media_id` through the official
 *   temporary-media endpoint using the same HTTP port and the same token
 *   provider as a send. With a `media_id` in hand the existing `msgtype: image`
 *   send path is complete, which is what makes `sendImage` an honest claim.
 * - **media download** — delegated to `@kefu/wecom`'s `WecomMediaDownloader`,
 *   the mirror of the uploader: same ports, same credential, same single replay
 *   after an authentication failure. An inbound image arrives as a `media_id`
 *   and nothing else, so this is the half that turns it back into bytes the
 *   platform can keep.
 *
 * What the download deliberately does *not* decide: what is worth keeping. The
 * endpoint is asked for the media a message referenced and the bytes are handed
 * back; the size and type a message may be *stored* with are the ingest path's
 * call, made where a refusal can be written down as a placeholder.
 *
 * The customer-service *event flow* used to be on that list. It is now wired
 * through two operations that stay inside this seam:
 *
 * - {@link RealWecomAdapter.readNotification} decrypts an authenticated
 *   callback once and reports which of the two shapes it is: a direct message
 *   callback, or a `kf_msg_or_event` notification — a callback that carries no
 *   message at all, only a short-lived `Token` and an `OpenKfId`;
 * - {@link RealWecomAdapter.pullSyncMessages} performs the `kf/sync_msg` pull
 *   that token and account require, mapping each customer text/image/link
 *   record onto a {@link UnifiedMessage}.
 *
 * Neither operation decides *whose* platform scope an account belongs to, and
 * neither persists anything: the binding and the paging cursor are durable
 * platform facts the caller owns, so the adapter is handed the scope it must map
 * into and the cursor it must resume from, and returns the provider's next one.
 * The notification `Token` is likewise the caller's to use and never to store.
 */

import {
  CHANNEL_PROVIDER_WECOM,
  channelMessagePlaceholder,
  createUnifiedMessage,
  isWeComSyncCursorPosition,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelResult,
  type MessageType,
  type SendMessageInput,
  type SendMessageResult,
  type UnifiedMessage,
  type WebhookVerificationInput,
  type WebhookVerificationResult,
  type WecomCredentialValues,
} from '@kefu/core';
import {
  WecomMediaDownloader,
  WecomMediaUploader,
  WecomOutboundSender,
  asRecord,
  isWecomAuthenticationError,
  numberOf,
  textOf,
  useWecomCredentials,
  type WecomCredentialReader,
  type WecomHttpClient,
  type WecomMediaDownloadTransport,
  type WecomMediaUploadTransport,
  type WecomOutboundTransport,
  type WecomTokenProvider,
} from '@kefu/wecom';
import {
  decryptWecomPayload,
  readXmlField,
  signatureMatches,
  wecomSignature,
} from './wecom-crypto';

/** WeCom's customer-service backlog endpoint. */
const SYNC_URL = 'https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg';

/** The three callback message types this slice maps. */
const SUPPORTED_MESSAGE_TYPES = ['text', 'image', 'link'] as const;

/** The `MsgType` of a customer-service notification rather than a message. */
const EVENT_MESSAGE_TYPE = 'event';

/** The `Event` a customer-service notification carries. */
const MESSAGE_EVENT = 'kf_msg_or_event';

/**
 * The `origin` WeCom stamps on a message the *customer* sent.
 *
 * The other values describe a system notice and an agent's own reply, and
 * neither is a new customer message: ingesting them would open a reply window
 * for something nobody asked, so they are skipped rather than mapped.
 */
const CUSTOMER_ORIGIN = 3;

/**
 * Placeholder MIME type for an image whose real type only the download knows.
 *
 * Neither shape of an inbound image — a callback or a pulled record — carries a
 * content type; it is the *response* to the media download that names one. So
 * this is what a mapped image is described as until the bytes are fetched, and
 * what a message keeps when the fetch finds nothing.
 */
const UNKNOWN_MIME_TYPE = 'application/octet-stream';

/** Platform tenant and store a provider callback belongs to. */
export type WecomScope = {
  readonly tenantId: string;
  readonly storeId: string;
};

/**
 * Resolve the platform scope of one customer-service callback.
 *
 * WeCom identifies a session by `open_kfid` and an external user, not by a
 * platform tenant, so the binding is a platform decision and cannot be guessed
 * by the adapter. Returning `null` means "not bound yet", and the adapter then
 * refuses the callback instead of inventing a tenant.
 */
export type WecomScopeResolver = (input: {
  readonly corpId: string;
  readonly openKfId: string | null;
  readonly externalCustomerId: string;
}) => Promise<WecomScope | null>;

/**
 * A resolver that binds nothing.
 *
 * For an adapter constructed on its own — a unit test of the mapping or the
 * handshake — where no binding store exists to consult. It is deliberately
 * *not* what a deployed application uses: the module's own provider resolves
 * every callback through the durable `wecom_channel_bindings` table, so an
 * account that a notification can pull for is an account a direct callback can
 * be ingested from, and neither shape can be served by a value only a test has.
 */
export const UNBOUND_WECOM_SCOPE: WecomScopeResolver = async () => null;

/**
 * Injection token carrying the platform binding of a customer-service account.
 *
 * The binding is a platform decision: WeCom identifies a session by `open_kfid`
 * and an external user, never by a tenant, so the adapter receives the mapping
 * as a dependency instead of guessing one. The application binds
 * `wecomScopeResolverFromBindings` here, which answers from the same durable
 * binding the `kf/sync_msg` pull resolves, so both callback shapes see one
 * account-to-tenant decision. Publishing it under its own token also lets a
 * deployment replace that one value without touching the adapter or the delivery
 * loop.
 */
export const WECOM_SCOPE_RESOLVER = Symbol('WECOM_SCOPE_RESOLVER');

/**
 * A customer-service callback that announces work instead of carrying it.
 *
 * WeCom posts `kf_msg_or_event` to the callback URL and expects the platform to
 * pull the messages from `kf/sync_msg`. The callback itself holds no message, so
 * everything it does hold is provider plumbing and stays behind this seam.
 */
export type WecomCallbackNotification = {
  /** `open_kfid` of the account the notification names, when the body carries one. */
  readonly openKfId: string | null;
  /**
   * Short-lived pull credential the provider put in the notification.
   *
   * Used once, for the `kf/sync_msg` call the notification requires. It is never
   * persisted, never logged, never returned to a caller and never placed in a
   * failure message — the same handling the customer-service secret gets.
   */
  readonly notificationToken: string;
};

/**
 * Which of the two shapes one *authenticated* callback has.
 *
 * A direct message callback is mapped here, because the transport already owns
 * the decrypt and the field mapping; the caller then only has to authorize the
 * scope and persist it. A notification carries no message and is handed back as
 * the provider plumbing it is.
 */
export type WecomCallbackKind =
  | { readonly kind: 'message'; readonly message: UnifiedMessage }
  | ({ readonly kind: 'notification' } & WecomCallbackNotification);

/** One authenticated `kf/sync_msg` pull request. */
export type WecomSyncPullInput = {
  /** Customer-service account to pull for. */
  readonly openKfId: string;
  /** Cursor to resume from; `null` starts from the provider's own beginning. */
  readonly cursor: string | null;
  /** Notification token the pull is authorized with. */
  readonly notificationToken: string;
  /** Maximum records to ask for in this page. */
  readonly limit: number;
  /** Platform scope the pulled records belong to. */
  readonly scope: WecomScope;
};

/** One bounded page of the provider backlog. */
export type WecomSyncPage = {
  /**
   * Customer text/image/link records of this page, mapped and ready to ingest.
   *
   * Records that are not a customer message — system notices and the agent's own
   * replies — are deliberately absent: they are not new inbound messages and the
   * platform must never open a reply window for them.
   */
  readonly messages: ReadonlyArray<UnifiedMessage>;
  /**
   * Position the backlog resumes from once this page is durable.
   *
   * Not nullable: a successful page always carries where it stopped, so a caller
   * can never store "nowhere" as the account's position. A provider answer
   * without a usable cursor is refused rather than mapped.
   */
  readonly nextCursor: string;
  /** Whether the provider reports more records beyond this page. */
  readonly hasMore: boolean;
};

/** Everything the adapter needs that is not a credential. */
export type RealWecomAdapterDeps = {
  /** Outbound HTTP port; tests bind a fake so nothing reaches the network. */
  readonly http: WecomHttpClient;
  /** Access-token provider, which owns the cache and the refresh policy. */
  readonly tokens: WecomTokenProvider;
  /** Platform scope binding of an inbound callback. */
  readonly scope: WecomScopeResolver;
  /** Deadline applied to each provider request. */
  readonly timeoutMs: number;
  /** Injectable clock, so a mapping test can pin `receivedAt`. */
  readonly now?: () => number;
};

/**
 * The real-transport capabilities this adapter can honestly claim.
 *
 * `sendImage` is `true` because both halves of an image delivery are bound
 * here: {@link RealWecomAdapter.uploadMedia} produces a provider `media_id`
 * through the official temporary-media endpoint, and the shared send path
 * already turns a `media_id` into a `msgtype: image` message. It would be
 * `false` again the moment either half stopped being wired — a capability is a
 * promise about a delivery the transport can actually complete.
 */
export const REAL_WECOM_CAPABILITIES: ChannelCapabilities = Object.freeze({
  receiveText: true,
  receiveImage: true,
  sendText: true,
  sendImage: true,
  sendLink: true,
});

/** Query parameters of the callback URL handshake. */
export type WecomCallbackUrlInput = {
  readonly signature: string | null;
  readonly timestamp: string | null;
  readonly nonce: string | null;
  readonly echostr: string | null;
};

/**
 * The part of the real transport that is not on the provider-neutral contract.
 *
 * A Mock boot has no equivalent, so the application asks for this shape through
 * a separate injection token and gets `null` when the Mock is bound, instead of
 * widening {@link ChannelAdapter} with methods most transports cannot answer.
 */
export interface WecomRealTransport {
  /** Complete WeCom's callback URL handshake, returning the plaintext. */
  verifyCallbackUrl(input: WecomCallbackUrlInput): Promise<ChannelResult<string>>;
  /** Report whether the credentials and network really reach WeCom. */
  probeConnection(): Promise<boolean>;
  /**
   * Forget what the previous credential proved, then prove the current one.
   *
   * The order is the whole point, which is why it is one operation rather than
   * two the caller sequences: the probe trusts a recent success, and a success
   * that was reached on *different* values must not be inherited by the ones
   * just written. The cache the success lives in is the token provider's, so the
   * pair belongs here, beside it — a caller cannot get the order wrong if it
   * never performs the steps.
   *
   * @returns `true` only when WeCom answered with a token for these values.
   */
  reconnect(): Promise<boolean>;
  /**
   * Decrypt one *authenticated* callback and say which shape it is.
   *
   * The signature must already have been verified over these same bytes: this
   * reads provider fields out of the plaintext, so it is only meaningful on
   * bytes the provider signed, and the caller authenticates before it classifies.
   *
   * @param input - Raw, already authenticated callback body.
   * @returns The mapped message or the bare notification, or a stable failure.
   */
  readNotification(input: { readonly rawBody: string }): Promise<ChannelResult<WecomCallbackKind>>;
  /**
   * Pull one bounded page of the customer-service backlog.
   *
   * No cursor is stored here: the position belongs to the account and to the
   * caller that owns the durable binding, so the adapter is handed the cursor to
   * resume from and returns the provider's next one.
   *
   * @param input - Account, cursor, notification token, page bound and scope.
   * @returns The mapped page, or a stable failure.
   */
  pullSyncMessages(input: WecomSyncPullInput): Promise<ChannelResult<WecomSyncPage>>;
}

/**
 * Injection token carrying the bound real transport.
 *
 * `null` when the Mock transport is bound: the application asks whether a real
 * transport exists rather than assuming one does, so no Mock build has to stub
 * a handshake or a connectivity probe it cannot answer.
 */
export const WECOM_REAL_TRANSPORT = Symbol('WECOM_REAL_TRANSPORT');

/** Whether a bound adapter is the real WeCom transport. */
export function isWecomRealTransport(value: unknown): value is WecomRealTransport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<WecomRealTransport>;
  return (
    typeof candidate.verifyCallbackUrl === 'function' &&
    typeof candidate.probeConnection === 'function' &&
    typeof candidate.reconnect === 'function' &&
    typeof candidate.readNotification === 'function' &&
    typeof candidate.pullSyncMessages === 'function'
  );
}

/**
 * Provider adapter for the enterprise WeChat customer-service interface.
 *
 * Every credential is read at the point of use, through the reader this adapter
 * is handed, and never held. That is what makes a connection typed into the
 * console effective for the *next* callback rather than the next restart, and it
 * is why the reading happens once per entry point and is threaded down: an
 * operation authenticates as exactly one account, the one the reader answered
 * with at its start.
 *
 * The customer-service secret is never a fallback for the self-built application
 * secret: real mode requires it and refuses to run without it, because the
 * customer-service interface stopped accepting an application secret.
 */
export class RealWecomAdapter implements ChannelAdapter, WecomRealTransport {
  readonly channel = CHANNEL_PROVIDER_WECOM;
  readonly capabilities = REAL_WECOM_CAPABILITIES;

  /**
   * The shared outbound implementation, built once from the same ports this
   * adapter was handed.
   *
   * Composition, not inheritance: the callback half of the transport and the
   * outbound half have nothing in common but the credential and the HTTP port,
   * and only the outbound half has to be the *same code* in the Worker. Wiring
   * it here keeps the API's transport behind one `ChannelAdapter` token while the
   * sending itself comes from `@kefu/wecom`.
   */
  readonly #outbound: WecomOutboundTransport;

  /**
   * The shared media upload implementation, built from the same ports as the
   * sender.
   *
   * Bound here for the same reason the sender is: the upload is the other half
   * of one image delivery, so it reads the account's credential through the same
   * token provider and cannot grow a second opinion about what an unconfigured
   * transport says.
   */
  readonly #media: WecomMediaUploadTransport;

  /**
   * The shared media download implementation, built from the same ports as the
   * sender and the uploader.
   *
   * Bound here for the same reason the uploader is: an inbound image is one
   * provider call made with the account's credential, so the fetch cannot grow
   * a second opinion about which token it used or what a rejected media id
   * means. Unlike the uploader it is on the *inbound* path, which is why the
   * ingest path asks the adapter for it rather than calling the endpoint
   * itself.
   */
  readonly #mediaDownload: WecomMediaDownloadTransport;

  /**
   * @param credentials - Reads the account the transport authenticates as.
   * @param deps - HTTP port, token provider, scope resolver and clock.
   */
  constructor(
    private readonly credentials: WecomCredentialReader,
    private readonly deps: RealWecomAdapterDeps,
  ) {
    // The three shared implementations are handed the *reader*, not a set read
    // here: they resolve it per operation, which is what lets a credential
    // written from the console take effect on the next message instead of the
    // next restart.
    this.#outbound = new WecomOutboundSender(deps.http, deps.tokens, {
      credentials,
      timeoutMs: deps.timeoutMs,
    });
    this.#media = new WecomMediaUploader(deps.http, deps.tokens, {
      timeoutMs: deps.timeoutMs,
      credentials,
    });
    this.#mediaDownload = new WecomMediaDownloader(deps.http, deps.tokens, {
      timeoutMs: deps.timeoutMs,
      credentials,
    });
  }

  // --------------------------------------------------------------------------
  // Callback authentication and payload decryption
  // --------------------------------------------------------------------------

  /**
   * Authenticate one callback with the `msg_signature` over the raw body.
   *
   * @param input - Signature, timestamp, nonce and the raw request body.
   * @returns The verified result, or a stable failure.
   */
  async verifyWebhook(
    input: WebhookVerificationInput,
  ): Promise<ChannelResult<WebhookVerificationResult>> {
    const account = await useWecomCredentials(this.credentials);
    if (account._tag === 'refused') {
      return account.refusal;
    }
    const encrypt = readXmlField(input.rawBody, 'Encrypt');
    if (encrypt === null) {
      return invalid('the callback body carries no <Encrypt> element');
    }
    const rejection = this.#rejectBadSignature(
      input.signature,
      input.timestamp,
      input.nonce,
      encrypt,
      account.values,
    );
    return rejection ?? { ok: true, value: { verified: true } };
  }

  /**
   * Complete the callback URL handshake.
   *
   * WeCom sends a `GET` with an encrypted `echostr` and expects the decrypted
   * plaintext back, so this both authenticates the request and proves the
   * platform holds the right `EncodingAESKey` and corp id.
   *
   * @param input - Handshake query parameters.
   * @returns The plaintext to answer with, or a stable failure.
   */
  async verifyCallbackUrl(input: WecomCallbackUrlInput): Promise<ChannelResult<string>> {
    const account = await useWecomCredentials(this.credentials);
    if (account._tag === 'refused') {
      return account.refusal;
    }
    if (input.echostr === null) {
      return invalid('the callback URL verification carries no echostr');
    }
    // The handshake signs the ciphertext parameter itself, exactly like a
    // message callback signs its <Encrypt> element.
    const rejection = this.#rejectBadSignature(
      input.signature,
      input.timestamp,
      input.nonce,
      input.echostr,
      account.values,
    );
    if (rejection !== null) {
      return rejection;
    }
    const decrypted = decryptWecomPayload(
      account.values.aesKey,
      input.echostr,
      account.values.corpId,
    );
    return decrypted.ok ? { ok: true, value: decrypted.message } : invalid(decrypted.reason);
  }

  /**
   * Decrypt one callback and map it into a provider-neutral message.
   *
   * The signature was already checked by {@link verifyWebhook} over these same
   * bytes, so this step is the mapping: decrypt, resolve the platform scope, and
   * project the text/image/link fields onto {@link UnifiedMessage}.
   *
   * @param input - Raw callback body.
   * @returns The unified inbound message, or a stable failure.
   */
  async parseInboundMessage(input: {
    readonly rawBody: string;
  }): Promise<ChannelResult<UnifiedMessage>> {
    const classified = await this.readNotification(input);
    if (!classified.ok) {
      return classified;
    }
    // A notification is not a message, and a provider-neutral caller has no way
    // to express "pull the backlog": it is refused rather than mapped into a
    // message the platform never received. {@link readNotification} is the
    // entry point that can answer it.
    return classified.value.kind === 'notification'
      ? eventNotificationRefusal()
      : { ok: true, value: classified.value.message };
  }

  /**
   * Decrypt one authenticated callback and say which shape it is.
   *
   * This is the single decrypt of a real callback: the caller authenticates the
   * bytes first, then this method reads the plaintext once and either maps a
   * direct message — resolving the platform scope the same way
   * {@link parseInboundMessage} does — or hands back the `kf_msg_or_event`
   * plumbing that requires a `kf/sync_msg` pull.
   *
   * @param input - Raw callback body the signature was already checked over.
   * @returns The mapped message or the notification, or a stable failure.
   */
  async readNotification(input: {
    readonly rawBody: string;
  }): Promise<ChannelResult<WecomCallbackKind>> {
    const account = await useWecomCredentials(this.credentials);
    if (account._tag === 'refused') {
      return account.refusal;
    }
    const decrypted = this.#decryptCallback(input.rawBody, account.values);
    if (!decrypted.ok) {
      return decrypted;
    }
    const xml = decrypted.value;
    const openKfId = readXmlField(xml, 'OpenKfId') ?? configuredOpenKfId(account.values);

    if (readXmlField(xml, 'MsgType') === EVENT_MESSAGE_TYPE) {
      if (readXmlField(xml, 'Event') !== MESSAGE_EVENT) {
        return invalid('the callback is a customer-service event this transport does not handle');
      }
      // A notification carries no customer identity at all, which is why it is
      // recognised before anything below demands one.
      const notificationToken = readXmlField(xml, 'Token');
      if (notificationToken === null) {
        return invalid('the customer-service notification carries no <Token> to pull with');
      }
      return { ok: true, value: { kind: 'notification', openKfId, notificationToken } };
    }

    const externalCustomerId = readXmlField(xml, 'FromUserName');
    if (externalCustomerId === null) {
      return invalid('the decrypted callback carries no <FromUserName>');
    }
    const scope = await this.deps.scope({
      corpId: account.values.corpId,
      openKfId,
      externalCustomerId,
    });
    if (scope === null) {
      return {
        ok: false,
        code: 'channel_not_configured',
        message: 'the WeCom customer-service callback is not bound to a platform tenant/store yet',
        retryable: false,
      };
    }
    const mapped = mapWecomInboundMessage({
      xml,
      openKfId,
      scope,
      now: this.deps.now ?? (() => Date.now()),
    });
    return mapped.ok ? { ok: true, value: { kind: 'message', message: mapped.value } } : mapped;
  }

  /**
   * Pull one bounded page of the customer-service backlog.
   *
   * The notification token authorizes exactly this call and is placed in the
   * request body only; the access token comes from the shared provider, which
   * owns its cache and refresh policy. An authentication failure — the cached
   * access token was rejected — costs exactly one refresh and one replay, the
   * same recovery {@link sendMessage} performs and for the same reason: the
   * notification token WeCom hands out cannot be re-issued, so spending it on a
   * failure a fresh access token would have avoided loses the notification
   * window. A second rejection is final and is never retried again.
   *
   * A page is refused as a whole when any customer record in it cannot be
   * mapped, so a caller never advances past a record the platform did not
   * understand. It is refused too when it cannot say where the backlog resumes:
   * a page with no usable `next_cursor`, or one that claims more records while
   * handing back the position it was given, would leave the caller re-pulling
   * the same window with nothing to advance to.
   *
   * @param input - Account, cursor, notification token, page bound and scope.
   * @returns The mapped page, or a stable failure.
   */
  async pullSyncMessages(input: WecomSyncPullInput): Promise<ChannelResult<WecomSyncPage>> {
    const account = await useWecomCredentials(this.credentials);
    if (account._tag === 'refused') {
      return account.refusal;
    }
    const first = await this.#pullOnce(input);
    if (first.result.ok || !isWecomAuthenticationError(first.errcode)) {
      return first.result;
    }
    // The token was rejected. Drop it so the replay asks WeCom for a new one,
    // and replay exactly once — a second authentication failure is final.
    await this.deps.tokens.invalidate();
    const second = await this.#pullOnce(input);
    return second.result;
  }

  /**
   * Perform one `kf/sync_msg` request, keeping the `errcode` for the retry
   * decision.
   *
   * @param input - Account, cursor, notification token, page bound and scope.
   * @returns The attempted page and the provider's `errcode`, if it named one.
   */
  async #pullOnce(
    input: WecomSyncPullInput,
  ): Promise<{ readonly errcode: number | null; readonly result: ChannelResult<WecomSyncPage> }> {
    const token = await this.deps.tokens.get();
    if (!token.ok) {
      return { errcode: null, result: token };
    }
    let status: number;
    let body: unknown;
    try {
      const response = await this.deps.http.send({
        method: 'POST',
        url: `${SYNC_URL}?access_token=${encodeURIComponent(token.value)}`,
        body: {
          // The provider's first pull starts from no cursor at all, so the field
          // is omitted rather than sent empty.
          ...(input.cursor === null ? {} : { cursor: input.cursor }),
          token: input.notificationToken,
          limit: input.limit,
          voice_format: 0,
          open_kfid: input.openKfId,
        },
        timeoutMs: this.deps.timeoutMs,
      });
      status = response.status;
      body = response.body;
    } catch {
      return {
        errcode: null,
        result: {
          ok: false,
          code: 'channel_provider_error',
          message: 'the WeCom sync endpoint could not be reached',
          retryable: true,
        },
      };
    }

    const record = asRecord(body);
    const errcode = numberOf(record?.['errcode']);
    if (errcode !== 0) {
      return { errcode, result: mapSyncFailure(errcode, status) };
    }

    const rawList = record?.['msg_list'];
    const messages: UnifiedMessage[] = [];
    for (const entry of Array.isArray(rawList) ? rawList : []) {
      const mapped = mapWecomSyncRecord({
        record: entry,
        openKfId: input.openKfId,
        scope: input.scope,
        now: this.deps.now ?? (() => Date.now()),
      });
      if (!mapped.ok) {
        return { errcode: null, result: mapped };
      }
      // `null` is a record that is deliberately not a new customer message.
      if (mapped.value !== null) {
        messages.push(mapped.value);
      }
    }

    const rawNext = record?.['next_cursor'];
    if (!isWeComSyncCursorPosition(rawNext)) {
      return { errcode: null, result: noCursorProgress() };
    }
    const nextCursor = rawNext.trim();
    const hasMore = numberOf(record?.['has_more']) === 1;
    if (hasMore && nextCursor === input.cursor) {
      return { errcode: null, result: noCursorProgress() };
    }
    return { errcode: null, result: { ok: true, value: { messages, nextCursor, hasMore } } };
  }

  // --------------------------------------------------------------------------
  // Outbound
  // --------------------------------------------------------------------------

  /**
   * Send one message through `kf/send_msg`.
   *
   * The whole request-building, retry and failure-mapping behaviour lives in
   * `@kefu/wecom`'s `WecomOutboundSender`, which the Worker also delivers
   * through: one attempt classification, whichever process makes it.
   *
   * @param input - Provider-neutral outbound message.
   * @returns The provider message id, or a stable failure.
   */
  async sendMessage(input: SendMessageInput): Promise<ChannelResult<SendMessageResult>> {
    return this.#outbound.sendMessage(input);
  }

  /**
   * Report whether a fresh token can be fetched.
   *
   * The refusal is the token provider's own: it reads the same credential
   * through the same reader and answers `false` when the account is unusable,
   * so there is no second opinion here about what "not connected" means.
   *
   * @returns `true` only when WeCom actually answered with a token.
   */
  async probeConnection(): Promise<boolean> {
    return this.deps.tokens.probe();
  }

  /**
   * Forget the previous credential, then prove the current one.
   *
   * @returns `true` only when WeCom answered with a token for these values.
   */
  async reconnect(): Promise<boolean> {
    await this.deps.tokens.invalidate();
    return this.deps.tokens.probe();
  }

  // --------------------------------------------------------------------------
  // Not in this slice
  // --------------------------------------------------------------------------

  /**
   * Refuse the provider-neutral backlog operation.
   *
   * The pull itself is wired — {@link pullSyncMessages} — but it cannot be
   * expressed through this contract: a `kf/sync_msg` pull needs the account, the
   * persisted cursor and the notification token the platform received, and this
   * signature carries none of them. Answering `ok` with an empty list would
   * silently claim there is nothing to pull, which is exactly the lie the manual
   * sync route must not tell.
   */
  async syncMessages(): Promise<
    ChannelResult<{ readonly messages: ReadonlyArray<UnifiedMessage> }>
  > {
    return unImplemented('syncMessages');
  }

  /**
   * Download one image the provider holds for this account.
   *
   * An inbound customer image arrives as a `media_id` and nothing else — no
   * bytes, and on the pulled path not even a URL — so this is the only way the
   * platform can come to hold the picture itself. The endpoint, the credential,
   * the read bound and the single replay after an authentication failure live
   * in `@kefu/wecom`'s `WecomMediaDownloader`, which uses the same HTTP port and
   * token provider as {@link sendMessage}.
   *
   * @param input - The provider `media_id` the message arrived with.
   * @returns The bytes and their content type, or a stable failure.
   */
  async fetchMedia(input: {
    readonly mediaId: string;
  }): Promise<ChannelResult<{ readonly mimeType: string; readonly bytes: Uint8Array }>> {
    return this.#mediaDownload.fetchMedia(input);
  }

  /**
   * Upload one image and return its provider `media_id`.
   *
   * The tenant and store are the caller's scope, not the provider's: WeCom
   * identifies an account by credential, so they are not part of the request.
   * The upload itself — endpoint, `type=image`, multipart field, payload bounds,
   * the single replay after an authentication failure and the stable failure
   * mapping — lives in `@kefu/wecom`'s `WecomMediaUploader`, which uses the same
   * HTTP port and token provider as {@link sendMessage}.
   *
   * @param input - Tenant/store scope the upload is made for, and the image.
   * @returns The provider media id, or a stable failure.
   */
  async uploadMedia(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<ChannelResult<{ readonly mediaId: string }>> {
    return this.#media.uploadMedia({ mimeType: input.mimeType, bytes: input.bytes });
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Decrypt one callback body into its message document.
   *
   * The single place a real callback is decrypted, so the direct-callback path
   * and the notification path cannot disagree about the envelope. A failure
   * carries a safe reason and never the payload or the key.
   */
  #decryptCallback(rawBody: string, credentials: WecomCredentialValues): ChannelResult<string> {
    const encrypt = readXmlField(rawBody, 'Encrypt');
    if (encrypt === null) {
      return invalid('the callback body carries no <Encrypt> element');
    }
    const decrypted = decryptWecomPayload(credentials.aesKey, encrypt, credentials.corpId);
    return decrypted.ok ? { ok: true, value: decrypted.message } : invalid(decrypted.reason);
  }

  /** Reject a request whose digest does not match, or whose triple is incomplete. */
  #rejectBadSignature(
    signature: string | null,
    timestamp: string | null,
    nonce: string | null,
    ciphertext: string,
    credentials: WecomCredentialValues,
  ): ChannelResult<never> | null {
    if (timestamp === null || nonce === null) {
      return invalid('the callback carries no timestamp or nonce to authenticate');
    }
    const expected = wecomSignature(credentials.callbackToken, timestamp, nonce, ciphertext);
    return signatureMatches(expected, signature)
      ? null
      : invalid('the callback msg_signature was rejected');
  }
}

/** The configured customer-service account id, or `null` when absent. */
function configuredOpenKfId(credentials: WecomCredentialValues): string | null {
  const openKfId = credentials.openKfId.trim();
  return openKfId.length > 0 ? openKfId : null;
}

/** Input of {@link mapWecomInboundMessage}. */
export type WecomInboundMappingInput = {
  /** The decrypted message document. */
  readonly xml: string;
  /** `open_kfid` of the account the callback arrived on, when known. */
  readonly openKfId: string | null;
  /** The platform scope the callback was resolved to. */
  readonly scope: WecomScope;
  /** Clock used when the payload carries no usable timestamp. */
  readonly now: () => number;
};

/**
 * Map a decrypted WeCom message document onto a {@link UnifiedMessage}.
 *
 * Exported as a pure function so the field mapping can be asserted directly,
 * without standing up the HTTP boundary or a provider connection.
 *
 * @param input - Decrypted XML and the resolved platform scope.
 * @returns The unified inbound message, or a stable failure.
 */
export function mapWecomInboundMessage(
  input: WecomInboundMappingInput,
): ChannelResult<UnifiedMessage> {
  const xml = input.xml;
  const messageType = readXmlField(xml, 'MsgType');
  if (messageType === EVENT_MESSAGE_TYPE) {
    return eventNotificationRefusal();
  }
  if (messageType === null) {
    // Not "a kind of message this slice cannot name" but "no message document at
    // all": every message the provider sends carries `<MsgType>`, so its absence
    // is a parse failure and is reported as one. A type that *is* named and is
    // not the three below is a different case — see {@link contentOf}.
    return invalid('the callback carries no <MsgType>');
  }

  const messageId = readXmlField(xml, 'MsgId');
  const externalCustomerId = readXmlField(xml, 'FromUserName');
  if (messageId === null || externalCustomerId === null) {
    return invalid('the callback carries no <MsgId> or <FromUserName>');
  }

  const openKfId = readXmlField(xml, 'OpenKfId') ?? input.openKfId;
  const mapped = contentOf(xml, messageType);
  return {
    ok: true,
    value: createUnifiedMessage({
      channel: CHANNEL_PROVIDER_WECOM,
      // The envelope has no independent event id, and `MsgId` is the provider's
      // stable identity for exactly one message, so it is both.
      externalEventId: messageId,
      tenantId: input.scope.tenantId,
      storeId: input.scope.storeId,
      externalCustomerId,
      // A customer-service session is `open_kfid` + external user; neither half
      // identifies it alone.
      externalConversationId:
        openKfId === null ? externalCustomerId : `${openKfId}:${externalCustomerId}`,
      externalMessageId: messageId,
      direction: 'inbound',
      messageType: unifiedMessageType(messageType),
      content: mapped.content,
      dedupKey: `wecom:${messageId}`,
      media: mapped.media,
      receivedAt: receivedAtOf(xml, input.now),
    }),
  };
}

/** Mapped content and media of one callback message type. */
type MappedContent = {
  readonly content: string;
  readonly media: UnifiedMessage['media'];
};

/**
 * The unified message type a provider message type is stored as.
 *
 * The three mapped types keep their own. Everything else the provider names —
 * a voice note, a video, a file — is stored as `text` whose content is the
 * placeholder for its kind, because the alternative was refusing the callback:
 * the customer's message then never reached the workspace at all, and a refusal
 * the provider can retry is a message lost repeatedly rather than once.
 *
 * @param providerType - The provider's own `MsgType` or `msgtype`.
 * @returns A type the platform's message model has.
 */
function unifiedMessageType(providerType: string): MessageType {
  return isSupportedMessageType(providerType) ? providerType : 'text';
}

/**
 * Project one callback message type onto content and media.
 *
 * @param xml - The decrypted callback document.
 * @param messageType - Its `MsgType`, already known not to be null.
 */
function contentOf(xml: string, messageType: string): MappedContent {
  switch (messageType) {
    case 'text':
      return {
        content: readXmlField(xml, 'Content') ?? channelMessagePlaceholder('text'),
        media: null,
      };
    case 'image': {
      const mediaId = readXmlField(xml, 'MediaId');
      const url = readXmlField(xml, 'PicUrl');
      return {
        content: channelMessagePlaceholder('image'),
        media:
          mediaId === null
            ? null
            : {
                mediaId,
                // The callback carries no MIME type; the download's content
                // type is what replaces this, and it is only the *stored* copy
                // the ingest path writes that ever names one.
                mimeType: UNKNOWN_MIME_TYPE,
                ...(url === null ? {} : { url }),
              },
      };
    }
    case 'link':
      return {
        // A link callback is readable as its title; the URL is the fallback and
        // the shared placeholder is the floor, so the transcript never shows an
        // empty customer message.
        content:
          readXmlField(xml, 'Title') ??
          readXmlField(xml, 'Url') ??
          channelMessagePlaceholder('link'),
        media: null,
      };
    default:
      // A payload the platform has no unified type for. Only the placeholder is
      // carried: a voice or a file callback does name a media id, but the
      // platform fetches and stores media for images only, so a stored
      // reference here would point at something no reader ever asks for. The
      // kind itself is not lost — the placeholder says which it was, and the
      // workspace shows it as a message a person has to answer rather than as
      // the customer's words.
      return { content: channelMessagePlaceholder(messageType), media: null };
  }
}

/** Input of {@link mapWecomSyncRecord}. */
export type WecomSyncRecordInput = {
  /** One `msg_list` entry exactly as the provider sent it. */
  readonly record: unknown;
  /** `open_kfid` of the account the page was pulled for. */
  readonly openKfId: string;
  /** Platform scope the pulled records belong to. */
  readonly scope: WecomScope;
  /** Clock used when a record carries no usable `send_time`. */
  readonly now: () => number;
};

/**
 * Map one `kf/sync_msg` record onto a {@link UnifiedMessage}.
 *
 * Exported as a pure function for the same reason the callback mapping is: the
 * field mapping can be asserted directly, without a provider or an HTTP port.
 *
 * @param input - One provider record and the scope it was resolved into.
 * @returns `null` for a record that is deliberately not a new customer message —
 * a system notice or the agent's own reply; a stable failure for a customer
 * record this transport cannot map, so a caller never advances past it.
 */
export function mapWecomSyncRecord(
  input: WecomSyncRecordInput,
): ChannelResult<UnifiedMessage | null> {
  const record = asRecord(input.record);
  if (record === null) {
    return invalid('a kf/sync_msg record is not a JSON object');
  }
  if (numberOf(record['origin']) !== CUSTOMER_ORIGIN) {
    // Not a message the customer sent, so it is skipped rather than ingested:
    // an agent's own delivery must never open a reply window as if the customer
    // had written.
    return { ok: true, value: null };
  }
  const messageId = textOf(record['msgid']);
  const externalCustomerId = textOf(record['external_userid']);
  if (messageId === null || externalCustomerId === null) {
    return invalid('a customer kf/sync_msg record carries no msgid or external_userid');
  }
  const messageType = textOf(record['msgtype']);
  if (messageType === null) {
    // As on the callback path: an absent type is a record this transport cannot
    // read, not a message kind it does not map, and the two deserve different
    // answers. A named type outside the three is normalised instead — see
    // {@link contentOfRecord}.
    return invalid('a customer kf/sync_msg record carries no msgtype');
  }
  const content = contentOfRecord(record, messageType);
  return {
    ok: true,
    value: createUnifiedMessage({
      channel: CHANNEL_PROVIDER_WECOM,
      // As on the callback path, `msgid` is the provider's stable identity for
      // exactly one message and the envelope has no separate event id.
      externalEventId: messageId,
      tenantId: input.scope.tenantId,
      storeId: input.scope.storeId,
      externalCustomerId,
      // A customer-service session is `open_kfid` + external user, exactly as
      // the callback path composes it, so a message pulled here and a callback
      // for the same customer resolve to one conversation.
      externalConversationId: `${input.openKfId}:${externalCustomerId}`,
      externalMessageId: messageId,
      direction: 'inbound',
      messageType: unifiedMessageType(messageType),
      content: content.content,
      dedupKey: `wecom:${messageId}`,
      media: content.media,
      receivedAt: receivedAtOfRecord(record, input.now),
    }),
  };
}

/** Project one supported `kf/sync_msg` record onto content and media. */
function contentOfRecord(
  record: Readonly<Record<string, unknown>>,
  messageType: string,
): MappedContent {
  switch (messageType) {
    case 'text': {
      const text = asRecord(record['text']);
      return {
        content: textOf(text?.['content']) ?? channelMessagePlaceholder('text'),
        media: null,
      };
    }
    case 'image': {
      const image = asRecord(record['image']);
      const mediaId = textOf(image?.['media_id']);
      return {
        content: channelMessagePlaceholder('image'),
        // A pull carries only the media id; the download's content type is what
        // the ingest path stores, exactly as on the callback path.
        media: mediaId === null ? null : { mediaId, mimeType: UNKNOWN_MIME_TYPE },
      };
    }
    case 'link': {
      const link = asRecord(record['link']);
      // Same reading as the callback path: the title is what a transcript can
      // show, the URL is the fallback, and the shared placeholder is the floor.
      return {
        content:
          textOf(link?.['title']) ?? textOf(link?.['url']) ?? channelMessagePlaceholder('link'),
        media: null,
      };
    }
    default:
      // As on the callback path, and for the same reason: a record the platform
      // has no unified type for is a customer's message, not a parsing failure,
      // and refusing it also stopped the cursor from advancing past it.
      return { content: channelMessagePlaceholder(messageType), media: null };
  }
}

/** Read `send_time` as an ISO instant, falling back to the supplied clock. */
function receivedAtOfRecord(record: Readonly<Record<string, unknown>>, now: () => number): string {
  const seconds = numberOf(record['send_time']);
  if (seconds === null || seconds <= 0) {
    return new Date(now()).toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

/**
 * Refuse a `kf_msg_or_event` notification on the provider-neutral parse path.
 *
 * WeCom announces pending customer-service messages with an event and requires a
 * `kf/sync_msg` pull. That pull is now wired, but it needs a durable cursor and a
 * platform binding, neither of which a {@link UnifiedMessage} can carry — so a
 * provider-neutral caller is still told what it met rather than being handed a
 * message the platform never received. {@link RealWecomAdapter.readNotification}
 * is the entry point that can answer it. One helper keeps the two places that
 * must recognise the event saying the same thing.
 */
function eventNotificationRefusal(): ChannelResult<never> {
  return {
    ok: false,
    code: 'channel_invalid_request',
    message:
      'the callback is a customer-service event notification, not a message; it is answered by the kf/sync_msg notification path',
    retryable: false,
  };
}

/**
 * A page that cannot say where the backlog resumes.
 *
 * One refusal for both shapes of a non-progress answer — no cursor at all, or
 * the position it was given back while claiming more — because the caller must
 * react identically: stop, store nothing, and let the next notification try
 * again. The wording is the platform's own; nothing the provider sent is
 * carried into it.
 */
function noCursorProgress(): ChannelResult<never> {
  return {
    ok: false,
    code: 'channel_provider_error',
    message: 'the WeCom sync endpoint answered without advancing the kf/sync_msg cursor',
    retryable: false,
  };
}

/**
 * Map a rejected `kf/sync_msg` answer onto a stable channel failure.
 *
 * The provider's own `errmsg` is deliberately not carried: it is unbounded text
 * under the provider's control, and every field this failure reaches — an API
 * result, a log line, a delivery's stored diagnostics — is documented as safe to
 * expose. `errcode` is a number the provider chose from a fixed protocol, so it
 * stays for classification.
 *
 * @param errcode - The provider's `errcode`, or `null` when none was readable.
 * @param status - HTTP status the endpoint answered with.
 * @returns The stable channel failure.
 */
function mapSyncFailure(errcode: number | null, status: number): ChannelResult<never> {
  if (isWecomAuthenticationError(errcode)) {
    return {
      ok: false,
      code: 'channel_not_configured',
      message: `WeCom rejected the customer-service credential (errcode ${errcode ?? 'unknown'})`,
      retryable: false,
    };
  }
  if (errcode === null) {
    // The endpoint answered with something that is not a WeCom error document,
    // so the HTTP status is the only evidence available.
    return {
      ok: false,
      code: 'channel_provider_error',
      message: `the WeCom sync endpoint answered with HTTP ${status}`,
      retryable: status >= 500,
    };
  }
  return {
    ok: false,
    code: 'channel_provider_error',
    message: `the WeCom sync endpoint rejected the kf/sync_msg request (errcode ${errcode})`,
    // An expired notification token or an already-consumed cursor needs a new
    // notification, not another attempt with the same arguments.
    retryable: false,
  };
}

/** Read `CreateTime` as an ISO instant, falling back to the supplied clock. */
function receivedAtOf(xml: string, now: () => number): string {
  const raw = readXmlField(xml, 'CreateTime');
  const seconds = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return new Date(now()).toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

/** Whether a callback `MsgType` is one this slice maps. */
function isSupportedMessageType(value: string): value is (typeof SUPPORTED_MESSAGE_TYPES)[number] {
  return SUPPORTED_MESSAGE_TYPES.some((candidate) => candidate === value);
}

/** Stable failure for an operation this slice deliberately leaves unwired. */
function unImplemented(operation: string): ChannelResult<never> {
  return {
    ok: false,
    code: 'channel_not_configured',
    message: `the WeCom customer-service ${operation} operation is not wired in this transport slice`,
    retryable: false,
  };
}

/** Stable failure for a malformed or unauthenticated callback. */
function invalid<T>(message: string): ChannelResult<T> {
  return {
    ok: false,
    code: 'channel_invalid_request',
    message,
    retryable: false,
  };
}
