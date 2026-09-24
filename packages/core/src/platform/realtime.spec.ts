import { describe, expect, it } from 'vitest';
import {
  REALTIME_EVENT_CONNECTED,
  REALTIME_EVENT_PING,
  REALTIME_EVENT_TYPES,
  buildRealtimeEvent,
  isDomainRealtimeEvent,
  isRealtimeEventType,
  realtimeEventVisibleTo,
  type RealtimeEvent,
  type RealtimeScope,
} from './realtime';

const AT = '2026-09-14T10:00:00.000Z';

function frame(tenantId: string | null, storeId: string | null): RealtimeEvent {
  return buildRealtimeEvent(
    {
      event_type: 'conversation.updated',
      data: { conversation_id: 'conv-1', status: 'claimed', assigned_member_id: 'u-agent' },
    },
    { eventId: 'evt-1', tenantId, storeId, occurredAt: AT },
  );
}

function scope(tenantId: string | null, storeId: string | undefined): RealtimeScope {
  return { tenantId, storeId };
}

describe('buildRealtimeEvent', () => {
  it('assembles the five envelope fields from the identity it is given', () => {
    const event = buildRealtimeEvent(
      { event_type: 'realtime.ping', data: { at: AT } },
      { eventId: 'evt-9', tenantId: 'tenant-acme', storeId: 'store-acme-flagship', occurredAt: AT },
    );

    expect(event).toEqual({
      event_id: 'evt-9',
      event_type: 'realtime.ping',
      tenant_id: 'tenant-acme',
      store_id: 'store-acme-flagship',
      occurred_at: AT,
      data: { at: AT },
    });
  });

  it('keeps the payload variant alongside the envelope', () => {
    const event = buildRealtimeEvent(
      {
        event_type: 'message.created',
        data: {
          conversation_id: 'conv-1',
          message_id: 'msg-1',
          direction: 'inbound',
          message_type: 'image',
        },
      },
      { eventId: 'evt-1', tenantId: 'tenant-acme', storeId: null, occurredAt: AT },
    );

    // The narrowing is the point: `data.message_type` is only reachable because
    // the returned type kept the caller's variant.
    expect(event.data.message_type).toBe('image');
  });
});

describe('realtimeEventVisibleTo', () => {
  it('delivers a store-scoped fact to a subscriber scoped to that store', () => {
    const event = frame('tenant-acme', 'store-a');
    expect(realtimeEventVisibleTo(event, scope('tenant-acme', 'store-a'))).toBe(true);
  });

  it('delivers a store-scoped fact to a tenant-wide subscriber', () => {
    const event = frame('tenant-acme', 'store-a');
    expect(realtimeEventVisibleTo(event, scope('tenant-acme', undefined))).toBe(true);
  });

  it('withholds a store-scoped fact from another store of the same tenant', () => {
    const event = frame('tenant-acme', 'store-a');
    expect(realtimeEventVisibleTo(event, scope('tenant-acme', 'store-b'))).toBe(false);
  });

  it('delivers a tenant-wide fact to any subscriber of that tenant', () => {
    const event = frame('tenant-acme', null);
    expect(realtimeEventVisibleTo(event, scope('tenant-acme', 'store-b'))).toBe(true);
  });

  it('withholds a fact of another tenant from a tenant-wide subscriber', () => {
    // The case that must never regress: a subscriber reading across its whole
    // tenant is still not reading across tenants.
    const event = frame('tenant-beta', null);
    expect(realtimeEventVisibleTo(event, scope('tenant-acme', undefined))).toBe(false);
  });

  it('withholds a tenant-scoped fact from a subscriber with no tenant', () => {
    const event = frame('tenant-acme', null);
    expect(realtimeEventVisibleTo(event, scope(null, undefined))).toBe(false);
  });

  it('delivers a transport-level frame, which belongs to no tenant, to a tenantless subscriber', () => {
    const event = frame(null, null);
    expect(realtimeEventVisibleTo(event, scope(null, undefined))).toBe(true);
  });
});

describe('realtime event types', () => {
  it('lists the handshake and keepalive alongside the domain frames', () => {
    expect(REALTIME_EVENT_TYPES).toContain(REALTIME_EVENT_CONNECTED);
    expect(REALTIME_EVENT_TYPES).toContain(REALTIME_EVENT_PING);
    expect(REALTIME_EVENT_TYPES).toHaveLength(new Set(REALTIME_EVENT_TYPES).size);
  });

  it('recognises its own kinds and refuses anything else', () => {
    for (const eventType of REALTIME_EVENT_TYPES) {
      expect(isRealtimeEventType(eventType)).toBe(true);
    }
    expect(isRealtimeEventType('conversation.deleted')).toBe(false);
    expect(isRealtimeEventType('')).toBe(false);
  });
});

describe('isDomainRealtimeEvent', () => {
  it('counts a fact as actionable', () => {
    expect(isDomainRealtimeEvent(frame('tenant-acme', 'store-a'))).toBe(true);
  });

  it('excludes the handshake and the keepalive, so an idle stream is not a poll', () => {
    const connected = buildRealtimeEvent(
      { event_type: 'realtime.connected', data: { reconnect: true } },
      { eventId: 'evt-1', tenantId: null, storeId: null, occurredAt: AT },
    );
    const ping = buildRealtimeEvent(
      { event_type: 'realtime.ping', data: { at: AT } },
      { eventId: 'evt-2', tenantId: null, storeId: null, occurredAt: AT },
    );

    expect(isDomainRealtimeEvent(connected)).toBe(false);
    expect(isDomainRealtimeEvent(ping)).toBe(false);
  });
});
