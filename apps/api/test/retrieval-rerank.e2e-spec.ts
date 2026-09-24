import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE_FUSION_TOP, parseAppConfig } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';
import {
  KNOWLEDGE_KEYWORD_RECALL,
  type KeywordRecallHit,
} from '../src/retrieval/knowledge-keyword-recall';

const TENANT = 'tenant-acme';
const STORE = 'store-acme-flagship';
const MEMBER = 'u-t1-agent-1';
const CONVERSATION = 'conversation-acme-2';
const SUGGESTIONS_URL = '/api/v1/retrieval/suggestions';
/** A question whose answer this store can actually recall slices for. */
const QUERY = '白色 M 现货';

const MODEL = 'stub-reranker';
const FAILURE_MSG = 'the rerank leg did not run; answering with the fused order';

/** How many slices the suite's keyword leg answers with. */
const SLICE_COUNT = 8;

/**
 * The slices the keyword leg answers with, more than the answer keeps.
 *
 * More than {@link KNOWLEDGE_FUSION_TOP} on purpose: at exactly that many, fusing
 * at the candidate bound and fusing at the answer bound produce the same list,
 * and the assertion about what the reranker was shown would hold either way.
 */
const SLICES: KeywordRecallHit[] = Array.from({ length: SLICE_COUNT }, (_, offset) => ({
  chunk: {
    id: `chunk-rerank-${offset}`,
    tenantId: TENANT,
    storeId: STORE,
    scopeType: 'store',
    sourceKind: 'product',
    sourceId: `product-rerank-${offset}`,
    sourceField: 'title',
    chunkType: 'field',
    chunkIndex: 0,
    content: `第 ${offset} 条候选话术`,
  },
  mode: 'keyword',
  score: SLICE_COUNT - offset,
  matched: [],
}));

type DataEnvelope = { request_id: string; data: unknown; meta: Record<string, never> };

/** What the endpoint serializes one suggestion set as. */
type SuggestSet = {
  readonly id: string;
  readonly provider: string;
  readonly candidates: ReadonlyArray<Record<string, unknown>>;
  readonly fallbackReasons: ReadonlyArray<string>;
};

/** One request the stub rerank service received, as it arrived on the wire. */
type StubCall = {
  readonly path: string;
  readonly model: unknown;
  readonly query: unknown;
  readonly documents: ReadonlyArray<string>;
};

/**
 * The rerank leg as the running application assembles it, over the real wire.
 *
 * Two facts live here and nowhere else, because both are about *assembly*
 * rather than about a decision:
 *
 *   * A configuration with a reranker in it produces a provider that reaches the
 *     service over the real HTTP client and asks it the agent's question with the
 *     whole fused candidate list. Nothing else in this repository runs that path
 *     end to end: the provider's own suite hand-writes its HTTP client, and the
 *     service's suite hand-writes the provider, so a composition root that read
 *     the wrong config key, or a service that was never handed the token, would
 *     leave both of them green.
 *   * A rerank service that is *down* is reported at the real sink with the code
 *     the status maps to, and the request still answers.
 *
 * What the reranker's answer *changes* is deliberately not asserted here. In this
 * configuration `APP_ENV=test` serves the in-process store, so the slices the
 * recall leg answers with are refused on read-back and the answer's sources come
 * from the fixture catalogue alone — an order asserted here would be asserted
 * over exactly the entries a reranker cannot move, and would pass whether or not
 * the leg was wired. `src/retrieval/retrieval-rerank.spec.ts` owns that claim,
 * where the entries are the suite's own and the reranker's answer is the only
 * thing that can move the answer.
 */
describe('Retrieval rerank (interface)', () => {
  /** What the stub answers with. Flipped immediately before the request. */
  let mode: 'scores' | 'down' = 'scores';

  /** Every request the stub received. */
  const calls: StubCall[] = [];

  let server: Server;
  let baseUrl: string;
  let app: INestApplication;

  beforeAll(async () => {
    // A stand-in for `services/retrieval`: the real provider, client and
    // configuration, and a service that answers in the sidecar's own shape.
    server = createServer((incoming, outgoing) => {
      let body = '';
      incoming.on('data', (piece) => {
        body += String(piece);
      });
      incoming.on('end', () => {
        if (mode === 'down') {
          outgoing.writeHead(503, { 'content-type': 'application/json' });
          outgoing.end('{"code":"rerank_model_unavailable"}');
          return;
        }
        const parsed = JSON.parse(body) as {
          readonly model: unknown;
          readonly query: unknown;
          readonly documents: ReadonlyArray<string>;
        };
        calls.push({
          path: incoming.url ?? '',
          model: parsed.model,
          query: parsed.query,
          documents: parsed.documents,
        });
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.end(
          JSON.stringify({
            model: parsed.model,
            // One score per document, which is the contract: a partial answer is
            // refused rather than attached to the wrong slices. All zeros means
            // "no opinion", so the answer is the fused order and this suite's
            // assertions stay about assembly.
            results: parsed.documents.map((_, index) => ({ index, score: 0 })),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const parsed = parseAppConfig({
      APP_ENV: 'test',
      RERANK_BASE_URL: baseUrl,
      RERANK_MODEL: MODEL,
    });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    })
      // The keyword leg is the suite's own, so this file needs no catalogue and
      // no index: what it asserts is that the *configured* reranker is reached,
      // and a leg that answers the same eight slices every run makes that
      // assertion independent of what a database happens to hold. The read-back
      // that follows refuses them — `APP_ENV=test` serves the in-process store,
      // which does not hold this catalogue — and that is fine here: nothing
      // below asserts on the answer's sources.
      .overrideProvider(KNOWLEDGE_KEYWORD_RECALL)
      .useValue({
        recall: () => Promise.resolve(SLICES),
      })
      .compile();

    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  /** One suggestion set, under one behaviour of the rerank service. */
  async function suggest(next: 'scores' | 'down' = 'scores'): Promise<SuggestSet> {
    mode = next;
    const response = await request(app.getHttpServer())
      .post(SUGGESTIONS_URL)
      .set('x-member-id', MEMBER)
      .send({ conversationId: CONVERSATION, query: QUERY })
      .expect(201);
    return (response.body as DataEnvelope).data as SuggestSet;
  }

  it('reaches a reranker built from the configuration, with the whole candidate list', async () => {
    calls.length = 0;
    const set = await suggest();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/rerank');
    // The model travels with every call, so a sidecar running a different one
    // can refuse instead of answering about a model nobody configured.
    expect(calls[0]?.model).toBe(MODEL);
    expect(calls[0]?.query).toBe(QUERY);

    // The bound is the point. Five would mean the reranker only ever sees the
    // ranking it was brought in to replace; `KNOWLEDGE_FUSION_TOP` is what the
    // answer keeps, not what the reranker is shown.
    const candidates = calls[0]?.documents ?? [];
    expect(candidates).toHaveLength(SLICE_COUNT);
    expect(SLICE_COUNT).toBeGreaterThan(KNOWLEDGE_FUSION_TOP);

    // And what was sent is slice text: a cross-encoder reads the pair, so a
    // blank or shortened candidate would be scored as if that were all of it.
    expect(candidates.every((document) => document.trim().length > 0)).toBe(true);

    // The answer is still the store's own, and complete.
    expect(set.provider).toBe('none');
    expect(set.candidates.length).toBeGreaterThan(0);
  });

  it('reports a rerank service that is down, and still answers', async () => {
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    let set: SuggestSet;
    try {
      set = await suggest('down');
    } finally {
      write.mockRestore();
    }

    // A reranker that is configured and *down* has to say so at the real sink.
    // Silence here reads exactly like a reranker that ran and did not help, and
    // those are opposite facts about a deployment.
    const reported = chunks
      .map((chunk) => {
        try {
          return JSON.parse(chunk) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((record): record is Record<string, unknown> => record !== null)
      .filter((record) => record['msg'] === FAILURE_MSG);

    expect(reported).toHaveLength(1);
    // 503 and not a generic HTTP error: the two failures this pair of modules
    // can actually name apart are a sidecar that has not loaded the model and
    // one that loaded a different one.
    expect(reported[0]?.['code']).toBe('rerank_model_unavailable');
    expect(reported[0]?.['model']).toBe(MODEL);
    expect(reported[0]?.['candidates']).toBe(SLICE_COUNT);
    // The reason travels, and the question does not: an outage line must not
    // become a second place a buyer's words are stored.
    expect(reported[0]?.['reason']).toBe(`the rerank service has not loaded the model ${MODEL} yet`);
    expect(JSON.stringify(reported[0])).not.toContain(QUERY);

    // And the workbench is not left empty by a reranker that failed. The fused
    // order is a complete answer, which is why the deadline can be short.
    expect(set.candidates.length).toBeGreaterThan(0);
  });
});
