/**
 * Semantic recall: the buyer's question, answered by meaning rather than by words.
 *
 * This is the second of SDD-014's two recall legs. It reads
 * `knowledge_chunk_embeddings` — the `0011_knowledge_index` table the Worker's
 * sweep fills — and it is a *read*: nothing here writes, reindexes or embeds a
 * slice. The one thing it does compute is the **question's** vector, because a
 * vector search needs a vector to search with, and that is the reason the
 * embedding provider had to become a shared port rather than the Worker's
 * property: `apps`, not the kernel, is where the query-side embedding happens.
 *
 * Three properties of the index are what this leg is built on:
 *
 *   * **The model name is part of a row's address.** `knowledge_chunk_embeddings`
 *     is unique on `(tenant_id, chunk_id, embedding_model)`, so a slice can have
 *     several vectors and each one belongs to the model that produced it. A query
 *     embedded by model A must therefore be compared against A's rows only:
 *     distances between two different models' vectors are arithmetic on unrelated
 *     coordinate systems, and they would rank slices by nothing at all.
 *   * **A vector describes the text it was computed from, and `content_hash` says
 *     which text that was.** A slice that has been edited since it was embedded
 *     holds a vector of the older text — the rewrite that produced the edit names
 *     the slice `pending` and re-embeds it later, so between those two moments the
 *     vector is stale while looking perfectly usable. Comparing the stored hash
 *     with the slice's own is what refuses that window; the alternative is a
 *     recalled slice that is answered with a vector describing text that is no
 *     longer there.
 *   * **There is no index on the vector column, so every candidate's distance is
 *     computed.** `0011` deliberately leaves the dimension undeclared so the model
 *     is not locked in, and a vector index needs the dimension. The three indexes
 *     the table does have are all btree — `_pkey`, `_unique` on
 *     `(tenant_id, chunk_id, embedding_model)` and `_model_idx` on
 *     `(tenant_id, embedding_model, chunk_id)` — so the scan reads this tenant's
 *     vectors for this model and the distances are computed row by row, with a
 *     top-N heapsort on top. Measured on the development machine
 *     (`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)`, this block's record, one real
 *     1024-dimension vector per slice): **100 / 300 / 600 slices cost 0.54 / 1.44 /
 *     2.37 ms**, near-linear, because the work grows with the number of slices in
 *     scope rather than logarithmically — SDD-014's P95 budget has no index behind
 *     it on this path, and the fix is a declared dimension, which is a migration
 *     and a model decision.
 *
 *     Two things about that measurement are worth as much as the numbers. It is
 *     **statistics-sensitive**: the same statement, run against the same 300-slice
 *     fixture before the freshly inserted rows had been `ANALYZE`d, planned as a
 *     nested loop whose join filter discarded 44850 rows and took 9.9 ms — seven
 *     times slower on the same bytes. And a single earlier figure of 3.2 ms was
 *     recorded for this path from a different fixture; it is superseded rather than
 *     averaged, because a cost quoted without its fixture and its statistics is not
 *     a measurement of anything.
 *
 * **Scope and rejection are the keyword leg's, restated because they must not
 * diverge.** A slice may answer only if it is this tenant's, `enabled`, and either
 * this store's or a tenant-level slice shared by every store; and a value the
 * buyer rejected removes the slices that carry it as a keyword, on both legs — a
 * black hoodie that the keyword leg refuses must not come back through this one
 * merely because the question's *meaning* was close to it.
 *
 * **The result carries why it is empty.** The keyword leg answers with an array,
 * because a question that parsed to nothing is a complete answer. This leg has a
 * dependency the other one does not — a model server — so "no hits" and "no
 * provider configured" and "the model server did not answer" are three different
 * facts, and a caller that cannot tell them apart reports an outage on every
 * request of a tenant that has simply not configured a model. {@link
 * SemanticRecallResult} keeps them apart.
 *
 * **The score is a similarity, not a judgement.** `1 - (embedding <=> query)`:
 * `1` is the same direction, `-1` the opposite, and the magnitudes are uninteresting
 * because the fusion step (RRF, the next block) replaces scores with ranks.
 * Nothing outside this leg may read the number as a measure of relevance.
 */

import type { RecalledChunk } from '@kefu/core';

/**
 * How many slices one semantic query may answer with.
 *
 * The design's default (`语义召回…默认召回 Top 20`), and the same bound the keyword
 * leg and the fusion step consume — one number, so a fused list cannot be capped
 * by the smaller of two unequal ones.
 */
export const KNOWLEDGE_SEMANTIC_RECALL_TOP = 20;

/**
 * One recalled slice and how close the model found it.
 *
 * `mode` is the fusion step's business: it is how a hit says which leg produced
 * it, and the two legs' scores are deliberately not comparable — a similarity and
 * a weighted count of matched terms mean different things, which is exactly why
 * the fusion ranks them instead of adding them.
 */
export type SemanticRecallHit = {
  readonly chunk: RecalledChunk;
  readonly mode: 'semantic';
  /** Cosine similarity between the question and the slice, `1` is closest. */
  readonly score: number;
};

/**
 * Why this leg answered nothing, when it answered nothing for a reason.
 *
 * The codes are the provider's own (`embedding_service_unreachable`, …),
 * {@link NO_EMBEDDING_PROVIDER_CODE}, or {@link EMBEDDING_PROVIDER_THREW_CODE};
 * the reason is written for an operator, so it carries no payload (see the provider
 * port).
 */
export type SemanticRecallUnavailable = {
  readonly code: string;
  readonly reason: string;
};

/** The code carried when the deployment has configured no embedding model. */
export const NO_EMBEDDING_PROVIDER_CODE = 'no_embedding_provider';

/**
 * The code carried when the provider broke its contract by throwing.
 *
 * The port says a failure is a value, so this should be unreachable — which is why
 * it is a code of its own rather than a fold into the provider's failures. A
 * thrown error is a *different kind of fact* from a reported one: the first is a
 * bug in a provider, the second is the world telling the provider no. Keeping them
 * apart is what lets an operator tell "the model server is down" from "the provider
 * is broken", and it is what keeps this leg's refusal to answer with an empty list
 * honest — see the adapter's note on the narrow catch.
 */
export const EMBEDDING_PROVIDER_THREW_CODE = 'embedding_provider_threw';

/** One semantic recall: whose scope, what was asked, and how many to answer with. */
export type SemanticRecallInput = {
  readonly tenantId: string;
  /** The store being answered for. Tenant-level slices are visible to it. */
  readonly storeId: string;
  /**
   * The buyer's question, verbatim.
   *
   * Verbatim because this is the text the model embeds: the kernel's parse is the
   * keyword leg's input, and a question rewritten into its keywords would be
   * embedded as a bag of words — which is the leg the *other* implementation
   * already is.
   */
  readonly text: string;
  /**
   * The values the buyer rejected, as the kernel parsed them.
   *
   * Plain strings rather than the parse itself: this leg applies them as a filter
   * and has no use for dimensions or free-text terms. They are the same values the
   * keyword leg is handed, so both legs refuse the same slices.
   */
  readonly negations: ReadonlyArray<string>;
  /** Defaults to {@link KNOWLEDGE_SEMANTIC_RECALL_TOP}. */
  readonly limit?: number;
};

/** One semantic recall's answer: the hits, and why there were none if there was a reason. */
export type SemanticRecallResult = {
  readonly hits: ReadonlyArray<SemanticRecallHit>;
  /** `null` when the leg ran; a reported reason when it could not. */
  readonly unavailable: SemanticRecallUnavailable | null;
};

/**
 * The semantic recall leg.
 *
 * A port rather than a service so the retrieval pipeline depends on the answer
 * and not on PostgreSQL or on a model server, and so the durable half (the vector
 * statement) has exactly one implementation to keep honest.
 */
export interface KnowledgeSemanticRecall {
  /**
   * Recall the slices of one store that answer one question by meaning.
   *
   * @param input - The scope, the question, the rejected values and the bound.
   * @returns The hits, closest first, with the slice id as the tie-breaker — or no
   *   hits and the reason there are none.
   */
  recall(input: SemanticRecallInput): Promise<SemanticRecallResult>;
}

/** Injection token for {@link KnowledgeSemanticRecall}. */
export const KNOWLEDGE_SEMANTIC_RECALL = Symbol('KNOWLEDGE_SEMANTIC_RECALL');
