/**
 * Keyword recall: a buyer's question, answered from the slices already indexed.
 *
 * This is the first of SDD-014's two recall legs and it reads the tables
 * `0011_knowledge_index` and `0014_knowledge_chunk_terms` declare —
 * `knowledge_chunks`, `knowledge_chunk_keywords` and `knowledge_chunk_terms`. It
 * is a *read*: nothing here writes, reindexes or embeds, and the index sweep that
 * fills those tables is the Worker's.
 *
 * The parsed question is the kernel's ({@link parseKnowledgeQuery}), not this
 * module's, and the three buckets it produces are what the two halves below
 * implement:
 *
 *   * **`attributes` — exact, on the keyword table.** `XL`, `黑色`, `安踏` are
 *     matched by equality against `knowledge_chunk_keywords`, on `(kind, text)`.
 *     A strong constraint must never take part in a substring match, and the
 *     reason is the 错品 SDD-014 caps at 5%: `LIKE '%XL%'` recalls a chunk whose
 *     size is `XLL`, and the buyer gets a product that does not fit.
 *   * **`keywords` — scored, on the slice text.** The free text left over is
 *     tokenized and scored with BM25 over `knowledge_chunk_terms`. What this
 *     replaced, and why, is the paragraph below.
 *   * **`negations` — a filter, not a source.** A value the buyer rejected
 *     removes slices that carry it as a keyword. Without this the kernel's
 *     negation bucket would have no consumer, and 「不要黑色的」 would answer with
 *     black products.
 *
 * **The free-text half used to be a substring match and is now BM25.** It was
 * `content ILIKE '%卫衣%'` worth one point per term, summed — a scorer with no
 * term frequency, no inverse document frequency and no document length, in which
 * 「规格」, a word in almost every slice of the catalogue, weighed exactly as much
 * as 「冰雾粉」, a colour nine slices carry. BM25 has all three, which is what
 * `0014` and {@link tokenizeKnowledgeText} exist to feed it: the slice's terms
 * and their frequencies are indexed, the document frequency is read off the same
 * index, and the length is the slice's own text length.
 *
 * **The two halves are still not the same kind of thing.** An attribute match is
 * a *constraint satisfied* and contributes a fixed boost
 * ({@link KNOWLEDGE_BM25_ATTRIBUTE_BOOST}); a term match is *evidence* and
 * contributes its BM25 weight. They add, and that sum is one number, but only
 * because the answer's order is all that survives — see the score note.
 *
 * **The scope is the retrieval scope, and it is written the way the index-status
 * read writes it**: this tenant's slices, one store's or the tenant's own. A
 * `scope_type = 'tenant'` slice is `store_id IS NULL` by construction, it is
 * shared by every store, and the store rule is the shortcut list's rule — see
 * `PostgresPlatformRepository.knowledgeIndexStatus`, which states it. A slice
 * belonging to *another* store of the same tenant is not this store's to answer
 * with, and neither is another tenant's anything.
 *
 * **The order is total, not merely sorted.** Ties on the score are broken by the
 * slice id, because "the first twenty" has to mean one thing: two runs over the
 * same rows must return the same twenty in the same order, or an evaluation set
 * built on this leg measures the plan cache instead of the recall.
 *
 * **A coverage bonus was measured, and is not here.** Rewarding a slice for how
 * many of the question's terms it answered — the intuition that a slice naming
 * both 「内裤」 and 「蓝烟灰」 beats one naming only the colour — was implemented as
 * `score + 6 × matched` on 2026-09-21 and made every reading worse: the frozen
 * set's fused arm lost 1.0pp of Top-1 and 0.8pp of 错品率, the dev set 0.6pp, and
 * the colour questions it was written for lost the most. The reason is the tie
 * this leg actually has: at `b = 0` two slices that matched the *same* term the
 * same number of times score alike, and those two have the same coverage, so the
 * bonus cannot separate them — it only reorders slices whose evidence already
 * differs, which is idf's job. Removing it is the fix; the report is
 * `eval/reports/retrieval-eval-2026-09-21T04-03-42-262Z.json`.
 *
 * **The score is a rank, not a judgement.** BM25's magnitude is not comparable
 * across questions — it moves with the corpus, with the term count and with the
 * lengths in play — and nothing outside this leg may read the number as a
 * measure of relevance. The fusion step (RRF) replaces it with a rank, which is
 * the only thing this leg's score was ever asked to carry; the boost above is
 * likewise a nudge on an order and not a quantity with a meaning.
 */

import type { KeywordKind, ParsedKnowledgeQuery, RecalledChunk } from '@kefu/core';

/**
 * How many slices one keyword query may answer with.
 *
 * The design's default (`语义召回…默认召回 Top 20`), and the same bound the fusion
 * step consumes. A bound rather than a target: it is what keeps one recall from
 * carrying the whole index into ranking.
 */
export const KNOWLEDGE_KEYWORD_RECALL_TOP = 20;

/**
 * What one exact attribute match adds to a slice's score.
 *
 * The one number here that is not BM25's, and it is deliberately *not* on the
 * scale of a BM25 term weight: a satisfied constraint is a tie-breaker between
 * slices the same question otherwise scores alike, not a quantity of evidence.
 * An attribute also contributes its own tokens to the BM25 sum — `XL` is in the
 * slice's text as much as `黑色` is, and {@link tokenizeKnowledgeText} keeps the
 * two apart from `XLL` for the reason the module note gives — so the boost is
 * what an *exact* attribute match adds on top of the tokens it shares.
 *
 * Whether the constant is the right size is a question for
 * `npm run eval:retrieval`, not for this comment: it was 2 when the score was a
 * sum of substring weights and it is 2 now, and the evaluation set is what says
 * whether that moved the ordering the wrong way.
 */
export const KNOWLEDGE_BM25_ATTRIBUTE_BOOST = 2;

/**
 * BM25's term-frequency saturation, `k1`.
 *
 * The standard value, and the reason it is a constant rather than a parameter:
 * `k1` decides how fast repeating a term stops paying, and 1.2 is the value the
 * published formula was fitted with. A different one is a different scorer, and
 * would need a measurement of its own rather than a nudge here.
 */
export const KNOWLEDGE_BM25_K1 = 1.2;

/**
 * BM25's length-normalisation strength, `b`.
 *
 * `0`: a slice's length takes no part in its score. The standard `0.75` was in
 * place first and was measured out on 2026-09-21 — 131 colour questions, the
 * fused arm, every value in `0.75 / 0.3 / 0.2 / 0.1 / 0` run over the whole
 * band, and every reading improves as `b` falls:
 *
 * | `b` | Top-1 | Top-5 | 错品 |
 * | --- | --- | --- | --- |
 * | 0.75 | 71.8% | 91.6% | 33.1% |
 * | 0.3 | 75.6% | 95.4% | 30.1% |
 * | 0.1 | 77.9% | 95.4% | 29.6% |
 * | 0 | 79.4% | 96.2% | 29.5% |
 *
 * The monotone curve is the point: this is not a value fitted to a distribution
 * that will drift, it is this catalogue's slices having no length signal to
 * give. A slice's length here is *how many spec values it carries*, not how far
 * it has drifted from the question, and the slice that carries the value the
 * buyer named is the long one — 「内裤 蓝烟灰」's answer is
 * `颜色：漫暮黑+蓝烟灰+乌梅紫-170/95(M)`, a 3-colour pack, while the short
 * slices naming that same colour belong to bags and masks. At `b = 0.75` the
 * leg ranked that pack 13th of its twenty, behind fourteen unrelated slicings of
 * the colour, and fusion never showed it; at `0` it is the leg's first slice.
 *
 * What `0` costs is bounded, which is why it is safe here: a term's contribution
 * is `tf`-saturated at `(k1 + 1) * idf` however long the slice and however often
 * it repeats the term, so a long slice cannot talk its way to the top by
 * volume — it still has to match terms the corpus considers rare.
 *
 * It is *not* a tie-breaker and must not be read as one. With `b = 0` every
 * slice holding a query term once scores alike, so the leg's own order falls
 * back to the slice id — which is what the substring leg this replaced did, and
 * it is the only reason the code questions' Top-1 looks better at `0` than at
 * `0.1` (82.4% against 38.2%, measured on 34). That is the fusion tie in
 * `fuseRecall` being won or lost by a UUID, not a gain in relevance; the fix for
 * it is a tie that means something, and it is not this constant.
 */
export const KNOWLEDGE_BM25_B = 0;

/** Which of the two halves found a term. */
export type RecallLeg = 'exact' | 'bm25';

/**
 * One query term that matched one slice.
 *
 * `kind` is the dimension the kernel named the value with, or `null` for a
 * free-text term, which has no dimension by definition. It is reported so the
 * answer can be explained — SDD-014's 可解释 requirement — and so a test can say
 * *which* half matched rather than only that something did.
 *
 * `text` is the **query's** term, not the slice token that matched it. BM25
 * scores a query's tokens rather than its terms — 「冰雾粉」 is two of them — and
 * reporting `冰雾` back to the buyer would be an explanation of the scorer's
 * internals rather than of the answer.
 */
export type MatchedRecallTerm = {
  readonly text: string;
  readonly kind: KeywordKind | null;
  readonly leg: RecallLeg;
};

/**
 * The slice a hit came from — {@link RecalledChunk}, which is a *kernel* type
 * and no longer this module's to declare.
 *
 * It was first written here, and the semantic leg imported it from here, which
 * made two peer legs depend on each other for the shape they share. The fusion
 * kernel is the third consumer and the one that settled it: fusion lives in
 * `platform/` with the other kernels, and a kernel cannot import from a leg. The
 * type moved to `@kefu/core` (`platform/knowledge-recall`) unchanged — same
 * fields, same nullability, same reasoning — and both legs now read it from
 * there. Nothing about this leg's answer changed.
 */

/**
 * One recalled slice and why it was recalled.
 *
 * The four things the architecture requires of a retrieval result — 来源切片、
 * `source_field`、关键词、检索分数 — plus the recall mode, which the fusion step
 * needs in order to tell this leg's hits from the semantic leg's.
 */
export type KeywordRecallHit = {
  readonly chunk: RecalledChunk;
  readonly mode: 'keyword';
  readonly score: number;
  readonly matched: ReadonlyArray<MatchedRecallTerm>;
};

/** One keyword recall: whose scope, what was asked, and how many to answer with. */
export type KeywordRecallInput = {
  readonly tenantId: string;
  /** The store being answered for. Tenant-level slices are visible to it. */
  readonly storeId: string;
  /** The parsed question, from the kernel rather than from a second parser. */
  readonly query: ParsedKnowledgeQuery;
  /** Defaults to {@link KNOWLEDGE_KEYWORD_RECALL_TOP}. */
  readonly limit?: number;
};

/**
 * The keyword recall leg.
 *
 * A port rather than a service so the retrieval pipeline depends on the answer
 * and not on PostgreSQL, and so the durable half (the BM25 statement over the
 * term index) has exactly one implementation to keep honest.
 */
export interface KnowledgeKeywordRecall {
  /**
   * Recall the slices of one store that answer one parsed question.
   *
   * @param input - The scope, the parsed question and the bound.
   * @returns The hits, best first, with the slice id as the tie-breaker.
   */
  recall(input: KeywordRecallInput): Promise<ReadonlyArray<KeywordRecallHit>>;
}

/** Injection token for {@link KnowledgeKeywordRecall}. */
export const KNOWLEDGE_KEYWORD_RECALL = Symbol('KNOWLEDGE_KEYWORD_RECALL');
