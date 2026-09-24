import { describe, expect, it } from 'vitest';
import type { Conversation } from './types';
import {
  claimConversation,
  closeConversation,
  conversationReadAccess,
  isAdministratorRole,
  maySendToConversation,
  openConversationForInbound,
  recordFirstReply,
  reopenConversation,
  returnConversation,
  touchConversationForInbound,
  transferConversation,
  type TakeoverAuthority,
} from './conversation';

const NOW = '2026-09-09T12:00:00.000Z';

/** The authority a seat acting on a conversation it holds itself carries. */
const SELF: TakeoverAuthority = { actorIsAdmin: false, actorStoreId: null, assigneeLive: true };

/** The authority of somebody acting on a conversation whose assignee is gone. */
function takeover(overrides: Partial<TakeoverAuthority> = {}): TakeoverAuthority {
  return {
    actorIsAdmin: false,
    actorStoreId: 'store-acme-flagship',
    assigneeLive: false,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conversation-1',
    tenantId: 'tenant-acme',
    storeId: 'store-acme-flagship',
    channel: 'manual',
    externalCustomerId: 'customer-1001',
    externalConversationId: null,
    title: null,
    status: 'open',
    version: 1,
    assignedMemberId: null,
    openedAt: '2026-09-01T02:00:00.000Z',
    lastMessageAt: '2026-09-01T02:00:00.000Z',
    closedAt: null,
    createdAt: '2026-09-01T02:00:00.000Z',
    // A pooled round, which is what most of these transitions start from.
    pendingSince: '2026-09-01T02:00:00.000Z',
    firstResponseStartedAt: '2026-09-01T02:00:00.000Z',
    nextAssignmentAt: '2026-09-01T02:00:00.000Z',
    dispatchAttempts: 0,
    assignedAt: null,
    offlineReplyAt: null,
    firstReplyAt: null,
    ...overrides,
  };
}

describe('conversation transitions', () => {
  it('claims an open conversation with a matching version', () => {
    const result = claimConversation(conversation(), 1, 'u-t1-agent-1', NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.status).toBe('claimed');
    expect(result.conversation.assignedMemberId).toBe('u-t1-agent-1');
    expect(result.conversation.version).toBe(2);
  });

  it('refuses a stale claim with a stable conflict', () => {
    const result = claimConversation(conversation({ version: 5 }), 1, 'u-t1-agent-1', NOW);
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('refuses to claim an already claimed conversation', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-2',
      version: 2,
    });
    const result = claimConversation(current, 2, 'u-t1-agent-1', NOW);
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('lets the assigned agent return the conversation to the pool', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      version: 2,
    });
    const result = returnConversation(current, 2, 'u-t1-agent-1', SELF, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.status).toBe('open');
    expect(result.conversation.assignedMemberId).toBeNull();
    expect(result.conversation.version).toBe(3);
  });

  it('refuses return from a non-assigned agent while the assignee is live', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      version: 2,
    });
    // 受理人还在线：会话是他的，同店坐席也不能动。
    const result = returnConversation(
      current,
      2,
      'u-t1-agent-2',
      takeover({ assigneeLive: true }),
      NOW,
    );
    expect(result).toMatchObject({ ok: false, code: 'not_claimed' });
  });

  it('lets a same-store seat take over once the assignee is offline', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      version: 2,
    });
    const result = returnConversation(current, 2, 'u-t1-agent-2', takeover(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.status).toBe('open');
    expect(result.conversation.assignedMemberId).toBeNull();
    expect(result.conversation.nextAssignmentAt).toBe(NOW);
  });

  it('lets an administrator hand an offline assignee’s conversation to somebody else', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      version: 2,
    });
    const result = transferConversation(
      current,
      2,
      'u-t1-admin',
      takeover({ actorIsAdmin: true, actorStoreId: null }),
      'u-t1-agent-2',
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.assignedMemberId).toBe('u-t1-agent-2');
  });

  it('refuses a takeover from a seat of another store', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      version: 2,
    });
    const result = returnConversation(
      current,
      2,
      'u-t9-agent-1',
      takeover({ actorStoreId: 'store-other' }),
      NOW,
    );
    expect(result).toMatchObject({ ok: false, code: 'not_claimed' });
  });

  it('transfers between members with a matching version', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      version: 3,
    });
    const result = transferConversation(current, 3, 'u-t1-agent-1', SELF, 'u-t1-agent-2', NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.assignedMemberId).toBe('u-t1-agent-2');
    expect(result.conversation.version).toBe(4);
  });

  it('refuses transfer when the version is stale', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      version: 3,
    });
    const result = transferConversation(current, 2, 'u-t1-agent-1', SELF, 'u-t1-agent-2', NOW);
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('closes an assigned conversation for its agent and refuses double close', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      version: 2,
    });
    const closed = closeConversation(current, 2, 'u-t1-agent-1', false, NOW);
    expect(closed.ok).toBe(true);
    if (!closed.ok) {
      return;
    }
    expect(closed.conversation.status).toBe('closed');
    expect(closed.conversation.closedAt).toBe(NOW);

    const again = closeConversation(
      closed.conversation,
      closed.conversation.version,
      'u-t1-agent-1',
      false,
      NOW,
    );
    expect(again).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('reopens only a closed conversation with a version bump', () => {
    const current = conversation({ status: 'closed', version: 4, closedAt: NOW });
    const result = reopenConversation(current, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.status).toBe('open');
    expect(result.conversation.closedAt).toBeNull();
    expect(result.conversation.version).toBe(5);
  });

  it('rejects a manual reopen of an open conversation', () => {
    const result = reopenConversation(conversation(), NOW);
    expect(result).toMatchObject({ ok: false, code: 'invalid_state' });
  });

  it('reopens a closed conversation on a new inbound message', () => {
    const current = conversation({ status: 'closed', version: 4, closedAt: NOW });
    const result = touchConversationForInbound(current, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.status).toBe('open');
    expect(result.conversation.version).toBe(5);
  });
});

describe('the pool schedule', () => {
  const LATER = '2026-09-09T13:00:00.000Z';

  it('opens a brand-new conversation already due for assignment', () => {
    const created = openConversationForInbound({
      id: 'conversation-new',
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      channel: 'manual',
      externalCustomerId: 'customer-2001',
      externalConversationId: null,
      now: NOW,
    });
    expect(created.status).toBe('open');
    expect(created.version).toBe(1);
    expect(created.assignedMemberId).toBeNull();
    // Due at the instant it opens: there is no window to wait out.
    expect(created.nextAssignmentAt).toBe(NOW);
    expect(created.pendingSince).toBe(NOW);
    expect(created.firstResponseStartedAt).toBe(NOW);
    expect(created.dispatchAttempts).toBe(0);
    expect(created.assignedAt).toBeNull();
    expect(created.offlineReplyAt).toBeNull();
    expect(created.firstReplyAt).toBeNull();
  });

  it('takes a claimed conversation out of the schedule', () => {
    const result = claimConversation(conversation(), 1, 'u-t1-agent-1', NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.nextAssignmentAt).toBeNull();
    expect(result.conversation.assignedAt).toBe(NOW);
    expect(result.conversation.dispatchAttempts).toBe(0);
  });

  it('puts a transferred conversation under its new owner, still out of the pool', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      assignedAt: NOW,
      nextAssignmentAt: null,
      version: 3,
    });
    const result = transferConversation(current, 3, 'u-t1-agent-1', SELF, 'u-t1-agent-2', LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.assignedAt).toBe(LATER);
    expect(result.conversation.nextAssignmentAt).toBeNull();
  });

  it('returns a conversation to the pool due immediately', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      assignedAt: NOW,
      nextAssignmentAt: null,
      version: 2,
    });
    const result = returnConversation(current, 2, 'u-t1-agent-1', SELF, LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.pendingSince).toBe(LATER);
    expect(result.conversation.nextAssignmentAt).toBe(LATER);
    expect(result.conversation.assignedAt).toBeNull();
    // The customer's wait did not restart because an agent changed their mind.
    expect(result.conversation.firstResponseStartedAt).toBe('2026-09-01T02:00:00.000Z');
  });

  it('takes a closed conversation out of the schedule entirely', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      version: 2,
    });
    const result = closeConversation(current, 2, 'u-t1-agent-1', false, LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.nextAssignmentAt).toBeNull();
    expect(result.conversation.assignedAt).toBeNull();
  });

  it('reopens a closed conversation as a fresh round', () => {
    const current = conversation({
      status: 'closed',
      version: 4,
      closedAt: NOW,
      nextAssignmentAt: null,
      firstReplyAt: NOW,
    });
    const result = reopenConversation(current, LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.pendingSince).toBe(LATER);
    expect(result.conversation.nextAssignmentAt).toBe(LATER);
    // A new round has not been replied to yet.
    expect(result.conversation.firstReplyAt).toBeNull();
    // But the customer's original wait still stands.
    expect(result.conversation.firstResponseStartedAt).toBe('2026-09-01T02:00:00.000Z');
  });

  it('leaves the pool schedule alone when a customer speaks again', () => {
    // The load-bearing one: a chatty customer must not push the due time out of
    // reach, and must not reset the attempt counter.
    const current = conversation({
      pendingSince: '2026-09-01T02:00:00.000Z',
      nextAssignmentAt: '2026-09-01T02:00:00.000Z',
      dispatchAttempts: 3,
    });
    const result = touchConversationForInbound(current, LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.nextAssignmentAt).toBe('2026-09-01T02:00:00.000Z');
    expect(result.conversation.pendingSince).toBe('2026-09-01T02:00:00.000Z');
    expect(result.conversation.dispatchAttempts).toBe(3);
    expect(result.conversation.lastMessageAt).toBe(LATER);
    expect(result.conversation.version).toBe(2);
  });

  it('leaves the schedule alone for a claimed conversation too', () => {
    const current = conversation({
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      assignedAt: NOW,
      nextAssignmentAt: null,
      version: 2,
    });
    const result = touchConversationForInbound(current, LATER);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conversation.assignedMemberId).toBe('u-t1-agent-1');
    expect(result.conversation.assignedAt).toBe(NOW);
    expect(result.conversation.nextAssignmentAt).toBeNull();
  });
});

describe('who may read a conversation', () => {
  const HANDED_OFF = '2026-09-09T08:00:00.000Z';
  const MINE = { status: 'claimed', assignedMemberId: 'u-t1-agent-1' } as const;
  const THEIRS = { status: 'claimed', assignedMemberId: 'u-t1-agent-2' } as const;
  const POOLED = { status: 'open', assignedMemberId: null } as const;
  const FINISHED = { status: 'closed', assignedMemberId: null } as const;

  it('gives a seat the whole conversation it is holding', () => {
    expect(
      conversationReadAccess({
        conversation: MINE,
        readerMemberId: 'u-t1-agent-1',
        readerIsAdmin: false,
        handedOffAt: undefined,
      }),
    ).toEqual({ kind: 'full' });
  });

  it('gives any seat the pool it could claim', () => {
    expect(
      conversationReadAccess({
        conversation: POOLED,
        readerMemberId: 'u-t1-agent-1',
        readerIsAdmin: false,
        handedOffAt: undefined,
      }),
    ).toEqual({ kind: 'full' });
  });

  it('gives any seat a finished round nobody holds', () => {
    // 已结束＝没人持有（`close` 会清掉受理人）。不加这一条的话，坐席刚结束的会话
    // 会从队列里消失、点开还 403——那条路上没有第二个回到它的入口。
    expect(
      conversationReadAccess({
        conversation: FINISHED,
        readerMemberId: 'u-t1-agent-2',
        readerIsAdmin: false,
        handedOffAt: undefined,
      }),
    ).toEqual({ kind: 'full' });
  });

  it('refuses a seat a colleague’s conversation it never held', () => {
    expect(
      conversationReadAccess({
        conversation: THEIRS,
        readerMemberId: 'u-t1-agent-1',
        readerIsAdmin: false,
        handedOffAt: undefined,
      }),
    ).toBeUndefined();
  });

  it('keeps the seat that handed it over to the record it saw', () => {
    // 转交走的是会话，不是记录：交出去的那位只读到自己放手的那一刻。
    expect(
      conversationReadAccess({
        conversation: THEIRS,
        readerMemberId: 'u-t1-agent-1',
        readerIsAdmin: false,
        handedOffAt: HANDED_OFF,
      }),
    ).toEqual({ kind: 'history', until: HANDED_OFF });
  });

  it('gives it back in full once it is theirs again', () => {
    // 转手回来之后它就是自己的了，历史截断不再适用——先判「现在是谁的」。
    expect(
      conversationReadAccess({
        conversation: MINE,
        readerMemberId: 'u-t1-agent-1',
        readerIsAdmin: false,
        handedOffAt: HANDED_OFF,
      }),
    ).toEqual({ kind: 'full' });
  });

  it('lets an administrator read what no seat may', () => {
    expect(
      conversationReadAccess({
        conversation: THEIRS,
        readerMemberId: 'u-t1-admin',
        readerIsAdmin: true,
        handedOffAt: undefined,
      }),
    ).toEqual({ kind: 'full' });
  });

  it('names the two administrator roles', () => {
    expect(isAdministratorRole('merchant_admin')).toBe(true);
    expect(isAdministratorRole('platform_admin')).toBe(true);
    expect(isAdministratorRole('agent')).toBe(false);
  });
});

describe('who may speak in a conversation', () => {
  it('lets the seat holding it reply', () => {
    expect(
      maySendToConversation({
        conversation: { status: 'claimed', assignedMemberId: 'u-t1-agent-1' },
        memberId: 'u-t1-agent-1',
      }),
    ).toBe(true);
  });

  it('stops a colleague from joining a conversation', () => {
    // 同事的会话不是可以插话的群聊；转交出去之后原受理人落到的也是这一条——
    // 「这单不是你的」只有一份判据，所以这里只写一次。
    expect(
      maySendToConversation({
        conversation: { status: 'claimed', assignedMemberId: 'u-t1-agent-2' },
        memberId: 'u-t1-agent-1',
      }),
    ).toBe(false);
  });

  it('lets anybody speak into the pool, and nobody into a closed round', () => {
    // 池子是例外，而且它不是这条规则的漏洞：没人接走的单本来就可以先接话。
    // 已结束的那一行是这条例外的边界——`close` 会把受理人清空，少了状态这一半，
    // 结束的会话就会答成「谁都能说话」。
    expect(
      maySendToConversation({
        conversation: { status: 'open', assignedMemberId: null },
        memberId: 'u-t1-agent-1',
      }),
    ).toBe(true);
    expect(
      maySendToConversation({
        conversation: { status: 'closed', assignedMemberId: null },
        memberId: 'u-t1-agent-1',
      }),
    ).toBe(false);
  });
});

describe('the first-reply clock', () => {
  const REPLIED = '2026-09-09T12:00:05.000Z';

  it('stamps the first outbound of the round', () => {
    expect(recordFirstReply(conversation(), REPLIED).firstReplyAt).toBe(REPLIED);
  });

  it('does not move on a second outbound', () => {
    const first = recordFirstReply(conversation(), REPLIED);
    const second = recordFirstReply(first, '2026-09-09T12:00:09.000Z');
    expect(second.firstReplyAt).toBe(REPLIED);
  });

  it('returns the very same object when there is nothing to stamp', () => {
    const replied = recordFirstReply(conversation(), REPLIED);
    expect(recordFirstReply(replied, '2026-09-09T12:00:09.000Z')).toBe(replied);
  });
});
