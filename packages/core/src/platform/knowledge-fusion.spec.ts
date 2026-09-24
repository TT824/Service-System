/**
 * What fusion does with two legs' opinions, and the five ways it can look right
 * while being wrong.
 *
 * The kernel is four lines of arithmetic around a `Map`, so the suite is written
 * against the failures that are *invisible in the output's shape*: every one of
 * them returns five slices in a plausible order.
 *
 *   * **Scores instead of ranks.** The legs' numbers are different units, so
 *     adding them hands the answer to whichever leg's arithmetic is larger. The
 *     first two tests are a matched pair: one constructs the case where the two
 *     rules disagree, the other shows the rule that reads ranks is invariant to
 *     a thousandfold rescaling of one leg's scores.
 *   * **No merge on agreement.** Two legs recalling one slice must yield one
 *     slice — with two terms in the sum, which is the whole reason agreement is
 *     worth detecting.
 *   * **No tie-break.** Two slices can genuinely score the same, and the answer
 *     still has to mean one thing.
 *   * **`unavailable` swallowed.** A vector outage and "nothing matched" are the
 *     same five-item-looking answer, and only one of them is an outage.
 *   * **A leg's repetition counted twice.** One leg listing a slice twice must
 *     not buy it two terms in the sum, or a single leg's duplicate would outrank
 *     the two legs' agreement.
 *
 * Each of these was checked by breaking it and watching the named test go red,
 * one break at a time: a green suite is evidence that the assertions hold, not
 * that the path in a test's name ran. The merge break is the one that reds more
 * than its own test — four of the fixtures contain a slice both legs saw, and
 * without the merge their premise is gone — which is why the breaks were run
 * separately rather than piled into one edit.
 */

import { describe, expect, it } from 'vitest';
import {
  fuseRecall,
  KNOWLEDGE_FUSION_RRF_K,
  KNOWLEDGE_FUSION_TOP,
  type FuseRecallInput,
  type FusableRecallHit,
  type FusableSemanticRecall,
} from './knowledge-fusion';
import type { RecalledChunk } from './knowledge-recall';

/**
 * A leg's hit as the legs really produce it: fusion's shape plus the score it
 * promises not to read.
 *
 * Declared here rather than imported from the legs because the legs are in
 * `apps/api` and this suite is in the package they depend on — the same
 * direction problem the kernel's own input types exist to solve. That these
 * values are accepted where a `FusableRecallHit` is asked for is itself the
 * check that the legs' types will be.
 */
type ScoredHit = FusableRecallHit & { readonly score: number };

function chunk(id: string, content = `content of ${id}`): RecalledChunk {
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
    content,
  };
}

function keywordHit(id: string, score: number): ScoredHit {
  return { chunk: chunk(id), mode: 'keyword', score };
}

function semanticHit(id: string, score: number, content?: string): ScoredHit {
  return {
    chunk: content === undefined ? chunk(id) : chunk(id, content),
    mode: 'semantic',
    score,
  };
}

function semantic(hits: ReadonlyArray<ScoredHit>): FusableSemanticRecall {
  return { hits, unavailable: null };
}

function ids(input: FuseRecallInput): ReadonlyArray<string> {
  return fuseRecall(input).hits.map((hit) => hit.chunk.id);
}

const K = KNOWLEDGE_FUSION_RRF_K;

/**
 * The three slices the score-versus-rank pair shares: `only-keyword` leads the
 * keyword leg, `agreed` is second there and first on the semantic leg.
 */
function scoreVersusRank(scores: {
  readonly head: number;
  readonly second: number;
}): FuseRecallInput {
  return {
    keyword: [keywordHit('only-keyword', scores.head), keywordHit('agreed', scores.second)],
    semantic: semantic([semanticHit('agreed', 0.2)]),
  };
}

describe('fuseRecall', () => {
  it('outranks a leg-leading slice with the one both legs recalled', () => {
    const fused = fuseRecall(scoreVersusRank({ head: 1, second: 0.5 }));

    // The keyword leg is explicit that `only-keyword` beat `agreed` on its own
    // terms; fusion overrules that because the semantic leg also wanted it.
    expect(fused.hits.map((hit) => hit.chunk.id)).toEqual(['agreed', 'only-keyword']);
    expect(fused.hits[0]?.score).toBeCloseTo(1 / (K + 2) + 1 / (K + 1));
    expect(fused.hits[1]?.score).toBeCloseTo(1 / (K + 1));
  });

  it('keeps that order when one leg scores a thousand times larger', () => {
    const small = ids(scoreVersusRank({ head: 1, second: 0.5 }));
    const large = ids(scoreVersusRank({ head: 1000, second: 500 }));

    // Adding the two legs' numbers would flip this pair: `1000` beats `500.2`
    // while `1` loses to `1.4`. Reading ranks only, the answer is the same list.
    expect(large).toEqual(small);
    expect(large).toEqual(['agreed', 'only-keyword']);
  });

  it("ranks two mid-rank agreements above one leg's head and the other leg's tail", () => {
    // `midrank` is 5th on both legs; `split` leads one leg and trails the other
    // at 10th. Two `1/(k+5)` terms beat `1/(k+1) + 1/(k+10)` by 0.00009 at
    // k=60 — and lose to it at k=1. The margin is the claim: the answer is
    // decided by rank agreement, and the constant is part of the decision.
    const keyword = [
      keywordHit('split', 9),
      keywordHit('kw-2', 8),
      keywordHit('kw-3', 7),
      keywordHit('kw-4', 6),
      keywordHit('midrank', 5),
    ];
    const semanticHits = [
      semanticHit('sem-1', 0.9),
      semanticHit('sem-2', 0.8),
      semanticHit('sem-3', 0.7),
      semanticHit('sem-4', 0.6),
      semanticHit('midrank', 0.5),
      semanticHit('sem-6', 0.4),
      semanticHit('sem-7', 0.3),
      semanticHit('sem-8', 0.2),
      semanticHit('sem-9', 0.1),
      semanticHit('split', 0.05),
    ];

    const fused = fuseRecall({ keyword, semantic: semantic(semanticHits) });

    expect(fused.hits.slice(0, 2).map((hit) => hit.chunk.id)).toEqual(['midrank', 'split']);
    expect(fused.hits[0]?.ranks).toEqual({ keyword: 5, semantic: 5 });
    expect(fused.hits[1]?.ranks).toEqual({ keyword: 1, semantic: 10 });
    expect(fused.hits[0]?.score).toBeCloseTo(2 / (K + 5));
  });

  it('lists a slice both legs recalled once, with both modes and both ranks', () => {
    const fused = fuseRecall({
      keyword: [keywordHit('shared', 7), keywordHit('keyword-only', 3)],
      semantic: semantic([semanticHit('shared', 0.4, 'a different copy of the row')]),
    });

    const shared = fused.hits.filter((hit) => hit.chunk.id === 'shared');

    expect(fused.hits.map((hit) => hit.chunk.id)).toEqual(['shared', 'keyword-only']);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.modes).toEqual(['keyword', 'semantic']);
    expect(shared[0]?.ranks).toEqual({ keyword: 1, semantic: 1 });
    expect(shared[0]?.score).toBeCloseTo(2 / (K + 1));
    // Two legs reading one table return the same row; the first leg's copy is
    // the one that travels, so which copy it is never becomes a live question.
    expect(shared[0]?.chunk.content).toBe('content of shared');
  });

  it('breaks a tie on the slice id, so two runs over it agree', () => {
    // `zzz` leads the keyword leg and `aaa` leads the semantic leg, so both sum
    // 1/(k+1) + 1/(k+2) — the same two terms, added in the same order, and
    // therefore the same number. Only the id can order them.
    const input: FuseRecallInput = {
      keyword: [keywordHit('zzz', 9), keywordHit('aaa', 8)],
      semantic: semantic([semanticHit('aaa', 0.9), semanticHit('zzz', 0.8)]),
    };

    const first = fuseRecall(input);
    const second = fuseRecall(input);

    expect(first.hits[0]?.score).toBe(first.hits[1]?.score);
    expect(first.hits.map((hit) => hit.chunk.id)).toEqual(['aaa', 'zzz']);
    expect(second.hits.map((hit) => hit.chunk.id)).toEqual(['aaa', 'zzz']);
  });

  it('returns the keyword hits and the reason when the semantic leg is unavailable', () => {
    const reason = {
      code: 'embedding_service_unreachable',
      reason: 'connect ECONNREFUSED 127.0.0.1:11434',
    };

    const fused = fuseRecall({
      keyword: [keywordHit('faq-1', 2), keywordHit('faq-2', 1)],
      semantic: { hits: [], unavailable: reason },
    });

    expect(fused.hits.map((hit) => hit.chunk.id)).toEqual(['faq-1', 'faq-2']);
    expect(fused.unavailable).toEqual(reason);
  });

  it('answers with five slices by default and with the limit it is given', () => {
    const many = Array.from({ length: 7 }, (_unused, index) =>
      keywordHit(`faq-${index}`, 7 - index),
    );
    const fused = fuseRecall({ keyword: many, semantic: semantic([]) });

    expect(fused.hits).toHaveLength(KNOWLEDGE_FUSION_TOP);
    expect(fused.hits.map((hit) => hit.chunk.id)).toEqual([
      'faq-0',
      'faq-1',
      'faq-2',
      'faq-3',
      'faq-4',
    ]);
    expect(fused.unavailable).toBeNull();

    const bounded = fuseRecall({ keyword: many, semantic: semantic([]), limit: 2 });
    expect(bounded.hits.map((hit) => hit.chunk.id)).toEqual(['faq-0', 'faq-1']);
  });

  it('scores a slice a single leg listed twice only once', () => {
    const fused = fuseRecall({
      keyword: [keywordHit('faq-1', 5), keywordHit('faq-1', 5)],
      semantic: semantic([]),
    });

    expect(fused.hits).toHaveLength(1);
    expect(fused.hits[0]?.ranks).toEqual({ keyword: 1, semantic: null });
    // One term, not two: a leg repeating itself must not outrank the other leg's
    // agreement.
    expect(fused.hits[0]?.score).toBeCloseTo(1 / (K + 1));
  });

  it('answers two empty legs with an empty list and no reason', () => {
    const fused = fuseRecall({ keyword: [], semantic: semantic([]) });

    expect(fused.hits).toEqual([]);
    expect(fused.unavailable).toBeNull();
  });
});
