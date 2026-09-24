/**
 * Durable {@link KnowledgeSemanticRecall} over `0011_knowledge_index` and the
 * model server `AppConfig.embedding` names.
 *
 * One question, one embedding, one statement. The order is fixed: the text is
 * embedded first, because a vector search with no vector has nothing to search
 * for, and the statement is only worth running once there is one.
 *
 * The statement is a CTE chain that reads in the order the module note of the port
 * describes — `scoped` (the slices this store may see) → `live` (minus what the
 * buyer rejected) → `candidates` (scored against this model's vectors) → the
 * ordered, bounded answer. Four rules are worth reading before changing it, and
 * each one is a way this leg can answer with the wrong slice:
 *
 * **The scope rule and the rejection filter are stated exactly as the keyword
 * leg states them.** `scoped` is the same three-condition predicate, and `live`
 * is the same `NOT EXISTS` over `knowledge_chunk_keywords`; a slice the keyword
 * leg refuses may not come back through this one. The two legs run in one request
 * against one question, and a rule that holds on one of them only is a wrong
 * answer that looks like a difference of opinion between two retrievers.
 *
 * **The join carries the model, and it carries the hash.** `e.embedding_model =
 * $3` is what makes the distances mean anything: a vector written by another model
 * lives in the same table and describes the same slice in a coordinate system this
 * query's vector does not share. `e.content_hash = c.content_hash` refuses a vector
 * whose text has been rewritten since it was computed — the slice is `pending` at
 * that moment, not wrong, and answering with the older text's vector is how a
 * recall quietly returns the wrong product. Both conditions are the port's, and
 * they are written once, here.
 *
 * **The order and the cap are stated once, in the same query level.** `<=>` is
 * pgvector's cosine distance and `1 - distance` is the number the port calls
 * `score`; the answer is `ORDER BY score DESC, id LIMIT $5`, on the one statement
 * that has a total order to sort by. An earlier draft ordered and truncated inside
 * a CTE and sorted again outside, which left two tie-breaks of which only one was
 * load-bearing — the slice id in the *inner* one was what decided which five
 * slices the cap kept. Keeping both would have meant keeping a line no test can
 * discriminate; keeping neither would let the planner decide. The cap lives here
 * because "the first twenty" is only meaningful as "the first twenty *of the total
 * order*", and a total order is only total if its tie-break is written once.
 *
 * The honest boundary of that arrangement: a **wrong** tie-break is falsifiable
 * (reversing `id` moves the cap onto the wrong five slices), a **missing** one is
 * not, because the sort's input at this scale happens to arrive in slice-id order
 * anyway. The statement therefore keeps exactly one, where removing it is the only
 * way to get a different answer.
 *
 * **A provider failure is a value, and a provider that throws is caught anyway.**
 * The port says a failure is a value, so the two ways this leg can answer nothing
 * for a reason — no model configured, a model server that did not answer — come
 * back as {@link SemanticRecallResult.unavailable} and are distinguishable from
 * "no relevant knowledge". A provider that violates that contract by throwing is
 * caught here, **around that one call only**, and reported with
 * {@link EMBEDDING_PROVIDER_THREW_CODE}: this is a read with a second leg behind
 * it, so one provider's bug should cost the semantic evidence and not the whole
 * request — and the worker's sweep, the other caller of the same port, already
 * defends itself the same way. Two boundaries keep this from becoming a way to
 * hide a broken provider: the catch is narrow (an exception from this adapter's
 * own code is not laundered into a provider failure), and the result *says* a
 * provider threw instead of answering with an empty list. Whether that report
 * reaches anyone is the caller's business — the fusion step has to surface it, or
 * the failure is silent in a different costume (registered for the next block).
 */

import type { QueryResultRow } from 'pg';
import {
  maskPii,
  type EmbeddingProvider,
  type EmbeddingResult,
  type RecalledChunk,
} from '@kefu/core';
import { DatabaseService } from '../database/database.service';
import { toNumber, toText, toTextOrNull } from '../persistence/row-values';
import {
  EMBEDDING_PROVIDER_THREW_CODE,
  KNOWLEDGE_SEMANTIC_RECALL_TOP,
  NO_EMBEDDING_PROVIDER_CODE,
  type KnowledgeSemanticRecall,
  type SemanticRecallHit,
  type SemanticRecallInput,
  type SemanticRecallResult,
} from './knowledge-semantic-recall';

/**
 * The one statement every semantic recall runs.
 *
 * `$4::vector` appears once: the distance is computed in `nearest`, and the answer
 * is that distance turned into a similarity, sorted and truncated by the fields it
 * selected. The cap and the order are therefore in the same place — see the module
 * note on why that is the point of the shape rather than a detail of it.
 */
const RECALL_SQL = `
WITH scoped AS (
  SELECT * FROM knowledge_chunks c
   WHERE c.tenant_id = $1
     AND c.enabled
     AND (c.scope_type = 'tenant' OR c.store_id = $2)
),
live AS (
  SELECT c.* FROM scoped c
   WHERE NOT EXISTS (
     SELECT 1
       FROM knowledge_chunk_keywords rejected
      WHERE rejected.tenant_id = $1
        AND rejected.chunk_id = c.id
        AND lower(rejected.keyword_text) = ANY($6::text[])
   )
),
nearest AS (
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
         1 - (e.embedding <=> $4::vector) AS score
    FROM live c
    JOIN knowledge_chunk_embeddings e
      ON e.tenant_id = c.tenant_id
     AND e.chunk_id = c.id
     AND e.embedding_model = $3
     AND e.content_hash = c.content_hash
)
SELECT id,
       tenant_id,
       store_id,
       scope_type,
       source_kind,
       source_id,
       source_field,
       chunk_type,
       chunk_index,
       content,
       score
  FROM nearest
 ORDER BY score DESC, id
 LIMIT $5
`;

/**
 * Semantic recall over PostgreSQL and a model server.
 *
 * Stateless and read-only on the database: no transaction, no lock, and every
 * statement it runs is a `SELECT`. It does hold the one dependency the keyword leg
 * does not have — an embedding provider — and it holds it possibly-absent, because
 * "this deployment has configured no model" is a state the API has to serve rather
 * than crash on (see the provider port and `AppConfig.embedding`).
 */
export class PostgresKnowledgeSemanticRecall implements KnowledgeSemanticRecall {
  /**
   * @param database - The API-owned pool. Injected rather than constructed, so
   * the recall shares the connection budget and the statement timeout the rest
   * of the API runs under.
   * @param provider - The embedding provider, or `undefined` when the
   * configuration names no model. `undefined` is a value rather than a stub that
   * fails every call; see the port.
   */
  constructor(
    private readonly database: DatabaseService,
    private readonly provider: EmbeddingProvider | undefined,
  ) {}

  /** @inheritdoc */
  async recall(input: SemanticRecallInput): Promise<SemanticRecallResult> {
    const limit = input.limit ?? KNOWLEDGE_SEMANTIC_RECALL_TOP;
    if (limit <= 0 || input.text.trim() === '') {
      // Nothing to answer with, and nothing wrong: a caller that asked for no
      // rows gets none, and a question with no text has no vector to be close to
      // anything. Neither is a reason to spend a request on the model server.
      return { hits: [], unavailable: null };
    }

    const provider = this.provider;
    if (provider === undefined) {
      // The gate: a deployment with no model configured answers no slices rather
      // than failing — the same posture the index sweep takes, expressed as a
      // reported reason instead of a silent empty list.
      return {
        hits: [],
        unavailable: {
          code: NO_EMBEDDING_PROVIDER_CODE,
          reason: 'no embedding model is configured, so this question cannot be embedded',
        },
      };
    }

    let embedded: EmbeddingResult;
    try {
      // §4.5's rule is about text on its way to a model, and the embedding server
      // is a model: the question is the customer's, so it is masked here before a
      // vector is ever computed from it. The *corpus* leg is deliberately not
      // masked — `apps/worker/src/knowledge/chunk-index-processor.ts` embeds text
      // a merchant wrote, and masking it would invalidate every vector already
      // stored, since those were computed from the unmasked text.
      //
      // That asymmetry is why this is written at the query rather than inside
      // `OllamaEmbeddingProvider.embed`: the provider is shared by both legs, so
      // a rule put there would silently redact the corpus too — a migration
      // dressed as a safety default. Which text is masked is a property of who
      // wrote it, and only this call site knows that it is a customer.
      //
      // The cost, accepted knowingly: a query that is nothing but a reference —
      // `A1B2C3D4 到哪了` — becomes `[订单号] 到哪了`, and a query made only of
      // digits loses the only thing that told it apart from any other number.
      // Queries with words in them keep their words. Block 5's evaluation set is
      // where that loss gets measured rather than argued about.
      embedded = await provider.embed(maskPii(input.text).text);
    } catch (error: unknown) {
      // Narrow on purpose: the try block holds this one call and nothing else, so
      // an exception from the statement below is still a bug that fails the
      // request rather than a provider failure dressed as one.
      return {
        hits: [],
        unavailable: {
          code: EMBEDDING_PROVIDER_THREW_CODE,
          reason: `the embedding provider threw ${errorName(error)} instead of reporting a failure`,
        },
      };
    }

    if (!embedded.ok) {
      return { hits: [], unavailable: { code: embedded.code, reason: embedded.reason } };
    }

    const result = await this.database.pool.query(RECALL_SQL, [
      input.tenantId,
      input.storeId,
      provider.model,
      vectorLiteral(embedded.vector),
      limit,
      input.negations.map((negation) => negation.toLowerCase()),
    ]);
    return { hits: result.rows.map(toHit), unavailable: null };
  }
}

/**
 * One vector as pgvector's text form.
 *
 * `pg` has no codec for a dimension-less `vector` column and the statement casts
 * the parameter, so the value travels as text — the same form the index writer
 * stores a vector in, and for the same reason.
 *
 * @param vector - The numbers the provider returned.
 * @returns The vector as `[a,b,c]`.
 */
export function vectorLiteral(vector: ReadonlyArray<number>): string {
  return `[${vector.join(',')}]`;
}

/**
 * The name of a thrown value, without its message.
 *
 * A reason string travels to the caller and is written for an operator, so it
 * carries the *shape* of the failure and never its payload — the rule the provider
 * port states for its own reasons. Here the payload is `Error.message`, which for
 * a `fetch` failure is the URL and for a model server's error is its body.
 *
 * Stated locally rather than imported: the provider module's copy is private to it,
 * and three lines of `instanceof` are not worth a shared export that would put a
 * helper in the kernel for one caller in the apps.
 *
 * @param error - Whatever was thrown.
 * @returns The error's name, or the type of a non-`Error` throw.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** One row of {@link RECALL_SQL} as a hit. */
function toHit(row: QueryResultRow): SemanticRecallHit {
  return Object.freeze({
    chunk: toChunk(row),
    mode: 'semantic',
    score: toNumber(row['score']),
  } satisfies SemanticRecallHit);
}

/**
 * The slice a hit was recalled from.
 *
 * The ten columns {@link RECALL_SQL} selects, mapped field for field. It is stated
 * here as well as in the keyword adapter rather than shared between them: the
 * mapping is only correct against the column list of the statement that produced
 * the row, so the two are one decision each — a shared mapper would add a third
 * place to look without removing the coupling.
 */
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
