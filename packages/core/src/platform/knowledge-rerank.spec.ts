/**
 * What rerank ordering does with a cross-encoder's scores, and the ways it can
 * look right while being wrong.
 *
 * The function is a sort, and a sort is the easiest kind of code to test badly:
 * almost any input comes out "sorted", so a suite that only checks the order is
 * ascending proves nothing about the rules that decide the cases where two
 * candidates are *not* separated by their scores. The cases here are chosen for
 * that: each one is an input where a plausible implementation returns a
 * different list, and several of them return a list that still looks sorted.
 *
 *   * **The tie-break.** Two candidates with equal scores must come out in the
 *     order fusion put them, not in slice-id order. The fixture is built so the
 *     two disagree — the *worse* id is fused first — which is the only way the
 *     assertion can tell the two rules apart.
 *   * **Alignment.** `scores[i]` describes `fused[i]`. The fixture is one where
 *     reading the scores as a ranking rather than as positions produces a
 *     different answer, so the assertions discriminate the named path.
 *   * **A failure is the fused order.** An empty or misaligned score list is
 *     what a caller passes when the provider failed, and the answer is the order
 *     it already had — not an empty list, and not a crash.
 *   * **Determinism under an unusable score.** A `NaN` compares false against
 *     everything, so a sort that lets one through returns an order that depends
 *     on the engine's internals. The kernel refuses the whole list instead,
 *     which is the same reading `fuseRecall`'s tie-break exists to guarantee.
 *   * **The candidate bound is a bound on the answer.** If the reranker is shown
 *     fewer slices than the answer needs, the answer gets shorter — a failure
 *     that would read as "retrieval found less" rather than as a misconfigured
 *     constant.
 */

import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_FUSION_TOP, type FusedRecallHit } from './knowledge-fusion';
import { applyRerankOrder, KNOWLEDGE_RERANK_CANDIDATES } from './knowledge-rerank';
import type { RecalledChunk } from './knowledge-recall';

function chunk(id: string): RecalledChunk {
  return {
    id,
    tenantId: 'tenant-1',
    storeId: 'store-1',
    scopeType: 'store',
    sourceKind: 'faq',
    sourceId: `source-of-${id}`,
    sourceField: 'answer',
    chunkType: 'prose',
    chunkIndex: 0,
    content: `content of ${id}`,
  };
}

/**
 * A fused hit, as `fuseRecall` produces it.
 *
 * The `score` is `fuseRecall`'s RRF sum and is deliberately *not* what this
 * kernel reads — the module it is imported from ignores it too, and the values
 * below are made to contradict the scores passed to {@link applyRerankOrder} so
 * that a kernel which read them instead would fail the alignment test.
 */
function fused(id: string, rrf: number): FusedRecallHit {
  return { chunk: chunk(id), score: rrf, ranks: { keyword: 1, semantic: null }, modes: ['keyword'] };
}

function ids(hits: ReadonlyArray<FusedRecallHit>): ReadonlyArray<string> {
  return hits.map((hit) => hit.chunk.id);
}

describe('applyRerankOrder', () => {
  it('orders by the cross-encoder’s score, best first', () => {
    const hits = [fused('a', 0.9), fused('b', 0.8), fused('c', 0.7)];

    // Every score contradicts the fused order, so an implementation that
    // returned its input unchanged — or sorted by the RRF score — fails here.
    const ordered = applyRerankOrder(hits, [0.1, 0.5, 0.9]);

    expect(ids(ordered)).toEqual(['c', 'b', 'a']);
  });

  it('breaks a tie with the fused order, not with the slice id', () => {
    // Fusion put `z` first and `a` second; the ids say the opposite. Both
    // candidates scored the same, so the two rules are the only thing that can
    // decide, and this fixture is the case where they disagree.
    const hits = [fused('z', 0.05), fused('a', 0.04)];

    expect(ids(applyRerankOrder(hits, [0.5, 0.5]))).toEqual(['z', 'a']);
  });

  it('reads the scores as positions and not as a ranking', () => {
    // The provider's answer arrives ranked and is realigned before it gets here;
    // this asserts the kernel's half of that contract. Read as a ranking, the
    // last document would come first.
    const hits = [fused('a', 0.9), fused('b', 0.8), fused('c', 0.7)];

    const ordered = applyRerankOrder(hits, [0.9, 0.1, 0.5]);

    expect(ids(ordered)).toEqual(['a', 'c', 'b']);
  });

  it('answers with the fused order when there are no scores at all', () => {
    const hits = [fused('a', 0.9), fused('b', 0.8)];

    // What a caller passes when the provider is not configured or reported a
    // failure: the answer is the list it already had, not an empty one.
    expect(ids(applyRerankOrder(hits, []))).toEqual(['a', 'b']);
  });

  it('answers with the fused order when the scores do not cover the slices', () => {
    const hits = [fused('a', 0.9), fused('b', 0.8), fused('c', 0.7)];

    // Too few and too many, because either one leaves a document without a
    // score or a score without a document, and guessing at the pairing would
    // attach a cross-encoder's opinion to a slice it never read.
    expect(ids(applyRerankOrder(hits, [0.1, 0.9]))).toEqual(['a', 'b', 'c']);
    expect(ids(applyRerankOrder(hits, [0.1, 0.9, 0.5, 0.2]))).toEqual(['a', 'b', 'c']);
  });

  it('answers with the fused order when a score is not a finite number', () => {
    const hits = [fused('a', 0.9), fused('b', 0.8), fused('c', 0.7)];

    // `NaN` compares false against everything, so a sort that let one through
    // returns an order that depends on the engine's internals — and "the top
    // five" would stop meaning one thing, which is what the tie-break in
    // `fuseRecall` exists to prevent. `Infinity` is refused with it because the
    // provider refuses it: a kernel that accepted one would be the only place
    // the two disagreed about what a score is.
    expect(ids(applyRerankOrder(hits, [0.1, Number.NaN, 0.9]))).toEqual(['a', 'b', 'c']);
    expect(ids(applyRerankOrder(hits, [0.1, Number.POSITIVE_INFINITY, 0.9]))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('does not modify the list it was given', () => {
    const hits = [fused('a', 0.9), fused('b', 0.8)];

    applyRerankOrder(hits, [0.1, 0.9]);

    // The caller keeps the fused order to fall back on, and the loop that reads
    // sources back walks the reranked list — so a mutation here would corrupt
    // the very list the caller's `unavailable` reasoning is about.
    expect(ids(hits)).toEqual(['a', 'b']);
  });

  it('is total: the answer is always a permutation of the input', () => {
    const hits = [fused('a', 0.9), fused('b', 0.8), fused('c', 0.7)];

    expect(ids(applyRerankOrder(hits, [0.5, 0.5, 0.5]))).toHaveLength(3);
    expect(new Set(ids(applyRerankOrder(hits, [0.5, 0.5, 0.5])))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('shows the reranker at least as many slices as the answer needs', () => {
    // If it showed fewer, the reranker could not fill the answer and the read
    // path would return a short list — a failure that reads as "retrieval found
    // less" rather than as two constants that were chosen independently.
    expect(KNOWLEDGE_RERANK_CANDIDATES).toBeGreaterThanOrEqual(KNOWLEDGE_FUSION_TOP);
  });
});
