/**
 * Durable {@link KnowledgeChunkWriter} over `0011`'s `knowledge_chunks` and
 * `knowledge_chunk_keywords`, and `0014`'s `knowledge_chunk_terms`.
 *
 * One source row is one transaction, and the statements inside it are ordered so
 * that every intermediate state is one the schema already allows: slices first
 * (the keywords and the terms have a foreign key to them), the stale slices
 * removed, the keywords of the written slices brought down to the set the new
 * text produces, and the new keywords inserted — then the terms, replaced for
 * the slices whose text was written. A failure anywhere rolls the whole source
 * back — see `chunk-writer` for why a half-applied source is worse than a source
 * that did not index at all.
 *
 * **The terms are derived here rather than passed in**, and this is the one
 * thing this writer decides. It is not a judgement the way a keyword is —
 * `knowledge-keywords` reads merchant knowledge and names a dimension, and that
 * is a kernel's work — it is a function of the text of the row being written,
 * and the function belongs to `@kefu/core` (`tokenizeKnowledgeText`), where the
 * read path calls the same one. Nothing is decided here that the read path could
 * decide differently, so this is a second caller and not a second owner.
 *
 * The upsert's conflict target is `knowledge_chunks_slice_unique`'s five
 * columns. That is not a convenience: it is the only constraint that names the
 * same address {@link deriveChunkId} hashes, so the row updated is the row the
 * kernel meant. The table's other unique constraints are a primary key on `id`
 * and `knowledge_chunks_scope_unique (tenant_id, id)` — the second is a scope
 * guard for the child tables, and conflicting on it would mean "update whichever
 * slice already owns this id", which is a different question with the same
 * answer only by luck.
 *
 * Three columns are deliberately **not** in the `DO UPDATE` set:
 *
 * - `id` — derived from the conflict target, so it is equal by construction.
 * - `source_kind`, `source_id`, `source_field`, `chunk_index` — the conflict
 *   target itself.
 * - `created_at` — the first write's instant is the row's birth, and a reindex
 *   is not a birth.
 *
 * **Two statements, and the split is the invariant `@kefu/core` states.**
 * `resetsIndexState` names the plans that write index columns: a slice with no
 * row yet, and a slice whose text moved. Those go through
 * {@link UPSERT_CHUNK_SQL}, which writes the content, `pending`, a zero budget
 * and a fresh `updated_at` in one statement. Every other plan goes through
 * {@link TOUCH_CHUNK_SQL}, which writes **content only** and leaves
 * `index_status`, `index_attempts`, `index_error`, `indexed_at` and `updated_at`
 * exactly as it found them.
 *
 * The columns left alone are the point, and each has a reason that is not
 * obvious from the code that writes them:
 *
 * - `updated_at` is the only anchor `0011` offers for the retry backoff, and the
 *   *claim* re-anchors it when it spends an attempt. A sweep that refreshed it on
 *   every pass would push the delay forward for ever, so a slice at four spent
 *   attempts would never come due again: its eight-minute delay is measured from
 *   a write that a sweep a few minutes apart keeps making now.
 * - `index_attempts` and `index_error` belong to the claim and to the outcome
 *   record. A sweep writing them spends attempts no provider was asked about and
 *   erases the reason a real failure recorded, which is how a tenant's whole
 *   table came to hold NULL reasons.
 * - `indexed_at` describes a vector that exists; only a plan that drops the
 *   budget can drop it, and those plans write it as NULL rather than as
 *   `EXCLUDED`'s.
 *
 * What every pass still writes is `enabled`, which is how a source switched off
 * after indexing has its copied flag corrected. That correction needs the
 * *content* columns written, not the timestamp bumped: the promise `0011`'s
 * header makes is that the next index pass corrects the copy, and it does.
 */

import { resetsIndexState, tokenizeKnowledgeText } from '@kefu/core';
import type { ChunkTextPlan, KnowledgeChunkRow, StoredChunkState } from '@kefu/core';
import { WorkerDatabase } from '../database/worker-database';
import { toIso, toNumber, toText } from '../database/row-values';
import type { ChunkSourceAddress, KnowledgeChunkWriter, SourceChunkWrite } from './chunk-writer';

/**
 * Upsert one slice whose text is new — the row's whole content, and a budget
 * nothing has spent.
 *
 * Every content column is written from the incoming row and the index columns
 * from its plan, so a slice whose text moved is one statement rather than a
 * delete and an insert — the latter would drop the slice's keywords and its
 * embedding row through the cascades, and re-embedding text that only changed in
 * one character is not what `content_hash` is for.
 *
 * `indexed_at` is `NULL` rather than `EXCLUDED`'s, and the statement has no
 * `CASE` for it: the only plans that reach here are the two `resetsIndexState`
 * names, and neither can describe text that has a vector — a slice with no row
 * has never been embedded, and a slice whose text moved had its vector for the
 * text that is gone.
 */
const UPSERT_CHUNK_SQL = `
  INSERT INTO knowledge_chunks (
    id, tenant_id, store_id, scope_type, source_kind, source_id, source_field, chunk_type,
    chunk_index, content, context_before, context_after, char_count, enabled, content_hash,
    index_status, index_attempts, index_error, indexed_at, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21)
  ON CONFLICT (tenant_id, source_kind, source_id, source_field, chunk_index) DO UPDATE SET
    store_id = EXCLUDED.store_id,
    scope_type = EXCLUDED.scope_type,
    chunk_type = EXCLUDED.chunk_type,
    content = EXCLUDED.content,
    context_before = EXCLUDED.context_before,
    context_after = EXCLUDED.context_after,
    char_count = EXCLUDED.char_count,
    enabled = EXCLUDED.enabled,
    content_hash = EXCLUDED.content_hash,
    index_status = EXCLUDED.index_status,
    index_attempts = EXCLUDED.index_attempts,
    index_error = EXCLUDED.index_error,
    indexed_at = NULL,
    updated_at = EXCLUDED.updated_at`;

/**
 * Upsert one slice whose text did **not** move, writing content and nothing else.
 *
 * The `DO UPDATE` set is the whole contract of this statement: `enabled` and the
 * content columns, and not one column of index state. A row that is `failed`
 * after this pass is still `failed` with the same count and the same recorded
 * reason; a row waiting out its backoff still has the `updated_at` its last
 * attempt gave it, so the wait it is in the middle of is the wait it gets.
 *
 * The `INSERT` branch is unreachable — an untouched plan exists only for a row
 * that is already stored — and is spelled out rather than left to a separate
 * "update" statement so that the conflict target, and therefore the row this
 * addresses, is the same expression in both statements. Its literal defaults are
 * the ones a brand-new slice would get, so a bug that reached it would produce a
 * slice waiting to be embedded rather than a malformed row.
 */
const TOUCH_CHUNK_SQL = `
  INSERT INTO knowledge_chunks (
    id, tenant_id, store_id, scope_type, source_kind, source_id, source_field, chunk_type,
    chunk_index, content, context_before, context_after, char_count, enabled, content_hash,
    index_status, index_attempts, index_error, indexed_at, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending', 0, NULL,
          NULL, $16, $17)
  ON CONFLICT (tenant_id, source_kind, source_id, source_field, chunk_index) DO UPDATE SET
    store_id = EXCLUDED.store_id,
    scope_type = EXCLUDED.scope_type,
    chunk_type = EXCLUDED.chunk_type,
    content = EXCLUDED.content,
    context_before = EXCLUDED.context_before,
    context_after = EXCLUDED.context_after,
    char_count = EXCLUDED.char_count,
    enabled = EXCLUDED.enabled,
    content_hash = EXCLUDED.content_hash`;

/**
 * Remove the slices the kernel no longer produces.
 *
 * The keyword rows and any embedding rows go with them through
 * `knowledge_chunk_keywords_chunk_fk` / `knowledge_chunk_embeddings_chunk_fk`,
 * both `ON DELETE CASCADE`, so no child row is deleted by hand here — a second
 * delete would be a second place that has to know what a slice owns.
 */
const DELETE_STALE_SQL =
  'DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND id = ANY($2::text[])';

/**
 * Remove the keywords of the written slices that the new text no longer
 * produces.
 *
 * Scoped to the slices that were just written, so a keyword under a *different*
 * source is never touched by this source's pass, and excluding the ids about to
 * be inserted, so unchanged keywords keep their `created_at` instead of being
 * recreated.
 */
const DELETE_ORPHAN_KEYWORDS_SQL = `
  DELETE FROM knowledge_chunk_keywords
   WHERE tenant_id = $1
     AND chunk_id = ANY($2::text[])
     AND id <> ALL($3::text[])`;

/**
 * Attach one keyword to its slice.
 *
 * `DO NOTHING` rather than `DO UPDATE`: the only column a conflicting row could
 * change is `created_at`, and rewriting a row to record that it was seen again
 * is not worth the write. A keyword's id is derived from the same four columns
 * this conflicts on, so a conflict is always the same keyword.
 */
const INSERT_KEYWORD_SQL = `
  INSERT INTO knowledge_chunk_keywords (id, tenant_id, chunk_id, keyword_kind, keyword_text, created_at)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (tenant_id, chunk_id, keyword_kind, keyword_text) DO NOTHING`;

/**
 * Remove every term of the slices whose text was just written.
 *
 * Not a reconciliation like the keywords', and the asymmetry is the reason this
 * is two statements instead of three: a keyword is merchant knowledge and has a
 * history — an unchanged one keeps its `created_at` — while a term is derived
 * from the text that carries it and has none, so replacing the whole set is the
 * update. It is scoped to the slices this pass wrote, so a term under a
 * *different* source is never touched by this source's pass.
 */
const DELETE_TERMS_SQL =
  'DELETE FROM knowledge_chunk_terms WHERE tenant_id = $1 AND chunk_id = ANY($2::text[])';

/**
 * Attach one term to its slice, with the frequency BM25 saturates on.
 *
 * `unnest` over three parallel arrays rather than a statement per term, because
 * a slice carries an order of magnitude more terms than keywords and the write
 * is the same fact either way.
 *
 * There is no `ON CONFLICT`. The delete above removes every row these triples
 * could collide with, so a conflict would mean two rows for one (slice, term) —
 * two counts for one term, which is a bug in the counting and not a state to
 * resolve. Failing the source's transaction is how this writer treats an
 * impossible state everywhere else, and it is what makes the bug visible.
 */
const INSERT_TERMS_SQL = `
  INSERT INTO knowledge_chunk_terms (tenant_id, chunk_id, term, tf)
  SELECT $1, t.chunk_id, t.term, t.tf
    FROM unnest($2::text[], $3::text[], $4::int[]) AS t(chunk_id, term, tf)`;

/** Every slice stored under one source's address. */
const SELECT_STORED_SQL = `
  SELECT id, content_hash, index_status, index_attempts, updated_at
    FROM knowledge_chunks
   WHERE tenant_id = $1 AND source_kind = $2 AND source_id = $3`;

/** One source row's slices and keywords, written through the Worker's own pool. */
export class PostgresChunkWriter implements KnowledgeChunkWriter {
  /**
   * @param database - The Worker-owned connection pool.
   */
  constructor(private readonly database: WorkerDatabase) {}

  /** @inheritdoc */
  async listStoredChunks(address: ChunkSourceAddress): Promise<ReadonlyArray<StoredChunkState>> {
    const rows = await this.database.rows(SELECT_STORED_SQL, [
      address.tenantId,
      address.sourceKind,
      address.sourceId,
    ]);
    return rows.map((row) => ({
      id: toText(row['id']),
      contentHash: toText(row['content_hash']),
      indexStatus: toIndexStatus(row['index_status']),
      indexAttempts: toNumber(row['index_attempts']),
      updatedAt: toIso(row['updated_at']),
    }));
  }

  /** @inheritdoc */
  async writeSourceChunks(write: SourceChunkWrite): Promise<void> {
    const { address } = write;
    const now = new Date().toISOString();
    const plans = new Map(write.plans.map((plan) => [plan.id, plan]));

    // The slices whose text this pass writes — the same set `UPSERT_CHUNK_SQL`
    // takes, because `0014`'s terms are a function of that text and of nothing
    // else. A slice the pass only touches already has the terms its text
    // produces, which is also why the slices that predate the term table are
    // backfilled by `backfill-chunk-terms.cjs` instead of by the next sweep.
    const rewritten: KnowledgeChunkRow[] = [];

    await this.database.transaction(async (client) => {
      for (const chunk of write.chunks) {
        const plan = plans.get(chunk.id);
        if (plan === undefined) {
          // Unreachable through {@link indexSourceInto}, which derives both from
          // one call to the state machine. It is checked rather than defaulted
          // because the default would be a slice whose index columns belong to
          // some other slice's plan — a row that looks indexed and is not.
          throw new Error(
            `index write invariant: chunk ${chunk.id} has no plan (${write.plans.length} plans, ${write.chunks.length} chunks)`,
          );
        }
        if (resetsIndexState(plan)) {
          await client.query(UPSERT_CHUNK_SQL, chunkParams(chunk, plan, address, now));
          rewritten.push(chunk);
        } else {
          await client.query(TOUCH_CHUNK_SQL, touchParams(chunk, address, now));
        }
      }

      if (write.stale.length > 0) {
        await client.query(DELETE_STALE_SQL, [address.tenantId, [...write.stale]]);
      }

      if (write.chunks.length > 0) {
        await client.query(DELETE_ORPHAN_KEYWORDS_SQL, [
          address.tenantId,
          write.chunks.map((chunk) => chunk.id),
          write.keywords.map((keyword) => keyword.id),
        ]);
      }

      for (const keyword of write.keywords) {
        await client.query(INSERT_KEYWORD_SQL, [
          keyword.id,
          keyword.tenantId,
          keyword.chunkId,
          keyword.keywordKind,
          keyword.keywordText,
          now,
        ]);
      }

      if (rewritten.length > 0) {
        const terms = countChunkTerms(rewritten);
        await client.query(DELETE_TERMS_SQL, [
          address.tenantId,
          rewritten.map((chunk) => chunk.id),
        ]);
        if (terms.chunkIds.length > 0) {
          await client.query(INSERT_TERMS_SQL, [
            address.tenantId,
            terms.chunkIds,
            terms.terms,
            terms.counts,
          ]);
        }
      }
    });
  }
}

/**
 * The terms of the slices about to be written, as the three parallel arrays
 * {@link INSERT_TERMS_SQL} unnests.
 *
 * Counting rather than de-duplicating is what the table is for: `tf` is the
 * frequency BM25 saturates on, so a term the text says three times is one row
 * holding three. The order of the triples is the order the tokenizer produced
 * them, and nothing reads it.
 */
function countChunkTerms(chunks: ReadonlyArray<KnowledgeChunkRow>): {
  readonly chunkIds: string[];
  readonly terms: string[];
  readonly counts: number[];
} {
  const chunkIds: string[] = [];
  const terms: string[] = [];
  const counts: number[] = [];
  for (const chunk of chunks) {
    const counted = new Map<string, number>();
    for (const token of tokenizeKnowledgeText(chunk.content)) {
      counted.set(token, (counted.get(token) ?? 0) + 1);
    }
    for (const [term, tf] of counted) {
      chunkIds.push(chunk.id);
      terms.push(term);
      counts.push(tf);
    }
  }
  return { chunkIds, terms, counts };
}

/**
 * The placeholder values of one text-resetting upsert, in column order.
 *
 * `indexed_at` is a literal `NULL` (see the statement), and the three index
 * columns come from the plan rather than from literals here, so the values the
 * kernel decided and the values the row receives cannot drift apart.
 */
function chunkParams(
  chunk: KnowledgeChunkRow,
  plan: ChunkTextPlan,
  address: ChunkSourceAddress,
  now: string,
): Array<unknown> {
  return [
    chunk.id,
    address.tenantId,
    chunk.storeId,
    chunk.scopeType,
    chunk.sourceKind,
    address.sourceId,
    chunk.sourceField,
    chunk.chunkType,
    chunk.chunkIndex,
    chunk.content,
    chunk.contextBefore,
    chunk.contextAfter,
    chunk.charCount,
    chunk.enabled,
    chunk.contentHash,
    plan.indexStatus,
    plan.indexAttempts,
    plan.indexError,
    null,
    now,
    now,
  ];
}

/**
 * The placeholder values of one content-only touch, in column order.
 *
 * Seventeen rather than twenty-one, because the statement's `DO UPDATE` set has
 * no index column and no `created_at` in it: passing values the statement does
 * not read would suggest the row receives them.
 */
function touchParams(
  chunk: KnowledgeChunkRow,
  address: ChunkSourceAddress,
  now: string,
): Array<unknown> {
  return [
    chunk.id,
    address.tenantId,
    chunk.storeId,
    chunk.scopeType,
    chunk.sourceKind,
    address.sourceId,
    chunk.sourceField,
    chunk.chunkType,
    chunk.chunkIndex,
    chunk.content,
    chunk.contextBefore,
    chunk.contextAfter,
    chunk.charCount,
    chunk.enabled,
    chunk.contentHash,
    now,
    now,
  ];
}

/**
 * Narrow a stored `index_status` to the four states the state machine reads.
 *
 * The column is `CHECK (index_status IN (...))`, so an unrecognised value means
 * the row was not written by this platform. It is reported as `pending` — the
 * column's own default, and the state that asks the sweep to look again — rather
 * than thrown on, because a status the indexer cannot name is not a reason to
 * stop indexing the tenant.
 *
 * @param value - Column value as the driver returned it.
 * @returns One of `pending`, `indexed`, `failed`, `skipped`.
 */
function toIndexStatus(value: unknown): StoredChunkState['indexStatus'] {
  const text = toText(value);
  return text === 'indexed' || text === 'failed' || text === 'skipped' ? text : 'pending';
}
