/**
 * Query parsing: what a buyer asked for, in the three shapes retrieval needs.
 *
 * SDD-014 asks for 「从买家问题解析关键词、属性和否定词」, and this is that kernel.
 * It is the mirror image of `knowledge-keywords`: that module reads *merchant*
 * knowledge at index time and decides what an attribute is; this one reads a
 * *buyer's* question at query time and sorts the same question into three
 * buckets. Neither needs a model and neither needs a database — the vocabulary
 * is an argument, for the same reason it is over there.
 *
 * The three buckets are a **partition**, and that is the whole contract:
 *
 *   * `attributes` — a value the platform can name a dimension for (`品牌：安踏`,
 *     or `XL` when the caller vouched for `XL` being a size). Retrieval matches
 *     these **exactly**.
 *   * `negations` — a value the buyer rejected (`不要黑色`). These are *removed*
 *     from the question before anything else reads it, so they cannot come back
 *     as a keyword and recall the thing the buyer just ruled out.
 *   * `keywords` — what is left: the free text that goes to the fuzzy
 *     (`pg_trgm`) path.
 *
 * A value lands in exactly one bucket. The rule is not cosmetic: a strong
 * constraint that also entered the fuzzy path could re-enter through the back
 * door as a near-miss (`XL` ≈ `XLL`), which is the 错品 SDD-014 caps at 5%.
 *
 * What is recognised as an attribute is **not decided here** — the question is
 * handed to {@link extractKeywords}, so the closed alias map and the vocabulary
 * pass have exactly one owner, and a query and a slice can never disagree about
 * what `颜色分类：黑` means.
 *
 * Four deliberate limits, each of which looks like a gap from the outside:
 *
 *   * **`没有` and `不是` are not negations.** 「有没有XL码」 and 「没有XL码吗」 ask
 *     *for* XL; 「不是黑色的」 rejects it — one character apart, opposite meanings.
 *     A cue list that took `没有` would systematically file a wanted size as an
 *     excluded one — the 错品 the card caps at 5%, arriving as a *parse* rather
 *     than as a match. The A-not-A forms (`要不要`, `想不想要`, `是不是`) and the
 *     `没`-spelled `有没有` are handled the same way, by being flattened before the
 *     cues are looked for — except where the form would swallow a cue itself, which
 *     is what {@link flattenA_Not_A} guards. Which of
 *     the ambiguous forms to trust is exactly what the 300–400 条评测集 is for;
 *     until it exists, only the unambiguous rejections are read.
 *   * **No model numbers by pattern.** `A1234` reads like a 型号 and so does `XL`,
 *     a phone number and a SKU code — the same finding `knowledge-keywords`
 *     records. A 型号 becomes an attribute when the text labels it or the
 *     vocabulary vouches for it, never because it looks like one.
 *   * **Terms are runs, not words.** No segmenter is available and none is
 *     guessed: the question is cut on punctuation and on the question's own
 *     scaffolding, and a long run stays one term. Recall on those runs is what
 *     the evaluation set measures later; this module pins the bucket boundaries,
 *     not the segmentation.
 *   * **A one-character Chinese term is not a keyword.** It recalls everything and
 *     distinguishes nothing under `pg_trgm`. An ASCII run of any length is kept —
 *     `L` and `M` are how sizes are actually written.
 */

import {
  DIMENSION_ALIASES,
  extractKeywords,
  type KeywordKind,
  type KeywordVocabularyEntry,
  type KnowledgeKeyword,
} from './knowledge-keywords';

/** A buyer's question, plus the values the caller already knows to be attributes. */
export type ParseKnowledgeQueryInput = {
  readonly text: string;
  /** Values known to be attributes. Omitted means only labelled pairs classify. */
  readonly vocabulary?: ReadonlyArray<KeywordVocabularyEntry> | undefined;
};

/**
 * A value the buyer rejected.
 *
 * `kind` is `null` when the platform knows *that* something was rejected but not
 * what dimension it belongs to — `不要加绒的` with no vocabulary naming 加绒. The
 * honest record of a half-known fact is a half-filled row, not a guess.
 */
export type QueryNegation = {
  readonly kind: KeywordKind | null;
  readonly text: string;
};

/** The question, sorted. `attributes` reuses the index side's keyword shape. */
export type ParsedKnowledgeQuery = {
  readonly keywords: ReadonlyArray<string>;
  readonly attributes: ReadonlyArray<KnowledgeKeyword>;
  readonly negations: ReadonlyArray<QueryNegation>;
};

/**
 * How many free-text terms one question may carry.
 *
 * A bound, not a target: past this a "question" is a pasted conversation, and the
 * tail of a pasted conversation is where the previous topic sits. Overflow is
 * dropped from the tail, the same direction the keyword cap drops.
 */
export const KNOWLEDGE_QUERY_MAX_KEYWORDS = 16;

/**
 * The prefixes a buyer writes to reject something, longest first so that
 * `不想要` is read as itself rather than as `不要` followed by `想`.
 *
 * What is **absent** is the point of the list: `没有` / `不是` (see the module
 * note), `非` (`非常` is not a rejection), `除…之外` (a scope, not a cue), `不` on
 * its own (`不锈钢`, `不易皱`), and — the one that costs the most — `别`, because
 * 「别的颜色有吗」 asks for *other* colours and would otherwise be read as a
 * rejection of the colour dimension.
 */
const NEGATION_CUES: ReadonlyArray<string> = Object.freeze([
  '不想要',
  '不喜欢',
  '不接受',
  '不考虑',
  '不需要',
  '不要',
  '不用',
  '不带',
  '不含',
  '拒绝',
  '勿',
]);

/**
 * The question forms that are not rejections, spelled both of the ways Chinese
 * spells one: the A-not-A verbs `要不要`, `想不想要`, `是不是`, and the
 * `没`-spelled `有没有`.
 *
 * Flattened to spaces before any cue is looked for — same length, so every other
 * index still means what it did — which is what keeps 「要不要黑色的」 a question
 * about black, and what keeps 「有没有XL码」 from leaving `没有XL码` behind as a term
 * that matches no slice anybody wrote. `能不要…` is the shape this loses; it is
 * rare and ambiguous in Chinese anyway.
 *
 * A form that **begins inside a cue** is left alone; that guard is in
 * {@link flattenA_Not_A}, and it is what keeps 「不要不要XL」 a rejection.
 */
const A_NOT_A_FORM = /(?:要|想|是|有|能|会)不(?:要|想|是|有|能|会)|有没(?:有|货)/gu;

/**
 * Where a rejection stops inside a clause that has no punctuation to stop it.
 *
 * 「不要XL要M」 has no comma; the positive pivot `要` is what separates the rejected
 * value from the wanted one. Only a stated intent turns the sentence back around,
 * so the set is verbs a buyer uses to ask for something, and a pivot at the very
 * start of the span is not one (`不要有异味的` rejects 有异味, not nothing).
 */
const NEGATION_PIVOT_CHARS: ReadonlySet<string> = new Set(['要', '想', '买', '换', '来']);

/**
 * Characters that are the question rather than its subject: particles, the
 * copula, pronouns and the request verbs.
 *
 * They are **trimmed from the ends** of a run rather than splitting it, which is
 * what turns `是不是黑色的` into `黑色` in one step. Trimming costs the occasional
 * real word that starts with one of them (`有货` → `货`), and that is the accepted
 * side of the trade: the alternative is a part-of-speech tagger.
 */
const SCAFFOLD_CHARS: ReadonlySet<string> = new Set(
  Array.from('的了吗呢吧啊哦呀嘛哈是有请我你他她它咱我们要想买能可以会个款件双条只怎哪谁啥问'),
);

/**
 * The classifiers a buyer puts after a value: `XL码`, `42码`, `两件`.
 *
 * Deliberately **not** in {@link SCAFFOLD_CHARS}: trimmed from a run's ends, `码`
 * would take `大码` down to a single character and the term would be dropped —
 * and 大码 is a thing buyers search for. It is a classifier, so it is only ever
 * accepted *around a value the platform already recognised*.
 */
const MEASURE_CHARS: ReadonlySet<string> = new Set(Array.from('码号个件双条只款副对'));

/**
 * Clause boundary. A negation never reaches past one — 「不要黑色的，XL有吗」 is two
 * clauses and only the first is negative.
 */
const CLAUSE_SEPARATOR = /[。；;！!？?，,、\n\r]+/u;

/**
 * What separates terms. Punctuation and whitespace only, with one deliberate
 * difference from the index side: `|` and `/` **do** separate here.
 *
 * Over there they are inside a value, because `黑|白` is one colour column with two
 * values and `S/M/L` is one size range — a merchant writes them. A buyer does not:
 * `安踏/李宁` is two brands asked about in one breath.
 */
const TERM_SEPARATOR = /[\s|/，,。；;：:、！!？?（）()【】[\]{}《》<>"'“”‘’`~～+\-*&^%$#@=_\\]+/u;

/**
 * Sort a buyer's question into keywords, attributes and negations.
 *
 * Attributes are collected from the whole question *before* keywords are, so a
 * value claimed by the attribute vocabulary is never also emitted as free text —
 * the partition holds across clauses, not just inside one.
 *
 * @param input - The question and, optionally, the values known to be attributes.
 * @returns The three buckets; every bucket is empty rather than absent when it is.
 */
export function parseKnowledgeQuery(input: ParseKnowledgeQueryInput): ParsedKnowledgeQuery {
  const vocabulary = input.vocabulary ?? [];
  const clauses = input.text.split(CLAUSE_SEPARATOR).filter((clause) => clause.trim().length > 0);

  const readings = clauses.map((clause) => readClause(clause));
  const positiveText = readings.map((reading) => reading.positive).join(' ');

  const attributes: KnowledgeKeyword[] = [];
  const seenAttributes = new Set<string>();
  for (const hit of extractKeywords({ text: positiveText, vocabulary })) {
    const key = `${hit.kind} ${hit.text.toLowerCase()}`;
    if (seenAttributes.has(key)) {
      continue;
    }
    seenAttributes.add(key);
    attributes.push(hit);
  }
  const claimed = new Set(attributes.map((attribute) => attribute.text.toLowerCase()));

  const negations: QueryNegation[] = [];
  const keywords: string[] = [];
  const seenKeywords = new Set<string>();
  for (const reading of readings) {
    for (const span of reading.negations) {
      negations.push(...negationOf(span, vocabulary));
    }
    for (const term of queryTerms(reading.positive, claimed)) {
      if (keywords.length >= KNOWLEDGE_QUERY_MAX_KEYWORDS) {
        break;
      }
      const key = term.toLowerCase();
      if (seenKeywords.has(key)) {
        continue;
      }
      seenKeywords.add(key);
      keywords.push(term);
    }
  }

  return Object.freeze({
    keywords: Object.freeze(keywords),
    attributes: Object.freeze(attributes),
    negations: Object.freeze(negations),
  } satisfies ParsedKnowledgeQuery);
}

/** One clause, split into the text that survives and the spans a cue rejected. */
type ClauseReading = {
  readonly positive: string;
  readonly negations: ReadonlyArray<string>;
};

/** A cue found in a clause, and what it rejected. */
type NegationMatch = {
  readonly start: number;
  readonly end: number;
  readonly span: string;
};

/** Cut one clause at its negation cues and keep everything else. */
function readClause(clause: string): ClauseReading {
  const flattened = flattenA_Not_A(clause);
  const matches = findNegationMatches(flattened);
  const negations: string[] = [];
  let positive = '';
  let from = 0;
  for (const match of matches) {
    positive += flattened.slice(from, match.start);
    from = match.end;
    if (match.span.length > 0) {
      negations.push(match.span);
    }
  }
  positive += flattened.slice(from);
  return { positive, negations };
}

/**
 * Blank out the question forms, keeping every index where it was.
 *
 * The returned string is the clause as far as every other rule is concerned, which
 * is why the two are not allowed to drift: a cue's position, a span's bounds and
 * the text that survives are all read off the same length.
 *
 * One form is deliberately left where it is: the one that **starts inside a cue**.
 * `不要` ends in `要`, so a repeated 「不要不要」 spells a form one character into
 * the buyer's rejection — blanking it would delete the cue and hand the rejected
 * value back as something to search *for*. The cues this reads are the ones the
 * matches are read from ({@link findCueSpans}), and the two agree by construction:
 * a form that is blanked cannot create or destroy a cue, so the scan below sees
 * the same spans in the same places.
 */
function flattenA_Not_A(clause: string): string {
  const cues = findCueSpans(clause);
  return clause.replace(A_NOT_A_FORM, (form: string, offset: number) =>
    cues.some((cue) => cue.start < offset && offset < cue.end) ? form : ' '.repeat(form.length),
  );
}

/** Where one cue sits in a clause. */
type CueSpan = { readonly start: number; readonly end: number };

/** Every cue in a clause, left to right. */
function findCueSpans(text: string): ReadonlyArray<CueSpan> {
  const cues: CueSpan[] = [];
  let index = 0;
  while (index < text.length) {
    const cue = NEGATION_CUES.find((candidate) => text.startsWith(candidate, index));
    if (cue === undefined) {
      index += 1;
      continue;
    }
    cues.push({ start: index, end: index + cue.length });
    index += cue.length;
  }
  return cues;
}

/** Every cue in a clause, left to right, each with the text it rejected. */
function findNegationMatches(flattened: string): ReadonlyArray<NegationMatch> {
  const cues = findCueSpans(flattened);

  const matches: NegationMatch[] = [];
  let previousEnd = 0;
  for (const [at, cue] of cues.entries()) {
    const next = cues[at + 1];
    const limit = Math.min(next?.start ?? flattened.length, pivotIndex(flattened, cue.end));
    const forward = flattened.slice(cue.end, limit);
    if (forward.trim().length > 0) {
      matches.push({ start: cue.start, end: limit, span: forward });
      // What this cue claimed reaches `limit` — the pivot verb, or the next cue —
      // so that is how far the next one may look back.
      previousEnd = limit;
    } else {
      // The rejection is postposed — 「黑色的不要」 — so it lands on the text before
      // the cue, back to the previous cue so that two cues never claim one value.
      const span = flattened.slice(previousEnd, cue.start);
      matches.push({ start: previousEnd, end: cue.end, span: span.trim().length > 0 ? span : '' });
      previousEnd = cue.end;
    }
  }
  return matches;
}

/** Where the span a cue opened turns back into a request, or the end of the clause. */
function pivotIndex(clause: string, from: number): number {
  for (let at = from + 1; at < clause.length; at += 1) {
    if (NEGATION_PIVOT_CHARS.has(clause[at] ?? '')) {
      return at;
    }
  }
  return clause.length;
}

/**
 * What a rejected span rejected.
 *
 * The vocabulary decides when it can (`不要黑色的` + a colour vocabulary → a colour
 * negation). When it cannot, the span's own terms are reported with `kind: null`,
 * minus any term that is just how a classified hit was written — the span
 * `黑色的` with a vocabulary of `黑` is one rejection, not two.
 */
function negationOf(
  span: string,
  vocabulary: ReadonlyArray<KeywordVocabularyEntry>,
): ReadonlyArray<QueryNegation> {
  const hits = extractKeywords({ text: span, vocabulary });
  const negations: QueryNegation[] = hits.map((hit) => ({ kind: hit.kind, text: hit.text }));
  const classified = hits.map((hit) => hit.text.toLowerCase());
  for (const term of queryTerms(span, new Set())) {
    const key = term.toLowerCase();
    if (classified.some((text) => text.includes(key) || key.includes(text))) {
      continue;
    }
    negations.push({ kind: null, text: term });
  }
  return negations;
}

/** The free-text terms of a positive remainder, without the values already claimed. */
function queryTerms(text: string, claimed: ReadonlySet<string>): ReadonlyArray<string> {
  const terms: string[] = [];
  for (const run of text.split(TERM_SEPARATOR)) {
    const term = trimScaffold(run);
    if (term.length === 0 || claimed.has(term.toLowerCase()) || restatesClaimed(term, claimed)) {
      continue;
    }
    if (DIMENSION_ALIASES[term] !== undefined) {
      continue;
    }
    if (!isAsciiWord(term) && countChars(term) < 2) {
      continue;
    }
    terms.push(term);
  }
  return terms;
}

/**
 * Whether a term is an already-claimed value with nothing but scaffolding and a
 * classifier around it — `XL码` once `XL` is a size.
 *
 * Without this the partition leaks on the most ordinary question shape there is,
 * because a buyer writes the classifier and an attribute value does not carry one.
 * The guard is the "nothing but" part: `黑色牛仔裤` also contains a claimed `黑`, and
 * it is a term in its own right.
 */
function restatesClaimed(term: string, claimed: ReadonlySet<string>): boolean {
  const lower = term.toLowerCase();
  for (const text of claimed) {
    if (text.length === 0 || !lower.includes(text)) {
      continue;
    }
    const around = lower.replace(text, '');
    if (Array.from(around).every((character) => isDecoration(character))) {
      return true;
    }
  }
  return false;
}

/** Whether a character carries no product meaning of its own. */
function isDecoration(character: string): boolean {
  return SCAFFOLD_CHARS.has(character) || MEASURE_CHARS.has(character) || /\s/u.test(character);
}

/** Strip the question's own scaffolding from both ends of a run. */
function trimScaffold(run: string): string {
  let start = 0;
  let end = run.length;
  while (start < end && SCAFFOLD_CHARS.has(run[start] ?? '')) {
    start += 1;
  }
  while (end > start && SCAFFOLD_CHARS.has(run[end - 1] ?? '')) {
    end -= 1;
  }
  return run.slice(start, end).trim();
}

/** Whether the term is an ASCII word, which keeps its single characters. */
function isAsciiWord(term: string): boolean {
  return /^[A-Za-z0-9]+$/u.test(term);
}

/** Length in Unicode code points, matching the index side's counter. */
function countChars(text: string): number {
  return Array.from(text).length;
}
