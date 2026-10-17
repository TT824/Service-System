/**
 * The realtime event contract, re-exported from its single definition.
 *
 * The types and the visibility rule live in `@kefu/core` (`platform/realtime`)
 * because they are domain rules, and the SQL and in-memory adapters must not be
 * able to disagree about who may see a frame. This module exists only so the
 * API's own files go on importing from their own directory.
 */

export {
  REALTIME_EVENT_CONNECTED,
  REALTIME_EVENT_PING,
  REALTIME_EVENT_TYPES,
  buildRealtimeEvent,
  isDomainRealtimeEvent,
  isRealtimeEventType,
  realtimeEventVisibleTo,
} from '@kefu/core';

export type {
  ConversationOpenedEvent,
  ConversationUpdatedEvent,
  InternalMessageCreatedEvent,
  MessageCreatedEvent,
  MessageDeliveryUpdatedEvent,
  PresenceChangedEvent,
  RealtimeEnvelope,
  RealtimeEnvelopeInput,
  RealtimeEvent,
  RealtimeEventPayload,
  RealtimeEventType,
  RealtimeScope,
} from '@kefu/core';
