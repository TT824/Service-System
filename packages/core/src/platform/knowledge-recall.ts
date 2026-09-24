/**
 * What recall answers with: the slice, the leg that found it, and the reason a
 * leg could not answer at all.
 *
 * This is the vocabulary the two recall legs of SDD-014 share, and the reason it
 * is a module of its own is the same reason `knowledge-query` is: two
 * implementations answering the same question have to agree on the answer's
 * shape before either one is written.
 *
 * **Why it sits in the kernel package rather than beside a leg.** {@link
 * RecalledChunk} was declared by the keyword leg, and the semantic leg imported
 * it *from* the keyword leg — two peers with a dependency between them that
 * neither port's comment admits to. The module that broke the tie is the fusion
 * kernel: it lives in `platform/` with the other five kernels (chunker, keywords,
 * indexer, index-state, query), and a kernel cannot import from a leg. So the
 * shape moves here, which is where it belonged from the start — it is what a
 * slice *is* when read back, not what one leg does with it.
 *
 * **Two fields are honest about their nullability.** `storeId` is `null` for a
 * tenant-level slice — knowledge that belongs to no single store, shared by all
 * of them — and `scopeType` says the same thing in the schema's own vocabulary;
 * `0011`'s `knowledge_chunks_scope_check` makes that pair the only two states a
 * row can be in. `sourceId` is a **polymorphic text with no foreign key**: the
 * indexer writes `(tenant_id, source_kind, source_id)` as a triple precisely
 * because the parent table varies by kind, so a caller walking from a slice back
 * to its source row must carry the tenant itself, because no constraint will do
 * it. That is the hole the retrieval path's title lookup has to close by hand,
 * and closing it is what makes the two legs' `WHERE tenant_id` mean anything.
 */

/**
 * One `knowledge_chunks` row, as it comes back out.
 *
 * The write-side shape is `KnowledgeChunkRow` in `knowledge-indexer`: same
 * table, opposite direction. That one is derived and ready to be inserted
 * (`contentHash`, `indexStatus: 'pending'`, `enabled`), and it knows its
 * `chunkType` is one of the chunker's values. This one is what a `SELECT`
 * returned, so `scopeType` / `sourceKind` / `chunkType` are the columns' own
 * strings: a read has no business narrowing what the index wrote, and a slice
 * whose kind this build does not recognise is a fact the caller should be able
 * to see rather than a cast.
 */
export type RecalledChunk = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly scopeType: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly sourceField: string;
  readonly chunkType: string;
  readonly chunkIndex: number;
  readonly content: string;
};

/**
 * Which leg recalled a slice.
 *
 * Two legs answer SDD-014's one question, and "which one" is not diagnostics —
 * it is part of the answer (the 可解释 requirement), and it is what lets the
 * fusion step tell a slice both legs agreed on from one only a single leg found.
 */
export type RecallLegName = 'keyword' | 'semantic';

/**
 * Why a leg answered nothing, when it answered nothing for a reason.
 *
 * The codes are the embedding provider's own (`embedding_service_unreachable`,
 * …), `NO_EMBEDDING_PROVIDER_CODE`, or `EMBEDDING_PROVIDER_THREW_CODE`; the
 * reason is written for an operator. This is the shape the semantic leg reports
 * and the fusion step passes through untouched — see {@link RecalledChunk} for
 * why the keyword leg has none: a question that parsed to nothing is a complete
 * answer, while a vector search that could not run is not.
 */
export type RecallUnavailable = {
  readonly code: string;
  readonly reason: string;
};
