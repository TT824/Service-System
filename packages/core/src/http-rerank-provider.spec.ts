/**
 * The HTTP rerank provider, against a fake port.
 *
 * Every case here is a way this provider can be wrong while looking healthy, and
 * each is settled without a socket — and, deliberately, without the model: the
 * Python sidecar is not a dependency of this suite, so a broken *service* cannot
 * make these assertions fail and a broken *provider* cannot hide behind it.
 *
 * - **What goes in the request.** The question, the candidates and the model,
 *   and nothing else. The query is the only field that changes between two
 *   otherwise identical reads, so a body that lost it would score every question
 *   the same and still return a full, plausible ranking.
 * - **What comes out of the answer.** The service ranks; this returns scores
 *   *aligned to the documents it sent*. The first test is the one that matters
 *   most, because reading the answer as a ranking instead of as positions
 *   produces a full, correctly-shaped, completely wrong result — the highest
 *   score attached to the lowest-ranked slice.
 * - **What is refused.** An answer that drops a document, repeats one, names one
 *   that was never sent, or carries a non-finite score. All four are refused
 *   rather than realigned, because a reranker scoring the wrong slice is worse
 *   than one that did not run: the fused order it replaces was at least derived
 *   from this question.
 * - **What is reported when it goes wrong.** A failure is a value with a code
 *   and a reason, never a throw — except the port's own throw, which becomes
 *   `rerank_service_unreachable`. The reason is asserted to be free of the
 *   question and of every document, because it is written to a log an operator
 *   reads and both of those are a tenant's own content.
 */

import { describe, expect, it } from 'vitest';
import { HttpRerankProvider } from './http-rerank-provider';
import type { RerankHttpClient, RerankHttpRequest, RerankHttpResponse } from './rerank-http-client';

/** The model this suite configures. */
const MODEL = 'bge-reranker-base';

/** The question every case reranks. */
const QUERY = '有棵树内裤 黑色';

/** The candidates, in the order the caller's fusion produced them. */
const DOCUMENTS = ['有棵树内裤 颜色：灰色', '有棵树内裤 颜色：黑色', '有棵树内裤 颜色：蓝色'];

describe('HttpRerankProvider', () => {
  it('sends the question, the candidates and the model, and nothing else', async () => {
    const http = fakeHttp({ status: 200, body: answer([]) });
    const provider = providerOver(http);

    await provider.rerank(QUERY, DOCUMENTS);

    expect(http.requests).toHaveLength(1);
    const request = http.requests[0];
    expect(request?.url).toBe('http://127.0.0.1:8000/rerank');
    expect(request?.timeoutMs).toBe(9_000);
    // Exact equality, not a subset: the question is the only field that differs
    // between two reads, and a body that dropped it would score every question
    // identically while returning a full ranking.
    expect(request?.body).toEqual({ model: MODEL, query: QUERY, documents: DOCUMENTS });
  });

  it('reads the answer as positions, not as a ranking', async () => {
    const http = fakeHttp({
      status: 200,
      body: answer([
        { index: 1, score: 9.5 },
        { index: 0, score: 2.0 },
        { index: 2, score: -1.0 },
      ]),
    });

    const result = await providerOver(http).rerank(QUERY, DOCUMENTS);

    // The service answered best-first; the caller sorts. Read as a ranking, the
    // black one's 9.5 would land on the grey one — same length, same shape, and
    // the wrong slice promoted.
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.scores).toEqual([2.0, 9.5, -1.0]);
  });

  it('reports the configured model verbatim', () => {
    // A label rather than an address — nothing is stored under it — but it is
    // sent with every call, so a normalised one would ask the service to compare
    // against a name it does not have.
    expect(providerOver(fakeHttp({ status: 200, body: answer([]) })).model).toBe(MODEL);
  });

  it('reaches the same endpoint whether the base URL ends in a slash or not', async () => {
    const http = fakeHttp({ status: 200, body: answer([]) });
    const provider = new HttpRerankProvider(http, {
      baseUrl: 'http://127.0.0.1:8000/',
      model: MODEL,
      timeoutMs: 9_000,
    });

    await provider.rerank(QUERY, DOCUMENTS);

    // `//rerank` is a 404 that reads as "the sidecar is broken".
    expect(http.requests[0]?.url).toBe('http://127.0.0.1:8000/rerank');
  });

  it('asks for nothing when there is nothing to rerank', async () => {
    const http = fakeHttp({ status: 200, body: answer([]) });

    const result = await providerOver(http).rerank(QUERY, []);

    // An empty search reaches here on every question the index has no answer
    // for, and a round trip to learn that there was nothing to score would be
    // paid on the path that is already the slowest to answer.
    expect(result).toEqual({ ok: true, scores: [] });
    expect(http.requests).toHaveLength(0);
  });

  it('refuses an answer that does not cover every document', async () => {
    // Each of these is a full, correctly-shaped answer that would be attached,
    // position by position, to the wrong slices.
    const shortened = fakeHttp({
      status: 200,
      body: answer([
        { index: 0, score: 1 },
        { index: 1, score: 2 },
      ]),
    });
    const repeated = fakeHttp({
      status: 200,
      body: answer([
        { index: 0, score: 1 },
        { index: 0, score: 2 },
        { index: 1, score: 3 },
      ]),
    });
    const unsent = fakeHttp({
      status: 200,
      body: answer([
        { index: 0, score: 1 },
        { index: 1, score: 2 },
        { index: 3, score: 3 },
      ]),
    });

    for (const http of [shortened, repeated, unsent]) {
      const result = await providerOver(http).rerank(QUERY, DOCUMENTS);
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.code).toBe('rerank_response_unusable');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('refuses a score that is not a finite number', async () => {
    // `NaN` sorts inconsistently against everything, so one would make the
    // caller's ordering depend on the sort implementation rather than on the
    // model — which is the same reason `applyRerankOrder` refuses the list.
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const http = fakeHttp({
        status: 200,
        body: answer([
          { index: 0, score },
          { index: 1, score: 2 },
          { index: 2, score: 3 },
        ]),
      });

      const result = await providerOver(http).rerank(QUERY, DOCUMENTS);

      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.code).toBe('rerank_response_unusable');
    }
  });

  it('refuses an answer that names a different model', async () => {
    const http = fakeHttp({
      status: 200,
      body: answer(
        DOCUMENTS.map((_, index) => ({ index, score: 1 })),
        'bge-reranker-v2-m3',
      ),
    });

    const result = await providerOver(http).rerank(QUERY, DOCUMENTS);

    // Every score in that answer describes a model this caller did not ask for,
    // which from here is indistinguishable from a reranker that is not helping.
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('rerank_model_mismatch');
  });

  it('classifies a refusal by its status, and quotes none of the answer', async () => {
    const cases = [
      { status: 409, code: 'rerank_model_mismatch' },
      { status: 503, code: 'rerank_model_unavailable' },
      { status: 500, code: 'rerank_service_http_error' },
    ];

    for (const expected of cases) {
      // The body is what a real service would say, and none of it may appear in
      // the reason: the endpoint this provider is pointed at is a deployment's
      // choice, and a body read here is a body read from whatever answers.
      const http = fakeHttp({
        status: expected.status,
        body: { code: 'whatever', reason: `${QUERY} ${DOCUMENTS[0]}` },
      });

      const result = await providerOver(http).rerank(QUERY, DOCUMENTS);

      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.code).toBe(expected.code);
      expect(result.reason).not.toContain(QUERY);
      for (const document of DOCUMENTS) {
        expect(result.reason).not.toContain(document);
      }
    }
  });

  it('reports an unreachable service as a value rather than throwing', async () => {
    const http = fakeHttp({ throws: new TypeError('fetch failed') });

    const result = await providerOver(http).rerank(QUERY, DOCUMENTS);

    // The port throws when the request could not be completed at all; nothing
    // above this provider catches, so the classification has to happen here.
    expect(result).toEqual({
      ok: false,
      code: 'rerank_service_unreachable',
      reason: 'the rerank service could not be reached: TypeError',
    });
  });

  it('quotes none of the question or the candidates in a reported failure', async () => {
    // The reason lands in a log an operator reads, and every field of this
    // request is a tenant's own content — a buyer's question and the slices it
    // recalled. The thrown message is where a client library would put them.
    const http = fakeHttp({ throws: new Error(`${QUERY} / ${DOCUMENTS[2]}`) });

    const result = await providerOver(http).rerank(QUERY, DOCUMENTS);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).not.toContain(QUERY);
    for (const document of DOCUMENTS) {
      expect(result.reason).not.toContain(document);
    }
  });
});

/** One provider over the given fake port, with this suite's model and deadline. */
function providerOver(http: RerankHttpClient): HttpRerankProvider {
  return new HttpRerankProvider(http, {
    baseUrl: 'http://127.0.0.1:8000',
    model: MODEL,
    timeoutMs: 9_000,
  });
}

/** One sidecar answer, in the shape the endpoint returns. */
function answer(
  results: ReadonlyArray<{ readonly index: number; readonly score: number }>,
  model = MODEL,
): unknown {
  return { model, results };
}

/**
 * A fake port that answers every request the same way and records what it got.
 *
 * @param outcome - Either a canned response, or a thrown error.
 * @returns The port, with the requests it received.
 */
function fakeHttp(
  outcome: RerankHttpResponse | { readonly throws: Error },
): RerankHttpClient & { readonly requests: RerankHttpRequest[] } {
  const requests: RerankHttpRequest[] = [];
  return {
    requests,
    post: (request: RerankHttpRequest) => {
      requests.push(request);
      if ('throws' in outcome) {
        return Promise.reject(outcome.throws);
      }
      return Promise.resolve({ status: outcome.status, body: outcome.body });
    },
  };
}
