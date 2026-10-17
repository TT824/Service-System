/**
 * `@kefu/wecom` — the app-neutral WeCom outbound transport.
 *
 * One package, one implementation, two processes:
 *
 * - the **API** binds {@link WecomOutboundSender} behind a real adapter that
 *   also owns callback cryptography and payload mapping, and binds
 *   {@link MockWecomAdapter} when the environment asks for a Mock transport;
 * - the **Worker** binds the same sender — or the same Mock — to deliver the
 *   channel outbox entries the API queued.
 *
 * The package is the *reason* a retry in the Worker means what a first attempt in
 * the API meant: both go through {@link WecomOutboundSender}, so a request body,
 * a single retry-after-auth-failure, a lost-`msgid` reading and every stable
 * failure code are produced by one piece of code rather than two that must be
 * kept in step.
 *
 * What is deliberately *not* here: anything that names an application. The
 * package imports `@kefu/core` for the provider-neutral contracts and the shared
 * failure codes, and nothing else from the repository — no configuration loader,
 * no database, no NestJS module, no logger. A caller supplies the ports
 * ({@link WecomHttpClient}, {@link WecomTokenCache}) and the plain values
 * (credentials, account id) it already owns, and wires its own state through
 * {@link WecomTokenProviderOptions.onConnectionProven}.
 */

export {
  FetchWecomHttpClient,
  WECOM_HTTP_CLIENT,
  type WecomDownloadRequest,
  type WecomDownloadResponse,
  type WecomHttpClient,
  type WecomHttpRequest,
  type WecomHttpResponse,
  type WecomMultipartFile,
} from './http-client';

export {
  WECOM_MAX_REQUESTS_PER_DOWNLOAD,
  WECOM_MEDIA_DOWNLOAD_MAX_BYTES,
  WecomMediaDownloader,
  mapWecomDownloadFailure,
  type WecomMediaDownloadTransport,
  type WecomMediaDownloaderOptions,
} from './media';

export { asRecord, numberOf, textOf } from './readers';

export {
  MemoryWecomTokenCache,
  RedisWecomTokenCache,
  WECOM_TOKEN_CACHE,
  WecomTokenProvider,
  isWecomAuthenticationError,
  type WecomTokenCache,
  type WecomTokenProviderOptions,
} from './token-provider';

export {
  MOCK_WECOM_CAPABILITIES,
  MOCK_WECOM_FAIL_TRIGGER,
  MOCK_WECOM_SIGNATURE,
  MOCK_WECOM_SIGNATURE_HEADER,
  MOCK_WECOM_UNKNOWN_TRIGGER,
  MockWecomAdapter,
  WECOM_AUTH_REPLAY_ATTEMPTS,
  WECOM_FILE_MAX_BYTES,
  WECOM_MAX_REQUESTS_PER_SEND,
  WECOM_MAX_REQUESTS_PER_UPLOAD,
  WECOM_MEDIA_MAX_BYTES,
  WECOM_OUTBOUND_CAPABILITIES,
  WECOM_VIDEO_MAX_BYTES,
  WecomMediaUploader,
  WecomOutboundSender,
  mapWecomSendFailure,
  mapWecomUploadFailure,
  openKfIdOfConversation,
  wecomOutboundPayload,
  type WecomMediaKind,
  type WecomMediaUploaderOptions,
  type WecomMediaUploadTransport,
  type WecomOutboundSenderOptions,
  type WecomOutboundTransport,
} from './outbound';

export {
  useWecomCredentials,
  wecomConfigurationBlocker,
  type WecomCredentialReader,
  type WecomCredentialUse,
} from './credentials';
