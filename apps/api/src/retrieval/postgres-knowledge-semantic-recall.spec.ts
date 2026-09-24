import { describe, expect, it } from 'vitest';
import {
  OllamaEmbeddingProvider,
  type EmbeddingHttpClient,
  type EmbeddingHttpRequest,
  type EmbeddingProvider,
  type EmbeddingResult,
} from '@kefu/core';
import type { DatabaseService } from '../database/database.service';
import {
  EMBEDDING_PROVIDER_THREW_CODE,
  NO_EMBEDDING_PROVIDER_CODE,
  type SemanticRecallInput,
} from './knowledge-semantic-recall';
import { PostgresKnowledgeSemanticRecall } from './postgres-knowledge-semantic-recall';

/**
 * Unit tests for the semantic recall adapter's decisions that can be settled
 * without a database and without a model server.
 *
 * The statement itself is proved against a real database and a real model server
 * in `apps/api/test/knowledge-semantic-recall.integration.spec.ts`; what is left
 * for this file is the *order of the adapter's own steps*, and two of those are
 * exactly the kinds of failure that a green integration run cannot show:
 *
 * - **The gate.** A deployment with no model configured must answer nothing,
 *   without calling the provider and without touching the pool. If that ordering
 *   were wrong the suite would still pass on a machine that has a model.
 * - **What the model is asked to embed.** The provider's contract is that it
 *   receives the slice text and nothing else — no instruction prefix, no rewritten
 *   question. A prefix added on the query side is invisible in every assertion
 *   about *which* slices come back; it only shows up as a slow drift of the ranks,
 *   which is not a failure any test can see. So the text is asserted here.
 */

/** A question, parsed and rejected values included, in the shape the port takes. */
function input(overrides: Partial<SemanticRecallInput> = {}): SemanticRecallInput {
  return {
    tenantId: 'tenant-unit',
    storeId: 'store-unit',
    text: '这件羽绒服保暖吗',
    negations: [],
    ...overrides,
  };
}

/** An embedding provider that records every text it was asked to embed. */
function providerRecording(
  seen: string[],
  result: EmbeddingResult = { ok: true, vector: [0.5, -0.5] },
): EmbeddingProvider {
  return {
    model: 'test-model',
    embed: (content: string): Promise<EmbeddingResult> => {
      seen.push(content);
      return Promise.resolve(result);
    },
  };
}

/** An embedding provider that violates the port: it throws instead of reporting. */
function providerThrowing(error: unknown): EmbeddingProvider {
  return {
    model: 'test-model',
    embed: (): Promise<EmbeddingResult> => Promise.reject(error),
  };
}

/** A database that fails the test if the adapter reaches for it. */
const untouchedDatabase = {
  pool: {
    query: (): never => {
      throw new Error('the pool must not be touched');
    },
  },
} as unknown as DatabaseService;

describe('PostgresKnowledgeSemanticRecall', () => {
  it('answers nothing, and does not ask the model, when no provider is configured', async () => {
    const seen: string[] = [];
    const recall = new PostgresKnowledgeSemanticRecall(untouchedDatabase, undefined);

    const result = await recall.recall(input());

    expect(result.hits).toEqual([]);
    expect(result.unavailable?.code).toBe(NO_EMBEDDING_PROVIDER_CODE);
    // Reported rather than thrown: this is a deployment state, not a fault.
    expect(result.unavailable?.reason).toContain('no embedding model is configured');
    expect(seen).toEqual([]);
  });

  it("reports the provider's own failure instead of answering with nothing", async () => {
    const recall = new PostgresKnowledgeSemanticRecall(
      untouchedDatabase,
      providerRecording([], {
        ok: false,
        code: 'embedding_service_unreachable',
        reason: 'the embedding service could not be reached: TypeError',
      }),
    );

    const result = await recall.recall(input());

    expect(result.hits).toEqual([]);
    expect(result.unavailable).toEqual({
      code: 'embedding_service_unreachable',
      reason: 'the embedding service could not be reached: TypeError',
    });
  });

  it('reports a provider that threw, rather than answering as if nothing were closer', async () => {
    // The port says a failure is a value; this provider is one that breaks it. The
    // adapter has to report it, because an empty list is indistinguishable from a
    // tenant whose knowledge base simply has nothing to say — which is the way a
    // broken provider stays invisible.
    const recall = new PostgresKnowledgeSemanticRecall(
      untouchedDatabase,
      providerThrowing(new RangeError('expected 1024 numbers, got 5')),
    );

    const result = await recall.recall(input());

    expect(result.hits).toEqual([]);
    expect(result.unavailable?.code).toBe(EMBEDDING_PROVIDER_THREW_CODE);
    // The shape of the failure, and not its payload: the message of a thrown error
    // may carry a response body, and these reasons travel to the caller.
    expect(result.unavailable?.reason).toContain('RangeError');
    expect(result.unavailable?.reason).not.toContain('1024');
  });

  it('embeds the question verbatim, and searches with the model it was given', async () => {
    const seen: string[] = [];
    const calls: { params: ReadonlyArray<unknown> }[] = [];
    const database = {
      pool: {
        query: (_sql: string, params: ReadonlyArray<unknown>) => {
          calls.push({ params });
          return Promise.resolve({ rows: [] });
        },
      },
    } as unknown as DatabaseService;
    const recall = new PostgresKnowledgeSemanticRecall(database, providerRecording(seen));

    const result = await recall.recall(input({ negations: ['黑色'] }));

    // The text, unchanged: no prefix, no keyword rewrite.
    expect(seen).toEqual(['这件羽绒服保暖吗']);
    expect(result.unavailable).toBeNull();
    // The parameters, in the order the statement binds them: scope, then the
    // model that addresses the rows, then the vector, the bound and the rejected
    // values (lower-cased, as the keyword leg lower-cases them).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual([
      'tenant-unit',
      'store-unit',
      'test-model',
      '[0.5,-0.5]',
      20,
      ['黑色'],
    ]);
  });

  it("redacts the customer's own text before the model server is asked to embed it (§4.5)", async () => {
    // The claim is about the *request body*, not about a redaction function of
    // this repository's own: a unit test of `maskPii` would stay green on the day
    // the call site stopped calling it, which is the only failure this test is
    // here to catch. So the provider below is the real one and the client under
    // it is the port — what a real deployment puts on a socket is exactly what is
    // asserted. `ollama-embedding-provider.spec.ts` proves the request body is
    // what the endpoint receives, text unaltered.
    const bodies: unknown[] = [];
    const http: EmbeddingHttpClient = {
      post: (request: EmbeddingHttpRequest) => {
        bodies.push(request.body);
        return Promise.resolve({ status: 200, body: { embeddings: [[0.5, -0.5]] } });
      },
    };
    const database = {
      pool: { query: () => Promise.resolve({ rows: [] }) },
    } as unknown as DatabaseService;
    const recall = new PostgresKnowledgeSemanticRecall(
      database,
      new OllamaEmbeddingProvider(http, {
        baseUrl: 'http://127.0.0.1:11434',
        model: 'test-model',
        timeoutMs: 1_000,
      }),
    );

    await recall.recall(input({ text: '我的手机号 13812345678 怎么改' }));

    expect(bodies).toEqual([{ model: 'test-model', input: '我的手机号 [手机号] 怎么改' }]);
  });

  it('asks the model nothing when there is nothing to ask about', async () => {
    const seen: string[] = [];
    const recall = new PostgresKnowledgeSemanticRecall(untouchedDatabase, providerRecording(seen));

    expect(await recall.recall(input({ limit: 0 }))).toEqual({ hits: [], unavailable: null });
    expect(await recall.recall(input({ text: '   ' }))).toEqual({ hits: [], unavailable: null });
    expect(seen).toEqual([]);
  });
});
