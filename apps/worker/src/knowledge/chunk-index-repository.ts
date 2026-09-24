/**
 * The sweep's durable side: which slices are due for an attempt, and what an
 * attempt's result becomes in the tables.
 *
 * The kernel answers "what does a claimed slice's outcome mean"
 * (`recordChunkIndexOutcome`) and "is this row due" (`isChunkIndexDue`). This
 * module answers the two questions a kernel cannot: *which rows a running Worker
 * may claim right now*, and *what a claimed row's result is written as*. Both are
 * silent when they are wrong, and neither is a decision this layer invents — the
 * port below is a thin naming of work that is already defined elsewhere:
 *
 *   * **Write a claimed attempt back without checking the text.** The claim
 *     read `content` and handed it to a provider; the write-back happens one
 *     provider call later. `0011`'s `content_hash` is exactly the record of what
 *     was embedded, so a row whose hash moved under the claim — an edit or a
 *     reindex that landed in between — must not receive that vector. Writing it
 *     anyway produces an `indexed` row whose vector describes text the row no
 *     longer contains: retrieval answers with the old sentence, and nothing is
 *     logged. Hence {@link ChunkOutcomeWrite} carries the claim, and the adapter
 *     matches on the hash it read rather than on the id alone.
 *   * **Claim a slice that cannot be indexed.** Claiming spends an attempt
 *     (the kernel counts it at the claim, not at the failure). With no embedding
 *     provider configured, claiming is not "doing nothing" — it is spending a
 *     budget that will never be refilled, five ticks at a time, until every
 *     slice in the table is parked. That is why the *tick* refuses to claim
 *     without a provider and this port has no opinion about it at all.
 *
 * The port has three methods rather than one because the recovery sweep, the
 * claim and the write-back are three different statements with three different
 * `WHERE` clauses; a single "run the sweep" method would have to be implemented
 * by every fake, and the things a spec needs to vary — a due row, a stale hash, a
 * crash at the ceiling — are exactly the seams between them.
 */

import type { ChunkIndexState } from '@kefu/core';

/**
 * One slice the claim handed to this Worker.
 *
 * `indexAttempts` is the **post-claim** count: the claim wrote it, and it is the
 * number {@link recordChunkIndexOutcome} expects. Reading it as the pre-claim
 * count would park a slice after three recorded failures instead of five.
 *
 * `content` is the text the provider embeds, and `contentHash` is the same text
 * hashed — carried separately because the write-back needs the hash that was
 * *embedded*, and re-deriving it from `content` at that point would be a second
 * answer to "what did we send".
 */
export type ClaimedChunk = {
  readonly id: string;
  readonly tenantId: string;
  /** The slice text, as the provider receives it. */
  readonly content: string;
  /** `content` hashed, as the claim read it. */
  readonly contentHash: string;
  /** Attempts spent, this claim included. */
  readonly indexAttempts: number;
};

/**
 * One vector, ready to be stored.
 *
 * `dimensions` is deliberately absent: it is `vector.length`, and a second field
 * that could disagree with the vector it describes is a field that eventually
 * will. `contentHash` is the hash of the text that produced the vector, copied
 * from the claim so a vector whose chunk has since been rewritten is detectable
 * without re-embedding anything — the use `0011` states for the column.
 */
export type EmbeddingWrite = {
  readonly id: string;
  readonly model: string;
  readonly vector: ReadonlyArray<number>;
  readonly contentHash: string;
};

/**
 * One claimed attempt's result, as the store receives it.
 *
 * `state` is the kernel's `recordChunkIndexOutcome` output, passed through
 * unmodified: this layer decides where the columns go, never what they say.
 * `embedding` is non-null exactly when the state is `indexed` — a row that claims
 * to be indexed with no vector under it is the silent failure the whole index
 * layer exists to prevent, so the adapter treats the two disagreeing as an
 * invariant violation rather than writing one of them.
 */
export type ChunkOutcomeWrite = {
  readonly chunk: ClaimedChunk;
  readonly state: ChunkIndexState;
  readonly embedding: EmbeddingWrite | null;
  /** The instant the outcome is written at, used for `updated_at`. */
  readonly now: string;
};

/**
 * What became of one attempt's write.
 *
 * `superseded` means the row no longer carries the text that was embedded, so
 * the outcome was discarded rather than applied. It is a return value rather
 * than a silent no-op because the two cases that produce it — an edit landing
 * mid-attempt, and the slice having been deleted — are not errors, but they are
 * also not nothing, and a caller that cannot tell them from `recorded` cannot
 * report them.
 */
export type ChunkOutcomeRecord = 'recorded' | 'superseded';

/** The durable side of the index sweep. */
export interface ChunkIndexRepository {
  /**
   * Claim up to `limit` slices whose attempt is due, and count the attempt.
   *
   * The `WHERE` is `isChunkIndexDue` expressed in SQL, and it is the only place
   * in the system where that predicate exists twice. Claiming means writing
   * `index_attempts + 1` and `updated_at = now` in the same statement that
   * selects the rows, so two Workers running concurrently cannot be handed the
   * same attempt: the first one's update leaves the row with a fresh `updated_at`
   * and therefore outside the second one's backoff window.
   *
   * @param now - The tick's instant; the anchor the next attempt is measured from.
   * @param limit - How many slices one tick may claim.
   * @returns The claimed slices, in the order the claim chose them.
   */
  claimDue(now: string, limit: number): Promise<ReadonlyArray<ClaimedChunk>>;

  /**
   * Park the slices a Worker claimed and never wrote back.
   *
   * A claim spends an attempt; a Worker that dies between the claim and the
   * write-back therefore leaves a row at the attempt ceiling that
   * {@link claimDue} will never take again. The kernel names this as the sweep's
   * job (`planChunkWrite`'s park branch is reachable "two ways, and both need
   * this branch"), and this is the second way.
   *
   * @param now - The tick's instant.
   * @returns How many rows became `skipped`.
   */
  parkExhausted(now: string): Promise<number>;

  /**
   * Write one attempt's outcome, and its vector when there is one.
   *
   * @param write - The claim, the kernel's state, the vector, and the instant.
   * @returns Whether the outcome was applied or superseded; see
   *   {@link ChunkOutcomeRecord}.
   */
  recordOutcome(write: ChunkOutcomeWrite): Promise<ChunkOutcomeRecord>;
}
