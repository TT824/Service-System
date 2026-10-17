import { describe, expect, it } from 'vitest';
import {
  AGENT_AVAILABILITY_STATUSES,
  AGENT_PRESENCE_TTL_MS,
  DEFAULT_ASSIGNMENT_WEIGHT,
  effectiveAvailabilityStatus,
  assignmentAudience,
  assignmentEligibility,
  firstResponseDurationMs,
  isAgentAvailabilityStatus,
  isAgentSeat,
  isAssignmentDue,
  isOfflineFallback,
  isPresenceLive,
  isValidAssignmentWeight,
  planAutoAssign,
  selectAutoAssignee,
  transferTargetRefusal,
  type AgentPresence,
  type AssignmentCandidate,
} from './assignment';
import type { Conversation, Member } from './types';

const NOW = '2026-09-14T10:00:00.000Z';

/** A live, accepting agent seat in `store-1`, which every test varies from. */
function candidate(overrides: Partial<AssignmentCandidate> = {}): AssignmentCandidate {
  return {
    memberId: 'u-agent-1',
    tenantId: 'tenant-1',
    storeId: 'store-1',
    role: 'agent',
    enabled: true,
    status: 'accepting',
    heartbeatAt: NOW,
    inProgressCount: 0,
    weight: DEFAULT_ASSIGNMENT_WEIGHT,
    ...overrides,
  };
}

/** Presence for the liveness readers. */
function presence(overrides: Partial<AgentPresence> = {}): AgentPresence {
  return {
    tenantId: 'tenant-1',
    memberId: 'u-agent-1',
    storeId: 'store-1',
    status: 'accepting',
    heartbeatAt: NOW,
    changedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

/** Pool-relevant fields of a conversation. */
function pooled(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conversation-1',
    tenantId: 'tenant-1',
    storeId: 'store-1',
    channel: 'manual',
    externalCustomerId: 'customer-1',
    externalConversationId: null,
    title: null,
    status: 'open',
    version: 1,
    assignedMemberId: null,
    openedAt: NOW,
    lastMessageAt: NOW,
    closedAt: null,
    createdAt: NOW,
    pendingSince: NOW,
    firstResponseStartedAt: NOW,
    nextAssignmentAt: NOW,
    dispatchAttempts: 0,
    assignedAt: null,
    offlineReplyAt: null,
    firstReplyAt: null,
    ...overrides,
  };
}

describe('agent presence liveness', () => {
  it('never treats an offline seat as live, however recent its heartbeat', () => {
    expect(isPresenceLive({ status: 'offline', heartbeatAt: NOW }, NOW)).toBe(false);
  });

  it('treats busy and away seats as live: they are connected, just not free', () => {
    expect(isPresenceLive({ status: 'busy', heartbeatAt: NOW }, NOW)).toBe(true);
    expect(isPresenceLive({ status: 'away', heartbeatAt: NOW }, NOW)).toBe(true);
  });

  it('keeps a seat live exactly up to the window and no further', () => {
    const atEdge = new Date(Date.parse(NOW) - AGENT_PRESENCE_TTL_MS).toISOString();
    const pastEdge = new Date(Date.parse(NOW) - AGENT_PRESENCE_TTL_MS - 1).toISOString();
    expect(isPresenceLive({ status: 'accepting', heartbeatAt: atEdge }, NOW)).toBe(true);
    expect(isPresenceLive({ status: 'accepting', heartbeatAt: pastEdge }, NOW)).toBe(false);
  });

  it('reports a seat that lapsed as offline, so a crashed browser frees itself', () => {
    const stale = new Date(Date.parse(NOW) - AGENT_PRESENCE_TTL_MS - 1).toISOString();
    expect(effectiveAvailabilityStatus(presence({ heartbeatAt: stale }), NOW)).toBe('offline');
  });

  it('reports a seat that has never connected as offline', () => {
    expect(effectiveAvailabilityStatus(undefined, NOW)).toBe('offline');
  });

  it('passes a live seat through unchanged', () => {
    expect(effectiveAvailabilityStatus(presence({ status: 'busy' }), NOW)).toBe('busy');
    expect(effectiveAvailabilityStatus(presence({ status: 'accepting' }), NOW)).toBe('accepting');
  });
});

describe('assignment eligibility', () => {
  it('accepts a live accepting agent of the conversation store', () => {
    expect(
      assignmentEligibility({ candidate: candidate(), conversationStoreId: 'store-1', now: NOW })
        .eligible,
    ).toBe(true);
  });

  it('refuses an administrator, who holds no seat', () => {
    for (const role of ['platform_admin', 'merchant_admin'] as const) {
      const verdict = assignmentEligibility({
        candidate: candidate({ role }),
        conversationStoreId: 'store-1',
        now: NOW,
      });
      expect(verdict.eligible).toBe(false);
      expect(verdict.eligible ? undefined : verdict.code).toBe('not_an_agent');
    }
  });

  it('refuses a disabled member', () => {
    const verdict = assignmentEligibility({
      candidate: candidate({ enabled: false }),
      conversationStoreId: 'store-1',
      now: NOW,
    });
    expect(verdict.eligible ? undefined : verdict.code).toBe('target_disabled');
  });

  it('refuses an agent of another store', () => {
    const verdict = assignmentEligibility({
      candidate: candidate({ storeId: 'store-2' }),
      conversationStoreId: 'store-1',
      now: NOW,
    });
    expect(verdict.eligible ? undefined : verdict.code).toBe('target_scope_mismatch');
  });

  it('refuses a seat with no heartbeat at all', () => {
    const verdict = assignmentEligibility({
      candidate: candidate({ heartbeatAt: null }),
      conversationStoreId: 'store-1',
      now: NOW,
    });
    expect(verdict.eligible ? undefined : verdict.code).toBe('target_offline');
  });

  it('refuses a seat whose heartbeat lapsed', () => {
    const stale = new Date(Date.parse(NOW) - AGENT_PRESENCE_TTL_MS - 1).toISOString();
    const verdict = assignmentEligibility({
      candidate: candidate({ heartbeatAt: stale }),
      conversationStoreId: 'store-1',
      now: NOW,
    });
    expect(verdict.eligible ? undefined : verdict.code).toBe('target_offline');
  });

  it('refuses a live seat that is not accepting work', () => {
    for (const status of ['busy', 'away'] as const) {
      const verdict = assignmentEligibility({
        candidate: candidate({ status }),
        conversationStoreId: 'store-1',
        now: NOW,
      });
      expect(verdict.eligible).toBe(false);
      expect(verdict.eligible ? undefined : verdict.code).toBe('target_not_accepting');
    }
  });

  it('names the first thing wrong, so the reason does not depend on iteration order', () => {
    // An administrator who is also in the wrong store, disabled and not
    // accepting: the verdict is the seat itself, not any of the rest.
    const verdict = assignmentEligibility({
      candidate: candidate({
        role: 'platform_admin',
        enabled: false,
        storeId: 'store-2',
        status: 'offline',
        heartbeatAt: null,
      }),
      conversationStoreId: 'store-1',
      now: NOW,
    });
    expect(verdict.eligible ? undefined : verdict.code).toBe('not_an_agent');
  });
});

describe('choosing the assignee', () => {
  it('picks the fewest conversations in progress', () => {
    const chosen = selectAutoAssignee(
      [
        candidate({ memberId: 'u-a', inProgressCount: 3 }),
        candidate({ memberId: 'u-b', inProgressCount: 1 }),
        candidate({ memberId: 'u-c', inProgressCount: 2 }),
      ],
      'store-1',
      NOW,
    );
    expect(chosen?.memberId).toBe('u-b');
  });

  it('breaks a tie on member id, not on input order', () => {
    const chosen = selectAutoAssignee(
      [
        candidate({ memberId: 'u-b', inProgressCount: 2 }),
        candidate({ memberId: 'u-a', inProgressCount: 2 }),
      ],
      'store-1',
      NOW,
    );
    expect(chosen?.memberId).toBe('u-a');
  });

  it('breaks a tie the same way whatever order the candidates arrive in', () => {
    const ids = ['u-a', 'u-b', 'u-c', 'u-d'];
    const forwards = selectAutoAssignee(
      ids.map((memberId) => candidate({ memberId, inProgressCount: 1 })),
      'store-1',
      NOW,
    );
    const backwards = selectAutoAssignee(
      [...ids].reverse().map((memberId) => candidate({ memberId, inProgressCount: 1 })),
      'store-1',
      NOW,
    );
    expect(forwards?.memberId).toBe('u-a');
    expect(backwards?.memberId).toBe(forwards?.memberId);
  });

  it('ignores an ineligible seat even when it is the least loaded', () => {
    const chosen = selectAutoAssignee(
      [
        candidate({ memberId: 'u-a', inProgressCount: 0, status: 'busy' }),
        candidate({ memberId: 'u-b', inProgressCount: 7 }),
      ],
      'store-1',
      NOW,
    );
    expect(chosen?.memberId).toBe('u-b');
  });

  it('returns nothing when every seat is ineligible', () => {
    expect(
      selectAutoAssignee(
        [
          candidate({ memberId: 'u-a', status: 'offline' }),
          candidate({ memberId: 'u-b', role: 'merchant_admin' }),
          candidate({ memberId: 'u-c', storeId: 'store-2' }),
        ],
        'store-1',
        NOW,
      ),
    ).toBeUndefined();
  });

  it('returns nothing when the store has no seats at all', () => {
    expect(selectAutoAssignee([], 'store-1', NOW)).toBeUndefined();
  });
});

describe('分流权重', () => {
  it('divides the load by the weight instead of comparing it raw', () => {
    // The busier seat carries the heavier weight, so its share of the queue is
    // already the smaller one and the next conversation is its.
    const chosen = selectAutoAssignee(
      [
        candidate({ memberId: 'u-a', inProgressCount: 2, weight: 3 }),
        candidate({ memberId: 'u-b', inProgressCount: 1, weight: 1 }),
      ],
      'store-1',
      NOW,
    );
    expect(chosen?.memberId).toBe('u-a');
  });

  it('reduces to fewest-in-progress when every weight is equal', () => {
    const chosen = selectAutoAssignee(
      [
        candidate({ memberId: 'u-a', inProgressCount: 4, weight: 2 }),
        candidate({ memberId: 'u-b', inProgressCount: 1, weight: 2 }),
      ],
      'store-1',
      NOW,
    );
    expect(chosen?.memberId).toBe('u-b');
  });

  it('reads the weight as a ratio, so 60/40 and 6/4 are the same policy', () => {
    const wide = selectAutoAssignee(
      [
        candidate({ memberId: 'u-a', inProgressCount: 4, weight: 60 }),
        candidate({ memberId: 'u-b', inProgressCount: 2, weight: 40 }),
      ],
      'store-1',
      NOW,
    );
    const narrow = selectAutoAssignee(
      [
        candidate({ memberId: 'u-a', inProgressCount: 4, weight: 6 }),
        candidate({ memberId: 'u-b', inProgressCount: 2, weight: 4 }),
      ],
      'store-1',
      NOW,
    );
    expect(wide?.memberId).toBe('u-b');
    expect(narrow?.memberId).toBe(wide?.memberId);
  });

  it('skips a seat weighted zero even when it is the idlest', () => {
    const chosen = selectAutoAssignee(
      [
        candidate({ memberId: 'u-a', inProgressCount: 0, weight: 0 }),
        candidate({ memberId: 'u-b', inProgressCount: 5, weight: 1 }),
      ],
      'store-1',
      NOW,
    );
    expect(chosen?.memberId).toBe('u-b');
  });

  it('finds nobody when every eligible seat weighs zero', () => {
    expect(
      selectAutoAssignee(
        [
          candidate({ memberId: 'u-a', inProgressCount: 0, weight: 0 }),
          candidate({ memberId: 'u-b', inProgressCount: 0, weight: 0 }),
        ],
        'store-1',
        NOW,
      ),
    ).toBeUndefined();
  });

  it('leaves a zero-weight seat available for a manual transfer', () => {
    // The weight governs the dispatcher only. Naming a seat by hand is a
    // different act, and an administrator who took a seat out of the rotation did
    // not forbid sending it work.
    expect(
      transferTargetRefusal({
        target: candidate({ memberId: 'u-a', weight: 0 }),
        conversationStoreId: 'store-1',
        now: NOW,
      }),
    ).toBeUndefined();
  });

  it('breaks an exact tie on member id rather than on rounding', () => {
    // 3/7 and 6/14 are the same load. Comparing quotients as floats could order
    // them by a difference that is not a difference, so the id decides.
    const chosen = selectAutoAssignee(
      [
        candidate({ memberId: 'u-b', inProgressCount: 6, weight: 14 }),
        candidate({ memberId: 'u-a', inProgressCount: 3, weight: 7 }),
      ],
      'store-1',
      NOW,
    );
    expect(chosen?.memberId).toBe('u-a');
  });
});

describe('isValidAssignmentWeight', () => {
  it('accepts a whole number of shares, including none', () => {
    expect(isValidAssignmentWeight(0)).toBe(true);
    expect(isValidAssignmentWeight(1)).toBe(true);
    expect(isValidAssignmentWeight(1000)).toBe(true);
  });

  it('refuses a fraction, a negative, an out-of-range number and a non-number', () => {
    expect(isValidAssignmentWeight(1.5)).toBe(false);
    expect(isValidAssignmentWeight(-1)).toBe(false);
    expect(isValidAssignmentWeight(1001)).toBe(false);
    expect(isValidAssignmentWeight('3')).toBe(false);
    expect(isValidAssignmentWeight(undefined)).toBe(false);
    expect(isValidAssignmentWeight(Number.NaN)).toBe(false);
  });
});

describe('the set a pool entry belongs to', () => {
  it('lists only the eligible seats, in a stable order', () => {
    expect(
      assignmentAudience(
        [
          candidate({ memberId: 'u-c' }),
          candidate({ memberId: 'u-a', status: 'away' }),
          candidate({ memberId: 'u-b' }),
        ],
        'store-1',
        NOW,
      ),
    ).toEqual(['u-b', 'u-c']);
  });

  it('is empty when nobody could take the conversation', () => {
    expect(assignmentAudience([candidate({ status: 'offline' })], 'store-1', NOW)).toEqual([]);
  });
});

describe('transferring to a named agent', () => {
  it('allows a live accepting agent of the conversation store', () => {
    expect(
      transferTargetRefusal({
        target: candidate(),
        conversationStoreId: 'store-1',
        now: NOW,
      }),
    ).toBeUndefined();
  });

  it('refuses an offline target, which would strand the conversation', () => {
    expect(
      transferTargetRefusal({
        target: candidate({ status: 'offline' }),
        conversationStoreId: 'store-1',
        now: NOW,
      }),
    ).toBe('target_offline');
  });

  it('refuses an agent of another store', () => {
    expect(
      transferTargetRefusal({
        target: candidate({ storeId: 'store-2' }),
        conversationStoreId: 'store-1',
        now: NOW,
      }),
    ).toBe('target_scope_mismatch');
  });

  it('honours an explicit liveness window', () => {
    const heartbeatAt = new Date(Date.parse(NOW) - 5_000).toISOString();
    expect(
      transferTargetRefusal({
        target: candidate({ heartbeatAt }),
        conversationStoreId: 'store-1',
        now: NOW,
        ttlMs: 1_000,
      }),
    ).toBe('target_offline');
  });
});

describe('pool state', () => {
  it('is due when open and unassigned', () => {
    expect(isAssignmentDue(pooled())).toBe(true);
  });

  it('is not due once assigned or closed', () => {
    expect(isAssignmentDue(pooled({ status: 'claimed', assignedMemberId: 'u-agent-1' }))).toBe(
      false,
    );
    expect(isAssignmentDue(pooled({ status: 'closed' }))).toBe(false);
  });

  it('is the offline fallback only after the customer has been acknowledged', () => {
    expect(isOfflineFallback(pooled())).toBe(false);
    expect(isOfflineFallback(pooled({ offlineReplyAt: NOW }))).toBe(true);
  });

  it('is not the offline fallback once someone took it', () => {
    expect(
      isOfflineFallback(
        pooled({ status: 'claimed', assignedMemberId: 'u-agent-1', offlineReplyAt: NOW }),
      ),
    ).toBe(false);
  });

  it('leaves the offline fallback even though the entry stays due', () => {
    // The two are deliberately independent: falling back does not clear the due
    // time, which is what lets a later sweep still assign the conversation.
    const fallenBack = pooled({ offlineReplyAt: NOW });
    expect(isOfflineFallback(fallenBack)).toBe(true);
    expect(isAssignmentDue(fallenBack)).toBe(true);
  });
});

describe('first response duration', () => {
  it('measures from the pool-entry clock to the first reply', () => {
    const repliedAt = new Date(Date.parse(NOW) + 4_000).toISOString();
    expect(firstResponseDurationMs(NOW, repliedAt)).toBe(4_000);
  });

  it('is unknown until both ends exist', () => {
    expect(firstResponseDurationMs(null, NOW)).toBeUndefined();
    expect(firstResponseDurationMs(NOW, null)).toBeUndefined();
    expect(firstResponseDurationMs(null, null)).toBeUndefined();
  });
});

describe('planning an assignment', () => {
  it('assigns to the least loaded eligible seat', () => {
    const plan = planAutoAssign({
      conversation: pooled(),
      candidates: [
        candidate({ memberId: 'u-a', inProgressCount: 4 }),
        candidate({ memberId: 'u-b', inProgressCount: 1 }),
      ],
      now: NOW,
    });
    expect(plan).toEqual({ kind: 'assign', toMemberId: 'u-b' });
  });

  it('falls back with an offline reply when nobody is eligible', () => {
    const plan = planAutoAssign({
      conversation: pooled(),
      candidates: [candidate({ status: 'offline' })],
      now: NOW,
    });
    expect(plan).toEqual({ kind: 'fallback', needsOfflineReply: true });
  });

  it('falls back when the store has no seats', () => {
    expect(planAutoAssign({ conversation: pooled(), candidates: [], now: NOW })).toEqual({
      kind: 'fallback',
      needsOfflineReply: true,
    });
  });

  it('waits rather than acknowledging twice once the reply has gone out', () => {
    const plan = planAutoAssign({
      conversation: pooled({ offlineReplyAt: NOW }),
      candidates: [],
      now: NOW,
    });
    expect(plan).toEqual({ kind: 'wait' });
  });

  it('still assigns a fallen-back conversation when an agent appears later', () => {
    // The offline reply does not end the conversation's claim on an agent: an
    // agent who comes online afterwards picks it up.
    const plan = planAutoAssign({
      conversation: pooled({ offlineReplyAt: NOW }),
      candidates: [candidate({ inProgressCount: 0 })],
      now: NOW,
    });
    expect(plan).toEqual({ kind: 'assign', toMemberId: 'u-agent-1' });
  });

  it('skips a conversation that already has an owner', () => {
    const plan = planAutoAssign({
      conversation: pooled({ status: 'claimed', assignedMemberId: 'u-a' }),
      candidates: [candidate()],
      now: NOW,
    });
    expect(plan).toEqual({ kind: 'skip' });
  });

  it('skips a closed conversation', () => {
    expect(
      planAutoAssign({
        conversation: pooled({ status: 'closed' }),
        candidates: [candidate()],
        now: NOW,
      }),
    ).toEqual({ kind: 'skip' });
  });
});

describe('closed vocabularies', () => {
  it('accepts exactly the four availability statuses', () => {
    expect([...AGENT_AVAILABILITY_STATUSES]).toEqual(['accepting', 'busy', 'away', 'offline']);
    for (const status of AGENT_AVAILABILITY_STATUSES) {
      expect(isAgentAvailabilityStatus(status)).toBe(true);
    }
  });

  it('rejects anything outside the vocabulary', () => {
    for (const value of ['online', 'ACCEPTING', '', 'busy ', null, 42, undefined]) {
      expect(isAgentAvailabilityStatus(value)).toBe(false);
    }
  });

  it('recognises an agent seat', () => {
    const member = (role: Member['role']): Member => ({
      id: 'u-1',
      tenantId: 'tenant-1',
      storeId: 'store-1',
      role,
      username: 'agent',
      displayName: 'Agent',
      enabled: true,
      createdAt: NOW,
    });
    expect(isAgentSeat(member('agent'))).toBe(true);
    expect(isAgentSeat(member('merchant_admin'))).toBe(false);
    expect(isAgentSeat(member('platform_admin'))).toBe(false);
  });
});
