/**
 * The rerank kernel: fusion's ordered slices and a cross-encoder's scores in,
 * one reordered list out.
 *
 * The step after {@link fuseRecall} and before anything is read back. It is a
 * pure function over two arrays — no provider, no socket, no clock — so the
 * ordering rule can be stated and falsified without a model running, which is
 * the same reason the fusion kernel exists as a module rather than as four lines
 * inside the retrieval service.
 *
 * **Why a cross-encoder is allowed where fusion refused to mix scores.** The
 * fusion kernel's whole argument is that the two legs' numbers are different
 * units and adding them would let the larger-numbered leg decide the answer. This
 * module sorts by a score, and the difference is that there is only *one*
 * score here. The reranker is not a third opinion to combine — it is the same
 * question ("how well does this slice answer this query?") asked once, by
 * something that read both strings, over every candidate. There is nothing to
 * weigh it against, so nothing is being silently outvoted.
 *
 * **Ties fall back to the fused order, and that is the opposite of the fusion
 * tie-break on purpose.** `fuseRecall` breaks a tie on `chunk.id`, because it has
 * nothing better: two legs that each ranked a slice once have said everything
 * they have to say. Here there *is* something better — the order the caller
 * already had. Two candidates the cross-encoder scored identically are two
 * candidates the rank fusion ranked differently, and that difference is evidence
 * from the legs, where a slice's id is evidence from nowhere. So this sort is
 * stable over its input and the input is ordered by design.
 *
 * **A failure to rerank is the fused order, not an empty answer.** The provider
 * reports rather than throws, and a caller holding a failure calls this with
 * nothing and gets its list back unchanged. That is not a degraded fallback
 * invented here — it is the answer every deployment gave before a reranker
 * existed, and the alternative (returning nothing because the *orderer* was
 * down) would turn a quality feature's outage into a retrieval outage.
 *
 * **The scores are aligned by position and that is the caller's contract.**
 * `scores[i]` belongs to `fused[i]`. The provider refuses an answer that does
 * not cover exactly the documents it was sent, so a misalignment cannot reach
 * here through the read path — the length check below is for a caller that
 * computed its own scores, and it returns the fused order rather than guessing
 * at a pairing. Attaching a score to the wrong slice would not degrade the
 * ranking, it would invert it.
 */

import type { FusedRecallHit } from './knowledge-fusion';

/**
 * How many fused slices are handed to the reranker.
 *
 * The reranker can only reorder what it is given, so this is the ceiling on the
 * reranker's usefulness: a slice that fusion ranked 21st cannot be promoted by
 * anything downstream. It is twice {@link KNOWLEDGE_FUSION_TOP} per leg because
 * both legs recalled up to twenty — a candidate that one leg ranked 20th and the
 * other never saw is exactly the kind of slice fusion buries and a cross-encoder
 * can rescue, and it is the case this bound exists to admit.
 *
 * It is bounded rather than generous because a rerank is one forward pass *per
 * candidate*: the cost is linear here and paid on every read, in front of an
 * agent who is waiting. Twenty is where the measurements say the curve flattens;
 * see `eval/reports/` for the A/B that chose it.
 */
export const KNOWLEDGE_RERANK_CANDIDATES = 20;

/**
 * Reorder fused slices by a cross-encoder's scores.
 *
 * Pure and total. Every input produces an answer, the answer is a permutation of
 * the input under the precondition, and the same input always produces the same
 * answer — the stability of the sort is what makes that true rather than likely.
 *
 * @param fused - The fused slices, best first, as {@link fuseRecall} returned them.
 * @param scores - One score per slice, aligned by position. Pass an empty array
 *   (or the fused list's own order's worth of nothing) to keep the fused order —
 *   which is what a caller does when the provider failed.
 * @returns The same slices, best score first, ties in their fused order.
 */
export function applyRerankOrder(
  fused: ReadonlyArray<FusedRecallHit>,
  scores: ReadonlyArray<number>,
): ReadonlyArray<FusedRecallHit> {
  if (scores.length !== fused.length || !scores.every((score) => Number.isFinite(score))) {
    // See the module note: reaching here through the read path is a bug in the
    // provider's alignment check, and the safe answer is the order we already
    // had rather than a pairing this function would have to invent.
    //
    // A non-finite score is refused for a different reason. `NaN` compares false
    // against everything, so a sort that let one through returns an order that
    // depends on the engine's internals rather than on a decision — and "the top
    // five" has to mean one thing, which is exactly the argument that gives
    // `fuseRecall` its tie-break. The provider refuses one too; the check is
    // here as well because this is a public kernel and a caller that computed
    // its own scores never went through that provider.
    return fused;
  }

  // Sorted by index, then mapped back, so the sort is over positions and the
  // comparator's stability guarantee applies to the *fused* order rather than to
  // whatever order a decorated array happened to be built in.
  return fused
    .map((hit, index) => ({ hit, score: scores[index] as number }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.hit);
}
