/**
 * Chunking: cut one field of one knowledge source into indexable slices.
 *
 * This module owns the answer to "what is one slice?" for the whole platform.
 * The indexer writes these rows and retrieval reads them, so a second copy of
 * the rule would give the platform two ideas of what a chunk is — the same
 * reason {@link usableKnowledge} has a file of its own.
 *
 * Two modes, because the card draws a distinction and the distinction is real:
 *
 *   * **Prose** (a title, an answer, a description) is packed into slices of
 *     roughly {@link KNOWLEDGE_CHUNK_TARGET_CHARS} to
 *     {@link KNOWLEDGE_CHUNK_MAX_CHARS} characters, breaking at sentence
 *     boundaries so a slice does not end mid-sentence.
 *
 *   * **Structured** (a spec table, a price, a stock figure) is never cut inside
 *     an item and never merged with a neighbour. SDD-013 is explicit that
 *     "结构化规格、价格和库存信息不会被错误拆散" — a price that has been split
 *     from its unit, or a spec whose name and value landed in different slices,
 *     is worse than a small slice. One item, one slice.
 *
 * Both modes share one counter: `charCount` is **Unicode code points**, not
 * UTF-16 units, so a character outside the BMP counts as one the way a reader
 * would count it. The card says 约 200～500 中文字符 — 约, approximately — so this
 * is a soft target and a hard ceiling: see {@link chunkProse} about the short
 * slice that uneven text can still force.
 *
 * No hashing and no I/O happen here. `content_hash` is the caller's to compute
 * from the returned `content`, which keeps this a pure text function the web
 * bundle can import and the test suite can drive without a database.
 */

/**
 * The length a prose slice is packed up to before a sentence boundary is taken.
 *
 * A preference, not a promise: text whose sentences are unevenly sized can
 * still produce a shorter slice, and {@link chunkProse} documents when.
 */
export const KNOWLEDGE_CHUNK_TARGET_CHARS = 200;

/** The hard ceiling for one slice. No prose slice is ever longer than this. */
export const KNOWLEDGE_CHUNK_MAX_CHARS = 500;

/**
 * How much of each neighbouring slice is carried along as context.
 *
 * Bounded on purpose. The point is to let one slice be read in the company it
 * was written in — a pronoun's referent, the heading a spec list sat under —
 * without re-importing the document the slice was cut from.
 */
export const KNOWLEDGE_CHUNK_CONTEXT_CHARS = 60;

/**
 * What a slice is. Mirrors the `chunk_type` CHECK in migration
 * `0011_knowledge_index`, and is deliberately the whole vocabulary the schema
 * accepts — the product-side values included, so that "products are not sliced"
 * was a type error rather than a silently empty field list.
 *
 * `price` and `stock` are the two that remain unproduced, and on purpose: the
 * catalogue's price and stock are *answered from* when a product has been
 * recalled, not sliced (see the `product` entry in {@link KNOWLEDGE_FIELDS}).
 * `spec` and `title` are written for products and their variants.
 */
export type ChunkType =
  | 'title'
  | 'selling_point'
  | 'spec'
  | 'usage'
  | 'after_sale'
  | 'question'
  | 'answer'
  | 'content'
  | 'price'
  | 'stock';

/**
 * The source kinds this kernel can slice.
 *
 * `product` and `product_sku` were added once the catalogue held rows to slice:
 * `0011` fixed the vocabulary from the start, and the union was left narrower on
 * purpose so that "the indexer does not cover products" was a type error rather
 * than a source kind that silently produced nothing. Widening it meant this
 * union, its entry in {@link KNOWLEDGE_FIELDS}, and every place the compiler then
 * named — which is what that arrangement was for.
 *
 * The names are written once, in {@link INDEXED_SOURCE_KINDS}, because two
 * callers need to *iterate* them rather than only be checked against them: a
 * status filter arriving as a query string, and a report grouping rows by kind.
 */
export const INDEXED_SOURCE_KINDS = [
  'faq',
  'faq_variant',
  'shortcut',
  'product',
  'product_sku',
] as const;

/** One kind of knowledge source the indexer reads. */
export type IndexedSourceKind = (typeof INDEXED_SOURCE_KINDS)[number];

/** Whether a value is one of {@link INDEXED_SOURCE_KINDS}. */
export function isIndexedSourceKind(value: string): value is IndexedSourceKind {
  return (INDEXED_SOURCE_KINDS as ReadonlyArray<string>).includes(value);
}

/** How one field must be sliced. */
export type ChunkableField = {
  /** The column name in the source table, recorded as `source_field`. */
  readonly field: string;
  readonly chunkType: ChunkType;
  readonly mode: 'prose' | 'structured';
};

/**
 * Which fields of which source become slices, in what order.
 *
 * Field order is the order their slices receive `chunkIndex` within a source, so
 * it is part of the row identity and not a presentation detail.
 */
export const KNOWLEDGE_FIELDS: Readonly<Record<IndexedSourceKind, ReadonlyArray<ChunkableField>>> =
  Object.freeze({
    faq: Object.freeze([
      { field: 'question', chunkType: 'question', mode: 'prose' },
      { field: 'answer', chunkType: 'answer', mode: 'prose' },
    ]),
    faq_variant: Object.freeze([{ field: 'question_text', chunkType: 'question', mode: 'prose' }]),
    shortcut: Object.freeze([
      { field: 'title', chunkType: 'title', mode: 'prose' },
      { field: 'content', chunkType: 'content', mode: 'prose' },
    ]),
    /**
     * A product's searchable surface: what it is called, and the attributes a
     * customer would recognise it by.
     *
     * `attributes` is a **derived** value, not a column: the source row carries
     * `common_attributes_json` (a map), and the job hands over the labelled lines
     * the whitelist produced — see `index-source` and `product-knowledge`. The
     * name is the kernel's, and the projection is what has to agree with it.
     *
     * Only the customer-visible attributes and never the variant facts: the
     * catalogue's `售价` / `库存` are answered from, not recalled on, and a price
     * does not belong in the text that decides which product is meant.
     */
    product: Object.freeze([
      { field: 'title', chunkType: 'title', mode: 'prose' },
      { field: 'attributes', chunkType: 'spec', mode: 'structured' },
    ]),
    /**
     * One variant's dimensions.
     *
     * `variant` is derived the same way, from `variant_json`. The variant's own
     * facts (`售价`, `库存`) are deliberately absent — see the note on `product`;
     * the slice exists so that "有冰雾粉的吗" reaches the product, and the price
     * is read back from the row when the answer is composed.
     */
    product_sku: Object.freeze([{ field: 'variant', chunkType: 'spec', mode: 'structured' }]),
  } satisfies Record<IndexedSourceKind, ReadonlyArray<ChunkableField>>);

/** One slice, ready to be written as a `knowledge_chunks` row. */
export type KnowledgeChunkDraft = {
  readonly sourceKind: IndexedSourceKind;
  readonly sourceId: string;
  /** The source column this slice came from (`source_field`). */
  readonly sourceField: string;
  readonly chunkType: ChunkType;
  /** Position of this slice within its field, from zero. */
  readonly chunkIndex: number;
  readonly content: string;
  /** The tail of the previous slice, or `null` when this is the first. */
  readonly contextBefore: string | null;
  /** The head of the next slice, or `null` when this is the last. */
  readonly contextAfter: string | null;
  /** Length of `content` in Unicode code points. */
  readonly charCount: number;
};

/** Input for {@link chunkSource}. */
export type ChunkSourceInput = {
  readonly sourceKind: IndexedSourceKind;
  readonly sourceId: string;
  /** Field values by column name. An absent or blank field yields no slices. */
  readonly values: Readonly<Record<string, string | null | undefined>>;
};

/**
 * Slice every mapped field of one source row.
 *
 * @param input - The source kind, its id, and its field values.
 * @returns Slices in field order, each carrying `source_field` and `chunkIndex`.
 */
export function chunkSource(input: ChunkSourceInput): ReadonlyArray<KnowledgeChunkDraft> {
  const drafts: KnowledgeChunkDraft[] = [];
  for (const field of KNOWLEDGE_FIELDS[input.sourceKind]) {
    const value = input.values[field.field];
    if (value === null || value === undefined) {
      continue;
    }
    drafts.push(...chunkField(input.sourceKind, input.sourceId, field, value));
  }
  return drafts;
}

/**
 * Slice one field value.
 *
 * @param sourceKind - The source the value belongs to.
 * @param sourceId - The source row id.
 * @param field - The field descriptor, which fixes the mode and `chunkType`.
 * @param value - The raw field text.
 * @returns Slices with context attached, or none when the value is blank.
 */
export function chunkField(
  sourceKind: IndexedSourceKind,
  sourceId: string,
  field: ChunkableField,
  value: string,
): ReadonlyArray<KnowledgeChunkDraft> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const contents = field.mode === 'prose' ? chunkProse(trimmed) : chunkStructured(trimmed);
  return withContext(sourceKind, sourceId, field.chunkType, field.field, contents);
}

/**
 * Pack prose into slices of at most {@link KNOWLEDGE_CHUNK_MAX_CHARS}.
 *
 * Sentences are accumulated until adding the next would cross the ceiling, at
 * which point the accumulated text is emitted and a new slice starts. A single
 * sentence longer than the ceiling is cut at the ceiling — there is no boundary
 * to prefer, and the ceiling is the one hard rule here.
 *
 * **A slice shorter than {@link KNOWLEDGE_CHUNK_TARGET_CHARS} is allowed.** When
 * the text before a break is short and the next sentence does not fit — a
 * 100-character paragraph followed by a 450-character one — the only ways to
 * reach the target are to exceed the ceiling or to cut the long sentence early.
 * Both are worse than a short slice, so the floor stays a preference. A slice is
 * therefore in `1..MAX`, not in `TARGET..MAX`, and callers must not assume the
 * floor. (A whole field that is shorter than the target is one slice, which is
 * the same case seen from the other end: the kernel never invents text to pad.)
 *
 * @param text - Non-empty, already trimmed.
 * @returns Slice contents in order, without context.
 */
export function chunkProse(text: string): ReadonlyArray<string> {
  const codePoints = Array.from(text);
  if (codePoints.length <= KNOWLEDGE_CHUNK_MAX_CHARS) {
    return [text];
  }

  const slices: string[] = [];
  let current = '';
  let currentLength = 0;

  const flush = (): void => {
    if (currentLength > 0) {
      slices.push(current);
      current = '';
      currentLength = 0;
    }
  };

  for (const sentence of splitSentences(text)) {
    const length = countChars(sentence);
    if (length > KNOWLEDGE_CHUNK_MAX_CHARS) {
      // No boundary to prefer inside it, so the ceiling wins.
      flush();
      for (const piece of hardSplit(sentence, KNOWLEDGE_CHUNK_MAX_CHARS)) {
        slices.push(piece);
      }
      continue;
    }
    if (currentLength > 0 && currentLength + length > KNOWLEDGE_CHUNK_MAX_CHARS) {
      flush();
    }
    current += sentence;
    currentLength += length;
  }
  flush();
  return slices;
}

/**
 * Cut a structured field into one slice per line.
 *
 * **The separator is a newline and nothing else.** `;` `；` and `|` read like
 * item separators and were the first choice, but each of them is just as
 * commonly used *inside* a value: `颜色：黑|白`, `尺码：S/M/L；XL 缺货`. Splitting
 * there yields `颜色：黑` and `白` as separate slices, which separates a spec name
 * from its value — precisely the "结构化规格…被错误拆散" the card forbids, and
 * worse than not splitting at all because both halves still look well-formed.
 * A newline is the one separator that does not appear inside a spec value.
 *
 * The cost, accepted deliberately: a field whose items are all on one line
 * becomes a single slice however long it is. That is the safe direction — an
 * over-long slice still retrieves correctly, whereas a wrongly split one
 * retrieves the wrong thing.
 *
 * Items are neither split further nor packed together. An item over the ceiling
 * stays whole, and two items are never merged: merging would tie the slice to
 * both, so editing one attribute would invalidate a slice holding the other.
 *
 * @param text - Non-empty, already trimmed.
 * @returns One entry per non-blank line, in order.
 */
export function chunkStructured(text: string): ReadonlyArray<string> {
  return text
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Break text into sentences, keeping each terminator with the sentence it ends.
 *
 * A terminator is CJK or ASCII sentence punctuation. Whitespace-only pieces are
 * dropped; if the text contains no terminator at all the whole string is one
 * sentence, which is what makes {@link chunkProse} hard-split it.
 */
function splitSentences(text: string): ReadonlyArray<string> {
  const pieces = text.split(/(?<=[。！？；!?;])/u);
  const sentences: string[] = [];
  for (const piece of pieces) {
    if (piece.length > 0) {
      sentences.push(piece);
    }
  }
  return sentences;
}

/** Cut by code points, so a surrogate pair is never halved. */
function hardSplit(text: string, size: number): ReadonlyArray<string> {
  const codePoints = Array.from(text);
  const pieces: string[] = [];
  for (let index = 0; index < codePoints.length; index += size) {
    pieces.push(codePoints.slice(index, index + size).join(''));
  }
  return pieces;
}

/**
 * Attach each slice's neighbouring edges as its context.
 *
 * `contextBefore` is the tail of the previous slice and `contextAfter` the head
 * of the next, each capped at {@link KNOWLEDGE_CHUNK_CONTEXT_CHARS}. The edges
 * are duplicated from the neighbouring slices rather than stored once beside
 * them so that a single row is self-sufficient for embedding: a slice read on
 * its own must still carry enough of its surroundings to be understood.
 *
 * @param sourceKind - The source the slices belong to.
 * @param sourceId - The source row id.
 * @param chunkType - The `chunk_type` every slice of this field carries.
 * @param sourceField - The source column the slices came from.
 * @param contents - Slice contents in order.
 */
function withContext(
  sourceKind: IndexedSourceKind,
  sourceId: string,
  chunkType: ChunkType,
  sourceField: string,
  contents: ReadonlyArray<string>,
): ReadonlyArray<KnowledgeChunkDraft> {
  return contents.map((content, index) => {
    const previous = index > 0 ? contents[index - 1] : undefined;
    const next = index + 1 < contents.length ? contents[index + 1] : undefined;
    return Object.freeze({
      sourceKind,
      sourceId,
      sourceField,
      chunkType,
      chunkIndex: index,
      content,
      contextBefore: previous === undefined ? null : tail(previous),
      contextAfter: next === undefined ? null : head(next),
      charCount: countChars(content),
    } satisfies KnowledgeChunkDraft);
  });
}

/** The last {@link KNOWLEDGE_CHUNK_CONTEXT_CHARS} code points of a slice. */
function tail(slice: string): string {
  const codePoints = Array.from(slice);
  const start = Math.max(0, codePoints.length - KNOWLEDGE_CHUNK_CONTEXT_CHARS);
  return codePoints.slice(start).join('');
}

/** The first {@link KNOWLEDGE_CHUNK_CONTEXT_CHARS} code points of a slice. */
function head(slice: string): string {
  return Array.from(slice).slice(0, KNOWLEDGE_CHUNK_CONTEXT_CHARS).join('');
}

/** Length in Unicode code points, which is how a reader counts characters. */
export function countChars(text: string): number {
  return Array.from(text).length;
}
