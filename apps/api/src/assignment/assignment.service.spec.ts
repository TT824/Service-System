import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { KefuStore, type Member, type RealtimeEvent } from '@kefu/core';
import { MemoryPlatformRepository } from '../platform/memory-platform.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { AssignmentService } from './assignment.service';

const T1 = 'tenant-acme';
const S1 = 'store-acme-flagship';
const POOLED = 'conversation-acme-2';
const NOW = '2026-09-14T10:00:00.000Z';

/**
 * The agent seat of a seeded member.
 *
 * @param id - Seeded member id.
 * @returns The member as the access service would resolve it.
 */
function agent(id: string): Member {
  return {
    id,
    tenantId: T1,
    storeId: S1,
    role: 'agent',
    username: id,
    displayName: id,
    enabled: true,
    createdAt: NOW,
  };
}

/**
 * A member with no seat to accept work from.
 *
 * @param role - The non-agent role to build.
 * @returns The member as the access service would resolve it.
 */
function nonAgent(role: 'merchant_admin' | 'platform_admin'): Member {
  return {
    id: role === 'merchant_admin' ? 'u-t1-admin' : 'u-platform-admin',
    tenantId: role === 'merchant_admin' ? T1 : null,
    storeId: null,
    role,
    username: role,
    displayName: role,
    enabled: true,
    createdAt: NOW,
  };
}

/**
 * A fresh service over a fresh deterministic store.
 *
 * @returns The service, the repository it writes through, the store behind both
 * (so a test can seed, inspect the history, or drive a rival instance), and the
 * publisher the service announces through, so a test can assert on the frames a
 * seat would receive.
 */
function build(): {
  service: AssignmentService;
  repository: MemoryPlatformRepository;
  store: KefuStore;
  realtime: RealtimeService;
} {
  const store = new KefuStore();
  const repository = new MemoryPlatformRepository(store);
  const realtime = new RealtimeService();
  return { service: new AssignmentService(repository, realtime), repository, store, realtime };
}

/**
 * Collect the frames published while an action runs.
 *
 * @param realtime - The publisher to listen to.
 * @param action - The work whose frames to collect.
 * @returns Every frame published during the action, in order.
 */
async function framesDuring(
  realtime: RealtimeService,
  action: () => Promise<unknown>,
): Promise<ReadonlyArray<RealtimeEvent>> {
  const frames: RealtimeEvent[] = [];
  const detach = realtime.subscribe((event) => frames.push(event));
  try {
    await action();
  } finally {
    detach();
  }
  return frames;
}

describe('AssignmentService', () => {
  describe('availability reporting', () => {
    it('records the acting member own availability in its own store', async () => {
      const { service } = build();
      const presence = await service.setPresence(T1, agent('u-t1-agent-1'), 'accepting', NOW);
      expect(presence).toMatchObject({
        tenantId: T1,
        memberId: 'u-t1-agent-1',
        storeId: S1,
        status: 'accepting',
        heartbeatAt: NOW,
      });
    });

    it('refuses an administrator, who has no seat to accept work from', async () => {
      const { service } = build();
      await expect(
        service.setPresence(T1, nonAgent('merchant_admin'), 'accepting', NOW),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.setPresence(T1, nonAgent('platform_admin'), 'offline', NOW),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('reports nothing for a member who has never reported', async () => {
      const { service } = build();
      expect(await service.presence(T1, agent('u-t1-agent-1'))).toBeUndefined();
    });

    it('refreshes a heartbeat without moving the status or the changed instant', async () => {
      const { service } = build();
      await service.setPresence(T1, agent('u-t1-agent-1'), 'away', NOW);
      const later = '2026-09-14T10:00:30.000Z';
      const refreshed = await service.heartbeat(T1, agent('u-t1-agent-1'), later);
      expect(refreshed).toMatchObject({ status: 'away', heartbeatAt: later, changedAt: NOW });
    });

    it('refuses to let a heartbeat invent a status the agent never set', async () => {
      const { service } = build();
      await expect(service.heartbeat(T1, agent('u-t1-agent-1'), NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('one sweep with nobody available', () => {
    it('parks the pooled conversation, keeps it in the pool, and tells the customer once', async () => {
      const { service, store } = build();
      const first = await service.runOnce(NOW, 20);
      expect(first.fellBack).toEqual([POOLED]);
      expect(first.assigned).toEqual([]);

      const parked = store.getConversation(T1, POOLED);
      expect(parked).toMatchObject({
        // Still in the pool, because the pool is what retries it.
        status: 'open',
        assignedMemberId: null,
        offlineReplyAt: NOW,
        dispatchAttempts: 1,
      });
      // The customer received one automated message, and it is recorded as
      // automated so it neither enters review nor stops the first-reply clock.
      const sent = store
        .listMessages(T1, POOLED)
        .filter((message) => message.direction === 'outbound');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ source: 'other', reviewEligible: false });
      expect(store.getConversation(T1, POOLED)?.firstReplyAt).toBeNull();
    });

    it('does not apologise a second time on the next sweep', async () => {
      const { service, store } = build();
      await service.runOnce(NOW, 20);
      const second = await service.runOnce('2026-09-14T10:00:05.000Z', 20);
      expect(second.fellBack).toEqual([]);
      expect(second.waiting).toEqual([POOLED]);
      const outbound = store
        .listMessages(T1, POOLED)
        .filter((message) => message.direction === 'outbound');
      expect(outbound).toHaveLength(1);
    });

    it('leaves a waiting conversation completely untouched', async () => {
      const { service, store } = build();
      await service.runOnce(NOW, 20);
      const parked = store.getConversation(T1, POOLED);
      await service.runOnce('2026-09-14T10:00:05.000Z', 20);
      // A conversation parked in the fallback is waiting for a seat, and waiting
      // is not an attempt: `wait` writes no row at all, so a conversation that
      // sits for an hour costs nothing. This is why the attempt counter stays
      // where the parking left it instead of climbing once per sweep.
      expect(store.getConversation(T1, POOLED)).toEqual(parked);
    });

    it('records the fallback as an expired release naming the reason', async () => {
      const { service, repository } = build();
      await service.runOnce(NOW, 20);
      const history = await repository.listAssignments(T1, POOLED);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        action: 'release',
        result: 'expired',
        reasonCode: 'no_eligible_agent',
        fromMemberId: null,
        toMemberId: null,
        stateVersionAfter: null,
      });
    });

    it('records an assignment as a success naming the seat that took it', async () => {
      const { service, repository } = build();
      await service.setPresence(T1, agent('u-t1-agent-1'), 'accepting', NOW);
      await service.runOnce(NOW, 20);
      const history = await repository.listAssignments(T1, POOLED);
      expect(history[0]).toMatchObject({
        action: 'auto_assign',
        result: 'success',
        reasonCode: null,
        toMemberId: 'u-t1-agent-1',
      });
      expect(history[0]?.stateVersionAfter).toBeGreaterThan(
        history[0]?.stateVersionBefore ?? Number.POSITIVE_INFINITY,
      );
    });
  });

  describe('one sweep with an agent online', () => {
    it('assigns the pooled conversation to the only accepting seat', async () => {
      const { service, store } = build();
      await service.setPresence(T1, agent('u-t1-agent-1'), 'accepting', NOW);
      const result = await service.runOnce(NOW, 20);
      expect(result.assigned).toEqual([POOLED]);
      expect(store.getConversation(T1, POOLED)).toMatchObject({
        status: 'claimed',
        assignedMemberId: 'u-t1-agent-1',
        assignedAt: NOW,
        nextAssignmentAt: null,
        offlineReplyAt: null,
      });
    });

    it('prefers the seat already carrying less work', async () => {
      const { service, store } = build();
      // Agent 1 already holds the seeded claimed conversation, so agent 2 is the
      // least-loaded seat and must win despite sorting first.
      await service.setPresence(T1, agent('u-t1-agent-1'), 'accepting', NOW);
      await service.setPresence(T1, agent('u-t1-agent-2'), 'accepting', NOW);
      await service.runOnce(NOW, 20);
      expect(store.getConversation(T1, POOLED)?.assignedMemberId).toBe('u-t1-agent-2');
    });

    it('leaves a busy or away seat out of the running', async () => {
      const { service, store } = build();
      await service.setPresence(T1, agent('u-t1-agent-1'), 'busy', NOW);
      await service.setPresence(T1, agent('u-t1-agent-2'), 'away', NOW);
      const result = await service.runOnce(NOW, 20);
      expect(result.assigned).toEqual([]);
      expect(result.fellBack).toEqual([POOLED]);
      expect(store.getConversation(T1, POOLED)?.assignedMemberId).toBeNull();
    });

    it('leaves a seat whose heartbeat has gone stale out of the running', async () => {
      const { service, store } = build();
      await service.setPresence(T1, agent('u-t1-agent-1'), 'accepting', NOW);
      // One millisecond past the liveness window: the seat stopped reporting and
      // no browser is left to say so, which is exactly what the window detects.
      const stale = new Date(Date.parse(NOW) + 60_001).toISOString();
      const result = await service.runOnce(stale, 20);
      expect(result.assigned).toEqual([]);
      expect(store.getConversation(T1, POOLED)?.assignedMemberId).toBeNull();
    });

    it('keeps a conversation an agent already claimed out of the sweep', async () => {
      const { service, store } = build();
      await service.setPresence(T1, agent('u-t1-agent-2'), 'accepting', NOW);
      await service.runOnce(NOW, 20);
      // A new due conversation arrives while that agent is now offline. The one
      // it already holds must not be redistributed for it.
      await service.setPresence(T1, agent('u-t1-agent-2'), 'offline', NOW);
      const result = await service.runOnce('2026-09-14T10:01:00.000Z', 20);
      expect(result.assigned).toEqual([]);
      expect(store.getConversation(T1, POOLED)).toMatchObject({
        status: 'claimed',
        assignedMemberId: 'u-t1-agent-2',
      });
    });
  });

  describe('bounded sweeps', () => {
    it('considers no more conversations than the limit allows', async () => {
      const { service, store } = build();
      // A second pooled conversation, so there is something left over.
      store.ingestInbound({
        tenantId: T1,
        storeId: S1,
        channel: 'wecom',
        externalCustomerId: 'customer-2001',
        externalConversationId: 'wecom-ext-2001',
        content: '还有一个问题',
        now: NOW,
      });
      await service.setPresence(T1, agent('u-t1-agent-1'), 'accepting', NOW);
      const first = await service.runOnce(NOW, 1);
      expect(first.assigned).toHaveLength(1);
      const second = await service.runOnce(NOW, 20);
      expect(second.assigned).toHaveLength(1);
    });

    it('reports nothing to do once another sweeper has settled the pool', async () => {
      const { store, realtime } = build();
      // A rival instance over the same store wins the race outright. This is a
      // *sequential* reproduction of a lost compare-and-swap, not a concurrent
      // one: the in-memory store is synchronous, so nothing here proves the race
      // itself — the PostgreSQL integration spec is what exercises that.
      const rival = new AssignmentService(new MemoryPlatformRepository(store), realtime);
      await rival.setPresence(T1, agent('u-t1-agent-1'), 'accepting', NOW);
      expect((await rival.runOnce(NOW, 20)).assigned).toEqual([POOLED]);

      const loser = new AssignmentService(new MemoryPlatformRepository(store), realtime);
      expect(await loser.runOnce(NOW, 20)).toEqual({
        assigned: [],
        fellBack: [],
        waiting: [],
        lost: [],
        failed: [],
      });
      expect(store.getConversation(T1, POOLED)?.assignedMemberId).toBe('u-t1-agent-1');
    });
  });

  describe('announcements', () => {
    it('announces the seat state a report produced, scoped to its store', async () => {
      const { service, realtime } = build();
      const frames = await framesDuring(realtime, () =>
        service.setPresence(T1, agent('u-t1-agent-1'), 'accepting', NOW),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        event_type: 'presence.changed',
        tenant_id: T1,
        store_id: S1,
        data: { member_id: 'u-t1-agent-1', store_id: S1, status: 'accepting' },
      });
    });

    it('announces each conversation the sweep handed to a seat', async () => {
      const { service, realtime } = build();
      await service.setPresence(T1, agent('u-t1-agent-1'), 'accepting', NOW);
      const frames = await framesDuring(realtime, () => service.runOnce(NOW, 20));

      const updates = frames.filter((frame) => frame.event_type === 'conversation.updated');
      expect(updates).toHaveLength(1);
      // The row announced after the assignment, not the pooled row before it.
      expect(updates[0]).toMatchObject({
        tenant_id: T1,
        store_id: S1,
        data: {
          conversation_id: POOLED,
          status: 'claimed',
          assigned_member_id: 'u-t1-agent-1',
        },
      });
    });

    it('announces the automatic reply as a message, so a seat that comes online sees it', async () => {
      const { service, realtime } = build();
      const frames = await framesDuring(realtime, () => service.runOnce(NOW, 20));

      const messages = frames.filter((frame) => frame.event_type === 'message.created');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        tenant_id: T1,
        store_id: S1,
        data: { conversation_id: POOLED, direction: 'outbound' },
      });
    });
  });
});
