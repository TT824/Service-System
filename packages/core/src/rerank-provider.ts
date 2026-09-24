/**
 * The rerank provider boundary: a question and its candidate slices in, a score
 * per candidate out.
 *
 * This is the third thing in the retrieval path that is not ours, after the two
 * embedding uses, and it is the only one that reads a question and a slice
 * *together*. The two recall legs and the fusion between them are all,
 * deliberately, cheap arithmetic over things that were computed separately: a
 * term count and a cosine distance, neither of which has ever seen a query and a
 * slice in the same expression. That is what makes them fast, and it is also
 * what makes "有棵树内裤 黑色" come back with the grey one — nothing in the
 * pipeline can tell that the colour word in the question is the thing that
 * decides, because nothing in it ever looked at both strings at once.
 *
 * A cross-encoder is the thing that looks. Its output is therefore not another
 * rank to fuse — it is a *replacement* for the ordering, computed by something
 * that read the actual pair. Fusion still runs first, because the cross-encoder
 * is O(candidates) forward passes and can only be afforded over a short list;
 * the short list is what fusion is for.
 *
 * **The scores are aligned to the documents, not to a ranking.** `scores[i]`
 * describes `documents[i]`, always, and the caller sorts. The alternative — the
 * provider returning a ranked list — would put the ordering decision inside an
 * implementation that is only supposed to report what the model said, and every
 * caller that wanted a tie-break of its own would have to re-derive the
 * positions from indices anyway. Aligning by position makes a partial answer
 * impossible to misread: an answer that describes four of five documents is
 * refused rather than silently attached to the wrong slices.
 *
 * **The magnitude carries no promise.** These are raw cross-encoder logits:
 * unbounded, not probabilities, and comparable only within one call. Nothing
 * here says `-3.1` is "irrelevant"; it says only that it scored below whatever
 * scored `2.4` in the same batch. A caller that stored one and compared it to a
 * later call's would be comparing two different scales — the same mistake the
 * fusion kernel refuses by reading ranks instead of scores, and the reason this
 * doc says it out loud is that scores *look* more meaningful than ranks do.
 *
 * **A caller may have no provider**, exactly as with embeddings: a deployment
 * that runs no reranker is a deployment whose answer is the fused order, which
 * is a working answer rather than an outage. The absence is
 * `RerankProvider | undefined` and not a stub that fails every call, because a
 * read that has no reranker must return the fused slices while a read whose
 * reranker is *down* must return them too but say so — and only the caller can
 * tell those two apart.
 *
 * **It lives in `@kefu/core` for the embedding port's reason.** The API asks it
 * and the evaluation harness asks it; the model name in a request has to mean
 * the same thing on both sides, and the shape of an answer has to be the same
 * shape or the A/B measures the harness instead of the ranker.
 */

/**
 * Injection token carrying the bound {@link RerankProvider}, or `undefined`.
 *
 * It lives beside the port rather than in the Nest module that binds it, for the
 * same reason {@link GENERATION_PROVIDER} does: the *service* that injects it
 * cannot import from the module that provides it without the module importing
 * the service back, and a token is exactly the thing that has no dependencies of
 * its own to justify the cycle.
 *
 * `undefined` is a value here, not an absence — a deployment that configured no
 * reranker gets no provider, and the read path answers with the fused order,
 * which is the answer every deployment gave before a reranker existed. A
 * reranker that is configured but *down* is a different fact, and the service
 * reports it; the two must not collapse into the same silence.
 */
export const RERANK_PROVIDER = Symbol('RERANK_PROVIDER');

/** One rerank attempt's result, as the provider reports it. */
export type RerankOutcome =
  | { readonly ok: true; readonly scores: ReadonlyArray<number> }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/** The outbound half of a reranked read. */
export interface RerankProvider {
  /**
   * The reranker this provider believes it is talking to.
   *
   * A label rather than an address — nothing is stored under it, and no row's
   * identity depends on it. It is sent with every request so that a service
   * running a different model can refuse to answer instead of returning scores
   * that describe a model the caller did not ask for.
   */
  readonly model: string;

  /**
   * Score each candidate against the question.
   *
   * @param query - The buyer's question, verbatim.
   * @param documents - The candidate slice texts, in the caller's own order.
   * @returns One score per document, aligned by position, or a failure the
   *   caller degrades from.
   */
  rerank(query: string, documents: ReadonlyArray<string>): Promise<RerankOutcome>;
}
