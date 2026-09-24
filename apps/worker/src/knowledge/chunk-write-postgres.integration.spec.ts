import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildKnowledgeIndex,
  parseAppConfig,
  planSourceChunkWrites,
  tokenizeKnowledgeText,
  type IndexSourceInput,
  type KnowledgeKeywordRow,
} from '@kefu/core';
import { WorkerDatabase } from '../database/worker-database';
import { indexSourceInto } from './chunk-writer';
import { PostgresChunkWriter } from './postgres-chunk-writer';
import { PostgresIndexSourceReader } from './postgres-index-source-reader';

/**
 * Integration tests for the index write path, against the real PostgreSQL the
 * platform targets.
 *
 * What can only be settled here is what the first pass cannot show: that writing
 * the same source twice **updates** the slices rather than duplicating them,
 * that an edit rewrites the slice in place and returns it to `pending`, and that
 * rewriting 黑色 as 白色 leaves no keyword claiming the chunk is black. Every one
 * of those failures is silent and only visible on a second pass, which is why
 * the count is read with `SELECT count(*)` rather than inferred from a return
 * value, and why the rows are read back rather than trusted.
 *
 * The suite skips cleanly when no database is reachable, so `npm test` still
 * passes on a machine without PostgreSQL; every row it writes carries a per-run
 * unique identifier and is removed again in `afterAll`, so it neither depends on
 * another run's rows nor disturbs them.
 *
 * Three notes on this file's own plumbing, because each looks like duplication:
 *
 * - **It does not import the API's test helpers.** A Worker test that reached
 *   into `apps/api` would make the two workspaces one workspace, which is the
 *   boundary the whole task exists to establish. The handful of lines that
 *   locate the database and drive the migration runner live here instead, as
 *   they do in the outbox suite; they are generic test plumbing that names no
 *   channel and no provider.
 * - **The source rows are seeded with plain SQL.** Seeding is not part of the
 *   Worker's contract (the API writes these rows in production), so it is
 *   written out here rather than given a production home it does not have.
 * - **The inputs are read back through the real reader.** The write path is
 *   driven by `PostgresIndexSourceReader` rather than by hand-built inputs, so
 *   this suite also settles the question the read block left open: what the
 *   mappers produce when the rows are real.
 * - **The term expectations come from the shared tokenizer.** The writer derives
 *   `0014`'s terms with `@kefu/core`'s `tokenizeKnowledgeText`, so comparing what
 *   is stored against that same function is an assertion about the *storage* —
 *   which slice a term landed on, how often it was counted, and whether the old
 *   text's terms were replaced rather than added to — and not about what a bigram
 *   is. One slice's terms are written out by hand as well, because a round trip
 *   that is merely self-consistent would survive a tokenizer that produced
 *   nothing at all.
 */

const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Unique suffix isolating this run's rows from every other run's. */
const RUN = randomUUID().slice(0, 8);

/** The question field: short enough to be exactly one slice. */
const QUESTION = '加绒卫衣怎么洗？';

/**
 * The answer field, as a list of sentences rather than one string.
 *
 * The length is the point. `chunkProse` returns a single slice for any field of
 * at most {@link KNOWLEDGE_CHUNK_MAX_CHARS} (500) characters and only then starts
 * packing sentences up to that ceiling, so an answer short enough to read as one
 * paragraph produces one slice — and a suite written against it would test
 * neither the update path nor the stale path, silently. The sentences below
 * total well over the ceiling, which is what makes "the answer is more than one
 * slice" a fact about the fixture rather than a hope.
 *
 * The edit used by two of the tests swaps 黑色 for 白色 inside one sentence: same
 * length, no punctuation moved, so the cut points cannot shift and every slice
 * keeps its id.
 */
const ANSWER_SENTENCES = [
  '加绒卫衣建议手洗，水温不要超过三十度，避免用力搓揉导致起球，也不要长时间浸泡，浸泡时间控制在十分钟以内，洗完请轻轻挤出水分。',
  '洗涤时加入少量中性洗涤剂即可，不要使用漂白剂和强碱性洗衣粉，也不要和深色衣物一起洗，以免浮色影响外观。',
  '洗完后请平铺阴干，不要用力拧干，也不要直接暴晒，阳光直射会让绒面变硬，晾晒到八成千时可以用手轻拍恢复蓬松。',
  '收纳前请确认衣物已经彻底干透，折叠平放即可，不要长期悬挂，长期悬挂容易让肩部变形，影响下一次穿着的版型。',
  '卫衣的面料是棉混纺，穿着柔软亲肤，内里加绒保暖，适合秋冬季节穿着，日常搭配牛仔裤和运动裤都很合适。',
  '如果你所在的地区气温较低，建议在卫衣里面加一件打底衫，外面搭配一件羽绒服，这样既保暖又不会显得臃肿。',
  '关于褪色问题，深色衣物第一次洗涤时可能会有轻微浮色，属于正常现象，用冷水单独洗一次即可，之后不会再出现。',
  '本款商品的商品颜色：黑色，尺码偏小，建议按平时尺码大一码选购，如果不确定可以咨询客服，我们会按你的身材给出建议。',
  '如果收到货后发现尺码不合适，可以在七天内申请换货，吊牌完整、不影响二次销售的衣物都可以办理，运费按平台规则处理。',
  '商品的吊牌和水洗标请保留到确认收货之后再剪，剪掉以后如果出现尺码或者质量问题，换货和退货都会比较麻烦。',
  '客服的工作时间是每天九点到晚上十点，其他时间留言也会在第二天上班后第一时间回复，请耐心等待一下。',
];
const ANSWER = ANSWER_SENTENCES.join('');

/** The one text the edit tests rewrite, and what they rewrite it to. */
const BLACK = '黑色';
const WHITE = '白色';

describe.skipIf(!reachable)('Worker knowledge index writes (PostgreSQL)', () => {
  let database: WorkerDatabase;
  let reader: PostgresIndexSourceReader;
  let writer: PostgresChunkWriter;
  /** Tenants this run created, removed in `afterAll` in foreign-key order. */
  const tenants: string[] = [];

  beforeAll(async () => {
    // Idempotent: a developer machine may already have the migrations applied.
    runDatabaseCommand('migrate', databaseUrl);
    database = new WorkerDatabase(databaseUrl);
    reader = new PostgresIndexSourceReader(database);
    writer = new PostgresChunkWriter(database);
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

  it('writes one row per derived slice, and no row before the write', async () => {
    const scope = await createScope('first');
    await seedFaq(scope, 'a', { question: QUESTION, answer: ANSWER });

    // The precondition is asserted, not assumed: "the count did not change"
    // means nothing without the count it started from.
    expect(await countChunks(scope.tenantId)).toBe(0);

    const input = await indexableFaq(scope, 'a');
    const plan = await indexSourceInto(writer, input);

    // The plan is the kernel's own statement of what this source produces, so
    // the database is asked to hold exactly that — no more rows, no fewer.
    expect(plan.plans.length).toBeGreaterThan(1);
    expect(plan.stale).toEqual([]);
    expect(await countChunks(scope.tenantId)).toBe(plan.plans.length);

    // Compared as sets, not as sequences: the kernel's order is field order and
    // the table's is id order, and a slice's id is a hash of its address rather
    // than of its position in the source.
    const stored = await listChunks(scope.tenantId);
    expect(stored.map((row) => String(row['id'])).sort()).toEqual(
      plan.plans.map((entry) => entry.id).sort(),
    );

    // Every stored slice carries the content the kernel derived, not a
    // placeholder: a write that inserted the right number of empty rows would
    // satisfy the count above.
    for (const row of stored) {
      const chunk = plan.plans.find((entry) => entry.id === row['id']);
      expect(chunk).toBeDefined();
      expect(String(row['content'])).not.toBe('');
      expect(row['index_status']).toBe('pending');
      expect(row['scope_type']).toBe('store');
      expect(row['enabled']).toBe(true);
    }

    // The write stores the derived hash rather than recomputing one, so an
    // embedding later knows exactly which text it describes. The slices are
    // re-ordered by their position before being joined: the read is by id, and
    // an id is a hash of the address rather than of the position.
    const answerSlices = stored
      .filter((row) => row['source_field'] === 'answer')
      .sort((left, right) => Number(left['chunk_index']) - Number(right['chunk_index']));
    expect(answerSlices.length).toBeGreaterThan(1);
    expect(answerSlices.map((row) => row['content']).join('')).toBe(ANSWER);
    expect(answerSlices.map((row) => Number(row['chunk_index']))).toEqual(
      answerSlices.map((_, index) => index),
    );
  });

  it('updates the same rows on a second pass instead of adding more', async () => {
    const scope = await createScope('twice');
    await seedFaq(scope, 'b', { question: QUESTION, answer: ANSWER });

    const input = await indexableFaq(scope, 'b');
    await indexSourceInto(writer, input);
    const first = await listChunks(scope.tenantId);
    expect(first.length).toBeGreaterThan(0);

    // The instants are set to a sentinel first, so "was it rewritten?" is asked
    // of the row itself rather than of a clock the test cannot control.
    await database.query(
      `UPDATE knowledge_chunks SET created_at = $2, updated_at = $2 WHERE tenant_id = $1`,
      [scope.tenantId, SENTINEL],
    );

    // Re-read the source row, so the second pass is a full pass and not a
    // replay of the first pass's inputs.
    await indexSourceInto(writer, await indexableFaq(scope, 'b'));

    const second = await listChunks(scope.tenantId);
    // The failure this guards against is an insert: it is silent, it succeeds,
    // and the row count is the only place it shows.
    expect(second.length).toBe(first.length);
    expect(second.map((row) => row['id'])).toEqual(first.map((row) => row['id']));

    for (const row of second) {
      // A reindex is not a birth: the row keeps its id and its first-write
      // instant. It keeps its *last*-write instant too, and that is the part
      // worth naming: `updated_at` is the retry backoff's only anchor, and
      // re-anchoring it belongs to the claim that spends an attempt. A sweep that
      // refreshed it on every pass would push every slice's next attempt into the
      // future for ever — which is how a tenant's slices were once parked without
      // a single provider call.
      expect(Date.parse(String(row['created_at']))).toBe(Date.parse(SENTINEL));
      expect(Date.parse(String(row['updated_at']))).toBe(Date.parse(SENTINEL));
    }
    // The children are not duplicated either, though they are re-attached.
    expect(await countKeywords(scope.tenantId)).toBe(await countKeywordsFor(first));

    // The terms are not *duplicated* — they are not written at all, because no
    // slice's text moved and the term table is a function of that text. Asserted
    // as an equality rather than as a non-zero count because the failure it
    // guards against is a delete that ran outside that condition: that would
    // empty the table on this pass and refill it only on a pass that rewrites
    // something, which no later pass here does.
    const terms = await countTermsFor(first);
    expect(terms).toBeGreaterThan(0);
    expect(await countTermsFor(second)).toBe(terms);
  });

  it('rewrites content on a pass that re-indexes nothing, and touches no index column', async () => {
    const scope = await createScope('anchor');
    await seedFaq(scope, 'f', { question: QUESTION, answer: ANSWER });
    await indexSourceInto(writer, await indexableFaq(scope, 'f'));

    // The rows are made to look like slices a provider gave up on, with content
    // that has drifted from the source it came from. Both are things a pass has
    // to be able to correct *without* owning the index columns.
    await database.query(
      `UPDATE knowledge_chunks
          SET index_status = 'failed', index_attempts = 3, index_error = 'provider 502',
              indexed_at = $2, updated_at = $2, enabled = false, content = 'stale'
        WHERE tenant_id = $1`,
      [scope.tenantId, SENTINEL],
    );

    await indexSourceInto(writer, await indexableFaq(scope, 'f'));

    const after = await listChunks(scope.tenantId);
    expect(after.length).toBeGreaterThan(0);
    for (const row of after) {
      // Content is this pass's to write, and it is written: the drifted text is
      // replaced from the source and a switched-off copy is switched back on.
      expect(String(row['content'])).not.toBe('stale');
      expect(row['enabled']).toBe(true);
      // Index state is the claim's and the outcome's, and this pass leaves all
      // of it as it found it — including the reason, which the sweep used to wipe
      // on every pass, and the anchor, which it used to push forward.
      expect(row['index_status']).toBe('failed');
      expect(Number(row['index_attempts'])).toBe(3);
      expect(row['index_error']).toBe('provider 502');
      expect(Date.parse(String(row['updated_at']))).toBe(Date.parse(SENTINEL));
    }
  });

  it('rewrites an edited slice in place, back to pending with a fresh budget', async () => {
    const scope = await createScope('edit');
    await seedFaq(scope, 'c', { question: QUESTION, answer: ANSWER });
    await indexSourceInto(writer, await indexableFaq(scope, 'c'));

    const before = await listChunks(scope.tenantId);
    const edited = before.find((row) => String(row['content']).includes(BLACK));
    expect(edited).toBeDefined();

    // A slice that had spent attempts has to be distinguishable from one that
    // never tried: the budget is set to a spent value, with the reason a real
    // failure would have recorded, before the edit.
    await database.query(
      `UPDATE knowledge_chunks
          SET index_status = 'failed', index_attempts = 3, index_error = 'provider 502',
              indexed_at = $2
        WHERE tenant_id = $1`,
      [scope.tenantId, SENTINEL],
    );

    await database.query('UPDATE faqs SET answer = $2 WHERE id = $1', [
      faqId('c'),
      ANSWER.replace(BLACK, WHITE),
    ]);
    await indexSourceInto(writer, await indexableFaq(scope, 'c'));

    const after = await listChunks(scope.tenantId);
    // The edit is two characters inside one sentence, so the slice count is
    // unchanged and every id is unchanged — which is what makes this a test of
    // updating rather than of re-cutting.
    expect(after.map((row) => row['id'])).toEqual(before.map((row) => row['id']));

    const rewritten = after.find((row) => row['id'] === edited?.['id']);
    expect(rewritten).toBeDefined();
    expect(rewritten?.['content_hash']).not.toBe(edited?.['content_hash']);
    expect(String(rewritten?.['content'])).toContain(WHITE);
    // `0011` keeps the vector in a child table and the hash on the slice; a
    // slice whose text moved must be re-embeddable, which means pending.
    expect(rewritten?.['index_status']).toBe('pending');
    // The previous failures were about text that no longer exists, so the budget
    // starts over rather than continuing toward the ceiling — and it starts at
    // **zero**, because the count records attempts the *claim* spent, and no claim
    // has been asked about this text yet.
    expect(Number(rewritten?.['index_attempts'])).toBe(0);
    // An instant with no current vector behind it must not survive the rewrite,
    // and neither does a reason that described text which is gone.
    expect(rewritten?.['indexed_at']).toBeNull();
    expect(rewritten?.['index_error']).toBeNull();

    // The slices that did not change were still written — and their index state
    // was **not**. Asserted on one of them, because a write that only touched the
    // edited slice would pass everything above, and so would one that reset every
    // row's budget: this is the assertion the 46%-parked incident is about.
    const untouched = after.find((row) => row['id'] !== edited?.['id']);
    expect(untouched).toBeDefined();
    expect(untouched?.['index_status']).toBe('failed');
    expect(Number(untouched?.['index_attempts'])).toBe(3);
    expect(untouched?.['index_error']).toBe('provider 502');
  });

  it('drops the keyword the new text no longer produces', async () => {
    const scope = await createScope('keyword');
    await seedFaq(scope, 'd', { question: QUESTION, answer: ANSWER });
    await indexSourceInto(writer, await indexableFaq(scope, 'd'));

    // The fixture must actually produce keywords, or everything below is vacuous.
    const black = await listKeywords(scope.tenantId, BLACK);
    expect(black.length).toBeGreaterThan(0);
    expect(black[0]?.['keyword_kind']).toBe('color');
    const chunkId = String(black[0]?.['chunk_id']);
    const keywordsBefore = await countKeywordsFor(await listChunks(scope.tenantId));
    expect(keywordsBefore).toBeGreaterThan(0);

    await database.query('UPDATE faqs SET answer = $2 WHERE id = $1', [
      faqId('d'),
      ANSWER.replace(BLACK, WHITE),
    ]);
    await indexSourceInto(writer, await indexableFaq(scope, 'd'));

    // The new keyword is attached to the same slice: the slice kept its id, so
    // "add the new keyword" alone would leave the chunk described by both.
    expect((await listKeywords(scope.tenantId, BLACK)).length).toBe(0);
    const white = await listKeywords(scope.tenantId, WHITE);
    expect(white.length).toBe(1);
    expect(white[0]?.['chunk_id']).toBe(chunkId);

    const keywordsAfter = await countKeywords(scope.tenantId);
    expect(keywordsAfter).toBeLessThanOrEqual(keywordsBefore);
    expect(keywordsAfter).toBeGreaterThan(0);
  });

  it('writes the terms its text produces, and replaces them when the text moves', async () => {
    const scope = await createScope('terms');
    await seedFaq(scope, 'g', { question: QUESTION, answer: ANSWER });
    await indexSourceInto(writer, await indexableFaq(scope, 'g'));

    const stored = await listChunks(scope.tenantId);
    expect(stored.length).toBeGreaterThan(1);

    // The question is short enough to be exactly one slice, so its terms can be
    // written out by hand. This is the assertion that says the *encoding* is
    // right: bigrams of the Chinese, no punctuation and no partial pair at the
    // 「？」, and one row per distinct term.
    const question = stored.find((row) => row['source_field'] === 'question');
    expect(question).toBeDefined();
    expect([...(await storedTerms(String(question?.['id'])))].sort()).toEqual(
      [
        ['加绒', 1],
        ['绒卫', 1],
        ['卫衣', 1],
        ['衣怎', 1],
        ['怎么', 1],
        ['么洗', 1],
      ].sort(),
    );

    // Every slice holds exactly the tokens of its *own* text, counted with
    // multiplicity. One assertion, three failures: a term attached to the wrong
    // slice (the insert is three parallel arrays), a slice whose terms were never
    // written, and a `tf` that counted distinct terms instead of occurrences.
    const heldByItsText = async (): Promise<void> => {
      for (const row of await listChunks(scope.tenantId)) {
        expect(await storedTerms(String(row['id']))).toEqual(countedTokens(String(row['content'])));
      }
    };
    await heldByItsText();

    // The edit the other tests use, on the one sentence that says 黑色.
    const black = await listTermRows(scope.tenantId, BLACK);
    expect(black.length).toBe(1);
    const edited = String(black[0]?.['chunk_id']);
    const others = await countTermsFor(stored.filter((row) => String(row['id']) !== edited));

    await database.query('UPDATE faqs SET answer = $2 WHERE id = $1', [
      faqId('g'),
      ANSWER.replace(BLACK, WHITE),
    ]);
    await indexSourceInto(writer, await indexableFaq(scope, 'g'));

    // The slice keeps its id — the cut points cannot move — so the old colour's
    // terms have nowhere else to go. A term left behind here is a slice the
    // keyword leg would answer 「黑色」 with for ever.
    expect((await listTermRows(scope.tenantId, BLACK)).length).toBe(0);
    const white = await listTermRows(scope.tenantId, WHITE);
    expect(white.length).toBe(1);
    expect(white[0]?.['chunk_id']).toBe(edited);

    // Replaced rather than accumulated, and the untouched slices' terms are not
    // collateral: the delete is scoped to the slices this pass wrote.
    await heldByItsText();
    expect(await countTermsFor(stored.filter((row) => String(row['id']) !== edited))).toBe(others);
  });

  it('leaves no half-written source behind when one statement fails', async () => {
    const scope = await createScope('atomic');
    await seedFaq(scope, 'e', { question: QUESTION, answer: ANSWER });

    const input = await indexableFaq(scope, 'e');
    const rows = buildKnowledgeIndex(input);
    const plan = planSourceChunkWrites(rows.chunks, []);
    // The fixture has to have slices and keywords, or the rollback below is
    // proved on an empty transaction and proves nothing.
    expect(rows.chunks.length).toBeGreaterThan(1);
    expect(rows.keywords.length).toBeGreaterThan(0);

    // A keyword pointing at a slice that does not exist. Its foreign key rejects
    // it, and it is written *after* every slice upsert — so if the statements
    // were not one transaction, the slices would already be committed and the
    // source would be left with text indexed and no keywords describing it.
    const orphan: KnowledgeKeywordRow = {
      id: 'kkw-atomic-probe',
      tenantId: scope.tenantId,
      chunkId: 'kchunk-atomic-probe-missing',
      keywordKind: 'color',
      keywordText: '原子性探针',
    };

    await expect(
      writer.writeSourceChunks({
        address: {
          tenantId: scope.tenantId,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
        },
        chunks: rows.chunks,
        plans: plan.plans,
        keywords: [...rows.keywords, orphan],
        stale: [],
      }),
    ).rejects.toThrow();

    // Read from the table, not from the failure: "it threw" and "nothing was
    // written" are different claims, and only the second one is the contract.
    expect(await countChunks(scope.tenantId)).toBe(0);
    expect(await countKeywords(scope.tenantId)).toBe(0);
    // And neither are the terms those slices would have carried, which the same
    // transaction would have written had it survived.
    expect(await countTerms(scope.tenantId)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Fixtures and readers
  // ---------------------------------------------------------------------------

  /** One tenant and one store, both unique to this run. */
  async function createScope(label: string): Promise<Scope> {
    const tenantId = `tenant-kw-${RUN}-${label}`;
    const storeId = `store-kw-${RUN}-${label}`;
    const at = nowIso();
    await database.query(
      'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
      [tenantId, `kw-${RUN}-${label}`, '知识索引集成测试租户', at],
    );
    await database.query(
      'INSERT INTO stores (id, tenant_id, code, name, enabled, created_at) VALUES ($1, $2, $3, $4, TRUE, $5)',
      [storeId, tenantId, 'main', '知识索引集成测试门店', at],
    );
    tenants.push(tenantId);
    return { tenantId, storeId };
  }

  /** One FAQ row, in the shape the API writes. */
  async function seedFaq(
    scope: Scope,
    label: string,
    fields: { question: string; answer: string },
  ): Promise<void> {
    const at = nowIso();
    await database.query(
      `INSERT INTO faqs (id, tenant_id, store_id, question, answer, tags, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '{}', TRUE, $6, $6)`,
      [faqId(label), scope.tenantId, scope.storeId, fields.question, fields.answer, at],
    );
  }

  /** The input the read path maps for one FAQ, as the job receives it. */
  async function indexableFaq(scope: Scope, label: string): Promise<IndexSourceInput> {
    const id = faqId(label);
    const input = (await reader.listIndexSources(scope.tenantId)).find(
      (candidate) => candidate.sourceId === id,
    );
    if (input === undefined) {
      throw new Error(`test invariant: no index source was mapped for faq ${id}`);
    }
    return input;
  }

  /** Every stored slice of one tenant, in id order. */
  async function listChunks(tenantId: string): Promise<ReadonlyArray<Record<string, unknown>>> {
    return database.rows('SELECT * FROM knowledge_chunks WHERE tenant_id = $1 ORDER BY id', [
      tenantId,
    ]);
  }

  /** How many slices one tenant has, read from the table rather than inferred. */
  async function countChunks(tenantId: string): Promise<number> {
    const rows = await database.rows(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunks WHERE tenant_id = $1',
      [tenantId],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** How many keyword rows one tenant has. */
  async function countKeywords(tenantId: string): Promise<number> {
    const rows = await database.rows(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunk_keywords WHERE tenant_id = $1',
      [tenantId],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** How many keyword rows hang off the given slices. */
  async function countKeywordsFor(chunks: ReadonlyArray<Record<string, unknown>>): Promise<number> {
    const rows = await database.rows(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunk_keywords WHERE chunk_id = ANY($1::text[])',
      [chunks.map((row) => String(row['id']))],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** Every keyword row carrying one text, across the whole tenant. */
  async function listKeywords(
    tenantId: string,
    text: string,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    return database.rows(
      'SELECT * FROM knowledge_chunk_keywords WHERE tenant_id = $1 AND keyword_text = $2',
      [tenantId, text],
    );
  }

  /** How many term rows one tenant has. */
  async function countTerms(tenantId: string): Promise<number> {
    const rows = await database.rows(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunk_terms WHERE tenant_id = $1',
      [tenantId],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** How many term rows hang off the given slices. */
  async function countTermsFor(chunks: ReadonlyArray<Record<string, unknown>>): Promise<number> {
    const rows = await database.rows(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunk_terms WHERE chunk_id = ANY($1::text[])',
      [chunks.map((row) => String(row['id']))],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** Every term row of one tenant carrying one term. */
  async function listTermRows(
    tenantId: string,
    term: string,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    return database.rows(
      'SELECT * FROM knowledge_chunk_terms WHERE tenant_id = $1 AND term = $2',
      [tenantId, term],
    );
  }

  /** One slice's stored terms and their frequencies, read from the table. */
  async function storedTerms(chunkId: string): Promise<Map<string, number>> {
    const rows = await database.rows(
      'SELECT term, tf FROM knowledge_chunk_terms WHERE chunk_id = $1',
      [chunkId],
    );
    return new Map(rows.map((row) => [String(row['term']), Number(row['tf'])]));
  }

  /** Remove every row this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    for (const tenantId of tenants) {
      await database.query('DELETE FROM knowledge_chunk_keywords WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM knowledge_chunks WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM faq_question_variants WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM faqs WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM stores WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
  }
});

/** A tenant and the one store its FAQ belongs to. */
type Scope = { readonly tenantId: string; readonly storeId: string };

/**
 * A fixed instant in the past, written into rows so that "the write refreshed
 * this column" is a comparison against a value the test chose.
 */
const SENTINEL = '2001-01-01T00:00:00.000Z';

/** The id of one seeded FAQ, derived so a test can name it before it exists. */
function faqId(label: string): string {
  return `faq-kw-${RUN}-${label}`;
}

/**
 * How many times each token appears in one text.
 *
 * The shape `knowledge_chunk_terms` stores — one entry per distinct term, holding
 * its frequency and not a flag — so it can be compared against a slice's stored
 * rows directly.
 */
function countedTokens(content: string): Map<string, number> {
  const counted = new Map<string, number>();
  for (const token of tokenizeKnowledgeText(content)) {
    counted.set(token, (counted.get(token) ?? 0) + 1);
  }
  return counted;
}

/** Current instant, so durable timestamps are realistic. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Resolve the database the tests should talk to.
 *
 * Uses the same parser the Worker's entry point uses, so a test follows
 * `DATABASE_URL` when it is set and otherwise the documented local default.
 */
function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = parseAppConfig({ ...env, APP_ENV: 'test' });
  if (parsed._tag !== 'ok') {
    throw new Error(`test database configuration is invalid: ${parsed.error.message}`);
  }
  return parsed.config.databaseUrl.unwrap();
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
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    },
  );
}

/**
 * Child-process program that answers "is the database up?" with its exit code.
 *
 * Built by a function rather than held in a module constant, because the suite
 * decides `describe.skipIf(...)` at the top of this file: a `const` declared
 * down here would still be in its temporal dead zone at that point, and the
 * skip would silently read as "no database" on a machine that has one.
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
