/**
 * The interception half of content safety: does this text contain a banned
 * phrase, and if so, which rule caught it?
 *
 * Pure, synchronous and dependency-free, for the reason every other kernel in
 * this package is: it has to be usable from the middle of a send path where
 * there is no I/O budget, and it has to be testable by handing it a rule list
 * and a string.
 *
 * Rules arrive as an argument rather than being imported here. That is the
 * falsification seam: an empty list must let everything through, so a test that
 * empties it and watches an assertion go red is proving the library is doing
 * the blocking, not some hardcoded branch.
 */

import {
  DEFAULT_CONTENT_SAFETY_RULES,
  type ContentSafetyCategory,
  type ContentSafetyRule,
} from './rules';

/** One matched phrase, positioned so a caller can point at it in the original. */
export type ContentSafetyHit = {
  readonly ruleId: string;
  readonly category: ContentSafetyCategory;
  /** The rule's term, which is what an operator recognises. */
  readonly term: string;
  /** Index of the match in the screened text. */
  readonly index: number;
};

/** The answer for one piece of text. */
export type ContentSafetyVerdict = {
  /** True when at least one rule matched outside its exemptions. */
  readonly blocked: boolean;
  readonly hits: ReadonlyArray<ContentSafetyHit>;
  /** The distinct matched terms, in rule order; what a seat is shown. */
  readonly terms: ReadonlyArray<string>;
};

/** The verdict for text that is allowed through; shared, since it is immutable. */
const CLEAN: ContentSafetyVerdict = Object.freeze({
  blocked: false,
  hits: Object.freeze([]),
  terms: Object.freeze([]),
});

/**
 * Screen one piece of text against a rule library.
 *
 * An empty or whitespace-only string is clean without consulting the rules: no
 * rule can match it, and the send path already rejects empty content on its
 * own terms, so spending a scan here would only be a second opinion about a
 * decision that is not this function's to make.
 */
export function screenContent(
  text: string,
  rules: ReadonlyArray<ContentSafetyRule> = DEFAULT_CONTENT_SAFETY_RULES,
): ContentSafetyVerdict {
  if (text.length === 0 || rules.length === 0) {
    return CLEAN;
  }

  const hits: ContentSafetyHit[] = [];
  const terms: string[] = [];
  for (const rule of rules) {
    const matched = matchedIndexes(text, rule);
    if (matched.length === 0) {
      continue;
    }
    hits.push(
      ...matched.map((index) => ({
        ruleId: rule.id,
        category: rule.category,
        term: rule.term,
        index,
      })),
    );
    terms.push(rule.term);
  }

  if (hits.length === 0) {
    return CLEAN;
  }
  return Object.freeze({
    blocked: true,
    hits: Object.freeze(hits),
    terms: Object.freeze(terms),
  });
}

/**
 * Screen a list of candidates, keeping the ones that pass.
 *
 * Returns the survivors *and* the blocked ones rather than only the survivors:
 * the caller persists the first and logs the second, and a helper that dropped
 * the evidence would make it impossible to say afterwards why a set came back
 * short. Order is preserved, because candidate `rank` is the caller's and this
 * function is not entitled to reorder it.
 */
export function screenCandidates<T extends { readonly content: string }>(
  candidates: ReadonlyArray<T>,
  rules: ReadonlyArray<ContentSafetyRule> = DEFAULT_CONTENT_SAFETY_RULES,
): {
  readonly kept: ReadonlyArray<T>;
  readonly blocked: ReadonlyArray<{
    readonly candidate: T;
    readonly verdict: ContentSafetyVerdict;
  }>;
} {
  const kept: T[] = [];
  const blocked: { candidate: T; verdict: ContentSafetyVerdict }[] = [];
  for (const candidate of candidates) {
    const verdict = screenContent(candidate.content, rules);
    if (verdict.blocked) {
      blocked.push({ candidate, verdict });
    } else {
      kept.push(candidate);
    }
  }
  return { kept: Object.freeze(kept), blocked: Object.freeze(blocked) };
}

/**
 * A seat-facing sentence naming what was caught.
 *
 * Term-level and deduplicated rather than rule-level: an operator edits the
 * library by phrase, so a message that quotes rule ids would name something
 * they cannot find. Deliberately short — the full hit list, with rule ids and
 * offsets, belongs in the log line, not in a banner.
 */
export function describeBlockedContent(verdict: ContentSafetyVerdict): string {
  if (!verdict.blocked) {
    return '';
  }
  return `内容包含禁止用语：${verdict.terms.join('、')}`;
}

/**
 * Every place a rule matches, after its exemptions are applied.
 *
 * One function rather than a count plus a list of indexes, because the two
 * disagreeing is exactly the bug this replaced: the count said "exempt" and the
 * reported offsets said otherwise, so a caller that read either one got a
 * different answer.
 */
function matchedIndexes(text: string, rule: ContentSafetyRule): number[] {
  const exempt = exemptionRanges(text, rule);
  return occurrenceIndexes(text, rule.term).filter(
    (index) => !isExempt(index, rule.term.length, exempt),
  );
}

/** Every index at which `term` occurs in `text`, including overlaps. */
function occurrenceIndexes(text: string, term: string): number[] {
  if (term.length === 0) {
    return [];
  }
  const indexes: number[] = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(term, from);
    if (index === -1) {
      return indexes;
    }
    indexes.push(index);
    from = index + 1;
  }
}

/** The spans covered by this rule's exempt phrases. */
function exemptionRanges(
  text: string,
  rule: ContentSafetyRule,
): ReadonlyArray<readonly [number, number]> {
  const phrases = rule.exemptPhrases;
  if (phrases === undefined || phrases.length === 0) {
    return [];
  }
  const ranges: (readonly [number, number])[] = [];
  for (const phrase of phrases) {
    for (const index of occurrenceIndexes(text, phrase)) {
      ranges.push([index, index + phrase.length]);
    }
  }
  return ranges;
}

/**
 * Whether a match lies entirely inside an exempt phrase.
 *
 * Containment, not overlap: 第一时间 exempts the 第一 inside it, while a match
 * that merely touches the edge of an exempt phrase is still a hit. Overlap
 * would let an exempt phrase reach outside itself and silence a neighbouring
 * claim.
 */
function isExempt(
  index: number,
  length: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
  const end = index + length;
  return ranges.some(([start, stop]) => start <= index && end <= stop);
}
