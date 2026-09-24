/**
 * Durable {@link KnowledgeKeywordRecall} over `0011_knowledge_index` and
 * `0014_knowledge_chunk_terms`.
 *
 * One statement answers the whole query, because the two halves, the negation
 * filter and the bound have to agree about *which* slices are in play: a limit
 * applied per half, or a rejection applied to one half only, would answer a
 * question nobody asked. It is a CTE chain that reads in the order the module
 * note describes — `scoped` (the slices this store may see) → `asked` (the
 * question's terms, tokenized) → `hit` (the slice terms they name) → `bm25` (the
 * evidence, scored) → `candidates` (evidence *or* a satisfied constraint) →
 * `live` (minus what the buyer rejected) → the slices themselves.
 *
 * Six decisions in the SQL are worth reading before changing it:
 *
 * **The scope is one predicate, in one place.** `scoped` is the only statement
 * that names the tenant, the store rule and `enabled`; every half then reads
 * `scoped`, and so does the final join back to the slice. A second copy of the
 * rule inside a half is exactly how a filter comes to hold on one half and not
 * the other, which is the failure mode this arrangement makes unrepresentable.
 *
 * **The tokenizer is not here, and the tokens arrive as data.** The question is
 * cut into terms by {@link parseKnowledgeQuery} and those terms into tokens by
 * `@kefu/core`'s `tokenizeKnowledgeQuery` — the same function the Worker runs
 * over a slice's text on the way in. Spelling that rule a second time in SQL is
 * the duplicate this repository spends the most effort making unrepresentable,
 * and it is the one that would drift first, because nothing would run both and
 * compare them. So the statement receives a *JSON list of terms and their
 * tokens* and only ever compares tokens for equality.
 *
 * **`df` is counted over the slices in scope, not over the hits.** This is the
 * inverse document frequency, and its denominator is what makes a common word
 * cheap: `颜色` is in 13,491 of this catalogue's 18,147 slices and must count for
 * nearly nothing, while `雾粉` is in a handful and must count for a lot. Counting
 * it over `hit` instead would measure the query against itself.
 *
 * **The document length is the slice's character count.** BM25 wants the
 * relative length of the document, and for one language a character count is a
 * fixed multiple of a token count — the exact multiple is not the same for every
 * slice (`XL` is one token and two characters; `黑色` is one token and two
 * characters; `170/100` is two tokens and seven) but the ordering by length is
 * the same, and how hard the divisor presses is `KNOWLEDGE_BM25_B`, which this
 * module measured down to `0` — the constant's own note says why the length
 * signal was demoted rather than trusted. Counting tokens instead would mean a second
 * pass over a table whose whole purpose is to avoid the first one.
 *
 * **The exact half is a candidate source, not a scorer.** A slice that satisfies
 * the buyer's stated attribute is recalled *whether or not* BM25 scored it —
 * the keyword table names dimensions the text does not, so 「颜色分类：黑」 can be
 * the keyword 「黑色」 while the slice's own text never says it. That is why
 * `candidates` is a union and the two scores are merged with `LEFT JOIN`s
 * instead of the exact half being a term in the sum.
 *
 * **The exact leg matches `(kind, text)`, case-folded, as a set.** The kind is
 * part of the key because the kernel sorted the question by dimension: a chunk
 * whose `型号` is `XL` is not a chunk whose `尺码` is `XL`, and treating the two
 * as the same recalls a product the buyer did not ask for. Case folding is the
 * one place this half is looser than equality and it is deliberate — buyers type
 * `xl`, merchants write `XL`, and they are the same size. The price is recorded
 * rather than hidden: `lower(keyword_text)` cannot use
 * `knowledge_chunk_keywords_lookup_idx`, so this half reads the tenant's keyword
 * rows. At MVP scale that is a few hundred rows, and this block's record
 * accounts for it instead of implying an index scan that does not happen.
 */

import type { QueryResultRow } from 'pg';
import { tokenizeKnowledgeQuery } from '@kefu/core';
import type { KeywordKind, ParsedKnowledgeQuery, RecalledChunk } from '@kefu/core';
import { DatabaseService } from '../database/database.service';
import { toNumber, toText, toTextOrNull } from '../persistence/row-values';
import {
  KNOWLEDGE_BM25_ATTRIBUTE_BOOST,
  KNOWLEDGE_BM25_B,
  KNOWLEDGE_BM25_K1,
  KNOWLEDGE_KEYWORD_RECALL_TOP,
  type KeywordRecallHit,
  type KeywordRecallInput,
  type KnowledgeKeywordRecall,
  type MatchedRecallTerm,
  type RecallLeg,
} from './knowledge-keyword-recall';

/** The kinds `0011`'s `keyword_kind` CHECK admits, for narrowing a column value. */
const KEYWORD_KINDS: ReadonlySet<string> = new Set<KeywordKind>([
  'brand',
  'category',
  'model',
  'color',
  'size',
  'material',
  'effect',
  'other',
]);

/** The one statement every keyword recall runs. */
const RECALL_SQL = `
WITH scoped AS (
  SELECT * FROM knowledge_chunks c
   WHERE c.tenant_id = $1
     AND c.enabled
     AND (c.scope_type = 'tenant' OR c.store_id = $2)
),
asked AS (
  SELECT (t->>'text') AS text,
         (t->>'kind') AS kind,
         tok.token    AS token
    FROM jsonb_array_elements($3::jsonb) AS t
    CROSS JOIN LATERAL jsonb_array_elements_text(t->'tokens') AS tok(token)
),
qtok AS (
  SELECT DISTINCT token FROM asked
),
hit AS (
  SELECT k.chunk_id, k.term, k.tf
    FROM knowledge_chunk_terms k
    JOIN scoped c ON c.id = k.chunk_id
    JOIN qtok ON qtok.token = k.term
   WHERE k.tenant_id = $1
),
df AS (
  SELECT term, count(*)::numeric AS df FROM hit GROUP BY term
),
stats AS (
  SELECT (SELECT count(*) FROM scoped)::numeric AS n,
         (SELECT avg(char_length(c.content))::numeric FROM scoped c) AS avgdl
),
bm25 AS (
  SELECT h.chunk_id,
         sum(
           ln(1 + (st.n - f.df + 0.5) / (f.df + 0.5))
           * (h.tf * ($4::numeric + 1))
           / (h.tf + $4::numeric * (1 - $5::numeric + $5::numeric * char_length(c.content) / st.avgdl))
         ) AS score
    FROM hit h
    JOIN df f ON f.term = h.term
    JOIN scoped c ON c.id = h.chunk_id
   CROSS JOIN stats st
   GROUP BY h.chunk_id
),
bm25_why AS (
  SELECT chunk_id,
         jsonb_agg(
           jsonb_build_object('text', text, 'kind', kind, 'leg', 'bm25') ORDER BY text, kind
         ) AS matched
    FROM (SELECT DISTINCT h.chunk_id, a.text, a.kind FROM hit h JOIN asked a ON a.token = h.term)
      AS matched_terms(chunk_id, text, kind)
   GROUP BY chunk_id
),
exact_why AS (
  SELECT chunk_id,
         count(*) AS hits,
         jsonb_agg(
           jsonb_build_object('text', text, 'kind', kind, 'leg', 'exact') ORDER BY text, kind
         ) AS matched
    FROM (
      SELECT DISTINCT k.chunk_id, k.keyword_text AS text, k.keyword_kind AS kind
        FROM knowledge_chunk_keywords k
        JOIN scoped c ON c.id = k.chunk_id
       WHERE lower(k.keyword_kind) || ':' || lower(k.keyword_text) = ANY($6::text[])
    ) AS exact_terms(chunk_id, text, kind)
   GROUP BY chunk_id
),
candidates AS (
  SELECT chunk_id FROM bm25
  UNION
  SELECT chunk_id FROM exact_why
),
ranked AS (
  SELECT cand.chunk_id,
         coalesce(b.score, 0)
           + $7::numeric * coalesce(e.hits, 0) AS score,
         coalesce(w.matched, '[]'::jsonb) || coalesce(e.matched, '[]'::jsonb) AS matched
    FROM candidates cand
    LEFT JOIN bm25 b ON b.chunk_id = cand.chunk_id
    LEFT JOIN bm25_why w ON w.chunk_id = cand.chunk_id
    LEFT JOIN exact_why e ON e.chunk_id = cand.chunk_id
),
live AS (
  SELECT ranked.* FROM ranked
   WHERE NOT EXISTS (
     SELECT 1
       FROM knowledge_chunk_keywords rejected
      WHERE rejected.tenant_id = $1
        AND rejected.chunk_id = ranked.chunk_id
        AND lower(rejected.keyword_text) = ANY($8::text[])
   )
)
SELECT c.id,
       c.tenant_id,
       c.store_id,
       c.scope_type,
       c.source_kind,
       c.source_id,
       c.source_field,
       c.chunk_type,
       c.chunk_index,
       c.content,
       l.score   AS score,
       l.matched AS matched
  FROM live l
  JOIN scoped c ON c.id = l.chunk_id
 ORDER BY l.score DESC, c.id
 LIMIT $9
`;

/** One query term as the statement receives it: its text, its dimension, its tokens. */
type AskedTerm = {
  readonly text: string;
  readonly kind: KeywordKind | null;
  readonly tokens: ReadonlyArray<string>;
};

/**
 * Keyword recall over PostgreSQL.
 *
 * Stateless and read-only: no transaction, no lock, and every statement it runs
 * is a `SELECT`. The scope rule it applies is {@link KnowledgeKeywordRecall}'s,
 * written the way the index-status read writes it, so the two reads cannot
 * disagree about which slices a store may answer from.
 */
export class PostgresKnowledgeKeywordRecall implements KnowledgeKeywordRecall {
  /**
   * @param database - The API-owned pool. Injected rather than constructed, so
   * the recall shares the connection budget and the statement timeout the rest
   * of the API runs under.
   */
  constructor(private readonly database: DatabaseService) {}

  /** @inheritdoc */
  async recall(input: KeywordRecallInput): Promise<ReadonlyArray<KeywordRecallHit>> {
    const limit = input.limit ?? KNOWLEDGE_KEYWORD_RECALL_TOP;
    if (limit <= 0) {
      return [];
    }
    const asked = askedTerms(input.query);
    const exactKeys = attributeKeys(input.query);
    if (asked.length === 0 && exactKeys.length === 0) {
      // A question that parsed to no constraint and no term has no evidence
      // behind it; running the statement would only prove that an empty `ANY`
      // matches nothing. A term that tokenized to nothing is dropped from
      // `asked` for the same reason — it is a term no slice's text can carry.
      return [];
    }

    const result = await this.database.pool.query(RECALL_SQL, [
      input.tenantId,
      input.storeId,
      JSON.stringify(asked),
      KNOWLEDGE_BM25_K1,
      KNOWLEDGE_BM25_B,
      exactKeys,
      KNOWLEDGE_BM25_ATTRIBUTE_BOOST,
      input.query.negations.map((negation) => negation.text.toLowerCase()),
      limit,
    ]);
    return result.rows.map(toHit);
  }
}

/**
 * The terms the statement scores with, each carrying its own tokens.
 *
 * Attributes go in alongside the free text, because an attribute's value is
 * *in* the slice's text as much as a free-text term is — `黑色` is scored by
 * BM25 and boosted by the exact half; `XL` is scored by BM25 and boosted too,
 * and the tokenizer keeps that `xl` apart from a slice that says `xll` for the
 * reason the module note gives.
 *
 * A term whose tokens came back empty is dropped rather than sent: 「码」 is one
 * character and carries nothing, and asking the statement to look for no tokens
 * is asking it to scan an index for nothing.
 */
function askedTerms(query: ParsedKnowledgeQuery): ReadonlyArray<AskedTerm> {
  const asked: AskedTerm[] = [];
  for (const attribute of query.attributes) {
    const tokens = tokenizeKnowledgeQuery(attribute.text);
    if (tokens.length > 0) {
      asked.push({ text: attribute.text, kind: attribute.kind, tokens });
    }
  }
  for (const keyword of query.keywords) {
    const tokens = tokenizeKnowledgeQuery(keyword);
    if (tokens.length > 0) {
      asked.push({ text: keyword, kind: null, tokens });
    }
  }
  return asked;
}

/**
 * The exact half's search keys, as the statement compares them.
 *
 * Lower-cased on both sides so the comparison is case-insensitive without
 * `citext` and without a second index, and carrying the kind because the kernel
 * sorted the question by dimension — see the module note.
 */
function attributeKeys(query: ParsedKnowledgeQuery): ReadonlyArray<string> {
  return query.attributes.map(
    (attribute) => `${attribute.kind.toLowerCase()}:${attribute.text.toLowerCase()}`,
  );
}

/** One row of {@link RECALL_SQL} as a hit. */
function toHit(row: QueryResultRow): KeywordRecallHit {
  return Object.freeze({
    chunk: toChunk(row),
    mode: 'keyword',
    score: toNumber(row['score']),
    matched: matchedTerms(row['matched']),
  } satisfies KeywordRecallHit);
}

/** The slice a hit was recalled from. */
function toChunk(row: QueryResultRow): RecalledChunk {
  return Object.freeze({
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toTextOrNull(row['store_id']),
    scopeType: toText(row['scope_type']),
    sourceKind: toText(row['source_kind']),
    sourceId: toText(row['source_id']),
    sourceField: toText(row['source_field']),
    chunkType: toText(row['chunk_type']),
    chunkIndex: toNumber(row['chunk_index']),
    content: toText(row['content']),
  } satisfies RecalledChunk);
}

/** The terms one hit matched, in the order the statement aggregated them. */
function matchedTerms(value: unknown): ReadonlyArray<MatchedRecallTerm> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const record = entry as Record<string, unknown>;
    return Object.freeze({
      text: toText(record['text']),
      kind: keywordKindOrNull(record['kind']),
      // The two halves are this statement's own literals, so the value is read as
      // the union it was written as rather than validated against it.
      leg: toText(record['leg']) as RecallLeg,
    } satisfies MatchedRecallTerm);
  });
}

/**
 * Narrow a column value to a {@link KeywordKind}.
 *
 * `null` is the free-text half's honest answer — a term the kernel did not sort
 * into a dimension has none. A value that is neither `null` nor one of the
 * CHECK's kinds cannot come from this schema, so it is refused rather than
 * reported as a dimension the recall invented.
 */
function keywordKindOrNull(value: unknown): KeywordKind | null {
  if (value === null || value === undefined) {
    return null;
  }
  const kind = toText(value);
  if (!KEYWORD_KINDS.has(kind)) {
    throw new Error(`knowledge_chunk_keywords holds an unknown keyword_kind: ${kind}`);
  }
  return kind as KeywordKind;
}
