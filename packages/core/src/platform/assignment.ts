/**
 * Conversation assignment: agent availability, automatic assignment and its
 * history.
 *
 * ## The rule
 *
 * 1. **A conversation entering the pool is due for assignment immediately.**
 *    New conversations, conversations reopened by a new inbound message, and
 *    conversations an agent handed back all become due at the instant they
 *    enter the pool.
 * 2. **The sweep gives it to the eligible agent with the smallest load per unit
 *    of 分流权重** ({@link selectAutoAssignee}): conversations already in
 *    progress divided by the seat's weight. Every seat weighs
 *    {@link DEFAULT_ASSIGNMENT_WEIGHT} until an administrator sets otherwise, so
 *    a deployment that never opens the setting behaves exactly as it did before
 *    the setting existed.
 * 3. **When nobody is eligible** the conversation stays in the pool, still due,
 *    and the customer gets one offline auto-reply ({@link planAutoAssign}
 *    reports the need; the caller sends it). Because the entry stays due, the
 *    next sweep retries it — so an agent who comes online a minute later still
 *    picks up the conversation. There is no attempt budget and no retry
 *    cadence to configure: the pool *is* the retry.
 *
 * ## 分流权重
 *
 * A weight is a **relative share**, not a percentage: what decides is the ratio
 * between seats, so `60 / 40` and `6 / 4` are the same policy and the numbers
 * never have to add up to anything. `weight: 0` takes a seat out of *automatic*
 * assignment; it stays a valid manual transfer target, because naming a seat by
 * hand is a different act from the dispatcher choosing one, and only the first
 * is what an administrator configures here.
 *
 * The rule reads the weight off {@link AssignmentCandidate.weight}, which both
 * adapters fill from storage, applying {@link DEFAULT_ASSIGNMENT_WEIGHT} where no
 * row exists — so a weight is a fact about a seat, like its presence, rather than
 * a second decision path through the dispatcher.
 *
 * ## Departure from the SDD-009 specification
 *
 * SDD-009 specifies a **hybrid** model: a shared store pool that agents grab
 * from, with auto-dispatch only as a fallback after "60 秒无人抢时". The
 * product owner replaced that with immediate automatic assignment on
 * 2026-09-14, so this module implements assignment-first and carries no
 * 60-second window. The concurrency guarantee the specification asks for is
 * unchanged and still enforced: dispatch is a compare-and-swap, so concurrent
 * attempts produce exactly one winner.
 *
 * Consequently SDD-009's first acceptance criterion ("两个客服并发抢单只有一个
 * 成功") now reads *"two concurrent assignments produce exactly one winner"*.
 * The manual claim path is retained and still races the same way.
 *
 * Nothing here is stored twice: the plan is derived by these pure functions, so
 * the PostgreSQL adapter, the in-memory adapter and the specs cannot disagree
 * about who should receive a conversation.
 */

import type { ConversationTransitionErrorCode } from './conversation';
import type { Conversation, Member, PlatformRole } from './types';

/**
 * How long a presence row stays live after its last heartbeat.
 *
 * **Not from any specification**, which only says presence has a "短 TTL". The
 * window is the *only* thing that decides whether a seat counts as connected,
 * so it is generous relative to the sweep interval (5s): a seat must miss many
 * consecutive heartbeats before it silently drops out of dispatch.
 */
export const AGENT_PRESENCE_TTL_MS = 60_000;

/**
 * The weight a seat counts with until an administrator sets another one.
 *
 * A deployment that never opens 会话分流 therefore keeps exactly the behaviour
 * it had before the setting existed: every seat weighs the same, so the least
 * loaded one wins. The default lives here rather than in a column `DEFAULT` so
 * the in-memory adapter, the SQL adapter and the settings surface cannot
 * disagree about what an unconfigured seat weighs.
 */
export const DEFAULT_ASSIGNMENT_WEIGHT = 1;

/**
 * The largest weight an administrator may set.
 *
 * A relative weight is a ratio, so the useful range starts at `0` and any
 * ceiling is arbitrary; this one exists so a typo — a percentage pasted in as
 * `10000` — cannot make one seat swallow the queue. Because only the ratio
 * matters, capping at 1000 costs no policy that could not be expressed by
 * dividing every seat by ten.
 */
export const ASSIGNMENT_WEIGHT_MAX = 1000;

/**
 * One seat's share of the automatic assignment, as stored.
 *
 * **A seat with no row weighs {@link DEFAULT_ASSIGNMENT_WEIGHT}**, so the table
 * holds deliberate choices only and an unconfigured tenant reads back empty.
 * `updatedBy` is the administrator who last saved the seat, and is `null` when
 * that member is gone — the weight outlives its author, so the row is not
 * deleted with them.
 */
export type ConversationRoutingWeight = {
  readonly tenantId: string;
  readonly memberId: string;
  readonly weight: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
};

/**
 * Whether a value may be stored as a seat's 分流权重.
 *
 * Non-negative integers only: a weight is a count of shares, and `2.5` shares
 * has no meaning an administrator could have intended. `0` is valid and means
 * "no automatic assignment" (see {@link selectAutoAssignee}).
 *
 * @param value - The candidate value, from a request body or a stored row.
 * @returns `true` when it may be stored.
 */
export function isValidAssignmentWeight(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= ASSIGNMENT_WEIGHT_MAX
  );
}

/**
 * The offline auto-reply the customer receives when nobody can take the
 * conversation.
 *
 * **No document in this project defines this text.** "离线回复" appears only in
 * the SDD-009 specification, with no wording given anywhere. This default is a
 * neutral placeholder so the behaviour is complete and testable; it is
 * deliberately non-committal — it promises no timeframe and makes no product
 * claim — and it is the single place to change once the product wording is
 * decided.
 */
export const DEFAULT_OFFLINE_REPLY_CONTENT =
  '您好，当前暂无客服在线，您的消息我们已经收到，客服上线后会尽快回复您。';

/** Seat availability, mirroring `agent_presence.status`. */
export type AgentAvailabilityStatus = 'accepting' | 'busy' | 'away' | 'offline';

/**
 * Every availability status.
 *
 * Four values in one column rather than a connected/receiving pair, because
 * these are exactly the states the specification names — 在线接单, 忙碌, 离开 —
 * plus the one it implies for a seat that is gone. `busy` and `away` are the
 * agent's own "not right now" switches and are distinct from `offline`, which
 * means the seat is not connected at all.
 */
export const AGENT_AVAILABILITY_STATUSES: ReadonlyArray<AgentAvailabilityStatus> = [
  'accepting',
  'busy',
  'away',
  'offline',
];

/** One agent seat's availability (`agent_presence`). */
export type AgentPresence = {
  readonly tenantId: string;
  readonly memberId: string;
  /** The member's store. `members.store_id` stays the authority; this mirrors it. */
  readonly storeId: string;
  readonly status: AgentAvailabilityStatus;
  /** Last time this seat was heard from, whatever its status. Never null. */
  readonly heartbeatAt: string;
  /** When `status` last actually changed, so a repeat heartbeat does not move it. */
  readonly changedAt: string;
  readonly createdAt: string;
};

/** What an assignment history row records (`conversation_assignments.action`). */
export type AssignmentAction = 'claim' | 'auto_assign' | 'transfer' | 'return' | 'release';

/** How an assignment attempt ended (`conversation_assignments.result`). */
export type AssignmentResult = 'success' | 'rejected' | 'expired';

/**
 * Why an assignment attempt was refused or a schedule expired.
 *
 * A closed set this module owns, stored as plain `TEXT` so widening it is a
 * code change rather than a migration — the same treatment `failure_code` gets
 * in migration `0006`.
 */
export type AssignmentReasonCode =
  /** The caller's expected version did not match: somebody else won the race. */
  | 'cas_conflict'
  /** The conversation is not in the pool, so there is nothing to take. */
  | 'not_in_pool'
  /** The conversation already has an assignee. */
  | 'already_assigned'
  /** The actor is not the current assignee. */
  | 'not_claimed'
  /** The transition is not legal from the conversation's current state. */
  | 'invalid_state'
  | 'not_found'
  /** The target is not an agent seat (an administrator has no seat to assign to). */
  | 'not_an_agent'
  /** The target's member record is disabled. */
  | 'target_disabled'
  /** The target's store is not the conversation's store. */
  | 'target_scope_mismatch'
  /** The target has no live presence: never online, or its heartbeat lapsed. */
  | 'target_offline'
  /** The target is live but not accepting work right now. */
  | 'target_not_accepting'
  /** Nobody in the store was eligible when the assignment was attempted. */
  | 'no_eligible_agent';

/** One assignment history row (`conversation_assignments`). */
export type ConversationAssignment = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly conversationId: string;
  readonly action: AssignmentAction;
  readonly result: AssignmentResult;
  readonly reasonCode: AssignmentReasonCode | null;
  readonly fromMemberId: string | null;
  readonly toMemberId: string | null;
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number | null;
  readonly createdAt: string;
};

/**
 * One agent seat as the assignment rules see it.
 *
 * `inProgressCount` is how many conversations this seat is already handling
 * (`status = 'claimed'` and assigned to it). {@link selectAutoAssignee} divides
 * that count by `weight` and picks the smallest quotient, which is what
 * "进行中会话最少" asks for once 分流权重 exists.
 */
export type AssignmentCandidate = {
  readonly memberId: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly role: PlatformRole;
  readonly enabled: boolean;
  readonly status: AgentAvailabilityStatus;
  readonly heartbeatAt: string | null;
  readonly inProgressCount: number;
  /**
   * 分流权重: how many shares of the queue this seat counts for. `0` means it
   * takes no automatic assignment. See {@link selectAutoAssignee}.
   */
  readonly weight: number;
};

/** The eligibility verdict for one candidate. */
export type AssignmentEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly code: AssignmentReasonCode; readonly reason: string };

/**
 * Whether a seat's presence is still live at `now`.
 *
 * Live means "connected and heard from recently". It is not the same as
 * *accepting work*: a `busy` or `away` seat is live but not assignable, which is
 * why {@link assignmentEligibility} checks both.
 *
 * @param presence - The seat's presence, or the pieces of it that decide this.
 * @param now - Instant to judge at (ISO).
 * @param ttlMs - Liveness window; defaults to {@link AGENT_PRESENCE_TTL_MS}.
 * @returns `true` when the seat is connected and its heartbeat has not lapsed.
 */
export function isPresenceLive(
  presence: Pick<AgentPresence, 'status' | 'heartbeatAt'>,
  now: string,
  ttlMs: number = AGENT_PRESENCE_TTL_MS,
): boolean {
  if (presence.status === 'offline') {
    return false;
  }
  return elapsedMs(presence.heartbeatAt, now) <= ttlMs;
}

/**
 * A seat's availability after the liveness window is applied.
 *
 * This is the single reader every caller should use, because it is where a
 * lapsed heartbeat becomes `offline`: a seat with no presence row at all has
 * never connected, and a seat whose last heartbeat is older than the window has
 * disconnected without saying so. Both answer `offline`, so neither the
 * dispatcher nor a transfer check has to remember the rule.
 *
 * @param presence - The seat's presence, or `undefined` when it has none.
 * @param now - Instant to judge at (ISO).
 * @param ttlMs - Liveness window; defaults to {@link AGENT_PRESENCE_TTL_MS}.
 * @returns The effective status.
 */
export function effectiveAvailabilityStatus(
  presence: AgentPresence | undefined,
  now: string,
  ttlMs: number = AGENT_PRESENCE_TTL_MS,
): AgentAvailabilityStatus {
  if (presence === undefined || !isPresenceLive(presence, now, ttlMs)) {
    return 'offline';
  }
  return presence.status;
}

/**
 * Evaluate one seat against the assignment rule.
 *
 * The checks run in a fixed order so the reason code is deterministic: a
 * platform administrator in another store is reported as `not_an_agent` rather
 * than `target_scope_mismatch`, and every refusal names the *first* thing wrong
 * with the candidate rather than an arbitrary one.
 *
 * The store check applies only when a store was named. Passing `undefined` says
 * the store decides nothing — which is what a deployment where a seat is not
 * pinned to one store wants, and the reason the check is skippable rather than
 * deleted: the rule still exists for callers that narrow by store.
 *
 * @param input - Candidate, the conversation's store (or `undefined`), and the
 * instant.
 * @returns Eligibility, or the first reason the seat fails.
 */
export function assignmentEligibility(input: {
  readonly candidate: AssignmentCandidate;
  readonly conversationStoreId: string | undefined;
  readonly now: string;
  readonly ttlMs?: number;
}): AssignmentEligibility {
  const { candidate, conversationStoreId, now } = input;
  const ttlMs = input.ttlMs ?? AGENT_PRESENCE_TTL_MS;
  if (candidate.role !== 'agent') {
    return refuse('not_an_agent', 'an administrator seat never receives conversations');
  }
  if (!candidate.enabled) {
    return refuse('target_disabled', 'the member is disabled');
  }
  if (conversationStoreId !== undefined && candidate.storeId !== conversationStoreId) {
    return refuse('target_scope_mismatch', 'the member belongs to another store');
  }
  const status = effectiveAvailabilityStatus(presenceOf(candidate), now, ttlMs);
  if (status === 'offline') {
    return refuse('target_offline', 'the seat has no live presence');
  }
  if (status !== 'accepting') {
    return refuse('target_not_accepting', `the seat is ${status}`);
  }
  return { eligible: true };
}

/**
 * Choose the agent an assignment should hand the conversation to.
 *
 * Least-loaded wins: the eligible seat with the smallest in-progress count per
 * unit of 分流权重 ({@link AssignmentCandidate.weight}). Ties break on `memberId`
 * in code-unit order — **not** `localeCompare`, which would make the answer
 * depend on the host locale and let two replicas pick different winners from
 * identical data.
 *
 * A seat weighing `0` is skipped here rather than refused by
 * {@link assignmentEligibility}, because the two answer different questions:
 * eligibility says whether this *seat* may be given work at all, and a weight of
 * zero says only that the dispatcher should not be the one to choose it. A
 * zero-weight seat is still a valid manual transfer target, which is exactly what
 * `transferTargetRefusal` keeps asking about.
 *
 * @param candidates - Every seat of the store, eligible or not.
 * @param conversationStoreId - The store whose pool this is.
 * @param now - Instant to judge presence at (ISO).
 * @param ttlMs - Liveness window; defaults to {@link AGENT_PRESENCE_TTL_MS}.
 * @returns The winner, or `undefined` when nobody is eligible.
 */
export function selectAutoAssignee(
  candidates: ReadonlyArray<AssignmentCandidate>,
  conversationStoreId: string,
  now: string,
  ttlMs: number = AGENT_PRESENCE_TTL_MS,
): AssignmentCandidate | undefined {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.weight > 0 &&
      assignmentEligibility({ candidate, conversationStoreId, now, ttlMs }).eligible,
  );
  if (eligible.length === 0) {
    return undefined;
  }
  return [...eligible].sort(byWeightedLoad)[0];
}

/**
 * Which seats a conversation entering the pool belongs to the attention of.
 *
 * The specification asks a new pool entry to be announced "仅向当前店铺在线接单
 * 客服" — only to the online, accepting agents of that store. This computes that
 * set and nothing more: it is a pure rule, and the announcement itself is the
 * inbound path's, published as a store-scoped `conversation.opened` frame. It is
 * exposed so the pool view can report who would be told, which is the same set
 * the announcement reaches.
 *
 * @param candidates - Every seat in question, eligible or not.
 * @param conversationStoreId - The store whose pool this is, or `undefined` when
 * the store does not narrow the audience.
 * @param now - Instant to judge presence at (ISO).
 * @param ttlMs - Liveness window; defaults to {@link AGENT_PRESENCE_TTL_MS}.
 * @returns Eligible member ids, ordered by id for a stable answer.
 */
export function assignmentAudience(
  candidates: ReadonlyArray<AssignmentCandidate>,
  conversationStoreId: string | undefined,
  now: string,
  ttlMs: number = AGENT_PRESENCE_TTL_MS,
): ReadonlyArray<string> {
  return candidates
    .filter(
      (candidate) => assignmentEligibility({ candidate, conversationStoreId, now, ttlMs }).eligible,
    )
    .map((candidate) => candidate.memberId)
    .sort();
}

/**
 * Whether a conversation may be transferred to a seat.
 *
 * The specification's "支持退回池和转指定**在线**客服" makes online-ness a
 * precondition of the transfer, not just of assignment — which is why this
 * reuses the same eligibility rule rather than a looser check of its own. A
 * transfer to an offline seat would produce a conversation nobody is looking
 * at.
 *
 * @param input - Target seat, the conversation's store (or `undefined` when the
 * store does not narrow the transfer), and the instant.
 * @returns The refusal code, or `undefined` when the transfer may proceed.
 */
export function transferTargetRefusal(input: {
  readonly target: AssignmentCandidate;
  readonly conversationStoreId: string | undefined;
  readonly now: string;
  readonly ttlMs?: number;
}): AssignmentReasonCode | undefined {
  const verdict = assignmentEligibility({
    candidate: input.target,
    conversationStoreId: input.conversationStoreId,
    now: input.now,
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
  });
  return verdict.eligible ? undefined : verdict.code;
}

/**
 * Whether a conversation is waiting in the pool with nobody able to take it.
 *
 * Marked by the offline reply having been sent, which is the instant the
 * platform learned it had nobody for this customer. It is *not* marked by a
 * cleared due time: an entry that found nobody stays due so the next sweep
 * retries it.
 *
 * @param conversation - The pool-relevant fields of a conversation.
 * @returns `true` when the entry has fallen back to the offline path.
 */
export function isOfflineFallback(
  conversation: Pick<Conversation, 'status' | 'assignedMemberId' | 'offlineReplyAt'>,
): boolean {
  return (
    conversation.status === 'open' &&
    conversation.assignedMemberId === null &&
    conversation.offlineReplyAt !== null
  );
}

/**
 * Whether a conversation is in the pool and due to be assigned now.
 *
 * Due means "in the pool, unassigned, and not waiting for a clock" — every pool
 * entry is due the moment it enters, so this is really a pool test. It is
 * written as its own predicate so the SQL predicate and the in-memory one are
 * the same expression rather than two spellings of it.
 *
 * @param conversation - The pool-relevant fields of a conversation.
 * @returns `true` when the sweep should consider assigning it.
 */
export function isAssignmentDue(
  conversation: Pick<Conversation, 'status' | 'assignedMemberId'>,
): boolean {
  return conversation.status === 'open' && conversation.assignedMemberId === null;
}

/**
 * How long the customer waited for their first reply, in milliseconds.
 *
 * The start is {@link Conversation.firstResponseStartedAt} — stamped once, when
 * the conversation first entered the pool — so a conversation that was returned
 * and re-assigned still reports the customer's whole wait rather than the
 * latest round's.
 *
 * @param startedAt - `firstResponseStartedAt`, or `null` when never pooled.
 * @param firstReplyAt - `firstReplyAt`, or `null` when nobody has replied.
 * @returns The duration, or `undefined` when either end is missing.
 */
export function firstResponseDurationMs(
  startedAt: string | null,
  firstReplyAt: string | null,
): number | undefined {
  if (startedAt === null || firstReplyAt === null) {
    return undefined;
  }
  return elapsedMs(startedAt, firstReplyAt);
}

/** What the sweep should do with one pooled conversation. */
export type AutoAssignPlan =
  /** Hand it to this seat. */
  | { readonly kind: 'assign'; readonly toMemberId: string }
  /**
   * Nobody eligible. The customer has not been told yet, so this attempt must
   * send the offline reply and record it.
   */
  | { readonly kind: 'fallback'; readonly needsOfflineReply: true }
  /**
   * Nobody eligible, and the offline reply already went out. The entry stays
   * due and the next sweep tries again — and this verdict writes **nothing at
   * all**, so a conversation parked in the pool costs no row rewrite however
   * long it waits.
   */
  | { readonly kind: 'wait' }
  /** Not a pooled conversation, so there is nothing to decide. */
  | { readonly kind: 'skip' };

/**
 * Decide what to do with one pooled conversation.
 *
 * This is the whole dispatcher policy. The caller supplies the store's seats
 * and executes the verdict; every choice — who, and whether the customer has
 * been acknowledged — is made here, so the SQL adapter and the in-memory
 * adapter cannot diverge.
 *
 * @param input - The pooled conversation, the store's seats, and the instant.
 * @returns The verdict to execute.
 */
export function planAutoAssign(input: {
  readonly conversation: Pick<
    Conversation,
    'status' | 'assignedMemberId' | 'storeId' | 'offlineReplyAt'
  >;
  readonly candidates: ReadonlyArray<AssignmentCandidate>;
  readonly now: string;
  readonly ttlMs?: number;
}): AutoAssignPlan {
  const { conversation, candidates, now } = input;
  if (!isAssignmentDue(conversation)) {
    return { kind: 'skip' };
  }
  const target = selectAutoAssignee(candidates, conversation.storeId, now, input.ttlMs);
  if (target !== undefined) {
    return { kind: 'assign', toMemberId: target.memberId };
  }
  if (conversation.offlineReplyAt === null) {
    return { kind: 'fallback', needsOfflineReply: true };
  }
  return { kind: 'wait' };
}

/**
 * What one dispatch sweep did to one conversation.
 *
 * A sweep reports per conversation rather than as a count because the offline
 * reply is sent *after* the dispatch transaction commits: `fallback` is the only
 * outcome that asks for one, and it is reported by the single attempt that
 * actually wrote `offlineReplyAt`, so no two sweeps can acknowledge the same
 * customer.
 */
export type DispatchOutcome =
  /** Handed to an agent. */
  | {
      readonly kind: 'assigned';
      readonly tenantId: string;
      readonly storeId: string;
      readonly conversationId: string;
      readonly toMemberId: string;
    }
  /** Nobody was eligible, and this attempt sent the offline reply. */
  | {
      readonly kind: 'fallback';
      readonly tenantId: string;
      readonly storeId: string;
      readonly conversationId: string;
      readonly reasonCode: AssignmentReasonCode;
    }
  /**
   * Nobody was eligible, but the customer was already acknowledged. The entry
   * stays due; this outcome wrote nothing at all.
   */
  | { readonly kind: 'waiting'; readonly conversationId: string }
  /** The conversation moved out from under this sweep; nothing was written. */
  | { readonly kind: 'lost'; readonly conversationId: string };

/**
 * Translate a refused conversation transition into an assignment reason code.
 *
 * The two vocabularies exist for different readers — the transition codes are
 * what the conversation rules answer, the reason codes are what the assignment
 * history stores — so this is the single mapping between them. Both adapters
 * write a `rejected` history row through it, which is what stops the durable
 * ledger and the in-memory one from disagreeing about why a claim failed.
 *
 * @param code - The refusal a conversation transition produced.
 * @returns The reason code to store on the history row.
 */
export function rejectionReasonCode(code: ConversationTransitionErrorCode): AssignmentReasonCode {
  switch (code) {
    case 'conflict':
      // The claim raced: the version, the status or the assignee had moved.
      return 'cas_conflict';
    case 'not_claimed':
      return 'not_claimed';
    case 'invalid_state':
      return 'invalid_state';
    case 'not_found':
      return 'not_found';
  }
}

/**
 * Retry order: smallest in-progress count per unit of weight, then lowest member
 * id.
 *
 * The ratio is compared by cross-multiplying integers rather than by dividing,
 * so seats that are *exactly* equal cannot be separated by floating-point
 * rounding: `3 / 7` and `6 / 14` are the same load and must tie (and then be
 * broken by id) rather than be ordered by which division came out 1 ULP smaller.
 * With integer weights up to `ASSIGNMENT_WEIGHT_MAX` and realistic queue depths
 * the products stay far inside exact-integer range.
 */
function byWeightedLoad(a: AssignmentCandidate, b: AssignmentCandidate): number {
  const left = a.inProgressCount * b.weight;
  const right = b.inProgressCount * a.weight;
  if (left !== right) {
    return left - right;
  }
  if (a.memberId === b.memberId) {
    return 0;
  }
  return a.memberId < b.memberId ? -1 : 1;
}

/** Project a candidate's availability through the liveness window. */
function presenceOf(candidate: AssignmentCandidate): AgentPresence | undefined {
  if (candidate.heartbeatAt === null) {
    return undefined;
  }
  return {
    tenantId: candidate.tenantId,
    memberId: candidate.memberId,
    storeId: candidate.storeId ?? '',
    status: candidate.status,
    heartbeatAt: candidate.heartbeatAt,
    changedAt: candidate.heartbeatAt,
    createdAt: candidate.heartbeatAt,
  };
}

/** Build a refusal verdict. */
function refuse(code: AssignmentReasonCode, reason: string): AssignmentEligibility {
  return { eligible: false, code, reason };
}

/** Milliseconds from `from` to `to`; negative when `to` precedes `from`. */
function elapsedMs(from: string, to: string): number {
  return Date.parse(to) - Date.parse(from);
}

/** Narrow an unknown value to a known availability status. */
export function isAgentAvailabilityStatus(value: unknown): value is AgentAvailabilityStatus {
  return (
    typeof value === 'string' &&
    (AGENT_AVAILABILITY_STATUSES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Whether a member may hold a seat at all.
 *
 * Administrators configure the platform and have no seat; only agents receive
 * conversations. The check exists so the presence endpoints refuse an
 * administrator explicitly instead of quietly writing a seat nothing will ever
 * assign to.
 *
 * @param member - The member to check.
 * @returns `true` when the member is an agent.
 */
export function isAgentSeat(member: Member): boolean {
  return member.role === 'agent';
}
