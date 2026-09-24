import { describe, expect, it } from 'vitest';
// The Mock transport is shared with the Worker: an API in Mock mode queues
// outbox entries that a Worker delivers through this same adapter, so its
// triggers must mean one thing in both processes.
import { MOCK_WECOM_SIGNATURE, MockWecomAdapter } from '@kefu/wecom';

describe('MockWecomAdapter', () => {
  const adapter = new MockWecomAdapter();

  it('verifies the explicit mock signature', async () => {
    expect(
      await adapter.verifyWebhook({
        channel: 'wecom',
        signature: MOCK_WECOM_SIGNATURE,
        timestamp: null,
        nonce: null,
        rawBody: '{}',
      }),
    ).toEqual({ ok: true, value: { verified: true } });
    expect(
      await adapter.verifyWebhook({
        channel: 'wecom',
        signature: null,
        timestamp: null,
        nonce: null,
        rawBody: '{}',
      }),
    ).toMatchObject({ ok: false, code: 'channel_invalid_request', retryable: false });
  });

  it('maps image callbacks and supplies a readable placeholder', async () => {
    const result = await adapter.parseInboundMessage({
      rawBody: JSON.stringify({
        eventId: 'event-1',
        tenantId: 'tenant-acme',
        storeId: 'store-acme-flagship',
        externalCustomerId: 'customer-1',
        externalConversationId: 'conversation-1',
        externalMessageId: 'message-1',
        messageType: 'image',
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        externalEventId: 'event-1',
        messageType: 'image',
        content: '[图片消息]',
        dedupKey: 'wecom:event-1',
      },
    });
  });

  it('classifies provider failure and unknown delivery outcomes', async () => {
    const base = {
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      externalCustomerId: 'customer-1',
      externalConversationId: 'conversation-1',
      messageType: 'text' as const,
      media: null,
      correlationId: 'delivery-1',
    };
    expect(await adapter.sendMessage({ ...base, content: '[mock:fail]' })).toMatchObject({
      ok: false,
      code: 'channel_provider_error',
      retryable: true,
    });
    expect(await adapter.sendMessage({ ...base, content: '[mock:unknown]' })).toMatchObject({
      ok: false,
      code: 'channel_delivery_unknown',
      deliveryUnknown: true,
    });
  });
});
