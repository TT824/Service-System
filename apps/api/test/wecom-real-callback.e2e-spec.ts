import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_ADMIN_MEMBER_ID, type AppConfig, type Conversation } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';
import { WECOM_HTTP_CLIENT } from '@kefu/wecom';
import { WECOM_BINDING_REPOSITORY } from '../src/channels/wecom-binding.repository';
import { resetWecomConnectionState } from '../src/channels/wecom-transport';
import {
  FakeWecomHttp,
  SeededWecomBindings,
  TEST_CALLBACK_TOKEN,
  TEST_CORP_ID,
  TEST_ENCODING_AES_KEY,
  TEST_OPEN_KF_ID,
  encryptWecomMessage,
  realWecomConfig,
  wecomCallbackEnvelope,
  wecomCallbackSignature,
  wecomXml,
} from './wecom-callback-support';

/** The seeded member the channel status surface is read as. */
const MEMBER_ID = 'u-t1-admin';

/** The tenant and store both the binding and the platform directory know. */
const TENANT = 'tenant-acme';
const OTHER_TENANT = 'tenant-beta';
const STORE = 'store-acme-flagship';

/** A fake provider answer: `gettoken` succeeds, nothing else is expected. */
const http = new FakeWecomHttp((incoming) =>
  incoming.url.includes('/cgi-bin/gettoken')
    ? {
        status: 200,
        body: { errcode: 0, errmsg: 'ok', access_token: 'test-access-token', expires_in: 7200 },
      }
    : { status: 200, body: { errcode: 0, errmsg: 'ok' } },
);

/** One instant shared by every handshake and callback in this suite. */
const TIMESTAMP = '1770000000';
const NONCE = 'nonce-e2e-1';

/** The plaintext WeCom expects echoed back, and its ciphertext. */
const ECHO = 'echo-9876543210';
const ENCRYPTED_ECHO = encryptWecomMessage(TEST_ENCODING_AES_KEY, ECHO, TEST_CORP_ID);

/** Build the handshake query string, overriding any parameter. */
function handshake(overrides: Readonly<Record<string, string>> = {}): string {
  const params = new URLSearchParams({
    msg_signature: wecomCallbackSignature(TEST_CALLBACK_TOKEN, TIMESTAMP, NONCE, ENCRYPTED_ECHO),
    timestamp: TIMESTAMP,
    nonce: NONCE,
    echostr: ENCRYPTED_ECHO,
    ...overrides,
  });
  return `/api/v1/channels/wecom/callback?${params.toString()}`;
}

/** One encrypted, correctly signed customer-service callback. */
type SignedCallback = {
  /** The exact bytes a WeCom server would POST. */
  readonly body: string;
  /** The digest WeCom would put in the `msg_signature` query parameter. */
  readonly signature: string;
};

/**
 * Mint one encrypted, correctly signed customer-service callback.
 *
 * The envelope is built from the documented format by
 * `wecom-callback-support`, so a test states only the fields it cares about and
 * no fixture is copied between tests. Each field defaults to the bound account's
 * own values, which makes the override the whole point of the helper.
 *
 * @param fields - Elements to replace on the decrypted document.
 * @returns The ciphertext envelope and the digest covering it.
 */
function signedCallback(fields: Readonly<Record<string, string>> = {}): SignedCallback {
  const xml = wecomXml({
    ToUserName: 'gh_test',
    FromUserName: 'wm-customer-e2e',
    CreateTime: TIMESTAMP,
    MsgType: 'text',
    Content: '请问什么时候发货？',
    MsgId: '9001',
    OpenKfId: TEST_OPEN_KF_ID,
    ...fields,
  });
  const encrypted = encryptWecomMessage(TEST_ENCODING_AES_KEY, xml, TEST_CORP_ID);
  return {
    body: wecomCallbackEnvelope(encrypted),
    signature: wecomCallbackSignature(TEST_CALLBACK_TOKEN, TIMESTAMP, NONCE, encrypted),
  };
}

/** One callback the boundary suite posts, and the digest covering it. */
const CALLBACK = signedCallback();

/** POST one callback to the documented callback URL. */
function postCallback(
  app: INestApplication,
  callback: SignedCallback,
  signature = callback.signature,
): request.Test {
  // Callers assert `200`: WeCom reads only `200` as "received" and retries
  // anything else, so both callback routes answer it instead of the `201` Nest
  // would give a POST.
  return request(app.getHttpServer())
    .post(`/api/v1/channels/wecom/webhook?timestamp=${TIMESTAMP}&nonce=${NONCE}`)
    .query({ msg_signature: signature })
    .set('content-type', 'text/xml')
    .send(callback.body);
}

/**
 * Boot the real-mode application, optionally seeding the persistent bindings.
 *
 * No boot here overrides {@link WECOM_SCOPE_RESOLVER}: the module supplies its
 * own resolver, wired to whichever {@link WECOM_BINDING_REPOSITORY} is bound, so
 * a seeded boot exercises the production resolution path — the same
 * `findActiveBinding` read the `kf_msg_or_event` pull makes for the same
 * account.
 */
async function bootRealApp(
  config: AppConfig,
  bindings?: SeededWecomBindings,
): Promise<INestApplication> {
  resetWecomConnectionState();
  let builder = Test.createTestingModule({ imports: [AppModule.register(config)] })
    .overrideProvider(WECOM_HTTP_CLIENT)
    .useValue(http);
  if (bindings !== undefined) {
    builder = builder.overrideProvider(WECOM_BINDING_REPOSITORY).useValue(bindings);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  applyHttpDefaults(app, config);
  await app.init();
  attachJsonLogger(app);
  return app;
}

/**
 * The conversations of one tenant that mention a given external customer.
 *
 * Read as the platform administrator, because the point of most of these
 * assertions is that a callback wrote to the tenant its binding resolved and
 * *not* to another one — and a tenant administrator is refused when it reads a
 * tenant that is not its own, which would make the second half of that claim
 * unprovable. The platform administrator carries no tenant of its own, so the
 * requested tenant is the whole scope.
 */
async function conversationsFor(
  app: INestApplication,
  tenantId: string,
  externalCustomerId: string,
): Promise<ReadonlyArray<Conversation>> {
  const response = await request(app.getHttpServer())
    .get('/api/v1/conversations')
    .set('x-member-id', PLATFORM_ADMIN_MEMBER_ID)
    .set('x-tenant-id', tenantId)
    .expect(200);
  const conversations = (response.body as { data: ReadonlyArray<Conversation> }).data;
  return conversations.filter(
    (conversation) => conversation.externalCustomerId === externalCustomerId,
  );
}

/**
 * Interface tests for the WeChat Customer Service callback boundary.
 *
 * These boot the real Nest application with `WECOM_TRANSPORT=real`, so the
 * routes, the raw-body capture and the response shape are the ones a WeCom
 * server would meet. The outbound HTTP port is the fake client, so nothing here
 * reaches the network and no real credential or customer is involved.
 *
 * The suite is split by what a callback is allowed to be:
 *
 * 1. the boundary itself — handshake, raw-body digest, status surface, with the
 *    account deliberately unbound;
 * 2. the same route with a bound account, where a signed callback really
 *    ingests, replays idempotently and cannot be steered to another tenant;
 * 3. the same route under a production configuration, where the platform
 *    identity headers do not exist at all.
 *
 * Cases 2 and 3 are the ones a Mock boot cannot express: they are why a real
 * callback does not need — and cannot borrow — a platform credential.
 */
describe('WeCom customer-service callback boundary (interface)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootRealApp(realWecomConfig());
  });

  afterAll(async () => {
    await app.close();
    resetWecomConnectionState();
  });

  it('answers the callback URL handshake with the bare decrypted echostr', async () => {
    const response = await request(app.getHttpServer()).get(handshake()).expect(200);

    // Byte-for-byte: WeCom compares this body to the echostr it sent, so a JSON
    // envelope, quotes or a trailing newline would fail the handshake.
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.text).toBe(ECHO);
  });

  it('rejects a handshake whose signature is wrong, missing or covering other bytes', async () => {
    const badSignature = handshake({ msg_signature: '0'.repeat(40) });
    const missingSignature = handshake({ msg_signature: '' });
    const otherBytes = handshake({
      echostr: encryptWecomMessage(TEST_ENCODING_AES_KEY, 'something-else', TEST_CORP_ID),
    });

    for (const url of [badSignature, missingSignature, otherBytes]) {
      const response = await request(app.getHttpServer()).get(url).expect(401);
      expect(response.body).toMatchObject({ code: 'unauthorized' });
      expect(response.text).not.toContain(ECHO);
    }
  });

  it('rejects a handshake with no echostr to decrypt', async () => {
    const response = await request(app.getHttpServer())
      .get(handshake({ echostr: '' }))
      .expect(401);

    expect(response.body).toMatchObject({ code: 'unauthorized' });
  });

  it('authenticates a posted callback over the raw request body it was signed with', async () => {
    // No platform credential is presented: a real callback has none, and the
    // route must still reach the provider's own verifier.
    const response = await postCallback(app, CALLBACK).expect(503);

    // The digest covers the exact bytes WeCom signed, which is why a mismatch is
    // answered with 401: reaching decryption and scope resolution at all proves
    // a body parser that re-serialized the XML — or a controller reading a
    // parsed body — was not in the path. The callback then stops at the account,
    // which has no seeded tenant/store binding here: the adapter refuses it with
    // the provider-neutral `channel_not_configured`, which this boundary answers
    // with that same stable code rather than as a caller mistake.
    expect(response.body).toMatchObject({ code: 'channel_not_configured' });
    expect(await conversationsFor(app, TENANT, 'wm-customer-e2e')).toEqual([]);
  });

  it('rejects a posted callback whose signature does not cover those bytes', async () => {
    const response = await postCallback(app, CALLBACK, '0'.repeat(40)).expect(401);

    expect(response.body).toMatchObject({ code: 'unauthorized' });
  });

  it('rejects a posted callback with no signature at all', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/channels/wecom/webhook?timestamp=${TIMESTAMP}&nonce=${NONCE}`)
      .set('content-type', 'text/xml')
      .send(CALLBACK.body)
      .expect(401);

    expect(response.body).toMatchObject({ code: 'unauthorized' });
  });

  it('reports a configured real channel, and claims a connection only after the probe', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/channels')
      .set('x-member-id', MEMBER_ID)
      .expect(200);

    const payload = (response.body as { data: Record<string, unknown> }).data;
    const wecom = (payload['providers'] as Array<Record<string, unknown>>)[0];
    expect(wecom).toMatchObject({
      provider: 'wecom',
      mode: 'real',
      credentialsPresent: true,
      // Nothing was stored in this deployment, so the set that is complete is
      // the environment's — which is the answer a console editing credentials
      // has to be able to see, and the reason the field is on the wire at all.
      credentialSource: 'environment',
      // Verified callbacks and tenant binding are wired, but this build claims an
      // operational loop only for the Mock; a live end-to-end round trip is not
      // proven here.
      operational: false,
      // The probe above reached the fake token endpoint, which is the only
      // thing that may turn this on.
      realTransportConnected: true,
      missingCredentials: [],
    });
    expect(wecom?.['callbackVerifyPath']).toBe('/api/v1/channels/wecom/callback');
    // The key, not just its value: the console renders a stored verdict and a
    // missing one differently, so a payload that simply omitted the field would
    // leave that panel reading `undefined` while every unit test stayed green.
    expect(payload).toHaveProperty('credentialVerdict', null);
  });

  it('still resolves an identity on every other channel route', async () => {
    // Only the callback route is public. Every other channel route still goes
    // through the identity path, so an identity the platform does not know is
    // refused rather than silently answered as some default.
    await request(app.getHttpServer())
      .get('/api/v1/channels')
      .set('x-member-id', 'u-not-a-member')
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/sync')
      .set('x-member-id', 'u-not-a-member')
      .set('x-mock-signature', 'mock-signature')
      .expect(401);
    // The status callback is *not* public: it still requires an identity.
    await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/status')
      .set('x-member-id', 'u-not-a-member')
      .send({ eventId: 'event-1', deliveryId: 'delivery-1', status: 'sent' })
      .expect(401);
  });

  it('never exposes a credential through the channel status surface', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/channels')
      .set('x-member-id', MEMBER_ID)
      .expect(200);

    const serialized = JSON.stringify(response.body);
    for (const secret of [TEST_ENCODING_AES_KEY, TEST_CALLBACK_TOKEN, 'test-access-token']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

/**
 * A customer-service account bound to a platform tenant.
 *
 * Which tenant an `open_kfid` belongs to is a platform decision, and a console
 * makes it through `POST /channels/wecom/bindings` — which the last suite in
 * this file walks end to end. These seeded rows stand for the bindings a
 * deployment already holds, so the delivery loop can be asked the three
 * questions it has to separate without a route in the way: an account bound to a
 * tenant and store the platform knows, a binding that names a store the platform
 * does not have, and an account no binding resolves at all.
 */
const UNKNOWN_STORE_KF_ID = 'wkE2EUNKNOWNSTORE';
const UNKNOWN_TENANT_KF_ID = 'wkE2EUNKNOWNTENANT';
const UNBOUND_KF_ID = 'wkE2EUNBOUND';

/** The active bindings this suite's deployment holds. */
const BOUND_BINDINGS = new SeededWecomBindings([
  {
    id: 'binding-e2e-ok',
    tenantId: TENANT,
    storeId: STORE,
    corpId: TEST_CORP_ID,
    openKfId: TEST_OPEN_KF_ID,
  },
  {
    id: 'binding-e2e-ghost-store',
    tenantId: TENANT,
    storeId: 'store-ghost',
    corpId: TEST_CORP_ID,
    openKfId: UNKNOWN_STORE_KF_ID,
  },
  {
    id: 'binding-e2e-ghost-tenant',
    tenantId: 'tenant-ghost',
    storeId: STORE,
    corpId: TEST_CORP_ID,
    openKfId: UNKNOWN_TENANT_KF_ID,
  },
]);

describe('WeCom customer-service callback with a bound scope (interface)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootRealApp(realWecomConfig(), BOUND_BINDINGS);
  });

  afterAll(async () => {
    await app.close();
    resetWecomConnectionState();
  });

  it('ingests a signed callback that carries no platform credential at all', async () => {
    const callback = signedCallback({
      FromUserName: 'wm-customer-bound',
      MsgId: '910001',
      Content: '订单还没发货吗？',
    });

    const response = await postCallback(app, callback).expect(200);
    const ingested = (response.body as { data: Record<string, unknown> }).data;

    expect(ingested).toMatchObject({
      status: 'processed',
      created: true,
      eventId: '910001',
      messageType: 'text',
    });
    // The callback named no tenant. The tenant it wrote to is the one the
    // `open_kfid` binding resolved, and it landed there — not anywhere the
    // request could have asked for.
    expect(await conversationsFor(app, TENANT, 'wm-customer-bound')).toHaveLength(1);
    expect(await conversationsFor(app, OTHER_TENANT, 'wm-customer-bound')).toEqual([]);
  });

  it('ingests a voice note as a readable placeholder, and answers with no error', async () => {
    // §块 3, route (b). A voice note has no unified message type and the column's
    // CHECK is not extended, so the platform stores it as *text* whose content is
    // `[语音消息]` — the kind is named by the body. What this test holds is the
    // whole path rather than the mapper's return value: the callback is answered
    // (a rejected one would be a 4xx and the customer's message would be gone),
    // and the row an agent will read says what arrived.
    const callback = signedCallback({
      FromUserName: 'wm-customer-voice',
      MsgId: '910004',
      MsgType: 'voice',
      MediaId: 'MEDIA-VOICE-1',
      // A voice callback carries no `<Content>`; the fixture states that.
      Content: '',
    });

    const response = await postCallback(app, callback).expect(200);
    const ingested = (response.body as { data: Record<string, unknown> }).data;
    expect(ingested).toMatchObject({
      status: 'processed',
      created: true,
      eventId: '910004',
      messageType: 'text',
    });

    const conversation = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${String(ingested['conversationId'])}`)
      .set('x-member-id', MEMBER_ID)
      .expect(200);
    const detail = (conversation.body as { data: { messages: ReadonlyArray<unknown> } }).data;
    expect(detail.messages).toHaveLength(1);
    // The media id is not stored beside it: this transport wires no download, so
    // a reference nothing could resolve would be a promise the platform cannot
    // keep. The placeholder is the whole record — 媒体管道 is a later slice.
    expect(detail.messages[0]).toMatchObject({
      direction: 'inbound',
      messageType: 'text',
      content: '[语音消息]',
    });
  });

  it('replays the same provider event without a second message', async () => {
    const callback = signedCallback({
      FromUserName: 'wm-customer-replay',
      MsgId: '910002',
    });

    const first = await postCallback(app, callback).expect(200);
    const firstData = (first.body as { data: Record<string, unknown> }).data;
    const replay = await postCallback(app, callback).expect(200);
    const replayData = (replay.body as { data: Record<string, unknown> }).data;

    expect(replayData).toMatchObject({
      status: 'duplicate',
      created: false,
      eventId: '910002',
      messageId: firstData['messageId'],
      conversationId: firstData['conversationId'],
    });

    const conversation = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${String(firstData['conversationId'])}`)
      .set('x-member-id', MEMBER_ID)
      .expect(200);
    const detail = (conversation.body as { data: { messages: ReadonlyArray<unknown> } }).data;
    expect(detail.messages).toHaveLength(1);
  });

  it('ignores platform identity headers, so a callback cannot name the tenant it writes to', async () => {
    const callback = signedCallback({
      FromUserName: 'wm-customer-spoof',
      MsgId: '910003',
    });

    // A request that tries to act as the other tenant's administrator: the
    // provider branch reads neither `x-member-id` nor `x-tenant-id`, so the
    // callback still lands in the tenant its `open_kfid` is bound to.
    const response = await request(app.getHttpServer())
      .post(`/api/v1/channels/wecom/webhook?timestamp=${TIMESTAMP}&nonce=${NONCE}`)
      .query({ msg_signature: callback.signature })
      .set('x-member-id', 'u-t2-admin')
      .set('x-tenant-id', OTHER_TENANT)
      .set('content-type', 'text/xml')
      .send(callback.body)
      .expect(200);

    expect((response.body as { data: Record<string, unknown> }).data).toMatchObject({
      status: 'processed',
      eventId: '910003',
    });
    expect(await conversationsFor(app, TENANT, 'wm-customer-spoof')).toHaveLength(1);
    expect(await conversationsFor(app, OTHER_TENANT, 'wm-customer-spoof')).toEqual([]);
  });

  it('refuses a binding that names a store or tenant the platform does not have, and writes nothing', async () => {
    for (const [openKfId, customerId] of [
      [UNKNOWN_STORE_KF_ID, 'wm-customer-ghost-store'],
      [UNKNOWN_TENANT_KF_ID, 'wm-customer-ghost-tenant'],
      [UNBOUND_KF_ID, 'wm-customer-unbound'],
    ] as const) {
      const callback = signedCallback({
        OpenKfId: openKfId,
        FromUserName: customerId,
        MsgId: `9101-${openKfId}`,
      });

      const response = await postCallback(app, callback).expect(503);
      // One code for all three: a binding the platform cannot resolve and an
      // account no binding resolves are both "this channel is not configured
      // here", and neither is a caller mistake.
      expect(response.body).toMatchObject({ code: 'channel_not_configured' });

      // No conversation, and therefore no message and no reply window: the
      // receipt is written only after the scope passed platform storage.
      expect(await conversationsFor(app, TENANT, customerId)).toEqual([]);
      expect(await conversationsFor(app, OTHER_TENANT, customerId)).toEqual([]);
    }
  });
});

/**
 * The production configuration.
 *
 * `APP_ENV=production` is what makes the demo identity headers unreachable, so
 * this is the only boot in the repository where "no platform credential" means
 * what it means in a deployment. Nothing here reaches PostgreSQL: every case
 * below is refused before the first business read.
 */
function productionConfig(): AppConfig {
  return realWecomConfig({
    APP_ENV: 'production',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://kefu:kefu@127.0.0.1:5432/kefu',
    REDIS_URL: 'redis://127.0.0.1:6379',
    CORS_ORIGINS: 'https://kefu.example',
    OBJECT_STORAGE_ENDPOINT: '127.0.0.1',
    OBJECT_STORAGE_PORT: '9000',
    OBJECT_STORAGE_USE_SSL: 'false',
    OBJECT_STORAGE_ACCESS_KEY: 'test-object-key',
    OBJECT_STORAGE_SECRET_KEY: 'test-object-secret',
    OBJECT_STORAGE_BUCKET: 'media',
    MEDIA_URL_SECRET: 'test-media-url-secret',
    EMBEDDING_BASE_URL: 'http://embedding.example.internal:11434',
    EMBEDDING_MODEL: 'qwen3-embedding:0.6b',
  });
}

describe('WeCom customer-service callback without a platform credential (production)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Seeded with no bindings at all, because the case this suite has to prove
    // in production is "no binding resolves this account" — a refusal the
    // adapter reaches before any durable read could matter. Production
    // configuration would otherwise bind the PostgreSQL store, which would make
    // this suite depend on a live database it never queries for anything else.
    // Only the store binding is replaced: the module's own resolver still
    // performs the production resolution path over it.
    app = await bootRealApp(productionConfig(), new SeededWecomBindings());
  });

  afterAll(async () => {
    await app.close();
    resetWecomConnectionState();
  });

  it('reaches the provider verifier with no bearer token at all', async () => {
    // The blocking case this suite exists for: a WeCom server presents no
    // session, so a 401 from the platform identity gate would make the
    // documented callback URL unusable in production. The 401 below comes from
    // the provider's own digest check instead.
    const unsigned = await request(app.getHttpServer())
      .post(`/api/v1/channels/wecom/webhook?timestamp=${TIMESTAMP}&nonce=${NONCE}`)
      .set('content-type', 'text/xml')
      .send(CALLBACK.body)
      .expect(401);
    expect(unsigned.body).toMatchObject({ code: 'unauthorized' });

    const forged = await postCallback(app, CALLBACK, '0'.repeat(40)).expect(401);
    expect(forged.body).toMatchObject({ code: 'unauthorized' });
  });

  it('refuses a platform identity presented on the provider callback', async () => {
    // Production refuses the demo headers outright, so the default platform
    // administrator can never be the identity a real callback acts through.
    const response = await request(app.getHttpServer())
      .post(`/api/v1/channels/wecom/webhook?timestamp=${TIMESTAMP}&nonce=${NONCE}`)
      .set('x-member-id', MEMBER_ID)
      .set('content-type', 'text/xml')
      .send(CALLBACK.body)
      .expect(403);

    expect(response.body).toMatchObject({ code: 'forbidden' });
  });

  it('refuses a correctly signed callback while the account is unbound, without inventing a tenant', async () => {
    const response = await postCallback(app, CALLBACK).expect(503);

    expect(response.body).toMatchObject({ code: 'channel_not_configured' });
  });

  it('still refuses an anonymous request on every other channel route', async () => {
    await request(app.getHttpServer()).get('/api/v1/channels').expect(401);
    await request(app.getHttpServer()).get('/api/v1/channels/deliveries/delivery-1').expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/channels/deliveries/delivery-1/retry')
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/status')
      .set('x-mock-signature', 'mock-signature')
      .send({ eventId: 'event-1', deliveryId: 'delivery-1', status: 'sent' })
      .expect(401);
  });
});

/**
 * A real transport that is bound but not fully configured.
 *
 * `channel_not_configured` is the one refusal *both* callback entry points can
 * produce — the `GET` handshake WeCom calls and the `POST` webhook it posts to —
 * and this is the only configuration in which both really refuse: with a
 * credential missing, the adapter blocks the operation before it ever looks at a
 * signature. Booting without `WECOM_KF_SECRET` is therefore what makes the two
 * routes comparable, and it is the state a fresh deployment is actually in.
 */
function incompleteCredentialConfig(): AppConfig {
  return realWecomConfig({ WECOM_KF_SECRET: '' });
}

describe('WeCom callback verification with an incomplete credential set (interface)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootRealApp(incompleteCredentialConfig());
  });

  afterAll(async () => {
    await app.close();
    resetWecomConnectionState();
  });

  it('answers the handshake and the webhook with one not-configured projection', async () => {
    const handshakeResponse = await request(app.getHttpServer()).get(handshake()).expect(503);
    const callback = signedCallback({
      FromUserName: 'wm-customer-unconfigured',
      MsgId: '920001',
    });
    const webhookResponse = await postCallback(app, callback).expect(503);

    // One projection, not two: the entry point a client used does not change the
    // status or the stable code, so "this channel is not configured" reads the
    // same on the handshake WeCom calls and on the callbacks it posts.
    expect(handshakeResponse.body).toMatchObject({ code: 'channel_not_configured' });
    expect(webhookResponse.body).toMatchObject({ code: 'channel_not_configured' });
    expect(await conversationsFor(app, TENANT, 'wm-customer-unconfigured')).toEqual([]);
  });
});

/**
 * The console path, end to end: bind an account, then receive its callback.
 *
 * This is the sequence a deployment is actually set up with, and it is the one
 * the seeded suite above cannot prove — there, the rows a real deployment would
 * have are handed to the application, because nothing could write one. Here
 * nothing is seeded: the application boots with the binding store it ships, an
 * operator binds an account through the channel route, and the very next signed
 * callback on that account is answered by the scope the binding named.
 */
describe('An account bound through the console and then called back (interface)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootRealApp(realWecomConfig());
  });

  afterAll(async () => {
    await app.close();
    resetWecomConnectionState();
  });

  it('resolves the scope an operator just bound, with no row written by hand', async () => {
    const unbound = signedCallback({ FromUserName: 'wm-customer-unbound', MsgId: '930001' });

    // Nothing is bound yet, so the account resolves no scope at all: the
    // callback is refused rather than written into some default tenant, which is
    // the state the binding route exists to change.
    const refused = await postCallback(app, unbound).expect(503);
    expect(refused.body).toMatchObject({ code: 'channel_not_configured' });
    expect(await conversationsFor(app, TENANT, 'wm-customer-unbound')).toEqual([]);

    const bound = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/bindings')
      .set('x-member-id', PLATFORM_ADMIN_MEMBER_ID)
      .set('x-tenant-id', TENANT)
      .send({ corp_id: TEST_CORP_ID, open_kfid: TEST_OPEN_KF_ID, store_id: STORE });
    expect(bound.status).toBe(201);
    expect((bound.body as { data: Record<string, unknown> }).data).toMatchObject({
      tenantId: TENANT,
      storeId: STORE,
      corpId: TEST_CORP_ID,
      openKfId: TEST_OPEN_KF_ID,
      status: 'active',
    });

    // The overview the console reads reports the row a callback resolves, so
    // what the page shows and what the platform does cannot be two accounts of
    // the same account.
    const overview = await request(app.getHttpServer())
      .get('/api/v1/channels')
      .set('x-member-id', PLATFORM_ADMIN_MEMBER_ID)
      .set('x-tenant-id', TENANT)
      .expect(200);
    const listed = (
      overview.body as { data: { bindings: ReadonlyArray<{ openKfId: string; storeId: string }> } }
    ).data.bindings;
    expect(listed).toContainEqual(
      expect.objectContaining({ openKfId: TEST_OPEN_KF_ID, storeId: STORE }),
    );

    const live = signedCallback({ FromUserName: 'wm-customer-bound-live', MsgId: '930002' });
    const response = await postCallback(app, live).expect(200);
    expect((response.body as { data: Record<string, unknown> }).data).toMatchObject({
      status: 'processed',
      created: true,
      eventId: '930002',
    });
    expect(await conversationsFor(app, TENANT, 'wm-customer-bound-live')).toHaveLength(1);
    expect(await conversationsFor(app, OTHER_TENANT, 'wm-customer-bound-live')).toEqual([]);
  });

  it('refuses a store outside the tenant the operator is acting for', async () => {
    const bound = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/bindings')
      .set('x-member-id', PLATFORM_ADMIN_MEMBER_ID)
      .set('x-tenant-id', TENANT)
      .send({
        corp_id: TEST_CORP_ID,
        open_kfid: 'wkE2EOUTSIDESCOPE',
        store_id: 'store-beta-official',
      });

    expect(bound.status).toBe(400);
    expect((bound.body as { code: string }).code).toBe('bad_request');
  });

  it('refuses a seat, and refuses an account that is already bound', async () => {
    const body = { corp_id: TEST_CORP_ID, open_kfid: TEST_OPEN_KF_ID, store_id: STORE };

    // A seat reaches the route and is refused before anything is written: which
    // scope a provider account writes into is not a seat's fact.
    const denied = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/bindings')
      .set('x-member-id', 'u-t1-agent-1')
      .set('x-tenant-id', TENANT)
      .send(body);
    expect(denied.status).toBe(403);
    expect((denied.body as { code: string }).code).toBe('forbidden');

    // The account the previous test bound still resolves, so a second binding of
    // it is refused rather than allowed to move where callbacks are written.
    const duplicate = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/bindings')
      .set('x-member-id', PLATFORM_ADMIN_MEMBER_ID)
      .set('x-tenant-id', TENANT)
      .send(body);
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { code: string }).code).toBe('conflict');

    expect(await conversationsFor(app, TENANT, 'wm-customer-bound-live')).toHaveLength(1);
  });
});

/**
 * What the console's 连接 button does over HTTP.
 *
 * The success case is the load-bearing one, and it is a single claim with three
 * parts that only hold together if the wire contract is exactly right: the five
 * body names are the ones this route reads (a renamed field is a `400` naming a
 * missing variable, not a silently empty one), the probe really ran and the
 * token endpoint really answered, and the set that is now in effect is the
 * console's rather than the environment's — which is observable as
 * `credentialSource: "console"` only because this boot also has a complete
 * environment set to lose to it.
 *
 * It runs last and in its own application, because it is the one case here that
 * *stores* a credential: the suites above assert on the environment-sourced
 * state a deployment has before an operator types anything.
 */
describe('WeCom console connection (interface)', () => {
  let app: INestApplication;

  /** The complete set an operator types, under the names the form sends. */
  const TYPED = {
    corp_id: TEST_CORP_ID,
    kf_secret: 'kf-secret-typed-into-the-console',
    callback_token: TEST_CALLBACK_TOKEN,
    aes_key: TEST_ENCODING_AES_KEY,
    open_kfid: TEST_OPEN_KF_ID,
  } as const;

  beforeAll(async () => {
    app = await bootRealApp(realWecomConfig());
  });

  afterAll(async () => {
    await app.close();
    resetWecomConnectionState();
  });

  function connect(body: Record<string, unknown>, memberId: string = PLATFORM_ADMIN_MEMBER_ID) {
    return request(app.getHttpServer())
      .put('/api/v1/channels/wecom/credentials')
      .set('x-member-id', memberId)
      .set('x-tenant-id', TENANT)
      .send(body);
  }

  it('connects the typed set, reports the verdict, and never returns a value', async () => {
    const response = await connect(TYPED).expect(200);
    const verdict = (response.body as { data: Record<string, unknown> }).data;

    expect(verdict).toMatchObject({
      connected: true,
      credentialSource: 'console',
      verifiedError: null,
    });
    expect(typeof verdict['bindingId']).toBe('string');
    // The answer reaches a browser and, on a failure, a log line. Every one of
    // the five values is a credential, and none of them may be in it.
    for (const secret of [TYPED.kf_secret, TYPED.callback_token, TYPED.aes_key]) {
      expect(secret.length).toBeGreaterThan(0);
      expect(JSON.stringify(response.body)).not.toContain(secret);
    }

    // The rest of the application now authenticates with what was typed: this
    // boot has a complete `WECOM_*` set too, so reading the console's is the
    // only thing that can move this field off `environment`.
    const status = await request(app.getHttpServer())
      .get('/api/v1/channels')
      .set('x-member-id', PLATFORM_ADMIN_MEMBER_ID)
      .set('x-tenant-id', TENANT)
      .expect(200);
    const payload = (status.body as { data: Record<string, unknown> }).data;
    expect((payload['providers'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      mode: 'real',
      credentialsPresent: true,
      credentialSource: 'console',
      realTransportConnected: true,
    });
    // And the page can read the same verdict after a reload, without a click.
    expect(payload['credentialVerdict']).toMatchObject({
      connected: true,
      credentialSource: 'console',
    });
    expect(JSON.stringify(status.body)).not.toContain(TYPED.kf_secret);
  });

  it('refuses an unusable set, and stores nothing', async () => {
    const refused = await connect({ ...TYPED, aes_key: 'too-short' });

    // The code, because that is all that survives the envelope: this platform's
    // filter answers with the HTTP reason phrase in `message`, so the console
    // reads `code` and words the refusal itself. The service's own sentence —
    // which names `WECOM_AES_KEY` — is asserted where it is produced, in
    // `wecom-connect.service.spec.ts`, and never reaches a browser through here.
    expect(refused.status).toBe(400);
    expect((refused.body as { code: string }).code).toBe('bad_request');

    // The connection the previous case made is still the one in effect, and the
    // refused values were not kept even in part.
    const status = await request(app.getHttpServer())
      .get('/api/v1/channels')
      .set('x-member-id', PLATFORM_ADMIN_MEMBER_ID)
      .set('x-tenant-id', TENANT)
      .expect(200);
    expect(
      ((status.body as { data: Record<string, unknown> }).data['providers'] as Array<
        Record<string, unknown>
      >)[0],
    ).toMatchObject({ credentialSource: 'console', credentialsPresent: true });
  });

  it('refuses an administrator who does not act for the whole deployment', async () => {
    // A stored credential is the deployment's identity, not a tenant's: a tenant
    // administrator reaches the route and is refused before anything is read.
    const denied = await connect(TYPED, MEMBER_ID);

    expect(denied.status).toBe(403);
    expect((denied.body as { code: string }).code).toBe('forbidden');
  });
});
