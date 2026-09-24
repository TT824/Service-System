/**
 * The embedding provider boundary: text in, a vector or a recorded failure out.
 *
 * This is the only thing in the index job that is not ours. Everything below it —
 * which slices exist, which are due, what an attempt means — is decided by the
 * kernel and the state machine; everything above it is a port the sweep is handed
 * and does not reach behind. The interface is two members wide on purpose:
 *
 *   * **`model` is the provider's identity, and it is part of a row's address.**
 *     `knowledge_chunk_embeddings_unique` is `(tenant_id, chunk_id, model)`, so
 *     the name a provider reports here decides which row its vectors live in —
 *     and a second model writes beside the first rather than over it, which is
 *     what makes "recognise the old vectors and rebuild" answerable. A provider
 *     that reports a name it did not use has silently corrupted the rebuild path
 *     in a way nothing else in the system can detect.
 *   * **`embed` takes the slice text and nothing else.** `content_hash` covers
 *     `content` alone (see the kernel note), so an embedding that read a
 *     neighbour's context would put a vector under a hash that does not describe
 *     it — and the hash is the only thing that says whether a vector is stale.
 *     The signature is this rule, stated once.
 *
 * The result is a union rather than an exception because a provider failure is an
 * expected outcome of the job, not an interruption of it: `recordChunkIndexOutcome`
 * needs a code and a reason to write down, and a caller that had to catch and
 * classify would be re-inventing the shape on every call site. The processor
 * defends against a throw anyway — provider client libraries throw — but a
 * provider that reports its own failures reports them precisely, and that is what
 * lands in `index_error`.
 *
 * **A caller may have no provider.** No model configured means there is nothing to
 * embed with, which `AppConfig.embedding` states as a supported state rather than
 * as a misconfiguration. The absence is expressed as
 * `EmbeddingProvider | undefined` rather than as a stub that fails every call,
 * because the two have opposite consequences — for the sweep, a stub spends an
 * attempt and parks the slice while an absent provider spends nothing and leaves
 * it `pending` (see `chunk-index-processor`); for a *read*, an absent provider
 * answers nothing while a stub that failed every call would report an outage on
 * every query. Which one is right is the caller's decision, and the type keeps it
 * from being made by accident.
 *
 * **This port lives in the shared package because its two callers do not.** The
 * sweep that fills `knowledge_chunk_embeddings` runs in the Worker; the recall leg
 * that reads those vectors runs in the API, and both have to mean the same thing
 * by "the model this row belongs to" — the model name addresses a row, so a query
 * embedded by a different model answers with distances that describe nothing. The
 * shared binding rule beside the only implementation
 * (`createOllamaEmbeddingProvider`) is the other half of that agreement.
 */

/** One embedding attempt's result, as the provider reports it. */
export type EmbeddingResult =
  | { readonly ok: true; readonly vector: ReadonlyArray<number> }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/** The outbound half of the index job. */
export interface EmbeddingProvider {
  /**
   * The embedding model whose rows this provider's vectors belong to.
   *
   * Written to `knowledge_chunk_embeddings.embedding_model`, and part of the
   * `(tenant_id, chunk_id, model)` identity: two names are two rows.
   */
  readonly model: string;

  /**
   * Embed one slice's text.
   *
   * @param content - The slice text, exactly as `knowledge_chunks.content` holds
   *   it, and nothing else.
   * @returns The vector, or a failure the sweep records against the slice.
   */
  embed(content: string): Promise<EmbeddingResult>;
}
