/**
 * The indexer kernel: one source row in, its slice rows and keyword rows out.
 *
 * This module is the only place where a slice becomes a *row*. The two kernels
 * below it answer "what is a slice?" (`knowledge-chunker`) and "what is an
 * attribute?" (`knowledge-keywords`); this one answers the third question —
 * "what makes two rows the same row?" — and that question is the whole reason it
 * exists rather than the job calling the two kernels directly.
 *
 * Three decisions, each of which is invisible until the second indexing run:
 *
 *   * **The id is derived, never random.** `knowledge_chunks_slice_unique` is
 *     `(tenant_id, source_kind, source_id, source_field, chunk_index)`, and the
 *     write path is `ON CONFLICT (…) DO UPDATE` — so a reindex of an unchanged
 *     FAQ updates its rows in place. An id from `randomUUID()` conflicts with
 *     nothing, inserts a second copy of every slice, and each new copy's arrival
 *     re-parents the keywords through `ON DELETE CASCADE`. Nothing errors. The
 *     table just grows by one FAQ per index, and the stale keywords are gone.
 *     [`deriveChunkId`] addresses exactly those five columns, so "the same
 *     slice" is a function of the source text's position, not of when it ran.
 *   * **`contentHash` covers `content` and nothing else.** Migration `0011`
 *     states the use: the hash tells an embedding whether the text under it
 *     moved. An embedding reads `content`; folding `contextBefore` /
 *     `contextAfter` in would report "this slice changed" whenever a *neighbour*
 *     changed, which is the one thing the hash is there to distinguish.
 *   * **`scopeType` is derived from `storeId`, not taken as a second argument.**
 *     `0011`'s `knowledge_chunks_scope_check` forbids a tenant-level chunk with a
 *     store and a store-level chunk without one. Deriving it makes that state
 *     unrepresentable at the type level instead of a constraint violation at
 *     insert time — the same discipline as `shortcuts_scope_check` in `0010`.
 *
 * `enabled` is **passed through, not computed**. The rule "is this source usable"
 * lives once, in {@link usableKnowledge}, and `0011` records why the job must call
 * it and write the answer down rather than have the kernel ask again: a second
 * copy of the rule would be a second answer. This module therefore does not
 * import it. `indexStatus` is the literal `'pending'`, which is `0011`'s DEFAULT
 * and the state every freshly derived row is genuinely in.
 *
 * No clock, no randomness, no I/O: the same input yields the same rows byte for
 * byte, which is what makes the determinism suite meaningful and what the unique
 * key above is assuming.
 */

import { createHash } from 'node:crypto';
import { chunkSource, type IndexedSourceKind, type KnowledgeChunkDraft } from './knowledge-chunker';
import {
  extractKeywords,
  type KeywordKind,
  type KeywordVocabularyEntry,
} from './knowledge-keywords';

/**
 * What the job hands the kernel for one source row.
 *
 * `storeId: null` means tenant scope, and that is the only way to say it — see
 * the module note on `scopeType`. `enabled` is the caller's conclusion from
 * {@link usableKnowledge}, not a field this kernel reads off the row.
 */
export type IndexSourceInput = {
  readonly tenantId: string;
  /** The owning store, or `null` for a tenant-level source. */
  readonly storeId: string | null;
  readonly sourceKind: IndexedSourceKind;
  readonly sourceId: string;
  /** Whether the source may be used to answer customers, per `usableKnowledge`. */
  readonly enabled: boolean;
  /** Field values by column name; see `KNOWLEDGE_FIELDS` for which are read. */
  readonly values: Readonly<Record<string, string | null | undefined>>;
  /** Values known to be attributes. Omitted means no vocabulary pass. */
  readonly vocabulary?: ReadonlyArray<KeywordVocabularyEntry> | undefined;
};

/** One `knowledge_chunks` row, derived and ready to be written. */
export type KnowledgeChunkRow = KnowledgeChunkDraft & {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly scopeType: 'tenant' | 'store';
  readonly enabled: boolean;
  /** SHA-256 of `content` alone, as 64 hex characters. */
  readonly contentHash: string;
  readonly indexStatus: 'pending';
};

/** One `knowledge_chunk_keywords` row, derived and ready to be written. */
export type KnowledgeKeywordRow = {
  readonly id: string;
  readonly tenantId: string;
  readonly chunkId: string;
  readonly keywordKind: KeywordKind;
  readonly keywordText: string;
};

/** What {@link buildKnowledgeIndex} returns: the rows of one source row. */
export type KnowledgeIndexRows = {
  readonly chunks: ReadonlyArray<KnowledgeChunkRow>;
  readonly keywords: ReadonlyArray<KnowledgeKeywordRow>;
};

/**
 * The address of one slice, joined into the string the id hashes.
 *
 * `|` is safe as the separator even though `keywordText` may contain one: every
 * component before the last is drawn from a closed vocabulary (a tenant id, a
 * source kind, a `KNOWLEDGE_FIELDS` column name) or is itself a generated id, and
 * none of those contains `|`. So the join cannot be re-read two ways.
 */
function hashAddress(parts: ReadonlyArray<string | number>): string {
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

/**
 * The primary key of one slice.
 *
 * Derived from exactly the five columns of `knowledge_chunks_slice_unique` in
 * `0011`, so the id and the conflict target agree by construction: the same
 * source text at the same position always hashes to the same id, and the write
 * path's `ON CONFLICT` finds the row it is meant to update.
 *
 * @param input - The source identity, field and slice position.
 * @returns A 32-hex-character id — 128 bits, well inside the collision odds the
 *   64-character digest would buy and short enough to read in a log line.
 */
export function deriveChunkId(
  input: Pick<IndexSourceInput, 'tenantId' | 'sourceKind' | 'sourceId'> & {
    readonly sourceField: string;
    readonly chunkIndex: number;
  },
): string {
  return `kchunk-${hashAddress([
    input.tenantId,
    input.sourceKind,
    input.sourceId,
    input.sourceField,
    input.chunkIndex,
  ]).slice(0, 32)}`;
}

/**
 * The primary key of one keyword.
 *
 * Derived from the four columns of `knowledge_chunk_keywords_unique` in `0011`.
 * The text is last and may contain anything, which is why the separator note in
 * {@link hashAddress} holds.
 *
 * @param tenantId - The owning tenant.
 * @param chunkId - The slice this keyword was extracted from.
 * @param kind - The classified dimension.
 * @param text - The value, as written after normalisation.
 * @returns A 32-hex-character id.
 */
export function deriveKeywordId(
  tenantId: string,
  chunkId: string,
  kind: KeywordKind,
  text: string,
): string {
  return `kkw-${hashAddress([tenantId, chunkId, kind, text]).slice(0, 32)}`;
}

/**
 * The primary key of one embedding row.
 *
 * Derived from the three columns of `knowledge_chunk_embeddings_unique` in
 * `0011` — `(tenant_id, chunk_id, embedding_model)` — for the same reason as the
 * two ids above: the row a re-embed replaces is addressed by its model as well as
 * by its slice, so a second model's vector lands *beside* the first one rather
 * than on top of it, which is what makes "recognise the old vectors and rebuild"
 * a question about rows instead of a question about which model wrote what.
 *
 * @param tenantId - The owning tenant.
 * @param chunkId - The slice the vector describes.
 * @param model - The embedding model that produced it.
 * @returns A 32-hex-character id.
 */
export function deriveEmbeddingId(tenantId: string, chunkId: string, model: string): string {
  return `kemb-${hashAddress([tenantId, chunkId, model]).slice(0, 32)}`;
}

/**
 * Hash the text an embedding would read.
 *
 * `content` only — see the module note. Exported so the job and any future
 * reindex sweep can ask the same question of a stored row without re-deriving it.
 *
 * @param content - The slice text.
 * @returns The SHA-256 digest as 64 hex characters.
 */
export function hashChunkContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Turn one source row into the rows that index it.
 *
 * Slices come from {@link chunkSource} in field order — which is `chunkIndex`
 * order, and therefore part of the row identity, so it is passed through rather
 * than reordered here. Keywords are then extracted **per slice**, each hanging
 * off its own slice's id: a keyword belongs to the slice whose text produced it,
 * and a single pass over the joined field would attribute every keyword to
 * whichever slice happened to be first.
 *
 * Neither `KNOWLEDGE_KEYWORD_MAX` nor the `(kind, text)` dedupe is repeated here;
 * `knowledge-keywords` already applies both, and a second copy would be a second
 * answer to "what is a keyword".
 *
 * @param input - The source identity, its scope, its field values, its state.
 * @returns The chunk rows and the keyword rows, both possibly empty.
 */
export function buildKnowledgeIndex(input: IndexSourceInput): KnowledgeIndexRows {
  const drafts = chunkSource({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    values: input.values,
  });

  const scopeType = input.storeId === null ? 'tenant' : 'store';
  const chunks: KnowledgeChunkRow[] = [];
  const keywords: KnowledgeKeywordRow[] = [];

  for (const draft of drafts) {
    const id = deriveChunkId({
      tenantId: input.tenantId,
      sourceKind: draft.sourceKind,
      sourceId: draft.sourceId,
      sourceField: draft.sourceField,
      chunkIndex: draft.chunkIndex,
    });
    chunks.push(
      Object.freeze({
        ...draft,
        id,
        tenantId: input.tenantId,
        storeId: input.storeId,
        scopeType,
        enabled: input.enabled,
        contentHash: hashChunkContent(draft.content),
        indexStatus: 'pending',
      } satisfies KnowledgeChunkRow),
    );

    for (const keyword of extractKeywords({
      text: draft.content,
      vocabulary: input.vocabulary,
    })) {
      keywords.push(
        Object.freeze({
          id: deriveKeywordId(input.tenantId, id, keyword.kind, keyword.text),
          tenantId: input.tenantId,
          chunkId: id,
          keywordKind: keyword.kind,
          keywordText: keyword.text,
        } satisfies KnowledgeKeywordRow),
      );
    }
  }

  return { chunks: Object.freeze(chunks), keywords: Object.freeze(keywords) };
}
