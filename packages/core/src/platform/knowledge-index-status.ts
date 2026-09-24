/**
 * The index status read model: what a tenant's slices are doing, and why.
 *
 * `knowledge-index-state.ts` answers "what should happen to this slice"; this
 * module answers "what is happening to this tenant's slices", which is the
 * question SDD-013's acceptance criterion names ("支持异步重试和索引状态查询") and the
 * one an operator actually asks — usually right after retrieval answered nothing
 * and the reason is that every slice is parked.
 *
 * Two decisions live here rather than in the SQL that produces the rows:
 *
 * - **Every state is always present.** `GROUP BY index_status` returns the states
 *   that *have* rows, so a tenant with nothing parked would report a missing
 *   `skipped` key instead of a zero — and a field that disappears when it is zero
 *   is read as "unknown" by every consumer. {@link
 *   summarizeKnowledgeIndexCounts} zero-fills, so `skipped: 0` is a fact.
 * - **A state `0011` does not allow is refused, not counted.** The column's
 *   check constraint lists four states; a fifth arriving from a query means the
 *   migration and this code disagree, and adding it into a count would report a
 *   number nobody can act on. The same goes for a count that is not a
 *   non-negative integer: a NaN in the total is worse than a failed read.
 */

import type { IndexedSourceKind } from './knowledge-chunker';
import { isChunkIndexStatus, type ChunkIndexStatus } from './knowledge-index-state';

/**
 * How many recent failures a status read reports.
 *
 * A bound rather than a page: this read answers "what is wrong right now", and a
 * tenant with four hundred parked slices has one problem and four hundred rows
 * saying so. Handing the operator all four hundred is a different endpoint's job.
 */
export const KNOWLEDGE_INDEX_FAILURE_LIMIT = 5;

/** Which of a tenant's slices a status read covers. */
export type KnowledgeIndexStatusFilter = {
  /**
   * Only slices of this store. Merchant-level slices (`store_id IS NULL`) are
   * excluded, exactly as they are for every other store-scoped read.
   */
  readonly storeId?: string;
  readonly sourceKind?: IndexedSourceKind;
  readonly sourceId?: string;
  /** Only slices in this state. `total` then counts the same narrowed set. */
  readonly indexStatus?: ChunkIndexStatus;
};

/** How many slices sit in each state, and how many in all. */
export type KnowledgeIndexStatusCounts = {
  readonly pending: number;
  readonly indexed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
};

/** One recorded failure, still attached to the slice that recorded it. */
export type KnowledgeIndexFailure = {
  readonly chunkId: string;
  /**
   * `failed` still has budget and will be retried; `skipped` is the kernel's
   * verdict that the budget is spent. Both carry a reason, and telling them
   * apart is the difference between waiting and intervening.
   */
  readonly indexStatus: 'failed' | 'skipped';
  readonly sourceKind: IndexedSourceKind;
  readonly sourceId: string;
  readonly indexAttempts: number;
  readonly indexError: string | null;
  readonly updatedAt: string;
};

/** One status read's answer. */
export type KnowledgeIndexStatusSummary = {
  readonly counts: KnowledgeIndexStatusCounts;
  /**
   * Vectors stored for the same slice set. An `indexed` slice with no vector
   * under it is a slice retrieval searches for and never finds, so this number
   * is reported next to `counts.indexed` rather than trusted to equal it.
   */
  readonly embeddings: number;
  readonly recentFailures: ReadonlyArray<KnowledgeIndexFailure>;
};

/** One row of the `GROUP BY index_status` aggregate. */
export type KnowledgeIndexCountRow = {
  /** As the column holds it; narrowed by {@link summarizeKnowledgeIndexCounts}. */
  readonly indexStatus: string;
  readonly count: number;
};

/**
 * Assemble the counts from the aggregate's rows.
 *
 * @param rows - One row per state that has slices; a state with none is absent,
 * and a state may appear more than once without changing the answer.
 * @returns The four states, with a zero where the aggregate was silent, and
 * `total` as their sum.
 * @throws When a row names a state `0011`'s check constraint does not allow, or
 * carries a count that is not a non-negative integer.
 */
export function summarizeKnowledgeIndexCounts(
  rows: ReadonlyArray<KnowledgeIndexCountRow>,
): KnowledgeIndexStatusCounts {
  const counts: Record<ChunkIndexStatus, number> = {
    pending: 0,
    indexed: 0,
    failed: 0,
    skipped: 0,
  };
  for (const row of rows) {
    if (!isChunkIndexStatus(row.indexStatus)) {
      throw new Error(`index status ${row.indexStatus} is not one of the four 0011 allows`);
    }
    if (!Number.isSafeInteger(row.count) || row.count < 0) {
      throw new Error(`index status ${row.indexStatus} reported a count of ${row.count}`);
    }
    counts[row.indexStatus] += row.count;
  }
  return Object.freeze({
    ...counts,
    total: counts.pending + counts.indexed + counts.failed + counts.skipped,
  });
}
