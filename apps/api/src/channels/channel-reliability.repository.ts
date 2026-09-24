/**
 * The API-owned channel reliability port.
 *
 * Conversation and message content keeps living in the platform repository: an
 * inbound callback still creates its conversation and message through
 * `PlatformRepository.ingestInbound`, so there is exactly one storage model for
 * business history. What that repository deliberately does not model is the
 * *provider-facing* reliability trail: which callback was already handled, what
 * happened to each outbound message at the provider, which status notifications
 * arrived, what reply budget a customer has left, and which deliveries are still
 * waiting in the outbox.
 *
 * This port owns exactly that, and nothing else. Every method takes the caller's
 * verified tenant context as its first argument and scopes each statement by
 * `tenant_id`, so an adapter can never read or write outside the tenant the
 * request was authorized for. Authorization (which tenant, which store, which
 * role) stays in {@link ChannelDeliveryService} and {@link AccessService}.
 *
 * Two adapters implement it, picked by the same environment boundary the
 * platform repository uses: `memory` for `APP_ENV=test`, `postgres` otherwise.
 * Records are immutable values, matching the domain types in `@kefu/core`.
 */

import type {
  AppEnvironment,
  ChannelOutboxRecord,
  DeliveryAttempt,
  DeliveryFailureCode,
  InboundEvent,
  MessageDelivery,
  MessageDeliveryStatus,
  MessageStatusEvent,
  SendQuotaWindow,
} from '@kefu/core';

/** Injection token carrying the environment-selected channel reliability store. */
export const CHANNEL_RELIABILITY_REPOSITORY = Symbol('CHANNEL_RELIABILITY_REPOSITORY');

/** Data used to persist a provider callback receipt. */
export type RecordInboundEventInput = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly channel: string;
  readonly externalEventId: string;
  /** Stable digest of the accepted payload, kept for diagnostics. */
  readonly payloadHash: string;
  readonly now: string;
};

/** Result of recording a callback receipt: the row plus whether it is new. */
export type InboundEventRecord = {
  readonly event: InboundEvent;
  /** `false` when this provider event had already been received. */
  readonly created: boolean;
};

/** Data used to create the delivery of one logical outbound message. */
export type CreateDeliveryInput = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly channel: string;
  readonly externalCustomerId: string;
  readonly externalConversationId: string;
  readonly now: string;
};

/** Result of creating a delivery: the row plus whether it is new. */
export type DeliveryRecord = {
  readonly delivery: MessageDelivery;
  /** `false` when the logical message already had a delivery. */
  readonly created: boolean;
};

/** Data recorded for one provider delivery attempt. */
export type AppendAttemptInput = {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly status: MessageDeliveryStatus;
  readonly externalMessageId: string | null;
  readonly failureCode: DeliveryFailureCode | null;
  readonly failureReason: string | null;
  readonly retryable: boolean;
  readonly now: string;
};

/** Data recorded for a delivery refused before any provider attempt. */
export type RecordDegradationInput = {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly failureCode: DeliveryFailureCode;
  readonly failureReason: string;
  readonly retryable: boolean;
  readonly now: string;
};

/** Data recorded for one provider status notification. */
export type RecordStatusEventInput = {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly externalEventId: string;
  readonly status: MessageDeliveryStatus;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly now: string;
};

/**
 * Result of recording a status notification.
 *
 * `created` says whether the provider event id was new; `applied` says whether
 * the delivery state actually moved. The two differ on purpose: a duplicate
 * event is neither, and a genuine but stale or terminal event is recorded
 * (history is immutable) without moving the delivery backwards.
 */
export type StatusEventRecord = {
  readonly event: MessageStatusEvent;
  /** `false` when this provider event had already been recorded. */
  readonly created: boolean;
  /** `true` when the delivery state advanced because of this event. */
  readonly applied: boolean;
};

/** Outcome of an atomic quota reservation. */
export type QuotaReservation =
  | { readonly ok: true; readonly window: SendQuotaWindow }
  | { readonly ok: false; readonly code: DeliveryFailureCode; readonly reason: string };

/** Data used to enqueue an outbox entry for a delivery. */
export type EnqueueOutboxInput = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly now: string;
};

/** Data used to move an outbox entry to its next state. */
export type SaveOutboxStateInput = {
  readonly tenantId: string;
  readonly outboxId: string;
  readonly status: ChannelOutboxRecord['status'];
  readonly attemptCount: number;
  readonly now: string;
};

/** Data used to target one customer's reply window. */
export type QuotaWindowKey = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly channel: string;
  readonly externalCustomerId: string;
};

/**
 * Decide which channel reliability store an environment uses.
 *
 * @param appEnv - Application runtime boundary.
 * @returns `memory` for `test`, `postgres` otherwise.
 */
export function resolveChannelStorageMode(appEnv: AppEnvironment): 'memory' | 'postgres' {
  return appEnv === 'test' ? 'memory' : 'postgres';
}

/**
 * Durable provider-facing reliability facts for the channel slice.
 *
 * The mutation methods are the ones that must be atomic: reserving a quota slot
 * decides and increments in one step, and appending an attempt also moves the
 * delivery's latest state, so a caller can never observe an attempt whose
 * outcome is not reflected in the delivery.
 */
export interface ChannelReliabilityRepository {
  // --------------------------------------------------------------------------
  // Inbound callback receipts
  // --------------------------------------------------------------------------

  /** Persist a provider callback receipt; idempotent by `(tenant, event id)`. */
  recordInboundEvent(input: RecordInboundEventInput): Promise<InboundEventRecord>;
  /** One callback receipt inside the tenant scope. */
  getInboundEvent(tenantId: string, externalEventId: string): Promise<InboundEvent | undefined>;
  /** Mark a receipt processed with the message it produced. */
  completeInboundEvent(
    tenantId: string,
    externalEventId: string,
    messageId: string,
    now: string,
  ): Promise<InboundEvent | undefined>;
  /** Mark a receipt failed with a safe reason, so the outcome stays auditable. */
  failInboundEvent(
    tenantId: string,
    externalEventId: string,
    reason: string,
    now: string,
  ): Promise<InboundEvent | undefined>;

  // --------------------------------------------------------------------------
  // Deliveries and attempts
  // --------------------------------------------------------------------------

  /** Create the delivery of one logical message; idempotent by `messageId`. */
  createDelivery(input: CreateDeliveryInput): Promise<DeliveryRecord>;
  /** One delivery inside the tenant scope. */
  getDelivery(tenantId: string, deliveryId: string): Promise<MessageDelivery | undefined>;
  /** The delivery of one logical message inside the tenant scope. */
  getDeliveryByMessage(tenantId: string, messageId: string): Promise<MessageDelivery | undefined>;
  /** Deliveries of one conversation, oldest first. */
  listDeliveries(tenantId: string, conversationId: string): Promise<ReadonlyArray<MessageDelivery>>;
  /** Append one provider attempt and move the delivery to its resulting state. */
  appendAttempt(
    input: AppendAttemptInput,
  ): Promise<{ readonly attempt: DeliveryAttempt; readonly delivery: MessageDelivery }>;
  /** Record a refusal that happened before any provider attempt. */
  recordDegradation(input: RecordDegradationInput): Promise<MessageDelivery>;
  /** Provider attempts of one delivery, oldest first. */
  listAttempts(tenantId: string, deliveryId: string): Promise<ReadonlyArray<DeliveryAttempt>>;

  // --------------------------------------------------------------------------
  // Provider status notifications
  // --------------------------------------------------------------------------

  /** Record a status notification; idempotent by `(tenant, event id)`. */
  recordStatusEvent(input: RecordStatusEventInput): Promise<StatusEventRecord>;
  /** Status notifications of one delivery, oldest first. */
  listStatusEvents(
    tenantId: string,
    deliveryId: string,
  ): Promise<ReadonlyArray<MessageStatusEvent>>;

  // --------------------------------------------------------------------------
  // Reply window and outbox
  // --------------------------------------------------------------------------

  /** Open or reset a customer's reply window from the latest inbound event. */
  openQuotaWindow(key: QuotaWindowKey, now: string): Promise<SendQuotaWindow>;
  /** The customer's current reply window, if one is open. */
  getQuotaWindow(key: QuotaWindowKey): Promise<SendQuotaWindow | undefined>;
  /** Evaluate the window and take one slot in the same atomic step. */
  reserveQuotaSlot(key: QuotaWindowKey, now: string): Promise<QuotaReservation>;
  /** Return one slot after a definite provider failure. */
  releaseQuotaSlot(key: QuotaWindowKey, now: string): Promise<SendQuotaWindow | undefined>;

  /** Enqueue the outbox entry for a delivery; idempotent by `deliveryId`. */
  enqueueOutbox(input: EnqueueOutboxInput): Promise<ChannelOutboxRecord>;
  /** Move an outbox entry to its next state. */
  saveOutboxState(input: SaveOutboxStateInput): Promise<ChannelOutboxRecord>;
  /** The outbox entry of one delivery, if the delivery was ever queued. */
  getOutboxByDelivery(
    tenantId: string,
    deliveryId: string,
  ): Promise<ChannelOutboxRecord | undefined>;
}
