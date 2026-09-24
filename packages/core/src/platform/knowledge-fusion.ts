/**
 * The fusion kernel: two legs' answers in, one ranked list out.
 *
 * SDD-014's retrieval is two recalls of the same question — keyword and semantic
 * — and the step between them and the answer is this one. It is a pure function
 * over the two legs' *ordered* results: no database, no provider, no clock, so
 * the same two lists always fuse to the same list, which is what lets the
 * retrieval path be tested without either leg running.
 *
 * **Scores are not mixed, because they are not the same unit.** The keyword leg
 * counts matched terms with exact matches weighted double; the semantic leg
 * reports a cosine similarity `1 - (embedding <=> query)`. Adding them would not
 * be a combination, it would be a decision that whichever leg's arithmetic
 * happens to produce larger numbers is the leg that decides — and the keyword
 * leg's weighted count is unbounded while the similarity is not, so the semantic
 * leg would silently stop participating while every test still passed. The two
 * port comments already say the magnitudes are uninteresting; this module is the
 * only one that has to act on it.
 *
 * **So the fusion ranks.** Reciprocal rank fusion: a slice's score is
 * `Σ 1 / (k + rank)` over the legs that recalled it, with `rank` the 1-based
 * position in that leg's list and `k` = {@link KNOWLEDGE_FUSION_RRF_K}. Only the
 * order each leg promised is read; the numbers in `score` fields of the hits are
 * ignored entirely. That is what makes {@link fuseRecall} testable against its
 * own worst failure: multiplying one leg's scores by a thousand cannot change
 * the output, and the suite asserts exactly that.
 *
 * **`k` is 60, and the claim that comes with it is falsifiable.** `k` damps the
 * difference between the head and the tail of a leg's list: at `k = 60` the
 * weight of rank 1 is `1/61` and of rank 20 is `1/80` — a ratio of about 1.31,
 * against about 10.5 at `k = 1`. So a leg cannot take the answer by putting
 * something first; it takes it by putting it first *and* by the other leg
 * agreeing. That is a property a fixture can be built to fail on rather than a
 * remark: one slice placed 5th by *both* legs outranks one placed 1st by one leg
 * and 10th by the other, by a margin of `0.00009` — and at `k = 1` the same
 * input answers the other way round. The constant is exported for the reason the
 * legs export their own bounds: moving it is a decision, and the suite says so
 * out loud instead of hiding it in a float.
 *
 * **A slice both legs recalled is one slice, with both ranks.** The two legs
 * read the same two tables, so agreement is common, and it is the strongest
 * signal either leg can produce: two terms of the sum instead of one. Merging on
 * `chunk.id` is therefore not bookkeeping — it is what makes agreement pay, and
 * without it the same sentence would occupy two of the five places the answer
 * has. The row that is returned is the **first leg's** copy of it; the legs read
 * the same columns of the same table, so which copy is unobservable in
 * production, and it is pinned here so that it stays unobservable by decision
 * rather than by accident of iteration order.
 *
 * **The order is total.** Equal scores are broken by `chunk.id`, for the reason
 * the keyword leg states about its own ties: "the top five" has to mean one
 * thing, or two runs over the same input return two different answers and an
 * evaluation set measures the sort instead of the recall. Equal scores are not
 * hypothetical — a slice ranked 1st and 2nd by the two legs and a slice ranked
 * 2nd and 1st sum the same two terms — so this is the case the tie-break exists
 * for, and the suite constructs exactly it.
 *
 * **An unavailable semantic leg does not empty the answer.** {@link
 * FusableSemanticRecall} carries the reason it could not run, and that reason
 * travels out through {@link FusedRecallResult.unavailable} unchanged, while the
 * keyword leg's hits are returned as usual. The failure this refuses is the one
 * where a vector outage and "there is no knowledge for this question" are the
 * same answer, and the customer-service agent is shown an empty list with
 * nothing to explain it. `null` means the leg ran; it is never a substitute for
 * a reason, and it never cancels the other leg.
 *
 * **The inputs are this module's own shapes, and that is a boundary, not a
 * shortcut.** The legs' `KeywordRecallHit` / `SemanticRecallResult` live in
 * `apps/api`, and a kernel cannot import from an application — that is the
 * dependency direction the whole `platform/` layer exists to keep. The types
 * below are the *structural* requirement fusion actually has of a hit: a slice,
 * the leg it came from, and the order. The legs' types satisfy them as written,
 * so nothing in `apps/api` has to change to call this, and the kernel stays
 * callable from a module neither leg has heard of.
 */

import type { RecallLegName, RecallUnavailable, RecalledChunk } from './knowledge-recall';

/**
 * How many slices one fused answer carries.
 *
 * SDD-014's "返回 Top 5": it is the retrieval layer's answer, and it is not the
 * suggestion engine's bound — the engine's candidate list is clamped to three of
 * its own, so five here means "five slices of evidence to answer from", not
 * "five suggested replies".
 */
export const KNOWLEDGE_FUSION_TOP = 5;

/**
 * The RRF damping constant, in the rank denominators `1 / (k + rank)`.
 *
 * `60` is the value reciprocal rank fusion is published with, and its meaning is
 * stated at the module level as a measurable claim: rank 1 weighs about 1.31×
 * rank 20, so a leg's head cannot run away with the answer. It is a constant
 * rather than an argument because a per-call `k` would make two answers
 * incomparable while looking like a tuning knob; a candidate set that needs a
 * different `k` needs a record and a fixture, which is what changing this line
 * costs.
 */
export const KNOWLEDGE_FUSION_RRF_K = 60;

/**
 * One hit, as fusion needs to see it.
 *
 * `mode` is the leg that produced the hit, and the legs' own hit types declare
 * it as the literal their leg promises (`'keyword'`, `'semantic'`), which is
 * assignable to {@link RecallLegName} — so the legs do not have to be rewritten
 * to be fused, and a third leg would be a compile error here rather than a
 * silently missing branch.
 */
export type FusableRecallHit = {
  readonly chunk: RecalledChunk;
  readonly mode: RecallLegName;
};

/**
 * The semantic leg's whole answer: its hits, and why there are none if that is
 * the case rather than the question.
 *
 * The asymmetry with {@link FuseRecallInput.keyword} — a bare array — is the
 * legs' own asymmetry and is kept: the keyword leg has no failure mode to
 * report, and inventing an empty one for it would make "nothing matched" and
 * "the model server is down" the same shape again.
 */
export type FusableSemanticRecall = {
  readonly hits: ReadonlyArray<FusableRecallHit>;
  /** `null` when the leg ran; a reported reason when it could not. */
  readonly unavailable: RecallUnavailable | null;
};

/** One fusion: the two legs' answers, and how many slices to answer with. */
export type FuseRecallInput = {
  /**
   * The keyword leg's hits, best first.
   *
   * Read for its **order** and for the slices' ids; the hits' `score` fields are
   * deliberately not part of this type's business — see the module note.
   */
  readonly keyword: ReadonlyArray<FusableRecallHit>;
  /** The semantic leg's whole answer, hits and reason alike. */
  readonly semantic: FusableSemanticRecall;
  /** Defaults to {@link KNOWLEDGE_FUSION_TOP}. */
  readonly limit?: number;
};

/**
 * Where each leg placed a slice, or `null` if that leg did not recall it.
 *
 * Both keys are always present, so a caller can tell "this leg ranked it 0th"
 * from "this leg never saw it" without a second lookup, and so asserting a
 * fusion's provenance is one `toEqual` rather than a chain of optional reads.
 */
export type FusedRecallRanks = Readonly<Record<RecallLegName, number | null>>;

/** One slice of the fused answer, with why it is there and how strongly. */
export type FusedRecallHit = {
  /** The slice, as the first leg that recalled it returned it. */
  readonly chunk: RecalledChunk;
  /** The RRF sum, `Σ 1 / (k + rank)`. Comparable within one answer only. */
  readonly score: number;
  /** The legs that recalled it and where each placed it. */
  readonly ranks: FusedRecallRanks;
  /** The legs that recalled it, keyword before semantic. */
  readonly modes: ReadonlyArray<RecallLegName>;
};

/** What fusion answers: the ranked slices, and the semantic leg's reason if it had one. */
export type FusedRecallResult = {
  /** The top {@link FuseRecallInput.limit} slices, best first, ties by slice id. */
  readonly hits: ReadonlyArray<FusedRecallHit>;
  /** Passed through from the semantic leg; `null` when it ran. */
  readonly unavailable: RecallUnavailable | null;
};

/** One slice's record while the two legs are being walked. */
type FusionEntry = {
  chunk: RecalledChunk;
  score: number;
  ranks: Record<RecallLegName, number | null>;
  modes: RecallLegName[];
};

/** One leg's list under the name it is written down as. */
type LegHits = {
  readonly leg: RecallLegName;
  readonly hits: ReadonlyArray<FusableRecallHit>;
};

/**
 * Fuse the two legs into one ranked answer.
 *
 * Pure and total: every input produces an answer, including two empty lists, and
 * the same input always produces the same answer — the tie-break on `chunk.id`
 * is what makes that true rather than likely.
 *
 * @param input - The legs' ordered hits, the semantic leg's reason if it had
 *   one, and the bound.
 * @returns The top `limit` slices best first, and the semantic leg's
 *   `unavailable` passthrough.
 */
export function fuseRecall(input: FuseRecallInput): FusedRecallResult {
  const entries = new Map<string, FusionEntry>();

  // Written down in this order so `modes` reads keyword-first for every slice,
  // whatever order the legs were awaited in.
  const legs: ReadonlyArray<LegHits> = [
    { leg: 'keyword', hits: input.keyword },
    { leg: 'semantic', hits: input.semantic.hits },
  ];

  for (const { leg, hits } of legs) {
    hits.forEach((hit, index) => {
      const rank = index + 1;
      const entry = entries.get(hit.chunk.id);

      if (entry === undefined) {
        const ranks: Record<RecallLegName, number | null> = { keyword: null, semantic: null };
        ranks[leg] = rank;
        entries.set(hit.chunk.id, {
          chunk: hit.chunk,
          score: rrfWeight(rank),
          ranks,
          modes: [leg],
        });
        return;
      }

      // A leg that listed one slice twice has one rank for it, not two terms in
      // the sum: the second listing is the same evidence, and counting it again
      // would let one leg's duplicate outrank the other leg's agreement.
      if (entry.ranks[leg] !== null) return;

      entry.ranks[leg] = rank;
      entry.score += rrfWeight(rank);
      entry.modes.push(leg);
    });
  }

  const ranked = Array.from(entries.values())
    .sort(byScoreThenSliceId)
    .map((entry): FusedRecallHit => ({
      chunk: entry.chunk,
      score: entry.score,
      ranks: entry.ranks,
      modes: entry.modes,
    }));

  return {
    hits: ranked.slice(0, clampFusionLimit(input.limit)),
    unavailable: input.semantic.unavailable,
  };
}

/** What one rank contributes to a slice's score. */
function rrfWeight(rank: number): number {
  return 1 / (KNOWLEDGE_FUSION_RRF_K + rank);
}

/**
 * Best score first, ties by slice id.
 *
 * The id comparison is a plain code-unit comparison rather than `localeCompare`
 * for the reason the leg ports give about their own tie-breaker: it is the same
 * answer on every machine and in every locale, and it is only ever asked to pick
 * one of two things that scored the same.
 */
function byScoreThenSliceId(left: FusionEntry, right: FusionEntry): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.chunk.id === right.chunk.id) return 0;
  return left.chunk.id < right.chunk.id ? -1 : 1;
}

/**
 * How many slices to answer with.
 *
 * A caller that passes nothing gets {@link KNOWLEDGE_FUSION_TOP}; a caller that
 * passes something unusable — negative, fractional, `NaN` — gets a bound rather
 * than a `RangeError`, because the bound is what it asked for and a throw here
 * would turn a bad limit into a failed search.
 */
function clampFusionLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return KNOWLEDGE_FUSION_TOP;
  return Math.max(0, Math.trunc(limit));
}
