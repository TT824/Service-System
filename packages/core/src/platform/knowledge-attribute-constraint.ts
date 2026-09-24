/**
 * The attribute constraint: the slices that carry the value the buyer named, and
 * not the ones that carry another value of the same dimension.
 *
 * This is the step between {@link fuseRecall} and {@link applyRerankOrder}, and
 * it exists because of a reading rather than a principle. On 2026-09-21 the
 * reranker turned out to read the literal signals in a question well and colour
 * barely at all: the wrong-product rate of `code` questions fell 65.9% → 8.7%
 * while `color` moved 49.2% → 45.9%, on the same arm, in the same run. A
 * cross-encoder asked to score 「有棵树内裤 黑色」 against 「… 颜色：漫暮黑L」 is
 * being asked to know that 黑 and 漫暮黑 are the same colour by *reading both
 * strings*, and it does not know it.
 *
 * The index does. The colour was a labelled column in the merchant's sheet, not
 * a word in a sentence, so `颜色：漫暮黑` is a **fact about the slice** — the same
 * fact `knowledge-keywords` already extracts from it under kind `color`, and the
 * same one `eval/generate-queries.cjs` already reads to build a question. So this
 * module does not parse prose to find colours and does not guess: it reads the
 * labelled line the indexer wrote, and it spends the fact.
 *
 * **Why the case that costs the most is a question with no colour in it.** The
 * pool is what supplies the vocabulary — a value is "asked for" when the buyer's
 * own words contain it — so a question that names none of the colours in front
 * of it constrains nothing and the answer is the fused list, unchanged. That is
 * the same answer every deployment gave before this module existed, and it is
 * deliberate: the alternative reads a colour out of the question using a lexicon
 * this repository does not have and would have to maintain, and a question whose
 * colour is misread is a question answered with the wrong product.
 *
 * **Why an empty result falls back rather than answering nothing.** A constraint
 * that throws away every candidate would turn "the buyer named a colour this
 * catalogue does not have in the pool" into "the platform suggests nothing",
 * which is a worse answer than the unfiltered list and indistinguishable to an
 * agent from an outage. So the last thing this module does is check that it left
 * something behind, and `applied` says which of the two answers the caller got.
 *
 * **The numbers this is measured against are honest about being circular.** The
 * frozen question set defines a colour question's target as "the SPUs that have a
 * SKU in that colour", and this module decides by the same fact, so its reading
 * on that set is optimistic by construction. The reading that is not circular is
 * the strict one — of the five slices in the answer, how many carry the colour
 * the *question record* names — and it is reported alongside. See
 * `eval/README.md` and the plan of 2026-09-21.
 */

import type { FusedRecallHit } from './knowledge-fusion';
import { DIMENSION_ALIASES, type KeywordKind } from './knowledge-keywords';
import { parseKnowledgeQuery } from './knowledge-query';

/**
 * The dimensions this module constrains.
 *
 * Two of {@link KeywordKind}'s values, not a vocabulary of its own: a dimension
 * that has no label in `DIMENSION_ALIASES` was never extracted as a keyword
 * either, so there is nothing for a constraint to read. `规格` is absent for that
 * reason and not by oversight — it is deliberately not a dimension (see that
 * file), so a slice's `规格：` line yields no value here.
 *
 * `size` is nearly empty in this catalogue: 189 keyword rows against 13,458 for
 * `color`, because the merchant's sheets write `规格`. It is constrained anyway
 * because it costs one regex and because a dimension that is inert is measurably
 * inert — the readings say so, rather than an argument here.
 */
export type ConstrainedDimension = Extract<KeywordKind, 'color' | 'size'>;

/**
 * The labels each dimension is written under, longest first.
 *
 * Taken from {@link DIMENSION_ALIASES} rather than declared again, so that
 * widening the platform's vocabulary widens this module with it. Longest first
 * only matters for the alternation's readability: a label has to be followed by
 * a colon to match, which is what keeps `颜色` from matching inside `颜色分类：`.
 */
const LABELS: Readonly<Record<ConstrainedDimension, ReadonlyArray<string>>> = Object.freeze({
  color: labelsOf('color'),
  size: labelsOf('size'),
});

function labelsOf(dimension: ConstrainedDimension): ReadonlyArray<string> {
  return Object.freeze(
    Object.entries(DIMENSION_ALIASES)
      .filter(([, kind]) => kind === dimension)
      .map(([label]) => label)
      .sort((left, right) => right.length - left.length),
  );
}

/**
 * Where the next labelled pair begins, whatever dimension it belongs to.
 *
 * A value ends where the next label does, and that is a fact about the text
 * rather than about this module: `颜色：炭黑 尺码：XL` is two pairs the indexer
 * happened to write on one line, and a reader that took the rest of the line as
 * the colour would carry `尺码：XL` into the value and then refuse the whole
 * thing for not being Chinese. The labels of *every* dimension cut here, not just
 * the one being read, because what follows a colour can be anything.
 */
const NEXT_LABEL = new RegExp(
  `(?:${Object.keys(DIMENSION_ALIASES)
    .sort((left, right) => right.length - left.length)
    .join('|')})\\s*[:：]`,
  'u',
);

/** A trailing size or article number: `漫暮黑L`, `深咖灰160/68A(M)`. */
const TRAILING_SIZE = /[A-Za-z0-9+\-/.()（）\s]+$/u;

/** Everything that is a Chinese character and nothing else. */
const CHINESE_ONLY = /^[一-鿿]+$/u;

/**
 * A label written a second time inside the value it introduced.
 *
 * This is not hypothetical: `CC福利品-2 颜色：颜色: 漫暮黑,尺码: F` is a slice in
 * this catalogue, because the merchant's variant column held the whole pair as
 * one string. Stripped here rather than inside the normalizers so that those two
 * stay byte-for-byte the rule `generate-queries.cjs` has always applied — see
 * {@link normalizeColourValues}.
 */
const LEADING_LABEL = /^[^\s:：]{1,6}\s*[:：]\s*/u;

/**
 * The colour values inside one raw colour string, normalized.
 *
 * **This is `colorTokens` in `eval/generate-queries.cjs`, moved.** The two have
 * to agree exactly: the frozen question set was generated with that rule, so a
 * question's colour word and a slice's colour value are only comparable if both
 * sides are cut by it. That is also why duplicates are kept — the generator picks
 * from this list, and deduplicating changes what it picks. Callers that want a
 * set build one.
 *
 * The rule, in the order the merchant's own values need it: a multi-pack is
 * several values in one cell (`黑色+深灰+烟灰`), so split on `+` and the Chinese
 * separators; the size rides along with the colour (`乌云灰S`, `漫暮黑-165/72A(L)`)
 * because the column that held the colour held the whole variant, so strip a
 * trailing run of letters, digits and brackets; and what is left has to be a
 * Chinese word — a value that normalizes to nothing was never a colour.
 *
 * @param raw - One colour cell, as the merchant wrote it or as a slice quotes it.
 * @returns The values found, in order, possibly empty.
 */
export function normalizeColourValues(raw: string): ReadonlyArray<string> {
  const values: string[] = [];
  for (const part of raw.split(/[+、,，/]/u)) {
    const value = part.replace(TRAILING_SIZE, '').trim();
    if (value.length >= 2 && CHINESE_ONLY.test(value)) {
      values.push(value);
    }
  }
  return Object.freeze(values);
}

/**
 * The size values inside one raw size string, normalized.
 *
 * `sizeTokens` in `eval/generate-queries.cjs`, moved, and kept in step with
 * {@link normalizeColourValues} for the same reason. A size column carries its
 * measurement in brackets — `L (95-120斤);XL (120-140斤)` — so the list is split
 * on `;` and each entry is read up to its bracket; unlike a colour, a size is
 * *not* Chinese (`L`, `XL`, `2XL`, `160/68A`), which is the whole of the filter.
 *
 * @param raw - One size cell.
 * @returns The sizes found, in order, possibly empty.
 */
export function normalizeSizeValues(raw: string): ReadonlyArray<string> {
  const values: string[] = [];
  for (const part of raw.split(';')) {
    const value = (part.split(/[(（]/u)[0] ?? '').trim();
    if (value.length > 0 && value.length <= 6 && !CHINESE_ONLY.test(value)) {
      values.push(value);
    }
  }
  return Object.freeze(values);
}

/** Whether one separator-delimited part of a cell names a colour and nothing else. */
function understood(part: string): boolean {
  return normalizeColourValues(part).length > 0;
}

/** A colour cell read both ways: the colours it names, and the size that rode along. */
export type ColourCellSplit = {
  readonly colors: ReadonlyArray<string>;
  readonly size: string | null;
};

/**
 * The same read as {@link normalizeColourValues}, with the size tail kept.
 *
 * The merchant's colour column held the whole variant, so a third of this
 * catalogue's colour cells end in a size or an article number — `漫暮黑L`,
 * `乌云灰S`, `漫暮黑-165/72A(L)`. {@link normalizeColourValues} throws that tail
 * away, which is right for a reader that only wants to know *which colour* the
 * slice carries and wrong for a caller that is writing the slice in the first
 * place: a slice reading `颜色：漫暮黑L` is a line whose colour word is glued to
 * its size, and the reranker scores the query against exactly that string (see
 * this module's note, and L2 in the plan of 2026-09-21). So the tail is reported
 * here rather than discarded, and `knowledge/index-source.ts` spends it as a
 * `尺码：` line of its own.
 *
 * **The tail is read off the whole cell, never off its last separated part.** `/`
 * separates colours (`黑色/白色`) and is also inside an article number, so
 * `漫暮黑-160/84A(M)` — one colour, one size — would otherwise be read as a cell
 * ending in the value `84A(M)`.
 *
 * **Every part of the cell has to be understood before any of it is taken apart.**
 * A cell is several values on one line, so a part that names no colour is a value
 * this rule cannot account for, and reporting the rest of the cell as a colour
 * and a size quietly *deletes* it: `黑色镜框+灰色镜片-F(均码)` is a real row of
 * this catalogue, and read part by part it is a colour (`黑色镜框`) and a tail
 * (`)`) — the second colour gone, and a size that is a bracket. So a tail is
 * reported only when the whole cell reads, and the caller then leaves the cell
 * alone; the price is stated in the plan of 2026-09-21 rather than paid silently.
 *
 * **The tail is only a size when the cell had one, and when it reads back.** A
 * `图片色` or a bare `L` has no colour, so there is no pair to take apart; and
 * what is left is passed through {@link normalizeSizeValues}, because a size the
 * platform cannot read off the line it is written on is a size moved for no one's
 * benefit. `-S` loses its separator and becomes `S`; `165/72A(L)` comes back as
 * nothing at all, since the article number it leads with is longer than any size
 * this vocabulary has.
 *
 * @param raw - One colour cell, as the merchant wrote it.
 * @returns The colours the cell names, and the size glued to them if it reads back.
 */
export function splitColourCell(raw: string): ColourCellSplit {
  const colors = normalizeColourValues(raw);
  if (colors.length === 0 || !raw.split(/[+、,，/]/u).every(understood)) {
    return Object.freeze({ colors, size: null });
  }
  const withoutTail = raw.replace(TRAILING_SIZE, '');
  const sizes = normalizeSizeValues(
    raw.slice(withoutTail.length).replace(/^[\s+\-/]+/u, '').trim(),
  );
  return Object.freeze({ colors, size: sizes.length === 0 ? null : sizes.join(';') });
}

/**
 * The values one slice carries for one dimension, read off its own text.
 *
 * The slice's `content` is what the indexer wrote: the merchant's labelled lines,
 * each prefixed with the product's title when it came from a SKU (`knowledge/
 * index-source.ts`). So the read is "find the label, take the rest of its line,
 * normalize it" — no NER, no model, and no second copy of the extraction rule,
 * because the label is the extraction rule.
 *
 * A slice with no line for the dimension answers with an empty list, which
 * {@link constrainRecallByAttribute} reads as "unknown" rather than "wrong" — a
 * FAQ slice has no colour and is not thereby off-topic.
 *
 * @param content - One slice's text.
 * @param dimension - Which labelled line to read.
 * @returns The normalized values, in the order the lines appear.
 */
export function sliceAttributeValues(
  content: string,
  dimension: ConstrainedDimension,
): ReadonlyArray<string> {
  const labels = LABELS[dimension];
  const pattern = new RegExp(`(?:${labels.join('|')})\\s*[:：]\\s*([^\\n\\r]*)`, 'gu');
  const values: string[] = [];
  for (const match of content.matchAll(pattern)) {
    const line = (match[1] ?? '').replace(LEADING_LABEL, '');
    const end = line.search(NEXT_LABEL);
    const raw = end === -1 ? line : line.slice(0, end);
    values.push(...(dimension === 'color' ? normalizeColourValues(raw) : normalizeSizeValues(raw)));
  }
  return Object.freeze(values);
}

/** What one read of a candidate pool found, and which way it was spent. */
export type AttributeConstraint = {
  /**
   * How the pool was cut. `named` kept the slices carrying a value the buyer
   * named; `rejected` kept everything that did not carry one they refused;
   * `none` is the whole list back — see `applied`.
   */
  readonly mode: 'named' | 'rejected' | 'none';
  /** The values the buyer's own words name, from the pool's own vocabulary. */
  readonly asked: ReadonlyArray<string>;
  /** The values the buyer's own words reject, likewise. */
  readonly negated: ReadonlyArray<string>;
  /** How many candidates the constraint removed. */
  readonly dropped: number;
  /**
   * Whether `hits` is the constrained list or the list it was given.
   *
   * False has two causes and the caller cannot tell them apart, on purpose:
   * nothing was named, or everything was removed and the answer fell back. Both
   * mean "ask the same question you would have asked", and an operator reading a
   * log line wants the count, which is `dropped` and is zero in both cases.
   */
  readonly applied: boolean;
  /** The candidates to rerank: the constrained list, or the input unchanged. */
  readonly hits: ReadonlyArray<FusedRecallHit>;
};

/**
 * Does the buyer's question name this value?
 *
 * **A Chinese value is looked for as a substring, and an ASCII one is not.** The
 * asymmetry is the language's, not a shortcut: Chinese is written without spaces,
 * so 「有黑色的吗」 contains 黑色 and 「漫暮黑」 contains 黑, and substring is the only
 * comparison that finds a value inside a clause. `L`, on the other hand, is a
 * letter that occurs inside `XL`, inside `26AW` and inside a product code, so a
 * size is matched as a whole token — which is also how a buyer writes one, with
 * a space in front of it, and how the question set was generated.
 */
function queryNamesValue(text: string, value: string): boolean {
  if (CHINESE_ONLY.test(value)) {
    return text.includes(value);
  }
  const tokens = text.split(/[^0-9A-Za-z一-鿿]+/u);
  return tokens.some((token) => token.toLowerCase() === value.toLowerCase());
}

/**
 * Cut a fused candidate list down to the slices that carry the value the buyer
 * named, or that carry none at all.
 *
 * Pure and total: every input has an answer, the answer is a subsequence of the
 * input, and the same input always gives the same answer. It is a module of its
 * own — beside {@link fuseRecall} and {@link applyRerankOrder} rather than inside
 * the retrieval service — for the reason those are: the rule can be stated,
 * falsified and *measured* without a socket, and the second caller is the ruler.
 *
 * The order is the fusion's and is preserved: this step decides what is eligible,
 * never what is best. Nothing is promoted, so a slice the constraint saves from
 * the bottom of the pool still has to earn its place from the reranker.
 *
 * @param input.hits - The fused candidates, best first.
 * @param input.query - The buyer's question, verbatim.
 * @returns The eligible candidates, and what the read of the pool found.
 */
export function constrainRecallByAttribute(input: {
  readonly hits: ReadonlyArray<FusedRecallHit>;
  readonly query: string;
}): AttributeConstraint {
  const { hits, query } = input;

  /** Each candidate's own values, both dimensions at once, as one set. */
  const own = hits.map((hit) => {
    const values = new Set<string>([
      ...sliceAttributeValues(hit.chunk.content, 'color'),
      ...sliceAttributeValues(hit.chunk.content, 'size'),
    ]);
    return { hit, values };
  });

  // The pool is the vocabulary. A value this catalogue does not have in front of
  // the question is a value the question cannot be asking about, and reading the
  // question for colours with a lexicon of our own is the mistake this avoids.
  const pool = [...new Set(own.flatMap((entry) => [...entry.values]))];

  // Rejection first, because a cue and a value can be in the same question and
  // the cue is the one that says what to do with it: 「不要黑色」 names 黑色 and
  // rejects it, and reading only the name would filter *to* it.
  const rejection = parseKnowledgeQuery({ text: query })
    .negations.map((negation) => negation.text)
    .join(' ');
  const negated = pool.filter((value) => queryNamesValue(rejection, value));
  const asked = pool.filter(
    (value) => queryNamesValue(query, value) && !negated.includes(value),
  );

  const wanted =
    asked.length > 0
      ? { mode: 'named' as const, values: asked, matches: (values: Set<string>) => values.size === 0 || asked.some((value) => values.has(value)) }
      : negated.length > 0
        ? { mode: 'rejected' as const, values: negated, matches: (values: Set<string>) => !negated.some((value) => values.has(value)) }
        : null;

  if (wanted === null) {
    return Object.freeze({
      mode: 'none',
      asked: Object.freeze(asked),
      negated: Object.freeze(negated),
      dropped: 0,
      applied: false,
      hits,
    });
  }

  const kept = own.filter((entry) => wanted.matches(entry.values)).map((entry) => entry.hit);

  // An answer of nothing is not the answer. See the module note: the fallback is
  // the input, and the caller is told by `applied` rather than by an empty list.
  if (kept.length === 0) {
    return Object.freeze({
      mode: 'none',
      asked: Object.freeze(asked),
      negated: Object.freeze(negated),
      dropped: 0,
      applied: false,
      hits,
    });
  }

  return Object.freeze({
    mode: wanted.mode,
    asked: Object.freeze(asked),
    negated: Object.freeze(negated),
    dropped: hits.length - kept.length,
    applied: true,
    hits: Object.freeze(kept),
  });
}
