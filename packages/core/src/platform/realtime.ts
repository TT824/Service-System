/**
 * Realtime event contract.
 *
 * One envelope, one visibility rule, and nothing else. The realtime channel is
 * a *notification* surface: a frame says "this changed", never "here is the new
 * state". That is what makes the two hard requirements hold structurally rather
 * than by careful coding — a subscriber that treats a frame as a nudge to re-read
 * the REST surface cannot lose an event (the REST surface is the durable truth,
 * so a missed frame costs nothing) and cannot double-apply one (a re-read is
 * idempotent). Compensation after a disconnect is therefore the same mechanism
 * as normal operation, not a special case.
 *
 * Events are tenant- and store-scoped, and {@link realtimeEventVisibleTo} is the
 * single rule that decides who may see one. It mirrors the scope the REST
 * readers already enforce, so the stream can never be a way around them: a seat
 * that cannot `GET` a conversation cannot be *told* about it either.
 */

import type { MessageDeliveryStatus } from '../channel-reliability';
import type { AgentAvailabilityStatus } from './assignment';
import type { ConversationStatus, MessageDirection, MessageType } from './types';

/**
 * Every frame the realtime channel can send.
 *
 * Listed in one place so a consumer switch, the publisher and the tests cannot
 * drift. The two `realtime.*` kinds are transport-level: `connected` is the
 * handshake every stream opens with, `ping` is the keepalive that stops an idle
 * stream from being reaped by an intermediary.
 */
export const REALTIME_EVENT_TYPES = [
  'realtime.connected',
  'realtime.ping',
  'conversation.opened',
  'conversation.updated',
  'message.created',
  'message.delivery_updated',
  'presence.changed',
] as const;

/** A frame kind the realtime channel can send. */
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

/** Sent once when a stream opens, carrying whether this is a re-connection. */
export const REALTIME_EVENT_CONNECTED: RealtimeEventType = 'realtime.connected';

/** Keepalive frame. Carries no domain fact, so it never triggers a re-read. */
export const REALTIME_EVENT_PING: RealtimeEventType = 'realtime.ping';

/** The five envelope fields every frame carries, whatever its kind. */
export type RealtimeEnvelope = {
  /**
   * Unique per frame, so a consumer can drop a duplicate it has already seen.
   *
   * Not a cursor: this channel has no replay buffer, because re-reading REST
   * state is the compensation and a replay buffer would be a second, weaker
   * copy of the same truth (see the module doc comment).
   */
  readonly event_id: string;
  readonly event_type: RealtimeEventType;
  /** Tenant the fact belongs to; `null` for the transport-level frames. */
  readonly tenant_id: string | null;
  /** Store the fact belongs to; `null` when it is tenant-wide. */
  readonly store_id: string | null;
  readonly occurred_at: string;
};

/** Handshake and keepalive payloads. */
export type RealtimeControlEvent =
  | {
      readonly event_type: 'realtime.connected';
      /**
       * `true` when the stream is being re-established after a break.
       *
       * A re-connection is the one moment a subscriber knows its view may be
       * stale, so it is told explicitly rather than having to infer it from a
       * gap in `event_id`s it was never promised.
       */
      readonly data: { readonly reconnect: boolean };
    }
  | { readonly event_type: 'realtime.ping'; readonly data: { readonly at: string } };

/** A conversation became visible to the workspace. */
export type ConversationOpenedEvent = {
  readonly event_type: 'conversation.opened';
  readonly data: {
    readonly conversation_id: string;
    readonly status: ConversationStatus;
    readonly assigned_member_id: string | null;
  };
};

/** A conversation moved: claimed, returned, transferred, closed or reopened. */
export type ConversationUpdatedEvent = {
  readonly event_type: 'conversation.updated';
  readonly data: {
    readonly conversation_id: string;
    readonly status: ConversationStatus;
    readonly assigned_member_id: string | null;
  };
};

/** A message was appended to a conversation, in either direction. */
export type MessageCreatedEvent = {
  readonly event_type: 'message.created';
  readonly data: {
    readonly conversation_id: string;
    readonly message_id: string;
    readonly direction: MessageDirection;
    readonly message_type: MessageType;
  };
};

/** An outbound message's provider-facing outcome changed. */
export type MessageDeliveryUpdatedEvent = {
  readonly event_type: 'message.delivery_updated';
  readonly data: {
    readonly conversation_id: string;
    readonly message_id: string;
    readonly status: MessageDeliveryStatus;
  };
};

/**
 * A seat's availability changed.
 *
 * `offline` is reported here even though it is stored as the *absence* of a
 * row: the frame describes what other seats should now see, which is a status,
 * not a storage detail.
 */
export type PresenceChangedEvent = {
  readonly event_type: 'presence.changed';
  readonly data: {
    readonly member_id: string;
    readonly store_id: string;
    readonly status: AgentAvailabilityStatus;
  };
};

/** A frame's kind and its kind-specific payload, without the envelope. */
export type RealtimeEventPayload =
  | RealtimeControlEvent
  | ConversationOpenedEvent
  | ConversationUpdatedEvent
  | MessageCreatedEvent
  | MessageDeliveryUpdatedEvent
  | PresenceChangedEvent;

/** A full frame: the envelope plus the payload its kind carries. */
export type RealtimeEvent = RealtimeEventPayload & RealtimeEnvelope;

/** Facts one envelope is assembled from, supplied by the publisher. */
export type RealtimeEnvelopeInput = {
  readonly eventId: string;
  readonly tenantId: string | null;
  readonly storeId: string | null;
  readonly occurredAt: string;
};

/**
 * Assemble a frame.
 *
 * The single place the envelope is built, so the five documented fields cannot
 * be assembled differently in two call sites — or omitted in one.
 *
 * @param payload - The kind-specific payload.
 * @param input - Envelope identity and scope.
 * @returns The complete frame.
 */
export function buildRealtimeEvent<Payload extends RealtimeEventPayload>(
  payload: Payload,
  input: RealtimeEnvelopeInput,
): RealtimeEvent & Payload {
  // The spread of a union-typed payload widens `event_type`/`data` back to their
  // unions, which no longer proves the two came from the same variant. The
  // caller's `Payload` is what carries that proof, so the assertion restores
  // it rather than inventing it.
  return {
    event_id: input.eventId,
    event_type: payload.event_type,
    tenant_id: input.tenantId,
    store_id: input.storeId,
    occurred_at: input.occurredAt,
    data: payload.data,
  } as RealtimeEvent & Payload;
}

/**
 * The scope a subscriber may see, expressed the way reads express it.
 *
 * `storeId: undefined` means "across the whole tenant", which is exactly what
 * the store-scope resolver returns for an administrator and never for an agent
 * pinned to one store. Keeping the two representations identical means the
 * stream's filter and the REST filter cannot disagree.
 */
export type RealtimeScope = {
  readonly tenantId: string | null;
  readonly storeId: string | undefined;
};

/**
 * Whether a subscriber may be sent this frame.
 *
 * Two independent checks, both mandatory:
 *
 * 1. **Tenant.** An exact match, with no wildcard: a platform administrator is
 *    *not* exempt, because their stream is opened against one named tenant just
 *    like their reads are. A `null` subscriber tenant only ever matches the
 *    transport-level frames, which carry no tenant of their own.
 * 2. **Store.** A tenant-wide fact (`store_id: null`) reaches every subscriber
 *    in the tenant; a store-scoped fact reaches only a subscriber whose scope
 *    contains that store.
 *
 * @param event - The frame about to be sent.
 * @param scope - The subscriber's resolved tenant and store scope.
 * @returns `true` when the frame may be delivered.
 */
export function realtimeEventVisibleTo(
  event: Pick<RealtimeEvent, 'tenant_id' | 'store_id'>,
  scope: RealtimeScope,
): boolean {
  if (event.tenant_id !== scope.tenantId) {
    return false;
  }
  if (event.store_id === null || scope.storeId === undefined) {
    return true;
  }
  return event.store_id === scope.storeId;
}

/**
 * Whether a string is a frame kind this contract defines.
 *
 * @param value - Candidate value.
 * @returns `true` when the value is one of {@link REALTIME_EVENT_TYPES}.
 */
export function isRealtimeEventType(value: string): value is RealtimeEventType {
  return (REALTIME_EVENT_TYPES as ReadonlyArray<string>).includes(value);
}

/**
 * Whether a frame carries a domain fact, and so should trigger a re-read.
 *
 * The transport-level frames are deliberately excluded: re-reading on every
 * keepalive would turn an idle workspace into a polling client.
 *
 * @param event - Frame to classify.
 * @returns `true` for a frame a subscriber should act on.
 */
export function isDomainRealtimeEvent(event: RealtimeEvent): boolean {
  return event.event_type !== 'realtime.ping' && event.event_type !== 'realtime.connected';
}
