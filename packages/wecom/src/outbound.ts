/**
 * The outbound half of the WeCom customer-service transport.
 *
 * Sending is the one behaviour the API process and the Worker process must agree
 * on *exactly*: the API sends what an agent typed, the Worker re-sends a pending
 * outbox entry, and both must produce the same request, the same single
 * retry-after-auth-failure, the same handling of a lost provider id, and the same
 * stable failure codes — otherwise a retry would mean something different from
 * the attempt it follows, and a delivery's retry policy would be evaluated
 * against outcomes that are not comparable.
 *
 * So there is one implementation, {@link WecomOutboundSender}, and every caller
 * delegates to it. It is app-neutral: it holds an HTTP port, a token provider and
 * plain configuration values, and imports nothing from either application. The
 * Mock transport lives beside it for the same reason — the Worker must be able to
 * run a whole delivery loop deterministically without reaching the network, and
 * without importing an API module to do it.
 */

import {
  CHANNEL_PROVIDER_WECOM,
  channelMessagePlaceholder,
  createUnifiedMessage,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelResult,
  type SendMessageInput,
  type SendMessageResult,
  type UnifiedMessage,
  type UploadMediaResult,
  type WebhookVerificationInput,
  type WebhookVerificationResult,
} from '@kefu/core';
import type { WecomHttpClient } from './http-client';
import { asRecord, numberOf, textOf } from './readers';
import { useWecomCredentials, type WecomCredentialReader } from './credentials';
import { isWecomAuthenticationError, type WecomTokenProvider } from './token-provider';

/** WeCom's customer-service send endpoint. */
const SEND_URL = 'https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg';

/** WeCom's temporary-media upload endpoint, shared by every interface that needs media. */
const UPLOAD_URL = 'https://qyapi.weixin.qq.com/cgi-bin/media/upload';

/**
 * The media kinds this transport uploads, named the way the provider names them.
 *
 * `media/upload` takes exactly one `type` per request, and the type decides both
 * the ceiling and the container the provider accepts — so the kind travels with
 * the bytes instead of being re-derived from the MIME type at the last moment.
 * Voice is deliberately absent: nothing in this platform sends one, and an
 * upload no send can point at is an access token and a quota unit spent for
 * nothing.
 */
export type WecomMediaKind = 'image' | 'video' | 'file';

/** The `type` query parameter of each uploadable kind. */
const UPLOAD_TYPE_OF: Readonly<Record<WecomMediaKind, string>> = {
  image: 'image',
  video: 'video',
  file: 'file',
};

/** Form field the provider reads the uploaded file from. */
const UPLOAD_MEDIA_FIELD = 'media';

/** Error code WeCom returns when the 48-hour/five-message budget is exhausted. */
const REPLY_LIMIT_ERRCODE = 95002;

/** HTTP requests one attempt makes: the token it may have to fetch, then the send. */
const REQUESTS_PER_SEND_ATTEMPT = 2;

/** HTTP requests one upload attempt makes: the token it may have to fetch, then the upload. */
const REQUESTS_PER_UPLOAD_ATTEMPT = 2;

/**
 * Largest image payload this transport will hand to WeCom.
 *
 * WeCom documents a 10 MB ceiling for temporary images. Refusing above it here
 * keeps a request the provider would reject — after spending an access token and
 * a customer-service quota unit — from leaving the process at all.
 */
export const WECOM_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Largest video payload this transport will hand to WeCom.
 *
 * The same 10 MB ceiling an image has, and MP4 is the only container WeCom
 * takes for `type=video`; both bounds live in {@link mediaUploadRejection}.
 */
export const WECOM_VIDEO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Largest file payload this transport will hand to WeCom.
 *
 * WeCom documents a 20 MB ceiling for `type=file`. Above it the provider can
 * still answer, but with an errcode that names neither the limit nor the file,
 * so the refusal is made here where the message can be specific.
 */
export const WECOM_FILE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The ceiling WeCom documents for each uploadable kind.
 *
 * Kept beside the sizes themselves because the ceiling and the `type` a payload
 * is uploaded as are one decision: the provider measures the bytes against the
 * type the request named, so a kind is only honest if both travel together.
 */
const UPLOAD_MAX_BYTES_OF: Readonly<Record<WecomMediaKind, number>> = {
  image: WECOM_MEDIA_MAX_BYTES,
  video: WECOM_VIDEO_MAX_BYTES,
  file: WECOM_FILE_MAX_BYTES,
};

/**
 * Replays {@link WecomOutboundSender.sendMessage} permits after an authentication
 * failure.
 *
 * Exactly one, never a loop: a second authentication failure is final, because a
 * credential the provider has just rejected twice will not become valid on a
 * third try.
 */
export const WECOM_AUTH_REPLAY_ATTEMPTS = 1;

/**
 * The most HTTP requests one {@link WecomOutboundTransport.sendMessage} call can make.
 *
 * This is the transport's own worst case, published rather than left implicit
 * because a caller that has to bound the call in time — the Worker, whose claim
 * on an outbox entry expires — must size its per-request deadline against the
 * whole replay path, not against one request. Each attempt may fetch a token and
 * then send, and an authentication failure permits {@link
 * WECOM_AUTH_REPLAY_ATTEMPTS} more attempts, so the bound is
 * `REQUESTS_PER_SEND_ATTEMPT * (1 + WECOM_AUTH_REPLAY_ATTEMPTS)`.
 *
 * `outbox.spec.ts` counts the requests of the worst case and asserts they never
 * exceed this, so the constant cannot drift away from the implementation it
 * describes.
 */
export const WECOM_MAX_REQUESTS_PER_SEND =
  REQUESTS_PER_SEND_ATTEMPT * (1 + WECOM_AUTH_REPLAY_ATTEMPTS);

/**
 * The most HTTP requests one {@link WecomMediaUploader.uploadMedia} call can make.
 *
 * The same bound as a send, for the same reason: each attempt may fetch a token
 * and then upload, and an authentication failure permits
 * {@link WECOM_AUTH_REPLAY_ATTEMPTS} more attempts.
 */
export const WECOM_MAX_REQUESTS_PER_UPLOAD =
  REQUESTS_PER_UPLOAD_ATTEMPT * (1 + WECOM_AUTH_REPLAY_ATTEMPTS);

/**
 * The outbound capabilities the real customer-service transport can claim.
 *
 * `sendImage` is honest only because *both* halves of an image delivery are
 * wired here: {@link WecomMediaUploader} turns bytes into a provider `media_id`
 * through the official temporary-media endpoint, and
 * {@link wecomOutboundPayload} already turns a `media_id` into a `msgtype:
 * image` send. Before the uploader existed this claimed `false`, because a
 * capability is a promise about a delivery the transport can actually complete.
 */
export const WECOM_OUTBOUND_CAPABILITIES: ChannelCapabilities = Object.freeze({
  receiveText: true,
  receiveImage: true,
  sendText: true,
  sendImage: true,
  sendLink: true,
});

/**
 * The outbound seam every caller sends through.
 *
 * Publishing the capability rather than the class is what lets the Worker's
 * delivery processor depend on "something that can send one message" — a real
 * sender in production, the deterministic Mock in a test — without either of
 * them knowing which one it holds.
 */
export interface WecomOutboundTransport {
  /**
   * Send one message to one customer-service session.
   *
   * @param input - Provider-neutral outbound message.
   * @returns The provider message id, or a stable channel failure.
   */
  sendMessage(input: SendMessageInput): Promise<ChannelResult<SendMessageResult>>;
}

/** Everything the outbound sender needs that is not a port. */
export type WecomOutboundSenderOptions = {
  /**
   * Reads the account this send should be made as, at the moment of sending.
   *
   * Consulted once per {@link WecomOutboundSender.sendMessage}, never held: the
   * account the console holds may be replaced while the process runs, and a
   * message typed after that must be sent as the account that is configured
   * *then*. The account id used for a delivery whose conversation id does not
   * embed one comes from the same reading, which is the only honest fallback —
   * WeCom rejects a send that names no account.
   */
  readonly credentials: WecomCredentialReader;
  /** Deadline applied to each provider request. */
  readonly timeoutMs: number;
};

/** Result of one `kf/send_msg` attempt, keeping the `errcode` for the retry decision. */
type SendAttempt = {
  readonly errcode: number | null;
  readonly result: ChannelResult<SendMessageResult>;
};

/**
 * Sends one message through `kf/send_msg`.
 *
 * An authentication failure — the cached token was rejected — costs exactly one
 * refresh and one replay. Every other failure is mapped straight to a stable
 * channel failure and is never retried here: retry policy belongs to the
 * delivery record, not to the transport. A caller that retries therefore always
 * retries on a *classified* outcome, never on "the token was stale".
 */
export class WecomOutboundSender implements WecomOutboundTransport {
  /**
   * @param http - Outbound HTTP port.
   * @param tokens - Access-token provider, which owns the cache and refresh.
   * @param options - Credential reader and deadline.
   */
  constructor(
    private readonly http: WecomHttpClient,
    private readonly tokens: WecomTokenProvider,
    private readonly options: WecomOutboundSenderOptions,
  ) {}

  /** @inheritdoc */
  async sendMessage(input: SendMessageInput): Promise<ChannelResult<SendMessageResult>> {
    // The account is read before the payload is built: an unconfigured
    // transport refuses here without spending a provider request, and the
    // account id this send falls back to is the one just read.
    const account = await useWecomCredentials(this.options.credentials);
    if (account._tag === 'refused') {
      return account.refusal;
    }
    const payload = wecomOutboundPayload(input);
    if (!payload.ok) {
      return payload;
    }
    const request = this.#sendRequest(input, payload.value, account.values.openKfId);

    const first = await this.#sendOnce(request);
    if (first.result.ok || !isWecomAuthenticationError(first.errcode)) {
      return first.result;
    }
    // The token was rejected. Drop it so the replay asks WeCom for a new one,
    // and replay exactly once — a second authentication failure is final, which
    // is what `WECOM_AUTH_REPLAY_ATTEMPTS` fixes and
    // `WECOM_MAX_REQUESTS_PER_SEND` budgets for a caller that bounds the call.
    await this.tokens.invalidate();
    const second = await this.#sendOnce(request);
    return second.result;
  }

  /** Build the `kf/send_msg` body for one outbound message. */
  #sendRequest(
    input: SendMessageInput,
    payload: Readonly<Record<string, unknown>>,
    configuredOpenKfId: string,
  ): Readonly<Record<string, unknown>> {
    return {
      touser: input.externalCustomerId,
      open_kfid: openKfIdOfConversation(input.externalConversationId) ?? configuredOpenKfId,
      ...payload,
    };
  }

  /** Perform one `kf/send_msg` call, reporting the provider's `errcode` too. */
  async #sendOnce(request: Readonly<Record<string, unknown>>): Promise<SendAttempt> {
    const token = await this.tokens.get();
    if (!token.ok) {
      return { errcode: null, result: token };
    }
    let status: number;
    let body: unknown;
    try {
      const response = await this.http.send({
        method: 'POST',
        url: `${SEND_URL}?access_token=${encodeURIComponent(token.value)}`,
        body: request,
        timeoutMs: this.options.timeoutMs,
      });
      status = response.status;
      body = response.body;
    } catch {
      return {
        errcode: null,
        result: {
          ok: false,
          code: 'channel_provider_error',
          message: 'the WeCom send endpoint could not be reached',
          retryable: true,
        },
      };
    }

    const record = asRecord(body);
    const errcode = numberOf(record?.['errcode']);
    const messageId = textOf(record?.['msgid']);
    if (errcode === 0 && messageId !== null) {
      return { errcode, result: { ok: true, value: { externalMessageId: messageId } } };
    }
    if (errcode === 0) {
      // WeCom accepted the message but named no id, so the platform cannot
      // claim a delivery it cannot point at. The conservative reading is the
      // same one the delivery loop already uses for a lost response.
      return {
        errcode,
        result: {
          ok: false,
          code: 'channel_delivery_unknown',
          message: 'the provider accepted the message without returning an id',
          retryable: true,
          deliveryUnknown: true,
        },
      };
    }
    if (errcode === null) {
      // The endpoint answered with something that is not a WeCom error
      // document, so there is no business code to map and the HTTP status is
      // the only evidence available.
      return {
        errcode: null,
        result: {
          ok: false,
          code: 'channel_provider_error',
          message: `the WeCom send endpoint answered with HTTP ${status}`,
          retryable: status >= 500,
        },
      };
    }
    return { errcode, result: mapWecomSendFailure(errcode) };
  }
}

/** Build the `msgtype`-specific part of a `kf/send_msg` body. */
export function wecomOutboundPayload(
  input: SendMessageInput,
): ChannelResult<Readonly<Record<string, unknown>>> {
  switch (input.messageType) {
    case 'text':
      return { ok: true, value: { msgtype: 'text', text: { content: input.content } } };
    case 'link':
      // `content` is a flat string, so the URL is the payload and the URL is
      // also the only honest title the platform has. WeCom applies its own
      // length bounds and rejects an over-long one with an errcode the caller
      // maps to a stable failure.
      return {
        ok: true,
        value: { msgtype: 'link', link: { title: input.content, url: input.content } },
      };
    case 'image':
    case 'video':
    case 'file': {
      const mediaId = input.media?.mediaId;
      if (mediaId === undefined || mediaId.trim().length === 0) {
        // A media send carries nothing but the id of an upload, so a delivery
        // that arrives without one has no body to build. Refusing is the only
        // honest answer: the alternative is a provider call that can only fail
        // after the customer-service quota has been spent on it.
        return wecomInvalid(
          `a WeCom ${input.messageType} delivery requires an uploaded media id`,
        );
      }
      // The three kinds differ only in the key their payload nests under;
      // WeCom takes one `media_id` for each, and nothing else.
      return {
        ok: true,
        value: { msgtype: input.messageType, [input.messageType]: { media_id: mediaId } },
      };
    }
  }
}

/**
 * Recover the `open_kfid` from a conversation id the platform built.
 *
 * The platform composes a customer-service session id as `<open_kfid>:<user>`,
 * and an `open_kfid` always starts with `wk`. Anything else is not one, so the
 * configured account id is used instead of a misread prefix.
 *
 * @param externalConversationId - Conversation id from the delivery record.
 * @returns The embedded account id, or `null`.
 */
export function openKfIdOfConversation(externalConversationId: string): string | null {
  const separator = externalConversationId.indexOf(':');
  if (separator <= 0) {
    return null;
  }
  const candidate = externalConversationId.slice(0, separator);
  return /^wk[A-Za-z0-9_-]+$/.test(candidate) ? candidate : null;
}

/**
 * Map a rejected `kf/send_msg` answer onto a stable channel failure.
 *
 * The provider's `errmsg` is deliberately not carried: it is unbounded text
 * under the provider's control, and every field this failure reaches — an API
 * result, a log line, a delivery's stored diagnostics — is documented as safe to
 * expose. `errcode` is a number the provider chose from a fixed protocol, so it
 * stays for classification.
 *
 * @param errcode - The provider's `errcode`.
 * @returns The stable channel failure.
 */
export function mapWecomSendFailure(errcode: number): ChannelResult<SendMessageResult> {
  if (errcode === REPLY_LIMIT_ERRCODE) {
    // The provider applies the same 48-hour/five-message budget the platform
    // gates on, so this answer means the two disagreed. Another attempt would
    // be refused identically, which makes it a definite failure, not a retry.
    return {
      ok: false,
      code: 'channel_provider_error',
      message: 'the customer-service reply limit for this window was reached (95002)',
      retryable: false,
    };
  }
  if (isWecomAuthenticationError(errcode)) {
    return {
      ok: false,
      code: 'channel_not_configured',
      message: `WeCom rejected the customer-service credential (errcode ${errcode})`,
      retryable: false,
    };
  }
  return {
    ok: false,
    code: 'channel_invalid_request',
    message: `the WeCom send endpoint rejected the message (errcode ${errcode})`,
    retryable: false,
  };
}

/** Stable failure for a malformed outbound request. */
function wecomInvalid<T>(message: string): ChannelResult<T> {
  return {
    ok: false,
    code: 'channel_invalid_request',
    message,
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// Media upload
// ---------------------------------------------------------------------------

/**
 * The media seam every media delivery goes through.
 *
 * An `image`, `video` or `file` send carries only a provider `media_id`, so a
 * media delivery is two provider calls: upload the bytes, then send the id.
 * Publishing the upload as its own port is what lets the adapter that owns the
 * customer-service account also own the upload, without any caller having to
 * know the endpoint, the multipart field or how a rejected upload is classified.
 */
export interface WecomMediaUploadTransport {
  /**
   * Upload one payload to the provider and return its temporary `media_id`.
   *
   * @param input - Kind, MIME type and bytes; a file's own name, if it has one.
   * @returns The provider media id, or a stable channel failure.
   */
  uploadMedia(input: {
    readonly kind: WecomMediaKind;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
    readonly fileName?: string;
  }): Promise<ChannelResult<UploadMediaResult>>;
}

/** Everything the media uploader needs that is not a port. */
export type WecomMediaUploaderOptions = {
  /** Deadline applied to each provider request. */
  readonly timeoutMs: number;
  /**
   * Reads the account this upload should be made as, as for a send.
   *
   * An upload spends the same account's token and media quota as the send that
   * follows it, so it is read the same way and at the same moment.
   */
  readonly credentials: WecomCredentialReader;
};

/** Result of one `media/upload` attempt, keeping the `errcode` for the retry decision. */
type UploadAttempt = {
  readonly errcode: number | null;
  readonly result: ChannelResult<UploadMediaResult>;
};

/**
 * Uploads one payload through `media/upload`.
 *
 * The kind chooses the `type` the provider is asked for, which is also what
 * decides the ceiling and the container: the same bytes are a legal image and an
 * illegal video. The access token comes from the same {@link WecomTokenProvider}
 * the send path uses, so the cache, the expiry margin and the refresh policy
 * stay in one place. An authentication failure costs exactly one refresh and one
 * replay, for the same reason a send does: a credential the provider has just
 * rejected twice will not become valid on a third try, so anything else would be
 * a loop.
 *
 * Nothing about the payload or the answer leaves this class except a `media_id`
 * or a stable failure: the token is never carried into a message, the bytes are
 * never echoed, and the provider's `errmsg` is never read at all.
 */
export class WecomMediaUploader implements WecomMediaUploadTransport {
  /**
   * @param http - Outbound HTTP port.
   * @param tokens - Access-token provider, which owns the cache and refresh.
   * @param options - Credential reader and deadline.
   */
  constructor(
    private readonly http: WecomHttpClient,
    private readonly tokens: WecomTokenProvider,
    private readonly options: WecomMediaUploaderOptions,
  ) {}

  /** @inheritdoc */
  async uploadMedia(input: {
    readonly kind: WecomMediaKind;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
    readonly fileName?: string;
  }): Promise<ChannelResult<UploadMediaResult>> {
    const account = await useWecomCredentials(this.options.credentials);
    if (account._tag === 'refused') {
      return account.refusal;
    }
    const reject = mediaUploadRejection(input);
    if (reject !== null) {
      return reject;
    }

    const first = await this.#uploadOnce(input);
    if (first.result.ok || !isWecomAuthenticationError(first.errcode)) {
      return first.result;
    }
    // The token was rejected. Drop it so the replay asks WeCom for a new one,
    // and replay exactly once — a second authentication failure is final.
    await this.tokens.invalidate();
    const second = await this.#uploadOnce(input);
    return second.result;
  }

  /** Perform one `media/upload` call, reporting the provider's `errcode` too. */
  async #uploadOnce(input: {
    readonly kind: WecomMediaKind;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
    readonly fileName?: string;
  }): Promise<UploadAttempt> {
    const token = await this.tokens.get();
    if (!token.ok) {
      return { errcode: null, result: token };
    }
    let status: number;
    let body: unknown;
    try {
      const response = await this.http.send({
        method: 'POST',
        url: `${UPLOAD_URL}?access_token=${encodeURIComponent(token.value)}&type=${UPLOAD_TYPE_OF[input.kind]}`,
        multipart: {
          field: UPLOAD_MEDIA_FIELD,
          filename: mediaFilename(input.kind, input.mimeType, input.fileName),
          contentType: input.mimeType,
          bytes: input.bytes,
        },
        timeoutMs: this.options.timeoutMs,
      });
      status = response.status;
      body = response.body;
    } catch {
      return {
        errcode: null,
        result: {
          ok: false,
          code: 'channel_provider_error',
          message: 'the WeCom media upload endpoint could not be reached',
          retryable: true,
        },
      };
    }

    const record = asRecord(body);
    const errcode = numberOf(record?.['errcode']);
    const mediaId = textOf(record?.['media_id']);
    if (errcode === 0 && mediaId !== null) {
      return { errcode, result: { ok: true, value: { mediaId } } };
    }
    if (errcode === 0) {
      // The provider accepted the upload but named no media, so there is
      // nothing an image send could point at. Unlike a lost `msgid`, nothing
      // was delivered to a customer: the upload simply has to be repeated.
      return {
        errcode,
        result: {
          ok: false,
          code: 'channel_provider_error',
          message:
            'the WeCom media upload endpoint accepted the image without returning a media id',
          retryable: true,
        },
      };
    }
    if (errcode === null) {
      // The endpoint answered with something that is not a WeCom error
      // document, so the HTTP status is the only evidence available.
      return {
        errcode: null,
        result: {
          ok: false,
          code: 'channel_provider_error',
          message: `the WeCom media upload endpoint answered with HTTP ${status}`,
          retryable: status >= 500,
        },
      };
    }
    return { errcode, result: mapWecomUploadFailure(errcode) };
  }
}

/**
 * Refuse a payload this transport will not upload, or `null` when it is one.
 *
 * Checked here rather than at the adapter so that every caller of the port —
 * the API today, anything else tomorrow — is held to the same bound. The
 * refusals are all `channel_invalid_request`: they describe a request the
 * platform built wrongly, not a provider that misbehaved, and no provider call
 * is made to discover them.
 *
 * @param input - Kind, MIME type and bytes.
 * @returns The stable refusal, or `null` when the payload may be uploaded.
 */
function mediaUploadRejection(input: {
  readonly kind: WecomMediaKind;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): ChannelResult<never> | null {
  const maxBytes = UPLOAD_MAX_BYTES_OF[input.kind];
  // The `type` in the query string is what the provider measures the bytes
  // against, so a payload of the wrong family is one the call cannot succeed
  // with — and finding that out from the provider costs an access token and a
  // customer-service quota unit first. A file is the exception: `type=file`
  // takes whatever the sender picked, which is the whole reason it exists.
  const family =
    input.kind === 'video' ? 'video/mp4' : input.kind === 'image' ? 'image/' : null;
  if (family !== null && !input.mimeType.toLowerCase().startsWith(family)) {
    return wecomInvalid(
      `a WeCom ${input.kind} upload carries ${family} bytes, not '${input.mimeType}'`,
    );
  }
  if (input.bytes.byteLength === 0) {
    return wecomInvalid(`a WeCom ${input.kind} upload requires a non-empty payload`);
  }
  if (input.bytes.byteLength > maxBytes) {
    return wecomInvalid(
      `the ${input.kind} payload exceeds the ${maxBytes}-byte limit of a WeCom temporary ${input.kind}`,
    );
  }
  return null;
}

/**
 * The file name presented in the multipart part header.
 *
 * An image or a video is measured by its bytes and the part header only has to
 * carry a plausible name, so that name is derived from the MIME type and never
 * from anything the sender typed. A file is the exception: the name in this
 * header is the name the customer sees on the file that arrives, so there the
 * sender's own file name is used, reduced to something a header can carry.
 *
 * @param kind - Which of the three uploads this name is for.
 * @param mimeType - MIME type already validated by {@link mediaUploadRejection}.
 * @param fileName - The sender's own file name, for a `file` upload.
 * @returns A file name with the subtype as its extension.
 */
function mediaFilename(kind: WecomMediaKind, mimeType: string, fileName?: string): string {
  if (kind === 'file') {
    return mediaBaseName(fileName);
  }
  const subtype = mimeType
    .slice(mimeType.indexOf('/') + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return `wecom-${kind}${subtype.length === 0 ? '' : `.${subtype}`}`;
}

/**
 * Reduce whatever the sender called a file to a name a part header can carry.
 *
 * Only the base name survives: a path separator would put the sender's own
 * directory layout into a header, and control characters, quotes and a leading
 * dot go with it, because the name is data the platform displays rather than a
 * place to smuggle syntax. An empty result falls back to a name that at least
 * says what the payload is.
 *
 * @param fileName - Name as the sender's file had it, if the caller had one.
 * @returns A non-empty base name of bounded length.
 */
function mediaBaseName(fileName: string | undefined): string {
  const segments = (fileName ?? '').split(/[\\/]/);
  const last = segments[segments.length - 1] ?? '';
  // Control characters are dropped by code point rather than by a character
  // class: a name is displayed text, and a literal one would put a raw newline
  // or NUL into a header the provider parses.
  const printed = [...last].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f && character !== '"';
  });
  const base = printed.join('').replace(/^\.+/, '').trim();
  return base.length === 0 ? 'wecom-file' : base.slice(0, 120);
}

/**
 * Map a rejected `media/upload` answer onto a stable channel failure.
 *
 * The provider's `errmsg` is deliberately not carried: it is unbounded text
 * under the provider's control, and the only things this failure may ever reach
 * are platform-authored diagnostics.
 *
 * @param errcode - The provider's `errcode`.
 * @returns The stable channel failure.
 */
export function mapWecomUploadFailure(errcode: number): ChannelResult<UploadMediaResult> {
  if (isWecomAuthenticationError(errcode)) {
    return {
      ok: false,
      code: 'channel_not_configured',
      message: `WeCom rejected the customer-service credential (errcode ${errcode})`,
      retryable: false,
    };
  }
  return {
    ok: false,
    code: 'channel_invalid_request',
    message: `the WeCom media upload endpoint rejected the image (errcode ${errcode})`,
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// The deterministic Mock transport
// ---------------------------------------------------------------------------

/** Shared secret accepted by the local Mock WeCom webhook. */
export const MOCK_WECOM_SIGNATURE = 'mock-signature';

/** Header carrying {@link MOCK_WECOM_SIGNATURE} on a Mock callback request. */
export const MOCK_WECOM_SIGNATURE_HEADER = 'x-mock-signature';

/** Text trigger that makes the Mock provider report a definite rejection. */
export const MOCK_WECOM_FAIL_TRIGGER = '[mock:fail]';

/** Text trigger that makes the Mock provider lose its response. */
export const MOCK_WECOM_UNKNOWN_TRIGGER = '[mock:unknown]';

/** Capabilities implemented by the deterministic Mock WeCom transport. */
export const MOCK_WECOM_CAPABILITIES: ChannelCapabilities = Object.freeze({
  receiveText: true,
  receiveImage: true,
  sendText: true,
  sendImage: true,
  sendLink: true,
});

/**
 * Deterministic provider adapter used until real WeCom credentials exist.
 *
 * The Mock transport is *not* a WeCom connection: it performs no network call,
 * holds no credential, and speaks a local JSON shape that only contains
 * provider-facing identifiers. It exists so the whole message loop — callback
 * ingestion, quota/window gating, delivery attempts, retries and status
 * notifications — is exercisable end to end, deterministically, before a real
 * adapter replaces it behind the same {@link ChannelAdapter} contract.
 *
 * It is shared for one concrete reason: the Worker processes outbox entries that
 * an API running in Mock mode queued, so a per-process copy of the Mock would let
 * the two disagree about what `[mock:fail]` means and turn a deterministic
 * delivery test into a coin toss.
 *
 * Tenant and store authorization is never decided here: the callback payload
 * names a tenant and store, and the API's delivery service refuses any callback
 * whose scope the caller has not been authorized for.
 *
 * @remarks
 * {@link verifyWebhook} checks a shared secret header rather than a
 * cryptographic digest over the raw request body. That is honest for a local
 * Mock transport but would not be sufficient for a real provider: a real
 * adapter must verify a digest over the exact raw body bytes, which is why the
 * contract still carries `rawBody`.
 */
export class MockWecomAdapter implements ChannelAdapter {
  readonly channel = CHANNEL_PROVIDER_WECOM;
  readonly capabilities = MOCK_WECOM_CAPABILITIES;

  /**
   * Verify the documented Mock callback signature header.
   *
   * @param input - Callback headers and body as received.
   * @returns The verified result, or the stable `channel_invalid_request` failure.
   */
  async verifyWebhook(
    input: WebhookVerificationInput,
  ): Promise<ChannelResult<WebhookVerificationResult>> {
    if (input.signature !== MOCK_WECOM_SIGNATURE) {
      return wecomInvalid(`missing or invalid ${MOCK_WECOM_SIGNATURE_HEADER} header`);
    }
    return { ok: true, value: { verified: true } };
  }

  /**
   * Parse the documented Mock WeCom JSON callback into a unified message.
   *
   * A non-text callback without a readable caption is stored with a stable
   * placeholder, so the transcript never shows an empty customer message.
   *
   * @param input - Raw callback body.
   * @returns The unified inbound message, or a stable failure.
   */
  async parseInboundMessage(input: {
    readonly rawBody: string;
  }): Promise<ChannelResult<UnifiedMessage>> {
    const parsed = parseObject(input.rawBody);
    if (!parsed.ok) return parsed;

    const eventId = requiredString(parsed.value, 'eventId');
    const tenantId = requiredString(parsed.value, 'tenantId');
    const storeId = requiredString(parsed.value, 'storeId');
    const customerId = requiredString(parsed.value, 'externalCustomerId');
    const conversationId = requiredString(parsed.value, 'externalConversationId');
    const messageId = requiredString(parsed.value, 'externalMessageId');
    const messageType = parseMessageType(parsed.value['messageType']);
    if (
      eventId === null ||
      tenantId === null ||
      storeId === null ||
      customerId === null ||
      conversationId === null ||
      messageId === null ||
      messageType === null
    ) {
      return wecomInvalid('mock webhook is missing a required field or has an invalid messageType');
    }

    const rawContent = optionalString(parsed.value, 'content');
    const content = rawContent === null ? channelMessagePlaceholder(messageType) : rawContent;
    const occurredAt = optionalString(parsed.value, 'occurredAt') ?? new Date().toISOString();
    return {
      ok: true,
      value: createUnifiedMessage({
        channel: CHANNEL_PROVIDER_WECOM,
        externalEventId: eventId,
        tenantId,
        storeId,
        externalCustomerId: customerId,
        externalConversationId: conversationId,
        externalMessageId: messageId,
        direction: 'inbound',
        messageType,
        content,
        dedupKey: `wecom:${eventId}`,
        receivedAt: occurredAt,
      }),
    };
  }

  /** Return no remote backlog; in the Mock transport callbacks drive ingestion. */
  async syncMessages(): Promise<
    ChannelResult<{ readonly messages: ReadonlyArray<UnifiedMessage> }>
  > {
    return { ok: true, value: { messages: [] } };
  }

  /**
   * Deliver deterministically, with explicit text triggers for failure paths.
   *
   * `[mock:fail]` produces a definite rejection the platform may retry, and
   * `[mock:unknown]` produces the lost-response outcome the platform must treat
   * as possibly-delivered. Nothing leaves the process.
   *
   * @param input - Provider-neutral outbound message.
   * @returns The Mock external message id, or a stable failure.
   */
  async sendMessage(input: SendMessageInput): Promise<ChannelResult<SendMessageResult>> {
    if (input.content.includes(MOCK_WECOM_FAIL_TRIGGER)) {
      return {
        ok: false,
        code: 'channel_provider_error',
        message: 'mock provider rejected the message',
        retryable: true,
      };
    }
    if (input.content.includes(MOCK_WECOM_UNKNOWN_TRIGGER)) {
      return {
        ok: false,
        code: 'channel_delivery_unknown',
        message: 'mock provider response was lost',
        retryable: true,
        deliveryUnknown: true,
      };
    }
    if (input.messageType === 'image' && input.media === null) {
      return wecomInvalid('image delivery requires media');
    }
    return {
      ok: true,
      value: { externalMessageId: `mock-${input.correlationId}` },
    };
  }

  /** Return deterministic image bytes for contract testing. */
  async fetchMedia(input: {
    readonly mediaId: string;
  }): Promise<ChannelResult<{ readonly mimeType: string; readonly bytes: Uint8Array }>> {
    return {
      ok: true,
      value: { mimeType: 'image/png', bytes: new TextEncoder().encode(input.mediaId) },
    };
  }

  /** Return a deterministic media id without performing network I/O. */
  async uploadMedia(input: {
    readonly bytes: Uint8Array;
  }): Promise<ChannelResult<{ readonly mediaId: string }>> {
    return { ok: true, value: { mediaId: `mock-media-${input.bytes.byteLength}` } };
  }
}

type ParsedObject = ChannelResult<Readonly<Record<string, unknown>>>;

function parseObject(rawBody: string): ParsedObject {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return wecomInvalid('mock webhook body must be valid JSON');
  }
  const record = asRecord(value);
  if (record === null) {
    return wecomInvalid('mock webhook body must be a JSON object');
  }
  return { ok: true, value: record };
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  return textOf(record[key]);
}

function optionalString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  return textOf(record[key]);
}

function parseMessageType(value: unknown): UnifiedMessage['messageType'] | null {
  if (value === undefined || value === 'text') return 'text';
  if (value === 'image' || value === 'link') return value;
  return null;
}
