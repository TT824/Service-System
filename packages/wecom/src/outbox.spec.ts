import { describe, expect, it } from 'vitest';
import { WECOM_AES_KEY_LENGTH, type SendMessageInput, type WecomCredentialValues } from '@kefu/core';
import type {
  WecomDownloadRequest,
  WecomDownloadResponse,
  WecomHttpClient,
  WecomHttpRequest,
  WecomHttpResponse,
} from './http-client';
import type { WecomCredentialReader } from './credentials';
import { MemoryWecomTokenCache, WecomTokenProvider } from './token-provider';
import {
  MOCK_WECOM_FAIL_TRIGGER,
  MOCK_WECOM_UNKNOWN_TRIGGER,
  MockWecomAdapter,
  WECOM_AUTH_REPLAY_ATTEMPTS,
  WECOM_MAX_REQUESTS_PER_SEND,
  WECOM_MAX_REQUESTS_PER_UPLOAD,
  WECOM_MEDIA_MAX_BYTES,
  WECOM_OUTBOUND_CAPABILITIES,
  WecomMediaUploader,
  WecomOutboundSender,
  mapWecomSendFailure,
  mapWecomUploadFailure,
  openKfIdOfConversation,
  wecomOutboundPayload,
} from './outbound';

/**
 * Tests for the one outbound WeCom implementation both processes share.
 *
 * The point of `@kefu/wecom` is that the API and the Worker cannot disagree
 * about a send, so what is pinned here is the *contract* rather than either
 * caller: the exact `kf/send_msg` request, the single replay after an
 * authentication failure, and the stable failure code every provider answer maps
 * onto. A change that made a Worker retry mean something different from an API
 * retry would fail these tests rather than only showing up as a duplicate
 * message in production.
 *
 * Everything runs against a fake HTTP port, so no test here reaches the network.
 * The fake answers `gettoken`, `kf/send_msg` and the temporary-media upload
 * separately, because they are separate protocol steps: a test that scripts a
 * send must not accidentally script the token fetch as well.
 *
 * The media upload is pinned here for the same contract reason as the send: an
 * image delivery is only complete if the bytes reach WeCom as the multipart part
 * the provider reads them from, and if the failure of that call means the same
 * thing to every caller.
 */

const NOW = Date.parse('2026-05-01T10:00:00.000Z');

/** A scripted {@link WecomHttpClient} that records every request it is given. */
class FakeWecomHttp implements WecomHttpClient {
  readonly requests: WecomHttpRequest[] = [];
  /** Every download this fake was asked for; see {@link FakeWecomHttp.download}. */
  readonly downloads: WecomDownloadRequest[] = [];
  #sendHandler: (request: WecomHttpRequest) => WecomHttpResponse = () => sendOk();
  #tokenHandler: (request: WecomHttpRequest) => WecomHttpResponse = () => tokenOk();
  #uploadHandler: (request: WecomHttpRequest) => WecomHttpResponse = () => uploadOk();

  /** Replace the `kf/send_msg` answer. */
  scriptSend(handler: (request: WecomHttpRequest) => WecomHttpResponse): void {
    this.#sendHandler = handler;
  }

  /** Replace the `gettoken` answer. */
  scriptToken(handler: (request: WecomHttpRequest) => WecomHttpResponse): void {
    this.#tokenHandler = handler;
  }

  /** Replace the `media/upload` answer. */
  scriptUpload(handler: (request: WecomHttpRequest) => WecomHttpResponse): void {
    this.#uploadHandler = handler;
  }

  /** Every request that was not a `gettoken` or a `media/upload` call. */
  get sendRequests(): ReadonlyArray<WecomHttpRequest> {
    return this.requests.filter(
      (request) => !request.url.includes('/gettoken') && !request.url.includes('/media/upload'),
    );
  }

  /** Every `gettoken` request. */
  get tokenRequests(): ReadonlyArray<WecomHttpRequest> {
    return this.requests.filter((request) => request.url.includes('/gettoken'));
  }

  /** Every `media/upload` request. */
  get uploadRequests(): ReadonlyArray<WecomHttpRequest> {
    return this.requests.filter((request) => request.url.includes('/media/upload'));
  }

  async send(request: WecomHttpRequest): Promise<WecomHttpResponse> {
    this.requests.push(request);
    if (request.url.includes('/gettoken')) {
      return this.#tokenHandler(request);
    }
    if (request.url.includes('/media/upload')) {
      return this.#uploadHandler(request);
    }
    return this.#sendHandler(request);
  }

  /**
   * Refuse every download, recording it.
   *
   * Nothing in this suite fetches media back — the inbound half is scripted in
   * `media.spec.ts` — so the only honest answer here is the provider saying no.
   * A fake that invented bytes would let an outbound test reach a download
   * without ever scripting one.
   */
  download(request: WecomDownloadRequest): Promise<WecomDownloadResponse> {
    this.downloads.push(request);
    return Promise.resolve({ kind: 'json', status: 200, body: { errcode: 40007 } });
  }
}

/** A `gettoken` answer carrying a long-lived token. */
function tokenOk(token = 'token-1'): WecomHttpResponse {
  return { status: 200, body: { errcode: 0, access_token: token, expires_in: 7200 } };
}

/** A `kf/send_msg` answer WeCom accepted. */
function sendOk(msgid = 'wecom-msg-1'): WecomHttpResponse {
  return { status: 200, body: { errcode: 0, msgid } };
}

/** A `kf/send_msg` answer carrying only a provider error code. */
function sendErrcode(errcode: number): WecomHttpResponse {
  return { status: 200, body: { errcode, errmsg: 'provider text that must not be surfaced' } };
}

/** A `media/upload` answer WeCom accepted. */
function uploadOk(mediaId = 'media-1'): WecomHttpResponse {
  return { status: 200, body: { errcode: 0, errmsg: 'ok', type: 'image', media_id: mediaId } };
}

/** A `media/upload` answer carrying only a provider error code. */
function uploadErrcode(errcode: number): WecomHttpResponse {
  return { status: 200, body: { errcode, errmsg: 'provider text that must not be surfaced' } };
}

/** A provider-neutral outbound message as a caller supplies it. */
function sendInput(overrides: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    tenantId: 'tenant-1',
    storeId: 'store-1',
    externalCustomerId: 'customer-1',
    externalConversationId: 'wkCONV01:customer-1',
    messageType: 'text',
    content: '您好，我帮您查一下',
    media: null,
    correlationId: 'delivery-1',
    ...overrides,
  };
}

/** The five values every transport in this file authenticates with. */
const CREDENTIALS: WecomCredentialValues = {
  corpId: 'ww-corp',
  kfSecret: 'kf-secret',
  callbackToken: 'callback-token',
  aesKey: 'k'.repeat(WECOM_AES_KEY_LENGTH),
  openKfId: 'wkCONFIGURED',
};

/** A reader answering with one fixed, usable set. */
function readerOf(values: Partial<WecomCredentialValues> = {}): WecomCredentialReader {
  return async () => ({ _tag: 'ready', origin: 'console', values: { ...CREDENTIALS, ...values } });
}

/** A reader answering the way a deployment with a field missing does. */
function unconfiguredReader(variable: string): WecomCredentialReader {
  // `environment`, because a transport that could not be configured is the
  // state a deployment that never stored anything is in; the console's half has
  // its own tests where the rule lives.
  return async () => ({
    _tag: 'unconfigured',
    origin: 'environment',
    problems: [{ variable, code: 'missing' }],
  });
}

/**
 * Build a sender over a fake HTTP port, with a memory token cache and a fixed
 * clock, exactly as each application's composition root builds it.
 */
function buildSender(
  http: WecomHttpClient,
  options: {
    readonly openKfId?: string;
    readonly credentials?: WecomCredentialReader;
  } = {},
): WecomOutboundSender {
  const tokens = new WecomTokenProvider(http, new MemoryWecomTokenCache(), {
    credentials: readerOf(),
    timeoutMs: 1_000,
    now: () => NOW,
  });
  return new WecomOutboundSender(http, tokens, {
    credentials: options.credentials ?? readerOf({ openKfId: options.openKfId ?? 'wkCONFIGURED' }),
    timeoutMs: 1_000,
  });
}

/** Build a media uploader over a fake port, with its own memory token cache. */
function buildUploader(
  http: WecomHttpClient,
  options: { readonly credentials?: WecomCredentialReader } = {},
): WecomMediaUploader {
  const tokens = new WecomTokenProvider(http, new MemoryWecomTokenCache(), {
    credentials: readerOf(),
    timeoutMs: 1_000,
    now: () => NOW,
  });
  return new WecomMediaUploader(http, tokens, {
    timeoutMs: 1_000,
    credentials: options.credentials ?? readerOf(),
  });
}

describe('WecomOutboundSender request construction', () => {
  it('sends the message both processes would send, addressed by the conversation', async () => {
    const http = new FakeWecomHttp();
    const sender = buildSender(http);

    const result = await sender.sendMessage(sendInput());

    expect(result).toEqual({ ok: true, value: { externalMessageId: 'wecom-msg-1' } });
    expect(http.sendRequests).toHaveLength(1);
    expect(http.sendRequests[0]).toMatchObject({
      method: 'POST',
      timeoutMs: 1_000,
      url: 'https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=token-1',
    });
    // The provider-facing account comes from the conversation id the platform
    // built, so a delivery to a second account is not sent through the first.
    expect(http.sendRequests[0]?.body).toEqual({
      touser: 'customer-1',
      open_kfid: 'wkCONV01',
      msgtype: 'text',
      text: { content: '您好，我帮您查一下' },
    });
  });

  it('falls back to the configured account when the conversation names none', async () => {
    const http = new FakeWecomHttp();
    const sender = buildSender(http);

    await sender.sendMessage(sendInput({ externalConversationId: 'customer-1' }));

    expect(http.sendRequests[0]?.body).toMatchObject({ open_kfid: 'wkCONFIGURED' });
  });

  it('fetches the token once and reuses it for the next send', async () => {
    const http = new FakeWecomHttp();
    const sender = buildSender(http);

    await sender.sendMessage(sendInput());
    await sender.sendMessage(sendInput({ correlationId: 'delivery-2' }));

    expect(http.tokenRequests).toHaveLength(1);
    expect(http.sendRequests).toHaveLength(2);
    expect(http.tokenRequests[0]?.url).toContain('corpid=ww-corp');
  });

  it('refuses to send while the real credential is incomplete, without any request', async () => {
    const http = new FakeWecomHttp();
    const sender = buildSender(http, { credentials: unconfiguredReader('WECOM_KF_SECRET') });

    const result = await sender.sendMessage(sendInput());

    expect(result).toMatchObject({
      ok: false,
      code: 'channel_not_configured',
      retryable: false,
    });
    // Not even a token call: an unconfigured transport must not spend the
    // provider's quota to discover what it already knows.
    expect(http.requests).toHaveLength(0);
  });

  it('reports a lost provider id as possibly delivered', async () => {
    const http = new FakeWecomHttp();
    http.scriptSend(() => ({ status: 200, body: { errcode: 0 } }));
    const sender = buildSender(http);

    const result = await sender.sendMessage(sendInput());

    expect(result).toMatchObject({
      ok: false,
      code: 'channel_delivery_unknown',
      retryable: true,
      deliveryUnknown: true,
    });
  });

  it('maps the provider reply limit to a non-retryable failure', async () => {
    const http = new FakeWecomHttp();
    http.scriptSend(() => sendErrcode(95002));
    const sender = buildSender(http);

    const result = await sender.sendMessage(sendInput());

    expect(result).toMatchObject({ ok: false, code: 'channel_provider_error', retryable: false });
    // The provider's own text is never carried out of the transport.
    expect(JSON.stringify(result)).not.toContain('provider text');
  });

  it('maps any other provider rejection to a non-retryable invalid request', async () => {
    const http = new FakeWecomHttp();
    http.scriptSend(() => sendErrcode(93000));
    const sender = buildSender(http);

    const result = await sender.sendMessage(sendInput());

    expect(result).toMatchObject({ ok: false, code: 'channel_invalid_request', retryable: false });
  });

  it('classifies an unreachable endpoint as a retryable provider error', async () => {
    const http = new FakeWecomHttp();
    http.scriptSend(() => {
      throw new Error('socket hang up');
    });
    const sender = buildSender(http);

    const result = await sender.sendMessage(sendInput());

    expect(result).toMatchObject({ ok: false, code: 'channel_provider_error', retryable: true });
  });

  it('falls back to the HTTP status when the answer is not a WeCom document', async () => {
    const http = new FakeWecomHttp();
    http.scriptSend(() => ({ status: 503, body: null }));
    const sender = buildSender(http);

    expect(await sender.sendMessage(sendInput())).toMatchObject({ retryable: true });

    http.scriptSend(() => ({ status: 400, body: null }));
    expect(await sender.sendMessage(sendInput())).toMatchObject({
      ok: false,
      code: 'channel_provider_error',
      retryable: false,
    });
  });

  it('reports a failed token acquisition without calling the send endpoint', async () => {
    const http = new FakeWecomHttp();
    http.scriptToken(() => {
      throw new Error('token endpoint unreachable');
    });
    const sender = buildSender(http);

    const result = await sender.sendMessage(sendInput());

    expect(result).toMatchObject({ ok: false, code: 'channel_provider_error', retryable: true });
    expect(http.sendRequests).toHaveLength(0);
  });
});

describe('WecomOutboundSender replay after an authentication failure', () => {
  it('invalidates the token and replays exactly once', async () => {
    const http = new FakeWecomHttp();
    http.scriptToken(() =>
      http.tokenRequests.length > 1 ? tokenOk('token-2') : tokenOk('token-1'),
    );
    http.scriptSend(() =>
      http.sendRequests.length === 1 ? sendErrcode(40014) : sendOk('wecom-msg-2'),
    );
    const sender = buildSender(http);

    const result = await sender.sendMessage(sendInput());

    expect(result).toEqual({ ok: true, value: { externalMessageId: 'wecom-msg-2' } });
    // Exactly two sends and two token fetches: one replay, not a loop.
    expect(http.sendRequests).toHaveLength(2);
    expect(http.tokenRequests).toHaveLength(2);
    // The replay is the identical request, re-addressed to the fresh token.
    expect(http.sendRequests[0]?.body).toEqual(http.sendRequests[1]?.body);
    expect(http.sendRequests[1]?.url).toContain('access_token=token-2');
    // The whole replay path is inside the bound the Worker sizes its claim
    // against, so a caller that budgets `WECOM_MAX_REQUESTS_PER_SEND` requests
    // has budgeted for this case and not merely for the happy one.
    expect(http.requests).toHaveLength(2 * (1 + WECOM_AUTH_REPLAY_ATTEMPTS));
    expect(http.requests.length).toBeLessThanOrEqual(WECOM_MAX_REQUESTS_PER_SEND);
  });

  it('bounds the request count of the worst case it can produce', async () => {
    const http = new FakeWecomHttp();
    // Both attempts are rejected as unauthenticated: the transport's own worst
    // case, since every attempt may also have to fetch a token first.
    http.scriptSend(() => sendErrcode(40014));
    const sender = buildSender(http);

    await sender.sendMessage(sendInput());

    expect(http.requests).toHaveLength(WECOM_MAX_REQUESTS_PER_SEND);
    expect(WECOM_MAX_REQUESTS_PER_SEND).toBe(4);
    expect(WECOM_AUTH_REPLAY_ATTEMPTS).toBe(1);
  });

  it('gives up after a second authentication failure', async () => {
    const http = new FakeWecomHttp();
    http.scriptSend(() => sendErrcode(40014));
    const sender = buildSender(http);

    const result = await sender.sendMessage(sendInput());

    expect(result).toMatchObject({ ok: false, code: 'channel_not_configured', retryable: false });
    expect(http.sendRequests).toHaveLength(2);
  });

  it('does not replay a rejection that is not an authentication failure', async () => {
    const http = new FakeWecomHttp();
    http.scriptSend(() => sendErrcode(93000));
    const sender = buildSender(http);

    await sender.sendMessage(sendInput());

    expect(http.sendRequests).toHaveLength(1);
  });
});

describe('WeCom outbound payload and account mapping', () => {
  it('builds a link payload where the content is both title and url', () => {
    expect(
      wecomOutboundPayload(sendInput({ messageType: 'link', content: 'https://x.test' })),
    ).toEqual({
      ok: true,
      value: { msgtype: 'link', link: { title: 'https://x.test', url: 'https://x.test' } },
    });
  });

  it('builds an image payload from an uploaded media id', () => {
    expect(
      wecomOutboundPayload(
        sendInput({
          messageType: 'image',
          media: { mediaId: 'media-1', mimeType: 'image/png' },
        }),
      ),
    ).toEqual({ ok: true, value: { msgtype: 'image', image: { media_id: 'media-1' } } });
  });

  it('refuses an image payload with no media id', () => {
    expect(wecomOutboundPayload(sendInput({ messageType: 'image', media: null }))).toMatchObject({
      ok: false,
      code: 'channel_invalid_request',
      retryable: false,
    });
  });

  it('recovers an account id only from a well-formed conversation id', () => {
    expect(openKfIdOfConversation('wkCONV01:customer-1')).toBe('wkCONV01');
    expect(openKfIdOfConversation('wk_a-b:customer-1')).toBe('wk_a-b');
    expect(openKfIdOfConversation('customer-1')).toBeNull();
    expect(openKfIdOfConversation(':customer-1')).toBeNull();
    expect(openKfIdOfConversation('nope:customer-1')).toBeNull();
  });

  it('maps provider codes onto stable channel failures', () => {
    expect(mapWecomSendFailure(95002)).toMatchObject({ retryable: false });
    expect(mapWecomSendFailure(40001)).toMatchObject({ code: 'channel_not_configured' });
    expect(mapWecomSendFailure(42001)).toMatchObject({ code: 'channel_not_configured' });
    expect(mapWecomSendFailure(93000)).toMatchObject({ code: 'channel_invalid_request' });
  });

  it('claims image send only now that both halves of that delivery are wired', () => {
    expect(WECOM_OUTBOUND_CAPABILITIES.sendText).toBe(true);
    expect(WECOM_OUTBOUND_CAPABILITIES.sendImage).toBe(true);
    // The claim is only honest because the media-id send path exists beside the
    // uploader: a `media_id` is what an image send actually carries.
    expect(
      wecomOutboundPayload(
        sendInput({ messageType: 'image', media: { mediaId: 'media-1', mimeType: 'image/png' } }),
      ),
    ).toEqual({ ok: true, value: { msgtype: 'image', image: { media_id: 'media-1' } } });
  });

  it('reports what a token operation proved, without carrying the token', async () => {
    const observed: boolean[] = [];
    const http = new FakeWecomHttp();
    const tokens = new WecomTokenProvider(http, new MemoryWecomTokenCache(), {
      credentials: readerOf(),
      timeoutMs: 1_000,
      now: () => NOW,
      onConnectionProven: (connected) => observed.push(connected),
    });

    expect(await tokens.get()).toMatchObject({ ok: true });
    http.scriptToken(() => ({ status: 200, body: { errcode: 40001 } }));
    await tokens.invalidate();
    expect(await tokens.get()).toMatchObject({ ok: false, code: 'channel_not_configured' });

    expect(observed).toEqual([true, false]);
  });
});

describe('WecomMediaUploader request construction', () => {
  it('uploads the image as the multipart part the provider reads under `media`', async () => {
    const http = new FakeWecomHttp();
    const uploader = buildUploader(http);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const result = await uploader.uploadMedia({ mimeType: 'image/png', bytes });

    expect(result).toEqual({ ok: true, value: { mediaId: 'media-1' } });
    expect(http.uploadRequests).toHaveLength(1);
    expect(http.uploadRequests[0]).toMatchObject({
      method: 'POST',
      timeoutMs: 1_000,
      url: 'https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=token-1&type=image',
      multipart: {
        field: 'media',
        filename: 'wecom-image.png',
        contentType: 'image/png',
        bytes,
      },
    });
    // The upload is not a JSON request, and the port carries one body shape at a
    // time so the client can never be handed both.
    expect(http.uploadRequests[0]?.body).toBeUndefined();
    // One token fetch for the whole upload: the cache is the same one a send uses.
    expect(http.tokenRequests).toHaveLength(1);
    expect(http.tokenRequests[0]?.url).toContain('corpid=ww-corp');
  });

  it('refuses a payload the provider would only reject, without any request', async () => {
    const http = new FakeWecomHttp();
    const uploader = buildUploader(http);

    for (const input of [
      { mimeType: 'application/pdf', bytes: new Uint8Array([1]) },
      { mimeType: 'image/png', bytes: new Uint8Array(0) },
      { mimeType: 'image/png', bytes: new Uint8Array(WECOM_MEDIA_MAX_BYTES + 1) },
    ]) {
      expect(await uploader.uploadMedia(input)).toMatchObject({
        ok: false,
        code: 'channel_invalid_request',
        retryable: false,
      });
    }
    // Not even a token call: a payload the platform already knows is unusable
    // must not spend the provider's quota.
    expect(http.requests).toHaveLength(0);
  });

  it('refuses to upload while the real credential is incomplete', async () => {
    const http = new FakeWecomHttp();
    const uploader = buildUploader(http, { credentials: unconfiguredReader('WECOM_KF_SECRET') });

    expect(
      await uploader.uploadMedia({ mimeType: 'image/png', bytes: new Uint8Array([1]) }),
    ).toMatchObject({ ok: false, code: 'channel_not_configured', retryable: false });
    expect(http.requests).toHaveLength(0);
  });

  it('maps a rejected upload onto a stable failure without the provider text', async () => {
    const http = new FakeWecomHttp();
    http.scriptUpload(() => uploadErrcode(40001));
    const refused = await buildUploader(http).uploadMedia({
      mimeType: 'image/png',
      bytes: new Uint8Array([1]),
    });

    expect(refused).toMatchObject({ ok: false, code: 'channel_not_configured', retryable: false });
    expect(JSON.stringify(refused)).not.toContain('provider text');
    // The token that was used is not carried out of the transport either.
    expect(JSON.stringify(refused)).not.toContain('token-1');

    // 40006 is WeCom's "invalid file size": a rejection no fresh token would
    // change, so it must be classified once and never replayed.
    http.scriptUpload(() => uploadErrcode(40006));
    expect(
      await buildUploader(http).uploadMedia({ mimeType: 'image/png', bytes: new Uint8Array([1]) }),
    ).toMatchObject({ ok: false, code: 'channel_invalid_request', retryable: false });
  });

  it('treats an accepted upload with no media id as a retryable provider error', async () => {
    const http = new FakeWecomHttp();
    http.scriptUpload(() => ({ status: 200, body: { errcode: 0, errmsg: 'ok' } }));

    expect(
      await buildUploader(http).uploadMedia({ mimeType: 'image/png', bytes: new Uint8Array([1]) }),
    ).toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom media upload endpoint accepted the image without returning a media id',
      retryable: true,
    });
  });

  it('classifies an unreachable endpoint as a retryable provider error', async () => {
    const http = new FakeWecomHttp();
    http.scriptUpload(() => {
      throw new Error('socket hang up');
    });

    expect(
      await buildUploader(http).uploadMedia({ mimeType: 'image/jpeg', bytes: new Uint8Array([1]) }),
    ).toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom media upload endpoint could not be reached',
      retryable: true,
    });
  });

  it('falls back to the HTTP status when the answer is not a WeCom document', async () => {
    const http = new FakeWecomHttp();
    http.scriptUpload(() => ({ status: 502, body: 'bad gateway' }));

    expect(
      await buildUploader(http).uploadMedia({ mimeType: 'image/png', bytes: new Uint8Array([1]) }),
    ).toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom media upload endpoint answered with HTTP 502',
      retryable: true,
    });
  });

  it('reports a failed token acquisition without calling the upload endpoint', async () => {
    const http = new FakeWecomHttp();
    http.scriptToken(() => {
      throw new Error('token endpoint unreachable');
    });

    expect(
      await buildUploader(http).uploadMedia({ mimeType: 'image/png', bytes: new Uint8Array([1]) }),
    ).toMatchObject({ ok: false, code: 'channel_provider_error', retryable: true });
    expect(http.uploadRequests).toHaveLength(0);
  });

  it('maps provider codes onto stable channel failures', () => {
    expect(mapWecomUploadFailure(40014)).toMatchObject({ code: 'channel_not_configured' });
    expect(mapWecomUploadFailure(42001)).toMatchObject({ code: 'channel_not_configured' });
    expect(mapWecomUploadFailure(40006)).toMatchObject({ code: 'channel_invalid_request' });
  });
});

describe('WecomMediaUploader replay after an authentication failure', () => {
  it('invalidates the token and replays exactly once', async () => {
    const http = new FakeWecomHttp();
    http.scriptToken(() =>
      http.tokenRequests.length > 1 ? tokenOk('token-2') : tokenOk('token-1'),
    );
    http.scriptUpload(() =>
      http.uploadRequests.length === 1 ? uploadErrcode(40014) : uploadOk('media-2'),
    );

    const result = await buildUploader(http).uploadMedia({
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(result).toEqual({ ok: true, value: { mediaId: 'media-2' } });
    // Exactly two uploads and two token fetches: one replay, not a loop.
    expect(http.uploadRequests).toHaveLength(2);
    expect(http.tokenRequests).toHaveLength(2);
    // The replay carries the identical payload, re-addressed to the fresh token.
    expect(http.uploadRequests[0]?.multipart).toEqual(http.uploadRequests[1]?.multipart);
    expect(http.uploadRequests[1]?.url).toContain('access_token=token-2');
  });

  it('bounds the request count of the worst case it can produce', async () => {
    const http = new FakeWecomHttp();
    http.scriptUpload(() => uploadErrcode(40014));

    expect(
      await buildUploader(http).uploadMedia({ mimeType: 'image/png', bytes: new Uint8Array([1]) }),
    ).toMatchObject({ ok: false, code: 'channel_not_configured', retryable: false });
    expect(http.requests).toHaveLength(WECOM_MAX_REQUESTS_PER_UPLOAD);
    expect(WECOM_MAX_REQUESTS_PER_UPLOAD).toBe(4);
  });

  it('does not replay a rejection that is not an authentication failure', async () => {
    const http = new FakeWecomHttp();
    http.scriptUpload(() => uploadErrcode(40006));

    await buildUploader(http).uploadMedia({ mimeType: 'image/png', bytes: new Uint8Array([1]) });

    expect(http.uploadRequests).toHaveLength(1);
  });
});

describe('MockWecomAdapter outbound behaviour', () => {
  const adapter = new MockWecomAdapter();

  it('delivers deterministically and points the id at the correlation id', async () => {
    const result = await adapter.sendMessage(sendInput());

    expect(result).toEqual({ ok: true, value: { externalMessageId: 'mock-delivery-1' } });
  });

  it('produces the definite rejection the fail trigger documents', async () => {
    const result = await adapter.sendMessage(
      sendInput({ content: `请稍等 ${MOCK_WECOM_FAIL_TRIGGER}` }),
    );

    expect(result).toMatchObject({ ok: false, code: 'channel_provider_error', retryable: true });
    expect(result).not.toHaveProperty('deliveryUnknown');
  });

  it('produces the lost-response outcome the unknown trigger documents', async () => {
    const result = await adapter.sendMessage(
      sendInput({ content: `请稍等 ${MOCK_WECOM_UNKNOWN_TRIGGER}` }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'channel_delivery_unknown',
      retryable: true,
      deliveryUnknown: true,
    });
  });

  it('refuses an image delivery with no media', async () => {
    const result = await adapter.sendMessage(sendInput({ messageType: 'image', media: null }));

    expect(result).toMatchObject({ ok: false, code: 'channel_invalid_request' });
  });

  it('verifies the documented shared-secret callback header', async () => {
    const verified = await adapter.verifyWebhook({
      channel: 'wecom',
      signature: 'mock-signature',
      timestamp: null,
      nonce: null,
      rawBody: '{}',
    });
    const refused = await adapter.verifyWebhook({
      channel: 'wecom',
      signature: null,
      timestamp: null,
      nonce: null,
      rawBody: '{}',
    });

    expect(verified).toMatchObject({ ok: true });
    expect(refused).toMatchObject({ ok: false, code: 'channel_invalid_request' });
  });
});
