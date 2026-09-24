import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_ADMIN_MEMBER_ID, type AppConfig, type Conversation } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';
import { WECOM_BINDING_REPOSITORY } from '../src/channels/wecom-binding.repository';
import type { WecomActiveBinding } from '../src/channels/wecom-binding.repository';
import { WECOM_HTTP_CLIENT, type WecomHttpRequest, type WecomHttpResponse } from '@kefu/wecom';
import { resetWecomConnectionState } from '../src/channels/wecom-transport';
import {
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

/** The tenant and store the seeded binding resolves the account into. */
const TENANT = 'tenant-acme';
const OTHER_TENANT = 'tenant-beta';
const STORE = 'store-acme-flagship';

/** The seeded operator who may read the conversation list. */
const MEMBER_ID = 'u-t1-admin';

/** The account bound to no store, so a notification for it must be refused. */
const UNBOUND_KF_ID = 'wkE2EUNBOUNDSYNC';

/** One instant shared by every signature in this suite. */
const TIMESTAMP = '1770000000';
const NONCE = 'nonce-sync-1';

/** The pull credential the fake provider put in the notification. */
const NOTIFICATION_TOKEN = 'notification-token-e2e';

/** The access token the fake provider hands out. */
const ACCESS_TOKEN = 'test-access-token';

/** The account this suite's binding resolves. */
const BINDING_ID = 'binding-e2e-sync';

/** The one active binding this suite's deployment holds. */
const SEEDED_BINDING: WecomActiveBinding = {
  id: BINDING_ID,
  tenantId: TENANT,
  storeId: STORE,
  corpId: TEST_CORP_ID,
  openKfId: TEST_OPEN_KF_ID,
};

/** A fake provider: `gettoken`, `kf/sync_msg` and `kf/send_msg`, nothing else. */
class FakeSyncHttp {
  readonly syncBodies: Array<Record<string, unknown>> = [];
  /** The `kf/sync_msg` answers, consumed in order. */
  readonly answers: WecomHttpResponse[] = [];

  /** Queue one page answer. */
  answer(body: Record<string, unknown>): void {
    this.answers.push({ status: 200, body: { errcode: 0, errmsg: 'ok', ...body } });
  }

  /** Queue one refusal from the sync endpoint. */
  refuse(errcode: number, errmsg: string): void {
    this.answers.push({ status: 200, body: { errcode, errmsg } });
  }

  /** Drop every queued answer, so one test's pages cannot leak into the next. */
  reset(): void {
    this.answers.length = 0;
    this.syncBodies.length = 0;
  }

  async send(request: WecomHttpRequest): Promise<WecomHttpResponse> {
    if (request.url.includes('/cgi-bin/gettoken')) {
      return {
        status: 200,
        body: { errcode: 0, errmsg: 'ok', access_token: ACCESS_TOKEN, expires_in: 7200 },
      };
    }
    if (request.url.includes('/cgi-bin/kf/send_msg')) {
      return { status: 200, body: { errcode: 0, errmsg: 'ok', msgid: 'sent-1' } };
    }
    if (request.url.includes('/cgi-bin/kf/sync_msg')) {
      this.syncBodies.push(request.body as Record<string, unknown>);
      return (
        this.answers.shift() ?? {
          status: 200,
          body: {
            errcode: 0,
            errmsg: 'ok',
            msg_list: [],
            next_cursor: 'cursor-empty',
            has_more: 0,
          },
        }
      );
    }
    return { status: 200, body: { errcode: 0, errmsg: 'ok' } };
  }
}

/**
 * One provider `kf/sync_msg` record for a customer message.
 *
 * `send_time` defaults to now, so the reply window the record opens is open now
 * and the suite never expires with the calendar. It is also the instant the
 * platform records as the message's arrival, which is what makes a pulled record
 * indistinguishable from a pushed one once it is ingested.
 */
function syncRecord(
  messageId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    msgid: messageId,
    open_kfid: TEST_OPEN_KF_ID,
    external_userid: 'wm-customer-sync',
    send_time: Math.floor(Date.now() / 1000),
    origin: 3,
    msgtype: 'text',
    text: { content: '请问什么时候发货？' },
    ...overrides,
  };
}

/** One signed `kf_msg_or_event` notification, as WeCom would POST it. */
function notification(openKfId = TEST_OPEN_KF_ID): { body: string; signature: string } {
  const xml = wecomXml({
    ToUserName: 'gh_test',
    CreateTime: TIMESTAMP,
    MsgType: 'event',
    Event: 'kf_msg_or_event',
    Token: NOTIFICATION_TOKEN,
    OpenKfId: openKfId,
  });
  const encrypted = encryptWecomMessage(TEST_ENCODING_AES_KEY, xml, TEST_CORP_ID);
  return {
    body: wecomCallbackEnvelope(encrypted),
    signature: wecomCallbackSignature(TEST_CALLBACK_TOKEN, TIMESTAMP, NONCE, encrypted),
  };
}

/** One signed direct message callback, which must keep working unchanged. */
function directCallback(
  messageId: string,
  openKfId = TEST_OPEN_KF_ID,
): { body: string; signature: string } {
  const xml = wecomXml({
    ToUserName: 'gh_test',
    FromUserName: 'wm-customer-direct',
    CreateTime: TIMESTAMP,
    MsgType: 'text',
    Content: '直接推送的消息',
    MsgId: messageId,
    OpenKfId: openKfId,
  });
  const encrypted = encryptWecomMessage(TEST_ENCODING_AES_KEY, xml, TEST_CORP_ID);
  return {
    body: wecomCallbackEnvelope(encrypted),
    signature: wecomCallbackSignature(TEST_CALLBACK_TOKEN, TIMESTAMP, NONCE, encrypted),
  };
}

type DataEnvelope = { request_id: string; data: unknown; meta: Record<string, never> };

/** Read the payload of a successful response. */
function dataOf(body: unknown): Record<string, unknown> {
  return (body as DataEnvelope).data as Record<string, unknown>;
}

/**
 * Interface tests for the `kf/sync_msg` pull behind a WeCom notification.
 *
 * These boot the real Nest application with `WECOM_TRANSPORT=real`, so the route,
 * the raw-body digest and the response shape are the ones a WeCom server meets.
 * The outbound HTTP port is the fake client and the binding store is the seeded
 * in-process adapter, so nothing reaches the network, no real credential is
 * involved and no database is required — while the cursor semantics under test
 * are the shipped ones.
 *
 * What a Mock boot cannot express is the whole point: a callback that carries no
 * message at all, whose messages only exist behind a second provider call, and
 * whose platform scope comes from a durable binding rather than from the request.
 */
describe('WeCom kf/sync_msg notification pull (interface)', () => {
  let app: INestApplication;
  let http: FakeSyncHttp;
  let bindings: SeededWecomBindings;

  beforeAll(async () => {
    resetWecomConnectionState();
    const parsedConfig: AppConfig = realWecomConfig();
    http = new FakeSyncHttp();
    bindings = new SeededWecomBindings([SEEDED_BINDING]);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsedConfig)],
    })
      .overrideProvider(WECOM_HTTP_CLIENT)
      .useValue(http)
      // The one seam a deployment supplies: the persistent account binding.
      // `WECOM_SCOPE_RESOLVER` is deliberately *not* overridden, so the direct
      // callback path resolves its scope through the module's own provider —
      // the production value wired to this same binding store.
      .overrideProvider(WECOM_BINDING_REPOSITORY)
      .useValue(bindings)
      .compile();

    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsedConfig);
    await app.init();
    attachJsonLogger(app);
  });

  afterAll(async () => {
    await app.close();
    resetWecomConnectionState();
  });

  // The binding and its cursor are deliberately shared across the cases below —
  // a cursor that survives from one notification to the next is the fact under
  // test — so only the provider's queued answers are reset between them.
  beforeEach(() => {
    http.reset();
  });

  /** POST one signed callback to the documented callback URL. */
  function post(callback: { body: string; signature: string }): request.Test {
    return request(app.getHttpServer())
      .post(`/api/v1/channels/wecom/webhook?timestamp=${TIMESTAMP}&nonce=${NONCE}`)
      .query({ msg_signature: callback.signature })
      .set('content-type', 'text/xml')
      .send(callback.body);
  }

  /** The conversations of one tenant that mention a given external customer. */
  async function conversationsFor(
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

  /** The messages of one conversation, as the workspace would read them. */
  async function messagesOf(
    conversationId: string,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('x-member-id', MEMBER_ID)
      .expect(200);
    return (response.body as { data: { messages: ReadonlyArray<Record<string, unknown>> } }).data
      .messages;
  }

  it('pulls, ingests and stores the cursor for a notification that carries no message', async () => {
    http.answer({
      msg_list: [
        syncRecord('sync-e2e-1'),
        syncRecord('sync-e2e-2', {
          msgtype: 'image',
          text: undefined,
          image: { media_id: 'MEDIA-1' },
        }),
        syncRecord('sync-e2e-3', {
          msgtype: 'link',
          text: undefined,
          link: { title: '发货说明', url: 'https://example.invalid/a' },
        }),
      ],
      next_cursor: 'cursor-e2e-1',
      has_more: 0,
    });

    const response = await post(notification()).expect(201);

    expect(dataOf(response.body)).toEqual({
      status: 'synced',
      ingested: 3,
      pages: 1,
      hasMore: false,
    });
    // The pull used the notification's own credential and the shared access
    // token, and asked for no cursor because the account had never been pulled.
    expect(http.syncBodies).toEqual([
      {
        token: NOTIFICATION_TOKEN,
        limit: 100,
        voice_format: 0,
        open_kfid: TEST_OPEN_KF_ID,
      },
    ]);
    // The next notification resumes from the position this one reached.
    expect(bindings.cursor()).toBe('cursor-e2e-1');
    // And the claim was handed back, so it does not have to expire first.
    expect(bindings.releases).toHaveLength(1);

    const conversations = await conversationsFor(TENANT, 'wm-customer-sync');
    expect(conversations).toHaveLength(1);
    const messages = await messagesOf(conversations[0]?.id ?? '');
    expect(messages.map((message) => message['messageType'])).toEqual(['text', 'image', 'link']);
    expect(messages.map((message) => message['content'])).toEqual([
      '请问什么时候发货？',
      '[图片消息]',
      '发货说明',
    ]);
    // The binding resolved the tenant, and the request could not steer it: the
    // same customer is invisible in the other tenant.
    expect(await conversationsFor(OTHER_TENANT, 'wm-customer-sync')).toEqual([]);
  });

  it('opens a reply window through the ordinary ingestion path', async () => {
    http.answer({
      msg_list: [syncRecord('sync-e2e-window')],
      next_cursor: 'cursor-window',
      has_more: 0,
    });
    await post(notification()).expect(201);

    const conversations = await conversationsFor(TENANT, 'wm-customer-sync');
    const conversationId = conversations[0]?.id ?? '';
    // A reply is only allowed inside the window an inbound customer message
    // opens, so a sent delivery is the observable proof that the pulled message
    // opened one exactly like a pushed callback does.
    const reply = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('x-member-id', 'u-t1-agent-1')
      .send({ content: '您好，今天发货。', source: 'manual_typed' })
      .expect(201);

    const delivery = (reply.body as { data: { delivery: Record<string, unknown> } }).data.delivery;
    expect(delivery).toMatchObject({ status: 'sent', attemptCount: 1, failureCode: null });
  });

  it('resumes from the stored cursor and writes no second message for a repeated provider id', async () => {
    expect(bindings.cursor()).toBe('cursor-window');
    const conversations = await conversationsFor(TENANT, 'wm-customer-sync');
    const conversationId = conversations[0]?.id ?? '';
    const before = await messagesOf(conversationId);

    http.answer({
      msg_list: [syncRecord('sync-e2e-window')],
      next_cursor: 'cursor-window-2',
      has_more: 0,
    });
    const response = await post(notification()).expect(201);

    // The provider handed the same message back, which is what a retried or
    // replayed push looks like. It is ingested again — idempotently.
    expect(dataOf(response.body)).toMatchObject({ status: 'synced', ingested: 1 });
    expect(http.syncBodies.at(-1)).toMatchObject({ cursor: 'cursor-window' });
    expect(bindings.cursor()).toBe('cursor-window-2');

    const after = await messagesOf(conversationId);
    expect(after.map((message) => message['id'])).toEqual(before.map((message) => message['id']));
  });

  it('follows has_more but stops at its page bound instead of looping forever', async () => {
    for (let page = 0; page < 8; page += 1) {
      http.answer({
        msg_list: [syncRecord(`sync-e2e-page-${page}`)],
        next_cursor: `cursor-page-${page}`,
        has_more: 1,
      });
    }
    const before = http.syncBodies.length;

    const response = await post(notification()).expect(201);

    // Eight pages were offered; the bound is what ends the pull.
    expect(http.syncBodies.length - before).toBe(5);
    expect(dataOf(response.body)).toEqual({
      status: 'synced',
      ingested: 5,
      pages: 5,
      hasMore: true,
    });
    // The stored position is the end of the last durable page, so the next
    // notification resumes there rather than from the top.
    expect(bindings.cursor()).toBe('cursor-page-4');
  });

  it('refuses a provider failure without advancing the cursor or writing anything', async () => {
    const cursorBefore = bindings.cursor();
    http.refuse(95001, 'token expired');

    const response = await post(notification()).expect(502);

    expect(response.body).toMatchObject({ code: 'bad_gateway' });
    // Nothing was skipped and nothing was moved: a retry resumes from the same
    // position once the provider answers again.
    expect(bindings.cursor()).toBe(cursorBefore);
    expect(bindings.advances.at(-1)?.cursor).toBe(cursorBefore);
  });

  it('refuses an account no active binding resolves, before any provider call', async () => {
    const before = http.syncBodies.length;
    const claimsBefore = bindings.claims.length;

    const response = await post(notification(UNBOUND_KF_ID)).expect(503);

    expect(response.body).toMatchObject({ code: 'channel_not_configured' });
    // No provider call, no cursor claim and therefore no business write: the
    // refusal happens before the first thing that could leave a trace.
    expect(http.syncBodies).toHaveLength(before);
    expect(bindings.claims).toHaveLength(claimsBefore);
  });

  it('keeps the pull credential and the access token out of every response', async () => {
    http.answer({
      msg_list: [syncRecord('sync-e2e-secret')],
      next_cursor: 'cursor-secret',
      has_more: 0,
    });

    const pulled = await post(notification()).expect(201);
    const failed = await post(notification(UNBOUND_KF_ID)).expect(503);

    for (const body of [pulled.body, failed.body]) {
      const serialized = JSON.stringify(body);
      for (const secret of [NOTIFICATION_TOKEN, ACCESS_TOKEN, TEST_ENCODING_AES_KEY]) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it('still ingests a direct message callback that carries the message itself', async () => {
    const claimsBefore = bindings.claims.length;
    const response = await post(directCallback('910900')).expect(201);

    // The direct path is unchanged by the pull being wired: same route, same
    // ingestion result, same tenant resolved from the account binding.
    expect(dataOf(response.body)).toMatchObject({
      status: 'processed',
      created: true,
      eventId: '910900',
      messageType: 'text',
    });
    expect(await conversationsFor(TENANT, 'wm-customer-direct')).toHaveLength(1);
    expect(await conversationsFor(OTHER_TENANT, 'wm-customer-direct')).toEqual([]);
    // A direct callback is not a notification, so it never claims the cursor.
    expect(bindings.claims).toHaveLength(claimsBefore);
  });

  it('resolves a direct message callback through the persistent binding, not a test seam', async () => {
    // The scope resolver is the module's own provider — this boot overrides the
    // binding store alone — so the tenant below can only come from
    // `findActiveBinding`, the same read a `kf_msg_or_event` pull makes. Nothing
    // in this boot binds a scope by any other means.
    const response = await post(directCallback('910901')).expect(201);
    expect(dataOf(response.body)).toMatchObject({ status: 'processed', eventId: '910901' });
    expect(await conversationsFor(TENANT, 'wm-customer-direct')).toHaveLength(1);

    // And the resolution is the store's answer, not a guess: withdrawing the
    // binding is enough to make the very same callback refuse.
    const before = [...bindings.bindings];
    bindings.bindings = [];
    const refused = await post(directCallback('910902')).expect(503);
    expect(refused.body).toMatchObject({ code: 'channel_not_configured' });
    // A refused callback is refused before anything is written, so it leaves no
    // conversation behind and claims no cursor either.
    const claimsBefore = bindings.claims.length;
    expect(await conversationsFor(TENANT, 'wm-customer-direct')).toHaveLength(1);
    expect(bindings.claims).toHaveLength(claimsBefore);

    bindings.bindings = before;
  });

  it('refuses a direct message callback for an account with no active binding', async () => {
    const response = await post(directCallback('910903', UNBOUND_KF_ID)).expect(503);

    // Both callback shapes answer one refusal for one unbound account, which is
    // what stops a deployment from pulling a backlog for an account whose direct
    // callbacks it refuses.
    expect(response.body).toMatchObject({ code: 'channel_not_configured' });
    const notificationRefusal = await post(notification(UNBOUND_KF_ID)).expect(503);
    expect(notificationRefusal.body).toMatchObject({ code: 'channel_not_configured' });
  });
});
