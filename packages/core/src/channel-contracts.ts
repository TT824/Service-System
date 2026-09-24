/**
 * Provider-neutral channel adapter contracts.
 *
 * Every external messaging channel (enterprise WeChat in the MVP) is reached
 * through a {@link ChannelAdapter}. The adapter is deliberately provider
 * neutral: it exchanges {@link UnifiedMessage} values and adapter results, so
 * business code never depends on a channel's wire format.
 *
 * The first transport slice binds a deterministic Mock WeCom adapter. A real
 * WeCom adapter can replace it without changing application services.
 */

import type { MessageDirection, MessageType } from './platform/types';

/** Provider identifiers known to the platform. */
export type ChannelProviderId = 'wecom' | 'none';

/** Provider id used when no real transport is configured. */
export const CHANNEL_PROVIDER_NONE: ChannelProviderId = 'none';

/** Provider id reserved for the enterprise WeChat transport. */
export const CHANNEL_PROVIDER_WECOM: ChannelProviderId = 'wecom';

/** Stable failure code returned by a disabled or misconfigured adapter. */
export type ChannelFailureCode =
  | 'channel_disabled'
  | 'channel_not_configured'
  | 'channel_invalid_request'
  | 'channel_provider_error'
  | 'channel_delivery_unknown';

/**
 * Runtime mirror of {@link ChannelFailureCode}.
 *
 * A durable adapter reads a failure code back out of a text column, and the
 * column is plain `TEXT`, so the value has to be validated against the known set
 * before it re-enters the typed domain. Keeping the list next to the union is
 * what makes the two impossible to disagree silently.
 */
export const CHANNEL_FAILURE_CODES: ReadonlyArray<ChannelFailureCode> = [
  'channel_disabled',
  'channel_not_configured',
  'channel_invalid_request',
  'channel_provider_error',
  'channel_delivery_unknown',
];

/** Stable failure code returned by every operation on a disabled channel. */
export const CHANNEL_DISABLED: ChannelFailureCode = 'channel_disabled';

/** Adapter capabilities. A disabled adapter reports every capability as false. */
export type ChannelCapabilities = {
  readonly receiveText: boolean;
  readonly receiveImage: boolean;
  readonly sendText: boolean;
  readonly sendImage: boolean;
  readonly sendLink: boolean;
};

/** A successful adapter operation. */
export type ChannelOk<T> = {
  readonly ok: true;
  readonly value: T;
};

/** A failed adapter operation carrying a stable failure code. */
export type ChannelFailure = {
  readonly ok: false;
  readonly code: ChannelFailureCode;
  readonly message?: string;
  /** Whether the application may safely offer another delivery attempt. */
  readonly retryable?: boolean;
  /** Whether the provider may have accepted the message despite the failure. */
  readonly deliveryUnknown?: boolean;
};

/** Result returned by every adapter operation. */
export type ChannelResult<T> = ChannelOk<T> | ChannelFailure;

/** A media file referenced by a unified message. */
export type UnifiedMedia = {
  readonly mediaId: string;
  readonly mimeType: string;
  readonly url?: string;
};

/**
 * Provider-neutral message exchanged with an external channel.
 *
 * Inbound and outbound messages share one shape. Business identifiers are
 * always platform identifiers; the `external*` fields carry the identifiers
 * the remote channel uses so mapping stays inside the adapter.
 */
export type UnifiedMessage = {
  readonly id: string;
  readonly channel: ChannelProviderId;
  readonly externalEventId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly externalCustomerId: string;
  readonly externalConversationId: string;
  readonly externalMessageId: string | null;
  readonly direction: MessageDirection;
  readonly messageType: MessageType;
  readonly content: string;
  readonly dedupKey: string | null;
  readonly media: UnifiedMedia | null;
  readonly receivedAt: string;
};

/** Input used to create a provider-neutral inbound message. */
export type UnifiedMessageInput = {
  readonly channel: ChannelProviderId;
  readonly externalEventId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly externalCustomerId: string;
  readonly externalConversationId: string;
  readonly externalMessageId?: string | null;
  readonly direction: MessageDirection;
  readonly messageType: MessageType;
  readonly content: string;
  readonly dedupKey?: string | null;
  readonly media?: UnifiedMedia | null;
  readonly receivedAt?: string;
};

/** Input passed to {@link ChannelAdapter.verifyWebhook}. */
export type WebhookVerificationInput = {
  readonly channel: ChannelProviderId;
  readonly signature: string | null;
  readonly timestamp: string | null;
  readonly nonce: string | null;
  readonly rawBody: string;
};

/** Result of a successful webhook verification. */
export type WebhookVerificationResult = {
  readonly verified: boolean;
  readonly requestId?: string;
};

/** Input passed to {@link ChannelAdapter.sendMessage}. */
export type SendMessageInput = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly externalCustomerId: string;
  readonly externalConversationId: string;
  readonly messageType: MessageType;
  readonly content: string;
  readonly media?: UnifiedMedia | null;
  readonly correlationId: string;
};

/** Result of a successful outbound send. */
export type SendMessageResult = {
  readonly externalMessageId: string;
};

/**
 * Placeholders for the message types a *provider* names and this platform does
 * not map onto {@link MessageType}.
 *
 * WeCom's customer-service callbacks carry a voice, a video, a file and a
 * handful of other payloads the platform deliberately keeps out of its message
 * type: the transcript shows one unified placeholder per non-text kind, so the
 * three-value enum, the column's CHECK constraint and every migration stay as
 * they are. Such a message is therefore stored as *text* whose content is one of
 * these strings, and the only way anything downstream can still tell it apart
 * from something the customer typed is to recognise the string — which is what
 * {@link isChannelMessagePlaceholder} exists for.
 *
 * The provider's own token never reaches an operator: a type this table has no
 * name for becomes {@link UNKNOWN_MESSAGE_PLACEHOLDER}, not `[msgmenu]`.
 */
const PROVIDER_MESSAGE_PLACEHOLDERS: Readonly<Record<string, string>> = Object.freeze({
  voice: '[语音消息]',
  video: '[视频消息]',
  file: '[文件消息]',
  location: '[位置消息]',
  business_card: '[名片消息]',
  miniprogram: '[小程序消息]',
  msgmenu: '[菜单消息]',
  channels: '[视频号消息]',
  merged_msg: '[合并消息]',
});

/** Shown for a provider message type this module has no name for. */
const UNKNOWN_MESSAGE_PLACEHOLDER = '[非文本消息]';

/**
 * Stable placeholder shown when a non-text payload has no readable caption.
 *
 * @param messageType - A unified message type, or the raw type a provider named
 * for a payload outside that enum. Unknown provider types are named rather than
 * echoed, so nothing an operator reads is a provider's field value.
 * @returns The placeholder for that type.
 */
export function channelMessagePlaceholder(messageType: MessageType | string): string {
  switch (messageType) {
    case 'text':
      return '[空文本消息]';
    case 'image':
      return '[图片消息]';
    case 'link':
      return '[链接消息]';
    default:
      return PROVIDER_MESSAGE_PLACEHOLDERS[messageType] ?? UNKNOWN_MESSAGE_PLACEHOLDER;
  }
}

/** Every string {@link channelMessagePlaceholder} can return. */
const CHANNEL_MESSAGE_PLACEHOLDERS: ReadonlySet<string> = new Set([
  channelMessagePlaceholder('text'),
  channelMessagePlaceholder('image'),
  channelMessagePlaceholder('link'),
  ...Object.values(PROVIDER_MESSAGE_PLACEHOLDERS),
  UNKNOWN_MESSAGE_PLACEHOLDER,
]);

/**
 * Whether a message's content is one of the platform's own placeholders.
 *
 * Two callers need this and neither may get it wrong: the workspace, which must
 * not render `[语音消息]` as though the customer had typed it, and the candidate
 * gate, which must not spend a model call answering a placeholder. Both read the
 * *stored content*, because that is the only trace a normalised non-text message
 * leaves behind — see {@link PROVIDER_MESSAGE_PLACEHOLDERS}.
 *
 * @param content - A message's content, as stored.
 * @returns `true` when the content is a placeholder rather than customer text.
 */
export function isChannelMessagePlaceholder(content: string): boolean {
  return CHANNEL_MESSAGE_PLACEHOLDERS.has(content.trim());
}

/** Result of a successful media fetch. */
export type FetchMediaResult = {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
};

/** Result of a successful media upload. */
export type UploadMediaResult = {
  readonly mediaId: string;
};

/** Result of a successful message sync. */
export type SyncMessagesResult = {
  readonly messages: ReadonlyArray<UnifiedMessage>;
};

/**
 * Provider-neutral channel adapter.
 *
 * Implementations must never throw for a disabled state; a disabled adapter
 * returns the stable {@link CHANNEL_DISABLED} failure for every operation.
 */
export type ChannelAdapter = {
  readonly channel: ChannelProviderId;
  readonly capabilities: ChannelCapabilities;
  verifyWebhook(input: WebhookVerificationInput): Promise<ChannelResult<WebhookVerificationResult>>;
  parseInboundMessage(input: { readonly rawBody: string }): Promise<ChannelResult<UnifiedMessage>>;
  syncMessages(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly externalConversationId: string;
  }): Promise<ChannelResult<SyncMessagesResult>>;
  sendMessage(input: SendMessageInput): Promise<ChannelResult<SendMessageResult>>;
  fetchMedia(input: { readonly mediaId: string }): Promise<ChannelResult<FetchMediaResult>>;
  uploadMedia(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<ChannelResult<UploadMediaResult>>;
};

/**
 * Create a provider-neutral unified message with defaults filled in.
 *
 * @param input - Message fields supplied by an adapter or a caller.
 * @returns A fully populated {@link UnifiedMessage}.
 */
export function createUnifiedMessage(input: UnifiedMessageInput): UnifiedMessage {
  const now = input.receivedAt ?? new Date().toISOString();
  const id = input.externalMessageId ?? `${input.channel}-${now}-${input.dedupKey ?? 'msg'}`;
  return Object.freeze({
    id,
    channel: input.channel,
    externalEventId: input.externalEventId,
    tenantId: input.tenantId,
    storeId: input.storeId,
    externalCustomerId: input.externalCustomerId,
    externalConversationId: input.externalConversationId,
    externalMessageId: input.externalMessageId ?? null,
    direction: input.direction,
    messageType: input.messageType,
    content: input.content,
    dedupKey: input.dedupKey ?? null,
    media: input.media ?? null,
    receivedAt: now,
  });
}
