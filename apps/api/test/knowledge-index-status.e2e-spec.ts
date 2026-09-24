/**
 * `GET /knowledge/index-status` against the real PostgreSQL, through real HTTP.
 *
 * This is the block's evidence for the half of the acceptance criterion that is
 * not the sweep ("索引状态查询"), and it is deliberately *not* another unit suite:
 * three of the things this endpoint must get right are invisible to any test that
 * does not have a database and a request in it —
 *
 * 1. **Cross-tenant isolation.** Every number the endpoint reports comes from a
 *    `WHERE tenant_id = $1` in one of three statements. Nothing about the code
 *    that builds the filter can be asserted in the abstract; what can be asserted
 *    is that tenant A's answer contains none of tenant B's slices, and that is
 *    what the first two cases do — with B's *newest* failure carrying a reason
 *    that names it, so a leak is visible in the body rather than merely arithmetic.
 * 2. **The store filter's rule on tenant-scope slices.** `scope_type = 'tenant'`
 *    is `store_id IS NULL` by construction, and a store's retrieval reads those
 *    slices, so a store-scoped read keeps them and drops only the *other* store's.
 *    The seeded directory gives tenant A two stores, which is what makes that
 *    visible (and a mistake would otherwise look like a plausible count).
 * 3. **The refusal's shape.** `details` is only ever non-empty when the thrown
 *    value is an array, so the 400 below asserts a non-empty `details` — and one
 *    case asserts an *empty* one, naming the platform-level reason it is empty
 *    (挂账 #1) so that the day it is fixed, that line goes red instead of quietly
 *    passing.
 *
 * The app is booted `local` rather than `test`: `test` serves the in-process store
 * (`resolvePlatformStorageMode`), which answers zeros for every tenant by design
 * and therefore cannot show isolation. The `x-member-id` demo header is enabled
 * explicitly, because the production-shaped default is to refuse it.
 *
 * What this suite does *not* settle: the zero-fill and `total` arithmetic (pinned
 * without a database in `packages/core/src/platform/knowledge-index-status.spec.ts`)
 * and which query strings are refused at all (`knowledge-index-status-query.spec.ts`).
 */

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_INDEX_FAILURE_LIMIT,
  parseAppConfig,
  type KnowledgeIndexStatusSummary,
} from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';
import {
  isDatabaseReachable,
  openDatabaseClient,
  resolveDatabaseUrl,
} from './database-test-support';

const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Per-run suffix: every row this suite writes carries it, and all are removed. */
const RUN = randomUUID().slice(0, 8);

/** The two tenants the directory seeds, and the administrators that act for them. */
const T1 = 'tenant-acme';
const T1_ADMIN = 'u-t1-admin';
/** Tenant A has two stores, which is what lets the store case be discriminating. */
const S1_FLAGSHIP = 'store-acme-flagship';
const S1_DISTRIBUTION = 'store-acme-distribution';
const T2 = 'tenant-beta';
const T2_ADMIN = 'u-t2-admin';
const T2_STORE = 'store-beta-official';

const STATUS_URL = '/api/v1/knowledge/index-status';

/** The instant the fixtures' `updated_at` values count back from. */
const NOW_MS = Date.parse('2026-09-17T03:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW_MS - minutes * 60_000).toISOString();

/** Every fixture slice carries one, because the column is not nullable. */
const CONTENT_HASH = 'hash-of-the-status-fixture';
/** pgvector's text form, as the sweep's own integration suite writes it. */
const VECTOR = '[0.5,-1.25,3]';
const MODEL = 'status-e2e-embedding-v1';

/** One seeded slice. */
type Fixture = {
  readonly label: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly sourceKind: 'faq' | 'faq_variant' | 'shortcut';
  readonly sourceId: string;
  readonly indexStatus: 'pending' | 'indexed' | 'failed' | 'skipped';
  readonly indexAttempts: number;
  readonly indexError: string | null;
  readonly ageMinutes: number;
  /** Whether a vector row is stored for this slice. */
  readonly embedded?: boolean;
};

const FLAGSHIP_SOURCE = `faq-${RUN}-flagship`;
const DISTRIBUTION_SOURCE = `faq_variant-${RUN}-distribution`;
const TENANT_SOURCE = `shortcut-${RUN}-tenant`;
const BETA_SOURCE = `faq-${RUN}-beta`;

/**
 * The fixtures, laid out so that every case below has something to discriminate.
 *
 * Tenant A holds seven failure-bearing slices (five `failed` of which the oldest
 * is 40 minutes back, one `skipped` that exhausted its budget), two that are
 * indexed — one per store plus one at tenant scope, each with a vector — and
 * three that are merely pending. That is more failures than the kernel's limit,
 * so the ordering case has rows to drop; and the pending, indexed and skipped
 * states are all non-empty, so a case that reports zeros has to mean it.
 *
 * Tenant B holds four slices, and its single failure is *newer* than five of A's
 * and carries a reason that names it: if the tenant predicate ever left the
 * statement, B's row would be the first one back, in A's answer.
 */
const FIXTURES: ReadonlyArray<Fixture> = [
  {
    label: 'flagship-pending',
    tenantId: T1,
    storeId: S1_FLAGSHIP,
    sourceKind: 'faq',
    sourceId: FLAGSHIP_SOURCE,
    indexStatus: 'pending',
    indexAttempts: 1,
    indexError: null,
    ageMinutes: 30,
  },
  ...(
    [
      ['flagship-failed-1', 'rate_limited', 2, 10],
      ['flagship-failed-2', 'provider_timeout', 3, 9],
      ['flagship-failed-3', 'provider_timeout', 3, 8],
      ['flagship-failed-4', 'rate_limited', 2, 7],
      ['flagship-failed-5', 'provider_error', 1, 40],
    ] as ReadonlyArray<readonly [string, string, number, number]>
  ).map(([label, indexError, indexAttempts, ageMinutes]): Fixture => ({
    label,
    tenantId: T1,
    storeId: S1_FLAGSHIP,
    sourceKind: 'faq',
    sourceId: FLAGSHIP_SOURCE,
    indexStatus: 'failed',
    indexAttempts,
    indexError,
    ageMinutes,
  })),
  {
    label: 'flagship-parked',
    tenantId: T1,
    storeId: S1_FLAGSHIP,
    sourceKind: 'faq',
    sourceId: FLAGSHIP_SOURCE,
    indexStatus: 'skipped',
    indexAttempts: 5,
    indexError: 'provider_timeout',
    ageMinutes: 6,
  },
  {
    label: 'distribution-indexed',
    tenantId: T1,
    storeId: S1_DISTRIBUTION,
    sourceKind: 'faq_variant',
    sourceId: DISTRIBUTION_SOURCE,
    indexStatus: 'indexed',
    indexAttempts: 2,
    indexError: null,
    ageMinutes: 5,
    embedded: true,
  },
  {
    label: 'distribution-pending',
    tenantId: T1,
    storeId: S1_DISTRIBUTION,
    sourceKind: 'faq_variant',
    sourceId: DISTRIBUTION_SOURCE,
    indexStatus: 'pending',
    indexAttempts: 1,
    indexError: null,
    ageMinutes: 4,
  },
  {
    label: 'tenant-indexed',
    tenantId: T1,
    storeId: null,
    sourceKind: 'shortcut',
    sourceId: TENANT_SOURCE,
    indexStatus: 'indexed',
    indexAttempts: 2,
    indexError: null,
    ageMinutes: 3,
    embedded: true,
  },
  {
    label: 'tenant-failed',
    tenantId: T1,
    storeId: null,
    sourceKind: 'shortcut',
    sourceId: TENANT_SOURCE,
    indexStatus: 'failed',
    indexAttempts: 4,
    indexError: 'source_missing',
    ageMinutes: 2,
  },
  {
    label: 'beta-pending-1',
    tenantId: T2,
    storeId: T2_STORE,
    sourceKind: 'faq',
    sourceId: BETA_SOURCE,
    indexStatus: 'pending',
    indexAttempts: 1,
    indexError: null,
    ageMinutes: 30,
  },
  {
    label: 'beta-pending-2',
    tenantId: T2,
    storeId: T2_STORE,
    sourceKind: 'faq',
    sourceId: BETA_SOURCE,
    indexStatus: 'pending',
    indexAttempts: 2,
    indexError: null,
    ageMinutes: 25,
  },
  {
    label: 'beta-indexed',
    tenantId: T2,
    storeId: T2_STORE,
    sourceKind: 'faq',
    sourceId: BETA_SOURCE,
    indexStatus: 'indexed',
    indexAttempts: 1,
    indexError: null,
    ageMinutes: 20,
    embedded: true,
  },
  {
    label: 'beta-failed',
    tenantId: T2,
    storeId: T2_STORE,
    sourceKind: 'faq',
    sourceId: BETA_SOURCE,
    indexStatus: 'failed',
    indexAttempts: 2,
    indexError: 'beta_only_rate_limited',
    // The newest by a minute: nothing in A is fresher, so a statement that lost
    // its tenant predicate would answer A with this row at the head of the list.
    ageMinutes: 1,
  },
];

/** The id one fixture's slice is written under. */
function chunkId(label: string): string {
  return `kchunk-status-${RUN}-${label}`;
}

/** Every row this suite writes matches it, so cleanup cannot touch anyone else's. */
const ROW_PATTERN = `kchunk-status-${RUN}-%`;

/** An error response, shaped as `all-exceptions.filter.ts` emits it. */
type ErrorEnvelope = { request_id: string; code: string; message: string; details: unknown[] };

/**
 * Assert a refusal carried its reasons to the caller.
 *
 * The same three conditions the sibling preview suite holds (`knowledge-import-preview.e2e-spec.ts`),
 * and for the same reason: `details: []` is a 400 that tells the caller nothing,
 * and an element that is not a string stops being a reason and becomes a value.
 *
 * @param body - The parsed error response.
 * @returns The reasons, for a case that wants to name the parameter.
 */
function expectErrorReasons(body: ErrorEnvelope): ReadonlyArray<unknown> {
  expect(body.code).toBe('bad_request');
  expect(body.details.length).toBeGreaterThan(0);
  expect(body.details.every((detail) => typeof detail === 'string')).toBe(true);
  return body.details;
}

describe.skipIf(!reachable)('Knowledge index status (interface)', () => {
  let app: INestApplication;
  let client: Client;

  beforeAll(async () => {
    // `local` is what selects the PostgreSQL platform repository; `test` would
    // serve the in-process store, whose answer is zeros for every tenant.
    const parsed = parseAppConfig({
      ...process.env,
      APP_ENV: 'local',
      // Refused by default in a production-shaped environment: this suite is
      // about tenant boundaries, and it needs an identity to cross them with.
      AUTH_DEMO_IDENTITY_HEADERS: 'true',
    });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }

    client = await openDatabaseClient(databaseUrl);
    await assertSeededTenantsAreClean();
    await seedFixtures();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    }).compile();
    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);
  });

  afterAll(async () => {
    await client.query('DELETE FROM knowledge_chunk_embeddings WHERE chunk_id LIKE $1', [
      ROW_PATTERN,
    ]);
    await client.query('DELETE FROM knowledge_chunks WHERE id LIKE $1', [ROW_PATTERN]);
    await client.end();

    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  it('answers each tenant with only its own slices, state by state', async () => {
    const forT1 = await statusAs(T1_ADMIN);
    const forT2 = await statusAs(T2_ADMIN);

    // First, that the two answers are about different tenants *at all*. B's only
    // failure is the freshest row in the table, so a statement that lost its
    // tenant predicate would answer A with that row at the head of its list; and
    // B, which holds exactly one failure, would come back with A's five.
    const reasonsForT1 = forT1.recentFailures.map((failure) => failure.indexError);
    expect(reasonsForT1).not.toContain('beta_only_rate_limited');
    expect(forT2.recentFailures.map((failure) => failure.chunkId)).toEqual([
      chunkId('beta-failed'),
    ]);

    // Then the arithmetic, which is how the criterion is written. Tenant A holds 2
    // pending, 2 indexed, 6 failed and 1 skipped, with 2 vectors; tenant B holds
    // 2 / 1 / 1 / 0 and 1. A leak shows up as more rows rather than as a
    // differently-shaped answer, which is why these are exact rather than bounds.
    expect(forT1.counts).toEqual({ pending: 2, indexed: 2, failed: 6, skipped: 1, total: 11 });
    expect(forT1.embeddings).toBe(2);
    expect(forT2.counts).toEqual({ pending: 2, indexed: 1, failed: 1, skipped: 0, total: 4 });
    expect(forT2.embeddings).toBe(1);
  });

  it('reports the newest failures first, and no more than the kernel limit', async () => {
    const summary = await statusAs(T1_ADMIN);

    // Six failures recorded at distinct instants plus one parked slice: the list
    // is the newest five, and `flagship-failed-1` (10m) and `flagship-failed-5`
    // (40m) are what the bound drops. A statement without the `ORDER BY` would
    // return five arbitrary rows and pass a length assertion — this is the case
    // that makes the order the assertion.
    expect(summary.recentFailures.map((failure) => failure.chunkId)).toEqual([
      chunkId('tenant-failed'),
      chunkId('flagship-parked'),
      chunkId('flagship-failed-4'),
      chunkId('flagship-failed-3'),
      chunkId('flagship-failed-2'),
    ]);
    expect(summary.recentFailures).toHaveLength(KNOWLEDGE_INDEX_FAILURE_LIMIT);

    // `skipped` and `failed` are both listed, and the row says which it is: that
    // is the difference between a slice that will be retried and one that will
    // not, which is the whole reason an operator reads this.
    expect(summary.recentFailures[1]?.indexStatus).toBe('skipped');
    expect(summary.recentFailures[0]?.indexAttempts).toBe(4);
    expect(summary.recentFailures[0]?.sourceKind).toBe('shortcut');
  });

  it('narrows to one store, keeping the tenant-scope slices that store also retrieves', async () => {
    const flagship = await statusAs(T1_ADMIN, `?storeId=${S1_FLAGSHIP}`);

    // The flagship's seven slices plus the two at tenant scope: `scope_type =
    // 'tenant'` is `store_id IS NULL`, the store's retrieval reads those, and the
    // other store's slices drop out. Counting only `store_id = $2` would answer
    // 7 slices and 0 vectors — a plausible number that hides two slices the store
    // actually depends on.
    expect(flagship.counts).toEqual({ pending: 1, indexed: 1, failed: 6, skipped: 1, total: 9 });
    expect(flagship.embeddings).toBe(1);
    const ids = flagship.recentFailures.map((failure) => failure.chunkId);
    expect(ids).toContain(chunkId('tenant-failed'));
    expect(ids).not.toContain(chunkId('distribution-pending'));
  });

  it('narrows by source kind and by source id, and carries the filter into the vectors', async () => {
    const shortcuts = await statusAs(T1_ADMIN, '?sourceKind=shortcut');
    expect(shortcuts.counts).toEqual({ pending: 0, indexed: 1, failed: 1, skipped: 0, total: 2 });
    // One of the two tenant-scope slices has a vector, the other is a failure:
    // the count follows the same filter rather than reporting the tenant's two.
    expect(shortcuts.embeddings).toBe(1);

    const flagshipSource = await statusAs(T1_ADMIN, `?sourceId=${FLAGSHIP_SOURCE}`);
    expect(flagshipSource.counts).toEqual({
      pending: 1,
      indexed: 0,
      failed: 5,
      skipped: 1,
      total: 7,
    });
    // A source with no indexed slice has no vectors, which is a different fact
    // from "this tenant has two vectors" and is the one a filtered read owes.
    expect(flagshipSource.embeddings).toBe(0);
  });

  it('narrows by state, and lets total describe the narrowed set', async () => {
    const parked = await statusAs(T1_ADMIN, '?indexStatus=skipped');

    expect(parked.counts).toEqual({ pending: 0, indexed: 0, failed: 0, skipped: 1, total: 1 });
    expect(parked.embeddings).toBe(0);
    // The failure list is narrowed by the same filter, so asking for the parked
    // slices cannot answer with a mix of parked and merely-failed ones.
    expect(parked.recentFailures.map((failure) => failure.chunkId)).toEqual([
      chunkId('flagship-parked'),
    ]);
  });

  it('answers a filter that matches nothing with zeros rather than an empty body', async () => {
    const nothing = await statusAs(T1_ADMIN, `?sourceId=nothing-${RUN}`);

    // Every state present and zero: a consumer rendering this shape shows four
    // zeroes, and cannot tell it apart from a tenant whose slices are all fine.
    expect(nothing.counts).toEqual({ pending: 0, indexed: 0, failed: 0, skipped: 0, total: 0 });
    expect(nothing.embeddings).toBe(0);
    expect(nothing.recentFailures).toEqual([]);
  });

  it('refuses an unknown state with a 400 that says which value was wrong', async () => {
    const response = await request(app.getHttpServer())
      .get(`${STATUS_URL}?indexStatus=potato`)
      .set('x-member-id', T1_ADMIN);

    expect(response.status).toBe(400);
    // `details` is non-empty only because the refusal threw a list; a thrown
    // string would arrive as `[]` and leave the caller with no idea which
    // parameter the endpoint disliked.
    const reasons = expectErrorReasons(response.body as ErrorEnvelope);
    expect(reasons[0]).toContain('potato');
  });

  it('refuses an empty parameter instead of reading it as absent', async () => {
    const response = await request(app.getHttpServer())
      .get(`${STATUS_URL}?storeId=`)
      .set('x-member-id', T1_ADMIN);

    expect(response.status).toBe(400);
    // `?storeId=` is a caller who meant a store; answering with the whole tenant
    // is the one answer they cannot distinguish from a store with no slices.
    const reasons = expectErrorReasons(response.body as ErrorEnvelope);
    expect(reasons[0]).toContain('storeId');
  });

  it('refuses the other tenant store with details that are still a bare pair of brackets', async () => {
    const response = await request(app.getHttpServer())
      .get(`${STATUS_URL}?storeId=${T2_STORE}`)
      .set('x-member-id', T1_ADMIN);

    // The store is refused by `AccessService.assertStoreInTenant`, which is one of
    // the platform helpers that throw a *string* — `all-exceptions.filter.ts`
    // deliberately drops those, so `details` is empty (挂账 #1). Asserted rather
    // than ignored: the day that helper throws a list instead, this line is what
    // notices, and until then the emptiness is recorded as the platform's, not
    // this endpoint's. Deliberately *not* routed through `expectErrorReasons`.
    expect(response.status).toBe(400);
    const body = response.body as ErrorEnvelope;
    expect(body.code).toBe('bad_request');
    expect(body.details).toEqual([]);
  });

  it('refuses a tenant scope mismatch presented through the header', async () => {
    const response = await request(app.getHttpServer())
      .get(STATUS_URL)
      .set('x-member-id', T2_ADMIN)
      .set('x-tenant-id', T1);

    // Tenant B's administrator naming tenant A: the scope check runs before any
    // statement does, so no count of A's ever reaches this caller.
    expect(response.status).toBe(403);
    expect((response.body as ErrorEnvelope).code).toBe('forbidden');
  });

  /** One tenant's status, read through HTTP as a given administrator. */
  async function statusAs(memberId: string, query = ''): Promise<KnowledgeIndexStatusSummary> {
    const response = await request(app.getHttpServer())
      .get(`${STATUS_URL}${query}`)
      .set('x-member-id', memberId);
    expect(response.status).toBe(200);
    return (response.body as { data: KnowledgeIndexStatusSummary }).data;
  }
});

/**
 * Fail loudly when these tenants already hold slices.
 *
 * The counts below are exact — `total: 11` is the assertion, and it is what makes
 * a leaked row visible at all — so a row left behind by an interrupted run would
 * turn every case into a mystery instead. Leftovers carry this suite's pattern and
 * are named here, so the message says what to delete rather than where to look.
 */
async function assertSeededTenantsAreClean(): Promise<void> {
  const client = await openDatabaseClient(databaseUrl);
  try {
    const result = await client.query<{ tenant_id: string; count: string }>(
      `SELECT tenant_id, count(*) AS count FROM knowledge_chunks
        WHERE tenant_id = ANY($1) GROUP BY tenant_id`,
      [[T1, T2]],
    );
    const dirty = result.rows.filter((row) => Number(row.count) > 0);
    if (dirty.length > 0) {
      throw new Error(
        `knowledge_chunks already holds rows for ${dirty
          .map((row) => `${row.tenant_id} (${row.count})`)
          .join(', ')}: an earlier run left them behind, and this suite's counts are exact`,
      );
    }
  } finally {
    await client.end();
  }
}

/** Write this run's fixture rows, in one statement per slice. */
async function seedFixtures(): Promise<void> {
  const client = await openDatabaseClient(databaseUrl);
  try {
    for (const fixture of FIXTURES) {
      const id = chunkId(fixture.label);
      await client.query(
        `INSERT INTO knowledge_chunks (
           id, tenant_id, store_id, scope_type, source_kind, source_id, source_field, chunk_type,
           chunk_index, content, context_before, context_after, char_count, enabled, content_hash,
           index_status, index_attempts, index_error, indexed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'content', 'content', $7, $8, NULL, NULL, $9, true, $10,
                 $11, $12, $13, $14, $15, $15)`,
        [
          id,
          fixture.tenantId,
          fixture.storeId,
          fixture.storeId === null ? 'tenant' : 'store',
          fixture.sourceKind,
          fixture.sourceId,
          FIXTURES.indexOf(fixture),
          `状态夹具：${fixture.label}`,
          `状态夹具：${fixture.label}`.length,
          CONTENT_HASH,
          fixture.indexStatus,
          fixture.indexAttempts,
          fixture.indexError,
          fixture.indexStatus === 'indexed' ? minutesAgo(fixture.ageMinutes) : null,
          minutesAgo(fixture.ageMinutes),
        ],
      );
      if (fixture.embedded === true) {
        await client.query(
          `INSERT INTO knowledge_chunk_embeddings (
             id, tenant_id, chunk_id, embedding_model, embedding_dimensions, embedding,
             content_hash, created_at)
           VALUES ($1, $2, $3, $4, 3, $5::vector, $6, $7)`,
          [
            `kemb-status-${RUN}-${fixture.label}`,
            fixture.tenantId,
            id,
            MODEL,
            VECTOR,
            CONTENT_HASH,
            minutesAgo(fixture.ageMinutes),
          ],
        );
      }
    }
  } finally {
    await client.end();
  }
}
