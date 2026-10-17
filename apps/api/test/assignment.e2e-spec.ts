import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KefuStore,
  SEEDED_PLATFORM_ADMIN_MEMBER_ID,
  parseAppConfig,
  type ConversationAssignment,
} from '@kefu/core';
import { AppModule } from '../src/app.module';
import { AssignmentScheduler } from '../src/assignment/assignment-scheduler';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';

const T1 = 'tenant-acme';
const T2 = 'tenant-beta';
const S1 = 'store-acme-flagship';
/** A second store of the *same* tenant, so a scope refusal is about the store. */
const S2 = 'store-acme-distribution';
const AGENT_1 = 'u-t1-agent-1';
const AGENT_2 = 'u-t1-agent-2';
const POOLED = 'conversation-acme-2';
const CLAIMED = 'conversation-acme-1';

/**
 * The instant these tests treat as now.
 *
 * Anchored to the real clock rather than a fixed date, because presence is
 * stamped by the HTTP handlers at real time: a fixed instant in the past would
 * make every seat look stale to a sweep, and one in the future would look
 * stale the other way round. The seeded conversations are all dated August and
 * early September, so they are well past due against any real instant.
 */
const NOW = new Date().toISOString();

/**
 * An instant a given number of milliseconds after {@link NOW}.
 *
 * @param ms - Offset from now.
 * @returns The instant as an ISO string.
 */
function later(ms: number): string {
  return new Date(Date.parse(NOW) + ms).toISOString();
}

type ErrorEnvelope = { request_id: string; code: string; message: string; details: unknown[] };
type DataEnvelope = { request_id: string; data: unknown };
type PoolEntry = {
  conversation: { id: string; status: string; assignedMemberId: string | null };
  waitingMs: number | null;
  firstResponseMs: number | null;
  audienceMemberIds: ReadonlyArray<string>;
};
type TransferTargetRow = {
  memberId: string;
  displayName: string;
  storeId: string | null;
  availability: string;
  inProgressCount: number;
};

/**
 * Interface tests for agent availability and automatic assignment.
 *
 * These boot the real Nest application over the real HTTP surface with the
 * in-process store, and drive the dispatcher by calling the scheduler's
 * `runOnce`, so a sweep is exercised end to end without waiting on its interval.
 *
 * What these tests cannot show is concurrency: the in-memory store is
 * synchronous, so a "two sweepers race" test here would be a sequential
 * reproduction wearing a concurrent name. The real compare-and-swap race is
 * covered by the PostgreSQL integration spec, and only there.
 */
describe('Assignment (interface)', () => {
  let app: INestApplication;
  let store: KefuStore;
  let scheduler: AssignmentScheduler;

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    }).compile();

    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);
    store = app.get(KefuStore);
    scheduler = app.get(AssignmentScheduler);
  });

  afterAll(async () => {
    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  beforeEach(() => {
    // These tests consume the pool — a claim, an assignment or a fallback all
    // change the state the next test reads — and the application is booted once
    // for the whole file, so the store is shared across tests. Reset it to the
    // pristine seed so every test states its own preconditions instead of
    // inheriting whatever the previous one left behind.
    //
    // `seed()` restores the members, conversations, messages and audit trail but
    // deliberately leaves presence, assignment history and 分流权重 alone, because
    // in production those outlive a directory reload — a weight especially, being
    // configuration rather than a runtime fact. A test needs them cleared too,
    // which is why the reset names each of them rather than calling `seed()`
    // alone.
    const internals = store as unknown as {
      seed: () => void;
      presence: unknown[];
      assignments: unknown[];
      routingWeights: unknown[];
    };
    internals.presence = [];
    internals.assignments = [];
    internals.routingWeights = [];
    internals.seed();
  });

  /**
   * Report an agent's availability over HTTP.
   *
   * @param memberId - The agent whose seat to set.
   * @param status - The availability to report.
   * @returns The response status, so a test can assert the refusal path too.
   */
  async function setPresence(memberId: string, status: string): Promise<number> {
    const response = await request(app.getHttpServer())
      .put('/api/v1/assignment/presence')
      .set('x-member-id', memberId)
      .send({ status });
    return response.status;
  }

  it('offers only live accepting colleagues as transfer targets and enforces read scope', async () => {
    const path = `/api/v1/conversations/${CLAIMED}/transfer-targets`;
    await setPresence(AGENT_1, 'accepting');
    await setPresence(AGENT_2, 'away');
    let response = await request(app.getHttpServer()).get(path).set('x-member-id', AGENT_1).expect(200);
    expect(response.body.data).toEqual([]);
    await setPresence(AGENT_2, 'accepting');
    response = await request(app.getHttpServer()).get(path).set('x-member-id', AGENT_1).expect(200);
    expect(response.body.data).toEqual([expect.objectContaining({ memberId: AGENT_2, displayName: expect.any(String) })]);
    await setPresence(AGENT_2, 'offline');
    response = await request(app.getHttpServer()).get(path).set('x-member-id', AGENT_1).expect(200);
    expect(response.body.data).toEqual([]);
    await request(app.getHttpServer()).get(path).set('x-member-id', 'u-t2-agent-1').expect(404);
  });

  /**
   * Read one conversation's assignment history over HTTP.
   *
   * @param conversationId - Conversation whose history to read.
   * @param memberId - The member to read as.
   * @returns The history as the API returned it.
   */
  async function assignments(
    conversationId: string,
    memberId = 'u-t1-admin',
  ): Promise<ReadonlyArray<ConversationAssignment>> {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}/assignments`)
      .set('x-member-id', memberId)
      .expect(200);
    return (response.body as DataEnvelope).data as ReadonlyArray<ConversationAssignment>;
  }

  describe('acceptance 3: only an agent who is online and accepting receives work', () => {
    it('assigns the pooled conversation to the accepting seat when the other is offline', async () => {
      // Agent 1 stays silent, which is the store's default and means offline.
      expect(await setPresence(AGENT_2, 'accepting')).toBe(200);

      const result = await scheduler.runOnce(NOW);
      expect(result.assigned).toEqual([POOLED]);
      expect(store.getConversation(T1, POOLED)?.assignedMemberId).toBe(AGENT_2);
    });

    it('leaves a busy and an away seat out of the running', async () => {
      expect(await setPresence(AGENT_1, 'busy')).toBe(200);
      expect(await setPresence(AGENT_2, 'away')).toBe(200);

      const result = await scheduler.runOnce(NOW);
      expect(result.assigned).toEqual([]);
      expect(result.fellBack).toEqual([POOLED]);
      expect(store.getConversation(T1, POOLED)?.assignedMemberId).toBeNull();
    });

    it('refuses to record availability for an administrator, who holds no seat', async () => {
      const response = await request(app.getHttpServer())
        .put('/api/v1/assignment/presence')
        .set('x-member-id', 'u-t1-admin')
        .send({ status: 'accepting' })
        .expect(403);
      expect((response.body as ErrorEnvelope).code).toBe('forbidden');
    });

    it('refuses an availability value outside the closed set', async () => {
      const response = await request(app.getHttpServer())
        .put('/api/v1/assignment/presence')
        .set('x-member-id', AGENT_1)
        .send({ status: 'available' })
        .expect(400);
      expect((response.body as ErrorEnvelope).code).toBe('bad_request');
    });

    it('refuses a heartbeat from a seat that never reported a status', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/assignment/presence/heartbeat')
        .set('x-member-id', AGENT_1)
        .expect(404);
      expect((response.body as ErrorEnvelope).code).toBe('not_found');
    });

    it('refreshes a live seat so a later sweep still sees it', async () => {
      await setPresence(AGENT_1, 'accepting');
      const beat = await request(app.getHttpServer())
        .post('/api/v1/assignment/presence/heartbeat')
        .set('x-member-id', AGENT_1)
        .expect(201);
      const presence = (beat.body as DataEnvelope).data as { status: string; heartbeatAt: string };
      expect(presence.status).toBe('accepting');
      // The heartbeat moves liveness only: the status it did not carry is intact.
      // Being at or after this module's instant is enough — the handler stamps
      // real time, which is the same instant or a few milliseconds later.
      expect(Date.parse(presence.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(NOW));
    });

    it('reads back the acting member own availability and nobody else', async () => {
      await setPresence(AGENT_1, 'away');
      const mine = await request(app.getHttpServer())
        .get('/api/v1/assignment/presence')
        .set('x-member-id', AGENT_1)
        .expect(200);
      expect((mine.body as DataEnvelope).data).toMatchObject({
        memberId: AGENT_1,
        storeId: S1,
        status: 'away',
      });
      const other = await request(app.getHttpServer())
        .get('/api/v1/assignment/presence')
        .set('x-member-id', AGENT_2)
        .expect(200);
      // A seat that has never reported has no state to show, and the envelope
      // carries no `data` key at all rather than a null placeholder.
      expect((other.body as DataEnvelope).data).toBeUndefined();
    });
  });

  /**
   * The roster read: a tenant's seats, for the administrator drawing them.
   *
   * The console's 客服账号 page shows each row's 在线/离线, and presence used to be
   * self-only — `GET /assignment/presence` answers the caller about themselves —
   * so until this route existed a colleague's status had no source at all. What
   * these tests pin is not the shape of a row (that is `agent_presence`) but the
   * three things the roster depends on: the answer is the *reported* seats, it
   * stays inside one tenant, and only an administrator may ask.
   */
  describe('the roster read: a tenant’s seat presence for its administrator', () => {
    type PresenceRow = {
      readonly memberId: string;
      readonly storeId: string;
      readonly status: string;
    };

    it('lists every seat that reported in, with the store it sits in', async () => {
      expect(await setPresence(AGENT_1, 'accepting')).toBe(200);
      expect(await setPresence(AGENT_2, 'away')).toBe(200);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/admin/tenants/${T1}/presence`)
        .set('x-member-id', 'u-t1-admin')
        .expect(200);
      const rows = (response.body as DataEnvelope).data as ReadonlyArray<PresenceRow>;
      const byMember = new Map(rows.map((row) => [row.memberId, row]));

      expect([...byMember.keys()].sort()).toEqual([AGENT_1, AGENT_2]);
      expect(byMember.get(AGENT_1)).toMatchObject({ storeId: S1, status: 'accepting' });
      expect(byMember.get(AGENT_2)).toMatchObject({ storeId: S1, status: 'away' });
    });

    it('omits a seat that never reported in, rather than naming it offline', async () => {
      expect(await setPresence(AGENT_1, 'accepting')).toBe(200);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/admin/tenants/${T1}/presence`)
        .set('x-member-id', 'u-t1-admin')
        .expect(200);
      const rows = (response.body as DataEnvelope).data as ReadonlyArray<PresenceRow>;

      // `agent_presence` stores nothing for an offline seat, so this answers with
      // the seats that *reported*, and the missing row is the whole of what the
      // roster has to read as 离线. Naming it `offline` here would put the
      // console's rule on the wire and make the two disagree the day it changed.
      expect(rows.map((row) => row.memberId)).toEqual([AGENT_1]);
    });

    it('keeps the read inside the tenant that was asked for', async () => {
      expect(await setPresence(AGENT_1, 'accepting')).toBe(200);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/admin/tenants/${T2}/presence`)
        .set('x-member-id', 'u-t2-admin')
        .expect(200);

      // Beta holds no seat rows of its own, and acme's are not borrowed into it.
      expect((response.body as DataEnvelope).data).toEqual([]);
    });

    it('lets a platform administrator read a tenant they do not belong to', async () => {
      expect(await setPresence(AGENT_1, 'accepting')).toBe(200);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/admin/tenants/${T1}/presence`)
        .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
        .expect(200);

      const rows = (response.body as DataEnvelope).data as ReadonlyArray<PresenceRow>;
      expect(rows.map((row) => row.memberId)).toEqual([AGENT_1]);
    });

    it('refuses an administrator of another tenant', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/admin/tenants/${T1}/presence`)
        .set('x-member-id', 'u-t2-admin')
        .expect(403);
    });

    it('refuses a seat asking about its colleagues', async () => {
      // An agent is neither the tenant's administrator nor a platform one, and
      // who else is on shift is not theirs to read.
      await request(app.getHttpServer())
        .get(`/api/v1/admin/tenants/${T1}/presence`)
        .set('x-member-id', AGENT_1)
        .expect(403);
    });
  });

  describe('acceptance 2: a losing claimant gets a business error and a recorded refusal', () => {
    it('records one success and one refusal for two claims of the same version', async () => {
      const first = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${POOLED}/claim`)
        .set('x-member-id', AGENT_1)
        .send({ expectedVersion: 2 })
        .expect(201);
      expect(
        ((first.body as DataEnvelope).data as { assignedMemberId: string }).assignedMemberId,
      ).toBe(AGENT_1);

      const second = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${POOLED}/claim`)
        .set('x-member-id', AGENT_2)
        .send({ expectedVersion: 2 })
        .expect(409);
      // The published code is the documented status code, not the rule's own
      // reason: the error filter replaces both the code and the message. The
      // reason is queryable where it belongs — in the history below.
      expect((second.body as ErrorEnvelope).code).toBe('conflict');

      const history = await assignments(POOLED);
      expect(history).toHaveLength(2);
      const results = history.map((row) => row.result).sort();
      expect(results).toEqual(['rejected', 'success']);
      const rejected = history.find((row) => row.result === 'rejected');
      expect(rejected).toMatchObject({
        action: 'claim',
        reasonCode: 'cas_conflict',
        toMemberId: AGENT_2,
      });
    });

    it('reports a claim as refused when an administrator reads the history', async () => {
      await setPresence(AGENT_1, 'accepting');
      await scheduler.runOnce(NOW);
      const history = await assignments(POOLED);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        action: 'auto_assign',
        result: 'success',
        toMemberId: AGENT_1,
        fromMemberId: null,
      });
    });
  });

  describe('acceptance 4: a seat dropping offline does not lose the work it holds', () => {
    it('keeps a claimed conversation with its agent and out of the pool', async () => {
      await setPresence(AGENT_2, 'accepting');
      await scheduler.runOnce(NOW);
      expect(store.getConversation(T1, POOLED)?.assignedMemberId).toBe(AGENT_2);

      await setPresence(AGENT_2, 'offline');
      // A sweep must not redistribute what is already held, however idle its
      // holder looks. Returning it is an explicit act, not a side effect.
      const result = await scheduler.runOnce(later(300_000));
      expect(result.assigned).toEqual([]);
      expect(store.getConversation(T1, POOLED)).toMatchObject({
        status: 'claimed',
        assignedMemberId: AGENT_2,
      });

      const pool = await request(app.getHttpServer())
        .get('/api/v1/conversations/pool')
        .set('x-member-id', 'u-t1-admin')
        .expect(200);
      const ids = ((pool.body as DataEnvelope).data as ReadonlyArray<PoolEntry>).map(
        (entry) => entry.conversation.id,
      );
      expect(ids).not.toContain(POOLED);
    });

    it('takes the conversation back into the pool only when the agent returns it', async () => {
      await setPresence(AGENT_2, 'accepting');
      await scheduler.runOnce(NOW);
      const claimed = store.getConversation(T1, POOLED);
      const waitedSince = claimed?.firstResponseStartedAt;
      await request(app.getHttpServer())
        .post(`/api/v1/conversations/${POOLED}/return`)
        .set('x-member-id', AGENT_2)
        .send({ expectedVersion: claimed?.version })
        .expect(201);

      const returned = store.getConversation(T1, POOLED);
      expect(returned).toMatchObject({ status: 'open', assignedMemberId: null });
      // Back in the pool means immediately due again, so the next sweep retries
      // it — and the customer's original wait is preserved, not restarted by the
      // agent changing its mind.
      expect(returned?.nextAssignmentAt).toBe(returned?.pendingSince);
      expect(returned?.firstResponseStartedAt).toBe(waitedSince);
    });
  });

  // The boundary this block used to draw was *within* a tenant: a seat was
  // pinned to a store and the pool, the history and the handover all narrowed to
  // it. C1 moved the boundary out to the organisation — a seat reads every store
  // of its own tenant, and no other tenant's. What is left here is isolation
  // between organisations, plus the store filter, which is still honoured: it
  // selects among what the caller could already read rather than deciding what
  // that is.
  describe('acceptance 5: isolation between organisations', () => {
    it('shows an agent its organisation pool, oldest wait first', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/conversations/pool')
        .set('x-member-id', AGENT_1)
        .expect(200);
      const entries = (response.body as DataEnvelope).data as ReadonlyArray<PoolEntry>;
      expect(entries.map((entry) => entry.conversation.id)).toEqual([POOLED]);
      expect(entries[0]?.conversation.status).toBe('open');
      expect(entries[0]?.audienceMemberIds).toEqual([]);
    });

    it('offers the conversation to a seat that has come online', async () => {
      await setPresence(AGENT_1, 'accepting');
      const response = await request(app.getHttpServer())
        .get('/api/v1/conversations/pool')
        .set('x-member-id', AGENT_1)
        .expect(200);
      const entries = (response.body as DataEnvelope).data as ReadonlyArray<PoolEntry>;
      expect(entries[0]?.audienceMemberIds).toEqual([AGENT_1]);
      expect(entries[0]?.waitingMs).toBeGreaterThan(0);
      // Still unanswered, so there is no duration yet — and the key is absent
      // from the JSON rather than null, which is what an absent measurement means.
      expect('firstResponseMs' in (entries[0] ?? {})).toBe(false);
    });

    it('honours an agent store filter instead of refusing it', async () => {
      // Used to be a 403: naming a store other than the seat's own was a scope
      // escalation, so it was refused before the filter was applied. The seat
      // may read the whole organisation now, so `S2` is inside its scope and the
      // filter simply selects nothing — the organisation's conversations all
      // live in `S1` — which is a different answer from a refusal, and the one
      // that says the filter still works.
      const unfiltered = await request(app.getHttpServer())
        .get('/api/v1/conversations/pool')
        .set('x-member-id', AGENT_1)
        .expect(200);
      const allIds = ((unfiltered.body as DataEnvelope).data as ReadonlyArray<PoolEntry>).map(
        (entry) => entry.conversation.id,
      );
      expect(allIds).toContain(POOLED);

      const foreign = await request(app.getHttpServer())
        .get(`/api/v1/conversations/pool?storeId=${S2}`)
        .set('x-member-id', AGENT_1)
        .expect(200);
      expect((foreign.body as DataEnvelope).data).toEqual([]);

      // Its own store's filter is the unfiltered pool, so the read was not
      // granted by naming a store the seat was already pinned to.
      const own = await request(app.getHttpServer())
        .get(`/api/v1/conversations/pool?storeId=${S1}`)
        .set('x-member-id', AGENT_1)
        .expect(200);
      expect(
        ((own.body as DataEnvelope).data as ReadonlyArray<PoolEntry>).map(
          (entry) => entry.conversation.id,
        ),
      ).toEqual(allIds);
    });

    it('refuses a store filter from another tenant before it is ever a scope question', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/conversations/pool?storeId=store-beta-official')
        .set('x-member-id', AGENT_1)
        .expect(400);
      expect((response.body as ErrorEnvelope).code).toBe('bad_request');
    });

    it('gives a tenant from another store a pool of its own', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/conversations/pool')
        .set('x-member-id', 'u-t2-agent-1')
        .set('x-tenant-id', T2)
        .expect(200);
      expect((response.body as DataEnvelope).data).toEqual([]);
    });

    it('refuses a cross-store history read on a conversation that exists', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/conversations/${POOLED}/assignments`)
        .set('x-member-id', 'u-t2-agent-1')
        .set('x-tenant-id', T1)
        .expect(403);
      expect((response.body as ErrorEnvelope).code).toBe('forbidden');
    });

    it('refuses to hand a conversation to a seat of another store', async () => {
      const conversation = store.getConversation(T1, CLAIMED);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${CLAIMED}/transfer`)
        .set('x-member-id', 'u-t1-admin')
        .send({ expectedVersion: conversation?.version, toMemberId: 'u-t2-agent-1' })
        .expect(400);
      expect((response.body as ErrorEnvelope).code).toBe('bad_request');
      expect(store.getConversation(T1, CLAIMED)?.assignedMemberId).toBe(AGENT_1);
    });

    it('refuses to hand a conversation to a seat that is not accepting', async () => {
      const conversation = store.getConversation(T1, CLAIMED);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/conversations/${CLAIMED}/transfer`)
        .set('x-member-id', 'u-t1-admin')
        .send({ expectedVersion: conversation?.version, toMemberId: AGENT_2 })
        .expect(409);
      expect((response.body as ErrorEnvelope).code).toBe('conflict');
      expect(store.getConversation(T1, CLAIMED)?.assignedMemberId).toBe(AGENT_1);
    });

    it('offers the transfer picker exactly the seats the transfer itself accepts', async () => {
      // Two accepting seats, so the answer is narrowed by the rule rather than by
      // availability alone: the caller's own seat is the one that must drop out.
      expect(await setPresence(AGENT_1, 'accepting')).toBe(200);
      expect(await setPresence(AGENT_2, 'accepting')).toBe(200);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/conversations/${CLAIMED}/transfer-targets`)
        .set('x-member-id', AGENT_1)
        .expect(200);
      const targets = (response.body as DataEnvelope).data as ReadonlyArray<TransferTargetRow>;
      expect(targets.map((target) => target.memberId)).toEqual([AGENT_2]);
      // Named, not an id: the picker renders this string, and a seat missing from
      // the directory would otherwise be offered as `u-t1-agent-2`.
      expect(targets[0]).toMatchObject({
        displayName: '客服小蓝',
        storeId: S1,
        availability: 'accepting',
        inProgressCount: 0,
      });
    });

    it('leaves a seat out of the picker once a transfer to it would be refused', async () => {
      expect(await setPresence(AGENT_1, 'accepting')).toBe(200);
      expect(await setPresence(AGENT_2, 'away')).toBe(200);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/conversations/${CLAIMED}/transfer-targets`)
        .set('x-member-id', AGENT_1)
        .expect(200);
      // The refusal is the point, not the emptiness: the same request that
      // returned one target returns none, without the picker holding a copy of
      // the eligibility rule.
      expect((response.body as DataEnvelope).data).toEqual([]);
    });

    it('answers 404 for a conversation that does not exist, rather than an empty picker', async () => {
      // An unknown conversation and a conversation nobody can take both leave the
      // picker empty; only the status separates "no such conversation" from
      // "nobody available", and the workspace shows a different message for each.
      const response = await request(app.getHttpServer())
        .get('/api/v1/conversations/conversation-does-not-exist/transfer-targets')
        .set('x-member-id', AGENT_1)
        .expect(404);
      expect((response.body as ErrorEnvelope).code).toBe('not_found');
    });
  });

  describe('the offline fallback', () => {
    it('tells the customer once and keeps the conversation waiting in the pool', async () => {
      const first = await scheduler.runOnce(NOW);
      expect(first.fellBack).toEqual([POOLED]);

      const pooled = store.getConversation(T1, POOLED);
      expect(pooled).toMatchObject({ status: 'open', assignedMemberId: null, offlineReplyAt: NOW });

      const pool = await request(app.getHttpServer())
        .get('/api/v1/conversations/pool')
        .set('x-member-id', 'u-t1-admin')
        .expect(200);
      const entries = (pool.body as DataEnvelope).data as ReadonlyArray<PoolEntry>;
      expect(entries.map((entry) => entry.conversation.id)).toContain(POOLED);

      const second = await scheduler.runOnce(later(5_000));
      expect(second.fellBack).toEqual([]);
      expect(second.waiting).toEqual([POOLED]);
      const automated = store
        .listMessages(T1, POOLED)
        .filter((message) => message.source === 'other');
      expect(automated).toHaveLength(1);
    });

    it('still assigns the conversation to a seat that appears afterwards', async () => {
      await scheduler.runOnce(NOW);
      await setPresence(AGENT_2, 'accepting');
      const afterwards = await scheduler.runOnce(later(60_000));
      // The apology did not close the conversation, so a seat arriving late still
      // picks up a real customer rather than a dead one.
      expect(afterwards.assigned).toEqual([POOLED]);
      expect(store.getConversation(T1, POOLED)?.assignedMemberId).toBe(AGENT_2);
    });
  });

  it('routes /conversations/pool as the pool rather than a conversation named pool', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/conversations/pool')
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    // A 404 here would mean the literal route was captured by `:conversationId`.
    expect(Array.isArray((response.body as DataEnvelope).data)).toBe(true);
  });

  /**
   * 会话分流 over the real HTTP surface.
   *
   * The platform administrator needs **both** headers and this is why: it belongs
   * to no tenant, so `x-tenant-id` names the tenant whose seats are being
   * configured, and `x-member-id` names it as the actor.
   *
   * The ratio arithmetic itself — cross-multiplied loads, exact ties, the
   * relative-weight reading of `60/40` — is covered exhaustively by the core
   * spec, where a candidate can be built with any load. What these tests pin down
   * is the plumbing: that a stored weight reaches the sweep at all, that the
   * refusals are refusals, and that a change is recorded.
   */
  describe('会话分流: a stored weight decides what a sweep reaches', () => {
    type RoutingSeatRow = {
      memberId: string;
      weight: number;
      configured: boolean;
      enabled: boolean;
      status: string;
      live: boolean;
      inProgressCount: number;
      updatedAt: string | null;
      updatedBy: string | null;
    };

    /**
     * Read the tenant's routing policy as the platform administrator.
     *
     * @returns The seats the API answered with.
     */
    async function readRouting(): Promise<ReadonlyArray<RoutingSeatRow>> {
      const response = await request(app.getHttpServer())
        .get('/api/v1/assignment/routing')
        .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
        .set('x-tenant-id', T1)
        .expect(200);
      return ((response.body as DataEnvelope).data as { seats: ReadonlyArray<RoutingSeatRow> }).seats;
    }

    /**
     * Submit weights as the platform administrator.
     *
     * @param weights - The seats to speak for, in the request body's own spelling.
     * @returns The response, so a test can assert a refusal as well as a write.
     */
    function putRouting(
      weights: ReadonlyArray<{ member_id: string; weight: number }>,
    ): request.Test {
      return request(app.getHttpServer())
        .put('/api/v1/assignment/routing')
        .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
        .set('x-tenant-id', T1)
        .send({ weights });
    }

    /**
     * One seat of the policy by member id.
     *
     * @param seats - The seats the API returned.
     * @param memberId - The seat to find.
     * @returns The row, or `undefined` when the seat is not in the policy.
     */
    function seatOf(
      seats: ReadonlyArray<RoutingSeatRow>,
      memberId: string,
    ): RoutingSeatRow | undefined {
      return seats.find((seat) => seat.memberId === memberId);
    }

    it('reads every agent seat at the default weight, authored by nobody', async () => {
      const seats = await readRouting();
      expect(seats.map((seat) => seat.memberId)).toEqual(
        expect.arrayContaining([AGENT_1, AGENT_2]),
      );
      // Nobody has chosen a weight, so every seat weighs the default and says so:
      // the console must not present a default as if an administrator picked it.
      for (const seat of seats) {
        expect(seat.weight).toBe(1);
        expect(seat.configured).toBe(false);
        expect(seat.updatedAt).toBeNull();
        expect(seat.updatedBy).toBeNull();
        // No presence row has been written, so no seat is live — and the window
        // that decides that is applied by the shared rule, not by the handler.
        expect(seat.live).toBe(false);
      }
    });

    it('stores the ratio as submitted instead of normalising it', async () => {
      await putRouting([
        { member_id: AGENT_1, weight: 60 },
        { member_id: AGENT_2, weight: 40 },
      ]).expect(200);

      const seats = await readRouting();
      // 相对权重: the ratio is the policy, so 60/40 is stored as 60 and 40 rather
      // than being rewritten to something that adds up.
      expect(seatOf(seats, AGENT_1)).toMatchObject({ weight: 60, configured: true });
      expect(seatOf(seats, AGENT_2)).toMatchObject({ weight: 40, configured: true });
      expect(seatOf(seats, AGENT_1)?.updatedBy).toBe(SEEDED_PLATFORM_ADMIN_MEMBER_ID);
      expect(seatOf(seats, AGENT_1)?.updatedAt).not.toBeNull();
    });

    it('leaves the seats a save does not name exactly as they were', async () => {
      await putRouting([{ member_id: AGENT_1, weight: 5 }]).expect(200);
      await putRouting([{ member_id: AGENT_1, weight: 7 }]).expect(200);

      const seats = await readRouting();
      expect(seatOf(seats, AGENT_1)?.weight).toBe(7);
      // Silence is not a reset: the seat nobody mentioned still reads as never
      // configured rather than as an explicit default.
      expect(seatOf(seats, AGENT_2)).toMatchObject({ weight: 1, configured: false });
    });

    it('takes a zero-weighted seat out of the sweep', async () => {
      await putRouting([
        { member_id: AGENT_1, weight: 0 },
        { member_id: AGENT_2, weight: 1 },
      ]).expect(200);
      expect(await setPresence(AGENT_1, 'accepting')).toBe(200);
      expect(await setPresence(AGENT_2, 'accepting')).toBe(200);

      const result = await scheduler.runOnce(NOW);
      // Both seats are equally idle, so an unweighted sweep would have broken the
      // tie on member id and chosen AGENT_1 — this answer is the weight's.
      expect(result.assigned).toEqual([POOLED]);
      expect(store.getConversation(T1, POOLED)?.assignedMemberId).toBe(AGENT_2);
    });

    it('falls back to the offline reply when every seat weighs zero', async () => {
      await putRouting([
        { member_id: AGENT_1, weight: 0 },
        { member_id: AGENT_2, weight: 0 },
      ]).expect(200);
      expect(await setPresence(AGENT_1, 'accepting')).toBe(200);
      expect(await setPresence(AGENT_2, 'accepting')).toBe(200);

      const result = await scheduler.runOnce(NOW);
      // Both seats are online and accepting, and the customer is still told
      // nobody can take the conversation: weight zero means zero.
      expect(result.assigned).toEqual([]);
      expect(result.fellBack).toEqual([POOLED]);
      expect(store.getConversation(T1, POOLED)?.assignedMemberId).toBeNull();
    });

    it('refuses a weight for a member who is not an agent of the tenant', async () => {
      const unknown = await putRouting([{ member_id: 'u-t1-admin', weight: 2 }]).expect(400);
      expect((unknown.body as ErrorEnvelope).code).toBe('bad_request');
      const elsewhere = await putRouting([{ member_id: 'u-t2-agent-1', weight: 2 }]).expect(400);
      expect((elsewhere.body as ErrorEnvelope).code).toBe('bad_request');
      const stranger = await putRouting([{ member_id: 'nobody', weight: 2 }]).expect(400);
      expect((stranger.body as ErrorEnvelope).code).toBe('bad_request');
    });

    it('refuses a weight that is not a whole number of shares', async () => {
      const fractional = await putRouting([{ member_id: AGENT_1, weight: 1.5 }]).expect(400);
      expect((fractional.body as ErrorEnvelope).code).toBe('bad_request');
      const negative = await putRouting([{ member_id: AGENT_1, weight: -1 }]).expect(400);
      expect((negative.body as ErrorEnvelope).code).toBe('bad_request');
      const tooLarge = await putRouting([{ member_id: AGENT_1, weight: 1001 }]).expect(400);
      expect((tooLarge.body as ErrorEnvelope).code).toBe('bad_request');
    });

    it('refuses an agent both the read and the write', async () => {
      const read = await request(app.getHttpServer())
        .get('/api/v1/assignment/routing')
        .set('x-member-id', AGENT_1)
        .set('x-tenant-id', T1)
        .expect(403);
      expect((read.body as ErrorEnvelope).code).toBe('forbidden');
      const write = await request(app.getHttpServer())
        .put('/api/v1/assignment/routing')
        .set('x-member-id', AGENT_1)
        .set('x-tenant-id', T1)
        .send({ weights: [{ member_id: AGENT_1, weight: 9 }] })
        .expect(403);
      expect((write.body as ErrorEnvelope).code).toBe('forbidden');
      // The refusal is a refusal: nothing was stored under the agent's name.
      const seats = await readRouting();
      expect(seatOf(seats, AGENT_1)).toMatchObject({ weight: 1, configured: false });
    });

    it('records the change in the audit trail', async () => {
      await putRouting([{ member_id: AGENT_2, weight: 3 }]).expect(200);

      const entry = store
        .listAudit(T1)
        .find((row) => row.action === 'assignment.routing.updated');
      expect(entry).toMatchObject({
        actorMemberId: SEEDED_PLATFORM_ADMIN_MEMBER_ID,
        targetType: 'conversation_routing_weights',
        targetId: T1,
      });
    });
  });
});
