import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DELIVERY_WINDOW_MS, parseAppConfig, type AppConfig } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';

const TENANT = 'tenant-acme';
const OTHER_TENANT = 'tenant-beta';
const STORE = 'store-acme-flagship';
const SECOND_STORE = 'store-acme-distribution';

/** The documented Mock callback signature header. */
const SIGNATURE = { 'x-mock-signature': 'mock-signature' };

type DataEnvelope = { request_id: string; data: unknown; meta: Record<string, never> };
type ErrorEnvelope = { request_id: string; code: string; message: string; details: unknown[] };

/** Read the payload of a successful response. */
function dataOf(body: unknown): Record<string, unknown> {
  return (body as DataEnvelope).data as Record<string, unknown>;
}

/** Read the delivery projection of a send response. */
function deliveryOf(body: unknown): Record<string, unknown> {
  return dataOf(body)['delivery'] as Record<string, unknown>;
}

/** Read the message of a send response. */
function messageOf(body: unknown): Record<string, unknown> {
  return dataOf(body)['message'] as Record<string, unknown>;
}

/**
 * Build a Mock WeCom callback body with the fields a caller does not override.
 *
 * `occurredAt` defaults to the instant the callback is built, so the reply window
 * it opens is open *now* and the suite never expires with the calendar. A test
 * that needs an aged window overrides it with an offset from the current time.
 */
function callbackBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    tenantId: TENANT,
    storeId: STORE,
    messageType: 'text',
    content: '你好，请问这款有货吗？',
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

/** An ISO instant `hours` in the past, relative to the running clock. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * Interface tests for the Mock WeCom message loop.
 *
 * These tests boot the real Nest application in-process and drive the whole
 * loop over HTTP: callback ingestion with idempotency, scope enforcement,
 * non-text placeholders, outbound delivery with attempts and outbox state,
 * window/quota refusal before the provider is called, explicit retry, and
 * provider status notifications.
 *
 * The transport is the deterministic Mock adapter, so every path — including
 * "the provider rejected it" and "the provider response was lost" — is
 * reproducible without a network call and without a real WeCom credential.
 */
describe('Mock WeCom message loop (interface)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    }).compile();

    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Deliver one authenticated Mock callback as the given member. */
  async function postCallback(
    body: Record<string, unknown>,
    memberId = 'u-t1-admin',
  ): Promise<Record<string, unknown>> {
    // `200`, not the Nest default `201`: WeCom reads only `200` as "received"
    // and retries anything else, so the callback routes declare it explicitly.
    const response = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/webhook')
      .set('x-member-id', memberId)
      .set(SIGNATURE)
      .send(body)
      .expect(200);
    return dataOf(response.body);
  }

  /** Send one outbound reply from the agent workspace. */
  async function sendReply(
    conversationId: string,
    content: string,
    memberId = 'u-t1-agent-1',
  ): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('x-member-id', memberId)
      .send({ content, source: 'manual_typed' })
      .expect(201);
    return response.body as Record<string, unknown>;
  }

  it('ingests an authenticated callback once and replays it without a second message', async () => {
    const body = callbackBody({
      eventId: 'event-loop-1',
      externalCustomerId: 'customer-loop-1',
      externalConversationId: 'wecom-loop-1',
      externalMessageId: 'message-loop-1',
    });

    const processed = await postCallback(body);
    expect(processed).toMatchObject({
      status: 'processed',
      created: true,
      eventId: 'event-loop-1',
      messageType: 'text',
    });
    const conversationId = processed['conversationId'] as string;
    const messageId = processed['messageId'] as string;

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const detailData = dataOf(detail.body);
    expect((detailData['messages'] as unknown[]).length).toBe(1);
    expect((detailData['conversation'] as Record<string, unknown>)['channel']).toBe('wecom');
    expect(detailData['deliveries']).toEqual([]);

    const replay = await postCallback(body);
    expect(replay).toMatchObject({
      status: 'duplicate',
      created: false,
      eventId: 'event-loop-1',
      messageId,
      conversationId,
    });

    const afterReplay = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    expect((dataOf(afterReplay.body)['messages'] as unknown[]).length).toBe(1);
  });

  it('rejects unsigned, malformed, cross-tenant and cross-store callbacks', async () => {
    const body = callbackBody({
      eventId: 'event-loop-reject',
      externalCustomerId: 'customer-loop-reject',
      externalConversationId: 'wecom-loop-reject',
      externalMessageId: 'message-loop-reject',
    });

    const unsigned = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/webhook')
      .set('x-member-id', 'u-t1-admin')
      .send(body)
      .expect(401);
    expect(unsigned.body as ErrorEnvelope).toMatchObject({ code: 'unauthorized' });

    const forged = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/webhook')
      .set('x-member-id', 'u-t1-admin')
      .set('x-mock-signature', 'not-the-secret')
      .send(body)
      .expect(401);
    expect(forged.body as ErrorEnvelope).toMatchObject({ code: 'unauthorized' });

    const malformed = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/webhook')
      .set('x-member-id', 'u-t1-admin')
      .set(SIGNATURE)
      .send({ tenantId: TENANT, storeId: STORE })
      .expect(400);
    expect(malformed.body as ErrorEnvelope).toMatchObject({ code: 'bad_request' });

    const crossTenant = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/webhook')
      .set('x-member-id', 'u-t1-admin')
      .set(SIGNATURE)
      .send(callbackBody({ ...body, tenantId: OTHER_TENANT }))
      .expect(403);
    expect(crossTenant.body as ErrorEnvelope).toMatchObject({ code: 'forbidden' });

    const unknownStore = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/webhook')
      .set('x-member-id', 'u-t1-admin')
      .set(SIGNATURE)
      .send(callbackBody({ ...body, storeId: 'store-does-not-exist' }))
      .expect(400);
    expect(unknownStore.body as ErrorEnvelope).toMatchObject({ code: 'bad_request' });

    // A tenant-scoped agent may only receive callbacks for its own store.
    const crossStore = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/webhook')
      .set('x-member-id', 'u-t1-agent-1')
      .set(SIGNATURE)
      .send(callbackBody({ ...body, storeId: SECOND_STORE }))
      .expect(403);
    expect(crossStore.body as ErrorEnvelope).toMatchObject({ code: 'forbidden' });
  });

  it('stores non-text callbacks with a stable placeholder and keeps the message type', async () => {
    const image = await postCallback(
      callbackBody({
        eventId: 'event-loop-image',
        externalCustomerId: 'customer-loop-image',
        externalConversationId: 'wecom-loop-image',
        externalMessageId: 'message-loop-image',
        messageType: 'image',
        content: '',
      }),
    );
    expect(image).toMatchObject({ status: 'processed', messageType: 'image' });

    const imageDetail = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${image['conversationId'] as string}`)
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const imageMessage = (
      dataOf(imageDetail.body)['messages'] as Array<Record<string, unknown>>
    )[0];
    expect(imageMessage).toMatchObject({ messageType: 'image', content: '[图片消息]' });

    const link = await postCallback(
      callbackBody({
        eventId: 'event-loop-link',
        externalCustomerId: 'customer-loop-link',
        externalConversationId: 'wecom-loop-link',
        externalMessageId: 'message-loop-link',
        messageType: 'link',
        content: 'https://example.test/product/1',
      }),
    );
    expect(link).toMatchObject({ status: 'processed', messageType: 'link' });
  });

  it('delivers a reply inside the open window and records the attempt and outbox state', async () => {
    const callback = await postCallback(
      callbackBody({
        eventId: 'event-loop-send',
        externalCustomerId: 'customer-loop-send',
        externalConversationId: 'wecom-loop-send',
        externalMessageId: 'message-loop-send',
      }),
    );
    const conversationId = callback['conversationId'] as string;

    const sent = await sendReply(conversationId, '有的，现货可发。');
    const delivery = deliveryOf(sent);
    expect(delivery).toMatchObject({
      conversationId,
      channel: 'wecom',
      status: 'sent',
      attemptCount: 1,
      externalMessageId: `mock-${delivery['id'] as string}`,
      failureCode: null,
      retryable: false,
    });
    expect(messageOf(sent)).toMatchObject({ direction: 'outbound', source: 'manual_typed' });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/deliveries/${delivery['id'] as string}`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    const detailData = dataOf(detail.body);
    expect((detailData['attempts'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      attemptNumber: 1,
      status: 'sent',
      retryable: false,
    });
    expect(detailData['outbox']).toMatchObject({ status: 'dispatched', attemptCount: 1 });
  });

  it('refuses a reply with no open window before the provider is called', async () => {
    // `conversation-acme-1` is seeded with no inbound customer event, so its
    // customer has no reply window at all.
    const refused = await sendReply('conversation-acme-1', '您好，请问还在吗？');
    const delivery = deliveryOf(refused);
    expect(delivery).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      failureCode: 'window_missing',
      failureReason: 'no inbound customer message has opened a reply window for this customer',
      retryable: true,
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/deliveries/${delivery['id'] as string}`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    const detailData = dataOf(detail.body);
    // Blocked before the adapter: no provider attempt exists.
    expect(detailData['attempts']).toEqual([]);
    expect(detailData['outbox']).toMatchObject({ status: 'pending', attemptCount: 0 });
    // The message is still recorded, so the workspace stays usable.
    expect(messageOf(refused)).toMatchObject({
      content: '您好，请问还在吗？',
      direction: 'outbound',
    });
  });

  it('distinguishes a definite failure from an unknown outcome and retries in place', async () => {
    const callback = await postCallback(
      callbackBody({
        eventId: 'event-loop-failure',
        externalCustomerId: 'customer-loop-failure',
        externalConversationId: 'wecom-loop-failure',
        externalMessageId: 'message-loop-failure',
      }),
    );
    const conversationId = callback['conversationId'] as string;

    const failed = await sendReply(conversationId, '[mock:fail] 这条会被拒收。');
    const failedDelivery = deliveryOf(failed);
    expect(failedDelivery).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      failureCode: 'channel_provider_error',
      failureReason: 'mock provider rejected the message',
      retryable: true,
    });

    const unknown = await sendReply(conversationId, '[mock:unknown] 这条可能已经发出。');
    const unknownDelivery = deliveryOf(unknown);
    expect(unknownDelivery).toMatchObject({
      status: 'unknown',
      attemptCount: 1,
      failureCode: 'channel_delivery_unknown',
      retryable: true,
    });
    // A definite failure and a lost response are visibly distinct states.
    expect(unknownDelivery['status']).not.toBe(failedDelivery['status']);

    const retried = await request(app.getHttpServer())
      .post(`/api/v1/channels/deliveries/${failedDelivery['id'] as string}/retry`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(201);
    const retriedDelivery = dataOf(retried.body);
    expect(retriedDelivery).toMatchObject({
      id: failedDelivery['id'],
      messageId: failedDelivery['messageId'],
      status: 'failed',
      attemptCount: 2,
      failureCode: 'channel_provider_error',
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/deliveries/${failedDelivery['id'] as string}`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    const detailData = dataOf(detail.body);
    expect(detailData['attempts']).toHaveLength(2);
    // Every adapter attempt advances the outbox counter too, so the two counts
    // describe the same number of provider attempts on every path.
    expect(detailData['outbox']).toMatchObject({ status: 'pending', attemptCount: 2 });

    const unknownDetail = await request(app.getHttpServer())
      .get(`/api/v1/channels/deliveries/${unknownDelivery['id'] as string}`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    // A lost response keeps the entry pending (it may still have been accepted)
    // and still counts the one attempt that reached the provider.
    expect(dataOf(unknownDetail.body)['outbox']).toMatchObject({
      status: 'pending',
      attemptCount: 1,
    });

    // Two failed/unknown sends and one retry produced exactly two messages: a
    // retry appends an attempt, never a second platform message.
    const conversation = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    expect((dataOf(conversation.body)['messages'] as unknown[]).length).toBe(3);
  });

  it('enforces the five-message reply budget before the provider is called', async () => {
    const callback = await postCallback(
      callbackBody({
        eventId: 'event-loop-quota',
        externalCustomerId: 'customer-loop-quota',
        externalConversationId: 'wecom-loop-quota',
        externalMessageId: 'message-loop-quota',
      }),
    );
    const conversationId = callback['conversationId'] as string;

    for (let index = 1; index <= 5; index += 1) {
      const sent = await sendReply(conversationId, `第 ${index} 条回复`);
      expect(deliveryOf(sent)['status']).toBe('sent');
    }

    const blocked = await sendReply(conversationId, '第 6 条回复');
    const blockedDelivery = deliveryOf(blocked);
    expect(blockedDelivery).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      failureCode: 'quota_exceeded',
      retryable: true,
    });
    expect(blockedDelivery['failureReason']).toContain('5-message reply budget');

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/deliveries/${blockedDelivery['id'] as string}`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    expect(dataOf(detail.body)['attempts']).toEqual([]);

    // A new inbound customer message reopens the window with a fresh budget.
    await postCallback(
      callbackBody({
        eventId: 'event-loop-quota-2',
        externalCustomerId: 'customer-loop-quota',
        externalConversationId: 'wecom-loop-quota',
        externalMessageId: 'message-loop-quota-2',
        content: '那我再看看。',
      }),
    );
    const afterReopen = await sendReply(conversationId, '好的，随时联系。');
    expect(deliveryOf(afterReopen)['status']).toBe('sent');
  });

  it('releases a reserved slot on a definite failure but keeps it on an unknown outcome', async () => {
    // Definite failure: the provider rejected the message, so the customer never
    // received it and the slot it reserved must go back to the budget.
    const released = await postCallback(
      callbackBody({
        eventId: 'event-loop-quota-release',
        externalCustomerId: 'customer-loop-quota-release',
        externalConversationId: 'wecom-loop-quota-release',
        externalMessageId: 'message-loop-quota-release',
      }),
    );
    const releasedConversation = released['conversationId'] as string;
    for (let index = 1; index <= 4; index += 1) {
      expect(deliveryOf(await sendReply(releasedConversation, `第 ${index} 条`))['status']).toBe(
        'sent',
      );
    }
    const failed = await sendReply(releasedConversation, '[mock:fail] 被拒收。');
    expect(deliveryOf(failed)).toMatchObject({ status: 'failed', retryable: true });
    // If the failed send still held a slot, this fifth send would be refused
    // with `quota_exceeded`; it succeeds, so the reservation was released.
    const fifth = await sendReply(releasedConversation, '第 5 条');
    expect(deliveryOf(fifth)['status']).toBe('sent');
    // ...and the budget really is exhausted now, which is what makes the
    // observation above meaningful rather than a missing limit.
    const sixth = await sendReply(releasedConversation, '第 6 条');
    expect(deliveryOf(sixth)).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      failureCode: 'quota_exceeded',
    });

    // Unknown outcome: the provider may have accepted the message, so the slot
    // stays reserved and the budget is not handed back.
    const retained = await postCallback(
      callbackBody({
        eventId: 'event-loop-quota-retain',
        externalCustomerId: 'customer-loop-quota-retain',
        externalConversationId: 'wecom-loop-quota-retain',
        externalMessageId: 'message-loop-quota-retain',
      }),
    );
    const retainedConversation = retained['conversationId'] as string;
    for (let index = 1; index <= 4; index += 1) {
      expect(deliveryOf(await sendReply(retainedConversation, `第 ${index} 条`))['status']).toBe(
        'sent',
      );
    }
    const unknown = await sendReply(retainedConversation, '[mock:unknown] 也许已发出。');
    expect(deliveryOf(unknown)).toMatchObject({ status: 'unknown', retryable: true });
    const overBudget = await sendReply(retainedConversation, '第 6 条');
    expect(deliveryOf(overBudget)).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      failureCode: 'quota_exceeded',
    });
  });

  it('blocks an expired reply window before the provider is called', async () => {
    // The callback is accepted, but the window it opens closed 24 hours ago, so
    // nothing may be sent to this customer any more.
    const callback = await postCallback(
      callbackBody({
        eventId: 'event-loop-expired',
        externalCustomerId: 'customer-loop-expired',
        externalConversationId: 'wecom-loop-expired',
        externalMessageId: 'message-loop-expired',
        occurredAt: hoursAgo(72),
      }),
    );

    const blocked = await sendReply(callback['conversationId'] as string, '还能发货吗？');
    const delivery = deliveryOf(blocked);
    expect(delivery).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      failureCode: 'window_expired',
      retryable: true,
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/deliveries/${delivery['id'] as string}`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    const detailData = dataOf(detail.body);
    // Refused before the adapter: no attempt reached the provider and the outbox
    // never counted one.
    expect(detailData['attempts']).toEqual([]);
    expect(detailData['outbox']).toMatchObject({ status: 'pending', attemptCount: 0 });

    // A fresh inbound message opens a window that is open now, so the very same
    // conversation can be answered again.
    await postCallback(
      callbackBody({
        eventId: 'event-loop-expired-reopen',
        externalCustomerId: 'customer-loop-expired',
        externalConversationId: 'wecom-loop-expired',
        externalMessageId: 'message-loop-expired-reopen',
        content: '我在的。',
      }),
    );
    const reopened = await sendReply(callback['conversationId'] as string, '可以的。');
    expect(deliveryOf(reopened)['status']).toBe('sent');
  });

  it('accepts a reply just before the 48-hour end and refuses it exactly at the end', async () => {
    // The clock is pinned for this test only. The rule the platform enforces is
    // `now >= windowEndsAt`, and a test that merely let real time run a few
    // milliseconds past the end would pass against an inclusive boundary too —
    // so the two instants that decide it are set exactly instead.
    const openedAtMs = Date.parse('2026-09-10T00:00:00.000Z');
    const endsAtMs = openedAtMs + DELIVERY_WINDOW_MS;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(openedAtMs);
      const inside = await postCallback(
        callbackBody({
          eventId: 'event-loop-boundary-inside',
          externalCustomerId: 'customer-loop-boundary-inside',
          externalConversationId: 'wecom-loop-boundary-inside',
          externalMessageId: 'message-loop-boundary-inside',
          occurredAt: new Date(openedAtMs).toISOString(),
        }),
      );

      // One millisecond before the window closes: still answerable.
      vi.setSystemTime(endsAtMs - 1);
      const accepted = await sendReply(inside['conversationId'] as string, '刚好赶上。');
      expect(deliveryOf(accepted)).toMatchObject({
        status: 'sent',
        attemptCount: 1,
        failureCode: null,
        retryable: false,
      });

      // A second customer, for the boundary itself. Its window opens at the
      // same instant, so the reply below is evaluated exactly at `windowEndsAt`.
      vi.setSystemTime(openedAtMs);
      const atEnd = await postCallback(
        callbackBody({
          eventId: 'event-loop-boundary-at-end',
          externalCustomerId: 'customer-loop-boundary-at-end',
          externalConversationId: 'wecom-loop-boundary-at-end',
          externalMessageId: 'message-loop-boundary-at-end',
          occurredAt: new Date(openedAtMs).toISOString(),
        }),
      );

      vi.setSystemTime(endsAtMs);
      const refused = await sendReply(atEnd['conversationId'] as string, '刚好超时。');
      const delivery = deliveryOf(refused);
      expect(delivery).toMatchObject({
        status: 'pending',
        attemptCount: 0,
        failureCode: 'window_expired',
        retryable: true,
      });

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/channels/deliveries/${delivery['id'] as string}`)
        .set('x-member-id', 'u-t1-agent-1')
        .expect(200);
      const detailData = dataOf(detail.body);
      // Refused before the provider was called: the boundary belongs to the
      // closed side of the interval, so no attempt exists and the outbox has
      // spent none of its budget.
      expect(detailData['attempts']).toEqual([]);
      expect(detailData['outbox']).toMatchObject({ status: 'pending', attemptCount: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a provider status notification once, inside the tenant, with the retryable contract', async () => {
    const callback = await postCallback(
      callbackBody({
        eventId: 'event-loop-status',
        externalCustomerId: 'customer-loop-status',
        externalConversationId: 'wecom-loop-status',
        externalMessageId: 'message-loop-status',
      }),
    );
    // Start from a definite failure, so the notification below is a genuine
    // forward move rather than a stale one.
    const failed = await sendReply(callback['conversationId'] as string, '[mock:fail] 未送达。');
    const deliveryId = deliveryOf(failed)['id'] as string;
    expect(deliveryOf(failed)).toMatchObject({ status: 'failed', retryable: true });

    const applied = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/status')
      .set('x-member-id', 'u-t1-admin')
      .set(SIGNATURE)
      .send({
        eventId: 'status-event-1',
        deliveryId,
        status: 'unknown',
        reason: 'carrier lost the acknowledgement',
      })
      .expect(201);
    expect(dataOf(applied.body)).toMatchObject({
      eventId: 'status-event-1',
      recorded: true,
      applied: true,
      delivery: { id: deliveryId, status: 'unknown', retryable: true },
    });

    const replayed = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/status')
      .set('x-member-id', 'u-t1-admin')
      .set(SIGNATURE)
      .send({
        eventId: 'status-event-1',
        deliveryId,
        status: 'unknown',
        reason: 'carrier lost the acknowledgement',
      })
      .expect(201);
    expect(dataOf(replayed.body)).toMatchObject({
      recorded: false,
      applied: false,
      delivery: { id: deliveryId, status: 'unknown' },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/deliveries/${deliveryId}`)
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    expect(dataOf(detail.body)['statusEvents']).toHaveLength(1);

    // A status notification for a delivery of another tenant is not found, and
    // an unsigned one is refused outright.
    const crossTenant = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/status')
      .set('x-member-id', 'u-t2-admin')
      .set(SIGNATURE)
      .send({ eventId: 'status-event-2', deliveryId, status: 'failed' })
      .expect(404);
    expect(crossTenant.body as ErrorEnvelope).toMatchObject({ code: 'not_found' });

    const unsigned = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/status')
      .set('x-member-id', 'u-t1-admin')
      .send({ eventId: 'status-event-3', deliveryId, status: 'sent' })
      .expect(401);
    expect(unsigned.body as ErrorEnvelope).toMatchObject({ code: 'unauthorized' });

    const invalidStatus = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/status')
      .set('x-member-id', 'u-t1-admin')
      .set(SIGNATURE)
      .send({ eventId: 'status-event-4', deliveryId, status: 'delivered' })
      .expect(400);
    expect(invalidStatus.body as ErrorEnvelope).toMatchObject({ code: 'bad_request' });

    // The retry endpoint agrees with the retryable flag the callback set: the
    // delivery is `unknown`, which is explicitly retryable, so a retry is
    // allowed and appends one attempt to the same delivery. That attempt is a
    // new, deliberate send, so its own outcome — this Mock message is rejected
    // again — is what the delivery now reports; the `unknown` notification stays
    // in the status-event history above.
    const retried = await request(app.getHttpServer())
      .post(`/api/v1/channels/deliveries/${deliveryId}/retry`)
      .set('x-member-id', 'u-t1-admin')
      .expect(201);
    expect(dataOf(retried.body)).toMatchObject({
      id: deliveryId,
      status: 'failed',
      attemptCount: 2,
      retryable: true,
    });
  });

  it('never lets a late callback move a sent delivery backwards or re-enable retry', async () => {
    const callback = await postCallback(
      callbackBody({
        eventId: 'event-loop-status-late',
        externalCustomerId: 'customer-loop-status-late',
        externalConversationId: 'wecom-loop-status-late',
        externalMessageId: 'message-loop-status-late',
      }),
    );
    const sent = await sendReply(callback['conversationId'] as string, '已为您下单。');
    const deliveryId = deliveryOf(sent)['id'] as string;
    expect(deliveryOf(sent)).toMatchObject({ status: 'sent', attemptCount: 1, retryable: false });

    /** Post one status notification for this delivery and return its payload. */
    async function postStatus(eventId: string, status: string): Promise<Record<string, unknown>> {
      const response = await request(app.getHttpServer())
        .post('/api/v1/channels/wecom/status')
        .set('x-member-id', 'u-t1-admin')
        .set(SIGNATURE)
        .send({ eventId, deliveryId, status, reason: 'late provider notification' })
        .expect(201);
      return dataOf(response.body);
    }

    // A late failure: recorded as history, but `sent` is terminal, so the
    // delivery must not regress and must not become retryable again.
    expect(await postStatus('status-late-fail', 'failed')).toMatchObject({
      recorded: true,
      applied: false,
      delivery: { id: deliveryId, status: 'sent', retryable: false, attemptCount: 1 },
    });
    expect(await postStatus('status-late-unknown', 'unknown')).toMatchObject({
      recorded: true,
      applied: false,
      delivery: { id: deliveryId, status: 'sent', retryable: false },
    });

    // The retry endpoint enforces the same contract with a stable 409, and the
    // refusal costs nothing: no adapter attempt, no new outbox attempt, and no
    // second delivery for the message.
    const refused = await request(app.getHttpServer())
      .post(`/api/v1/channels/deliveries/${deliveryId}/retry`)
      .set('x-member-id', 'u-t1-admin')
      .expect(409);
    expect(refused.body as ErrorEnvelope).toMatchObject({ code: 'conflict' });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/channels/deliveries/${deliveryId}`)
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const detailData = dataOf(detail.body);
    expect(detailData['delivery']).toMatchObject({
      status: 'sent',
      attemptCount: 1,
      retryable: false,
    });
    expect(detailData['attempts']).toHaveLength(1);
    expect(detailData['outbox']).toMatchObject({ status: 'dispatched', attemptCount: 1 });

    const conversation = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${callback['conversationId'] as string}`)
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const deliveries = dataOf(conversation.body)['deliveries'] as unknown[];
    expect(deliveries).toHaveLength(1);
  });

  it('scopes delivery reads and retries to the authorized tenant and store', async () => {
    const callback = await postCallback(
      callbackBody({
        eventId: 'event-loop-scope',
        storeId: SECOND_STORE,
        externalCustomerId: 'customer-loop-scope',
        externalConversationId: 'wecom-loop-scope',
        externalMessageId: 'message-loop-scope',
      }),
    );
    const conversationId = callback['conversationId'] as string;
    const sent = await sendReply(conversationId, '门店自提可以吗？', 'u-t1-admin');
    const deliveryId = deliveryOf(sent)['id'] as string;

    // Another tenant cannot see the delivery.
    const foreign = await request(app.getHttpServer())
      .get(`/api/v1/channels/deliveries/${deliveryId}`)
      .set('x-member-id', 'u-t2-admin')
      .expect(404);
    expect(foreign.body as ErrorEnvelope).toMatchObject({ code: 'not_found' });

    // An agent of the other store may not read or retry it.
    const crossStoreRead = await request(app.getHttpServer())
      .get(`/api/v1/channels/deliveries/${deliveryId}`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(403);
    expect(crossStoreRead.body as ErrorEnvelope).toMatchObject({ code: 'forbidden' });

    const crossStoreRetry = await request(app.getHttpServer())
      .post(`/api/v1/channels/deliveries/${deliveryId}/retry`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(403);
    expect(crossStoreRetry.body as ErrorEnvelope).toMatchObject({ code: 'forbidden' });
  });
});

/**
 * The production configuration with the Mock transport bound.
 *
 * `APP_ENV=production` is what makes the demo identity headers unreachable, so
 * this is the only Mock boot in the repository where "no platform credential"
 * means what it means in a deployment. The Mock transport stays bound — the
 * strict environment changes who may act, not which adapter is wired — and
 * nothing here reaches PostgreSQL or Redis: every case below is refused before
 * the first business read.
 */
function productionMockConfig(): AppConfig {
  const parsed = parseAppConfig({
    APP_ENV: 'production',
    NODE_ENV: 'production',
    WECOM_TRANSPORT: 'mock',
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
  if (parsed._tag !== 'ok') {
    throw new Error(`production config could not be parsed: ${parsed.error.message}`);
  }
  return parsed.config;
}

/**
 * The Mock webhook in a strict environment.
 *
 * The Mock transport authenticates a callback with a shared secret, and that
 * secret says nothing about *who* is calling. Where the demo identity headers do
 * not exist, a correctly signed Mock callback still has to name a platform
 * identity — and an anonymous one must be refused rather than quietly answered
 * as the default platform administrator.
 */
describe('Mock WeCom webhook without a platform credential (production)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const config = productionMockConfig();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    }).compile();

    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, config);
    await app.init();
    attachJsonLogger(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an anonymous webhook that carries the correct Mock signature', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/webhook')
      .set(SIGNATURE)
      .send(
        callbackBody({
          eventId: 'event-production-anonymous',
          externalCustomerId: 'customer-production-anonymous',
          externalConversationId: 'wecom-production-anonymous',
          externalMessageId: 'message-production-anonymous',
        }),
      )
      .expect(401);

    const body = response.body as ErrorEnvelope;
    expect(body).toMatchObject({ code: 'unauthorized' });
    // The refusal is the whole response: no ingestion result, so no conversation
    // and no message were written for a callback nobody was authorized to send.
    expect(body).not.toHaveProperty('data');
    expect(body.details).toEqual([]);
  });

  it('refuses a platform identity presented on the Mock webhook', async () => {
    // The default platform administrator is what the demo header path would
    // have resolved to, and production refuses that path outright — so the
    // header cannot be the identity a callback acts through either.
    const response = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/webhook')
      .set('x-member-id', 'u-t1-admin')
      .set('x-tenant-id', TENANT)
      .set(SIGNATURE)
      .send(
        callbackBody({
          eventId: 'event-production-header',
          externalCustomerId: 'customer-production-header',
          externalConversationId: 'wecom-production-header',
          externalMessageId: 'message-production-header',
        }),
      )
      .expect(403);

    expect(response.body as ErrorEnvelope).toMatchObject({ code: 'forbidden' });
  });

  it('still refuses an anonymous request on every other channel route', async () => {
    await request(app.getHttpServer()).get('/api/v1/channels').expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/status')
      .set(SIGNATURE)
      .send({ eventId: 'event-1', deliveryId: 'delivery-1', status: 'sent' })
      .expect(401);
  });
});
