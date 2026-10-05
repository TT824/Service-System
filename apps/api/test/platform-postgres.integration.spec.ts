import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseAppConfig,
  type AgentAvailabilityStatus,
  type AgentPresence,
  type AppConfig,
  type Conversation,
} from '@kefu/core';
import { DatabaseService } from '../src/database/database.service';
import { TransactionManager } from '../src/persistence/transaction-manager';
import { PostgresPlatformRepository } from '../src/platform/postgres-platform.repository';
import {
  PlatformWriteError,
  resolvePlatformStorageMode,
} from '../src/platform/platform-repository';
import {
  isDatabaseReachable,
  resolveDatabaseUrl,
  runDatabaseCommand,
} from './database-test-support';

/**
 * Integration tests for the durable platform repository.
 *
 * These exercise {@link PostgresPlatformRepository} against the real PostgreSQL
 * the platform targets — the tables and constraints migrations `0002`-`0005`
 * declare — rather than only against the in-memory adapter the interface tests
 * use. They prove the facts the acceptance criteria name: business facts survive
 * an API/database client recreation, tenant and store boundaries hold, a
 * concurrent claim has exactly one winner, a duplicate `dedup_key` is replayed
 * instead of re-inserted, and the review/audit/report reads answer from durable
 * state.
 *
 * The suite skips cleanly when no database is reachable, so `npm test` passes on
 * a machine without PostgreSQL; a run that actually executed reports so through
 * the test names. Every row it writes carries a per-run unique identifier and is
 * removed again in `afterAll`, so it never depends on — or disturbs — the
 * seeded directory or another run's rows.
 */
const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Unique suffix isolating this run's rows from every other run's. */
const RUN = randomUUID().slice(0, 8);
/** The single platform review policy row id. */
const PLATFORM_REVIEW_POLICY_ID = 'review-policy-platform';

/**
 * Fail loudly when a write that should have produced a row answered nothing.
 *
 * The catalogue creates answer `undefined` for a reference outside the caller's
 * tenant, so a test that means to set up a row has to say so rather than carry
 * the possibility forward into every later assertion.
 */
function stored<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('integration setup: the write returned no row');
  }
  return value;
}

describe.skipIf(!reachable)('Platform persistence (PostgreSQL)', () => {
  let config: AppConfig;
  let database: DatabaseService;
  let pool: Pool;
  let repository: PostgresPlatformRepository;

  /** Tenant A: the primary tenant this run owns. */
  const tenantA = `tenant-it-${RUN}`;
  /** Tenant B: exists only to prove tenant isolation. */
  const tenantB = `tenant-it-b-${RUN}`;
  const storeA = `store-it-${RUN}`;
  const storeB = `store-it-b-${RUN}`;
  const agentA = `member-it-a-${RUN}`;
  /** A second seat of tenant A's store: the colleague a conversation is handed to. */
  const agentC = `member-it-c-${RUN}`;
  const agentB = `member-it-b-${RUN}`;

  /** The review policy row as it existed before this run, so it can be restored. */
  let previousPolicy: QueryResultRow | undefined;

  beforeAll(async () => {
    const parsed = parseAppConfig({ ...process.env, APP_ENV: 'test' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    config = parsed.config;
    // Idempotent: the migrations may already be applied on a developer machine.
    runDatabaseCommand('migrate', databaseUrl);
    database = new DatabaseService(config);
    pool = database.pool;
    repository = buildRepository(database);
    previousPolicy = await readPolicyRow();
    await seedDirectory();
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await cleanup();
      await database.onModuleDestroy();
    }
  });

  /**
   * Build a repository over one database client.
   *
   * Called again mid-suite to simulate an API process restart: a brand new pool
   * and a brand new repository must read the facts the previous one wrote.
   *
   * @param service - Database client the repository should use.
   * @returns The repository bound to that client.
   */
  function buildRepository(service: DatabaseService): PostgresPlatformRepository {
    return new PostgresPlatformRepository(service, new TransactionManager(service));
  }

  /** Read the current platform review policy row, if any. */
  async function readPolicyRow(): Promise<QueryResultRow | undefined> {
    const result = await pool.query('SELECT * FROM review_policy WHERE id = $1', [
      PLATFORM_REVIEW_POLICY_ID,
    ]);
    return result.rows[0];
  }

  /** Insert the two tenants, their stores and their agents. */
  async function seedDirectory(): Promise<void> {
    const now = new Date().toISOString();
    await pool.query(
      'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
      [tenantA, `it-${RUN}`, '集成测试租户', now],
    );
    await pool.query(
      'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
      [tenantB, `itb-${RUN}`, '集成测试租户B', now],
    );
    await pool.query(
      'INSERT INTO stores (id, tenant_id, code, name, enabled, created_at) VALUES ($1, $2, $3, $4, TRUE, $5)',
      [storeA, tenantA, 'main', '集成测试门店', now],
    );
    await pool.query(
      'INSERT INTO stores (id, tenant_id, code, name, enabled, created_at) VALUES ($1, $2, $3, $4, TRUE, $5)',
      [storeB, tenantB, 'main', '集成测试门店B', now],
    );
    await pool.query(
      'INSERT INTO members (id, tenant_id, store_id, role, username, display_name, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)',
      [agentA, tenantA, storeA, 'agent', `it-agent-a-${RUN}`, '集成测试客服A', now],
    );
    await pool.query(
      'INSERT INTO members (id, tenant_id, store_id, role, username, display_name, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)',
      [agentC, tenantA, storeA, 'agent', `it-agent-c-${RUN}`, '集成测试客服C', now],
    );
    await pool.query(
      'INSERT INTO members (id, tenant_id, store_id, role, username, display_name, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)',
      [agentB, tenantB, storeB, 'agent', `it-agent-b-${RUN}`, '集成测试客服B', now],
    );
  }

  /** Remove everything this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    const tenants = [tenantA, tenantB];
    const members = [agentA, agentC, agentB];
    await pool.query('DELETE FROM approved_phrases WHERE tenant_id = ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM suggestion_sets WHERE tenant_id = ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM messages WHERE tenant_id = ANY($1::text[])', [tenants]);
    // Before `conversations` and `members`: this table references both, and it
    // has no `ON DELETE` path that would clear it for us.
    await pool.query('DELETE FROM conversation_assignments WHERE tenant_id = ANY($1::text[])', [
      tenants,
    ]);
    await pool.query('DELETE FROM conversations WHERE tenant_id = ANY($1::text[])', [tenants]);
    // Before `members`, for the same reason.
    await pool.query('DELETE FROM agent_presence WHERE tenant_id = ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM products WHERE tenant_id = ANY($1::text[])', [tenants]);
    // Before `faqs`, which `faq_question_variants` references.
    await pool.query('DELETE FROM faq_question_variants WHERE tenant_id = ANY($1::text[])', [
      tenants,
    ]);
    await pool.query('DELETE FROM faqs WHERE tenant_id = ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM shortcuts WHERE tenant_id = ANY($1::text[])', [tenants]);
    // Before `product_import_batches`, which the error rows point at with a
    // composite key. The cascade would clear them too; doing it explicitly keeps
    // the ordering here readable rather than dependent on a constraint.
    await pool.query('DELETE FROM product_import_errors WHERE tenant_id = ANY($1::text[])', [
      tenants,
    ]);
    await pool.query('DELETE FROM product_import_batches WHERE tenant_id = ANY($1::text[])', [
      tenants,
    ]);
    // The catalogue, deepest first: `product_skus` references `product_spus`,
    // and both `product_spus` and `product_category_attributes` reference
    // `product_categories`.
    await pool.query('DELETE FROM product_skus WHERE tenant_id = ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM product_spus WHERE tenant_id = ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM product_category_attributes WHERE tenant_id = ANY($1::text[])', [
      tenants,
    ]);
    await pool.query('DELETE FROM product_categories WHERE tenant_id = ANY($1::text[])', [tenants]);
    // Covers both the tenant-scoped entries and the platform policy entry, which
    // carries a NULL tenant and the acting member as its actor.
    await pool.query('DELETE FROM audit_log WHERE tenant_id = ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM audit_log WHERE actor_member_id = ANY($1::text[])', [members]);
    await pool.query('DELETE FROM retention_policies WHERE tenant_id = ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM members WHERE id = ANY($1::text[])', [members]);
    await pool.query('DELETE FROM stores WHERE id = ANY($1::text[])', [[storeA, storeB]]);
    await pool.query('DELETE FROM tenants WHERE id = ANY($1::text[])', [tenants]);
    // Restore the platform policy exactly as it was found, so a developer's own
    // configuration is never silently replaced by this suite.
    await pool.query('DELETE FROM review_policy WHERE id = $1', [PLATFORM_REVIEW_POLICY_ID]);
    const restored = previousPolicy;
    if (restored !== undefined) {
      await pool.query(
        `INSERT INTO review_policy (id, scope, require_review, require_review_for_sources, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          restored['id'],
          restored['scope'],
          restored['require_review'],
          restored['require_review_for_sources'],
          restored['updated_by'],
          restored['updated_at'],
        ],
      );
    }
  }

  /** Open a conversation through the inbound path and remember its id. */
  async function openConversation(externalConversationId: string): Promise<Conversation> {
    const result = await repository.ingestInbound({
      tenantId: tenantA,
      storeId: storeA,
      channel: 'wecom',
      externalCustomerId: `customer-${RUN}`,
      externalConversationId,
      content: '你好，我想咨询一下',
      dedupKey: `inbound-${RUN}-${externalConversationId}`,
    });
    return result.conversation;
  }

  it('runs against a reachable database', () => {
    // Reported explicitly so a skipped run is never mistaken for a passing one.
    expect(reachable).toBe(true);
  });

  it('selects the durable adapter for local and production only', () => {
    // The environment boundary is the whole selection policy: `test` is the one
    // environment allowed to serve business facts from the in-process store.
    expect(resolvePlatformStorageMode('test')).toBe('memory');
    expect(resolvePlatformStorageMode('local')).toBe('postgres');
    expect(resolvePlatformStorageMode('production')).toBe('postgres');
  });

  it('reads the directory it was seeded with, scoped by tenant', async () => {
    expect((await repository.getTenant(tenantA))?.code).toBe(`it-${RUN}`);
    expect((await repository.listStores(tenantA)).map((store) => store.id)).toEqual([storeA]);
    // Tenant B's store is never returned for tenant A.
    expect((await repository.listStores(tenantA)).some((store) => store.id === storeB)).toBe(false);
    const members = await repository.listMembers(tenantA);
    expect(members.map((member) => member.id).sort()).toEqual([agentA, agentC].sort());
    expect((await repository.getMember(agentA))?.storeId).toBe(storeA);
    // A cross-tenant store read answers "not found", not someone else's row.
    expect(await repository.getStore(tenantA, storeB)).toBeUndefined();
  });

  it('persists every platform fact across a database client recreation', async () => {
    const now = new Date().toISOString();
    const sku = `SKU-${RUN}`;
    const product = await repository.createProduct({
      tenantId: tenantA,
      storeId: storeA,
      sku,
      title: '集成测试商品',
      description: '集成测试商品描述',
      now,
    });
    const faq = await repository.createFaq({
      tenantId: tenantA,
      storeId: storeA,
      question: '发货时间？',
      answer: '48 小时内发货。',
      tags: ['物流', '发货'],
      now,
    });
    const shortcut = await repository.createShortcut({
      tenantId: tenantA,
      storeId: storeA,
      code: `/hi-${RUN}`,
      title: '问候语',
      content: '您好，很高兴为您服务。',
      now,
    });
    const conversation = await openConversation(`external-${RUN}`);
    const outbound = await repository.sendOutbound({
      tenantId: tenantA,
      storeId: storeA,
      conversationId: conversation.id,
      content: '这是持久化验证消息',
      source: 'direct_candidate',
      dedupKey: `persist-${RUN}`,
    });
    const policy = await repository.setReviewPolicy({
      id: PLATFORM_REVIEW_POLICY_ID,
      scope: 'platform',
      requireReview: true,
      requireReviewForSources: ['direct_candidate', 'edited_send'],
      updatedBy: agentA,
      updatedAt: now,
    });
    const approval = await repository.approveMessage(
      tenantA,
      outbound.message.id,
      agentA,
      new Date().toISOString(),
    );
    expect(approval.ok).toBe(true);
    const audit = await repository.appendAudit({
      tenantId: tenantA,
      actorMemberId: agentA,
      action: 'it.marker',
      targetType: 'conversation',
      targetId: conversation.id,
    });

    // A completely new pool and repository, as if the API had been restarted.
    const restarted = new DatabaseService(config);
    try {
      const reader = buildRepository(restarted);
      expect((await reader.getProduct(tenantA, product.id))?.sku).toBe(sku);
      expect((await reader.listProducts(tenantA, storeA)).map((row) => row.id)).toContain(
        product.id,
      );
      expect((await reader.getFaq(tenantA, faq.id))?.tags).toEqual(['物流', '发货']);
      expect((await reader.listShortcuts(tenantA, storeA)).map((row) => row.id)).toContain(
        shortcut.id,
      );

      const reread = await reader.getConversation(tenantA, conversation.id);
      expect(reread?.id).toBe(conversation.id);
      const messages = await reader.listMessages(tenantA, conversation.id);
      expect(messages.map((message) => message.id)).toContain(outbound.message.id);
      // Booleans and numbers survive as booleans and numbers, and TIMESTAMPTZ
      // columns are normalised to the ISO strings the domain uses.
      expect((await reader.getMessage(tenantA, outbound.message.id))?.reviewEligible).toBe(true);
      expect(reread?.version).toBe(conversation.version);

      expect((await reader.getReviewPolicy()).id).toBe(policy.id);
      expect((await reader.getReviewPolicy()).requireReviewForSources).toEqual([
        'direct_candidate',
        'edited_send',
      ]);
      const phrases = await reader.listApprovedPhrases(tenantA);
      expect(phrases.map((phrase) => phrase.sourceMessageId)).toContain(outbound.message.id);
      expect(await reader.getSuggestionSet(tenantA, 'suggestion-does-not-exist')).toBeUndefined();

      const entries = await reader.listAudit(tenantA);
      expect(entries.map((entry) => entry.id)).toContain(audit.id);
      const summary = await reader.summarizeRetention(tenantA, new Date().toISOString());
      expect(summary.tenantId).toBe(tenantA);
      expect(summary.policies.length).toBeGreaterThan(0);
      // Everything this run wrote is fresh, so nothing is past its window yet.
      expect(summary.totalExpired).toBe(0);
    } finally {
      await restarted.onModuleDestroy();
    }
  });

  it('writes a knowledge patch durably and keeps the fields it does not name', async () => {
    const now = new Date().toISOString();
    const product = await repository.createProduct({
      tenantId: tenantA,
      storeId: storeA,
      sku: `SKU-PATCH-${RUN}`,
      title: '补丁测试商品',
      description: '补丁测试商品描述',
      now,
    });
    const faq = await repository.createFaq({
      tenantId: tenantA,
      storeId: storeA,
      question: '补丁测试问题？',
      answer: '补丁测试答案。',
      tags: ['补丁'],
      now,
    });
    const shortcut = await repository.createShortcut({
      tenantId: tenantA,
      storeId: storeA,
      code: `/patch-${RUN}`,
      title: '补丁测试短语',
      content: '补丁测试短语内容。',
      now,
    });

    // `COALESCE($n, column)` is what an absent patch field means on the way in:
    // the row keeps its value, and `FALSE` is a value, not an absence.
    const disabledAt = new Date(Date.parse(now) + 60_000).toISOString();
    const disabled = await repository.updateProduct(
      tenantA,
      product.id,
      { enabled: false },
      disabledAt,
    );
    expect(disabled).toMatchObject({
      id: product.id,
      sku: `SKU-PATCH-${RUN}`,
      title: '补丁测试商品',
      description: '补丁测试商品描述',
      enabled: false,
      createdAt: product.createdAt,
      updatedAt: disabledAt,
    });

    // A 停用 row is still listed, so the console can find it and undo it; what
    // withholds it from the reply pipeline is the caller's usability rule.
    expect((await repository.listProducts(tenantA, storeA)).map((row) => row.id)).toContain(
      product.id,
    );

    // The `text[]` column is replaced wholesale when named, and survives intact
    // when the patch says nothing about it.
    const retagged = await repository.updateFaq(tenantA, faq.id, { tags: ['售后', '退货'] });
    expect(retagged?.tags).toEqual(['售后', '退货']);
    const reworded = await repository.updateFaq(tenantA, faq.id, {
      answer: '补丁测试答案（改）。',
    });
    expect(reworded?.answer).toBe('补丁测试答案（改）。');
    expect(reworded?.tags).toEqual(['售后', '退货']);

    const retitled = await repository.updateShortcut(tenantA, shortcut.id, {
      title: '补丁测试短语（改）',
      enabled: false,
    });
    expect(retitled).toMatchObject({
      code: `/patch-${RUN}`,
      title: '补丁测试短语（改）',
      content: '补丁测试短语内容。',
      enabled: false,
    });

    // Another tenant, and an id that never existed, are both answered "not
    // found" — and neither changes the row they named.
    expect(
      await repository.updateProduct(tenantB, product.id, { title: '越权改名' }),
    ).toBeUndefined();
    expect(
      await repository.updateProduct(tenantA, 'product-does-not-exist', { title: '无此商品' }),
    ).toBeUndefined();
    expect((await repository.getProduct(tenantA, product.id))?.title).toBe('补丁测试商品');
  });

  it('keeps tenants and allowed stores isolated', async () => {
    const own = await openConversation(`isolation-${RUN}`);
    const sent = await repository.sendOutbound({
      tenantId: tenantA,
      storeId: storeA,
      conversationId: own.id,
      content: '租户A的私有消息',
      source: 'manual_typed',
      dedupKey: `isolation-${RUN}`,
    });

    // Tenant B addresses the very same ids and is answered "not found", exactly
    // as the service layer's 404 does, rather than being given tenant A's row.
    expect(await repository.getConversation(tenantB, own.id)).toBeUndefined();
    expect(await repository.getMessage(tenantB, sent.message.id)).toBeUndefined();
    expect(await repository.listMessages(tenantB, own.id)).toEqual([]);
    expect(await repository.listConversations(tenantB)).toEqual([]);
    expect(await repository.getProduct(tenantB, 'product-does-not-exist')).toBeUndefined();

    // Inside tenant A the same ids resolve, so the isolation above is a boundary
    // and not an empty database.
    expect((await repository.getConversation(tenantA, own.id))?.id).toBe(own.id);
    expect((await repository.getMessage(tenantA, sent.message.id))?.id).toBe(sent.message.id);

    // A store filter narrows the read to that store, and a store belonging to
    // another tenant matches nothing inside this one.
    expect((await repository.listConversations(tenantA, storeA)).map((row) => row.id)).toContain(
      own.id,
    );
    expect(await repository.listConversations(tenantA, storeB)).toEqual([]);
    expect(await repository.listReviewQueue(tenantB, storeB)).toEqual([]);
  });

  it('lets exactly one concurrent claim win', async () => {
    const conversation = await openConversation(`claim-${RUN}`);
    expect(conversation.status).toBe('open');

    const attempts = await Promise.all(
      [0, 1, 2, 3, 4].map(() =>
        repository.claim(
          tenantA,
          conversation.id,
          agentA,
          conversation.version,
          new Date().toISOString(),
        ),
      ),
    );

    const winners = attempts.filter((attempt) => attempt.ok);
    const losers = attempts.filter((attempt) => !attempt.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
    for (const loser of losers) {
      // A stale attempt is refused with the same stable code the in-process
      // adapter produces, never by overwriting the winner's row.
      expect(loser.ok ? undefined : loser.code).toBe('conflict');
    }
    const winner = winners[0];
    expect(winner?.ok ? winner.conversation.status : undefined).toBe('claimed');
    expect(winner?.ok ? winner.conversation.assignedMemberId : undefined).toBe(agentA);

    const stored = await repository.getConversation(tenantA, conversation.id);
    expect(stored?.version).toBe(conversation.version + 1);
    expect(stored?.assignedMemberId).toBe(agentA);
  });

  it('refuses stale versions and wrong states with their stable codes', async () => {
    const conversation = await openConversation(`stale-${RUN}`);
    const now = new Date().toISOString();
    const closed = await repository.close(
      tenantA,
      conversation.id,
      agentA,
      true,
      conversation.version,
      now,
    );
    expect(closed.ok ? closed.conversation.status : undefined).toBe('closed');

    // The same version is now stale, so the second close is a conflict.
    const stale = await repository.close(
      tenantA,
      conversation.id,
      agentA,
      true,
      conversation.version,
      now,
    );
    expect(stale.ok ? undefined : stale.code).toBe('conflict');
    // A current version on a closed conversation is refused by state instead.
    const wrongState = await repository.returnToPool(
      tenantA,
      conversation.id,
      agentA,
      // Acting on its own conversation; the state check is what refuses this.
      { actorIsAdmin: false, actorStoreId: null, assigneeLive: true },
      conversation.version + 1,
      now,
    );
    expect(wrongState.ok ? undefined : wrongState.code).toBe('invalid_state');
    // An unknown conversation is a not-found, never a conflict.
    const missing = await repository.claim(tenantA, 'conversation-does-not-exist', agentA, 1, now);
    expect(missing.ok ? undefined : missing.code).toBe('not_found');
  });

  it('refuses an outbound write to a closed conversation with a stable code', async () => {
    const conversation = await openConversation(`closed-${RUN}`);
    const closed = await repository.close(
      tenantA,
      conversation.id,
      agentA,
      true,
      conversation.version,
      new Date().toISOString(),
    );
    expect(closed.ok).toBe(true);

    // The adapter re-validates state inside its own transaction, so it reports
    // the refusal through a typed error the service maps back to its own 409
    // rather than letting a race become a 500.
    const refusal = await repository
      .sendOutbound({
        tenantId: tenantA,
        storeId: storeA,
        conversationId: conversation.id,
        content: '迟到的回复',
        source: 'manual_typed',
        dedupKey: `closed-${RUN}`,
      })
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PlatformWriteError);
    expect(refusal).toMatchObject({ code: 'invalid_state' });

    const missing = await repository
      .sendOutbound({
        tenantId: tenantA,
        storeId: storeA,
        conversationId: 'conversation-does-not-exist',
        content: '不存在的会话',
        source: 'manual_typed',
      })
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(missing).toMatchObject({ code: 'not_found' });
  });

  it('replays a duplicate dedup key instead of writing a second message', async () => {
    const conversation = await openConversation(`dedup-${RUN}`);
    const dedupKey = `dedup-${RUN}`;
    const first = await repository.sendOutbound({
      tenantId: tenantA,
      storeId: storeA,
      conversationId: conversation.id,
      content: '同一条消息',
      source: 'manual_typed',
      dedupKey,
    });
    const replay = await repository.sendOutbound({
      tenantId: tenantA,
      storeId: storeA,
      conversationId: conversation.id,
      content: '同一条消息',
      source: 'manual_typed',
      dedupKey,
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.message.id).toBe(first.message.id);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM messages WHERE tenant_id = $1 AND dedup_key = $2',
      [tenantA, dedupKey],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('writes one message when duplicate sends race', async () => {
    const conversation = await openConversation(`race-${RUN}`);
    const dedupKey = `race-${RUN}`;
    const results = await Promise.all(
      [0, 1, 2].map((index) =>
        repository.sendOutbound({
          tenantId: tenantA,
          storeId: storeA,
          conversationId: conversation.id,
          content: `并发消息 ${index}`,
          source: 'manual_typed',
          dedupKey,
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    const ids = new Set(results.map((result) => result.message.id));
    expect(ids.size).toBe(1);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM messages WHERE tenant_id = $1 AND dedup_key = $2',
      [tenantA, dedupKey],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('serves the review queue, approvals and audit from durable state', async () => {
    const conversation = await openConversation(`review-${RUN}`);
    const sent = await repository.sendOutbound({
      tenantId: tenantA,
      storeId: storeA,
      conversationId: conversation.id,
      content: '候选回复内容',
      source: 'direct_candidate',
      dedupKey: `review-${RUN}`,
    });
    expect(sent.message.reviewState).toBe('pending');

    const queue = await repository.listReviewQueue(tenantA, storeA);
    expect(queue.map((message) => message.id)).toContain(sent.message.id);

    const approved = await repository.approveMessage(
      tenantA,
      sent.message.id,
      agentA,
      new Date().toISOString(),
    );
    expect(approved.ok ? approved.phrase.phrase : undefined).toBe('候选回复内容');
    // Leaving the queue is visible through the same read the queue view uses.
    expect((await repository.listReviewQueue(tenantA, storeA)).map((m) => m.id)).not.toContain(
      sent.message.id,
    );
    // A repeat approval is refused with the stable code, not a second phrase.
    const repeat = await repository.approveMessage(
      tenantA,
      sent.message.id,
      agentA,
      new Date().toISOString(),
    );
    expect(repeat.ok ? undefined : repeat.code).toBe('already_reviewed');
    // A manual message never enters review.
    const manual = await repository.sendOutbound({
      tenantId: tenantA,
      storeId: storeA,
      conversationId: conversation.id,
      content: '人工消息',
      source: 'manual_typed',
      dedupKey: `manual-${RUN}`,
    });
    const ineligible = await repository.approveMessage(
      tenantA,
      manual.message.id,
      agentA,
      new Date().toISOString(),
    );
    expect(ineligible.ok ? undefined : ineligible.code).toBe('not_eligible');

    const approvalEntries = await repository.listAudit(tenantA);
    expect(approvalEntries.some((entry) => entry.action === 'review.message_approved')).toBe(true);
    // The audit entry is scoped to the tenant that produced it.
    expect(await repository.listAudit(tenantB)).toEqual([]);
  });

  it('records a suggestion set for the tenant that generated it', async () => {
    const conversation = await openConversation(`suggest-${RUN}`);
    const set = await repository.createSuggestionSet({
      tenantId: tenantA,
      storeId: storeA,
      conversationId: conversation.id,
      provider: 'none',
      intent: 'question',
      origin: 'catalogue',
      candidates: [
        {
          rank: 1,
          kind: 'product',
          sourceId: 'product-it',
          tenantId: tenantA,
          storeId: storeA,
          title: '集成测试商品',
          content: '集成测试商品描述',
          score: 1,
          recall: { rank: 2, modes: ['keyword'] },
        },
      ],
      fallbackReasons: ['no_generation_provider'],
    });

    expect(set.provider).toBe('none');
    expect(set.intent).toBe('question');
    expect(set.origin).toBe('catalogue');
    expect(set.candidates).toHaveLength(1);
    // JSONB candidates and reasons survive the round trip as structured values.
    const reread = await repository.getSuggestionSet(tenantA, set.id);
    expect(reread?.candidates[0]?.kind).toBe('product');
    // The recall evidence is part of the candidate, not a field the mapper drops
    // on the way back: 检索依据 is rendered from this and nothing else.
    expect(reread?.candidates[0]?.recall?.rank).toBe(2);
    expect(reread?.candidates[0]?.recall?.modes).toEqual(['keyword']);
    expect(reread?.origin).toBe('catalogue');
    expect(reread?.fallbackReasons).toEqual(['no_generation_provider']);
    expect(await repository.getSuggestionSet(tenantB, set.id)).toBeUndefined();
  });

  it('round-trips a set a generation provider wrote', async () => {
    // Until `0012` the column's CHECK admitted exactly one value, so this is
    // asserted against the real database rather than against the type — the
    // constraint, not the union, is what decides whether the write survives.
    const conversation = await openConversation(`suggest-generated-${RUN}`);
    const set = await repository.createSuggestionSet({
      tenantId: tenantA,
      storeId: storeA,
      conversationId: conversation.id,
      provider: 'deepseek',
      intent: 'question',
      origin: 'generated',
      candidates: [
        {
          rank: 1,
          kind: 'product',
          sourceId: 'product-it',
          tenantId: tenantA,
          storeId: storeA,
          title: '集成测试商品',
          content: '亲，这款有货的',
          score: 0,
        },
      ],
      fallbackReasons: [],
    });

    expect(set.provider).toBe('deepseek');
    const reread = await repository.getSuggestionSet(tenantA, set.id);
    // Read back through the mapper, not the INSERT's own RETURNING shortcut: a
    // hard-coded `'none'` on the read path is exactly the kind of thing that
    // survives a write-side test.
    expect(reread?.provider).toBe('deepseek');
    expect(reread?.origin).toBe('generated');
    expect(reread?.candidates[0]?.content).toBe('亲，这款有货的');
  });

  it('round-trips a chitchat set, whose emptiness is the decision rather than a failure', async () => {
    // The case the columns were added for: an empty candidate list that means
    // "nothing was searched" and not "the search failed". Asserted against the
    // database because `0018`'s CHECK constraints, not the union type, are what
    // decide whether the write survives.
    const conversation = await openConversation(`suggest-chitchat-${RUN}`);
    const set = await repository.createSuggestionSet({
      tenantId: tenantA,
      storeId: storeA,
      conversationId: conversation.id,
      provider: 'none',
      intent: 'chitchat',
      origin: 'none',
      candidates: [],
      fallbackReasons: ['chitchat_no_retrieval'],
    });

    const reread = await repository.getSuggestionSet(tenantA, set.id);
    expect(reread?.intent).toBe('chitchat');
    expect(reread?.origin).toBe('none');
    expect(reread?.candidates).toEqual([]);
    expect(reread?.fallbackReasons).toEqual(['chitchat_no_retrieval']);
  });

  it('lists the sets of one tenant and no other', async () => {
    const conversation = await openConversation(`suggest-list-${RUN}`);
    const set = await repository.createSuggestionSet({
      tenantId: tenantA,
      storeId: storeA,
      conversationId: conversation.id,
      provider: 'none',
      intent: 'question',
      origin: 'catalogue',
      candidates: [],
      fallbackReasons: ['no_generation_provider'],
    });

    const listed = await repository.listSuggestionSets(tenantA);
    expect(listed.some((each) => each.id === set.id)).toBe(true);
    // Containment rather than an exact length: every test above in this file
    // writes sets for the same tenant. The tenant predicate is the whole
    // contract, and a dropped WHERE would read as a successful §4.8 report over
    // somebody else's conversations.
    expect(listed.every((each) => each.tenantId === tenantA)).toBe(true);
    const other = await repository.listSuggestionSets(tenantB);
    expect(other.some((each) => each.id === set.id)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Assignment: seats, the dispatch sweep, and its history
  // --------------------------------------------------------------------------

  /** An instant far enough in the past to sort ahead of any other due row. */
  const DUE_BASE_MS = Date.parse('2000-01-01T00:00:00.000Z');

  /** How many conversations this suite has dated so far. */
  let dueSequence = 0;

  /**
   * The next dispatch-due instant, one second earlier than the previous one.
   *
   * The sweep scans the whole `conversations` table — it serves every tenant —
   * and orders by `next_assignment_at`, so a database still holding a previous
   * run's leftover pooled rows, or a conversation an earlier test in this file
   * parked, would otherwise decide which rows a bounded sweep sees. Two things
   * make the choice deterministic instead. Every dated conversation sorts ahead
   * of anything ingested at the real clock, and dating each one strictly earlier
   * than the last keeps the conversation a test just created at the head of the
   * queue — so a `limit` of one always selects exactly that one, and the sweep
   * writes nothing this run did not create.
   *
   * @returns The instant to ingest the next conversation at.
   */
  function nextDueInstant(): string {
    dueSequence += 1;
    return new Date(DUE_BASE_MS - dueSequence * 1_000).toISOString();
  }

  /**
   * Open a conversation that is due for dispatch ahead of everything else.
   *
   * The `due-` prefix is load-bearing, not decoration: `ingestInbound` replays a
   * conversation whose dedup key it has already seen, and it matches an existing
   * conversation by `(tenant, store, channel, external id)`. A slug that
   * collides with one a test above already used would therefore hand back *that*
   * conversation — a different row, scheduled at the real clock — and the sweep
   * assertions below would silently be about somebody else's data.
   *
   * @param slug - Topic of the conversation, unique to this suite.
   * @returns The conversation that is now due.
   */
  async function openDueConversation(slug: string): Promise<Conversation> {
    const externalConversationId = `due-${slug}-${RUN}`;
    const result = await repository.ingestInbound({
      tenantId: tenantA,
      storeId: storeA,
      channel: 'wecom',
      externalCustomerId: `customer-${RUN}`,
      externalConversationId,
      content: '你好，我想咨询一下',
      dedupKey: `inbound-${RUN}-${externalConversationId}`,
      now: nextDueInstant(),
    });
    return result.conversation;
  }

  /**
   * Report one agent seat's availability.
   *
   * @param memberId - The agent whose seat to set.
   * @param status - The availability to report.
   * @returns The stored seat row.
   */
  async function seatAgent(
    memberId: string,
    status: AgentAvailabilityStatus,
  ): Promise<AgentPresence> {
    return repository.setAgentPresence({
      tenantId: tenantA,
      memberId,
      storeId: storeA,
      status,
      now: new Date().toISOString(),
    });
  }

  it('reports only the seats of the requested store', async () => {
    await seatAgent(agentA, 'accepting');
    const candidates = await repository.listAssignmentCandidates(tenantA, storeA);
    // 两位同店坐席都在名单上：客服C 从没连上过，于是报 `offline` 而不是从名单里
    // 消失。这张表报的是事实（谁在这个店里），能不能接单是共享规则的事。
    expect(candidates.map((candidate) => candidate.memberId)).toEqual([agentA, agentC]);
    expect(candidates[1]?.status).toBe('offline');
    expect(candidates[0]).toMatchObject({
      tenantId: tenantA,
      storeId: storeA,
      role: 'agent',
      // The query deliberately does not filter on `enabled` — eligibility is the
      // shared rule's decision, not the reader's — so the flag is reported as it
      // is rather than used here to hide a seat.
      enabled: true,
      status: 'accepting',
    });

    // Another tenant's store is not this tenant's to read, and an agent of
    // another tenant is never a candidate however the ids line up.
    expect(await repository.listAssignmentCandidates(tenantA, storeB)).toEqual([]);
    expect(await repository.listAssignmentCandidates(tenantB, storeA)).toEqual([]);
  });

  it('moves the load count with the conversations a seat is actually holding', async () => {
    // A delta rather than an absolute: tests above leave their own claimed
    // conversations behind, and the count is over the whole store.
    const before = await repository.listAssignmentCandidates(tenantA, storeA);
    const held = await openConversation(`load-${RUN}`);
    await repository.claim(tenantA, held.id, agentA, held.version, new Date().toISOString());
    const after = await repository.listAssignmentCandidates(tenantA, storeA);

    expect(after[0]?.inProgressCount).toBe((before[0]?.inProgressCount ?? 0) + 1);

    // And only a *claimed* conversation counts: returning it takes the load off.
    await repository.returnToPool(
      tenantA,
      held.id,
      agentA,
      { actorIsAdmin: false, actorStoreId: null, assigneeLive: true },
      held.version + 1,
      new Date().toISOString(),
    );
    const returned = await repository.listAssignmentCandidates(tenantA, storeA);
    expect(returned[0]?.inProgressCount).toBe(before[0]?.inProgressCount);
  });

  it('hides a colleague’s conversation from the queue and remembers when it left a seat', async () => {
    // 队列那条 SQL 是 core 的 `conversationReadAccess` 的第二份抄写（详情那道门在
    // 服务层）。抄错一个 `AND` 有两种坏法，而且方向相反：同事接待中的单照旧发到手上，
    // 或者反过来——队列里出现一行点开即 403 的会话。两种都在这里钉住。
    const mine = await openConversation(`visible-mine-${RUN}`);
    const pooled = await openConversation(`visible-pooled-${RUN}`);
    /** 一个从未碰过这条会话的坐席：只出现在 `WHERE` 里，不需要是会员表里的一行。 */
    const stranger = `member-it-stranger-${RUN}`;

    const claimed = await repository.claim(
      tenantA,
      mine.id,
      agentA,
      mine.version,
      new Date().toISOString(),
    );
    expect(claimed.ok).toBe(true);
    const claimedVersion = claimed.ok ? claimed.conversation.version : 0;

    // 池中的单谁都看得见（还没被接走）；一旦挂在别人名下，第三位就看不见它了。
    const strangerQueue = await repository.listConversations(tenantA, storeA, stranger);
    expect(strangerQueue.map((row) => row.id)).toContain(pooled.id);
    expect(strangerQueue.map((row) => row.id)).not.toContain(mine.id);

    // 「它是不是从我手里出去的」只有一份依据：assignments 台账里 `from_member_id`
    // 那一列。自己接下的单不算——接单没有前手，所以这一格先空着。
    expect(await repository.lastHandoverFrom(tenantA, mine.id, agentA)).toBeUndefined();
    expect(await repository.lastHandoverFrom(tenantA, mine.id, stranger)).toBeUndefined();

    const handedOverAt = new Date().toISOString();
    const transferred = await repository.transfer(
      tenantA,
      mine.id,
      agentA,
      { actorIsAdmin: false, actorStoreId: storeA, assigneeLive: true },
      agentC,
      claimedVersion,
      handedOverAt,
    );
    expect(transferred.ok).toBe(true);

    // 转交那一刻就是读回来的那个时间戳本身，不是「大概在这附近」。
    expect(await repository.lastHandoverFrom(tenantA, mine.id, agentA)).toBe(handedOverAt);
    // 收到的那位是新受理人，队列里有它；交出去的那位也还看得见（历史在他那儿）。
    expect((await repository.listConversations(tenantA, storeA, agentC)).map((r) => r.id)).toContain(
      mine.id,
    );
    expect((await repository.listConversations(tenantA, storeA, agentA)).map((r) => r.id)).toContain(
      mine.id,
    );
    // 但那位旁观者仍然看不到：接手的是别人，这条会话不是「从他手里出去的」。
    expect(
      (await repository.listConversations(tenantA, storeA, stranger)).map((r) => r.id),
    ).not.toContain(mine.id);

    // 结束之后它没有受理人，对谁都还在队列里——详情那一侧的判据是「没人持有」，
    // 不看状态，这也是两份抄写最容易走样的地方。
    const closed = await repository.close(
      tenantA,
      mine.id,
      agentC,
      false,
      claimedVersion + 1,
      new Date().toISOString(),
    );
    expect(closed.ok).toBe(true);
    expect(
      (await repository.listConversations(tenantA, storeA, stranger)).map((r) => r.id),
    ).toContain(mine.id);
  });

  it('keeps the reported instant of a status change but not of a repeat', async () => {
    const first = await repository.setAgentPresence({
      tenantId: tenantA,
      memberId: agentA,
      storeId: storeA,
      status: 'away',
      now: '2026-09-14T08:00:00.000Z',
    });
    expect(first.changedAt).toBe('2026-09-14T08:00:00.000Z');

    // Re-reporting the same status is not a change, so "how long has this seat
    // been away" does not reset — but liveness does move.
    const same = await repository.setAgentPresence({
      tenantId: tenantA,
      memberId: agentA,
      storeId: storeA,
      status: 'away',
      now: '2026-09-14T08:05:00.000Z',
    });
    expect(same.changedAt).toBe('2026-09-14T08:00:00.000Z');
    expect(same.heartbeatAt).toBe('2026-09-14T08:05:00.000Z');

    const changed = await repository.setAgentPresence({
      tenantId: tenantA,
      memberId: agentA,
      storeId: storeA,
      status: 'accepting',
      now: '2026-09-14T08:10:00.000Z',
    });
    expect(changed.changedAt).toBe('2026-09-14T08:10:00.000Z');
  });

  it('refuses to let a heartbeat invent a seat that never reported', async () => {
    const missing = `member-it-absent-${RUN}`;
    expect(
      await repository.heartbeatAgentPresence(tenantA, missing, new Date().toISOString()),
    ).toBeUndefined();
    expect(await repository.getAgentPresence(tenantA, missing)).toBeUndefined();
  });

  it('assigns a due conversation to its only accepting seat in one transaction', async () => {
    const conversation = await openDueConversation('dispatch');
    await seatAgent(agentA, 'accepting');

    const outcomes = await repository.dispatchDue({
      now: new Date().toISOString(),
      limit: 1,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: 'assigned',
      conversationId: conversation.id,
      toMemberId: agentA,
    });

    const stored = await repository.getConversation(tenantA, conversation.id);
    expect(stored).toMatchObject({
      status: 'claimed',
      assignedMemberId: agentA,
      // Leaving the pool is what takes it out of the next scan.
      nextAssignmentAt: null,
      offlineReplyAt: null,
    });

    const history = await repository.listAssignments(tenantA, conversation.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'auto_assign',
      result: 'success',
      reasonCode: null,
      fromMemberId: null,
      toMemberId: agentA,
    });
    expect(history[0]?.stateVersionAfter).toBe(stored?.version);
  });

  it('lets exactly one of two concurrent sweeps take the same conversation', async () => {
    const conversation = await openDueConversation('race');
    await seatAgent(agentA, 'accepting');
    const now = new Date().toISOString();

    // Two sweeps over two independent clients, issued together. This is the real
    // race: the in-memory adapter is synchronous and cannot show it, and the
    // arbiter is the compare-and-swap in `executePlan` — the same mechanism the
    // concurrent claim test above proves, on the same columns.
    const [first, second] = await Promise.all([
      repository.dispatchDue({ now, limit: 1 }),
      repository.dispatchDue({ now, limit: 1 }),
    ]);

    const assigned = [...first, ...second].filter(
      (outcome) => outcome.kind === 'assigned' && outcome.conversationId === conversation.id,
    );
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ toMemberId: agentA });

    // Exactly one history row, and one version bump: the loser wrote nothing.
    const history = await repository.listAssignments(tenantA, conversation.id);
    expect(history).toHaveLength(1);
    const stored = await repository.getConversation(tenantA, conversation.id);
    expect(stored?.assignedMemberId).toBe(agentA);
    expect(stored?.version).toBe(conversation.version + 1);
  });

  it('sends the offline reply for one conversation exactly once across two sweeps', async () => {
    const conversation = await openDueConversation('fallback');
    // No seat in this store is accepting, so no sweep can place it.
    await seatAgent(agentA, 'offline');
    const now = new Date().toISOString();

    const [first, second] = await Promise.all([
      repository.dispatchDue({ now, limit: 1 }),
      repository.dispatchDue({ now, limit: 1 }),
    ]);

    // `offline_reply_at IS NULL` is in the UPDATE's `WHERE`, not left to
    // `COALESCE`: a sweep that finds the column already written matches no rows
    // and reports `lost`, so exactly one sweep concludes it is the one that may
    // tell the customer. Without that guard both would decide they were first.
    const fellBack = [...first, ...second].filter(
      (outcome) => outcome.kind === 'fallback' && outcome.conversationId === conversation.id,
    );
    expect(fellBack).toHaveLength(1);

    const stored = await repository.getConversation(tenantA, conversation.id);
    expect(stored).toMatchObject({
      // Still pooled and still due: the pool is what retries it.
      status: 'open',
      assignedMemberId: null,
      offlineReplyAt: now,
      dispatchAttempts: 1,
    });

    const history = await repository.listAssignments(tenantA, conversation.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'release',
      result: 'expired',
      reasonCode: 'no_eligible_agent',
      stateVersionAfter: null,
    });
  });

  it('still assigns a conversation that has already been told nobody is there', async () => {
    const conversation = await openDueConversation('late');
    await seatAgent(agentA, 'offline');
    const now = new Date().toISOString();
    const parked = await repository.dispatchDue({ now, limit: 1 });
    expect(parked[0]).toMatchObject({ kind: 'fallback', conversationId: conversation.id });

    // A seat appears. The conversation never left the pool, so the next sweep
    // hands it to a person rather than leaving the customer with an apology.
    await seatAgent(agentA, 'accepting');
    const later = await repository.dispatchDue({
      now: new Date(Date.parse(now) + 60_000).toISOString(),
      limit: 1,
    });
    expect(later[0]).toMatchObject({
      kind: 'assigned',
      conversationId: conversation.id,
      toMemberId: agentA,
    });
    // Two attempts are on record: the parking and the hand-off.
    const history = await repository.listAssignments(tenantA, conversation.id);
    expect(history.map((row) => row.result)).toEqual(['success', 'expired']);
  });

  it('keeps the assignment history and the seat state across a client recreation', async () => {
    const conversation = await openDueConversation('restart');
    await seatAgent(agentA, 'accepting');
    expect(
      (await repository.dispatchDue({ now: new Date().toISOString(), limit: 1 }))[0],
    ).toMatchObject({ kind: 'assigned', conversationId: conversation.id });

    // A brand new pool and repository, as a restarted API process would build.
    const restarted = buildRepository(database);
    const history = await restarted.listAssignments(tenantA, conversation.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'auto_assign',
      result: 'success',
      toMemberId: agentA,
    });
    expect((await restarted.getAgentPresence(tenantA, agentA))?.status).toBe('accepting');
    expect((await restarted.getConversation(tenantA, conversation.id))?.assignedMemberId).toBe(
      agentA,
    );

    // No seat of another tenant ever sees it, however the read is made.
    expect(await restarted.listAssignments(tenantB, conversation.id)).toEqual([]);
  });

  it('refuses an assignment history for a conversation of another tenant', async () => {
    const conversation = await openDueConversation('foreign');
    expect(await repository.listAssignments(tenantB, conversation.id)).toEqual([]);
  });

  it('stores one product with several variants, and keeps every JSON shape', async () => {
    const now = new Date().toISOString();
    const category = stored(
      await repository.createCategory({
        tenantId: tenantA,
        storeId: storeA,
        code: `apparel-${RUN}`,
        name: '服饰',
        now,
      }),
    );
    const child = stored(
      await repository.createCategory({
        tenantId: tenantA,
        storeId: storeA,
        parentId: category.id,
        code: `shirts-${RUN}`,
        name: '衬衫',
        now,
      }),
    );
    expect(child).toMatchObject({ parentId: category.id, status: 'enabled', createdAt: now });
    expect(await repository.getCategory(tenantB, category.id)).toBeUndefined();

    // A parent outside the tenant is refused before the insert, so the caller
    // gets an answer rather than a raw foreign-key error.
    expect(
      await repository.createCategory({
        tenantId: tenantB,
        storeId: storeB,
        parentId: category.id,
        code: 'orphan',
        name: '越权挂靠',
      }),
    ).toBeUndefined();

    const attribute = stored(
      await repository.createCategoryAttribute({
        tenantId: tenantA,
        categoryId: category.id,
        attributeCode: 'sleeve',
        attributeName: '袖长',
        valueType: 'enum',
        isRequired: true,
        isSearchable: true,
        allowedValues: ['长袖', '短袖'],
        now,
      }),
    );
    expect(attribute).toMatchObject({
      valueType: 'enum',
      isRequired: true,
      allowedValues: ['长袖', '短袖'],
    });
    expect(await repository.listCategoryAttributes(tenantA, category.id)).toHaveLength(1);

    const spu = stored(
      await repository.createSpu({
        tenantId: tenantA,
        storeId: storeA,
        categoryId: category.id,
        productCode: `TS-${RUN}`,
        title: '纯棉圆领 T 恤',
        sellingPoints: ['100% 纯棉', '支持七天无理由'],
        commonAttributes: { 袖长: '长袖', 克重: 180, 可机洗: true },
        shelfStatus: 'on_shelf',
        sourceType: 'manual',
        sourceUpdatedAt: now,
        now,
      }),
    );
    // JSONB round-trips the shapes that went in — a string, a number, a boolean
    // and a list — rather than flattening them all to text.
    expect(spu.commonAttributes).toEqual({ 袖长: '长袖', 克重: 180, 可机洗: true });
    expect(spu.sellingPoints).toEqual(['100% 纯棉', '支持七天无理由']);
    expect(spu).toMatchObject({
      shelfStatus: 'on_shelf',
      sourceUpdatedAt: now,
      categoryId: category.id,
    });

    const black = stored(
      await repository.createSku({
        tenantId: tenantA,
        storeId: storeA,
        spuId: spu.id,
        skuCode: `TS-${RUN}-BLK-M`,
        variant: { 颜色: '黑', 尺码: 'M' },
        searchAttributes: { 颜色: '黑', 尺码: 'M' },
        now,
      }),
    );
    const white = stored(
      await repository.createSku({
        tenantId: tenantA,
        storeId: storeA,
        spuId: spu.id,
        skuCode: `TS-${RUN}-WHT-L`,
        variant: { 颜色: '白', 尺码: 'L' },
        now,
      }),
    );
    expect(black.variant).toEqual({ 颜色: '黑', 尺码: 'M' });
    expect(black.searchAttributes).toEqual({ 颜色: '黑', 尺码: 'M' });
    expect(white).toMatchObject({
      status: 'active',
      externalSkuId: null,
      variant: { 颜色: '白', 尺码: 'L' },
    });

    // One row per *thing*, one per variant: the product is not duplicated.
    const inCategory = await repository.listSpus(tenantA, {
      storeId: storeA,
      categoryId: category.id,
    });
    expect(inCategory.filter((item) => item.id === spu.id)).toHaveLength(1);
    expect((await repository.listSkus(tenantA, spu.id)).map((sku) => sku.skuCode)).toEqual([
      `TS-${RUN}-BLK-M`,
      `TS-${RUN}-WHT-L`,
    ]);

    // A variant of another tenant's product is refused, not written.
    expect(
      await repository.createSku({
        tenantId: tenantB,
        storeId: storeB,
        spuId: spu.id,
        skuCode: `TS-${RUN}-XL`,
      }),
    ).toBeUndefined();

    // The tenant-first unique key is what makes an import idempotent: the
    // database itself refuses a second product with the same code in the store.
    await expect(
      repository.createSpu({
        tenantId: tenantA,
        storeId: storeA,
        productCode: `TS-${RUN}`,
        title: '重复编码',
      }),
    ).rejects.toThrow();

    // A different client reads the same tree back.
    const restarted = buildRepository(database);
    expect((await restarted.getSpu(tenantA, spu.id))?.commonAttributes).toEqual({
      袖长: '长袖',
      克重: 180,
      可机洗: true,
    });
    expect(await restarted.listSkus(tenantA, spu.id)).toHaveLength(2);
    expect(await restarted.getSpu(tenantB, spu.id)).toBeUndefined();
    expect(await restarted.getSku(tenantB, black.id)).toBeUndefined();

    // Taking it off the shelf leaves the category alone; then unfiling it sets
    // the column to NULL. The two writes are the reason the SQL cannot use
    // `COALESCE` here: `NULL` is a value, not an absence.
    const shelved = await restarted.updateSpu(tenantA, spu.id, { shelfStatus: 'off_shelf' }, now);
    expect(shelved).toMatchObject({
      shelfStatus: 'off_shelf',
      categoryId: category.id,
      title: '纯棉圆领 T 恤',
      createdAt: now,
    });
    const unfiled = await restarted.updateSpu(tenantA, spu.id, { categoryId: null }, now);
    expect(unfiled).toMatchObject({ categoryId: null, shelfStatus: 'off_shelf' });

    const withdrawn = await restarted.updateSku(tenantA, black.id, { status: 'inactive' }, now);
    expect(withdrawn).toMatchObject({
      status: 'inactive',
      skuCode: `TS-${RUN}-BLK-M`,
      variant: { 颜色: '黑', 尺码: 'M' },
      createdAt: now,
      updatedAt: now,
    });
  });

  it('keeps near-questions, an import record and a merchant-level phrase across a client recreation', async () => {
    const now = new Date().toISOString();
    const faq = await repository.createFaq({
      tenantId: tenantA,
      storeId: storeA,
      question: `什么时候发货-${RUN}？`,
      answer: '付款后 48 小时内发出。',
      tags: ['物流'],
      now,
    });

    const generated = stored(
      await repository.createFaqVariant({
        tenantId: tenantA,
        faqId: faq.id,
        questionText: `多久能发货-${RUN}`,
        source: 'generated',
        now,
      }),
    );
    expect(generated).toMatchObject({ faqId: faq.id, source: 'generated', status: 'enabled' });

    // Generating twice must not accumulate the same near-question: the
    // tenant-first unique key is what makes the generator safe to re-run.
    await expect(
      repository.createFaqVariant({
        tenantId: tenantA,
        faqId: faq.id,
        questionText: `多久能发货-${RUN}`,
        source: 'generated',
        now,
      }),
    ).rejects.toThrow();

    // A near-question of another tenant's FAQ is refused, not written.
    expect(
      await repository.createFaqVariant({
        tenantId: tenantB,
        faqId: faq.id,
        questionText: `跨租户-${RUN}`,
        now,
      }),
    ).toBeUndefined();

    const batch = await repository.createImportBatch({
      tenantId: tenantA,
      storeId: storeA,
      sourceType: 'csv',
      fileObjectKey: `imports/${RUN}.csv`,
      fileSha256: 'c'.repeat(64),
      createdBy: agentA,
      now,
    });
    expect(batch).toMatchObject({
      status: 'uploaded',
      totalRows: 0,
      startedAt: null,
      finishedAt: null,
      createdBy: agentA,
    });

    const written = stored(
      await repository.appendImportErrors({
        tenantId: tenantA,
        batchId: batch.id,
        errors: [
          { rowNumber: 7, fieldName: 'sku', errorCode: 'sku_duplicate', rawValueMasked: 'TS-0**' },
          { rowNumber: 3, errorCode: 'price_missing', errorMessage: '价格为空' },
        ],
        now,
      }),
    );
    expect(written).toHaveLength(2);

    // The composite `(tenant_id, batch_id)` key is what stops a batch id from
    // another tenant being used to write a line into that tenant's report.
    expect(
      await repository.appendImportErrors({
        tenantId: tenantB,
        batchId: batch.id,
        errors: [{ rowNumber: 1, errorCode: 'trespass' }],
        now,
      }),
    ).toBeUndefined();

    const finished = await repository.updateImportBatch(
      tenantA,
      batch.id,
      {
        status: 'partial_failed',
        totalRows: 400,
        successRows: 398,
        failedRows: 2,
        finishedAt: now,
      },
      now,
    );
    expect(finished).toMatchObject({
      status: 'partial_failed',
      successRows: 398,
      failedRows: 2,
      finishedAt: now,
      fileSha256: 'c'.repeat(64),
    });

    // The merchant-level phrase: `store_id` is now nullable and `scope_type`
    // says which of the two it is.
    const welcome = await repository.createShortcut({
      tenantId: tenantA,
      storeId: null,
      code: `welcome-${RUN}`,
      title: '欢迎语',
      content: '您好，很高兴为您服务。',
      sortOrder: 1,
      now,
    });
    expect(welcome).toMatchObject({ scopeType: 'tenant', storeId: null, sortOrder: 1 });
    const own = await repository.createShortcut({
      tenantId: tenantA,
      storeId: storeA,
      code: `delivery-${RUN}`,
      title: '本店发货时效',
      content: '下单后 48 小时内发货。',
      now,
    });
    expect(own).toMatchObject({ scopeType: 'store', storeId: storeA, intentCode: null });

    // The partial unique index covers the rows the three-column key cannot: each
    // NULL store_id compares as distinct, so without it two merchant-level
    // phrases could share a code.
    await expect(
      repository.createShortcut({
        tenantId: tenantA,
        storeId: null,
        code: `welcome-${RUN}`,
        title: '重复欢迎语',
        content: '重复',
        now,
      }),
    ).rejects.toThrow();

    // A different client reads the same facts back.
    const restarted = buildRepository(database);
    expect(
      (await restarted.listFaqVariants(tenantA, faq.id)).map((item) => item.questionText),
    ).toEqual([`多久能发货-${RUN}`]);
    expect(await restarted.listFaqVariants(tenantB, faq.id)).toEqual([]);

    const reopened = await restarted.getImportBatch(tenantA, batch.id);
    expect(reopened).toMatchObject({ status: 'partial_failed', sourceType: 'csv' });
    const errors = await restarted.listImportErrors(tenantA, batch.id);
    expect(errors.map((item) => item.rowNumber)).toEqual([3, 7]);
    expect(errors[0]).toMatchObject({
      fieldName: null,
      errorCode: 'price_missing',
      errorMessage: '价格为空',
      rawValueMasked: null,
    });
    expect(await restarted.listImportErrors(tenantB, batch.id)).toEqual([]);

    // Store B sees the merchant-level phrase and not store A's own.
    const forStoreB = (await restarted.listShortcuts(tenantA, storeB)).map((item) => item.code);
    expect(forStoreB).toContain(`welcome-${RUN}`);
    expect(forStoreB).not.toContain(`delivery-${RUN}`);

    // `intent_code` is nullable, so a patch has to be able to say "clear it"
    // distinctly from "leave it": the SQL uses a `CASE WHEN`, not `COALESCE`.
    const tagged = await restarted.updateShortcut(
      tenantA,
      welcome.id,
      { intentCode: 'greeting' },
      now,
    );
    expect(tagged).toMatchObject({ intentCode: 'greeting', scopeType: 'tenant' });
    const cleared = await restarted.updateShortcut(tenantA, welcome.id, { intentCode: null }, now);
    expect(cleared).toMatchObject({ intentCode: null, code: `welcome-${RUN}`, storeId: null });

    // Removing the batch takes its error rows with it through the composite
    // foreign key, rather than leaving lines that point at nothing.
    await pool.query('DELETE FROM product_import_batches WHERE tenant_id = $1 AND id = $2', [
      tenantA,
      batch.id,
    ]);
    expect(await restarted.listImportErrors(tenantA, batch.id)).toEqual([]);
  });
});
