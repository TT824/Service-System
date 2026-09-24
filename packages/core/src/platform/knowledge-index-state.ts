/**
 * The index state machine: what a freshly derived chunk row means to the row
 * already stored under the same id.
 *
 * `knowledge-indexer` answers "which rows does this source produce?"; this
 * module answers the question the job cannot get from either side alone —
 * "given the row that is there and the row that is now wanted, is there work to
 * do?" That question has exactly one failure mode worth a module of its own: it
 * fails **silently and by degrees**, never with an error.
 *
 *   * Skip too eagerly — treat "same id" as "same row" — and a slice whose text
 *     was edited keeps its old embedding for ever. Retrieval returns the old
 *     sentence, the answer reads as merely outdated, and nothing is logged.
 *   * Retry too eagerly — never park a slice that keeps failing — and one
 *     unembeddable row is re-attempted on every sweep. The table is small, the
 *     logs are green, and the provider is called for ever.
 *
 * Both are invisible to a shape assertion, which is why the decision is a pure
 * function of two rows here rather than a few `if`s inside the job.
 *
 * **The attempt is counted when it is claimed, and by nobody else.** Migration
 * `0011` stores `index_attempts`, and the claim spends it — `index_attempts + 1`
 * in the same statement that takes the row — *before* the embedding call, the
 * same discipline as `channel-reliability`'s outbox claim and for the same
 * reason: a worker that dies mid-attempt has already spent that attempt, so a
 * crash loop exhausts the budget instead of retrying for ever.
 *
 * So a plan for a slice whose text did not move **carries no counter at all**:
 * {@link planChunkWrite}'s job is to write content and, when the text is new, to
 * start a budget — never to spend one. The distinction is not cosmetic. The
 * first version of this module returned "the counter the claim writes" from every
 * branch, and a plan's only caller is the *source sweep*, not the claim: every
 * pass over an unindexed slice spent an attempt no provider was ever asked
 * about, wiped the `index_error` a real failure had recorded, and re-anchored the
 * backoff below. Five passes is a few minutes of a sweep that re-reads every
 * source every minute, so a tenant imported in bulk reached the ceiling almost
 * immediately, with `index_error` NULL on every row: 46% of its slices were parked
 * before their first embedding.
 *
 * **`0011` has no `available_at`.** The outbox has one; `knowledge_chunks` does
 * not, and this module does not add a migration. So the not-due rule is anchored
 * on `updated_at`, and the *claim* re-anchors it — which holds only while a write
 * that changes no index state leaves the column alone. A sweep that rewrites
 * `updated_at` on every pass pushes the delay forward for ever: the delay is
 * measured from the last write of the row, and such a sweep makes that write now,
 * every time. The consequence is worth stating plainly: a sweep that ignores
 * {@link isChunkIndexDue} does not retry late, it retries in a hot loop.
 *
 * **`enabled` is not read here.** Whether a source may answer customers lives
 * once, in `usableKnowledge`, and `0011` records that the job calls it and writes
 * the answer down. A source that is switched off after indexing is corrected by
 * the index pass rewriting the copy — not by a second rule, and not by this
 * module. So a disabled source's slices are still indexed; they are simply not
 * retrieved.
 *
 * No clock, no randomness, no I/O: `now` is a parameter, so every branch below is
 * reachable from a spec without waiting.
 */

import type { KnowledgeChunkRow } from './knowledge-indexer';

/**
 * Index attempts one slice may spend before it is parked.
 *
 * Parking is not deletion: the row stays, its keywords stay, and the next text
 * change resets the budget through {@link planChunkWrite}'s `reindex` branch.
 */
export const KNOWLEDGE_INDEX_MAX_ATTEMPTS = 5;

/** Delay before the attempt after one spent attempt. */
export const KNOWLEDGE_INDEX_RETRY_BASE_MS = 60_000;

/** Ceiling of the exponential retry delay. */
export const KNOWLEDGE_INDEX_RETRY_MAX_MS = 30 * 60_000;

/**
 * How long to wait before the attempt after `attemptCount` spent attempts.
 *
 * Exponential from {@link KNOWLEDGE_INDEX_RETRY_BASE_MS}, capped at
 * {@link KNOWLEDGE_INDEX_RETRY_MAX_MS}. It lives here rather than in the worker
 * so that the schedule the sweep applies and the schedule a diagnostic explains
 * are the same number.
 *
 * @param attemptCount - Attempts already spent on this slice.
 * @returns Delay in milliseconds; `0` when no attempt has been spent yet.
 */
export function knowledgeIndexRetryDelayMs(attemptCount: number): number {
  if (attemptCount <= 0) {
    return 0;
  }
  // Bounded before the shift, so a corrupted counter cannot overflow the delay.
  const exponent = Math.min(attemptCount - 1, 16);
  return Math.min(KNOWLEDGE_INDEX_RETRY_BASE_MS * 2 ** exponent, KNOWLEDGE_INDEX_RETRY_MAX_MS);
}

/**
 * The four states `0011`'s `index_status` check constraint allows, in the order
 * the migration lists them.
 *
 * `pending` and `failed` are states a sweep will visit again; `indexed` and
 * `skipped` are terminal, which is why the claim's `WHERE` names exactly those
 * two. Written as a list as well as a type because the status *read* has to
 * iterate them — a tenant with nothing parked must still report `skipped: 0`.
 */
export const CHUNK_INDEX_STATUSES = ['pending', 'indexed', 'failed', 'skipped'] as const;

/** One state of a slice's index lifecycle. */
export type ChunkIndexStatus = (typeof CHUNK_INDEX_STATUSES)[number];

/** Whether a value is one of {@link CHUNK_INDEX_STATUSES}. */
export function isChunkIndexStatus(value: string): value is ChunkIndexStatus {
  return (CHUNK_INDEX_STATUSES as ReadonlyArray<string>).includes(value);
}

/** The stored `knowledge_chunks` columns the decision reads. */
export type StoredChunkState = {
  readonly id: string;
  /** The hash written by the index that produced this row. */
  readonly contentHash: string;
  readonly indexStatus: ChunkIndexStatus;
  readonly indexAttempts: number;
  /** When the row was last written; the only anchor `0011` offers for backoff. */
  readonly updatedAt: string;
};

/** What the job should do with one slice. */
export type ChunkWriteAction =
  /** No row under this id yet. */
  | 'insert'
  /** Same id, different text: the stored embedding no longer describes it. */
  | 'reindex'
  /** Same text, unindexed, budget left: a claim may take it. */
  | 'queue'
  /** Already indexed, text unmoved. */
  | 'skip'
  /** Text unmoved and the budget is gone: nothing left to try. */
  | 'park';

/** Every action's fixed wording, so two reporters describe one state alike. */
const CHUNK_WRITE_REASONS: Readonly<Record<ChunkWriteAction, string>> = {
  insert: 'the slice is new to the index',
  reindex: 'the slice text moved since the last index, so its embedding is stale',
  queue: 'the slice is unindexed and still has attempts left, so a claim may take it',
  skip: 'the slice is already indexed and its text did not move',
  park: `the slice spent its ${KNOWLEDGE_INDEX_MAX_ATTEMPTS} index attempts`,
};

/**
 * What gets written into `index_error` when a slice is parked with nothing
 * recorded — a Worker that died between its claim and its write-back leaves
 * exactly that row.
 *
 * It lives here so the statement that parks such a row and the operator reading
 * the result tell one story, and it names no provider: {@link ChunkIndexState}
 * reserves `index_error` for the provider layer's words, and this sentence is
 * the platform's own.
 */
export const KNOWLEDGE_INDEX_PARKED_WITHOUT_REASON =
  'the slice spent its index attempts with no recorded provider failure';

/**
 * A plan for a slice whose text moved — or which has no row yet.
 *
 * These are the only plans that carry index columns, and the values do not vary
 * because a new text is a new start: `pending`, because no embedding describes
 * the text that is now there, and a **zero** budget, because the attempts spent
 * on the text that is gone were attempts on a different slice. Spending the first
 * one belongs to the claim, and a row no claim has taken has spent nothing.
 */
export type ChunkTextPlan = {
  readonly action: 'insert' | 'reindex';
  readonly id: string;
  readonly indexStatus: 'pending';
  readonly indexAttempts: 0;
  readonly indexError: null;
  readonly reason: string;
};

/**
 * A plan for a slice whose text did not move.
 *
 * It carries **no index columns at all**, and that absence is the point: content
 * is the sweep's to write, index state is the claim's and the outcome's, and a
 * plan that could name an attempt count is a plan that can spend an attempt no
 * provider was asked about. See the module note.
 */
export type ChunkUntouchedPlan = {
  readonly action: 'queue' | 'skip' | 'park';
  readonly id: string;
  readonly reason: string;
};

/** What to write for one slice, and why. */
export type ChunkWritePlan = ChunkTextPlan | ChunkUntouchedPlan;

/**
 * Whether a plan writes index state — that is, whether the caller must write
 * `index_status`, `index_attempts`, `index_error` and `updated_at` alongside the
 * content, rather than leaving all four to the claim.
 *
 * The single definition of "this write starts the slice over", so the adapter
 * that writes the row, the sweep that reports it and the spec that proves the
 * rule do not each decide it for themselves.
 *
 * @param plan - The plan under test.
 * @returns `true` for `insert` and `reindex`, `false` for the rest.
 */
export function resetsIndexState(plan: ChunkWritePlan): plan is ChunkTextPlan {
  return plan.action === 'insert' || plan.action === 'reindex';
}

/**
 * Decide what one slice needs.
 *
 * The order of the branches is the whole design: **the text is compared before
 * the status**, so a parked row whose text changed is revived rather than left
 * parked, and an indexed row whose text changed is rebuilt rather than skipped.
 * Reading the status first would make `skipped` and `indexed` both sticky, which
 * is precisely the silent failure this module exists to prevent.
 *
 * Every branch below the text comparison is a plan that leaves the index columns
 * alone. That is what the three of them have in common, and the only difference
 * worth reporting is why: the row is already done, the row is still worth
 * claiming, or the row has nothing left to spend.
 *
 * @param incoming - The slice as the kernel just derived it.
 * @param stored - The row under the same id, or `null` when there is none.
 * @returns The action, the index columns to write when the text moved, and a
 * stable reason.
 */
export function planChunkWrite(
  incoming: KnowledgeChunkRow,
  stored: StoredChunkState | null,
): ChunkWritePlan {
  if (stored === null) {
    return {
      action: 'insert',
      id: incoming.id,
      indexStatus: 'pending',
      indexAttempts: 0,
      indexError: null,
      reason: CHUNK_WRITE_REASONS.insert,
    };
  }
  if (stored.contentHash !== incoming.contentHash) {
    // A rebuilt slice starts its budget over: the previous failures were about
    // text that no longer exists, so carrying their count forward would park a
    // slice that has never actually been attempted.
    return {
      action: 'reindex',
      id: incoming.id,
      indexStatus: 'pending',
      indexAttempts: 0,
      indexError: null,
      reason: CHUNK_WRITE_REASONS.reindex,
    };
  }
  if (stored.indexStatus === 'indexed') {
    return {
      action: 'skip',
      id: incoming.id,
      reason: CHUNK_WRITE_REASONS.skip,
    };
  }
  if (stored.indexStatus === 'skipped') {
    return {
      action: 'park',
      id: incoming.id,
      reason: CHUNK_WRITE_REASONS.park,
    };
  }
  if (stored.indexAttempts >= KNOWLEDGE_INDEX_MAX_ATTEMPTS) {
    // Reachable two ways, and both need this branch: {@link recordChunkIndexOutcome}
    // parks at the moment the last attempt fails, and a worker that died between
    // its claim and that write leaves `pending` at the ceiling instead. The row is
    // reported as parked; putting `skipped` on it is `parkExhausted`'s job, since
    // only the claim knows whether the attempt that reached the ceiling is still
    // running.
    return {
      action: 'park',
      id: incoming.id,
      reason: CHUNK_WRITE_REASONS.park,
    };
  }
  return {
    action: 'queue',
    id: incoming.id,
    reason: CHUNK_WRITE_REASONS.queue,
  };
}

/** The plans for one source row, plus the rows its absence orphans. */
export type SourceChunkWritePlan = {
  readonly plans: ReadonlyArray<ChunkWritePlan>;
  /**
   * Ids stored under this source that the kernel no longer produces.
   *
   * A slice disappears when the field it was cut from got shorter, so this is
   * the normal outcome of an edit rather than an anomaly. The job deletes them:
   * leaving them would let retrieval answer from text the source no longer
   * contains, and `knowledge_chunk_keywords` would be the only thing still
   * pointing at it.
   */
  readonly stale: ReadonlyArray<string>;
};

/**
 * Decide one source row's whole write set.
 *
 * Staleness is computed from the incoming ids, not from the slice count: a field
 * that grew by one slice and lost another is two independent changes, and a count
 * comparison would see neither.
 *
 * @param incoming - The slice rows the kernel derived for this source.
 * @param stored - Every row stored under this source's address.
 * @returns One plan per incoming slice, and the ids to delete.
 */
export function planSourceChunkWrites(
  incoming: ReadonlyArray<KnowledgeChunkRow>,
  stored: ReadonlyArray<StoredChunkState>,
): SourceChunkWritePlan {
  const byId = new Map(stored.map((row) => [row.id, row]));
  const plans = incoming.map((row) => planChunkWrite(row, byId.get(row.id) ?? null));
  const incomingIds = new Set(incoming.map((row) => row.id));
  const stale = stored.filter((row) => !incomingIds.has(row.id)).map((row) => row.id);
  return { plans, stale };
}

/**
 * Whether a stored slice is due for an index attempt.
 *
 * This is the predicate the sweep's `WHERE` clause reproduces. `indexed` and
 * `skipped` are terminal until the text moves — a parked slice is not retried,
 * because "it failed five times" is a conclusion, not a schedule — and a row
 * whose backoff has not elapsed is left for a later sweep.
 *
 * @param state - The stored row.
 * @param now - Evaluation instant (ISO).
 * @returns `true` when a sweep may spend an attempt on this row now.
 */
export function isChunkIndexDue(state: StoredChunkState, now: string): boolean {
  if (state.indexStatus === 'indexed' || state.indexStatus === 'skipped') {
    return false;
  }
  if (state.indexAttempts >= KNOWLEDGE_INDEX_MAX_ATTEMPTS) {
    return false;
  }
  const dueAt = Date.parse(state.updatedAt) + knowledgeIndexRetryDelayMs(state.indexAttempts);
  return Date.parse(now) >= dueAt;
}

/** One embedding attempt's result, as the provider layer reports it. */
export type IndexAttemptOutcome =
  { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string };

/** The `0011` index columns, as the job writes them back. */
export type ChunkIndexState = {
  readonly indexStatus: 'indexed' | 'failed' | 'skipped';
  readonly indexAttempts: number;
  readonly indexError: string | null;
  readonly indexedAt: string | null;
};

/**
 * Record what one claimed attempt produced.
 *
 * Takes the **post-claim** counter, not the pre-claim one: the claim already
 * spent the attempt (see the module note), so incrementing here would spend it
 * twice and park a slice after three failures instead of five.
 *
 * The last failure of the budget parks the slice rather than marking it `failed`,
 * so the sweep's `WHERE` and the operator's status query agree on which rows are
 * finished. The reason text is written to `index_error` as given — it comes from
 * the provider layer, which is responsible for keeping payloads out of it.
 *
 * @param claimedAttempts - `indexAttempts` as the claim wrote it.
 * @param outcome - The attempt's result.
 * @param now - Completion instant (ISO), used as `indexed_at` on success.
 * @returns The columns to write.
 */
export function recordChunkIndexOutcome(
  claimedAttempts: number,
  outcome: IndexAttemptOutcome,
  now: string,
): ChunkIndexState {
  if (outcome.ok) {
    return {
      indexStatus: 'indexed',
      indexAttempts: claimedAttempts,
      indexError: null,
      indexedAt: now,
    };
  }
  return {
    indexStatus: claimedAttempts >= KNOWLEDGE_INDEX_MAX_ATTEMPTS ? 'skipped' : 'failed',
    indexAttempts: claimedAttempts,
    indexError: outcome.reason,
    indexedAt: null,
  };
}
