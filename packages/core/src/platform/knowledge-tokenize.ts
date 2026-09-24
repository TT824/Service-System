/**
 * Tokenizing slice text and query terms, so BM25 has something to count.
 *
 * The keyword leg used to score by *substring*: `content ILIKE '%卫衣%'` was
 * worth one point, an exact keyword hit two, and the points were summed. That
 * scorer has no term frequency, no inverse document frequency and no document
 * length — a slice that says `卫衣` once and a slice that says it three times
 * scored the same, and a term that appears in every slice of the catalogue
 * (`规格`, `颜色`) weighed as much as one that appears in nine
 * (`冰雾粉`). BM25 needs the three of them, and the three of them need *terms*,
 * which is what this module produces.
 *
 * **The tokenizer is a bigram one, and that is a decision about this corpus.**
 * A slice is a product title plus one value — 「有棵树男士家居服套装 颜色：冰雾粉」.
 * The words a dictionary would cut it into are exactly the words it does not
 * have: `有棵树` is a brand, `YSPJ1143` is a code, and `冰雾粉` is a colour name
 * no general-purpose segmenter has ever seen. jieba and ICU both cut `冰雾粉`
 * into `冰|雾|粉` and `加大码` into `加大|码`, which is not how a buyer types
 * either of them. Cutting every adjacent *pair* of Chinese characters instead
 * needs no dictionary at all, treats an unknown brand exactly like a known one,
 * and gives partial credit where a substring match gives none:
 * 「加大码女款」 shares `加大` and `大码` with 「加大码」.
 *
 * **It is also the same answer {@link parseKnowledgeQuery} already gave.** The
 * kernel refuses to segment on purpose — 「Terms are runs, not words」 — and a
 * segmenter here would be a second, contradicting answer to the question the
 * kernel declined. Two owners of "what is a term" is the shape this repository
 * spends the most effort making unrepresentable; the bigram rule keeps the owner
 * count at one, because the kernel's runs go into a function, not into a
 * dictionary.
 *
 * **An ASCII run is one token, kept whole.** This is what retires the hazard the
 * kernel's partition was built around: `LIKE '%XL%'` recalls a slice whose size
 * is `XLL` — a garment that does not fit, the 错品 SDD-014 caps at 5% — and the
 * partition answered it by keeping attributes out of the fuzzy path entirely.
 * `XL` and `XLL` are different runs and therefore different tokens, so the
 * scorer cannot make that mistake, and an attribute is safe to *score* without
 * being readmitted to the substring path. Case is folded because buyers type
 * `xl` and merchants write `XL`; they are the same size.
 *
 * **Chinese means `U+4E00`–`U+9FFF`, not "not ASCII".** The loose test is the
 * tempting one and it is wrong: `：`, `（` and `+` are all non-ASCII, and
 * 「颜色：冰雾粉」 would then yield the bigrams `色：` and `：冰` — tokens no
 * query can ever produce, inflating every slice's length and diluting the
 * length normalisation with punctuation. The BMP unified block is the range the
 * catalogue's Chinese actually lies in; the extension blocks are not covered and
 * a slice that used one would simply tokenize to nothing, which is a recall
 * failure this module would rather have visibly than silently.
 *
 * **A single Chinese character is not a token**, for the same reason the kernel
 * refuses one: it recalls everything and distinguishes nothing. A single ASCII
 * character *is* one, because `L` and `M` are how sizes are actually written.
 */

/** The inclusive bounds of the CJK Unified Ideographs block, `U+4E00`–`U+9FFF`. */
const CJK_FIRST = 0x4e00;
const CJK_LAST = 0x9fff;

/**
 * One slice's text or one query term, as the terms BM25 counts.
 *
 * The tokens come back in the order the text holds them, and **no caller may
 * read that order**: the index side counts occurrences into term frequencies and
 * the query side de-duplicates into a term set, and both throw the order away.
 * The repeats are kept rather than collapsed here because collapsing is the
 * query side's job and counting is the index side's, and a function that did
 * either would be answering for the caller.
 *
 * @param text - A slice's `content`, or one term from the parsed question.
 * @returns The tokens, in text order, with multiplicity.
 */
export function tokenizeKnowledgeText(text: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  let run = '';
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (isAsciiAlphanumeric(unit)) {
      run += text[index];
      continue;
    }
    if (run !== '') {
      tokens.push(run.toLowerCase());
      run = '';
    }
    // A pair of Chinese characters is a token; the window slides one character
    // at a time, so 「有棵树」 yields `有棵` and `棵树`. `charCodeAt` past the end
    // is `NaN`, which fails the test and ends the run.
    if (isCjk(unit) && isCjk(text.charCodeAt(index + 1))) {
      tokens.push(text.slice(index, index + 2));
    }
  }
  if (run !== '') {
    tokens.push(run.toLowerCase());
  }
  return Object.freeze(tokens);
}

/**
 * De-duplicate a token list into the term set BM25 scores a query by.
 *
 * Separate from {@link tokenizeKnowledgeText} because the two callers want
 * different things from the same list: the index side counts, and the query
 * side — which has one term and wants the *set* of tokens it stands for — does
 * not want to score `加大` twice for a question that said 「加大码加大码」.
 */
export function tokenizeKnowledgeQuery(text: string): ReadonlyArray<string> {
  return Object.freeze([...new Set(tokenizeKnowledgeText(text))]);
}

/** Whether one UTF-16 code unit is a CJK Unified Ideograph. */
function isCjk(unit: number): boolean {
  return unit >= CJK_FIRST && unit <= CJK_LAST;
}

/** Whether one UTF-16 code unit is `0-9`, `A-Z` or `a-z`. */
function isAsciiAlphanumeric(unit: number): boolean {
  return (unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x5a) || (unit >= 0x61 && unit <= 0x7a);
}
