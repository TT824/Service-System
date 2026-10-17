/**
 * The durable half of the Worker's outbox loop.
 *
 * This port is the whole database surface the delivery processor is allowed to
 * touch, and it is deliberately narrow. Three things follow from that, and all
 * three are the point:
 *
 * 1. **No transaction, and no connection, is reachable from the processor.**
 *    The processor holds an {@link OutboxRepository} and a
 *    `WecomOutboundTransport` and nothing else, so there is no way for it to
 *    hold a row lock or an open transaction across the provider call. A
 *    statement that must serialise is a *method* here, and it finishes before
 *    the method returns.
 * 2. **The claim is one atomic statement.** {@link OutboxRepository.claimDue}
 *    selects due entries with `FOR UPDATE SKIP LOCKED` and updates them in the
 *    same statement, so two Workers racing over one queue cannot claim the same
 *    attempt, and the claim spends the attempt and takes the lease together.
 * 3. **Every rule the processor applies is a `@kefu/core` policy.** The claim
 *    predicate, the retry schedule, the lease length, the attempt bound and the
 *    delivery-status ordering all come from `@kefu/core`, so this port can be
 *    re-implemented (the in-memory double a unit test uses) without the two
 *    implementations disagreeing about when an entry may be taken.
 * 4. **Ownership is re-checked before the provider is called.**
 *    {@link OutboxRepository.renewOutboxLease} is the one statement between the
 *    reply-window reservation and the send: a claim that was taken over while the
 *    Worker was preparing has lost the right to send, and learns so before the
 *    provider hears from it rather than after.
 *
 * Nothing here is provider-specific, and nothing here ever stores provider
 * payload text: a failure is a `@kefu/core` failure code plus a platform-authored
 * reason.
 */

import type {
  ChannelOutboxLeaseRecord,
  DeliveryAttempt,
  DeliveryFailureCode,
  MessageDelivery,
  MessageType,
  ProviderMediaRef,
  SendQuotaWindow,
} from '@kefu/core';

/** The reply-window a delivery is gated by. */
export type QuotaWindowKey = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly channel: string;
  readonly externalCustomerId: string;
};

/** One logical platform message, as the Worker needs it to send one. */
export type OutboxMessage = {
  readonly id: string;
  readonly tenantId: string;
  readonly messageType: MessageType;
  readonly content: string;
  /**
   * The provider's handle for this message's media, when it has any.
   *
   * Read from the row rather than carried on the outbox entry, because the
   * handle is a fact about the message and not about the attempt: the API
   * uploaded the bytes before writing either, and every retry has to name the
   * same handle. The entry itself stores no payload by design — see
   * {@link OutboxRepository} — so this is the one thing a retry recovers from
   * the message row rather than from the queue.
   *
   * Both halves or neither: a row with a type and no handle is a message whose
   * upload never happened, and {@link providerMediaOf} reads it as "no media"
   * rather than sending a bubble that could never be played.
   */
  readonly media: ProviderMediaRef | null;
};

/**
 * Outcome of reserving one reply-window slot.
 *
 * A refusal is a value rather than a throw, exactly like the API's reservation:
 * "the customer's window is closed" is an ordinary answer the loop reports and
 * retries, not a fault.
 */
export type QuotaReservation =
  | { readonly ok: true; readonly window: SendQuotaWindow }
  | {
      readonly ok: false;
      readonly code: Extract<
        DeliveryFailureCode,
        'window_missing' | 'window_expired' | 'quota_exceeded'
      >;
      readonly reason: string;
    };

/** One provider attempt to append to an existing delivery. */
export type ProviderAttemptInput = {
  readonly tenantId: string;
  readonly deliveryId: string;
  /**
   * Status this attempt observed at the provider.
   *
   * Recorded as immutable history. The *delivery's* status only moves forward
   * (see {@link OutboxRepository.appendProviderAttempt}), so a stale attempt can
   * never drag an accepted delivery backwards.
   */
  readonly status: MessageDelivery['status'];
  readonly externalMessageId: string | null;
  readonly failureCode: DeliveryFailureCode | null;
  readonly failureReason: string | null;
  readonly retryable: boolean;
  readonly now: string;
};

/** Result of appending one provider attempt. */
export type ProviderAttemptRecord = {
  readonly attempt: DeliveryAttempt;
  /** The delivery projection after the attempt, monotonic in status. */
  readonly delivery: MessageDelivery;
};

/** A stable, platform-authored reason to store on a released or abandoned entry. */
export type OutboxFailure = {
  readonly code: DeliveryFailureCode;
  readonly reason: string;
};

/**
 * Durable outbox state for the Worker.
 *
 * Every method is one round trip (or one short transaction) that completes
 * before it returns. None of them performs a provider call, and none of them is
 * called while a provider call is in flight.
 */
export interface OutboxRepository {
  /**
   * Claim up to `limit` due entries for `owner`.
   *
   * The claim spends one dispatch attempt and takes the lease on each entry it
   * returns: an entry that is not `pending`, has spent
   * `CHANNEL_OUTBOX_MAX_ATTEMPTS`, is not yet due, or carries an unexpired lease
   * is never returned. An *expired* lease is deliberately claimable — that is how
   * a Worker that died is recovered instead of leaving the entry stuck.
   *
   * @param owner - This Worker's opaque identity.
   * @param now - Claim instant (ISO).
   * @param limit - Maximum entries to claim in this call.
   * @returns The claimed entries, oldest due first. May be empty.
   */
  claimDue(
    owner: string,
    now: string,
    limit: number,
  ): Promise<ReadonlyArray<ChannelOutboxLeaseRecord>>;

  /**
   * Abandon every entry that is pending with its attempt budget spent.
   *
   * The recovery path for a Worker that died holding the *last* claim: the entry
   * is pending, at `CHANNEL_OUTBOX_MAX_ATTEMPTS`, and therefore unclaimable — so
   * without this sweep it would stay pending for ever. Only entries with no live
   * lease are swept, so a healthy Worker's in-flight final attempt is untouched.
   *
   * @param now - Sweep instant (ISO).
   * @returns How many entries were abandoned.
   */
  sweepExhausted(now: string): Promise<number>;

  /**
   * Re-validate this owner's claim and extend its lease, immediately before a
   * provider call.
   *
   * Compare-by-owner and nothing else, deliberately: a Worker asking to keep a
   * claim it already holds must be refused when its lease has since been taken
   * over — *even though* the expired lease itself was reclaimable — because that
   * refusal is the only thing standing between a slow Worker and a second
   * delivery of the same message. A caller that gets `undefined` must not send.
   *
   * The renewal is also what gives the send a full lease to live in rather than
   * the remainder of the claim's, which is what makes the bounded provider call
   * (see `provider-call-bound.ts`) provably fit.
   *
   * @param record - The claimed entry.
   * @param owner - This Worker's opaque identity.
   * @param now - Renewal instant (ISO).
   * @returns The renewed entry, or `undefined` when the claim is no longer this
   *   owner's — or the entry is no longer pending.
   */
  renewOutboxLease(
    record: ChannelOutboxLeaseRecord,
    owner: string,
    now: string,
  ): Promise<ChannelOutboxLeaseRecord | undefined>;

  /**
   * Close a claimed entry the provider accepted.
   *
   * Compare-by-owner: a Worker whose lease expired and was taken over cannot
   * close work it no longer owns.
   *
   * @param record - The claimed entry.
   * @param owner - This Worker's opaque identity.
   * @param now - Completion instant (ISO).
   * @returns `true` when this owner's claim was closed.
   */
  completeOutbox(record: ChannelOutboxLeaseRecord, owner: string, now: string): Promise<boolean>;

  /**
   * Release a claimed entry after a retryable attempt, scheduling the next one.
   *
   * `available_at` becomes `now + outboxRetryDelayMs(attemptCount)`, and once the
   * attempt budget is spent the same call abandons the entry — the two bounds are
   * one step, so no state exists where an entry is pending with no attempt left
   * to give.
   *
   * @param record - The claimed entry.
   * @param owner - This Worker's opaque identity.
   * @param failure - Failure code and platform-authored reason.
   * @param now - Release instant (ISO).
   * @returns The rescheduled or abandoned entry, or `undefined` when this owner
   *   no longer holds the claim.
   */
  releaseOutbox(
    record: ChannelOutboxLeaseRecord,
    owner: string,
    failure: OutboxFailure,
    now: string,
  ): Promise<ChannelOutboxLeaseRecord | undefined>;

  /**
   * Abandon a claimed entry now, whatever budget it has left.
   *
   * The outcome that must never be retried automatically: a definite
   * non-retryable failure, and an `unknown` outcome — which the platform must
   * stop on because the provider may already have delivered the message.
   *
   * @param record - The claimed entry.
   * @param owner - This Worker's opaque identity.
   * @param failure - Failure code and platform-authored reason.
   * @param now - Abandon instant (ISO).
   * @returns `true` when this owner's claim was abandoned.
   */
  abandonOutbox(
    record: ChannelOutboxLeaseRecord,
    owner: string,
    failure: OutboxFailure,
    now: string,
  ): Promise<boolean>;

  /** One delivery inside the tenant scope, or `undefined`. */
  getDelivery(tenantId: string, deliveryId: string): Promise<MessageDelivery | undefined>;

  /** One platform message inside the tenant scope, or `undefined`. */
  getMessage(tenantId: string, messageId: string): Promise<OutboxMessage | undefined>;

  /** The customer's current reply window, or `undefined` when none is open. */
  getQuotaWindow(key: QuotaWindowKey): Promise<SendQuotaWindow | undefined>;

  /**
   * Evaluate and reserve one reply-window slot in a single serialised step.
   *
   * The window row is locked before it is evaluated, so two concurrent Workers
   * can never both read "one slot left" and both take it.
   */
  reserveQuotaSlot(key: QuotaWindowKey, now: string): Promise<QuotaReservation>;

  /**
   * Give back one reserved slot after a *definite* failure.
   *
   * Never called for an `unknown` outcome: the provider may have accepted the
   * message, and returning the slot would let the platform spend a budget it
   * already used.
   */
  releaseQuotaSlot(key: QuotaWindowKey, now: string): Promise<void>;

  /**
   * Append one provider attempt to an existing delivery and re-project it.
   *
   * The delivery row is locked first, so two concurrent attempts serialise onto
   * consecutive attempt numbers, and the delivery's status only moves forward —
   * a `sent` delivery stays `sent` whatever a late attempt observed.
   */
  appendProviderAttempt(input: ProviderAttemptInput): Promise<ProviderAttemptRecord>;

  /**
   * Record that a delivery was blocked before it reached the provider.
   *
   * Used for the reply-window and budget refusals, which are decided *before*
   * any provider call, so they produce no attempt row — only a degradation on
   * the delivery. The delivery's status is left alone when it already reached
   * `sent`, so a degradation can never rewind an accepted message.
   */
  recordDegradation(input: {
    readonly tenantId: string;
    readonly deliveryId: string;
    readonly failureCode: DeliveryFailureCode;
    readonly failureReason: string;
    readonly retryable: boolean;
    readonly now: string;
  }): Promise<MessageDelivery | undefined>;
}
