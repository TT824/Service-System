/**
 * Durable {@link ChunkIndexRepository} over `0011`'s `knowledge_chunks` and
 * `knowledge_chunk_embeddings`.
 *
 * Every policy this adapter reproduces in SQL has exactly one definition, in
 * `@kefu/core`, and the statements below name it where they use it — the due
 * predicate, the attempt bound, the retry schedule. Nothing here decides a policy
 * of its own; what it does decide is *how a concurrent Worker is excluded*, and
 * that is the part worth reading carefully, because `0011` offers no lease.
 *
 * **The claim is its own lock.** `channel_outbox` has `lease_owner` and
 * `lease_expires_at`; `knowledge_chunks` has neither, and this adapter does not
 * add one. The exclusion comes from the retry schedule instead: the claim writes
 * `index_attempts + 1` **and** `updated_at = now` in one statement, and every
 * attempt after the first has a non-zero delay measured from `updated_at`. So the
 * row a Worker just claimed is outside every other Worker's backoff window for at
 * least a minute — not because someone holds a lease, but because the row now
 * says an attempt was spent at this instant. The consequences of that choice are
 * stated where they land: a Worker that dies holds nothing, and the row it left
 * is recovered by {@link PostgresChunkIndexRepository.parkExhausted} rather than
 * by a lease expiring.
 *
 * **The retry schedule is the kernel's, not a second expression of it.** The
 * obvious way to write "not yet due" here is to re-derive
 * `knowledgeIndexRetryDelayMs` in SQL — an exponential with a ceiling and a
 * clamp — and that would be a second definition of the schedule, silently wrong
 * the day either copy changes. Instead the delays are computed **by the kernel**
 * (`knowledgeIndexRetryDelayMs` for every attempt count the column can hold) and
 * passed to the statement as an array that the `WHERE` merely indexes into. The
 * SQL contains no exponent, no base and no ceiling: it contains a lookup, and the
 * numbers are the ones the kernel returns.
 *
 * **The write-back is guarded by the hash, not by the id.** Between the claim and
 * the write there is a provider call, and in that window the row's text can move
 * — an edit, an import, any pass of `indexSourceInto` over the same source. The
 * claim carries the hash it embedded, `0011`'s `content_hash` column is the
 * record of what the row holds now, and the update matches on both. A mismatch
 * means the vector describes text that is no longer there, and `superseded` is
 * returned instead of a stale `indexed` row.
 */

import type { PoolClient, QueryResultRow } from 'pg';
import {
  KNOWLEDGE_INDEX_MAX_ATTEMPTS,
  KNOWLEDGE_INDEX_PARKED_WITHOUT_REASON,
  knowledgeIndexRetryDelayMs,
} from '@kefu/core';
import { WorkerDatabase } from '../database/worker-database';
import { toNumber, toText } from '../database/row-values';
import type {
  ChunkIndexRepository,
  ChunkOutcomeRecord,
  ChunkOutcomeWrite,
  ClaimedChunk,
  EmbeddingWrite,
} from './chunk-index-repository';

/**
 * The retry schedule as the claim's `WHERE` reads it, one entry per attempt count
 * from zero to {@link KNOWLEDGE_INDEX_MAX_ATTEMPTS}.
 *
 * Built by calling the kernel rather than by transcribing its formula: entry
 * `n + 1` is what `knowledgeIndexRetryDelayMs(n)` returns, so the statement's
 * only remaining job is to pick the right entry. Passed as a parameter, so the
 * statement text itself never carries a number that could drift.
 */
const RETRY_DELAYS_MS: ReadonlyArray<number> = Object.freeze(
  Array.from({ length: KNOWLEDGE_INDEX_MAX_ATTEMPTS + 1 }, (_, attempts) =>
    knowledgeIndexRetryDelayMs(attempts),
  ),
);

/**
 * The claim, in one statement.
 *
 * The CTE's predicate is `isChunkIndexDue` written out:
 * `index_status NOT IN ('indexed', 'skipped')` (its two terminal states, and the
 * only two — a *parked* slice is not retried, because "it failed five times" is a
 * conclusion and not a schedule), `index_attempts < $3` (the attempt bound), and
 * the backoff: `updated_at` plus the delay the kernel gives for the attempts
 * already spent, at most `$1`.
 *
 * The outer `UPDATE` is what makes the claim an attempt rather than a read: it
 * spends the attempt (`index_attempts + 1`) and re-anchors the schedule
 * (`updated_at = $1`) before the provider is called, which is the kernel's rule
 * and the reason a crash loop exhausts a slice's budget instead of retrying it
 * for ever.
 *
 * `index_status` is set to `pending` on the way in. That is not a new state — it
 * is exactly what `planChunkWrite`'s `attempt` branch writes for a retryable
 * slice, and the two claim paths must leave one state rather than two. What the
 * claim deliberately does **not** touch is `index_error`: the row's last recorded
 * failure is the truth about it until a new outcome replaces it, and a Worker
 * that dies after claiming would otherwise have erased the reason it was there.
 *
 * `ORDER BY updated_at, id` offers the longest-waiting slice first and makes the
 * order total, so two Workers claiming concurrently take different rows rather
 * than racing on one. `SKIP LOCKED` is what turns that into a lock rather than a
 * queue. The `RETURNING` list is qualified with the claim's target alias because
 * the CTE puts `id` in scope twice and PostgreSQL refuses the ambiguity — the same
 * reason, and the same shape, as the outbox's claim.
 */
const CLAIM_DUE_SQL = `
WITH due AS (
  SELECT id FROM knowledge_chunks
   WHERE index_status NOT IN ('indexed', 'skipped')
     AND index_attempts < $3
     AND updated_at + (($4::bigint[])[index_attempts + 1] * INTERVAL '1 millisecond') <= $1
   ORDER BY updated_at, id
   FOR UPDATE SKIP LOCKED
   LIMIT $2
)
UPDATE knowledge_chunks AS claimed
   SET index_attempts = claimed.index_attempts + 1,
       index_status = 'pending',
       updated_at = $1
  FROM due
 WHERE claimed.id = due.id
RETURNING claimed.id, claimed.tenant_id, claimed.content, claimed.content_hash,
          claimed.index_attempts`;

/**
 * Park what a dead Worker left at the ceiling.
 *
 * The predicate is the complement of the claim's: `pending` (the state a claim
 * leaves behind), `index_attempts >= $2` (so the claim will never take it again),
 * and a backoff that has elapsed. The delay used is the ceiling's —
 * `RETRY_DELAYS_MS[$2 + 1]`, the last entry, and it is the *fifth* element
 * because PostgreSQL arrays are 1-based while the kernel's attempt counts start
 * at zero — which is also the delay of any counter above the ceiling, so this
 * statement is total without a clamp.
 *
 * The wait matters for the same reason the outbox's sweep excludes a live lease:
 * a slice claimed one moment ago is at the ceiling *because it is being embedded
 * right now*, and parking it would report a lie for as long as the provider takes.
 * The row's own backoff is the only clock `0011` offers, and the ceiling's delay
 * is what stands in for a lease here.
 *
 * `index_error` keeps whatever the row recorded, and is given
 * {@link KNOWLEDGE_INDEX_PARKED_WITHOUT_REASON} only when it recorded nothing —
 * which is precisely the case this statement exists for, a Worker that died
 * between its claim and its write-back. A recorded reason is a better account of
 * the row than any sentence this statement could invent, and a parked row with a
 * NULL reason is the one outcome an operator cannot read at all: 46% of one
 * tenant's slices were parked that way, and the table said nothing about why.
 */
const PARK_EXHAUSTED_SQL = `
UPDATE knowledge_chunks
   SET index_status = 'skipped',
       index_error = COALESCE(index_error, $4),
       updated_at = $1
 WHERE index_status = 'pending'
   AND index_attempts >= $2
   AND updated_at + (($3::bigint[])[$2 + 1] * INTERVAL '1 millisecond') <= $1
RETURNING id`;

/**
 * Write one attempt's outcome onto the slice it was claimed from.
 *
 * `content_hash = $3` is the guard the module note describes, and it is the whole
 * reason this is not a bare `WHERE id = $2`: the row is matched only while it
 * still holds the text that was embedded. A parked row and an indexed row whose
 * text did not move both match — correctly, because the outcome describes exactly
 * that text.
 */
const RECORD_OUTCOME_SQL = `
UPDATE knowledge_chunks
   SET index_status = $4,
       index_attempts = $5,
       index_error = $6,
       indexed_at = $7,
       updated_at = $8
 WHERE tenant_id = $1 AND id = $2 AND content_hash = $3
RETURNING id`;

/**
 * Store one vector under its slice and model.
 *
 * `ON CONFLICT (tenant_id, chunk_id, embedding_model)` is
 * `knowledge_chunk_embeddings_unique`: re-embedding the same slice under the same
 * model replaces `embedding` and `content_hash` in place, while a *different*
 * model inserts a second row beside the first — which is the rebuild story `0011`
 * spells out, and the reason the conflict target names the model.
 *
 * `created_at` and `id` are deliberately not in the `DO UPDATE` set, for the same
 * reason the chunk upsert leaves them alone: the first write's instant is the
 * row's birth, and the id is derived from the conflict target, so it is equal by
 * construction.
 *
 * The vector is passed as pgvector's text form (`[1,2,3]`) and cast in the
 * statement: `pg` has no codec for a dimension-less `vector` column, and the
 * column's type is deliberately dimension-less (see `0011`'s header), so the cast
 * is the only place a dimension could sneak in — and it does not.
 */
const UPSERT_EMBEDDING_SQL = `
INSERT INTO knowledge_chunk_embeddings (
  id, tenant_id, chunk_id, embedding_model, embedding_dimensions, embedding, content_hash, created_at)
VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
ON CONFLICT (tenant_id, chunk_id, embedding_model) DO UPDATE SET
  embedding_dimensions = EXCLUDED.embedding_dimensions,
  embedding = EXCLUDED.embedding,
  content_hash = EXCLUDED.content_hash`;

/** Durable index sweep store backed by the Worker-owned PostgreSQL pool. */
export class PostgresChunkIndexRepository implements ChunkIndexRepository {
  /**
   * @param database - The Worker-owned connection pool.
   */
  constructor(private readonly database: WorkerDatabase) {}

  /** @inheritdoc */
  async claimDue(now: string, limit: number): Promise<ReadonlyArray<ClaimedChunk>> {
    const rows = await this.database.rows(CLAIM_DUE_SQL, [
      now,
      Math.max(0, Math.trunc(limit)),
      KNOWLEDGE_INDEX_MAX_ATTEMPTS,
      [...RETRY_DELAYS_MS],
    ]);
    return rows.map((row) => ({
      id: toText(row['id']),
      tenantId: toText(row['tenant_id']),
      content: toText(row['content']),
      contentHash: toText(row['content_hash']),
      indexAttempts: toNumber(row['index_attempts']),
    }));
  }

  /** @inheritdoc */
  async parkExhausted(now: string): Promise<number> {
    const rows = await this.database.rows(PARK_EXHAUSTED_SQL, [
      now,
      KNOWLEDGE_INDEX_MAX_ATTEMPTS,
      [...RETRY_DELAYS_MS],
      KNOWLEDGE_INDEX_PARKED_WITHOUT_REASON,
    ]);
    return rows.length;
  }

  /** @inheritdoc */
  async recordOutcome(write: ChunkOutcomeWrite): Promise<ChunkOutcomeRecord> {
    // The two halves of an outcome must agree about which one it is. A row that
    // claims `indexed` with no vector under it is a slice retrieval will search
    // for and never find, and a vector claimed for a `failed` attempt is a
    // vector nothing recorded as correct; neither is reachable from the
    // processor, and neither may be written if it ever is.
    const indexed = write.state.indexStatus === 'indexed';
    if (indexed !== (write.embedding !== null)) {
      throw new Error(
        `index write invariant: a ${write.state.indexStatus} outcome carried ${write.embedding === null ? 'no vector' : 'a vector'}`,
      );
    }

    return this.database.transaction(async (client) => {
      const updated = await statement(client, RECORD_OUTCOME_SQL, [
        write.chunk.tenantId,
        write.chunk.id,
        write.chunk.contentHash,
        write.state.indexStatus,
        write.state.indexAttempts,
        write.state.indexError,
        write.state.indexedAt,
        write.now,
      ]);
      if (updated.length === 0) {
        // Either the text moved or the slice is gone. Nothing is written — the
        // vector has no slice to hang off, and the state describes text that is
        // no longer there.
        return 'superseded';
      }

      if (write.embedding !== null) {
        await statement(client, UPSERT_EMBEDDING_SQL, embeddingParams(write.embedding, write));
      }
      return 'recorded';
    });
  }
}

/**
 * The placeholder values of one vector row.
 *
 * `embedding_dimensions` is read off the vector rather than carried alongside it,
 * so the column and the value it describes cannot disagree.
 */
function embeddingParams(
  embedding: EmbeddingWrite,
  write: ChunkOutcomeWrite,
): ReadonlyArray<unknown> {
  return [
    embedding.id,
    write.chunk.tenantId,
    write.chunk.id,
    embedding.model,
    embedding.vector.length,
    `[${embedding.vector.join(',')}]`,
    embedding.contentHash,
    write.now,
  ];
}

/** Run one parameterised statement on a transaction connection. */
async function statement(
  client: PoolClient,
  text: string,
  values: ReadonlyArray<unknown> = [],
): Promise<ReadonlyArray<QueryResultRow>> {
  const result = await client.query(text, [...values]);
  return result.rows as ReadonlyArray<QueryResultRow>;
}
