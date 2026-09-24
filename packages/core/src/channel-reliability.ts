/**
 * Provider-neutral channel reliability model.
 *
 * A channel adapter only moves bytes; the platform additionally has to remember
 * *what happened* to every callback and every outbound message. This module owns
 * that shared vocabulary so the in-process adapter and the durable PostgreSQL
 * adapter describe the same facts with the same types:
 *
 * - {@link InboundEvent} is the durable receipt of a provider callback, used for
 *   webhook idempotency and for recovering a callback that failed mid-way.
 * - {@link MessageDelivery} is the latest state of one *logical* outbound
 *   message at the provider, backed by the immutable
 *   {@link DeliveryAttempt} history.
 * - {@link MessageStatusEvent} is an immutable provider status notification,
 *   idempotent by its own external event id.
 * - {@link SendQuotaWindow} is the customer-service reply budget the latest
 *   inbound customer event opens.
 * - {@link ChannelOutboxRecord} is the durable outbox entry that represents a
 *   delivery still waiting to be handed to the provider.
 *
 * The window/quota rule itself lives here as a pure function
 * ({@link evaluateDeliveryWindow}) so both adapters and the application service
 * agree on it without sharing storage.
 *
 * Three facts added for the real WeCom transport are modelled the same way,
 * because each of them is a decision two independent callers have to make
 * identically:
 *
 * - {@link WeComChannelBinding} is the durable mapping from one provider
 *   customer-service account to one tenant and store.
 * - {@link WeComSyncCursor} is that binding's single `kf/sync_msg` position,
 *   plus the bounded lease that decides which caller may pull it.
 * - {@link ChannelOutboxLeaseRecord} is the outbox entry with the claim lease
 *   and retry diagnostics a worker needs, over the {@link ChannelOutboxRecord}
 *   projection migration `0006` already defines.
 *
 * The rules are pure functions here — {@link claimWeComSyncCursor},
 * {@link renewWeComSyncCursor}, {@link advanceWeComSyncCursor},
 * {@link completeWeComSyncCursor}, {@link releaseWeComSyncCursor},
 * {@link claimChannelOutbox}, {@link releaseChannelOutboxAttempt} — so the
 * durable adapter, the in-process adapter and the worker cannot disagree about
 * who owns a cursor or when an entry may be taken again. The lease duration is
 * {@link WECOM_SYNC_LEASE_MS} for the same reason: a caller that had to supply
 * its own would be a second place the policy could live.
 */

import { CHANNEL_FAILURE_CODES, type ChannelFailureCode } from './channel-contracts';

/** Lifecycle of one logical outbound message at the external provider. */
export type MessageDeliveryStatus = 'pending' | 'sent' | 'failed' | 'unknown';

/** Every delivery status the platform recognizes. */
export const MESSAGE_DELIVERY_STATUSES: ReadonlyArray<MessageDeliveryStatus> = [
  'pending',
  'sent',
  'failed',
  'unknown',
];

/**
 * Progress order of a delivery's provider state.
 *
 * Provider notifications arrive out of order and are retried by the provider
 * itself, so "apply whatever arrived last" would let a stale or late event drag
 * a delivery backwards — most damagingly, from an accepted `sent` message back
 * to `failed`, which would re-offer a retry for a message the customer already
 * received. Ranking the states makes the transition rule total and testable
 * instead of incidental: a status only ever moves a delivery *forward*.
 *
 * `sent` is the terminal state, so nothing can move a delivery out of it.
 */
export const DELIVERY_STATUS_RANK: Readonly<Record<MessageDeliveryStatus, number>> = {
  pending: 0,
  failed: 1,
  unknown: 2,
  sent: 3,
};

/**
 * Whether an incoming provider status may move a delivery forward.
 *
 * @param current - Delivery's current status.
 * @param incoming - Status the provider reports.
 * @returns `true` when `incoming` ranks above `current`.
 */
export function advancesDeliveryStatus(
  current: MessageDeliveryStatus,
  incoming: MessageDeliveryStatus,
): boolean {
  return DELIVERY_STATUS_RANK[incoming] > DELIVERY_STATUS_RANK[current];
}

/**
 * Whether the platform may hand a delivery in this state to the provider again.
 *
 * The contract is the same however the state was reached — an adapter outcome or
 * a provider status notification — so the retry endpoint and the UI can decide
 * from the delivery alone. `sent` is terminal and never retryable; every other
 * state still has a send the platform may legitimately repeat (`failed` and
 * `unknown` after an attempt, `pending` when the window or budget blocked the
 * send before it reached the provider).
 *
 * @param status - Delivery status.
 * @returns `false` only for `sent`.
 */
export function isDeliveryRetryable(status: MessageDeliveryStatus): boolean {
  return status !== 'sent';
}

/** Processing state of a provider callback persisted before business handling. */
export type InboundEventStatus = 'received' | 'processed' | 'failed';

/** Durable outbox state of one queued delivery. */
export type ChannelOutboxStatus = 'pending' | 'dispatched' | 'abandoned';

/**
 * Stable reason a delivery did not reach the provider.
 *
 * Adapter failure codes are reused verbatim, so a degradation a caller sees is
 * always traceable to the adapter result that produced it. The window/quota
 * refusals are added by the application service before any adapter call.
 */
export type DeliveryFailureCode =
  ChannelFailureCode | 'window_missing' | 'window_expired' | 'quota_exceeded';

/** Window/quota refusals the application service adds before any adapter call. */
export const DELIVERY_WINDOW_FAILURE_CODES: ReadonlyArray<DeliveryFailureCode> = [
  'window_missing',
  'window_expired',
  'quota_exceeded',
];

/**
 * Runtime mirror of {@link DeliveryFailureCode}.
 *
 * A durable adapter reads a failure code back out of a plain `TEXT` column, so
 * the value is validated against the known set before it re-enters the typed
 * domain.
 */
export const DELIVERY_FAILURE_CODES: ReadonlyArray<DeliveryFailureCode> = [
  ...CHANNEL_FAILURE_CODES,
  ...DELIVERY_WINDOW_FAILURE_CODES,
];

/**
 * Narrow a string to a known delivery failure code.
 *
 * @param value - Candidate code read from a boundary.
 * @returns `true` when the value is one of {@link DELIVERY_FAILURE_CODES}.
 */
export function isDeliveryFailureCode(value: string): value is DeliveryFailureCode {
  return DELIVERY_FAILURE_CODES.some((candidate) => candidate === value);
}

/** Hours a customer-service reply window stays open after the latest inbound event. */
export const DELIVERY_WINDOW_HOURS = 48;

/** Logical outbound messages allowed inside one open reply window. */
export const DELIVERY_WINDOW_MESSAGE_LIMIT = 5;

/** Reply-window length in milliseconds. */
export const DELIVERY_WINDOW_MS = DELIVERY_WINDOW_HOURS * 60 * 60 * 1000;

/** Durable provider callback receipt used for webhook idempotency and recovery. */
export type InboundEvent = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly channel: string;
  readonly externalEventId: string;
  /** Stable digest of the accepted payload, for diagnostics only. */
  readonly payloadHash: string;
  readonly status: InboundEventStatus;
  readonly messageId: string | null;
  readonly failureReason: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
};

/** Immutable record of one provider delivery attempt. */
export type DeliveryAttempt = {
  readonly id: string;
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly attemptNumber: number;
  readonly status: MessageDeliveryStatus;
  readonly externalMessageId: string | null;
  readonly failureCode: DeliveryFailureCode | null;
  readonly failureReason: string | null;
  readonly retryable: boolean;
  readonly attemptedAt: string;
};

/** Latest durable delivery projection for one logical outbound message. */
export type MessageDelivery = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly channel: string;
  readonly externalCustomerId: string;
  readonly externalConversationId: string;
  readonly status: MessageDeliveryStatus;
  readonly externalMessageId: string | null;
  readonly attemptCount: number;
  readonly failureCode: DeliveryFailureCode | null;
  readonly failureReason: string | null;
  readonly retryable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Immutable provider status notification applied to a delivery. */
export type MessageStatusEvent = {
  readonly id: string;
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly externalEventId: string;
  readonly status: MessageDeliveryStatus;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly createdAt: string;
};

/** Current customer-service send budget opened by the latest inbound event. */
export type SendQuotaWindow = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly channel: string;
  readonly externalCustomerId: string;
  readonly windowStartedAt: string;
  readonly windowEndsAt: string;
  readonly messageLimit: number;
  /** Logical messages already handed to the provider inside this window. */
  readonly reservedCount: number;
  readonly updatedAt: string;
};

/** Durable outbox entry for a delivery the provider has not accepted yet. */
export type ChannelOutboxRecord = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly status: ChannelOutboxStatus;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Refusal produced by {@link evaluateDeliveryWindow}. */
export type DeliveryWindowRefusal = {
  readonly allowed: false;
  readonly code: Extract<
    DeliveryFailureCode,
    'window_missing' | 'window_expired' | 'quota_exceeded'
  >;
  readonly reason: string;
};

/** Outcome of one reply-window evaluation. */
export type DeliveryWindowDecision =
  { readonly allowed: true; readonly window: SendQuotaWindow } | DeliveryWindowRefusal;

/**
 * Compute the instant a reply window opened at `openedAt` closes.
 *
 * The returned instant is the *exclusive* end of the window: the interval a
 * customer's latest message opens is `[openedAt, openedAt + 48h)`, so a delivery
 * evaluated at exactly this instant is outside the window, not inside it.
 * {@link evaluateDeliveryWindow} is the rule that enforces that reading.
 *
 * @param openedAt - Instant the latest inbound customer event was accepted.
 * @returns The exclusive end of the window as an ISO timestamp.
 */
export function deliveryWindowEndsAt(openedAt: string): string {
  return new Date(Date.parse(openedAt) + DELIVERY_WINDOW_MS).toISOString();
}

/**
 * Decide whether a logical message may be handed to the provider right now.
 *
 * The rule is the customer-service one: the latest inbound customer event opens
 * a {@link DELIVERY_WINDOW_HOURS}-hour window, inside which at most
 * {@link DELIVERY_WINDOW_MESSAGE_LIMIT} logical messages may be sent. Outside
 * the window, or above the budget, the delivery must be refused *before* the
 * adapter is called, so a refusal can never reach a real customer.
 *
 * The window is `[windowStartedAt, windowEndsAt)`: the instant it opened is
 * inside it and the instant it ends is not. `now >= windowEndsAt` is therefore
 * the closing test rather than a strict comparison — a delivery evaluated at
 * exactly `windowEndsAt` is refused, which is the same reading the inclusive
 * start gives the interval.
 *
 * @param window - The customer's current window, or `undefined` when no inbound
 * event has opened one yet.
 * @param now - Evaluation instant (ISO).
 * @returns An allowed decision carrying the window, or a stable refusal.
 */
export function evaluateDeliveryWindow(
  window: SendQuotaWindow | undefined,
  now: string,
): DeliveryWindowDecision {
  if (window === undefined) {
    return {
      allowed: false,
      code: 'window_missing',
      reason: 'no inbound customer message has opened a reply window for this customer',
    };
  }
  if (Date.parse(now) >= Date.parse(window.windowEndsAt)) {
    return {
      allowed: false,
      code: 'window_expired',
      reason: `the ${DELIVERY_WINDOW_HOURS}-hour reply window closed at ${window.windowEndsAt}`,
    };
  }
  if (window.reservedCount >= window.messageLimit) {
    return {
      allowed: false,
      code: 'quota_exceeded',
      reason: `the ${window.messageLimit}-message reply budget for this window is exhausted`,
    };
  }
  return { allowed: true, window };
}

/** Latest delivery status an adapter failure maps to. */
export function deliveryStatusForFailure(failure: {
  readonly code: ChannelFailureCode;
  readonly deliveryUnknown?: boolean | undefined;
}): MessageDeliveryStatus {
  return failure.deliveryUnknown === true ? 'unknown' : 'failed';
}

// ---------------------------------------------------------------------------
// WeCom account binding (migration 0007)
// ---------------------------------------------------------------------------

/** Lifecycle of one provider customer-service account binding. */
export type WeComBindingStatus = 'active' | 'disabled';

/**
 * Runtime mirror of {@link WeComBindingStatus}.
 *
 * A durable adapter reads the status back out of a plain `TEXT` column, so the
 * value is validated against the known set before it re-enters the typed domain.
 */
export const WECOM_BINDING_STATUSES: ReadonlyArray<WeComBindingStatus> = ['active', 'disabled'];

/**
 * Narrow a string to a known binding status.
 *
 * @param value - Candidate status read from a boundary.
 * @returns `true` when the value is one of {@link WECOM_BINDING_STATUSES}.
 */
export function isWeComBindingStatus(value: string): value is WeComBindingStatus {
  return WECOM_BINDING_STATUSES.some((candidate) => candidate === value);
}

/**
 * Durable binding of one provider customer-service account to a platform scope.
 *
 * The pair `(corpId, openKfId)` identifies the account at the provider; the pair
 * `(tenantId, storeId)` is the only scope a callback arriving on that account may
 * write to. At most one binding per account is `active`; a `disabled` one is kept
 * so rebinding the account elsewhere stays auditable, and `disabledAt` records
 * when it stopped applying.
 */
export type WeComChannelBinding = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly corpId: string;
  readonly openKfId: string;
  readonly status: WeComBindingStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set exactly when {@link WeComChannelBinding.status} is `disabled`. */
  readonly disabledAt: string | null;
};

/** Whether a binding may currently resolve a provider callback or a pull. */
export function isWeComBindingActive(binding: WeComChannelBinding): boolean {
  return binding.status === 'active';
}

/**
 * What a caller asks the platform to bind, before it has an identity or a time.
 *
 * The four scope fields are the whole of a binding: the account is the pair the
 * provider carries in the clear, and the scope is the one place a callback on
 * that account may be written to. There is no fifth field — nothing about a
 * binding is a credential.
 */
export type WeComBindingDraft = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly corpId: string;
  readonly openKfId: string;
  /** Whether the binding applies as soon as it is written. */
  readonly enabled: boolean;
};

/**
 * Build the binding row one request asks for, or refuse it.
 *
 * This is the one place a binding is born, so both adapters call it rather than
 * each assembling a row of its own: the durable store writes what it returns,
 * and the in-process store keeps it. A rule fixed here is therefore fixed for
 * both — which is the same reason the cursor transitions are shared.
 *
 * Every scope field is trimmed, and one that trims to nothing is refused rather
 * than stored: an account identified by a blank `corp_id` is not the account any
 * callback would carry, so writing it would create a row that can never resolve
 * and that nothing can match. The refusal is a decision (`undefined`), not an
 * error: the caller asked for a binding the platform cannot hold, and says so.
 *
 * Two requests that differ only in surrounding whitespace produce the *same*
 * row, which is what lets the durable store's one-active-binding-per-account
 * index answer a near-duplicate with a conflict instead of a second row.
 *
 * @param input - Row identity, the request, and the instant it is made.
 * @returns The binding to store, or `undefined` when a scope field is blank.
 */
export function createWeComBinding(input: {
  readonly id: string;
  readonly draft: WeComBindingDraft;
  readonly now: string;
}): WeComChannelBinding | undefined {
  const tenantId = input.draft.tenantId.trim();
  const storeId = input.draft.storeId.trim();
  const corpId = input.draft.corpId.trim();
  const openKfId = input.draft.openKfId.trim();
  if (
    tenantId.length === 0 ||
    storeId.length === 0 ||
    corpId.length === 0 ||
    openKfId.length === 0
  ) {
    return undefined;
  }
  return {
    id: input.id,
    tenantId,
    storeId,
    corpId,
    openKfId,
    status: input.draft.enabled ? 'active' : 'disabled',
    createdAt: input.now,
    updatedAt: input.now,
    // The table's invariant is `(status = 'disabled') = (disabled_at IS NOT
    // NULL)`, so a binding born switched off carries the time it was made
    // rather than an ambiguous empty column.
    disabledAt: input.draft.enabled ? null : input.now,
  };
}

// ---------------------------------------------------------------------------
// `kf/sync_msg` cursor ownership (migration 0007)
// ---------------------------------------------------------------------------

/**
 * Durable `kf/sync_msg` position of one binding, with its pull lease.
 *
 * There is one row per binding because the position belongs to the provider
 * account, not to a caller: a second concurrent callback has to contend for the
 * lease instead of pulling the same window from the same cursor. `leaseOwner`
 * and `leaseExpiresAt` are the claim; an owner that dies leaves the cursor
 * recoverable once the lease expires, and a pull that finishes only advances the
 * cursor it still owns, so a stale owner can never overwrite a newer position.
 */
export type WeComSyncCursor = {
  readonly id: string;
  readonly tenantId: string;
  readonly bindingId: string;
  /** Provider cursor to resume from; `null` until the first successful pull. */
  readonly cursor: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** How long one `kf/sync_msg` pull may own its binding's cursor. */
export const WECOM_SYNC_LEASE_MS = 60_000;

/**
 * Whether a value is a usable `kf/sync_msg` position.
 *
 * The provider's cursor is opaque, but "no position at all" is not a position:
 * a page that answers without one has told the caller nothing about where the
 * backlog resumes. Storing that answer would overwrite a real position with
 * nothing, so both the adapter that reads the provider's answer and the stores
 * that persist it test the value with this one predicate instead of each
 * deciding for itself what an empty cursor looks like.
 *
 * @param value - Candidate position, as read from a boundary.
 * @returns `true` when the value is a non-blank string.
 */
export function isWeComSyncCursorPosition(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Whether some owner currently holds the cursor's lease.
 *
 * A lease without an expiry cannot hold anything: the pair is written together,
 * and the schema refuses an expiry without an owner, so a half-written lease is
 * treated as unclaimed rather than as a lock nobody can release.
 *
 * @param cursor - The binding's cursor row.
 * @param now - Evaluation instant (ISO).
 * @returns `true` when an owner holds an unexpired lease.
 */
export function isWeComSyncLeaseActive(cursor: WeComSyncCursor, now: string): boolean {
  return (
    cursor.leaseOwner !== null &&
    cursor.leaseExpiresAt !== null &&
    Date.parse(cursor.leaseExpiresAt) > Date.parse(now)
  );
}

/**
 * Whether `owner` may take or renew the cursor's lease.
 *
 * @param cursor - The binding's cursor row.
 * @param owner - Opaque worker identity asking for the pull.
 * @param now - Evaluation instant (ISO).
 * @returns `true` when no lease is live, or the live lease is this owner's.
 */
export function canClaimWeComSyncCursor(
  cursor: WeComSyncCursor,
  owner: string,
  now: string,
): boolean {
  return !isWeComSyncLeaseActive(cursor, now) || cursor.leaseOwner === owner;
}

/**
 * Take (or renew) the lease on a binding's cursor.
 *
 * Taking the lease is one short write and nothing else: the provider pull happens
 * afterwards, outside any database transaction, which is what makes a slow or
 * failed `kf/sync_msg` call unable to hold a row lock open.
 *
 * @param cursor - The binding's cursor row.
 * @param owner - Opaque worker identity asking for the pull.
 * @param now - Claim instant (ISO).
 * @returns The claimed cursor, or `undefined` when another owner holds it.
 * @throws When `owner` is empty, which would make ownership unverifiable.
 */
export function claimWeComSyncCursor(
  cursor: WeComSyncCursor,
  owner: string,
  now: string,
): WeComSyncCursor | undefined {
  assertLeaseOwner(owner);
  if (!canClaimWeComSyncCursor(cursor, owner, now)) {
    return undefined;
  }
  return {
    ...cursor,
    leaseOwner: owner,
    leaseExpiresAt: new Date(Date.parse(now) + WECOM_SYNC_LEASE_MS).toISOString(),
    updatedAt: now,
  };
}

/**
 * Extend the lease of a pull that still holds it.
 *
 * Compare-by-owner and nothing else, deliberately: the caller is asking to keep
 * a claim it already has, so an owner whose lease lapsed and was taken over must
 * be refused *even though* the expired lease itself is reclaimable. That is how
 * a slow pull that lost its claim learns to stop instead of resuming work it no
 * longer owns. The position is untouched, so a renewal never moves the cursor.
 *
 * @param cursor - The binding's cursor row.
 * @param owner - Opaque worker identity asking to keep the pull.
 * @param now - Renewal instant (ISO).
 * @returns The renewed cursor, or `undefined` when the lease is not this owner's.
 * @throws When `owner` is empty, which would make ownership unverifiable.
 */
export function renewWeComSyncCursor(
  cursor: WeComSyncCursor,
  owner: string,
  now: string,
): WeComSyncCursor | undefined {
  assertLeaseOwner(owner);
  if (cursor.leaseOwner !== owner) {
    return undefined;
  }
  return {
    ...cursor,
    leaseExpiresAt: new Date(Date.parse(now) + WECOM_SYNC_LEASE_MS).toISOString(),
    updatedAt: now,
  };
}

/**
 * Advance the cursor to the position a page reached, keeping the lease.
 *
 * A pull that still has pages to fetch still owns the account, so the position
 * moves while the claim stays; {@link releaseWeComSyncCursor} is what ends it
 * once the pull is over. Splitting the two is what makes a multi-page pull a
 * sequence of durable positions rather than one write at the end that a crash
 * would lose.
 *
 * Compare-by-owner, exactly like {@link completeWeComSyncCursor}: a stale owner
 * cannot rewind a newer position. The position itself is required to be a real
 * one — {@link isWeComSyncCursorPosition} — because advancing to "no position"
 * would erase where the account has been pulled to.
 *
 * @param cursor - The binding's cursor row.
 * @param owner - Opaque worker identity that performed the pull.
 * @param nextCursor - Provider position the page reached.
 * @param now - Advance instant (ISO).
 * @returns The advanced cursor, or `undefined` when the lease is not this owner's.
 * @throws When `owner` is empty, or `nextCursor` is blank.
 */
export function advanceWeComSyncCursor(
  cursor: WeComSyncCursor,
  owner: string,
  nextCursor: string,
  now: string,
): WeComSyncCursor | undefined {
  assertLeaseOwner(owner);
  if (!isWeComSyncCursorPosition(nextCursor)) {
    throw new Error('channel invariant: a kf/sync_msg position must not be blank');
  }
  if (cursor.leaseOwner !== owner) {
    return undefined;
  }
  return {
    ...cursor,
    cursor: nextCursor.trim(),
    lastSyncedAt: now,
    updatedAt: now,
  };
}

/**
 * Release the lease after a pull that did not produce a position.
 *
 * Releasing early is what keeps a failed pull from blocking the account until the
 * lease expires: the next caller resumes from the same cursor, so no window is
 * skipped. Compare-by-owner applies here too, so a stale owner cannot release a
 * lease another caller has since taken.
 *
 * @param cursor - The binding's cursor row.
 * @param owner - Opaque worker identity releasing the pull.
 * @param now - Release instant (ISO).
 * @returns The released cursor, or `undefined` when the lease is not this owner's.
 * @throws When `owner` is empty, which would make ownership unverifiable.
 */
export function releaseWeComSyncCursor(
  cursor: WeComSyncCursor,
  owner: string,
  now: string,
): WeComSyncCursor | undefined {
  assertLeaseOwner(owner);
  if (cursor.leaseOwner !== owner) {
    return undefined;
  }
  return { ...cursor, leaseOwner: null, leaseExpiresAt: null, updatedAt: now };
}

/**
 * Advance the cursor to the position a pull produced, releasing the lease.
 *
 * Completion is compare-by-owner and not compare-by-expiry: expiry only decides
 * *when* another caller may claim, and that claim overwrites `leaseOwner`, so an
 * owner whose lease lapsed while it was still working simply fails this check
 * instead of overwriting the newer position of the caller that took over. That is
 * the whole point of the lease — progress is never silently rewound.
 *
 * @param cursor - The binding's cursor row.
 * @param owner - Opaque worker identity that performed the pull.
 * @param nextCursor - Provider position the pull reached.
 * @param now - Completion instant (ISO).
 * @returns The completed cursor, or `undefined` when the lease is not this owner's.
 * @throws When `owner` is empty, which would make ownership unverifiable.
 */
export function completeWeComSyncCursor(
  cursor: WeComSyncCursor,
  owner: string,
  nextCursor: string,
  now: string,
): WeComSyncCursor | undefined {
  assertLeaseOwner(owner);
  if (cursor.leaseOwner !== owner) {
    return undefined;
  }
  return {
    ...cursor,
    cursor: nextCursor,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastSyncedAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Crash-safe outbox claiming (migration 0007)
// ---------------------------------------------------------------------------

/** How long one worker owns a claimed outbox entry before the claim expires. */
export const CHANNEL_OUTBOX_LEASE_MS = 60_000;

/**
 * Dispatch attempts one queued delivery may consume before it is abandoned.
 *
 * The attempt is counted when an entry is *claimed*, not when it fails: a worker
 * that dies mid-dispatch has still spent that attempt, so a crash loop exhausts
 * the budget instead of retrying for ever.
 */
export const CHANNEL_OUTBOX_MAX_ATTEMPTS = 5;

/** Delay before the second dispatch attempt. */
export const CHANNEL_OUTBOX_RETRY_BASE_MS = 30_000;

/** Ceiling of the exponential retry delay. */
export const CHANNEL_OUTBOX_RETRY_MAX_MS = 15 * 60_000;

/**
 * How long to wait before the attempt after `attemptCount` spent attempts.
 *
 * Backoff is exponential from {@link CHANNEL_OUTBOX_RETRY_BASE_MS} and capped at
 * {@link CHANNEL_OUTBOX_RETRY_MAX_MS}, so a provider outage delays retries
 * instead of hammering the provider, and the delay stays bounded. It lives here
 * rather than in the worker so the schedule a queued entry carries is agreed by
 * every writer of `channel_outbox`.
 *
 * @param attemptCount - Attempts already claimed for this entry.
 * @returns Delay in milliseconds; `0` when no attempt has been claimed yet.
 */
export function outboxRetryDelayMs(attemptCount: number): number {
  if (attemptCount <= 0) {
    return 0;
  }
  // The exponent is bounded before the shift, so a corrupted counter cannot
  // produce an overflowing delay.
  const exponent = Math.min(attemptCount - 1, 16);
  return Math.min(CHANNEL_OUTBOX_RETRY_BASE_MS * 2 ** exponent, CHANNEL_OUTBOX_RETRY_MAX_MS);
}

/**
 * Outbox fields migration `0007` adds for claiming and for retry diagnostics.
 *
 * All four are nullable: every row migration `0006` wrote stays valid, unclaimed
 * and without a recorded failure.
 */
export type ChannelOutboxClaimState = {
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  /** Failure code of the last failed dispatch attempt, validated on the way in. */
  readonly lastFailureCode: DeliveryFailureCode | null;
  /** Stable caller-authored explanation of that failure. Never provider payload. */
  readonly lastFailureReason: string | null;
};

/**
 * Durable outbox entry including its claim state.
 *
 * The `0006` projection plus the `0007` columns: the projection is what the
 * existing readers already consume, and the claim state is what a worker adds
 * when it takes an entry.
 */
export type ChannelOutboxLeaseRecord = ChannelOutboxRecord & ChannelOutboxClaimState;

/** Reason a due outbox entry cannot be claimed right now. */
export type ChannelOutboxClaimRefusalCode =
  'not_pending' | 'attempts_exhausted' | 'lease_held' | 'not_due';

/**
 * Why each refusal code refuses, in a form safe to surface to an operator.
 *
 * The wording is fixed, so two callers reporting the same refusal describe it
 * identically and no provider text can leak into a diagnostic.
 */
const CHANNEL_OUTBOX_CLAIM_REFUSAL_REASONS: Readonly<
  Record<ChannelOutboxClaimRefusalCode, string>
> = {
  not_pending: 'the outbox entry already reached a terminal state',
  attempts_exhausted: `the outbox entry spent its ${CHANNEL_OUTBOX_MAX_ATTEMPTS} dispatch attempts`,
  lease_held: 'another worker holds a live lease on the outbox entry',
  not_due: 'the outbox entry is not due yet',
};

/** Outcome of one attempt to claim a due outbox entry. */
export type ChannelOutboxClaim =
  | { readonly claimed: true; readonly record: ChannelOutboxLeaseRecord }
  | {
      readonly claimed: false;
      readonly code: ChannelOutboxClaimRefusalCode;
      readonly reason: string;
    };

/**
 * Whether a worker currently holds a live lease on an outbox entry.
 *
 * @param record - The outbox entry.
 * @param now - Evaluation instant (ISO).
 * @returns `true` when an owner holds an unexpired lease.
 */
export function isChannelOutboxLeaseActive(record: ChannelOutboxLeaseRecord, now: string): boolean {
  return (
    record.leaseOwner !== null &&
    record.leaseExpiresAt !== null &&
    Date.parse(record.leaseExpiresAt) > Date.parse(now)
  );
}

/**
 * The reason a due outbox entry cannot be claimed, or `null` when it can.
 *
 * This is the predicate a durable claim has to reproduce in SQL
 * (`status = 'pending'`, `available_at` reached, no live lease, attempts left) —
 * keeping it here as one ordered rule is what stops the two from drifting. The
 * order is deliberate: the entry's own terminal state and its spent budget are
 * reported before the transient claim state, so a refusal names the reason that
 * will not go away on its own.
 *
 * An expired lease is *not* a refusal: that is exactly the recovery path, where a
 * worker that died leaves its entry claimable again.
 *
 * @param record - The outbox entry.
 * @param now - Evaluation instant (ISO).
 * @returns A refusal code, or `null` when the entry may be claimed.
 */
export function channelOutboxClaimRefusal(
  record: ChannelOutboxLeaseRecord,
  now: string,
): ChannelOutboxClaimRefusalCode | null {
  if (record.status !== 'pending') {
    return 'not_pending';
  }
  if (record.attemptCount >= CHANNEL_OUTBOX_MAX_ATTEMPTS) {
    return 'attempts_exhausted';
  }
  if (isChannelOutboxLeaseActive(record, now)) {
    return 'lease_held';
  }
  if (Date.parse(record.availableAt) > Date.parse(now)) {
    return 'not_due';
  }
  return null;
}

/**
 * Claim a due outbox entry for one worker.
 *
 * Claiming spends an attempt and takes the lease in one step, so the durable
 * adapter can make it a single conditional `UPDATE ... WHERE` (or
 * `SELECT ... FOR UPDATE SKIP LOCKED`) and no transaction is held across the
 * provider call that follows. `availableAt` is left alone: the lease, not the
 * schedule, decides who may run now.
 *
 * @param record - The outbox entry.
 * @param owner - Opaque worker identity taking the entry.
 * @param now - Claim instant (ISO).
 * @returns The claim, or the stable refusal that prevented it.
 * @throws When `owner` is empty, which would make ownership unverifiable.
 */
export function claimChannelOutbox(
  record: ChannelOutboxLeaseRecord,
  owner: string,
  now: string,
): ChannelOutboxClaim {
  assertLeaseOwner(owner);
  const refusal = channelOutboxClaimRefusal(record, now);
  if (refusal !== null) {
    return { claimed: false, code: refusal, reason: CHANNEL_OUTBOX_CLAIM_REFUSAL_REASONS[refusal] };
  }
  return {
    claimed: true,
    record: {
      ...record,
      attemptCount: record.attemptCount + 1,
      leaseOwner: owner,
      leaseExpiresAt: new Date(Date.parse(now) + CHANNEL_OUTBOX_LEASE_MS).toISOString(),
      updatedAt: now,
    },
  };
}

/**
 * Close a claimed entry the provider accepted.
 *
 * Compare-by-owner, so a worker whose claim expired and was taken over cannot
 * close work it no longer owns. The retry diagnostics are cleared: they describe
 * an attempt that has since succeeded, and the authoritative per-attempt history
 * stays on `message_delivery_attempts`, which `0006` owns.
 *
 * @param record - The claimed outbox entry.
 * @param owner - Opaque worker identity that dispatched it.
 * @param now - Completion instant (ISO).
 * @returns The dispatched entry, or `undefined` when the claim is not this owner's.
 * @throws When `owner` is empty, which would make ownership unverifiable.
 */
export function markChannelOutboxDispatched(
  record: ChannelOutboxLeaseRecord,
  owner: string,
  now: string,
): ChannelOutboxLeaseRecord | undefined {
  assertLeaseOwner(owner);
  if (record.status !== 'pending' || record.leaseOwner !== owner) {
    return undefined;
  }
  return {
    ...record,
    status: 'dispatched',
    leaseOwner: null,
    leaseExpiresAt: null,
    lastFailureCode: null,
    lastFailureReason: null,
    updatedAt: now,
  };
}

/**
 * Release a claimed entry after an attempt that did not reach the provider.
 *
 * Bounded in one step: the attempt was already spent by the claim, so while the
 * budget has room the entry returns to `pending` with the next attempt scheduled
 * by {@link outboxRetryDelayMs}, and once the budget is spent the same call
 * abandons it. That leaves no state where an entry is pending with no attempt
 * left to give, which is what makes the retry bound real rather than advisory.
 *
 * Compare-by-owner, like {@link markChannelOutboxDispatched}: an entry another
 * worker has since claimed is not this caller's to reschedule.
 *
 * @param record - The claimed outbox entry.
 * @param owner - Opaque worker identity that attempted the dispatch.
 * @param failure - Failure code and a stable caller-authored reason. The reason
 *   is stored and surfaced, so it must never carry provider payload text or a
 *   credential.
 * @param now - Release instant (ISO).
 * @returns The rescheduled or abandoned entry, or `undefined` when the claim is
 *   not this owner's.
 * @throws When `owner` is empty, which would make ownership unverifiable.
 */
export function releaseChannelOutboxAttempt(
  record: ChannelOutboxLeaseRecord,
  owner: string,
  failure: { readonly code: DeliveryFailureCode; readonly reason: string },
  now: string,
): ChannelOutboxLeaseRecord | undefined {
  assertLeaseOwner(owner);
  if (record.status !== 'pending' || record.leaseOwner !== owner) {
    return undefined;
  }
  const released: ChannelOutboxLeaseRecord = {
    ...record,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastFailureCode: failure.code,
    lastFailureReason: failure.reason,
    updatedAt: now,
  };
  if (record.attemptCount >= CHANNEL_OUTBOX_MAX_ATTEMPTS) {
    return { ...released, status: 'abandoned' };
  }
  return {
    ...released,
    availableAt: new Date(Date.parse(now) + outboxRetryDelayMs(record.attemptCount)).toISOString(),
  };
}

/**
 * Reject an empty lease owner.
 *
 * Ownership is compared by value, so an empty owner would make every
 * compare-by-owner check succeed at once — the invariant the lease exists to
 * protect. Failing loudly here keeps that from being a silent data problem.
 *
 * @param owner - Candidate owner.
 * @throws When `owner` is empty or whitespace only.
 */
function assertLeaseOwner(owner: string): void {
  if (owner.trim().length === 0) {
    throw new Error('channel invariant: a lease owner must not be empty');
  }
}
