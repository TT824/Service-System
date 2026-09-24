import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FetchEmbeddingHttpClient,
  OllamaEmbeddingProvider,
  deriveEmbeddingId,
  hashChunkContent,
  parseAppConfig,
  parseKnowledgeQuery,
  type AppConfig,
  type EmbeddingProvider,
  type KeywordVocabularyEntry,
} from '@kefu/core';
import { DatabaseService } from '../src/database/database.service';
import {
  KNOWLEDGE_SEMANTIC_RECALL_TOP,
  NO_EMBEDDING_PROVIDER_CODE,
  type SemanticRecallResult,
} from '../src/retrieval/knowledge-semantic-recall';
import { PostgresKnowledgeKeywordRecall } from '../src/retrieval/postgres-knowledge-keyword-recall';
import { PostgresKnowledgeSemanticRecall } from '../src/retrieval/postgres-knowledge-semantic-recall';
import {
  insertKnowledgeTerms,
  isDatabaseReachable,
  resolveDatabaseUrl,
  runDatabaseCommand,
} from './database-test-support';

/**
 * Integration tests for the semantic recall leg, against the real PostgreSQL and
 * the real model server the platform targets.
 *
 * What can only be settled here is what neither a fake database nor a fake
 * provider can show: that a vector stored by the *real* index writer's shape is
 * found by cosine distance and ranked the way a paraphrase needs, that the model
 * name and the content hash in the join are what keep a stale or foreign vector
 * out of the answer, and that the scope and rejection rules hold in the statement
 * the API will really run.
 *
 * **The vectors are real.** Each seeded slice is embedded by the model server
 * before it is inserted, and the case that first uses one asserts the stored width
 * and model name back out of the table — a fixture written with a two-number
 * vector would pass every rank assertion about a question whose answer it does not
 * describe, which is the same "green for the wrong reason" shape this project has
 * been bitten by before.
 *
 * **Both legs run in one case, on one question.** The promise that the two legs
 * cannot disagree — a slice the keyword leg refuses may not come back through this
 * one — is the only claim in this file that cannot be settled against this file
 * alone. So one case parses a question with the kernel, hands the same rejection to
 * both legs, and asserts they refuse the same slice; a real parse rather than an
 * array the test wrote for itself, because what the two legs share is the kernel's
 * reading of the question, not a constant either of them chose.
 *
 * **The model server is a precondition, not a skip condition.** The suite skips
 * when no database is reachable, because a machine without PostgreSQL is an
 * expected development machine. The model is different: it is *this suite's
 * subject*, and a run that skipped because no model was up would be a green line
 * that means nothing. So its absence is a failing case, with the two commands that
 * fix it in the message.
 *
 * The slices are seeded with plain SQL — writing slices is the Worker's job and
 * the API reads them — in the shape `0011` and the index writer produce, ids
 * included: `deriveEmbeddingId` is the kernel's own derivation, so the rows here
 * are the rows a reindex would have written.
 */

const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** The model server the run embeds with, and the model it must report. */
const OLLAMA_URL = 'http://127.0.0.1:11434';
const MODEL = 'qwen3-embedding:0.6b';

/** The width the criteria name, from the model itself; see the probe below. */
const MODEL_DIMENSIONS = 1024;

/** A second model name, used to write a vector this leg must not search with. */
const OTHER_MODEL = 'embedding-elsewhere-v1';

/**
 * A colour vocabulary, so a question that rules a colour out parses to a rejection.
 *
 * The kernel is told which colours this tenant sells; without it, 黑色 is a
 * free-text term and neither leg would have a colour to refuse.
 */
const COLOR_VOCABULARY: ReadonlyArray<KeywordVocabularyEntry> = [{ text: '黑色', kind: 'color' }];

/** Unique suffix isolating this run's rows from every other run's. */
const RUN = randomUUID().slice(0, 8);

const ollama = probeOllama();

describe.skipIf(!reachable)('Knowledge semantic recall (PostgreSQL + a real model server)', () => {
  let config: AppConfig;
  let database: DatabaseService;
  let pool: Pool;
  let provider: EmbeddingProvider;
  let recall: PostgresKnowledgeSemanticRecall;
  /** Tenants this run created, removed in `afterAll` in foreign-key order. */
  const tenants: string[] = [];
  /** The content of every slice this run seeded, by id, so the embedder can read it. */
  const seeded = new Map<string, string>();

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
    // The provider is built from this suite's constants rather than from the
    // environment: `.env` names the model a *developer* runs, and a test that
    // silently embedded with a different one would be measuring the environment.
    provider = new OllamaEmbeddingProvider(new FetchEmbeddingHttpClient(), {
      baseUrl: OLLAMA_URL,
      model: MODEL,
      timeoutMs: 30_000,
    });
    recall = new PostgresKnowledgeSemanticRecall(database, provider);
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

  it('runs against a reachable model server that has the configured model', () => {
    // The failure of this case is the whole suite's precondition, so it says what
    // to do rather than just going red: `ollama serve` and `ollama pull`.
    expect(
      ollama.reachable ? ollama.models : `the model server is not answering at ${OLLAMA_URL}`,
    ).toContain(MODEL);
  });

  it('answers a question and its rephrasing with the same slice, closest first', async () => {
    const scope = await createScope('paraphrase');
    await seedChunk(scope, 'warm', { content: '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和。' });
    await seedChunk(scope, 'care', {
      content: '羽绒服洗涤说明：建议干洗，不要机洗，避免高温烘干。',
    });
    await seedChunk(scope, 'shoes', { content: '这双运动鞋轻便透气，适合长跑和日常通勤。' });
    await embedChunk(scope, 'warm');
    await embedChunk(scope, 'care');
    await embedChunk(scope, 'shoes');

    // The instrument is checked before the result is trusted: the stored row is a
    // real vector of this model, not a fixture that merely looks like one.
    const stored = await embeddingRow(scope, 'warm');
    expect(stored?.embedding_model).toBe(MODEL);
    expect(stored?.embedding_dimensions).toBe(MODEL_DIMENSIONS);
    expect(await dimensionsOf(scope, 'warm')).toBe(MODEL_DIMENSIONS);

    // Two questions that share no wording and mean the same thing. Both must come
    // back with the slice about warmth, and not with the one that merely shares
    // the words 羽绒服 with the second question.
    const first = await recallHits(scope, '冬天穿这件衣服冷不冷');
    const second = await recallHits(scope, '这件羽绒服保暖吗');

    expect(first.hits[0]?.chunk.id).toBe(chunkId('paraphrase', 'warm'));
    expect(second.hits[0]?.chunk.id).toBe(chunkId('paraphrase', 'warm'));

    // The four things a retrieval result owes its caller, plus the mode that says
    // which leg produced it.
    const hit = first.hits[0];
    expect(hit?.mode).toBe('semantic');
    expect(hit?.score).toBeGreaterThan(-1.0001);
    expect(hit?.score).toBeLessThanOrEqual(1.0001);
    expect(hit?.chunk.tenantId).toBe(scope.tenantId);
    expect(hit?.chunk.storeId).toBe(scope.storeId);
    expect(hit?.chunk.scopeType).toBe('store');
    expect(hit?.chunk.sourceField).toBe('title');
    expect(hit?.chunk.content).toContain('白鸭绒');

    // Closest first: the reported similarities do not increase down the list.
    const scores = first.hits.map((entry) => entry.score);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });

  it('still answers a question that carries a customer’s own data, after that data is redacted', async () => {
    const scope = await createScope('pii');
    await seedChunk(scope, 'change', {
      content: '修改手机号：在「我的」-「账号设置」里点更换手机号，输入新号并完成短信验证即可。',
    });
    await seedChunk(scope, 'shipping', { content: '发货时间：付款后 48 小时内发出，节假日顺延。' });
    await embedChunk(scope, 'change');
    await embedChunk(scope, 'shipping');

    // The question as a customer actually writes it, personal data included. It
    // is masked before the vector is computed (see the redaction at the query
    // call site), so this vector is not the one the raw text would have had.
    const hits = await recallHits(scope, '我的手机号 13812345678 怎么改');

    // What this asserts is that the masking is not *destructive*: the words that
    // carry the meaning survive it and the right slice still comes first. It does
    // not measure how much the ranking moved — that needs a comparison against
    // the unredacted text, which belongs on block 5's evaluation set rather than
    // in a suite that would have to guess at the answer to make it.
    expect(hits.hits[0]?.chunk.id).toBe(chunkId('pii', 'change'));
  });

  it('answers with this tenant only, however alike the other tenant’s knowledge is', async () => {
    const scope = await createScope('tenant-a');
    const other = await createScope('tenant-b');
    const content = '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和。';
    await seedChunk(scope, 'mine', { content, storeId: null });
    await seedChunk(other, 'theirs', { content, storeId: null });
    await embedChunk(scope, 'mine');
    await embedChunk(other, 'theirs');

    // Both slices carry the target text and both are real vectors, so the other
    // tenant's row is recallable — by its own tenant. Its absence below is the
    // tenant predicate's doing, not a slice that could never have been found.
    const mine = await recallHits(scope, '这件羽绒服保暖吗');
    expect(mine.hits.map((hit) => hit.chunk.id)).toEqual([chunkId('tenant-a', 'mine')]);

    const theirs = await recallHits(other, '这件羽绒服保暖吗');
    expect(theirs.hits.map((hit) => hit.chunk.id)).toEqual([chunkId('tenant-b', 'theirs')]);
  });

  it('answers with this store’s slices and its tenant-level ones, and no other store’s', async () => {
    const scope = await createScope('store');
    await seedChunk(scope, 'mine', { content: '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和。' });
    await seedChunk(scope, 'theirs', {
      content: '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和。',
      storeId: scope.otherStoreId,
    });
    await seedChunk(scope, 'shared', {
      content: '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和。',
      storeId: null,
    });
    await embedChunk(scope, 'mine');
    await embedChunk(scope, 'theirs');
    await embedChunk(scope, 'shared');

    const hits = await recallHits(scope, '这件羽绒服保暖吗');
    expect(hits.hits.map((hit) => hit.chunk.id).sort()).toEqual(
      [chunkId('store', 'mine'), chunkId('store', 'shared')].sort(),
    );
    // The other store's slice is a real vector of the same text, written by the
    // same run: it is excluded by the scope rule, and this asserts it exists.
    expect(await countChunks(scope.tenantId)).toBe(3);
  });

  it('answers only with slices that hold a vector of the model it is querying with', async () => {
    const scope = await createScope('model');
    const content = '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和。';
    await seedChunk(scope, 'elsewhere', { content });
    await seedChunk(scope, 'unembedded', { content });
    await seedChunk(scope, 'ours', { content });
    await embedChunk(scope, 'ours');
    // The same text under a *different* model name, with a vector that is not this
    // model's answer to it (reversed, so a query that used it would rank it last
    // while still returning it). Distance between two models' vectors describes
    // nothing, which is why the row is addressed by its model.
    await embedChunk(scope, 'elsewhere', { model: OTHER_MODEL, reverse: true });

    const hits = await recallHits(scope, '这件羽绒服保暖吗');
    expect(hits.hits.map((hit) => hit.chunk.id)).toEqual([chunkId('model', 'ours')]);
    // Both excluded slices exist and one of them was embedded: the exclusion is
    // the join's, not an empty table's.
    expect(await countEmbeddings(scope.tenantId)).toBe(2);
  });

  it('refuses a vector whose slice text has been rewritten since it was computed', async () => {
    const scope = await createScope('stale');
    const content = '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和。';
    await seedChunk(scope, 'stale', { content });
    await seedChunk(scope, 'fresh', { content });
    await embedChunk(scope, 'fresh');
    // The vector of the text as it was *before* an edit: the slice has been
    // rewritten since, so the vector describes a text that is no longer there.
    await embedChunk(scope, 'stale', {
      contentHash: hashChunkContent('这款羽绒服是很早以前写的那一版文案。'),
    });

    const hits = await recallHits(scope, '这件羽绒服保暖吗');
    expect(hits.hits.map((hit) => hit.chunk.id)).toEqual([chunkId('stale', 'fresh')]);
    // The refused row is a real vector of the same width under the same model, so
    // the hash in the join is the only thing that could have excluded it.
    expect(await countEmbeddings(scope.tenantId)).toBe(2);
  });

  it('does not answer with a slice carrying a value the buyer rejected', async () => {
    const scope = await createScope('negation');
    await seedChunk(scope, 'black', {
      content: '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和，黑色现货。',
      keywords: [{ kind: 'color', text: '黑色' }],
    });
    await seedChunk(scope, 'white', {
      content: '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和，白色现货。',
      keywords: [{ kind: 'color', text: '白色' }],
    });
    await embedChunk(scope, 'black');
    await embedChunk(scope, 'white');

    const rejected = await recallHits(scope, '想要暖和的羽绒服', { negations: ['黑色'] });
    expect(rejected.hits.map((hit) => hit.chunk.id)).toEqual([chunkId('negation', 'white')]);

    // The control: the same question without the rejection answers both, so the
    // absence above is the filter's and not a slice the model never ranked.
    const control = await recallHits(scope, '想要暖和的羽绒服');
    expect(control.hits.map((hit) => hit.chunk.id).sort()).toEqual(
      [chunkId('negation', 'black'), chunkId('negation', 'white')].sort(),
    );
  });

  it('refuses the same slice as the keyword leg when the buyer rejects a value', async () => {
    const scope = await createScope('crossleg');
    // Two slices that differ in one word — the colour — so a question that names
    // the colour ranks the rejected one highest, which is the only arrangement in
    // which "the two legs agree" is worth asserting.
    await seedChunk(scope, 'black', {
      content: '保暖羽绒服，黑色现货，填充90%白鸭绒，零下十度穿着也很暖和。',
      keywords: [{ kind: 'color', text: '黑色' }],
    });
    await seedChunk(scope, 'white', {
      content: '保暖羽绒服，白色现货，填充90%白鸭绒，零下十度穿着也很暖和。',
      keywords: [{ kind: 'color', text: '白色' }],
    });
    await embedChunk(scope, 'black');
    await embedChunk(scope, 'white');

    const question = '保暖羽绒服，不要黑色的';
    const parsed = parseKnowledgeQuery({ text: question, vocabulary: COLOR_VOCABULARY });
    // The premise, asserted rather than assumed: the question parses to a rejection
    // of 黑色 *and* to a term both slices answer. Were the rejection left in the
    // free-text bucket, neither leg would filter anything and this case would be
    // measuring the parser rather than the two legs' agreement.
    expect(parsed.negations).toEqual([{ kind: 'color', text: '黑色' }]);
    expect(parsed.keywords).toEqual(['保暖羽绒服']);

    // One question, one rejection: this leg is handed the rejected values as the
    // kernel parsed them, the keyword leg the parse itself — the shapes their ports
    // take, since this leg filters and the other one searches.
    const keywordRecall = new PostgresKnowledgeKeywordRecall(database);
    const semantic = await recallHits(scope, question, {
      negations: parsed.negations.map((negation) => negation.text),
    });
    const keyword = await keywordRecall.recall({
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      query: parsed,
    });

    expect(semantic.hits.map((hit) => hit.chunk.id)).toEqual([chunkId('crossleg', 'white')]);
    expect(keyword.map((hit) => hit.chunk.id)).toEqual([chunkId('crossleg', 'white')]);

    // The control, on both legs: the same question with the rejection withheld. The
    // black slice comes back on both — so its absence above is the filter's and not
    // a slice either model failed to rank. This is the assertion the file exists
    // for: two retrievers that refuse *different* slices answer one question with
    // two different truths, and it looks exactly like a difference of opinion.
    const semanticControl = await recallHits(scope, question);
    expect(semanticControl.hits.map((hit) => hit.chunk.id).sort()).toEqual(
      [chunkId('crossleg', 'black'), chunkId('crossleg', 'white')].sort(),
    );
    const keywordControl = await keywordRecall.recall({
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      query: parseKnowledgeQuery({ text: '保暖羽绒服' }),
    });
    expect(keywordControl.map((hit) => hit.chunk.id).sort()).toEqual(
      [chunkId('crossleg', 'black'), chunkId('crossleg', 'white')].sort(),
    );
  });

  it('does not answer with a slice that is switched off, however close it is', async () => {
    const scope = await createScope('disabled');
    // Identical text, so the two slices' vectors are the same vector and the
    // switched-off one would sort *first* — `off` precedes `on` by slice id, which
    // is the tie-break. Its absence is therefore the `enabled` predicate's and
    // nothing else's.
    await seedChunk(scope, 'on', { content: '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和。' });
    await seedChunk(scope, 'off', {
      content: '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和。',
      enabled: false,
    });
    await embedChunk(scope, 'on');
    await embedChunk(scope, 'off');

    // The row is there and it is embedded, read off the tables rather than
    // assumed: a slice whose vector was never written would be absent for a
    // different reason, and this case would pass either way.
    expect(await countChunks(scope.tenantId)).toBe(2);
    expect(await countEmbeddings(scope.tenantId)).toBe(2);

    const hits = await recallHits(scope, '这件羽绒服保暖吗');
    expect(hits.hits.map((hit) => hit.chunk.id)).toEqual([chunkId('disabled', 'on')]);
  });

  it('breaks ties by slice id, so the first twenty mean one thing', async () => {
    const scope = await createScope('tied');
    const ids: string[] = [];
    // Identical content is the only way to get identical distances from a real
    // model: five slices whose vectors are the same vector.
    for (const label of ['t3', 't1', 't5', 't2', 't4']) {
      ids.push(chunkId('tied', label));
      await seedChunk(scope, label, { content: '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和。' });
      await embedChunk(scope, label);
    }

    const hits = await recallHits(scope, '这件羽绒服保暖吗', { limit: 3 });
    expect(hits.hits.map((hit) => hit.chunk.id)).toEqual([...ids].sort().slice(0, 3));
    // The premise, asserted rather than assumed: the vectors really do tie, so the
    // order above is the tie-break's and not a distance that happened to be smaller.
    const distinct = await pool.query<{ total: number }>(
      `SELECT COUNT(DISTINCT embedding::text)::int AS total
         FROM knowledge_chunk_embeddings WHERE tenant_id = $1`,
      [scope.tenantId],
    );
    expect(distinct.rows[0]?.total).toBe(1);
  });

  it('honours the bound it was given, and answers nothing for a bound of zero', async () => {
    const scope = await createScope('bound');
    for (let index = 0; index < 5; index += 1) {
      await seedChunk(scope, `bound-${index}`, {
        content: `第${index}件羽绒服的介绍：填充90%白鸭绒，零下十度穿着也很暖和。`,
      });
      await embedChunk(scope, `bound-${index}`);
    }

    const bounded = await recallHits(scope, '这件羽绒服保暖吗', { limit: 3 });
    expect(bounded.hits).toHaveLength(3);
    expect(bounded.unavailable).toBeNull();

    // The default is the design's, and it is what the fusion step will consume.
    const byDefault = await recallHits(scope, '这件羽绒服保暖吗');
    expect(byDefault.hits).toHaveLength(5);
    expect(KNOWLEDGE_SEMANTIC_RECALL_TOP).toBe(20);

    const none = await recallHits(scope, '这件羽绒服保暖吗', { limit: 0 });
    expect(none).toEqual({ hits: [], unavailable: null });
  });

  it('answers nothing, with a reason, when the deployment has configured no model', async () => {
    const scope = await createScope('nomodel');
    await seedChunk(scope, 'warm', { content: '这款羽绒服填充90%白鸭绒，零下十度穿着也很暖和。' });
    await embedChunk(scope, 'warm');

    // The same slices, the same statement, no provider: a deployment state the API
    // has to serve rather than crash on.
    const gated = new PostgresKnowledgeSemanticRecall(database, undefined);
    const result = await gated.recall({
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      text: '这件羽绒服保暖吗',
      negations: [],
    });

    expect(result.hits).toEqual([]);
    expect(result.unavailable?.code).toBe(NO_EMBEDDING_PROVIDER_CODE);
    // And a provider that exists still answers, so "no provider" is the gate and
    // not the fixture's absence.
    const answered = await recallHits(scope, '这件羽绒服保暖吗');
    expect(answered.hits).toHaveLength(1);
  });

  /** One tenant with two stores, so "another store" is a real second store. */
  async function createScope(label: string): Promise<Scope> {
    const tenantId = `tenant-sr-${RUN}-${label}`;
    const storeId = `store-sr-${RUN}-${label}`;
    const otherStoreId = `store-sr-${RUN}-${label}-2`;
    const at = new Date().toISOString();
    await pool.query(
      'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
      [tenantId, `sr-${RUN}-${label}`, '语义召回集成测试租户', at],
    );
    for (const [id, code] of [
      [storeId, 'main'],
      [otherStoreId, 'other'],
    ] as ReadonlyArray<readonly [string, string]>) {
      await pool.query(
        'INSERT INTO stores (id, tenant_id, code, name, enabled, created_at) VALUES ($1, $2, $3, $4, TRUE, $5)',
        [id, tenantId, code, '语义召回集成测试门店', at],
      );
    }
    tenants.push(tenantId);
    return { tenantId, storeId, otherStoreId, label };
  }

  /** One slice and its keywords, in the shape the index writer stores them. */
  async function seedChunk(scope: Scope, label: string, fields: SeedChunk): Promise<void> {
    const id = chunkId(scope.label, label);
    seeded.set(id, fields.content);
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

    // This suite is about the *other* leg, but two of its cases hold the keyword
    // leg against it — a slice seeded without terms is invisible to that leg, and
    // the comparison would come out "the semantic leg is the only one that
    // answers" for a reason that has nothing to do with either of them.
    await insertKnowledgeTerms(pool, scope.tenantId, id, fields.content);
  }

  /**
   * Embed one seeded slice with the real model and store the vector.
   *
   * The row is written the way the index writer writes it — the id from the
   * kernel's own `deriveEmbeddingId`, the width read off the vector, the hash of
   * the text it described — so what the recall reads is a row the sweep could have
   * produced. The alternatives are the two this suite exists to catch: an override
   * for the hash (a vector of text the slice no longer holds) and another model
   * name (a vector this leg must not search with).
   */
  async function embedChunk(
    scope: Scope,
    label: string,
    overrides: {
      readonly model?: string;
      readonly contentHash?: string;
      readonly reverse?: boolean;
    } = {},
  ): Promise<void> {
    const model = overrides.model ?? MODEL;
    const id = chunkId(scope.label, label);
    const content = seededContent(id);
    const embedded = await provider.embed(content);
    if (!embedded.ok) {
      throw new Error(`the model server did not embed a fixture: ${embedded.reason}`);
    }
    const vector = overrides.reverse === true ? [...embedded.vector].reverse() : embedded.vector;
    await pool.query(
      `INSERT INTO knowledge_chunk_embeddings
         (id, tenant_id, chunk_id, embedding_model, embedding_dimensions, embedding, content_hash,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
       ON CONFLICT (tenant_id, chunk_id, embedding_model) DO UPDATE SET
         embedding_dimensions = EXCLUDED.embedding_dimensions,
         embedding = EXCLUDED.embedding,
         content_hash = EXCLUDED.content_hash`,
      [
        deriveEmbeddingId(scope.tenantId, id, model),
        scope.tenantId,
        id,
        model,
        vector.length,
        `[${vector.join(',')}]`,
        overrides.contentHash ?? hashChunkContent(content),
        new Date().toISOString(),
      ],
    );
  }

  /** Recall one question, with the rejected values and the bound the case needs. */
  async function recallHits(
    scope: Scope,
    text: string,
    options: { readonly negations?: ReadonlyArray<string>; readonly limit?: number } = {},
  ): Promise<SemanticRecallResult> {
    return recall.recall({
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      text,
      negations: options.negations ?? [],
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  /** The vector row one seeded slice holds, read back from the table. */
  async function embeddingRow(
    scope: Scope,
    label: string,
  ): Promise<{ embedding_model: string; embedding_dimensions: number } | undefined> {
    const rows = await pool.query<{ embedding_model: string; embedding_dimensions: number }>(
      `SELECT embedding_model, embedding_dimensions FROM knowledge_chunk_embeddings
        WHERE tenant_id = $1 AND chunk_id = $2 AND embedding_model = $3`,
      [scope.tenantId, chunkId(scope.label, label), MODEL],
    );
    return rows.rows[0];
  }

  /** The width pgvector itself reports for one stored vector. */
  async function dimensionsOf(scope: Scope, label: string): Promise<number | undefined> {
    const rows = await pool.query<{ dimensions: number }>(
      `SELECT vector_dims(embedding)::int AS dimensions FROM knowledge_chunk_embeddings
        WHERE tenant_id = $1 AND chunk_id = $2`,
      [scope.tenantId, chunkId(scope.label, label)],
    );
    return rows.rows[0]?.dimensions;
  }

  /** How many slices one tenant has, read from the table rather than inferred. */
  async function countChunks(tenantId: string): Promise<number> {
    const rows = await pool.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunks WHERE tenant_id = $1',
      [tenantId],
    );
    return rows.rows[0]?.total ?? 0;
  }

  /** How many vectors one tenant has, read from the table rather than inferred. */
  async function countEmbeddings(tenantId: string): Promise<number> {
    const rows = await pool.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunk_embeddings WHERE tenant_id = $1',
      [tenantId],
    );
    return rows.rows[0]?.total ?? 0;
  }

  /** The text a seeded slice holds, so an embedding can be computed for it. */
  function seededContent(id: string): string {
    const content = seeded.get(id);
    if (content === undefined) {
      throw new Error(`no seeded slice for ${id}`);
    }
    return content;
  }

  /** Remove every row this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    for (const tenantId of tenants) {
      await pool.query('DELETE FROM knowledge_chunk_embeddings WHERE tenant_id = $1', [tenantId]);
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
  return `chunk-sr-${RUN}-${scopeLabel}-${label}`;
}

/** The model server's own answer to "which models do you have", asked once. */
function probeOllama(): { readonly reachable: boolean; readonly models: ReadonlyArray<string> } {
  try {
    // Asked in a child process so the probe can be synchronous at module scope
    // (the shape `apps/worker`'s embedding suite uses) and so a server that
    // accepts a connection and then stalls cannot hold this file's collection open.
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        [
          `fetch('${OLLAMA_URL}/api/tags', { signal: AbortSignal.timeout(3000) })`,
          '  .then((response) => response.json())',
          '  .then((body) => { console.log(JSON.stringify((body.models || []).map((m) => m.name))); })',
          '  .catch(() => process.exit(1));',
        ].join('\n'),
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );
    return { reachable: true, models: JSON.parse(output) as string[] };
  } catch {
    return { reachable: false, models: [] };
  }
}
