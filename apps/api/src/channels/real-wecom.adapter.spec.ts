import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveWecomCredentials,
  type AppConfig,
  type ChannelAdapter,
  type SendMessageInput,
} from '@kefu/core';
import {
  REAL_WECOM_CAPABILITIES,
  RealWecomAdapter,
  UNBOUND_WECOM_SCOPE,
  isWecomRealTransport,
  type WecomScope,
  type WecomScopeResolver,
} from './real-wecom.adapter';
import {
  MemoryWecomTokenCache,
  WecomTokenProvider,
  type WecomCredentialReader,
  type WecomHttpRequest,
  type WecomHttpResponse,
} from '@kefu/wecom';
import { resetWecomConnectionState } from './wecom-transport';
import {
  FakeWecomHttp,
  TEST_CALLBACK_TOKEN,
  TEST_CORP_ID,
  TEST_ENCODING_AES_KEY,
  TEST_KF_SECRET,
  TEST_OPEN_KF_ID,
  encryptWecomMessage,
  realWecomConfig,
  wecomCallbackEnvelope,
  wecomCallbackSignature,
  wecomXml,
} from '../../test/wecom-callback-support';

/** The clock every test pins, so a mapped `receivedAt` is a literal. */
const NOW_MS = Date.parse('2026-03-01T12:00:00.000Z');

/** A pinned `CreateTime`, and the instant it must map to. */
const CREATE_TIME = '1770000000';
const CREATE_TIME_ISO = '2026-02-02T02:40:00.000Z';

/** The scope the bound resolver answers with. */
const SCOPE: WecomScope = { tenantId: 'tenant-acme', storeId: 'store-acme-flagship' };

/** A scope resolver that binds every callback, with the calls it received. */
function recordingScope(): {
  readonly scope: WecomScopeResolver;
  readonly calls: Array<{ corpId: string; openKfId: string | null; externalCustomerId: string }>;
} {
  const calls: Array<{ corpId: string; openKfId: string | null; externalCustomerId: string }> = [];
  return {
    calls,
    scope: async (input) => {
      calls.push({ ...input });
      return SCOPE;
    },
  };
}

/** The default resolver a mapping test binds with, when it records nothing. */
const BOUND_SCOPE: WecomScopeResolver = async () => SCOPE;

/** A successful `gettoken` answer. */
const TOKEN_ANSWER: WecomHttpResponse = {
  status: 200,
  body: { errcode: 0, errmsg: 'ok', access_token: 'test-access-token', expires_in: 7200 },
};

/** The default `kf/send_msg` answer. */
const SEND_OK: WecomHttpResponse = {
  status: 200,
  body: { errcode: 0, errmsg: 'ok', msgid: 'msg-1' },
};

/** Route a request to the token endpoint or the send endpoint. */
function routed(send: (body: unknown) => WecomHttpResponse) {
  return (request: WecomHttpRequest): WecomHttpResponse =>
    request.url.includes('/cgi-bin/gettoken') ? TOKEN_ANSWER : send(request.body);
}

/**
 * The environment half of the API's credential reader, with nothing stored.
 *
 * The adapter resolves its credentials per operation rather than holding them;
 * this is the same shape the module composes, over the environment alone — the
 * state a deployment that has never connected anything from the console is in.
 */
function environmentReader(config: AppConfig): WecomCredentialReader {
  return async () => resolveWecomCredentials({ stored: undefined, environment: config.wecom });
}

/** Build an adapter over a fake port, with the token provider on the same port. */
function buildAdapter(options: {
  readonly http?: FakeWecomHttp;
  readonly env?: Readonly<Record<string, string>>;
  readonly scope?: WecomScopeResolver;
  readonly credentials?: WecomCredentialReader;
}) {
  const config = realWecomConfig(options.env ?? {});
  const http = options.http ?? new FakeWecomHttp(routed(() => SEND_OK));
  const credentials = options.credentials ?? environmentReader(config);
  const tokens = new WecomTokenProvider(http, new MemoryWecomTokenCache(), {
    credentials,
    timeoutMs: 3000,
  });
  const adapter = new RealWecomAdapter(credentials, {
    http,
    tokens,
    scope: options.scope ?? UNBOUND_WECOM_SCOPE,
    timeoutMs: 3000,
    now: () => NOW_MS,
  });
  return { adapter, http, config };
}

/** Encrypt one message document into a callback envelope, and sign it. */
function signedCallback(
  message: string,
  options: { readonly timestamp?: string; readonly nonce?: string } = {},
) {
  const encrypted = encryptWecomMessage(TEST_ENCODING_AES_KEY, message, TEST_CORP_ID);
  const timestamp = options.timestamp ?? CREATE_TIME;
  const nonce = options.nonce ?? 'nonce-9';
  return {
    encrypted,
    body: wecomCallbackEnvelope(encrypted),
    signature: wecomCallbackSignature(TEST_CALLBACK_TOKEN, timestamp, nonce, encrypted),
    timestamp,
    nonce,
  };
}

/** One inbound customer-service text message document. */
function textMessage(overrides: Readonly<Record<string, string>> = {}): string {
  return wecomXml({
    ToUserName: 'gh_test',
    FromUserName: 'wm-customer-1',
    CreateTime: CREATE_TIME,
    MsgType: 'text',
    Content: '请问什么时候发货？',
    MsgId: '7001',
    OpenKfId: TEST_OPEN_KF_ID,
    ...overrides,
  });
}

/** One `kf_msg_or_event` notification document. */
function notification(overrides: Readonly<Record<string, string>> = {}): string {
  return wecomXml({
    ToUserName: 'gh_test',
    CreateTime: CREATE_TIME,
    MsgType: 'event',
    Event: 'kf_msg_or_event',
    Token: 'notification-token-1',
    OpenKfId: TEST_OPEN_KF_ID,
    ...overrides,
  });
}

/** The pull arguments a notification resolves to. */
const PULL_INPUT = {
  openKfId: TEST_OPEN_KF_ID,
  cursor: null,
  notificationToken: 'notification-token-1',
  limit: 100,
  scope: SCOPE,
} as const;

/**
 * One `kf/sync_msg` page answer.
 *
 * The default carries a position because a page a caller may accept must say
 * where it stopped; a test that omits one is deliberately describing a page the
 * transport has to refuse.
 */
function syncPage(fields: Readonly<Record<string, unknown>>): WecomHttpResponse {
  return {
    status: 200,
    body: { errcode: 0, errmsg: 'ok', next_cursor: 'cursor-1', ...fields },
  };
}

/** One customer text record, as the provider sends it. */
function syncTextRecord(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    msgid: 'sync-1',
    open_kfid: TEST_OPEN_KF_ID,
    external_userid: 'wm-customer-1',
    send_time: 1770000000,
    origin: 3,
    msgtype: 'text',
    text: { content: '请问什么时候发货？' },
    ...overrides,
  };
}

/** A `sendMessage` input with the platform-neutral fields filled in. */
function sendInput(overrides: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    tenantId: SCOPE.tenantId,
    storeId: SCOPE.storeId,
    externalCustomerId: 'wm-customer-1',
    externalConversationId: `${TEST_OPEN_KF_ID}:wm-customer-1`,
    messageType: 'text',
    content: '您好，今天发货',
    correlationId: 'delivery-1',
    ...overrides,
  };
}

describe('RealWecomAdapter callback authentication', () => {
  beforeEach(() => {
    resetWecomConnectionState();
  });

  afterEach(() => {
    resetWecomConnectionState();
  });

  it('accepts a callback whose msg_signature covers the raw body', async () => {
    const { adapter } = buildAdapter({});
    const callback = signedCallback(textMessage());

    expect(
      await adapter.verifyWebhook({
        channel: 'wecom',
        signature: callback.signature,
        timestamp: callback.timestamp,
        nonce: callback.nonce,
        rawBody: callback.body,
      }),
    ).toEqual({ ok: true, value: { verified: true } });
  });

  it('rejects a signature minted over different bytes, a different token or nothing at all', async () => {
    const { adapter } = buildAdapter({});
    const callback = signedCallback(textMessage());
    const other = signedCallback(textMessage({ MsgId: '7002' }));

    for (const signature of [
      other.signature,
      wecomCallbackSignature(
        'another-token',
        callback.timestamp,
        callback.nonce,
        callback.encrypted,
      ),
      null,
    ]) {
      expect(
        await adapter.verifyWebhook({
          channel: 'wecom',
          signature,
          timestamp: callback.timestamp,
          nonce: callback.nonce,
          rawBody: callback.body,
        }),
      ).toMatchObject({
        ok: false,
        code: 'channel_invalid_request',
        message: 'the callback msg_signature was rejected',
        retryable: false,
      });
    }
  });

  it('rejects a callback that carries no timestamp or nonce to authenticate', async () => {
    const { adapter } = buildAdapter({});
    const callback = signedCallback(textMessage());

    expect(
      await adapter.verifyWebhook({
        channel: 'wecom',
        signature: callback.signature,
        timestamp: null,
        nonce: callback.nonce,
        rawBody: callback.body,
      }),
    ).toMatchObject({
      ok: false,
      code: 'channel_invalid_request',
      message: 'the callback carries no timestamp or nonce to authenticate',
    });
  });

  it('rejects a body with no Encrypt element, and one that is not XML at all', async () => {
    const { adapter } = buildAdapter({});

    for (const rawBody of ['<xml><ToUserName>gh</ToUserName></xml>', '{"hello":"world"}']) {
      expect(
        await adapter.verifyWebhook({
          channel: 'wecom',
          signature: 'anything',
          timestamp: CREATE_TIME,
          nonce: 'nonce-9',
          rawBody,
        }),
      ).toMatchObject({
        ok: false,
        code: 'channel_invalid_request',
        message: 'the callback body carries no <Encrypt> element',
      });
    }
  });
});

describe('RealWecomAdapter callback URL handshake', () => {
  beforeEach(() => {
    resetWecomConnectionState();
  });

  afterEach(() => {
    resetWecomConnectionState();
  });

  it('answers with the decrypted echostr, with nothing added to it', async () => {
    const { adapter } = buildAdapter({});
    const echo = 'echo-1234567890123456';
    const encrypted = encryptWecomMessage(TEST_ENCODING_AES_KEY, echo, TEST_CORP_ID);

    const result = await adapter.verifyCallbackUrl({
      signature: wecomCallbackSignature(TEST_CALLBACK_TOKEN, CREATE_TIME, 'nonce-9', encrypted),
      timestamp: CREATE_TIME,
      nonce: 'nonce-9',
      echostr: encrypted,
    });

    // Exact equality is the point: WeCom compares the body byte for byte, so a
    // trailing newline or a quote would fail the handshake.
    expect(result).toEqual({ ok: true, value: echo });
  });

  it('refuses a handshake whose signature does not cover the echostr', async () => {
    const { adapter } = buildAdapter({});
    const encrypted = encryptWecomMessage(TEST_ENCODING_AES_KEY, 'echo-1', TEST_CORP_ID);

    expect(
      await adapter.verifyCallbackUrl({
        signature: wecomCallbackSignature('another-token', CREATE_TIME, 'nonce-9', encrypted),
        timestamp: CREATE_TIME,
        nonce: 'nonce-9',
        echostr: encrypted,
      }),
    ).toMatchObject({ ok: false, message: 'the callback msg_signature was rejected' });
  });

  it('refuses a handshake with no echostr', async () => {
    const { adapter } = buildAdapter({});

    expect(
      await adapter.verifyCallbackUrl({
        signature: 'anything',
        timestamp: CREATE_TIME,
        nonce: 'nonce-9',
        echostr: null,
      }),
    ).toMatchObject({ ok: false, message: 'the callback URL verification carries no echostr' });
  });

  it('refuses an echostr minted for another corp', async () => {
    const { adapter } = buildAdapter({});
    const encrypted = encryptWecomMessage(TEST_ENCODING_AES_KEY, 'echo-1', 'ww-someone-else');

    expect(
      await adapter.verifyCallbackUrl({
        signature: wecomCallbackSignature(TEST_CALLBACK_TOKEN, CREATE_TIME, 'nonce-9', encrypted),
        timestamp: CREATE_TIME,
        nonce: 'nonce-9',
        echostr: encrypted,
      }),
    ).toMatchObject({
      ok: false,
      message: 'the payload was encrypted for a different receiver id',
    });
  });
});

describe('RealWecomAdapter inbound mapping', () => {
  beforeEach(() => {
    resetWecomConnectionState();
  });

  afterEach(() => {
    resetWecomConnectionState();
  });

  it('maps a text callback onto a provider-neutral message', async () => {
    const recording = recordingScope();
    const { adapter } = buildAdapter({ scope: recording.scope });
    const callback = signedCallback(textMessage());

    const result = await adapter.parseInboundMessage({ rawBody: callback.body });

    expect(result).toEqual({
      ok: true,
      value: {
        id: '7001',
        channel: 'wecom',
        externalEventId: '7001',
        tenantId: SCOPE.tenantId,
        storeId: SCOPE.storeId,
        externalCustomerId: 'wm-customer-1',
        externalConversationId: `${TEST_OPEN_KF_ID}:wm-customer-1`,
        externalMessageId: '7001',
        direction: 'inbound',
        messageType: 'text',
        content: '请问什么时候发货？',
        dedupKey: 'wecom:7001',
        media: null,
        receivedAt: CREATE_TIME_ISO,
      },
    });
    // The binding is the platform's decision, so the adapter has to ask for it
    // with the identifiers the callback actually carries.
    expect(recording.calls).toEqual([
      { corpId: TEST_CORP_ID, openKfId: TEST_OPEN_KF_ID, externalCustomerId: 'wm-customer-1' },
    ]);
  });

  it('maps an image callback and keeps its media reference', async () => {
    const { adapter } = buildAdapter({ scope: BOUND_SCOPE });
    const callback = signedCallback(
      textMessage({
        MsgType: 'image',
        MediaId: 'MEDIA-1',
        PicUrl: 'https://example.invalid/1.jpg',
      }),
    );

    const result = await adapter.parseInboundMessage({ rawBody: callback.body });

    expect(result).toMatchObject({
      ok: true,
      value: {
        messageType: 'image',
        content: '[图片消息]',
        media: {
          mediaId: 'MEDIA-1',
          mimeType: 'application/octet-stream',
          url: 'https://example.invalid/1.jpg',
        },
      },
    });
  });

  it('leaves an image without a media id without a media reference', async () => {
    const { adapter } = buildAdapter({ scope: BOUND_SCOPE });
    const callback = signedCallback(textMessage({ MsgType: 'image', MediaId: '' }));

    expect(await adapter.parseInboundMessage({ rawBody: callback.body })).toMatchObject({
      ok: true,
      value: { messageType: 'image', content: '[图片消息]', media: null },
    });
  });

  it('reads a link as its title, falling back to its url and then to a placeholder', async () => {
    const { adapter } = buildAdapter({ scope: BOUND_SCOPE });

    for (const [fields, expected] of [
      [{ Title: '发货说明', Url: 'https://example.invalid/a' }, '发货说明'],
      [{ Url: 'https://example.invalid/a' }, 'https://example.invalid/a'],
      [{}, '[链接消息]'],
    ] as ReadonlyArray<[Readonly<Record<string, string>>, string]>) {
      const callback = signedCallback(textMessage({ MsgType: 'link', Content: '', ...fields }));
      expect(await adapter.parseInboundMessage({ rawBody: callback.body })).toMatchObject({
        ok: true,
        value: { messageType: 'link', content: expected },
      });
    }
  });

  it('falls back to the configured account id when the document carries none', async () => {
    const { adapter } = buildAdapter({ scope: BOUND_SCOPE });
    const callback = signedCallback(textMessage({ OpenKfId: '' }));

    expect(await adapter.parseInboundMessage({ rawBody: callback.body })).toMatchObject({
      ok: true,
      value: { externalConversationId: `${TEST_OPEN_KF_ID}:wm-customer-1` },
    });
  });

  it('refuses the customer-service event notification instead of inventing a message', async () => {
    const { adapter } = buildAdapter({ scope: BOUND_SCOPE });
    const callback = signedCallback(notification());

    // A notification is not a mapping failure — it has no message to map. It is
    // a request to pull, and this entry point cannot answer one, so it says so
    // rather than producing a message out of the notification's own fields.
    expect(await adapter.parseInboundMessage({ rawBody: callback.body })).toMatchObject({
      ok: false,
      code: 'channel_invalid_request',
      message:
        'the callback is a customer-service event notification, not a message; it is answered by the kf/sync_msg notification path',
      retryable: false,
    });
  });

  it('normalises a message type this slice does not map into a visible placeholder', async () => {
    const { adapter } = buildAdapter({ scope: BOUND_SCOPE });
    const callback = signedCallback(textMessage({ MsgType: 'voice' }));

    // This used to be a refusal, and the refusal lost the customer's message
    // outright: nothing was written, and the provider retried a callback that
    // would fail the same way every time. The voice note now arrives as a text
    // message whose content is the placeholder for its kind, so the workspace
    // shows something a person has to answer (§块 3).
    expect(await adapter.parseInboundMessage({ rawBody: callback.body })).toMatchObject({
      ok: true,
      value: {
        messageType: 'text',
        content: '[语音消息]',
        // The bytes are not carried: nothing on this transport downloads them.
        media: null,
      },
    });
  });

  it('names a message type it has no placeholder for instead of echoing the provider token', async () => {
    const { adapter } = buildAdapter({ scope: BOUND_SCOPE });
    const callback = signedCallback(textMessage({ MsgType: 'msgmenu' }));

    // Both halves matter: the message still arrives, and what an operator reads
    // is the platform's own words rather than a field out of the provider's
    // vocabulary.
    expect(await adapter.parseInboundMessage({ rawBody: callback.body })).toMatchObject({
      ok: true,
      value: { messageType: 'text', content: '[菜单消息]' },
    });
  });

  it('refuses a callback that carries no message type at all', async () => {
    const { adapter } = buildAdapter({ scope: BOUND_SCOPE });
    const callback = signedCallback(textMessage({ MsgType: '' }));

    // Not the same case as a type this slice does not map: every message the
    // provider sends names one, so its absence is a document this transport
    // cannot read and is reported as one rather than turned into a message.
    expect(await adapter.parseInboundMessage({ rawBody: callback.body })).toMatchObject({
      ok: false,
      code: 'channel_invalid_request',
      message: 'the callback carries no <MsgType>',
    });
  });

  it('refuses a callback with no stable message identity', async () => {
    const { adapter } = buildAdapter({ scope: BOUND_SCOPE });

    // No customer to attribute it to, so no platform scope can even be asked
    // for; and no MsgId, so there is no replay key to deduplicate on.
    for (const overrides of [
      { FromUserName: '' },
      { MsgId: '' },
      { MsgId: '', FromUserName: '' },
    ]) {
      const callback = signedCallback(textMessage(overrides));
      expect(await adapter.parseInboundMessage({ rawBody: callback.body })).toMatchObject({
        ok: false,
        code: 'channel_invalid_request',
      });
    }
  });

  it('refuses a callback it cannot attribute to a customer before resolving any scope', async () => {
    const recording = recordingScope();
    const { adapter } = buildAdapter({ scope: recording.scope });
    const callback = signedCallback(textMessage({ FromUserName: '' }));

    expect(await adapter.parseInboundMessage({ rawBody: callback.body })).toMatchObject({
      ok: false,
      message: 'the decrypted callback carries no <FromUserName>',
    });
    expect(recording.calls).toEqual([]);
  });

  it('refuses a callback it cannot bind to a platform tenant instead of guessing one', async () => {
    const { adapter } = buildAdapter({ scope: UNBOUND_WECOM_SCOPE });
    const callback = signedCallback(textMessage());

    expect(await adapter.parseInboundMessage({ rawBody: callback.body })).toMatchObject({
      ok: false,
      code: 'channel_not_configured',
      message: 'the WeCom customer-service callback is not bound to a platform tenant/store yet',
      retryable: false,
    });
  });

  it('refuses a body it cannot decrypt rather than reporting a mapping failure', async () => {
    const { adapter } = buildAdapter({ scope: BOUND_SCOPE });
    const body = wecomCallbackEnvelope('not-a-ciphertext');

    expect(await adapter.parseInboundMessage({ rawBody: body })).toMatchObject({
      ok: false,
      code: 'channel_invalid_request',
    });
  });
});

describe('RealWecomAdapter kf/sync_msg notification and pull', () => {
  beforeEach(() => {
    resetWecomConnectionState();
  });

  it('classifies a notification without resolving any platform scope', async () => {
    const recording = recordingScope();
    const { adapter } = buildAdapter({ scope: recording.scope });
    const callback = signedCallback(notification());

    expect(await adapter.readNotification({ rawBody: callback.body })).toEqual({
      ok: true,
      value: {
        kind: 'notification',
        openKfId: TEST_OPEN_KF_ID,
        notificationToken: 'notification-token-1',
      },
    });
    // A notification names no customer, so there is nothing to bind and no scope
    // that could be guessed.
    expect(recording.calls).toEqual([]);
  });

  it('falls back to the configured account id when a notification carries none', async () => {
    const { adapter } = buildAdapter({});
    const callback = signedCallback(notification({ OpenKfId: '' }));

    expect(await adapter.readNotification({ rawBody: callback.body })).toMatchObject({
      ok: true,
      value: { kind: 'notification', openKfId: TEST_OPEN_KF_ID },
    });
  });

  it('refuses a customer-service event that is not the notification it pulls for', async () => {
    const { adapter } = buildAdapter({});
    const callback = signedCallback(notification({ Event: 'kf_account_auth_change' }));

    expect(await adapter.readNotification({ rawBody: callback.body })).toMatchObject({
      ok: false,
      code: 'channel_invalid_request',
      message: 'the callback is a customer-service event this transport does not handle',
    });
  });

  it('refuses a notification that carries no pull token', async () => {
    const { adapter } = buildAdapter({});
    const callback = signedCallback(notification({ Token: '' }));

    expect(await adapter.readNotification({ rawBody: callback.body })).toMatchObject({
      ok: false,
      code: 'channel_invalid_request',
      message: 'the customer-service notification carries no <Token> to pull with',
    });
  });

  it('classifies a direct message callback and resolves its scope', async () => {
    const recording = recordingScope();
    const { adapter } = buildAdapter({ scope: recording.scope });
    const callback = signedCallback(textMessage());

    expect(await adapter.readNotification({ rawBody: callback.body })).toMatchObject({
      ok: true,
      value: { kind: 'message', message: { content: '请问什么时候发货？' } },
    });
    expect(recording.calls).toEqual([
      { corpId: TEST_CORP_ID, openKfId: TEST_OPEN_KF_ID, externalCustomerId: 'wm-customer-1' },
    ]);
  });

  it('pulls with the access token, the notification token and no cursor on a first pull', async () => {
    const http = new FakeWecomHttp(routed(() => syncPage({ msg_list: [] })));
    const { adapter } = buildAdapter({ http });

    await expect(adapter.pullSyncMessages({ ...PULL_INPUT })).resolves.toMatchObject({ ok: true });

    expect(http.matching('/cgi-bin/gettoken')).toHaveLength(1);
    const [request] = http.matching('/cgi-bin/kf/sync_msg');
    expect(request?.method).toBe('POST');
    expect(request?.url).toContain('access_token=test-access-token');
    expect(request?.body).toEqual({
      token: 'notification-token-1',
      limit: 100,
      voice_format: 0,
      open_kfid: TEST_OPEN_KF_ID,
    });
  });

  it('resumes from the cursor it was given on a later pull', async () => {
    const http = new FakeWecomHttp(routed(() => syncPage({ msg_list: [] })));
    const { adapter } = buildAdapter({ http });

    await adapter.pullSyncMessages({ ...PULL_INPUT, cursor: 'cursor-7' });

    expect(http.matching('/cgi-bin/kf/sync_msg')[0]?.body).toMatchObject({ cursor: 'cursor-7' });
  });

  it('maps customer text, image and link records and skips what the customer did not send', async () => {
    const http = new FakeWecomHttp(
      routed(() =>
        syncPage({
          msg_list: [
            syncTextRecord(),
            syncTextRecord({
              msgid: 'sync-2',
              msgtype: 'image',
              text: undefined,
              image: { media_id: 'MEDIA-9' },
            }),
            syncTextRecord({
              msgid: 'sync-3',
              msgtype: 'link',
              text: undefined,
              link: { title: '发货说明', url: 'https://example.invalid/a' },
            }),
            // The agent's own reply: `origin` is not the customer's, so it must
            // never be ingested as a new customer message.
            syncTextRecord({ msgid: 'sync-4', origin: 5 }),
            // A system notice, which carries no message either.
            syncTextRecord({ msgid: 'sync-5', origin: 4 }),
          ],
          next_cursor: 'cursor-8',
          has_more: 0,
        }),
      ),
    );
    const { adapter } = buildAdapter({ http });

    const page = await adapter.pullSyncMessages({ ...PULL_INPUT });
    expect(page.ok).toBe(true);
    if (!page.ok) {
      return;
    }
    expect(page.value.messages.map((message) => message.externalEventId)).toEqual([
      'sync-1',
      'sync-2',
      'sync-3',
    ]);
    expect(page.value.messages.map((message) => message.messageType)).toEqual([
      'text',
      'image',
      'link',
    ]);
    expect(page.value.messages[0]).toMatchObject({
      tenantId: SCOPE.tenantId,
      storeId: SCOPE.storeId,
      externalConversationId: `${TEST_OPEN_KF_ID}:wm-customer-1`,
      direction: 'inbound',
      content: '请问什么时候发货？',
      dedupKey: 'wecom:sync-1',
      receivedAt: '2026-02-02T02:40:00.000Z',
    });
    expect(page.value.messages[1]?.media).toEqual({
      mediaId: 'MEDIA-9',
      mimeType: 'application/octet-stream',
    });
    expect(page.value.messages[2]?.content).toBe('发货说明');
    expect(page.value.nextCursor).toBe('cursor-8');
    expect(page.value.hasMore).toBe(false);
  });

  it('reports has_more, normalises a record type it does not map, and refuses one with no identity', async () => {
    const more = new FakeWecomHttp(routed(() => syncPage({ msg_list: [], has_more: 1 })));
    await expect(
      buildAdapter({ http: more }).adapter.pullSyncMessages({ ...PULL_INPUT }),
    ).resolves.toMatchObject({ ok: true, value: { hasMore: true } });

    // A voice record used to refuse the whole page, which also kept the cursor
    // from advancing past it — the pull would meet the same note on every sweep
    // and never reach the messages behind it. It is now a placeholder message.
    const voice = new FakeWecomHttp(
      routed(() => syncPage({ msg_list: [syncTextRecord({ msgtype: 'voice', text: undefined })] })),
    );
    const page = await buildAdapter({ http: voice }).adapter.pullSyncMessages({ ...PULL_INPUT });
    expect(page.ok).toBe(true);
    if (!page.ok) {
      return;
    }
    expect(page.value.messages).toHaveLength(1);
    expect(page.value.messages[0]).toMatchObject({ messageType: 'text', content: '[语音消息]' });

    // A record with no type at all is a different case from one with a type this
    // transport does not map: it cannot be read, so it is reported rather than
    // turned into a placeholder message nobody can act on.
    const untyped = new FakeWecomHttp(
      routed(() => syncPage({ msg_list: [syncTextRecord({ msgtype: undefined })] })),
    );
    await expect(
      buildAdapter({ http: untyped }).adapter.pullSyncMessages({ ...PULL_INPUT }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'channel_invalid_request',
      message: 'a customer kf/sync_msg record carries no msgtype',
    });

    const anonymous = new FakeWecomHttp(
      routed(() => syncPage({ msg_list: [syncTextRecord({ external_userid: '' })] })),
    );
    await expect(
      buildAdapter({ http: anonymous }).adapter.pullSyncMessages({ ...PULL_INPUT }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'a customer kf/sync_msg record carries no msgid or external_userid',
    });
  });

  it('maps a rejected and an unreachable sync endpoint onto stable failures', async () => {
    const rejected = new FakeWecomHttp(
      routed(() => ({ status: 200, body: { errcode: 95001, errmsg: 'token expired' } })),
    );
    await expect(
      buildAdapter({ http: rejected }).adapter.pullSyncMessages({ ...PULL_INPUT }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'channel_provider_error',
      // The provider's own `errmsg` is not carried: the failure a caller sees is
      // the platform's sentence about the platform's classification.
      message: 'the WeCom sync endpoint rejected the kf/sync_msg request (errcode 95001)',
      retryable: false,
    });

    const credential = new FakeWecomHttp(
      routed(() => ({ status: 200, body: { errcode: 40001, errmsg: 'invalid credential' } })),
    );
    await expect(
      buildAdapter({ http: credential }).adapter.pullSyncMessages({ ...PULL_INPUT }),
    ).resolves.toMatchObject({ ok: false, code: 'channel_not_configured', retryable: false });

    const down = new FakeWecomHttp(routed(() => ({ status: 502, body: 'bad gateway' })));
    await expect(
      buildAdapter({ http: down }).adapter.pullSyncMessages({ ...PULL_INPUT }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom sync endpoint answered with HTTP 502',
      retryable: true,
    });

    const unreachable = buildAdapter({
      http: new FakeWecomHttp((request) => {
        if (request.url.includes('/cgi-bin/gettoken')) {
          return TOKEN_ANSWER;
        }
        throw new Error('socket hang up');
      }),
    });
    await expect(unreachable.adapter.pullSyncMessages({ ...PULL_INPUT })).resolves.toMatchObject({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom sync endpoint could not be reached',
      retryable: true,
    });
  });

  it('accepts an empty page that still says where the position moved to', async () => {
    const http = new FakeWecomHttp(routed(() => syncPage({ msg_list: [] })));
    const { adapter } = buildAdapter({ http });

    // A provider with nothing to hand over still reports the position it
    // stopped at, so the pull has somewhere to resume from.
    await expect(adapter.pullSyncMessages({ ...PULL_INPUT })).resolves.toEqual({
      ok: true,
      value: { messages: [], nextCursor: 'cursor-1', hasMore: false },
    });
  });

  it('refuses a page that carries no position instead of advancing the cursor nowhere', async () => {
    // Neither a cursor nor a list: accepting it would move the stored position
    // to "nothing", so the next notification would re-pull this same window
    // forever while every page claimed to have made progress.
    const missing = new FakeWecomHttp(
      routed(() => syncPage({ msg_list: [], next_cursor: undefined })),
    );
    await expect(
      buildAdapter({ http: missing }).adapter.pullSyncMessages({ ...PULL_INPUT }),
    ).resolves.toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom sync endpoint answered without advancing the kf/sync_msg cursor',
      retryable: false,
    });

    // A blank one is the same statement written differently.
    for (const blank of ['', '   ']) {
      const empty = new FakeWecomHttp(routed(() => syncPage({ msg_list: [], next_cursor: blank })));
      await expect(
        buildAdapter({ http: empty }).adapter.pullSyncMessages({ ...PULL_INPUT }),
      ).resolves.toMatchObject({ ok: false, code: 'channel_provider_error' });
    }
  });

  it('refuses a page that reports more to fetch without moving the position', async () => {
    // `has_more = 1` while the position stays where the pull already was: the
    // loop would consume its whole page bound re-reading one window, and the
    // caller would be told there is more to fetch from a position it never left.
    const stuck = new FakeWecomHttp(
      routed(() =>
        syncPage({ msg_list: [syncTextRecord()], next_cursor: 'cursor-7', has_more: 1 }),
      ),
    );
    await expect(
      buildAdapter({ http: stuck }).adapter.pullSyncMessages({ ...PULL_INPUT, cursor: 'cursor-7' }),
    ).resolves.toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom sync endpoint answered without advancing the kf/sync_msg cursor',
      retryable: false,
    });

    // The same answer from a *different* position is real progress and accepted.
    await expect(
      buildAdapter({ http: stuck }).adapter.pullSyncMessages({ ...PULL_INPUT, cursor: 'cursor-6' }),
    ).resolves.toMatchObject({ ok: true, value: { nextCursor: 'cursor-7', hasMore: true } });
  });

  it('replays exactly once after the sync endpoint rejects the cached token', async () => {
    let calls = 0;
    const http = new FakeWecomHttp((request) => {
      if (request.url.includes('/cgi-bin/gettoken')) {
        return TOKEN_ANSWER;
      }
      calls += 1;
      return calls === 1
        ? { status: 200, body: { errcode: 42001, errmsg: 'access token expired' } }
        : syncPage({ msg_list: [] });
    });
    const { adapter } = buildAdapter({ http });

    await expect(adapter.pullSyncMessages({ ...PULL_INPUT })).resolves.toMatchObject({ ok: true });
    expect(http.matching('/cgi-bin/kf/sync_msg')).toHaveLength(2);
    // The replay is only meaningful because the rejected token was dropped
    // first, so the second attempt must have acquired a fresh one.
    expect(http.matching('/cgi-bin/gettoken')).toHaveLength(2);
  });

  it('gives up after the sync replay instead of looping', async () => {
    const http = new FakeWecomHttp((request) =>
      request.url.includes('/cgi-bin/gettoken')
        ? TOKEN_ANSWER
        : { status: 200, body: { errcode: 41001, errmsg: 'missing access token' } },
    );
    const { adapter } = buildAdapter({ http });

    await expect(adapter.pullSyncMessages({ ...PULL_INPUT })).resolves.toEqual({
      ok: false,
      code: 'channel_not_configured',
      message: 'WeCom rejected the customer-service credential (errcode 41001)',
      retryable: false,
    });
    expect(http.matching('/cgi-bin/kf/sync_msg')).toHaveLength(2);
    expect(http.matching('/cgi-bin/gettoken')).toHaveLength(2);
  });

  it('keeps the provider text, the tokens and the raw records out of every refusal', async () => {
    // Hostile synthetic text, shaped like the worst a provider could return: a
    // credential in a field the platform reads, markup, and an `errmsg` that
    // names the very token the caller must never see.
    const hostile = 'ACCESS_TOKEN=test-access-token <script>alert(1)</script> notification-token-1';
    const http = new FakeWecomHttp(
      routed(() => ({ status: 200, body: { errcode: 95001, errmsg: hostile } })),
    );

    const refusal = await buildAdapter({ http }).adapter.pullSyncMessages({ ...PULL_INPUT });
    expect(refusal).toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom sync endpoint rejected the kf/sync_msg request (errcode 95001)',
      retryable: false,
    });
    const serialized = JSON.stringify(refusal);
    for (const secret of [hostile, 'test-access-token', 'notification-token-1', 'alert(1)']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('RealWecomAdapter sending', () => {
  beforeEach(() => {
    resetWecomConnectionState();
  });

  afterEach(() => {
    resetWecomConnectionState();
  });

  it('sends a text message through kf/send_msg with the access token', async () => {
    const http = new FakeWecomHttp(routed(() => SEND_OK));
    const { adapter } = buildAdapter({ http });

    expect(await adapter.sendMessage(sendInput())).toEqual({
      ok: true,
      value: { externalMessageId: 'msg-1' },
    });

    const sent = http.matching('/cgi-bin/kf/send_msg');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toContain('access_token=test-access-token');
    expect(sent[0]?.body).toEqual({
      touser: 'wm-customer-1',
      open_kfid: TEST_OPEN_KF_ID,
      msgtype: 'text',
      text: { content: '您好，今天发货' },
    });
  });

  it('takes the account id from the conversation when it names one', async () => {
    const http = new FakeWecomHttp(routed(() => SEND_OK));
    const { adapter } = buildAdapter({ http });

    await adapter.sendMessage(sendInput({ externalConversationId: 'wkOTHER0009:wm-customer-1' }));

    expect(http.matching('/cgi-bin/kf/send_msg')[0]?.body).toMatchObject({
      open_kfid: 'wkOTHER0009',
    });
  });

  it('sends a link, and an image only when it has a media id', async () => {
    const http = new FakeWecomHttp(routed(() => SEND_OK));
    const { adapter } = buildAdapter({ http });

    await adapter.sendMessage(
      sendInput({ messageType: 'link', content: 'https://example.invalid/a' }),
    );
    await adapter.sendMessage(
      sendInput({
        messageType: 'image',
        content: '',
        media: { mediaId: 'MEDIA-1', mimeType: 'image/png' },
      }),
    );

    const sent = http.matching('/cgi-bin/kf/send_msg');
    expect(sent[0]?.body).toMatchObject({
      msgtype: 'link',
      link: { title: 'https://example.invalid/a', url: 'https://example.invalid/a' },
    });
    expect(sent[1]?.body).toMatchObject({ msgtype: 'image', image: { media_id: 'MEDIA-1' } });
  });

  it('refuses an image with no media id without calling the provider', async () => {
    const http = new FakeWecomHttp(routed(() => SEND_OK));
    const { adapter } = buildAdapter({ http });

    expect(await adapter.sendMessage(sendInput({ messageType: 'image', content: '' }))).toEqual({
      ok: false,
      code: 'channel_invalid_request',
      message: 'a WeCom image delivery requires an uploaded media id',
      retryable: false,
    });
    expect(http.requests).toHaveLength(0);
  });

  it('treats the provider reply limit as final instead of retrying it', async () => {
    const http = new FakeWecomHttp(
      routed(() => ({ status: 200, body: { errcode: 95002, errmsg: 'reply limit reached' } })),
    );
    const { adapter } = buildAdapter({ http });

    expect(await adapter.sendMessage(sendInput())).toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the customer-service reply limit for this window was reached (95002)',
      retryable: false,
    });
    // The provider applies the same budget the platform gates on, so a second
    // attempt would be refused identically. Exactly one call may be made.
    expect(http.matching('/cgi-bin/kf/send_msg')).toHaveLength(1);
  });

  it('replays exactly once after the provider rejects the cached token', async () => {
    let calls = 0;
    const http = new FakeWecomHttp((request) => {
      if (request.url.includes('/cgi-bin/gettoken')) {
        return TOKEN_ANSWER;
      }
      calls += 1;
      return calls === 1
        ? { status: 200, body: { errcode: 40014, errmsg: 'invalid access token' } }
        : SEND_OK;
    });
    const { adapter } = buildAdapter({ http });

    expect(await adapter.sendMessage(sendInput())).toEqual({
      ok: true,
      value: { externalMessageId: 'msg-1' },
    });
    expect(http.matching('/cgi-bin/kf/send_msg')).toHaveLength(2);
    // The retry is only meaningful because the rejected token was dropped
    // first, so the replay must have acquired a fresh one.
    expect(http.matching('/cgi-bin/gettoken')).toHaveLength(2);
  });

  it('gives up after the replay instead of looping', async () => {
    const http = new FakeWecomHttp((request) =>
      request.url.includes('/cgi-bin/gettoken')
        ? TOKEN_ANSWER
        : { status: 200, body: { errcode: 40001, errmsg: 'invalid credential' } },
    );
    const { adapter } = buildAdapter({ http });

    expect(await adapter.sendMessage(sendInput())).toEqual({
      ok: false,
      code: 'channel_not_configured',
      message: 'WeCom rejected the customer-service credential (errcode 40001)',
      retryable: false,
    });
    expect(http.matching('/cgi-bin/kf/send_msg')).toHaveLength(2);
    expect(http.matching('/cgi-bin/gettoken')).toHaveLength(2);
  });

  it('maps any other provider refusal onto a platform-authored message', async () => {
    const http = new FakeWecomHttp(
      routed(() => ({ status: 200, body: { errcode: 40003, errmsg: 'invalid touser' } })),
    );

    // The numeric code stays, because it is a protocol value a caller may
    // classify on; the provider's sentence does not, because it is unbounded
    // text the platform would then be repeating as its own.
    const refusal = await buildAdapter({ http }).adapter.sendMessage(sendInput());
    expect(refusal).toEqual({
      ok: false,
      code: 'channel_invalid_request',
      message: 'the WeCom send endpoint rejected the message (errcode 40003)',
      retryable: false,
    });
    expect(JSON.stringify(refusal)).not.toContain('invalid touser');
  });

  it('reports an accepted message with no id as an unknown delivery', async () => {
    const http = new FakeWecomHttp(routed(() => ({ status: 200, body: { errcode: 0 } })));

    expect(await buildAdapter({ http }).adapter.sendMessage(sendInput())).toMatchObject({
      ok: false,
      code: 'channel_delivery_unknown',
      deliveryUnknown: true,
    });
  });

  it('falls back to the HTTP status when the answer is not a WeCom error document', async () => {
    const http = new FakeWecomHttp(routed(() => ({ status: 502, body: 'bad gateway' })));

    expect(await buildAdapter({ http }).adapter.sendMessage(sendInput())).toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom send endpoint answered with HTTP 502',
      retryable: true,
    });
  });

  it('maps an unreachable provider onto a retryable failure instead of throwing', async () => {
    // The token endpoint answers, so the failure is the send itself.
    const http = new FakeWecomHttp((request) => {
      if (request.url.includes('/cgi-bin/gettoken')) {
        return TOKEN_ANSWER;
      }
      throw new Error('socket hang up');
    });

    expect(await buildAdapter({ http }).adapter.sendMessage(sendInput())).toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom send endpoint could not be reached',
      retryable: true,
    });
  });
});

describe('RealWecomAdapter media upload', () => {
  beforeEach(() => {
    resetWecomConnectionState();
  });

  afterEach(() => {
    resetWecomConnectionState();
  });

  /** One small, obviously synthetic PNG payload. */
  const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

  /** The upload request the adapter put on the shared HTTP port. */
  function uploadOf(http: FakeWecomHttp): WecomHttpRequest | undefined {
    return http.matching('/cgi-bin/media/upload')[0];
  }

  it('uploads a file under the type and the name the caller carried', async () => {
    const http = new FakeWecomHttp((request) =>
      request.url.includes('/cgi-bin/media/upload')
        ? { status: 200, body: { errcode: 0, errmsg: 'ok', media_id: 'MEDIA-FILE-1' } }
        : TOKEN_ANSWER,
    );
    const { adapter } = buildAdapter({ http });

    const result = await adapter.uploadMedia({
      tenantId: SCOPE.tenantId,
      storeId: SCOPE.storeId,
      kind: 'file',
      mimeType: 'application/pdf',
      bytes: IMAGE,
      fileName: '报价单.pdf',
    });

    expect(result).toEqual({ ok: true, value: { mediaId: 'MEDIA-FILE-1' } });
    const upload = uploadOf(http);
    // The kind is what the provider measures the payload against, and the part
    // header is the only place the name the customer will see can travel.
    expect(upload?.url).toContain('type=file');
    expect(upload?.multipart).toMatchObject({
      filename: '报价单.pdf',
      contentType: 'application/pdf',
    });
  });

  it('uploads the image through the shared port and returns the provider media id', async () => {
    const http = new FakeWecomHttp((request) =>
      request.url.includes('/cgi-bin/media/upload')
        ? { status: 200, body: { errcode: 0, errmsg: 'ok', media_id: 'MEDIA-OK-1' } }
        : TOKEN_ANSWER,
    );
    const { adapter } = buildAdapter({ http });

    const result = await adapter.uploadMedia({
      tenantId: SCOPE.tenantId,
      storeId: SCOPE.storeId,
      kind: 'image',
      mimeType: 'image/png',
      bytes: IMAGE,
    });

    expect(result).toEqual({ ok: true, value: { mediaId: 'MEDIA-OK-1' } });
    const upload = uploadOf(http);
    expect(upload?.method).toBe('POST');
    // Official temporary-media endpoint, `type=image`, and the token the shared
    // provider fetched — not a second credential path of the adapter's own.
    expect(upload?.url).toBe(
      'https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=test-access-token&type=image',
    );
    expect(upload?.multipart).toEqual({
      field: 'media',
      filename: 'wecom-image.png',
      contentType: 'image/png',
      bytes: IMAGE,
    });
    expect(http.matching('/cgi-bin/gettoken')).toHaveLength(1);
    // The bytes travel in the multipart part only: nothing re-serializes them
    // into a JSON body as well.
    expect(upload?.body).toBeUndefined();
  });

  it('maps a rejected upload onto a stable failure, without provider text or the token', async () => {
    const http = new FakeWecomHttp((request) =>
      request.url.includes('/cgi-bin/media/upload')
        ? {
            status: 200,
            body: { errcode: 40006, errmsg: 'provider text that must not be surfaced' },
          }
        : TOKEN_ANSWER,
    );
    const { adapter } = buildAdapter({ http });

    const refused = await adapter.uploadMedia({
      tenantId: SCOPE.tenantId,
      storeId: SCOPE.storeId,
      kind: 'image',
      mimeType: 'image/png',
      bytes: IMAGE,
    });

    expect(refused).toMatchObject({
      ok: false,
      code: 'channel_invalid_request',
      retryable: false,
    });
    const serialized = JSON.stringify(refused);
    expect(serialized).not.toContain('provider text');
    expect(serialized).not.toContain('test-access-token');
    expect(serialized).not.toContain('89,80,78');
  });

  it('refuses a payload that is not a bounded image before any provider call', async () => {
    const http = new FakeWecomHttp(routed(() => SEND_OK));
    const { adapter } = buildAdapter({ http });

    for (const input of [
      { kind: 'image', mimeType: 'application/pdf', bytes: IMAGE },
      { kind: 'image', mimeType: 'image/png', bytes: new Uint8Array(0) },
    ] as const) {
      await expect(
        adapter.uploadMedia({
          tenantId: SCOPE.tenantId,
          storeId: SCOPE.storeId,
          ...input,
        }),
      ).resolves.toMatchObject({ ok: false, code: 'channel_invalid_request', retryable: false });
    }
    expect(http.requests).toHaveLength(0);
  });

  it('completes an image delivery: upload first, then send the returned media id', async () => {
    const http = new FakeWecomHttp((request) =>
      request.url.includes('/cgi-bin/media/upload')
        ? { status: 200, body: { errcode: 0, errmsg: 'ok', media_id: 'MEDIA-OK-1' } }
        : request.url.includes('/cgi-bin/gettoken')
          ? TOKEN_ANSWER
          : SEND_OK,
    );
    const { adapter } = buildAdapter({ http });

    const uploaded = await adapter.uploadMedia({
      tenantId: SCOPE.tenantId,
      storeId: SCOPE.storeId,
      kind: 'image',
      mimeType: 'image/png',
      bytes: IMAGE,
    });
    expect(uploaded.ok).toBe(true);
    const mediaId = uploaded.ok ? uploaded.value.mediaId : '';

    await adapter.sendMessage(
      sendInput({ messageType: 'image', content: '', media: { mediaId, mimeType: 'image/png' } }),
    );

    expect(http.matching('/cgi-bin/kf/send_msg')[0]?.body).toMatchObject({
      msgtype: 'image',
      image: { media_id: 'MEDIA-OK-1' },
    });
  });
});

describe('RealWecomAdapter configuration and unbound operations', () => {
  beforeEach(() => {
    resetWecomConnectionState();
  });

  afterEach(() => {
    resetWecomConnectionState();
  });

  it('refuses every operation without calling the provider when a credential is missing', async () => {
    const http = new FakeWecomHttp(routed(() => SEND_OK));
    const { adapter } = buildAdapter({ http, env: { WECOM_KF_SECRET: '' } });
    const callback = signedCallback(textMessage());

    const refused = {
      ok: false,
      code: 'channel_not_configured',
      message: 'the WeCom customer-service transport is not configured: WECOM_KF_SECRET',
      retryable: false,
    };
    await expect(
      adapter.verifyWebhook({
        channel: 'wecom',
        signature: callback.signature,
        timestamp: callback.timestamp,
        nonce: callback.nonce,
        rawBody: callback.body,
      }),
    ).resolves.toEqual(refused);
    await expect(adapter.parseInboundMessage({ rawBody: callback.body })).resolves.toEqual(refused);
    await expect(adapter.readNotification({ rawBody: callback.body })).resolves.toEqual(refused);
    await expect(adapter.pullSyncMessages({ ...PULL_INPUT })).resolves.toEqual(refused);
    await expect(adapter.sendMessage(sendInput())).resolves.toEqual(refused);
    expect(
      await adapter.verifyCallbackUrl({
        signature: 'anything',
        timestamp: CREATE_TIME,
        nonce: 'nonce-9',
        echostr: 'anything',
      }),
    ).toEqual(refused);
    await expect(adapter.probeConnection()).resolves.toBe(false);
    await expect(
      adapter.uploadMedia({
        tenantId: SCOPE.tenantId,
        storeId: SCOPE.storeId,
        kind: 'image',
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toEqual(refused);
    expect(http.requests).toHaveLength(0);
  });

  it('never lets the self-built application secret satisfy the customer-service one', async () => {
    const http = new FakeWecomHttp(routed(() => SEND_OK));
    const { adapter } = buildAdapter({
      http,
      env: {
        WECOM_KF_SECRET: '',
        WECOM_AGENT_ID: '1000002',
        WECOM_SECRET: TEST_KF_SECRET,
      },
    });

    await expect(adapter.sendMessage(sendInput())).resolves.toMatchObject({
      ok: false,
      code: 'channel_not_configured',
      message: 'the WeCom customer-service transport is not configured: WECOM_KF_SECRET',
    });
    expect(http.requests).toHaveLength(0);
  });

  it('refuses the operations this slice deliberately leaves unwired', async () => {
    // Through the provider-neutral contract, so the refusal is the one every
    // caller of the channel port would see.
    const adapter: ChannelAdapter = buildAdapter({}).adapter;

    await expect(
      adapter.syncMessages({
        tenantId: SCOPE.tenantId,
        storeId: SCOPE.storeId,
        externalConversationId: `${TEST_OPEN_KF_ID}:wm-customer-1`,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'channel_not_configured' });
  });

  it('downloads a message image through the shared media downloader', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const http = new FakeWecomHttp(routed(() => SEND_OK));
    http.setDownloadHandler(() => ({
      kind: 'media',
      status: 200,
      contentType: 'image/png',
      bytes,
    }));
    const { adapter } = buildAdapter({ http });

    await expect(adapter.fetchMedia({ mediaId: 'MEDIA-1' })).resolves.toEqual({
      ok: true,
      value: { mimeType: 'image/png', bytes },
    });

    // The provider's own endpoint, addressed by the media id the callback
    // carried — this is the assertion that fails if the adapter ever answers a
    // fetch out of anything but a real download.
    const download = http.downloads[0];
    expect(download?.url).toContain('/cgi-bin/media/get');
    expect(download?.url).toContain('media_id=MEDIA-1');
  });

  it('probes the connection through the token provider', async () => {
    const http = new FakeWecomHttp(routed(() => SEND_OK));
    const { adapter } = buildAdapter({ http });

    await expect(adapter.probeConnection()).resolves.toBe(true);
    expect(http.matching('/cgi-bin/gettoken')).toHaveLength(1);

    // A separate adapter, because a successful probe is deliberately remembered
    // for a short window and would otherwise answer this second call.
    const unreachable = buildAdapter({
      http: new FakeWecomHttp(() => {
        throw new Error('socket hang up');
      }),
    });
    await expect(unreachable.adapter.probeConnection()).resolves.toBe(false);
  });

  it('claims only the capabilities it can honour, and is recognisable as the real transport', () => {
    const { adapter } = buildAdapter({});

    expect(adapter.channel).toBe('wecom');
    expect(adapter.capabilities).toEqual(REAL_WECOM_CAPABILITIES);
    // Image sending is claimed because both halves are bound here: the upload
    // above produces a `media_id`, and the shared send path sends one. Receiving
    // one is claimed for the same reason — the callback maps the media id and the
    // download above turns it into bytes — so the capability set no longer reads
    // as a promise the adapter could not keep.
    expect(adapter.capabilities.sendImage).toBe(true);
    expect(adapter.capabilities.receiveImage).toBe(true);
    expect(isWecomRealTransport(adapter)).toBe(true);
    expect(isWecomRealTransport({})).toBe(false);
    expect(isWecomRealTransport(null)).toBe(false);
  });
});
