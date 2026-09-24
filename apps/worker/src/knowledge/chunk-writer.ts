/**
 * The index job's write side: one source row in, one transaction out.
 *
 * `index-source` decides what a source row *means*, the kernel decides which
 * rows it *produces*, and `knowledge-index-state` decides what each of those
 * rows *needs*. This module is the last step — putting that answer into
 * `knowledge_chunks` — and it is the step where the ways of being wrong are
 * silent, because every one of them succeeds:
 *
 * - **`INSERT` where the address should be updated.** `0011`'s
 *   `knowledge_chunks_slice_unique` exists so that re-indexing a source updates
 *   its slices in place (see the kernel note on `deriveChunkId`). An insert
 *   succeeds on the first pass over any source and only fails on the second —
 *   and the second pass is the normal case, not the exception: editing one
 *   answer re-indexes its whole source. The damage is not an error but a second
 *   copy of every slice, whose keywords hang off the new ids while the old ones
 *   stay behind.
 * - **A stale slice left behind.** A field that got shorter produces fewer
 *   slices, so a slice can stop being produced while its row remains — text the
 *   source no longer contains, still answering customers. Only the state
 *   machine's `stale` list knows which ids those are, which is why deleting them
 *   is this module's job and not a `WHERE` clause's.
 * - **A stale keyword left behind.** The same argument one level down, and the
 *   same silence: keywords are derived from the slice's text, so rewriting
 *   黑色 as 白色 leaves a row still saying 黑色 unless the keyword set is
 *   *replaced* with the text rather than added to. An upsert alone never
 *   removes anything.
 * - **A half-applied source.** A slice and its keywords are one answer to one
 *   question. A failure between the two halves leaves the new text searchable
 *   through the old keywords, which reads exactly like a working index.
 *
 * So the port has two methods, and {@link indexSourceInto} is the only order in
 * which they are called: read what is stored under the source's address, ask the
 * state machine what that implies, hand the whole answer to one write. The
 * adapter behind the port owns the SQL and the transaction; everything above it
 * is a function of rows that a spec can drive without a database — the same
 * split the kernel and `index-source` already use.
 *
 * **The read is by address, not by scope.** `listStoredChunks` is asked for one
 * `(tenant, sourceKind, sourceId)` and never for a store. That is exactly
 * `knowledge_chunks_slice_unique`'s tuple minus the field and the position, and
 * it is deliberately wider than the source's current store: a shortcut that
 * moves from the whole merchant to one store keeps its address, so the rows
 * written at the old scope are the rows the write must find and correct.
 */

import {
  buildKnowledgeIndex,
  planSourceChunkWrites,
  type ChunkWritePlan,
  type IndexSourceInput,
  type IndexedSourceKind,
  type KnowledgeChunkRow,
  type KnowledgeKeywordRow,
  type SourceChunkWritePlan,
  type StoredChunkState,
} from '@kefu/core';

/** The three columns every slice of one source row shares: its address. */
export type ChunkSourceAddress = {
  readonly tenantId: string;
  readonly sourceKind: IndexedSourceKind;
  readonly sourceId: string;
};

/**
 * One source row's whole write, as the port receives it.
 *
 * The three list fields are the kernel's and the state machine's own outputs,
 * passed through unmerged: `chunks` carry the content columns, `plans` carry the
 * index columns, and they are joined on `id` where the SQL is written. Nothing
 * is pre-combined here, because a combination step would be a second place that
 * decides which action a slice gets.
 */
export type SourceChunkWrite = {
  readonly address: ChunkSourceAddress;
  /** The slices as derived, one `plan` per element, same ids. */
  readonly chunks: ReadonlyArray<KnowledgeChunkRow>;
  /** One plan per element of `chunks`; see {@link planSourceChunkWrites}. */
  readonly plans: ReadonlyArray<ChunkWritePlan>;
  /** Every keyword of every slice above. */
  readonly keywords: ReadonlyArray<KnowledgeKeywordRow>;
  /** Slice ids stored under this address that the kernel no longer produces. */
  readonly stale: ReadonlyArray<string>;
};

/** The durable side of the index job: stored slices, and one source's write. */
export interface KnowledgeChunkWriter {
  /**
   * Every slice stored under one source's address, as the state machine reads
   * it — indexed, pending, failed and parked alike, because a parked slice whose
   * text moved has to be revived rather than left parked.
   *
   * @param address - The source whose stored rows are read.
   * @returns One row per stored slice, possibly empty.
   */
  listStoredChunks(address: ChunkSourceAddress): Promise<ReadonlyArray<StoredChunkState>>;

  /**
   * Replace one source row's slices and keywords with the given set, as one
   * transaction: the upserts, the deletion of `stale`, and the keyword rewrite
   * either all happen or none do.
   *
   * @param write - The rows, the plans, the keywords and the ids to delete.
   */
  writeSourceChunks(write: SourceChunkWrite): Promise<void>;
}

/**
 * Index one source row, end to end: build, compare, write.
 *
 * This is the unit the sweep repeats and the unit the integration suite drives,
 * so there is one sequence rather than one per caller — the three calls here are
 * only correct in this order, and a caller that reordered them (writing before
 * reading, say) would silently classify every stored slice as new.
 *
 * It is deliberately not a repository method: it names no SQL, which is what
 * lets a spec hand it a port that counts calls instead of a database.
 *
 * `vocabulary` is not supplied here. Passing no vocabulary means the keyword
 * pass extracts only the labelled pairs the slice text itself carries, which is
 * what the kernel already does by default; sourcing a vocabulary per tenant is a
 * separate decision (B02.3 leftover #3) that would otherwise be made, silently
 * and for every tenant, by this line.
 *
 * @param writer - The durable writer for the slices.
 * @param input - The source row, already mapped by `index-source`.
 * @returns The plan the write followed, for a caller that logs or asserts it.
 */
export async function indexSourceInto(
  writer: KnowledgeChunkWriter,
  input: IndexSourceInput,
): Promise<SourceChunkWritePlan> {
  const address: ChunkSourceAddress = {
    tenantId: input.tenantId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
  };
  const rows = buildKnowledgeIndex(input);
  const stored = await writer.listStoredChunks(address);
  const plan = planSourceChunkWrites(rows.chunks, stored);

  await writer.writeSourceChunks({
    address,
    chunks: rows.chunks,
    plans: plan.plans,
    keywords: rows.keywords,
    stale: plan.stale,
  });

  return plan;
}
