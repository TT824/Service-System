/**
 * Conversation state transitions.
 *
 * The kernel treats every conversation mutation as an optimistic compare-and-
 * swap over `Conversation.version`. A repeated or stale mutation (wrong
 * `expectedVersion`) always resolves to a stable `conflict`, never to a silent
 * overwrite. Reopening happens only through a new inbound message on a closed
 * conversation; there is no manual reopen path in the MVP.
 *
 * ## The pool schedule
 *
 * Entering the pool and leaving it are also expressed here, because they are
 * part of the same transition and must move with the same version bump. Every
 * transition that puts a conversation *into* the pool makes it due for
 * automatic assignment **at once**; every one that takes it *out* clears the
 * due time.
 *
 * The load-bearing exception is {@link touchConversationForInbound}: a customer
 * message on an already-open conversation must **not** re-stamp the pool
 * fields. Re-stamping would reset the attempt counter and the pool-entry time
 * on every message, so the "how long has this been waiting" reading would
 * restart whenever the customer spoke.
 *
 * Assignment is deliberately one function ({@link claimConversation}) whether
 * the taker is a human pressing a button or the sweeper acting on a due entry.
 * The state change is identical — open, unassigned, matching version → claimed
 * by that member — so a second copy would only be a second place for the CAS
 * preconditions to drift. It is the *history row* the caller writes that
 * records which of the two it was.
 */

import type { Conversation, PlatformRole } from './types';

/**
 * Whether a member role is one of the two administrator roles.
 *
 * Administrators never hold a conversation, so every rule that asks about an
 * *actor* versus an *assignee* reads this first.
 *
 * @param role - The member's platform role.
 * @returns `true` for a merchant or platform administrator.
 */
export function isAdministratorRole(role: PlatformRole): boolean {
  return role === 'merchant_admin' || role === 'platform_admin';
}

/** Codes produced by a refused conversation transition. */
export type ConversationTransitionErrorCode =
  'conflict' | 'not_found' | 'not_claimed' | 'invalid_state';

/** Outcome of a conversation transition attempt. */
export type ConversationTransition =
  | { readonly ok: true; readonly conversation: Conversation }
  | {
      readonly ok: false;
      readonly code: ConversationTransitionErrorCode;
      readonly reason: string;
    };

function conflict(reason: string): ConversationTransition {
  return { ok: false, code: 'conflict', reason };
}

function invalidState(reason: string): ConversationTransition {
  return { ok: false, code: 'invalid_state', reason };
}

function notClaimed(reason: string): ConversationTransition {
  return { ok: false, code: 'not_claimed', reason };
}

function changed(conversation: Conversation, changes: Partial<Conversation>): Conversation {
  const next: Conversation = { ...conversation, ...changes };
  return Object.freeze(next);
}

function checkVersion(conversation: Conversation, expectedVersion: number): string | null {
  if (conversation.version !== expectedVersion) {
    return `expected version ${expectedVersion} but conversation is at version ${conversation.version}`;
  }
  return null;
}

/**
 * Claim an open conversation for an agent.
 *
 * Only an *open, unassigned* conversation can be claimed, and the caller must
 * present the current version. Any other state yields a stable conflict.
 *
 * This is the single implementation of "a member takes a pooled conversation",
 * used by a human claim and by auto-dispatch alike; the caller's history row
 * records which it was (`claim` or `auto_assign`). The successful transition
 * leaves the pool: the due time is cleared and the attempt counter resets.
 *
 * @param conversation - The current conversation record.
 * @param expectedVersion - The version the caller observed.
 * @param actorMemberId - The agent claiming the conversation.
 * @param now - ISO timestamp used as `lastMessageAt` and `assignedAt`.
 */
export function claimConversation(
  conversation: Conversation,
  expectedVersion: number,
  actorMemberId: string,
  now: string,
): ConversationTransition {
  const versionIssue = checkVersion(conversation, expectedVersion);
  if (versionIssue !== null) {
    return conflict(versionIssue);
  }
  if (conversation.status !== 'open') {
    return conflict(
      `conversation is ${conversation.status}, only an open conversation can be claimed`,
    );
  }
  if (conversation.assignedMemberId !== null) {
    return conflict('conversation is already assigned');
  }
  return {
    ok: true,
    conversation: changed(conversation, {
      status: 'claimed',
      assignedMemberId: actorMemberId,
      assignedAt: now,
      nextAssignmentAt: null,
      dispatchAttempts: 0,
      version: conversation.version + 1,
      lastMessageAt: now,
    }),
  };
}

/**
 * Who may act on a claimed conversation they are not assigned to.
 *
 * The requirement keeps a dropped seat's conversations with that seat
 * ("客服掉线期间其'接待中'会话仍归其名下，重新登录可见") and hands the
 * customer over "走退单/转接" — so the hand-over has to be possible *after* the
 * assignee is gone, which is exactly when the assignee can no longer perform
 * it. Without that, a conversation whose assignee logged off is one nobody can
 * move and a customer nobody answers.
 *
 * It is a set of *facts* rather than a verdict, in the shape `closeConversation`
 * takes `actorIsAdmin`: the caller resolves the assignee's liveness from the
 * presence row (a pure function of the row and the clock — `isPresenceLive` in
 * `./assignment`) and this module decides, so the rule exists in one place.
 */
export type TakeoverAuthority = {
  /** The actor holds a merchant or platform administrator role. */
  readonly actorIsAdmin: boolean;
  /** The actor's own store, or `null` for a member that carries none. */
  readonly actorStoreId: string | null;
  /** Whether the current assignee is still live (heartbeat within the TTL). */
  readonly assigneeLive: boolean;
};

/**
 * Whether the actor may return or transfer this conversation.
 *
 * The assigned seat may always act on its own conversation. Anybody else may
 * act only while the assignee is **not live**, and only as an administrator or
 * as a seat of the conversation's own store. A live assignee keeps its
 * conversation: a seat that is working is not to be robbed of its queue, which
 * is why liveness — not merely a missing reply — is the trigger.
 *
 * @param input - The conversation's assignee and store, the actor, and the facts.
 * @returns `true` when the transition may proceed.
 */
export function mayTakeOverClaim(input: {
  readonly conversation: Pick<Conversation, 'assignedMemberId' | 'storeId'>;
  readonly actorMemberId: string;
  readonly authority: TakeoverAuthority;
}): boolean {
  const { conversation, actorMemberId, authority } = input;
  if (conversation.assignedMemberId === actorMemberId) {
    return true;
  }
  if (authority.assigneeLive) {
    return false;
  }
  if (authority.actorIsAdmin) {
    return true;
  }
  return authority.actorStoreId !== null && authority.actorStoreId === conversation.storeId;
}

/**
 * How far one reader may read a conversation it is looking at.
 *
 * The requirement's pool is shared (§276: a seat sees and takes what its store
 * has waiting), and one seat's own conversation is its own — but a conversation
 * another seat is handling is not a third seat's business. 转交 moves the
 * conversation, not the history: the seat that handed it over keeps the record
 * up to the instant it left its hands, cannot read what the next seat said
 * after that, and cannot speak in it again.
 *
 * `full` covers the reads that look the same to a console — the reader's own
 * conversation, one nobody is holding (the pool it could claim, a round that has
 * already been closed), and anything an administrator is looking at. `history`
 * carries the instant the conversation left the reader, which is where its
 * transcript stops for them.
 *
 * "Nobody is holding it" is judged by the assignee alone, not by the status: a
 * closed conversation is unassigned (`closeConversation` clears the field), and
 * the seat that closed it has no other way back to what it just finished.
 */
export type ConversationReadAccess =
  | { readonly kind: 'full' }
  | { readonly kind: 'history'; readonly until: string };

/**
 * Resolve what a member may read of one conversation.
 *
 * Administrator roles read everything: they are the fallback the requirement
 * keeps for a conversation nobody is left to answer.
 *
 * @param input - The conversation, the reader, and when it last left the reader.
 * @returns The reader's access, or `undefined` when the reader has none.
 */
export function conversationReadAccess(input: {
  readonly conversation: Pick<Conversation, 'assignedMemberId'>;
  readonly readerMemberId: string;
  readonly readerIsAdmin: boolean;
  readonly handedOffAt: string | undefined;
}): ConversationReadAccess | undefined {
  const { conversation, readerMemberId, readerIsAdmin, handedOffAt } = input;
  if (readerIsAdmin || conversation.assignedMemberId === readerMemberId) {
    return { kind: 'full' };
  }
  if (conversation.assignedMemberId === null) {
    return { kind: 'full' };
  }
  if (handedOffAt !== undefined) {
    return { kind: 'history', until: handedOffAt };
  }
  return undefined;
}

/**
 * Whether this member may send a message into this conversation.
 *
 * Only the seat holding it — a colleague's conversation is not a chat the reader
 * may join, and after 转交 the seat that handed it over is done talking in it.
 * The answer deliberately does not consult a role: an administrator does not
 * answer customers either, it moves the conversation to somebody who will.
 *
 * A conversation nobody has taken is the one exception, and it is the pool's own
 * rule rather than a hole in this one: 待接入 的单还没被接走，谁都可以先接话
 * （`status === 'open'` 且没有受理人）。Closed conversations are not in the pool —
 * `closeConversation` clears the assignee, so without the status clause a finished
 * round would answer "anybody may speak here".
 *
 * @param input - The conversation and the member asking.
 * @returns `true` when the send may proceed.
 */
export function maySendToConversation(input: {
  readonly conversation: Pick<Conversation, 'status' | 'assignedMemberId'>;
  readonly memberId: string;
}): boolean {
  const { conversation, memberId } = input;
  if (conversation.assignedMemberId === memberId) {
    return true;
  }
  return conversation.status === 'open' && conversation.assignedMemberId === null;
}

/**
 * Return a claimed conversation to the open pool.
 *
 * The assigned agent may return the conversation; once that agent is no longer
 * live, an administrator or a seat of the same store may do it instead (see
 * {@link mayTakeOverClaim}). The conversation re-enters the pool as a new
 * round, so the dispatch deadline starts again from `now` rather than resuming
 * wherever it left off — the agent who just handed it back is not the one who
 * should be given it again three seconds later by a stale schedule.
 *
 * `firstResponseStartedAt` is deliberately *not* touched: the customer's wait
 * for their first reply began when they first entered the pool and does not
 * restart because an agent changed their mind.
 *
 * @param conversation - The current conversation record.
 * @param expectedVersion - The version the caller observed.
 * @param actorMemberId - The member returning it.
 * @param authority - Whether the actor may act without being the assignee.
 * @param now - ISO timestamp used as `lastMessageAt` and the new pool entry.
 */
export function returnConversation(
  conversation: Conversation,
  expectedVersion: number,
  actorMemberId: string,
  authority: TakeoverAuthority,
  now: string,
): ConversationTransition {
  const versionIssue = checkVersion(conversation, expectedVersion);
  if (versionIssue !== null) {
    return conflict(versionIssue);
  }
  if (conversation.status !== 'claimed') {
    return invalidState(
      `conversation is ${conversation.status}, only a claimed conversation can be returned`,
    );
  }
  if (!mayTakeOverClaim({ conversation, actorMemberId, authority })) {
    return notClaimed(
      'only the assigned agent can return the conversation while it is live; an administrator or a same-store seat may do it once the assignee is offline',
    );
  }
  return {
    ok: true,
    conversation: changed(conversation, {
      status: 'open',
      assignedMemberId: null,
      assignedAt: null,
      pendingSince: now,
      nextAssignmentAt: now,
      dispatchAttempts: 0,
      version: conversation.version + 1,
      lastMessageAt: now,
    }),
  };
}

/**
 * Transfer a claimed conversation to another member.
 *
 * The assigned agent may transfer the conversation; once that agent is no
 * longer live, an administrator or a seat of the same store may do it instead
 * (see {@link mayTakeOverClaim}). That the *target* must be an online,
 * accepting agent is checked before this runs (see `transferTargetRefusal` in
 * `./assignment`) — this transition stays a pure state change and does not
 * reach for presence, only for the facts the caller passed in.
 *
 * @param conversation - The current conversation record.
 * @param expectedVersion - The version the caller observed.
 * @param actorMemberId - The member handing the conversation over.
 * @param authority - Whether the actor may act without being the assignee.
 * @param toMemberId - The member receiving the conversation.
 * @param now - ISO timestamp used as `lastMessageAt` and `assignedAt`.
 */
export function transferConversation(
  conversation: Conversation,
  expectedVersion: number,
  actorMemberId: string,
  authority: TakeoverAuthority,
  toMemberId: string,
  now: string,
): ConversationTransition {
  const versionIssue = checkVersion(conversation, expectedVersion);
  if (versionIssue !== null) {
    return conflict(versionIssue);
  }
  if (conversation.status !== 'claimed') {
    return invalidState(
      `conversation is ${conversation.status}, only a claimed conversation can be transferred`,
    );
  }
  if (!mayTakeOverClaim({ conversation, actorMemberId, authority })) {
    return notClaimed(
      'only the assigned agent can transfer the conversation while it is live; an administrator or a same-store seat may do it once the assignee is offline',
    );
  }
  if (toMemberId.length === 0 || toMemberId === actorMemberId) {
    return invalidState('transfer target must be a different member');
  }
  return {
    ok: true,
    conversation: changed(conversation, {
      status: 'claimed',
      assignedMemberId: toMemberId,
      assignedAt: now,
      nextAssignmentAt: null,
      dispatchAttempts: 0,
      version: conversation.version + 1,
      lastMessageAt: now,
    }),
  };
}

/**
 * Close an open or claimed conversation.
 *
 * An assigned conversation can be closed by its agent; an open conversation can
 * be closed by any actor that holds a tenant admin or platform admin role. The
 * caller passes an optimistic `expectedVersion` for the CAS check.
 *
 * @param conversation - The current conversation record.
 * @param expectedVersion - The version the caller observed.
 * @param actorMemberId - The member closing the conversation.
 * @param actorIsAdmin - Whether the actor holds a platform/merchant admin role.
 * @param now - ISO timestamp used for `closedAt` and `lastMessageAt`.
 */
export function closeConversation(
  conversation: Conversation,
  expectedVersion: number,
  actorMemberId: string,
  actorIsAdmin: boolean,
  now: string,
): ConversationTransition {
  const versionIssue = checkVersion(conversation, expectedVersion);
  if (versionIssue !== null) {
    return conflict(versionIssue);
  }
  if (conversation.status === 'closed') {
    return conflict('conversation is already closed');
  }
  if (
    conversation.status === 'claimed' &&
    conversation.assignedMemberId !== actorMemberId &&
    !actorIsAdmin
  ) {
    return notClaimed('only the assigned agent or an admin can close the conversation');
  }
  return {
    ok: true,
    conversation: changed(conversation, {
      status: 'closed',
      assignedMemberId: null,
      assignedAt: null,
      nextAssignmentAt: null,
      closedAt: now,
      version: conversation.version + 1,
      lastMessageAt: now,
    }),
  };
}

/**
 * Reopen a closed conversation when a new inbound message arrives.
 *
 * This transition is *not* a manual API mutation: it runs as part of inbound
 * message ingestion (see the store). It bumps the version so any stale client
 * mutation that raced the inbound message will be refused with a conflict.
 *
 * This is a **new round**, so the pool fields restart: the entry becomes due
 * for assignment immediately, and `firstReplyAt` clears because the round's
 * first reply has not happened yet. `firstResponseStartedAt` is deliberately
 * left alone — the customer's wait for a first reply began when they first
 * entered the pool and did not restart because they came back.
 *
 * @param conversation - The current (closed) conversation record.
 * @param now - ISO timestamp used for `openedAt`/`lastMessageAt`.
 */
export function reopenConversation(
  conversation: Conversation,
  now: string,
): ConversationTransition {
  if (conversation.status !== 'closed') {
    return invalidState(
      `conversation is ${conversation.status}, only a closed conversation can be reopened`,
    );
  }
  return {
    ok: true,
    conversation: changed(conversation, {
      status: 'open',
      assignedMemberId: null,
      assignedAt: null,
      pendingSince: now,
      nextAssignmentAt: now,
      dispatchAttempts: 0,
      firstReplyAt: null,
      closedAt: null,
      version: conversation.version + 1,
      lastMessageAt: now,
    }),
  };
}

/**
 * Apply the effect of a new inbound message on a conversation.
 *
 * Closed conversations reopen; open/claimed conversations stay in place. The
 * conversation version is bumped so that a stale outbound CAS attempted by a
 * client that raced the inbound message is refused.
 *
 * The pool fields are deliberately untouched for an open or claimed
 * conversation: it is already in the pool (or already has an owner), and
 * re-stamping would restart the pool-entry time and the attempt counter on
 * every message a chatty customer sends.
 *
 * @param conversation - The conversation receiving the inbound message.
 * @param now - ISO timestamp of the inbound message.
 */
export function touchConversationForInbound(
  conversation: Conversation,
  now: string,
): ConversationTransition {
  if (conversation.status === 'closed') {
    return reopenConversation(conversation, now);
  }
  return {
    ok: true,
    conversation: changed(conversation, {
      status: conversation.status,
      version: conversation.version + 1,
      lastMessageAt: now,
    }),
  };
}

/**
 * Open the conversation a first inbound message creates.
 *
 * A brand-new conversation is a pool entry like any other, so it is due for
 * assignment at the instant it opens and its first-response clock starts now.
 * Building it here rather than at each call site is what keeps the in-memory
 * store and the SQL adapter from disagreeing about the pool fields — the two
 * used to spell out the identical object literal in two places.
 *
 * @param input - Identity and origin of the conversation.
 * @returns A pooled, unassigned conversation at version 1.
 */
export function openConversationForInbound(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly channel: string;
  readonly externalCustomerId: string;
  readonly externalConversationId: string | null;
  readonly now: string;
}): Conversation {
  const { id, tenantId, storeId, channel, externalCustomerId, externalConversationId, now } = input;
  return Object.freeze({
    id,
    tenantId,
    storeId,
    channel,
    externalCustomerId,
    externalConversationId,
    title: null,
    status: 'open',
    version: 1,
    assignedMemberId: null,
    openedAt: now,
    lastMessageAt: now,
    closedAt: null,
    createdAt: now,
    pendingSince: now,
    firstResponseStartedAt: now,
    nextAssignmentAt: now,
    dispatchAttempts: 0,
    assignedAt: null,
    offlineReplyAt: null,
    firstReplyAt: null,
  } satisfies Conversation);
}

/**
 * Stamp the first outbound of the current round.
 *
 * Idempotent: only the first valid outbound sets `firstReplyAt`, so a second
 * reply does not move the metric. Callers invoke this after a send succeeds
 * rather than before, so a send that never reached the customer does not count
 * as a reply.
 *
 * @param conversation - The conversation that was replied to.
 * @param now - ISO timestamp of the outbound message.
 * @returns The conversation, with `firstReplyAt` set if it was not already.
 */
export function recordFirstReply(conversation: Conversation, now: string): Conversation {
  if (conversation.firstReplyAt !== null) {
    return conversation;
  }
  return changed(conversation, { firstReplyAt: now });
}
