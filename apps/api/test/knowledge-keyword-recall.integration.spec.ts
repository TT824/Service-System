import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseAppConfig,
  parseKnowledgeQuery,
  type AppConfig,
  type KeywordVocabularyEntry,
} from '@kefu/core';
import { DatabaseService } from '../src/database/database.service';
import {
  KNOWLEDGE_BM25_ATTRIBUTE_BOOST,
  KNOWLEDGE_KEYWORD_RECALL_TOP,
  type KeywordRecallHit,
} from '../src/retrieval/knowledge-keyword-recall';
import { PostgresKnowledgeKeywordRecall } from '../src/retrieval/postgres-knowledge-keyword-recall';
import {
  insertKnowledgeTerms,
  isDatabaseReachable,
  resolveDatabaseUrl,
  runDatabaseCommand,
} from './database-test-support';

/**
 * Integration tests for the keyword recall leg, against the real PostgreSQL the
 * platform targets.
 *
 * What can only be settled here is what a fake cannot show: that a slice whose
 * own text never spells the value is recalled by its keyword row, that the exact
 * leg does *not* answer with a near miss of the value asked for, that BM25 orders
 * two slices by how often they say the term, that the tenant and store boundaries
 * hold in the statement itself, and that the order of ties is decided by the
 * statement rather than by whichever plan PostgreSQL picked. Every one of those
 * failures is a wrong answer delivered calmly, which is why the rows are seeded
 * in the database and the counts are read back with `SELECT count(*)` rather than
 * inferred from what was inserted.
 *
 * The suite skips cleanly when no database is reachable, so `npm test` passes on
 * a machine without PostgreSQL. Every row it writes carries a per-run unique
 * identifier and is removed again in `afterAll`, so it never disturbs the seeded
 * directory or another run's rows.
 *
 * Two notes on this file's own plumbing:
 *
 * - **The slices are seeded with plain SQL.** Writing slices is the Worker's job
 *   (the API reads them, and `PlatformRepository` states that boundary), so
 *   seeding is test plumbing here rather than a production path the API does not
 *   have. The rows are written in the shape `0011` and the index writer produce,
 *   so what the recall reads is a row the indexer could have written.
 * - **The terms are derived, never hand-written.** `seedChunk` fills
 *   `knowledge_chunk_terms` through `insertKnowledgeTerms`, which derives them
 *   with the very function the index writer runs over a slice's text — so a case
 *   states what a slice's text *is* and the terms follow, exactly as they do in
 *   production. A fixture that spelled its own terms would let this file pass
 *   against a tokenizer no caller runs, and one that wrote no terms at all would
 *   turn every case below into an empty answer.
 * - **The query is always the kernel's.** Every case parses its question with
 *   `parseKnowledgeQuery` instead of hand-building the three buckets, so a test
 *   says what a buyer typed and the recall answers the parse the platform would
 *   really hand it.
 */

const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Unique suffix isolating this run's rows from every other run's. */
const RUN = randomUUID().slice(0, 8);

/** The size the vocabulary vouches for, as the buyer writes it and as it is stored. */
const SIZE_VOCABULARY: ReadonlyArray<KeywordVocabularyEntry> = [{ text: 'XL', kind: 'size' }];
/** The colour vocabulary, for the rejection case. */
const COLOR_VOCABULARY: ReadonlyArray<KeywordVocabularyEntry> = [{ text: '黑色', kind: 'color' }];

describe.skipIf(!reachable)('Knowledge keyword recall (PostgreSQL)', () => {
  let config: AppConfig;
  let database: DatabaseService;
  let pool: Pool;
  let recall: PostgresKnowledgeKeywordRecall;
  /** Tenants this run created, removed in `afterAll` in foreign-key order. */
  const tenants: string[] = [];

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
    recall = new PostgresKnowledgeKeywordRecall(database);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await cleanup();
      await database.onModuleDestroy();
    }
  });

  it('runs against a reachable database', () => {
    // Reported explicitly, so a skipped run is never mistaken for a passing one.
    expect(reachable).toBe(true);
  });

  it('answers with an exact attribute and not with a slice that merely contains it', async () => {
    const scope = await createScope('exact');
    await seedChunk(scope, 'xl', {
      content: '尺码：XL 加绒卫衣，建议按平时尺码选购。',
      keywords: [{ kind: 'size', text: 'XL' }],
    });
    await seedChunk(scope, 'xll', {
      content: '尺码：XLL 加绒卫衣，建议按平时尺码选购。',
      keywords: [{ kind: 'size', text: 'XLL' }],
    });

    // The premise is asserted, not assumed: the question really does become an
    // attribute and nothing else. Were `XL` left in the free-text bucket, the
    // substring leg would decide this case and the exactness would be untested.
    const query = parseKnowledgeQuery({ text: '有XL码吗', vocabulary: SIZE_VOCABULARY });
    expect(query.attributes).toEqual([{ kind: 'size', text: 'XL' }]);
    expect(query.keywords).toEqual([]);

    const hits = await recallHits(scope, '有XL码吗', SIZE_VOCABULARY);
    expect(hits.map((hit) => hit.chunk.id)).toEqual([chunkId('exact', 'xl')]);

    // The four things a retrieval result owes its caller, read off the row
    // rather than off the query: the slice and its provenance, the keyword that
    // matched, the leg it matched by, and the score.
    const hit = hits[0] as KeywordRecallHit;
    expect(hit.mode).toBe('keyword');
    // `XL` is a term in the slice's text as well as a key in its keyword table,
    // so both legs found it and both are reported — the caller is told *which*
    // halves answered, and a constraint satisfied is not the same evidence as a
    // word found. The exact half's own contribution is pinned in the case below,
    // where no token matches and the boost stands alone.
    expect(hit.matched).toEqual([
      { text: 'XL', kind: 'size', leg: 'bm25' },
      { text: 'XL', kind: 'size', leg: 'exact' },
    ]);
    // Strictly more than the boost, because the token `xl` weighed something on
    // top of it. The magnitude below the boost is BM25's and is not pinned here
    // (see the port's score note) — that it is there at all is what says both
    // halves of the statement ran.
    expect(hit.score).toBeGreaterThan(KNOWLEDGE_BM25_ATTRIBUTE_BOOST);
    expect(hit.chunk.tenantId).toBe(scope.tenantId);
    expect(hit.chunk.storeId).toBe(scope.storeId);
    expect(hit.chunk.scopeType).toBe('store');
    expect(hit.chunk.sourceKind).toBe('faq');
    expect(hit.chunk.sourceField).toBe('title');
    expect(hit.chunk.content).toContain('XL 加绒卫衣');

    // The instrument is checked before the result is trusted: `XLL` *is*
    // recallable — it is one ASCII run, so it is a term like any other — and its
    // absence above is therefore about the question that was asked rather than
    // about a slice that could never have been found at all.
    const control = await recallHits(scope, 'XLL');
    expect(control.map((entry) => entry.chunk.id)).toEqual([chunkId('exact', 'xll')]);
  });

  it('answers with a slice whose attribute only its keyword table names', async () => {
    const scope = await createScope('kw-only');
    // The slice's text says nothing about a size; only its keyword row does.
    // This is the clause that makes `exact_why` a *source* of candidates rather
    // than a scorer — BM25 can only weigh tokens that are in the text, so this
    // slice is recalled by an equality on `(kind, text)` or not at all.
    await seedChunk(scope, 'kw-only', {
      content: '本商品版型标准，建议按平时尺码选购。',
      keywords: [{ kind: 'size', text: 'XL' }],
    });
    await seedChunk(scope, 'plain', { content: '本商品为均码，建议参考尺码表。' });

    const hits = await recallHits(scope, '有XL码吗', SIZE_VOCABULARY);
    expect(hits.map((hit) => hit.chunk.id)).toEqual([chunkId('kw-only', 'kw-only')]);

    // Exactly the boost and nothing else, because no token matched: this pins
    // the attribute's own contribution rather than a sum that happens to contain
    // it, and it is the number the case above is greater than.
    expect(hits[0]?.score).toBe(KNOWLEDGE_BM25_ATTRIBUTE_BOOST);
    expect(hits[0]?.matched).toEqual([{ text: 'XL', kind: 'size', leg: 'exact' }]);
  });

  it('answers with free text the slice does not spell the way the buyer did', async () => {
    const scope = await createScope('bm25');
    await seedChunk(scope, 'hoodie', { content: '加绒卫衣加厚保暖不起球，秋冬内搭首选。' });
    await seedChunk(scope, 'jeans', { content: '直筒牛仔裤显瘦，高腰显腿长。' });
    await seedChunk(scope, 'denim', { content: 'Jeans 高腰牛仔裤，弹力面料。' });

    const hoodie = await recallHits(scope, '加绒卫衣');
    expect(hoodie.map((hit) => hit.chunk.id)).toEqual([chunkId('bm25', 'hoodie')]);
    // The query's term is reported, not the bigrams it was cut into: `绒卫` is an
    // artefact of the tokenizer, and explaining an answer with it would be
    // explaining the scorer rather than the answer.
    expect(hoodie[0]?.matched).toEqual([{ text: '加绒卫衣', kind: null, leg: 'bm25' }]);
    expect(hoodie[0]?.score).toBeGreaterThan(0);

    // ASCII is folded on both sides: the buyer's `jeans` finds the slice that
    // writes `Jeans`. This is the leg where case could have been silently lost.
    const denim = await recallHits(scope, 'jeans');
    expect(denim.map((hit) => hit.chunk.id)).toEqual([chunkId('bm25', 'denim')]);
  });

  it('answers with the slice that says a term twice above the one that says it once', async () => {
    const scope = await createScope('tf');
    // Two slices of the same length answering the same question, differing in one
    // thing: how many times the text says 「加绒」. Equal length means the length
    // normalisation is identical for both, so the term frequency is the only term
    // of the formula left to order them — and the ids run the *other* way round
    // on purpose, because the substring sum this leg replaced scored every
    // matching slice 1 and broke the tie by ascending id, which would have put
    // `a-once` first.
    await seedChunk(scope, 'z-twice', { content: '加绒卫衣，加绒加厚。' });
    await seedChunk(scope, 'a-once', { content: '加绒卫衣，加厚保暖。' });
    expect(await termFrequency(chunkId('tf', 'z-twice'), '加绒')).toBe(2);
    expect(await termFrequency(chunkId('tf', 'a-once'), '加绒')).toBe(1);

    const hits = await recallHits(scope, '加绒');
    expect(hits.map((hit) => hit.chunk.id)).toEqual([
      chunkId('tf', 'z-twice'),
      chunkId('tf', 'a-once'),
    ]);
  });

  it('answers with both legs at once, and puts the constraint above the word', async () => {
    const scope = await createScope('both');
    await seedChunk(scope, 'both', {
      content: '尺码：XL 加绒卫衣，加厚保暖。',
      keywords: [{ kind: 'size', text: 'XL' }],
    });
    await seedChunk(scope, 'exact', {
      content: '尺码：XL 牛仔外套，直筒版型。',
      keywords: [{ kind: 'size', text: 'XL' }],
    });
    await seedChunk(scope, 'word', { content: '加绒卫衣加厚保暖不起球。' });

    const query = parseKnowledgeQuery({ text: 'XL 加绒卫衣', vocabulary: SIZE_VOCABULARY });
    expect(query.attributes).toEqual([{ kind: 'size', text: 'XL' }]);
    expect(query.keywords).toEqual(['加绒卫衣']);

    const hits = await recallHits(scope, 'XL 加绒卫衣', SIZE_VOCABULARY);

    // A slice that satisfies the constraint outranks one that only contains the
    // word, and a slice that does both outranks either — which is the two halves'
    // whole job, since the fusion step will replace the numbers with ranks.
    expect(hits.map((hit) => hit.chunk.id)).toEqual([
      chunkId('both', 'both'),
      chunkId('both', 'exact'),
      chunkId('both', 'word'),
    ]);
    // What is asserted of the scores is that they strictly descend, which is the
    // one property the order above rests on. Their magnitudes are BM25's, which
    // the port's score note says is not a quantity anything may read.
    const [best, constrained, worded] = hits;
    expect(best?.score).toBeGreaterThan(constrained?.score as number);
    expect(constrained?.score).toBeGreaterThan(worded?.score as number);

    // Both legs are reported for the slice that gave both of them something, and
    // compared as a set: which of the two terms the statement aggregates first is
    // the database's collation, which is not a fact about the recall.
    expect(hits[0]?.matched).toHaveLength(3);
    expect(hits[0]?.matched).toEqual(
      expect.arrayContaining([
        { text: 'XL', kind: 'size', leg: 'exact' },
        { text: 'XL', kind: 'size', leg: 'bm25' },
        { text: '加绒卫衣', kind: null, leg: 'bm25' },
      ]),
    );
  });

  it('answers with this tenant only, though the other tenant has the same slice', async () => {
    const scope = await createScope('tenant-a');
    const other = await createScope('tenant-b');
    const content = '本店支持七天无理由退货，运费按平台规则处理。';
    // Both slices are tenant-level on purpose. The store rule admits a
    // tenant-level slice to every store of its tenant, so the *only* predicate
    // that can exclude the other tenant's row is the tenant's own — with a
    // store-level fixture, the store rule would exclude it and this case would
    // pass without the tenant filter existing at all.
    await seedChunk(scope, 'a', { storeId: null, content });
    await seedChunk(other, 'b', { storeId: null, content });

    // Both rows exist, so "the other tenant was not answered with" is a fact
    // about the statement rather than about a slice that was never written.
    expect(await countChunks(other.tenantId)).toBe(1);

    const hits = await recallHits(scope, '七天无理由退货');
    expect(hits.map((hit) => hit.chunk.id)).toEqual([chunkId('tenant-a', 'a')]);
  });

  it("answers with neither another store's slice nor another store's tenant-level one", async () => {
    const scope = await createScope('store');
    await seedChunk(scope, 'mine', { content: '加绒卫衣加厚保暖不起球。' });
    await seedChunk(scope, 'theirs', {
      storeId: scope.otherStoreId,
      content: '加绒卫衣加厚保暖不起球。',
    });

    const hits = await recallHits(scope, '加绒卫衣');
    expect(hits.map((hit) => hit.chunk.id)).toEqual([chunkId('store', 'mine')]);
  });

  it('answers with a tenant-level slice from any of its stores', async () => {
    const scope = await createScope('shared');
    await seedChunk(scope, 'shared', {
      storeId: null,
      content: '本店支持七天无理由退货，运费按平台规则处理。',
    });
    await seedChunk(scope, 'shared-rejected', {
      storeId: null,
      enabled: false,
      content: '本店支持七天无理由退货，运费按平台规则处理。',
    });

    const hits = await recallHits(scope, '七天无理由退货');
    // The tenant-level slice is recalled for a store that does not own it, and
    // the switched-off one is not: the usability rule reaches both scopes.
    expect(hits.map((hit) => hit.chunk.id)).toEqual([chunkId('shared', 'shared')]);
    expect(hits[0]?.chunk.storeId).toBe(null);
    expect(hits[0]?.chunk.scopeType).toBe('tenant');
  });

  it('answers from a slice whose keywords exist but whose vector does not yet', async () => {
    const scope = await createScope('pending');
    await seedChunk(scope, 'pending', {
      indexStatus: 'pending',
      content: '加绒卫衣加厚保暖不起球。',
      keywords: [{ kind: 'category', text: '卫衣' }],
    });

    // The keyword leg reads the text *through its terms*, and the writer derives
    // those in the same transaction as the row it writes; tying this leg to
    // `index_status = 'indexed'` would make keyword recall wait on the embedding
    // pipeline for evidence it already has.
    const hits = await recallHits(scope, '加绒卫衣');
    expect(hits.map((hit) => hit.chunk.id)).toEqual([chunkId('pending', 'pending')]);
  });

  it('does not answer with a slice carrying a value the buyer rejected', async () => {
    const scope = await createScope('negation');
    await seedChunk(scope, 'black', {
      content: '黑色加绒卫衣，加厚保暖。',
      keywords: [{ kind: 'color', text: '黑色' }],
    });
    await seedChunk(scope, 'white', {
      content: '白色加绒卫衣，加厚保暖。',
      keywords: [{ kind: 'color', text: '白色' }],
    });

    const rejected = parseKnowledgeQuery({
      text: '有加绒卫衣吗，不要黑色的',
      vocabulary: COLOR_VOCABULARY,
    });
    expect(rejected.negations).toEqual([{ kind: 'color', text: '黑色' }]);

    const hits = await recallHits(scope, '有加绒卫衣吗，不要黑色的', COLOR_VOCABULARY);
    expect(hits.map((hit) => hit.chunk.id)).toEqual([chunkId('negation', 'white')]);

    // The instrument again: without the rejection both slices are recalled, so
    // the black one is absent above because the buyer ruled it out.
    const control = await recallHits(scope, '有加绒卫衣吗');
    expect(control.map((hit) => hit.chunk.id).sort()).toEqual(
      [chunkId('negation', 'black'), chunkId('negation', 'white')].sort(),
    );
  });

  it('bounds the answer at twenty slices and breaks ties by slice id', async () => {
    const scope = await createScope('tied');
    // Twenty-five identical answers, written newest-id-first so that the order
    // PostgreSQL happens to read the rows in is not the order asserted below.
    const ids: string[] = [];
    for (let index = 24; index >= 0; index -= 1) {
      const label = `tied-${String(index).padStart(2, '0')}`;
      ids.push(chunkId('tied', label));
      await seedChunk(scope, label, {
        content: '藏青卫衣，加厚保暖。',
        keywords: [{ kind: 'color', text: '藏青' }],
      });
    }
    expect(await countChunks(scope.tenantId)).toBe(25);

    const hits = await recallHits(scope, '颜色：藏青');
    expect(hits.length).toBe(KNOWLEDGE_KEYWORD_RECALL_TOP);
    // Every score is equal, so the order below is the tie-breaker and nothing
    // else: ascending slice id, the first twenty of twenty-five.
    expect(hits.map((hit) => hit.chunk.id)).toEqual([...ids].sort().slice(0, 20));
  });

  it('honours the bound it was given, and answers nothing for a bound of zero', async () => {
    const scope = await createScope('bound');
    for (let index = 0; index < 4; index += 1) {
      await seedChunk(scope, `bound-${index}`, { content: `加绒卫衣加厚保暖，第${index}件。` });
    }

    const three = await recall.recall({
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      query: parseKnowledgeQuery({ text: '加绒卫衣' }),
      limit: 3,
    });
    expect(three.length).toBe(3);

    const none = await recall.recall({
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      query: parseKnowledgeQuery({ text: '加绒卫衣' }),
      limit: 0,
    });
    expect(none).toEqual([]);
  });

  /** One tenant with two stores, so "another store" is a real second store. */
  async function createScope(label: string): Promise<Scope> {
    const tenantId = `tenant-kr-${RUN}-${label}`;
    const storeId = `store-kr-${RUN}-${label}`;
    const otherStoreId = `store-kr-${RUN}-${label}-2`;
    const at = new Date().toISOString();
    await pool.query(
      'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
      [tenantId, `kr-${RUN}-${label}`, '关键词召回集成测试租户', at],
    );
    for (const [id, code] of [
      [storeId, 'main'],
      [otherStoreId, 'other'],
    ] as ReadonlyArray<readonly [string, string]>) {
      await pool.query(
        'INSERT INTO stores (id, tenant_id, code, name, enabled, created_at) VALUES ($1, $2, $3, $4, TRUE, $5)',
        [id, tenantId, code, '关键词召回集成测试门店', at],
      );
    }
    tenants.push(tenantId);
    return { tenantId, storeId, otherStoreId, label };
  }

  /** One slice, its keywords and its terms, in the shape the index writer stores them. */
  async function seedChunk(scope: Scope, label: string, fields: SeedChunk): Promise<void> {
    const id = chunkId(scope.label, label);
    const at = new Date().toISOString();
    const storeId = fields.storeId === undefined ? scope.storeId : fields.storeId;
    await pool.query(
      `INSERT INTO knowledge_chunks
         (id, tenant_id, store_id, scope_type, source_kind, source_id, source_field, chunk_type,
          chunk_index, content, char_count, enabled, content_hash, index_status, index_attempts,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'faq', $5, 'title', 'question', 0, $6, $7, $8, $9, $10, 0, $11, $11)`,
      [
        id,
        scope.tenantId,
        storeId,
        storeId === null ? 'tenant' : 'store',
        `faq-${id}`,
        fields.content,
        Array.from(fields.content).length,
        fields.enabled ?? true,
        createHash('sha256').update(fields.content).digest('hex'),
        fields.indexStatus ?? 'pending',
        at,
      ],
    );
    for (const [index, keyword] of (fields.keywords ?? []).entries()) {
      await pool.query(
        `INSERT INTO knowledge_chunk_keywords
           (id, tenant_id, chunk_id, keyword_kind, keyword_text, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [`${id}-kw-${index}`, scope.tenantId, id, keyword.kind, keyword.text, at],
      );
    }

    // The terms are the index side of this fixture, and the one part of it that
    // several suites need identically — see `insertKnowledgeTerms`.
    await insertKnowledgeTerms(pool, scope.tenantId, id, fields.content);
  }

  /** One slice's stored frequency for one term, read from the table. */
  async function termFrequency(id: string, term: string): Promise<number> {
    const rows = await pool.query<{ tf: number }>(
      'SELECT tf FROM knowledge_chunk_terms WHERE chunk_id = $1 AND term = $2',
      [id, term],
    );
    return rows.rows[0]?.tf ?? 0;
  }

  /** Recall one typed question, parsed by the kernel the platform uses. */
  async function recallHits(
    scope: Scope,
    text: string,
    vocabulary: ReadonlyArray<KeywordVocabularyEntry> = [],
  ): Promise<ReadonlyArray<KeywordRecallHit>> {
    return recall.recall({
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      query: parseKnowledgeQuery({ text, vocabulary }),
    });
  }

  /** How many slices one tenant has, read from the table rather than inferred. */
  async function countChunks(tenantId: string): Promise<number> {
    const rows = await pool.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunks WHERE tenant_id = $1',
      [tenantId],
    );
    return rows.rows[0]?.total ?? 0;
  }

  /** Remove every row this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    for (const tenantId of tenants) {
      await pool.query('DELETE FROM knowledge_chunk_keywords WHERE tenant_id = $1', [tenantId]);
      await pool.query('DELETE FROM knowledge_chunks WHERE tenant_id = $1', [tenantId]);
      await pool.query('DELETE FROM stores WHERE tenant_id = $1', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
  }
});

/** A tenant, the store being answered for, and a second store it also owns. */
type Scope = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly otherStoreId: string;
  /** The scope's label, so a seed can derive the same id a test names. */
  readonly label: string;
};

/** One slice to write, with the columns a recall cares about. */
type SeedChunk = {
  readonly content: string;
  readonly keywords?: ReadonlyArray<{ readonly kind: string; readonly text: string }>;
  /** `null` writes a tenant-level slice; omitted uses the scope's store. */
  readonly storeId?: string | null;
  readonly enabled?: boolean;
  readonly indexStatus?: string;
};

/**
 * The id of one seeded slice, derived so a test can name it before it exists.
 *
 * Unique across runs and across tenants: `knowledge_chunks.id` is the table's
 * primary key, not a per-tenant one.
 */
function chunkId(scopeLabel: string, label: string): string {
  return `chunk-kr-${RUN}-${scopeLabel}-${label}`;
}
