import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildKnowledgeIndex,
  parseAppConfig,
  type IndexSourceInput,
  type IndexedSourceKind,
} from '@kefu/core';
import { WorkerDatabase } from '../database/worker-database';
import { indexSourceInto } from './chunk-writer';
import { PostgresChunkWriter } from './postgres-chunk-writer';
import { PostgresIndexSourceReader } from './postgres-index-source-reader';

/**
 * One source row's whole life in the index, against the real PostgreSQL.
 *
 * `chunk-write-postgres.integration.spec.ts` settles what one pass does: that
 * slices land where the kernel says, that a second pass updates them, that an
 * edit returns them to `pending`, that a keyword the new text no longer produces
 * goes away, and that a source whose keywords fail to write is rolled back
 * whole. This suite walks the same source through the two states that suite
 * cannot reach, and it is deliberately a second file rather than more cases in
 * the first: what is under test here is the *sequence*, where each state is
 * produced by the pass before it rather than seeded.
 *
 * - **A field that got shorter** (class 4). The kernel derives fewer slices, so
 *   the extra ones have to stop existing — and the keyword rows hanging off them
 *   have to go with them, through the foreign key's `ON DELETE CASCADE` rather
 *   than through a second delete statement that would have to know what a slice
 *   owns. What makes this silent is that the leftover slice still answers
 *   customers, from text its source no longer contains.
 * - **A source that stopped being indexable** (class 5). A deleted row is never
 *   read again, so nothing revisits its slices; a switched-off row *is* read, and
 *   its copied `enabled` has to be corrected by the next pass — which is the
 *   whole reason the read path filters on nothing but the tenant.
 *
 * Classes 1–3 restate the first, second and third cases of the write suite in
 * this file's own terms. That is duplication on purpose and not an oversight: the
 * acceptance criterion for this block is five classes, each of which must be able
 * to go red on its own, and a class that only exists in another file is not
 * evidence this file produces. Where the two disagree, the write suite is the one
 * that was written first; neither may be relaxed to make the other pass.
 *
 * Four notes on the plumbing, which is the write suite's and is copied for the
 * same reasons:
 *
 * - **It does not import the API's test helpers.** A Worker test reaching into
 *   `apps/api` would make the two workspaces one workspace, which is the boundary
 *   the whole task exists to establish.
 * - **Rows are seeded with plain SQL.** Seeding is not part of the Worker's
 *   contract — the API writes these rows in production — so it is written out
 *   here rather than given a production home it does not have.
 * - **The inputs are read back through the real reader.** Every pass is driven by
 *   `PostgresIndexSourceReader`, so what the mappers produce for real rows is part
 *   of what this suite settles, and no fixture can quietly disagree with the
 *   mapper it is standing in for.
 * - **The suite skips when no database is reachable**, and says so out loud in
 *   its first case: `npm test` has to pass on a machine without PostgreSQL, and a
 *   skipped run must never be read as a passing one. Every row it writes carries
 *   a per-run identifier and is removed in `afterAll`.
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
 * The length is the point, and it was measured rather than guessed: the kernel
 * cuts this list into two slices — 476 characters then 104 — so "the answer is
 * more than one slice" is a fact about the fixture, and the second slice is the
 * one class 4 removes. A single-slice answer would leave both the update path and
 * the stale path untested, silently.
 *
 * The last sentence carries the one labelled pair these sentences produce
 * ({@link BLACK}, as a colour), and it is last on purpose: the cut that shortens
 * the field is a cut off the end, so the slice that disappears is the slice that
 * owns the keyword. Move it earlier and class 4's cascade would be asserted over
 * a slice with nothing hanging off it.
 */
const ANSWER_SENTENCES = [
  '加绒卫衣建议手洗，水温不要超过三十度，避免用力搓揉导致起球，也不要长时间浸泡，浸泡时间控制在十分钟以内，洗完请轻轻挤出水分。',
  '洗涤时加入少量中性洗涤剂即可，不要使用漂白剂和强碱性洗衣粉，也不要和深色衣物一起洗，以免浮色影响外观。',
  '洗完后请平铺阴干，不要用力拧干，也不要直接暴晒，阳光直射会让绒面变硬，晾晒到八成千时可以用手轻拍恢复蓬松。',
  '收纳前请确认衣物已经彻底干透，折叠平放即可，不要长期悬挂，长期悬挂容易让肩部变形，影响下一次穿着的版型。',
  '卫衣的面料是棉混纺，穿着柔软亲肤，内里加绒保暖，适合秋冬季节穿着，日常搭配牛仔裤和运动裤都很合适。',
  '如果你所在的地区气温较低，建议在卫衣里面加一件打底衫，外面搭配一件羽绒服，这样既保暖又不会显得臃肿。',
  '关于褪色问题，深色衣物第一次洗涤时可能会有轻微浮色，属于正常现象，用冷水单独洗一次即可，之后不会再出现。',
  '如果收到货后发现尺码不合适，可以在七天内申请换货，吊牌完整、不影响二次销售的衣物都可以办理，运费按平台规则处理。',
  '商品的吊牌和水洗标请保留到确认收货之后再剪，剪掉以后如果出现尺码或者质量问题，换货和退货都会比较麻烦。',
  '客服的工作时间是每天九点到晚上十点，其他时间留言也会在第二天上班后第一时间回复，请耐心等待一下。',
  '本款商品的商品颜色：黑色，尺码偏小，建议按平时尺码大一码选购，如果不确定可以咨询客服，我们会按你的身材给出建议。',
];
const ANSWER = ANSWER_SENTENCES.join('');

/**
 * The same field after the edit that shortens it: two sentences, 113 characters,
 * one slice. Both sentences are ones the full answer already contains, so the
 * surviving slice keeps its address and its id — a shortened field is a cut, not
 * a rewrite, and the difference is what lets class 4 ask about ids rather than
 * about counts alone.
 */
const SHORT_ANSWER = ANSWER_SENTENCES.slice(0, 2).join('');

/** The one text the edit rewrites, and what it rewrites it to. */
const BLACK = '黑色';
const WHITE = '白色';

describe.skipIf(!reachable)('Worker knowledge index lifecycle (PostgreSQL)', () => {
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

  it('writes one row per derived slice on the first pass, one set per field', async () => {
    const scope = await createScope('first');
    await seedFaq(scope, 'a', { question: QUESTION, answer: ANSWER });

    // The count a comparison starts from is asserted, not assumed: "the rows are
    // exactly what the kernel said" means nothing without the empty table it
    // started from.
    expect(await countChunks(scope.tenantId)).toBe(0);

    const input = await indexableFaq(scope, 'a');
    const rows = buildKnowledgeIndex(input);
    // The fixture has to span more than one slice in more than one field, or
    // "one row per derived slice" is a claim about a single row.
    expect(rows.chunks.length).toBeGreaterThan(1);
    expect([...new Set(rows.chunks.map((chunk) => chunk.sourceField))].sort()).toEqual([
      'answer',
      'question',
    ]);

    await indexSourceInto(writer, input);

    // Read with `SELECT count(*)` rather than inferred from the plan the write
    // returned: a plan and a write can disagree, and only the table is the
    // contract. `0011`'s slice-unique constraint makes this the row count of the
    // kernel's own statement of what the source produces — no more, no fewer.
    expect(await countChunks(scope.tenantId)).toBe(rows.chunks.length);

    const stored = await listChunks(scope.tenantId);
    // Compared as sets, not as sequences: the kernel's order is field order and
    // the table's is id order, and a slice's id is a hash of its address rather
    // than of its position in the source.
    expect(stored.map((row) => String(row['id'])).sort()).toEqual(
      rows.chunks.map((chunk) => chunk.id).sort(),
    );

    for (const row of stored) {
      const derived = rows.chunks.find((chunk) => chunk.id === row['id']);
      expect(derived).toBeDefined();
      // The hash, not just the text: an embedding later is described by this
      // column, so a row whose hash describes some other text is a row that would
      // be re-embedded from the wrong input.
      expect(String(row['content_hash'])).toBe(derived?.contentHash);
      expect(String(row['content'])).not.toBe('');
      expect(row['index_status']).toBe('pending');
      expect(row['enabled']).toBe(true);
    }
  });

  it('updates the same rows on a second pass without adding one, and without moving the anchor', async () => {
    const scope = await createScope('again');
    await seedFaq(scope, 'b', { question: QUESTION, answer: ANSWER });
    await indexSourceInto(writer, await indexableFaq(scope, 'b'));

    const first = await listChunks(scope.tenantId);
    expect(first.length).toBeGreaterThan(0);

    // The instants are written to a sentinel first, so "was it rewritten?" is
    // asked of the row rather than of a clock the test cannot control.
    await database.query(
      `UPDATE knowledge_chunks SET created_at = $2, updated_at = $2 WHERE tenant_id = $1`,
      [scope.tenantId, SENTINEL],
    );

    // The source is re-read, so the second pass is a full pass and not a replay
    // of the first pass's inputs.
    await indexSourceInto(writer, await indexableFaq(scope, 'b'));

    const second = await listChunks(scope.tenantId);
    // The failure this guards against is an insert. It is silent, it succeeds,
    // and the row count is the only place it shows — which is why it is asked of
    // `SELECT count(*)` as well as of the rows read back.
    expect(await countChunks(scope.tenantId)).toBe(first.length);
    expect(second.length).toBe(first.length);
    expect(second.map((row) => String(row['id']))).toEqual(first.map((row) => String(row['id'])));

    for (const row of second) {
      // A reindex is not a birth: the row keeps its id and its first-write
      // instant. It keeps its *last*-write instant too, and that is the part worth
      // naming here: `updated_at` is the retry backoff's only anchor and the
      // `enabled` correction is not measured from it, so a pass that changed no
      // index state has nothing to re-anchor. The claim owns that write, because
      // the claim is what spends an attempt.
      expect(Date.parse(String(row['created_at']))).toBe(Date.parse(SENTINEL));
      expect(Date.parse(String(row['updated_at']))).toBe(Date.parse(SENTINEL));
    }
  });

  it('returns an edited slice to pending with a fresh budget, without moving its id', async () => {
    const scope = await createScope('edit');
    await seedFaq(scope, 'c', { question: QUESTION, answer: ANSWER });
    await indexSourceInto(writer, await indexableFaq(scope, 'c'));

    const before = await listChunks(scope.tenantId);
    const edited = before.find((row) => String(row['content']).includes(BLACK));
    expect(edited).toBeDefined();

    // A slice that had spent attempts has to be distinguishable from one that
    // never tried: the budget is spent before the edit, with the reason a real
    // failure records, so a pass that left the counter alone would be visible.
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
    const plan = await indexSourceInto(writer, await indexableFaq(scope, 'c'));

    const after = await listChunks(scope.tenantId);
    // The edit is two characters inside one sentence, so the slice count is
    // unchanged and every id is unchanged — which is what makes this a test of
    // updating rather than of re-cutting.
    expect(await countChunks(scope.tenantId)).toBe(before.length);
    expect(after.map((row) => String(row['id']))).toEqual(before.map((row) => String(row['id'])));
    // Nothing disappeared, and the state machine has to say so: a stale list that
    // named the edited slice would delete the row this test then reads.
    expect(plan.stale).toEqual([]);

    const rewritten = after.find((row) => String(row['id']) === String(edited?.['id']));
    expect(rewritten).toBeDefined();
    expect(String(rewritten?.['content_hash'])).not.toBe(edited?.['content_hash']);
    expect(String(rewritten?.['content'])).toContain(WHITE);
    // `0011` keeps the vector in a child table and the hash on the slice; a slice
    // whose text moved must be re-embeddable, which means pending.
    expect(rewritten?.['index_status']).toBe('pending');
    // The previous failures were about text that no longer exists, so the budget
    // starts over — at **zero**, because the counter records attempts the *claim*
    // spent and no claim has been asked about this text yet.
    expect(Number(rewritten?.['index_attempts'])).toBe(0);
    // An instant with no current vector behind it must not survive the rewrite,
    // and neither does a reason that described text which is gone.
    expect(rewritten?.['indexed_at']).toBeNull();
    expect(rewritten?.['index_error']).toBeNull();

    // The slices that did not change were written too — and their index state
    // was **not**. Asserted on one of them, because a write that only touched the
    // edited slice would pass everything above, and so would one that reset every
    // row's budget: this is the assertion the 46%-parked incident is about.
    const untouched = after.find((row) => String(row['id']) !== String(edited?.['id']));
    expect(untouched).toBeDefined();
    expect(untouched?.['index_status']).toBe('failed');
    expect(Number(untouched?.['index_attempts'])).toBe(3);
    expect(untouched?.['index_error']).toBe('provider 502');
  });

  it('drops the slices a shortened field no longer produces, and their keywords with them', async () => {
    const scope = await createScope('short');
    await seedFaq(scope, 'd', { question: QUESTION, answer: ANSWER });
    await indexSourceInto(writer, await indexableFaq(scope, 'd'));

    const before = await listChunks(scope.tenantId);
    // The fixture has to have a slice to lose, and that slice has to own a
    // keyword, or the cascade below is asserted over nothing.
    expect(before.length).toBeGreaterThan(1);
    const doomed = before.filter((row) => String(row['content']).includes(BLACK));
    expect(doomed.length).toBe(1);
    const doomedIds = doomed.map((row) => String(row['id']));
    const keywordsBefore = await countKeywordsFor(doomedIds);
    expect(keywordsBefore).toBeGreaterThan(0);

    await database.query('UPDATE faqs SET answer = $2 WHERE id = $1', [faqId('d'), SHORT_ANSWER]);
    const plan = await indexSourceInto(writer, await indexableFaq(scope, 'd'));

    // The state machine named exactly the slices the shorter field stopped
    // producing — not the ones whose text merely changed.
    expect([...plan.stale].sort()).toEqual([...doomedIds].sort());

    const after = await listChunks(scope.tenantId);
    expect(await countChunks(scope.tenantId)).toBe(after.length);
    expect(after.length).toBeLessThan(before.length);
    // The survivors are the slices that were not dropped, ids intact: a pass that
    // re-cut the whole field would produce the right count at the wrong
    // addresses, and every one of them would be re-embedded.
    const survivors = before
      .map((row) => String(row['id']))
      .filter((id) => !doomedIds.includes(id))
      .sort();
    expect(after.map((row) => String(row['id'])).sort()).toEqual(survivors);

    // Read from the table rather than from the returned plan: "it was reported
    // stale" and "it is gone" are different claims, and only the second is the
    // contract. A slice left behind would still answer customers, from text its
    // source no longer contains.
    expect(await countChunksByIds(doomedIds)).toBe(0);
    // And the keyword rows went with it through `knowledge_chunk_keywords_chunk_fk`
    // — the one delete in this path that no statement of the writer's performs.
    // Rewriting 黑色 as 白色 earlier leaves the *rewritten* slice's keywords
    // correct; what is asserted here is that a slice that stops existing takes its
    // keywords with it rather than leaving rows behind that point at a ghost.
    expect(await countKeywordsFor(doomedIds)).toBe(0);
  });

  it('leaves a deleted source alone, and copies a switch-off through on the next pass', async () => {
    const scope = await createScope('gone');
    await seedFaq(scope, 'e1', { question: QUESTION, answer: SHORT_ANSWER });
    await seedFaq(scope, 'e2', { question: QUESTION, answer: SHORT_ANSWER });
    await indexSourceInto(writer, await indexableFaq(scope, 'e1'));
    await indexSourceInto(writer, await indexableFaq(scope, 'e2'));

    const deletedBefore = await listChunksFor(scope.tenantId, faqId('e1'));
    const switchedBefore = await listChunksFor(scope.tenantId, faqId('e2'));
    expect(deletedBefore.length).toBeGreaterThan(0);
    expect(switchedBefore.length).toBeGreaterThan(0);

    // --- the source row is deleted ------------------------------------------
    await database.query('DELETE FROM faqs WHERE id = $1', [faqId('e1')]);

    // The read path stops seeing it, which is the whole of what deletion means
    // here: no pass will ever visit this address again.
    const sources = await reader.listIndexSources(scope.tenantId);
    expect(sources.some((source) => source.sourceId === faqId('e1'))).toBe(false);

    // Its slices stay. This is the day's registered gap, not a behaviour this
    // test approves of: `knowledge_chunks.source_id` is a polymorphic text column
    // with no foreign key to the source, so nothing knows the source is gone —
    // the write path's `stale` list covers "the source is still there and got
    // shorter", and this is the other case. It is asserted rather than left
    // unstated so that the day the sweep learns to reconcile it, this is the
    // line that has to change and cannot change quietly.
    expect(await countChunksFor(scope.tenantId, faqId('e1'))).toBe(deletedBefore.length);

    // --- the source row is switched off -------------------------------------
    await database.query('UPDATE faqs SET enabled = FALSE WHERE id = $1', [faqId('e2')]);

    // Still mapped, and mapped as unusable: the read path filters on the tenant
    // alone precisely so that this row is read and its copies can be corrected.
    const switchedInput = await indexableFaq(scope, 'e2');
    expect(switchedInput.enabled).toBe(false);
    // Nothing is dropped for being switched off — the kernel derives chunks from
    // the values it is given and never re-judges usability, which is the rule the
    // read path is the only caller of.
    expect(buildKnowledgeIndex(switchedInput).chunks.length).toBeGreaterThan(0);

    await indexSourceInto(writer, switchedInput);

    const switchedAfter = await listChunksFor(scope.tenantId, faqId('e2'));
    // The rows are the same rows: this pass corrected a copied column, it did not
    // re-cut the field.
    expect(switchedAfter.map((row) => String(row['id']))).toEqual(
      switchedBefore.map((row) => String(row['id'])),
    );
    for (const row of switchedAfter) {
      expect(row['enabled']).toBe(false);
    }
    // And the deleted source's rows are still untouched by the pass over its
    // neighbour, which is what keeps the two halves of this test independent.
    expect(await countChunksFor(scope.tenantId, faqId('e1'))).toBe(deletedBefore.length);
  });

  // ---------------------------------------------------------------------------
  // Fixtures and readers
  // ---------------------------------------------------------------------------

  /** One tenant and one store, both unique to this run. */
  async function createScope(label: string): Promise<Scope> {
    const tenantId = `tenant-life-${RUN}-${label}`;
    const storeId = `store-life-${RUN}-${label}`;
    const at = nowIso();
    await database.query(
      'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
      [tenantId, `life-${RUN}-${label}`, '知识索引生命周期测试租户', at],
    );
    await database.query(
      'INSERT INTO stores (id, tenant_id, code, name, enabled, created_at) VALUES ($1, $2, $3, $4, TRUE, $5)',
      [storeId, tenantId, 'main', '知识索引生命周期测试门店', at],
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

  /** Every stored slice of one source, in id order. */
  async function listChunksFor(
    tenantId: string,
    sourceId: string,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    return database.rows(
      `SELECT * FROM knowledge_chunks
        WHERE tenant_id = $1 AND source_kind = $2 AND source_id = $3
        ORDER BY id`,
      [tenantId, SOURCE_KIND, sourceId],
    );
  }

  /** How many slices one tenant has, counted by the table rather than inferred. */
  async function countChunks(tenantId: string): Promise<number> {
    const rows = await database.rows(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunks WHERE tenant_id = $1',
      [tenantId],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** How many slices one source has, counted by the table. */
  async function countChunksFor(tenantId: string, sourceId: string): Promise<number> {
    const rows = await database.rows(
      `SELECT COUNT(*)::int AS total FROM knowledge_chunks
        WHERE tenant_id = $1 AND source_kind = $2 AND source_id = $3`,
      [tenantId, SOURCE_KIND, sourceId],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** How many of the given slice ids still exist, counted by the table. */
  async function countChunksByIds(ids: ReadonlyArray<string>): Promise<number> {
    const rows = await database.rows(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunks WHERE id = ANY($1::text[])',
      [ids],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** How many keyword rows hang off the given slices. */
  async function countKeywordsFor(ids: ReadonlyArray<string>): Promise<number> {
    const rows = await database.rows(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunk_keywords WHERE chunk_id = ANY($1::text[])',
      [ids],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** Remove every row this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    for (const tenantId of tenants) {
      await database.query('DELETE FROM knowledge_chunk_keywords WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM knowledge_chunks WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM faq_question_variants WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM faqs WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM shortcuts WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM stores WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
  }
});

/** A tenant and the one store its FAQ belongs to. */
type Scope = { readonly tenantId: string; readonly storeId: string };

/** The source kind under test: the three-column address every helper narrows by. */
const SOURCE_KIND: IndexedSourceKind = 'faq';

/**
 * A fixed instant in the past, written into rows so that "the write refreshed
 * this column" is a comparison against a value the test chose.
 */
const SENTINEL = '2001-01-01T00:00:00.000Z';

/** The id of one seeded FAQ, derived so a test can name it before it exists. */
function faqId(label: string): string {
  return `faq-life-${RUN}-${label}`;
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
