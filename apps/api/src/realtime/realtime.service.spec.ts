import { describe, expect, it, vi } from 'vitest';
import type { Conversation, Message, RealtimeEvent } from '@kefu/core';
import { InMemoryRealtimeBus } from './realtime-bus';
import { RealtimeService } from './realtime.service';

const AT = '2026-09-14T10:00:00.000Z';
const T1 = 'tenant-acme';
const S1 = 'store-acme-flagship';

/** A conversation row as the repository would return it after a write. */
function conversationOf(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conversation-1',
    tenantId: T1,
    storeId: S1,
    channel: 'wecom',
    externalCustomerId: 'wm-customer-1',
    externalConversationId: 'wecom-ext-1',
    title: null,
    status: 'claimed',
    version: 2,
    assignedMemberId: 'u-t1-agent-1',
    openedAt: AT,
    lastMessageAt: AT,
    closedAt: null,
    createdAt: AT,
    pendingSince: null,
    firstResponseStartedAt: null,
    nextAssignmentAt: null,
    dispatchAttempts: 0,
    assignedAt: AT,
    offlineReplyAt: null,
    firstReplyAt: null,
    ...overrides,
  };
}

/** A message row as the repository would return it after a write. */
function messageOf(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    tenantId: T1,
    storeId: S1,
    conversationId: 'conversation-1',
    channel: 'wecom',
    direction: 'inbound',
    messageType: 'text',
    source: 'other',
    content: '你好',
    dedupKey: null,
    reviewState: 'none',
    reviewEligible: false,
    candidateId: null,
    media: null,
    createdAt: AT,
    ...overrides,
  };
}

describe('InMemoryRealtimeBus', () => {
  it('delivers to every subscriber and stops after detaching', () => {
    const bus = new InMemoryRealtimeBus();
    const first: RealtimeEvent[] = [];
    const second: RealtimeEvent[] = [];
    const detachFirst = bus.subscribe((event) => first.push(event));
    bus.subscribe((event) => second.push(event));
    const event = { event_id: 'e1' } as RealtimeEvent;

    bus.publish(event);
    detachFirst();
    bus.publish(event);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(bus.size).toBe(1);
  });

  it('keeps delivering when one subscriber throws, and drops it', () => {
    const bus = new InMemoryRealtimeBus();
    const healthily: RealtimeEvent[] = [];
    bus.subscribe(() => {
      throw new Error('this stream is gone');
    });
    bus.subscribe((event) => healthily.push(event));

    const event = { event_id: 'e1' } as RealtimeEvent;
    bus.publish(event);
    bus.publish({ event_id: 'e2' } as RealtimeEvent);

    // The second frame proves the broken subscriber was dropped rather than
    // re-throwing on every later publish, and the healthy one missed nothing.
    expect(healthily.map((frame) => frame.event_id)).toEqual(['e1', 'e2']);
    expect(bus.size).toBe(1);
  });

  it('lets a subscriber detach itself from inside its own callback', () => {
    const bus = new InMemoryRealtimeBus();
    const seen: string[] = [];
    const detach = bus.subscribe((event) => {
      seen.push(event.event_id);
      detach();
    });

    bus.publish({ event_id: 'e1' } as RealtimeEvent);
    bus.publish({ event_id: 'e2' } as RealtimeEvent);

    expect(seen).toEqual(['e1']);
  });
});

describe('RealtimeService', () => {
  it('stamps the five envelope fields and scopes the frame to its row', () => {
    const realtime = new RealtimeService();
    const frames: RealtimeEvent[] = [];
    realtime.subscribe((event) => frames.push(event));

    realtime.conversationUpdated(conversationOf(), AT);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      event_id: `${AT}#1`,
      event_type: 'conversation.updated',
      tenant_id: T1,
      store_id: S1,
      occurred_at: AT,
      data: {
        conversation_id: 'conversation-1',
        status: 'claimed',
        assigned_member_id: 'u-t1-agent-1',
      },
    });
  });

  it('numbers frames in order, so two frames of the same instant stay distinct', () => {
    const realtime = new RealtimeService();
    const ids = [
      realtime.pingEvent(AT).event_id,
      realtime.pingEvent(AT).event_id,
      realtime.pingEvent(AT).event_id,
    ];

    expect(ids).toEqual([`${AT}#1`, `${AT}#2`, `${AT}#3`]);
  });

  it('describes a message by its conversation rather than by itself', () => {
    const realtime = new RealtimeService();
    const frames: RealtimeEvent[] = [];
    realtime.subscribe((event) => frames.push(event));

    realtime.messageCreated(messageOf({ messageType: 'image' }), AT);

    expect(frames[0]).toMatchObject({
      event_type: 'message.created',
      data: {
        conversation_id: 'conversation-1',
        message_id: 'message-1',
        direction: 'inbound',
        message_type: 'image',
      },
    });
  });

  it('carries a delivery status without re-deriving the message it belongs to', () => {
    const realtime = new RealtimeService();
    const frames: RealtimeEvent[] = [];
    realtime.subscribe((event) => frames.push(event));

    realtime.messageDeliveryUpdated(
      {
        tenantId: T1,
        storeId: S1,
        conversationId: 'conversation-1',
        messageId: 'message-1',
        status: 'failed',
      },
      AT,
    );

    expect(frames[0]).toMatchObject({
      event_type: 'message.delivery_updated',
      tenant_id: T1,
      data: { conversation_id: 'conversation-1', message_id: 'message-1', status: 'failed' },
    });
  });

  it('never publishes a keepalive or a handshake, which belong to one connection', () => {
    const realtime = new RealtimeService();
    const listener = vi.fn();
    realtime.subscribe(listener);

    realtime.pingEvent(AT);
    realtime.connectedEvent({ reconnect: true, tenantId: T1, storeId: S1, now: AT });

    expect(listener).not.toHaveBeenCalled();
  });

  it('opens a stream with the scope it resolved to and whether it is a re-connection', () => {
    const realtime = new RealtimeService();

    expect(
      realtime.connectedEvent({ reconnect: true, tenantId: T1, storeId: S1, now: AT }),
    ).toMatchObject({
      event_type: 'realtime.connected',
      tenant_id: T1,
      store_id: S1,
      data: { reconnect: true },
    });
    expect(
      realtime.connectedEvent({ reconnect: false, tenantId: T1, storeId: null, now: AT }),
    ).toMatchObject({ store_id: null, data: { reconnect: false } });
  });
});
