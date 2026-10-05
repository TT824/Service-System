/**
 * Suggestion generation.
 *
 * Suggestions are generated deterministically from the tenant's own knowledge
 * sources (products, FAQ entries and shortcuts) and never call an external
 * model when no provider is configured. The engine returns at most three
 * source-aware candidates, each carrying its tenant/store/source reference, and
 * records stable fallback reasons when generation is incomplete.
 *
 * **Two kinds of evidence arrive here, and they are not the same unit.** The
 * engine scores what it is given by counting query terms in a title and a body
 * — exact and cheap, and blind to wording: a question phrased differently from
 * the answer shares no term with it and scores zero. That blindness is the
 * whole reason SDD-014 recalls by meaning as well, and it is why an entry may
 * arrive already carrying {@link RetrievableKnowledge.recall}: the retrieval
 * layer put it in a leg's list, and a rank is evidence even when the words
 * disagree.
 *
 * **So an entry no longer has to win the lexical count to be offered.** It has
 * to carry evidence of *some* kind — a positive lexical score, or a recall
 * rank. Dropping the rank-carrying entries was the failure this fixes: the
 * semantic leg recalls exactly the entries whose words do not overlap, so
 * filtering the list by lexical score alone discarded the semantic leg's entire
 * contribution at the last step, silently, with `no_knowledge_match` written
 * down as if the knowledge were not there.
 *
 * The two kinds are still not added together. Lexical score orders first and
 * unchanged (it is the engine's own measurement and the unit it always had);
 * the recall rank decides the ties the score cannot, and it orders the
 * score-zero entries among themselves — which, for a question whose wording
 * matches nothing, is every entry in the answer.
 */

import type { RecallLegName } from './knowledge-recall';
import { SUGGESTION_FALLBACK_REASONS, type KnowledgeKind, type SuggestionCandidate } from './types';

/**
 * What the retrieval layer knows about an entry that the words do not say.
 *
 * `rank` is the 1-based position in the fused answer, and it is comparable only
 * within one answer — the same reason the fusion kernel keeps its RRF scores
 * out of any cross-answer claim. `modes` is the legs that recalled it, kept
 * because "only the semantic leg saw this one, and it saw it late" is a
 * statement the entry has to be able to make: it is the shape
 * SDD-014's relevance floor is defined on, in place of a threshold on a score
 * whose absolute value depends on the fusion's own constant.
 */
export type KnowledgeRecallEvidence = {
  readonly rank: number;
  readonly modes: ReadonlyArray<RecallLegName>;
};

/** A knowledge entry normalized for retrieval. */
export type RetrievableKnowledge = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly kind: KnowledgeKind;
  readonly title: string;
  readonly content: string;
  /**
   * Where SDD-014's two-lane recall placed this entry, or absent for an entry
   * that never went through it — the legacy `products` read, which bypasses the
   * index entirely. Absent is not "ranked last": it is "no recall evidence".
   */
  readonly recall?: KnowledgeRecallEvidence;
};

/** Hard upper bound for generated candidates. */
export const SUGGESTION_MAX_CANDIDATES = 3;

/** Normalize the requested candidate limit to the `1..3` range. */
export function clampSuggestionLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return SUGGESTION_MAX_CANDIDATES;
  }
  const floored = Math.floor(limit);
  if (floored < 1) {
    return 1;
  }
  if (floored > SUGGESTION_MAX_CANDIDATES) {
    return SUGGESTION_MAX_CANDIDATES;
  }
  return floored;
}

/** Result of the deterministic suggestion engine. */
export type SuggestionEngineResult = {
  readonly candidates: ReadonlyArray<SuggestionCandidate>;
  readonly fallbackReasons: ReadonlyArray<string>;
};

/** Input for {@link generateSuggestions}. */
export type SuggestionEngineInput = {
  readonly query: string;
  readonly knowledge: ReadonlyArray<RetrievableKnowledge>;
  readonly providerConfigured: boolean;
  /**
   * Whether the semantic recall leg reported why it could not answer.
   *
   * The engine is told the fact, not the leg's own code: what travels out to a
   * client is this module's stable vocabulary ({@link
   * SUGGESTION_FALLBACK_REASONS}), and the leg's precise reason is already in
   * the retrieval layer's log line. A buyer-facing set says "half of the search
   * did not run"; an operator reading the log gets to see which half and why.
   */
  readonly semanticRecallUnavailable?: boolean;
  readonly limit?: number;
};

/**
 * Generate at most three source-aware candidates from tenant knowledge.
 *
 * @param input - Query, in-scope knowledge and whether an external generation
 * provider is configured. Without a provider no external model is ever called.
 * @returns Ranked candidates plus stable fallback reasons.
 */
export function generateSuggestions(input: SuggestionEngineInput): SuggestionEngineResult {
  const fallbackReasons: string[] = [];
  if (!input.providerConfigured) {
    fallbackReasons.push(SUGGESTION_FALLBACK_REASONS.noProvider);
  }
  // Recorded before the empty-query return on purpose: the recall legs ran, and
  // one of them reported that it could not, which stays true whatever the
  // question was.
  if (input.semanticRecallUnavailable === true) {
    fallbackReasons.push(SUGGESTION_FALLBACK_REASONS.semanticRecallUnavailable);
  }

  const limit = clampSuggestionLimit(input.limit);
  const tokens = tokenizeQuery(input.query);
  if (tokens.length === 0) {
    fallbackReasons.push(SUGGESTION_FALLBACK_REASONS.emptyQuery);
    return { candidates: [], fallbackReasons };
  }

  const scored = input.knowledge
    .map((item) => ({
      item,
      score: scoreKnowledgeItem(item, tokens),
    }))
    .filter((entry) => entry.score > 0 || entry.item.recall !== undefined)
    .sort(byScoreThenRecallThenId)
    .slice(0, limit);

  const candidates = scored.map((entry, index) =>
    Object.freeze({
      rank: index + 1,
      kind: entry.item.kind,
      sourceId: entry.item.id,
      tenantId: entry.item.tenantId,
      storeId: entry.item.storeId,
      title: entry.item.title,
      content: entry.item.content,
      // The engine's own lexical score, and nothing else. A recalled entry the
      // words did not match carries `0` here, which is not a claim that it is
      // irrelevant — it is the engine saying it has no lexical evidence of its
      // own, and `rank` is where the answer to "why is this first" lives.
      score: entry.score,
      // Carried, not spent: the workspace's 检索依据 is its only reader, and the
      // engine never re-derives an order from it. Absent means the recall never
      // saw this entry — the legacy products read, which bypasses the index — and
      // that is a different statement from "recalled last".
      ...(entry.item.recall === undefined ? {} : { recall: entry.item.recall }),
    } satisfies SuggestionCandidate),
  );

  if (candidates.length === 0) {
    fallbackReasons.push(SUGGESTION_FALLBACK_REASONS.noKnowledgeMatch);
  }

  return { candidates, fallbackReasons };
}

/** One entry with the score the engine gave it, while the list is being sorted. */
type ScoredKnowledge = {
  readonly item: RetrievableKnowledge;
  readonly score: number;
};

/**
 * Best lexical score first; then the recall rank; then the id.
 *
 * The score leads because it is the engine's own measurement and was the only
 * ordering this list ever had — an entry that matched the question's words is
 * not displaced by one that arrived with a rank, and the product half (which
 * never carries a rank) keeps the order it has always had. The rank is what
 * decides everything the score cannot: ties, and the entries sitting at zero,
 * which for a question whose words appear nowhere in the knowledge is the whole
 * answer, and which is exactly the case the semantic leg exists for.
 *
 * An entry with no recall evidence sorts after one that has it at the same
 * score — never before, and never by being treated as a very large rank: the
 * absence of evidence is not a position in the recall.
 */
function byScoreThenRecallThenId(left: ScoredKnowledge, right: ScoredKnowledge): number {
  if (left.score !== right.score) return right.score - left.score;

  const leftRank = left.item.recall?.rank;
  const rightRank = right.item.recall?.rank;
  if (leftRank !== rightRank) {
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank;
  }

  // Deterministic tie-break so results are stable across runs.
  if (left.item.id === right.item.id) return 0;
  return left.item.id < right.item.id ? -1 : 1;
}

function tokenizeQuery(query: string): ReadonlyArray<string> {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return [];
  }
  const tokens = normalized
    .split(/[\s,，。.!！?？、;；:：'"“”‘’()（）[\]]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return tokens;
}

function scoreKnowledgeItem(item: RetrievableKnowledge, tokens: ReadonlyArray<string>): number {
  const title = item.title.toLowerCase();
  const content = item.content.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) {
      score += 3;
    } else if (content.includes(token)) {
      score += 1;
    }
  }
  return score;
}
