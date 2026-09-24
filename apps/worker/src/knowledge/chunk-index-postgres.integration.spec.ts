import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_INDEX_MAX_ATTEMPTS,
  KNOWLEDGE_INDEX_PARKED_WITHOUT_REASON,
  deriveEmbeddingId,
  knowledgeIndexRetryDelayMs,
  parseAppConfig,
} from '@kefu/core';
import { WorkerDatabase } from '../database/worker-database';
import type { ClaimedChunk } from './chunk-index-repository';
import { ChunkIndexProcessor } from './chunk-index-processor';
import type { EmbeddingProvider } from '@kefu/core';
import { PostgresChunkIndexRepository } from './postgres-chunk-index-repository';

/**
 * The index sweep against the real PostgreSQL: which slices a claim takes, and
 * what an attempt's outcome becomes in the two tables.
 *
 * `chunk-index-processor.spec.ts` settles everything about a tick that can be
 * settled without a database — the gate, the counter, the classification of a
 * provider's failures. What it cannot settle is the half of the sweep that *is*
 * SQL, and this suite exists for exactly that half, because each of these three
 * statements is wrong in a way that no assertion about the code around it can
 * see:
 *
 * - **The claim's `WHERE`.** It is the only place `isChunkIndexDue` exists twice,
 *   and a predicate that is too wide does not error — it claims rows whose
 *   backoff has not elapsed, spends attempts on them, and the table simply parks
 *   its slices sooner. The rows are therefore *seeded into the states the
 *   predicate distinguishes* (a fresh failure, an elapsed failure, `indexed`,
 *   `skipped`, and a counter at the ceiling) and the assertion is which ids came
 *   back, not how many.
 * - **The write-back's guard.** `content_hash = $3` is what keeps a vector from
 *   landing under text that changed while the provider was being called. The
 *   case reproduces that by moving the text between the claim and the record,
 *   which is the only way to see the difference between a guard and a `WHERE id`.
 * - **The recovery's clock.** Parking a row that a live Worker is embedding right
 *   now is a lie an operator would read as a finished slice. The case seeds two
 *   rows at the ceiling that differ only in how long ago they were touched.
 *
 * Three notes on the plumbing, which is the write suite's and is copied for the
 * same reasons:
 *
 * - **It does not import the API's test helpers.** A Worker test reaching into
 *   `apps/api` would make the two workspaces one workspace, which is the boundary
 *   the whole task exists to establish.
 * - **Rows are seeded with plain SQL.** Seeding is not part of the Worker's
 *   contract — the API writes these rows in production — so it is written out
 *   here rather than given a production home it does not have. The seed helper
 *   writes every column the block's own writer would, so a seeded row and a
 *   written row are the same row.
 * - **A case reads its own tenant's slice of the claim.** The claim is
 *   platform-wide by design — the Worker sweeps every tenant and the port has no
 *   tenant parameter — so a case narrows the answer to its own tenant instead of
 *   asserting over the whole table. In a green run the two are the same list:
 *   every case leaves its rows outside their backoff windows, so there is nothing
 *   else for the claim to take. The narrowing is what keeps a broken schedule
 *   from turning one case red for another case's fixture.
 * - **The suite skips when no database is reachable**, and says so out loud in
 *   its first case: `npm test` has to pass on a machine without PostgreSQL, and a
 *   skipped run must never be read as a passing one. Every row it writes carries
 *   a per-run identifier and is removed in `afterAll`.
 */

const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Unique suffix isolating this run's rows from every other run's. */
const RUN = randomUUID().slice(0, 8);

/** The tick instant every case runs at. */
const NOW_MS = Date.parse('2026-09-17T03:00:00.000Z');
const NOW = new Date(NOW_MS).toISOString();

/** The model the fake provider reports; also the `embedding_model` written. */
const MODEL = 'sweep-test-embedding-v1';

/** The vector the fake provider returns, and the text form it round-trips as. */
const VECTOR = [0.5, -1.25, 3];
const VECTOR_TEXT = '[0.5,-1.25,3]';

/** A slice that failed one attempt ten seconds before the tick: not yet due. */
const FRESH_FAILURE = { at: new Date(NOW_MS - 10_000).toISOString(), attempts: 1 };
/** A slice that failed one attempt two minutes before the tick: due. */
const ELAPSED_FAILURE = { at: new Date(NOW_MS - 2 * 60_000).toISOString(), attempts: 1 };
/** A slice at the ceiling, touched twenty minutes ago: past the ceiling's delay. */
const OLD_CEILING = { at: new Date(NOW_MS - 20 * 60_000).toISOString() };
/** A slice at the ceiling, touched a minute ago: inside the ceiling's delay. */
const LIVE_CEILING = { at: new Date(NOW_MS - 60_000).toISOString() };

describe.skipIf(!reachable)('Worker chunk index sweep (PostgreSQL)', () => {
  let database: WorkerDatabase;
  let repository: PostgresChunkIndexRepository;
  /** Tenants this run created, removed in `afterAll` in foreign-key order. */
  const tenants: string[] = [];

  beforeAll(async () => {
    // Idempotent: a developer machine may already have the migrations applied.
    runDatabaseCommand('migrate', databaseUrl);
    database = new WorkerDatabase(databaseUrl);
    repository = new PostgresChunkIndexRepository(database);
  });

  afterAll(async () => {
    if (database !== undefined) {
      await cleanup();
      await database.close();
    }
  });

  it('runs against a reachable database', () => {
    // Reported explicitly, so a skipped run is never mistaken for a passing one.
    expect(reachable).toBe(true);
  });

  it('places its fixtures on the two sides of the schedule the sweep applies', () => {
    // Every case below turns on a comparison against a delay — "the backoff has
    // elapsed", "it has not" — and a fixture on the wrong side of that boundary
    // would make the case pass for the opposite reason to the one it means. The
    // schedule is the kernel's, so these four assertions are also what keeps this
    // file honest if the schedule changes underneath it.
    const oneAttempt = knowledgeIndexRetryDelayMs(1);
    const ceiling = knowledgeIndexRetryDelayMs(KNOWLEDGE_INDEX_MAX_ATTEMPTS);
    expect(NOW_MS - Date.parse(ELAPSED_FAILURE.at)).toBeGreaterThanOrEqual(oneAttempt);
    expect(NOW_MS - Date.parse(FRESH_FAILURE.at)).toBeLessThan(oneAttempt);
    expect(NOW_MS - Date.parse(OLD_CEILING.at)).toBeGreaterThanOrEqual(ceiling);
    expect(NOW_MS - Date.parse(LIVE_CEILING.at)).toBeLessThan(ceiling);
  });

  it('claims only the slices whose backoff has elapsed, and counts why', async () => {
    const tenantId = await createTenant('claim');
    const due = await seedChunk(tenantId, 'due', { status: 'failed', ...ELAPSED_FAILURE });
    const fresh = await seedChunk(tenantId, 'fresh', { status: 'failed', ...FRESH_FAILURE });
    const indexed = await seedChunk(tenantId, 'indexed', { status: 'indexed', ...ELAPSED_FAILURE });
    const parked = await seedChunk(tenantId, 'parked', {
      ...ELAPSED_FAILURE,
      status: 'skipped',
      attempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS,
    });
    const ceiling = await seedChunk(tenantId, 'ceiling', {
      ...ELAPSED_FAILURE,
      status: 'pending',
      attempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS,
    });

    const claimed = await repository.claimDue(NOW, 10);

    // Which ids, not how many: a wide `WHERE` returns the right count for the
    // wrong reasons, and the three excluded rows are excluded by three different
    // clauses of the predicate.
    expect(claimedFor(claimed, tenantId).map((slice) => slice.id)).toEqual([due]);
    expect(claimed[0]?.indexAttempts).toBe(2);
    expect(claimed[0]?.contentHash).toBe(hashOf('claim-due'));

    // The claim is an attempt, not a read: the counter moved and the schedule
    // re-anchored on the tick's instant, while the status the slice carried is
    // replaced by the one `planChunkWrite`'s attempt branch writes.
    expect(await readChunk(due)).toMatchObject({
      index_status: 'pending',
      index_attempts: 2,
      updated_at: new Date(NOW),
    });
    // And the rows it left are untouched *including* their instants: a claim that
    // refreshed `updated_at` on a row it did not take would push that row's
    // backoff forward on every tick, silently, until it never came due again.
    expect(await readChunk(fresh)).toMatchObject({
      index_status: 'failed',
      index_attempts: 1,
      updated_at: new Date(FRESH_FAILURE.at),
    });
    expect(await readChunk(ceiling)).toMatchObject({
      index_status: 'pending',
      index_attempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS,
      updated_at: new Date(ELAPSED_FAILURE.at),
    });
    expect((await readChunk(indexed)).index_status).toBe('indexed');
    expect((await readChunk(parked)).index_status).toBe('skipped');
  });

  it('takes the longest-waiting slices first, and no more than the limit', async () => {
    const tenantId = await createTenant('limit');
    const first = await seedChunk(tenantId, 'first', {
      status: 'failed',
      at: new Date(NOW_MS - 30 * 60_000).toISOString(),
      attempts: 1,
    });
    const second = await seedChunk(tenantId, 'second', { status: 'failed', ...ELAPSED_FAILURE });

    // One at a time, so the order the claim chose is visible rather than inferred
    // from a set: `ORDER BY updated_at, id` is what makes two Workers take
    // different rows instead of racing on one.
    const take = async (): Promise<ReadonlyArray<string>> =>
      claimedFor(await repository.claimDue(NOW, 1), tenantId).map((slice) => slice.id);
    expect(await take()).toEqual([first]);
    expect(await take()).toEqual([second]);
    // The first row's claim put it outside the backoff window, so a third claim
    // at the same instant finds nothing rather than taking it again.
    expect(await take()).toEqual([]);
  });

  it('claims a slice whose source was switched off, because indexing is not retrieval', async () => {
    const tenantId = await createTenant('disabled');
    const disabled = await seedChunk(tenantId, 'disabled', {
      status: 'pending',
      enabled: false,
      ...ELAPSED_FAILURE,
    });

    // `0011` says the indexer writes the usability rule *down* so retrieval does
    // not have to join for it, and the kernel says a switched-off source's slices
    // are still indexed — the correction reaches them through a pass, and a slice
    // this sweep skipped would keep its stale copy for ever.
    expect(
      claimedFor(await repository.claimDue(NOW, 10), tenantId).map((slice) => slice.id),
    ).toEqual([disabled]);
  });

  it('writes the vector and the index columns together, and re-embeds in place', async () => {
    const tenantId = await createTenant('record');
    const chunkId = await seedChunk(tenantId, 'record', { status: 'failed', ...ELAPSED_FAILURE });
    const [claim] = await repository.claimDue(NOW, 1);
    if (claim === undefined) {
      throw new Error('test invariant: the due slice was not claimed');
    }

    const recorded = await repository.recordOutcome({
      chunk: claim,
      state: {
        indexStatus: 'indexed',
        indexAttempts: claim.indexAttempts,
        indexError: null,
        indexedAt: NOW,
      },
      embedding: {
        id: deriveEmbeddingId(tenantId, chunkId, MODEL),
        model: MODEL,
        vector: VECTOR,
        contentHash: claim.contentHash,
      },
      now: NOW,
    });

    expect(recorded).toBe('recorded');
    expect(await readChunk(chunkId)).toMatchObject({
      index_status: 'indexed',
      // The claim's count, written once: a second increment here would park a
      // slice after three recorded failures instead of five.
      index_attempts: 2,
      index_error: null,
      indexed_at: new Date(NOW),
      updated_at: new Date(NOW),
    });
    expect(await listEmbeddings(chunkId)).toEqual([
      {
        id: deriveEmbeddingId(tenantId, chunkId, MODEL),
        embedding_model: MODEL,
        embedding_dimensions: VECTOR.length,
        embedding: VECTOR_TEXT,
        content_hash: claim.contentHash,
      },
    ]);

    // A second model's vector lands beside this one rather than on top of it —
    // the rebuild path `0011` spells out — and the first model's row is still
    // there afterwards, which is the whole question that migration asks.
    await repository.recordOutcome({
      chunk: claim,
      state: {
        indexStatus: 'indexed',
        indexAttempts: claim.indexAttempts,
        indexError: null,
        indexedAt: NOW,
      },
      embedding: {
        id: deriveEmbeddingId(tenantId, chunkId, 'other-model'),
        model: 'other-model',
        vector: [1],
        contentHash: claim.contentHash,
      },
      now: NOW,
    });
    // Read in `embedding_model` order, so the pair is also evidence the second
    // write inserted rather than replaced.
    expect((await listEmbeddings(chunkId)).map((row) => row.embedding_model)).toEqual([
      'other-model',
      MODEL,
    ]);

    // And re-embedding under the same model replaces in place, keeping the id the
    // first write derived: the row a rebuild finds is the row it wrote.
    await repository.recordOutcome({
      chunk: claim,
      state: {
        indexStatus: 'indexed',
        indexAttempts: claim.indexAttempts,
        indexError: null,
        indexedAt: NOW,
      },
      embedding: {
        id: deriveEmbeddingId(tenantId, chunkId, MODEL),
        model: MODEL,
        vector: [0.25],
        contentHash: claim.contentHash,
      },
      now: NOW,
    });
    const sameModel = (await listEmbeddings(chunkId)).filter(
      (row) => row.embedding_model === MODEL,
    );
    expect(sameModel).toHaveLength(1);
    expect(sameModel[0]?.embedding).toBe('[0.25]');
    expect(sameModel[0]?.id).toBe(deriveEmbeddingId(tenantId, chunkId, MODEL));
  });

  it('discards the outcome of an attempt whose slice text moved, rather than indexing it', async () => {
    const tenantId = await createTenant('superseded');
    const chunkId = await seedChunk(tenantId, 'moved', { status: 'failed', ...ELAPSED_FAILURE });
    const [claim] = await repository.claimDue(NOW, 1);
    if (claim === undefined) {
      throw new Error('test invariant: the due slice was not claimed');
    }
    const before = await readChunk(chunkId);
    // The claim spent an attempt; the edit below is what the guard is about.
    expect(before['index_attempts']).toBe(2);

    // The edit a pass of `indexSourceInto` would make while the provider was
    // being called: new text, new hash, back to `pending` with a fresh budget.
    await database.query(
      `UPDATE knowledge_chunks
          SET content = $2, char_count = $3, content_hash = $4,
              index_status = 'pending', index_attempts = 1, index_error = NULL,
              indexed_at = NULL, updated_at = $5
        WHERE id = $1`,
      [chunkId, '完全不同的文案', 7, 'hash-after-the-edit', NOW],
    );

    const recorded = await repository.recordOutcome({
      chunk: claim,
      state: {
        indexStatus: 'indexed',
        indexAttempts: claim.indexAttempts,
        indexError: null,
        indexedAt: NOW,
      },
      embedding: {
        id: deriveEmbeddingId(tenantId, chunkId, MODEL),
        model: MODEL,
        vector: VECTOR,
        contentHash: claim.contentHash,
      },
      now: NOW,
    });

    // The vector describes text the slice no longer contains, so nothing is
    // written — not the vector, and not the `indexed` state that would claim
    // there is one.
    expect(recorded).toBe('superseded');
    expect(await listEmbeddings(chunkId)).toEqual([]);
    expect(await readChunk(chunkId)).toMatchObject({
      index_status: 'pending',
      index_attempts: 1,
      content_hash: 'hash-after-the-edit',
      indexed_at: null,
    });
  });

  it('closes the row a dead worker left at the ceiling, but not while a live one may hold it', async () => {
    const tenantId = await createTenant('ceiling');
    const stale = await seedChunk(tenantId, 'stale', {
      status: 'pending',
      attempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS,
      at: OLD_CEILING.at,
    });
    const live = await seedChunk(tenantId, 'live', {
      status: 'pending',
      attempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS,
      at: LIVE_CEILING.at,
    });

    // The ceiling's own delay is the clock, because `0011` offers no lease: the
    // row it stands in for is one a Worker claimed a moment ago and is embedding
    // right now, and parking that would report a finished slice that is not one.
    expect(await repository.parkExhausted(NOW)).toBe(1);
    expect(await readChunk(stale)).toMatchObject({
      index_status: 'skipped',
      updated_at: new Date(NOW),
    });
    expect(await readChunk(live)).toMatchObject({
      index_status: 'pending',
      updated_at: new Date(LIVE_CEILING.at),
    });
    // And the claim will not take either of them, which is what makes this
    // recovery the only way a row at the ceiling ever leaves `pending`.
    expect(claimedFor(await repository.claimDue(NOW, 10), tenantId)).toEqual([]);
  });

  it('names why it parked a row nothing recorded a failure for, and does not speak over one that did', async () => {
    const tenantId = await createTenant('reason');
    const silent = await seedChunk(tenantId, 'silent', {
      status: 'pending',
      attempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS,
      ...OLD_CEILING,
    });
    const recorded = await seedChunk(tenantId, 'recorded', {
      status: 'pending',
      attempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS,
      error: 'provider 502',
      ...OLD_CEILING,
    });

    expect(await repository.parkExhausted(NOW)).toBe(2);

    // A dead Worker leaves the row at the ceiling with nothing to say, so the
    // platform supplies the one sentence that is true of every such row. That is
    // the whole reason the column is filled rather than left NULL: 46% of one
    // tenant's slices were parked with no reason recorded, and the status query
    // that lists parked slices filters on this column, so those rows were not
    // merely unexplained — they were invisible.
    expect(await readChunk(silent)).toMatchObject({
      index_status: 'skipped',
      index_error: KNOWLEDGE_INDEX_PARKED_WITHOUT_REASON,
    });
    // A row that recorded a real failure keeps its words. The provider's reason
    // is a better account of this slice than any sentence this statement could
    // invent, and overwriting it would replace evidence with boilerplate.
    expect(await readChunk(recorded)).toMatchObject({
      index_status: 'skipped',
      index_error: 'provider 502',
    });
  });

  it('runs one tick end to end: the due slice is indexed, and the rest are left alone', async () => {
    const tenantId = await createTenant('tick');
    const due = await seedChunk(tenantId, 'due', { status: 'failed', ...ELAPSED_FAILURE });
    await seedChunk(tenantId, 'fresh', { status: 'failed', ...FRESH_FAILURE });
    await seedChunk(tenantId, 'indexed', { status: 'indexed', ...ELAPSED_FAILURE });
    await seedChunk(tenantId, 'parked', {
      ...ELAPSED_FAILURE,
      status: 'skipped',
      attempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS,
    });
    const ceiling = await seedChunk(tenantId, 'ceiling', {
      status: 'pending',
      attempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS,
      at: OLD_CEILING.at,
    });
    // The two rows this tick is *expected* to move, excluded from the
    // before/after comparison so that it is a strict assertion about the rest.
    const moved = [due, ceiling].map(String);
    const untouched = (rows: ReadonlyArray<Record<string, unknown>>) =>
      rows.filter((row) => !moved.includes(String(row['id'])));
    const dueContent = await contentOf(due);
    const before = untouched(await snapshot(tenantId));
    const provider = recordingProvider();

    const result = await buildProcessor(provider).runOnce();

    // The fake provider is asked exactly once, and the last thing it was asked is
    // the text of the one slice the predicate selected — the assertion the
    // block's acceptance criterion names.
    expect(provider.embedded).toEqual([dueContent]);
    expect(result).toEqual({
      claimed: 1,
      indexed: 1,
      failed: 0,
      parked: 0,
      recovered: 1,
      superseded: 0,
    });

    expect(await readChunk(due)).toMatchObject({
      index_status: 'indexed',
      index_attempts: 2,
      indexed_at: new Date(NOW),
    });
    expect(await listEmbeddings(due)).toHaveLength(1);
    // The recovery closed the ceiling row in the same tick, and every row the
    // predicate and the recovery both passed over is exactly what it was: same
    // status, same counter, same instants.
    expect((await readChunk(ceiling)).index_status).toBe('skipped');
    expect(untouched(await snapshot(tenantId))).toEqual(before);
    expect(await countEmbeddings(tenantId)).toBe(1);
  });

  it('changes nothing at all in a tick with no provider configured', async () => {
    const tenantId = await createTenant('noprovider');
    await seedChunk(tenantId, 'due', { status: 'failed', ...ELAPSED_FAILURE });
    await seedChunk(tenantId, 'fresh', { status: 'failed', ...FRESH_FAILURE });
    await seedChunk(tenantId, 'pending', { status: 'pending' });
    const before = await snapshot(tenantId);

    const result = await buildProcessor(undefined).runOnce();

    // The criterion is about the table, not about the counters: a gate that let
    // the claim run and merely skipped the embedding would leave the same
    // counters and a table full of slices at the attempt ceiling.
    expect(result).toEqual({
      claimed: 0,
      indexed: 0,
      failed: 0,
      parked: 0,
      recovered: 0,
      superseded: 0,
    });
    expect(await snapshot(tenantId)).toEqual(before);
    expect(await countEmbeddings(tenantId)).toBe(0);
  });

  it('indexes a due slice from the poller, not from a hand-called tick', async () => {
    const tenantId = await createTenant('loop');
    const due = await seedChunk(tenantId, 'loopdue', { status: 'failed', ...ELAPSED_FAILURE });
    const provider = recordingProvider();
    const processor = buildProcessor(provider, 5);

    expect(processor.running).toBe(false);
    processor.start();
    expect(processor.running).toBe(true);
    try {
      // The row is watched rather than the return value of a `runOnce` this case
      // called itself: the claim under test is that the *loop* moves it, and an
      // assertion about a tick this case drove would hold just as well with no
      // loop at all.
      expect(await waitUntil(async () => (await readChunk(due)).index_status === 'indexed')).toBe(
        true,
      );
    } finally {
      await processor.stop();
    }

    expect(processor.running).toBe(false);
    // This slice was embedded exactly once: the loop polled on, and the row it
    // had just indexed was not claimable a second time — a loop that re-claimed
    // its own work would call the provider again for the same text, and this is
    // the only case that can see that (the tick's own case cannot: it ticks once).
    //
    // The count is taken over this slice's text rather than over the whole list
    // because the claim is platform-wide and this run has left other cases' rows
    // due — the same narrowing the other cases do with `claimedFor`.
    const content = await contentOf(due);
    expect(provider.embedded.filter((text) => text === content)).toEqual([content]);
    expect(await readChunk(due)).toMatchObject({
      index_status: 'indexed',
      index_attempts: 2,
      indexed_at: new Date(NOW),
    });
    expect(await listEmbeddings(due)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Fixtures and readers
  // ---------------------------------------------------------------------------

  /**
   * The processor under test, wired to the real store and a fixed clock.
   *
   * The poll interval defaults to a value no case reaches: a case that runs the
   * loop names its own, so a suite that never starts one cannot poll by accident.
   */
  function buildProcessor(
    provider: EmbeddingProvider | undefined,
    pollIntervalMs = 60_000,
  ): ChunkIndexProcessor {
    return new ChunkIndexProcessor(repository, provider, {
      batchSize: 10,
      pollIntervalMs,
      now: () => NOW_MS,
    });
  }

  /** One tenant, unique to this run. */
  async function createTenant(label: string): Promise<string> {
    const tenantId = `tenant-sweep-${RUN}-${label}`;
    await database.query(
      'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
      [tenantId, `sweep-${RUN}-${label}`, '知识索引扫描测试租户', NOW],
    );
    tenants.push(tenantId);
    return tenantId;
  }

  /**
   * One slice, in the shape `PostgresChunkWriter` writes.
   *
   * Every column the writer sets is set here, so a seeded row is the same row a
   * pass of `indexSourceInto` would have produced — including `store_id` being
   * `NULL` with `scope_type = 'tenant'`, which `knowledge_chunks_scope_check`
   * requires and which is why this helper needs no store.
   */
  async function seedChunk(
    tenantId: string,
    label: string,
    options: {
      readonly status: 'pending' | 'indexed' | 'failed' | 'skipped';
      readonly attempts?: number;
      readonly at?: string;
      readonly enabled?: boolean;
      /**
       * What the row recorded as its last failure's reason. Left out by most
       * cases, which is the state a Worker that died mid-attempt leaves; the one
       * case that cares about a recorded reason passes it.
       */
      readonly error?: string | null;
    },
  ): Promise<string> {
    // `knowledge_chunks_pkey` is on `id` alone — the tenant is not part of it —
    // so the id has to carry the tenant to stay unique across this run's cases.
    const chunkId = `kchunk-${tenantId}-${label}`;
    const content = `测试切片文案 ${label}`;
    const at = options.at ?? NOW;
    await database.query(
      `INSERT INTO knowledge_chunks (
         id, tenant_id, store_id, scope_type, source_kind, source_id, source_field, chunk_type,
         chunk_index, content, context_before, context_after, char_count, enabled, content_hash,
         index_status, index_attempts, index_error, indexed_at, created_at, updated_at)
       VALUES ($1, $2, NULL, 'tenant', 'faq', $3, 'answer', 'answer',
               0, $4, NULL, NULL, $5, $6, $7,
               $8, $9, $13, $10, $11, $12)`,
      [
        chunkId,
        tenantId,
        `faq-sweep-${RUN}-${label}`,
        content,
        content.length,
        options.enabled ?? true,
        hashOf(`claim-${label}`),
        options.status,
        options.attempts ?? 0,
        options.status === 'indexed' ? at : null,
        at,
        at,
        options.error ?? null,
      ],
    );
    return chunkId;
  }

  /** One slice's index columns, read back from the table. */
  async function readChunk(chunkId: string): Promise<Record<string, unknown>> {
    const rows = await database.rows(
      `SELECT id, content, content_hash, index_status, index_attempts, index_error, indexed_at, updated_at
         FROM knowledge_chunks WHERE id = $1`,
      [chunkId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`test invariant: chunk ${chunkId} is not in the table`);
    }
    // `pg` hands back `Date` for `timestamptz`, which is what the matchers above
    // compare against; nothing is normalised, so the assertions are about the
    // values the driver returned.
    return row;
  }

  /** One slice's text, read back from the table. */
  async function contentOf(chunkId: string): Promise<string> {
    return String((await readChunk(chunkId))['content']);
  }

  /** Every slice's index columns for one tenant, in id order. */
  async function snapshot(
    tenantId: string,
    excluded: ReadonlyArray<string> = [],
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const rows = await database.rows(
      `SELECT id, index_status, index_attempts, index_error, indexed_at, updated_at
         FROM knowledge_chunks WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    );
    return rows.filter((row) => !excluded.includes(String(row['id'])));
  }

  /** Every vector row under one slice, in model order. */
  async function listEmbeddings(chunkId: string): Promise<ReadonlyArray<Record<string, unknown>>> {
    return database.rows(
      `SELECT id, embedding_model, embedding_dimensions, embedding::text AS embedding, content_hash
         FROM knowledge_chunk_embeddings WHERE chunk_id = $1 ORDER BY embedding_model`,
      [chunkId],
    );
  }

  /** How many vector rows one tenant has, counted by the table. */
  async function countEmbeddings(tenantId: string): Promise<number> {
    const rows = await database.rows(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunk_embeddings WHERE tenant_id = $1',
      [tenantId],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** Remove every row this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    for (const tenantId of tenants) {
      await database.query('DELETE FROM knowledge_chunk_embeddings WHERE tenant_id = $1', [
        tenantId,
      ]);
      await database.query('DELETE FROM knowledge_chunk_keywords WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM knowledge_chunks WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
  }
});

/** The database URL the suite runs against, resolved as the app resolves it. */
function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = parseAppConfig({ ...env, APP_ENV: 'test' });
  if (parsed._tag !== 'ok') {
    throw new Error(`test database configuration is invalid: ${parsed.error.message}`);
  }
  return parsed.config.databaseUrl.unwrap();
}

/**
 * Poll a real-database condition until it holds.
 *
 * The processor's clock is frozen at the tick instant, so the wall clock is the
 * only thing that can time a loop out — and a suite that waited forever on a loop
 * which never ticked would look exactly like a suite waiting on a slow database.
 *
 * @param check - The condition, read from the database each time.
 * @param timeoutMs - How long the loop gets before the case fails.
 * @returns Whether the condition came true within the timeout.
 */
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/**
 * The claim's answer, narrowed to one case's tenant; see the suite note.
 */
function claimedFor(
  claimed: ReadonlyArray<ClaimedChunk>,
  tenantId: string,
): ReadonlyArray<ClaimedChunk> {
  return claimed.filter((slice) => slice.tenantId === tenantId);
}

/** The content hash the seed helper uses for one label's slice. */
function hashOf(label: string): string {
  return `hash-${label}`;
}

/**
 * A provider that records the text it was asked to embed.
 *
 * The port takes the slice's text and nothing else — that is the rule its
 * signature states — so the record is a list of strings, and the case that uses
 * it asserts against the seeded row's own content rather than against a fixture
 * that could agree with itself.
 */
function recordingProvider(): EmbeddingProvider & { readonly embedded: string[] } {
  const embedded: string[] = [];
  return {
    model: MODEL,
    embedded,
    embed: (content) => {
      embedded.push(content);
      return Promise.resolve({ ok: true, vector: VECTOR });
    },
  };
}

/**
 * Drive one `database/scripts` entrypoint, exactly as a developer would.
 *
 * The URL travels through the child environment, never through its command line.
 */
function runDatabaseCommand(command: 'migrate', url: string): void {
  execFileSync(
    process.execPath,
    [path.resolve(process.cwd(), 'database/scripts/migrate.cjs'), command],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
  );
}

/**
 * Child-process program that answers "is the database up?" with its exit code.
 *
 * Built by a function rather than held in a module constant, because the suite
 * decides `describe.skipIf(...)` at the top of this file: a `const` declared down
 * here would still be in its temporal dead zone at that point, and the skip would
 * silently read as "no database" on a machine that has one.
 */
function reachabilityProbe(): string {
  return [
    "const { Client } = require('pg');",
    'const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });',
    'client',
    '  .connect()',
    "  .then(() => client.query('SELECT 1'))",
    '  .then(() => client.end())',
    '  .then(() => process.exit(0))',
    '  .catch(() => process.exit(1));',
  ].join('\n');
}

/**
 * Probe the database with a bounded round trip.
 *
 * Synchronous on purpose: the suite has to decide `describe.skipIf(...)` while
 * Vitest collects it, before any hook has run.
 */
function isDatabaseReachable(url: string): boolean {
  try {
    execFileSync(process.execPath, ['-e', reachabilityProbe()], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}
