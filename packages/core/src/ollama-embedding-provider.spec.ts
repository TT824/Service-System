/**
 * The Ollama embedding provider, against a fake HTTP port.
 *
 * Every case here is a way this provider can be wrong while looking healthy, and
 * each is settled without a socket so it runs on any machine:
 *
 * - **What goes in the request.** The text and nothing else: an extra field, a
 *   prefix, or a context would change the vector while `content_hash` — which
 *   covers `content` alone — kept describing something else.
 * - **What comes out of the answer.** A vector only when the answer is one the
 *   provider may store: the model echoed back has to be the model this provider
 *   addresses its rows by, there has to be exactly one embedding, and every entry
 *   has to be a finite number. The alternative to checking is a constraint
 *   violation from inside an INSERT, with the attempt already spent.
 * - **What is reported when it goes wrong.** A failure is a value with a code and
 *   a reason, never a throw — the reason is what lands in `index_error`. It is
 *   also asserted to be free of the model server's own words, because that text
 *   can echo the request and the request is a tenant's slice text.
 */

import { describe, expect, it } from 'vitest';
import type { EmbeddingHttpClient, EmbeddingHttpRequest } from './embedding-http-client';
import { OllamaEmbeddingProvider } from './ollama-embedding-provider';

/** The model this suite configures; the tag is part of the name on purpose. */
const MODEL = 'qwen3-embedding:0.6b';

/** The slice text every case embeds. */
const TEXT = '这件羽绒服是黑色的';

describe('OllamaEmbeddingProvider', () => {
  it('asks the embedding endpoint for the slice text alone, and nothing else', async () => {
    const http = fakeHttp({ status: 200, body: answer([[0.1, 0.2]]) });
    const provider = providerOver(http);

    await provider.embed(TEXT);

    expect(http.requests).toHaveLength(1);
    const request = http.requests[0];
    expect(request?.url).toBe('http://127.0.0.1:11434/api/embed');
    expect(request?.timeoutMs).toBe(4_000);
    // Exact equality, not a subset: a `context` field added here would change the
    // vector under a hash that only covers `content`.
    expect(request?.body).toEqual({ model: MODEL, input: TEXT });
  });

  it('reports the configured model verbatim, tag included', () => {
    // The name addresses the vector rows; a provider that normalised it — by
    // dropping the tag, say — would file every vector under a name the server
    // does not use, which is the corruption the port's note calls undetectable.
    expect(providerOver(fakeHttp({ status: 200, body: answer([[0.1]]) })).model).toBe(MODEL);
  });

  it('reaches the same endpoint whether the base URL ends in a slash or not', async () => {
    const http = fakeHttp({ status: 200, body: answer([[0.1]]) });
    const provider = new OllamaEmbeddingProvider(http, {
      baseUrl: 'http://127.0.0.1:11434/',
      model: MODEL,
      timeoutMs: 4_000,
    });

    await provider.embed(TEXT);

    // `//api/embed` is a 404 that reads as "the model server is broken".
    expect(http.requests[0]?.url).toBe('http://127.0.0.1:11434/api/embed');
  });

  it('returns the vector the model server produced', async () => {
    const vector = [0.5, -1.25, 3];
    const provider = providerOver(fakeHttp({ status: 200, body: answer([vector]) }));

    expect(await provider.embed(TEXT)).toEqual({ ok: true, vector });
  });

  it('reports an unreachable model server instead of throwing', async () => {
    const http = fakeHttp({ throws: new Error('connect ECONNREFUSED 127.0.0.1:11434') });
    const provider = providerOver(http);

    const result = await provider.embed(TEXT);

    // A throw would be caught one layer up and reported as a generic provider
    // error; the precise reason is what an operator reads in `index_error`.
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('embedding_service_unreachable');
    // The name of the error, never its message: an exception can carry the URL
    // or the request body.
    expect(result.reason).toContain('Error');
    expect(result.reason).not.toContain('ECONNREFUSED');
  });

  it('names a 404 as a model the service does not have, without quoting the service', async () => {
    // The body is what a real model server sends for an unknown model — and it
    // echoes the request, which is why none of it may reach the reason.
    const http = fakeHttp({
      status: 404,
      body: { error: `model "${MODEL}" not found, request: ${TEXT}` },
    });
    const provider = providerOver(http);

    const result = await provider.embed(TEXT);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('embedding_model_not_found');
    expect(result.reason).toContain(MODEL);
    expect(result.reason).not.toContain(TEXT);
    expect(result.reason).not.toContain('not found');
  });

  it('reports any other non-200 answer with its status', async () => {
    const provider = providerOver(fakeHttp({ status: 500, body: null }));

    const result = await provider.embed(TEXT);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('embedding_service_http_error');
    expect(result.reason).toContain('500');
  });

  it('refuses an answer the model server embedded with a different model', async () => {
    // The server names the model it actually used. Storing this vector would file
    // it under this provider's name while the server used another — a row that
    // no rebuild can ever find, which is the failure the port's note calls
    // impossible to detect from anywhere else.
    const http = fakeHttp({ status: 200, body: answer([[0.1, 0.2]], 'qwen3-embedding:latest') });
    const provider = providerOver(http);

    const result = await provider.embed(TEXT);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('embedding_model_mismatch');
    expect(result.reason).toContain('qwen3-embedding:latest');
    expect(result.reason).toContain(MODEL);
  });

  it('refuses a vector of zeros, which is finite and still not a direction', async () => {
    // The one shape the finite-number check above cannot see. pgvector's cosine
    // distance against a zero vector is `NaN` (measured: `'[0,0,0]'::vector <=>
    // '[1,2,3]'::vector` is `NaN`), and `NaN` sorts *above* every real
    // similarity under `ORDER BY score DESC` — so storing one would not degrade a
    // ranking, it would put that slice first for every question ever asked.
    const provider = providerOver(fakeHttp({ status: 200, body: answer([[0, 0, 0]]) }));

    const result = await provider.embed(TEXT);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('embedding_vector_unusable');
    expect(result.reason).toContain('zeros');
  });

  it('accepts an answer that does not echo a model name at all', async () => {
    // The echo is a cross-check, not a requirement: a server that says nothing
    // about its model has told no lie about it.
    const provider = providerOver(fakeHttp({ status: 200, body: { embeddings: [[1, 2]] } }));

    expect(await provider.embed(TEXT)).toEqual({ ok: true, vector: [1, 2] });
  });

  it.each([
    ['a body that is not a JSON object', 'null'],
    ['a body with no embedding list', '{}'],
    ['a body whose embedding list is empty', '{"embeddings":[]}'],
    ['a body with more than one embedding', '{"embeddings":[[1],[2]]}'],
    ['an embedding that is not a list', '{"embeddings":[7]}'],
    ['an embedding with no dimensions', '{"embeddings":[[]]}'],
    ['an embedding holding a non-number', '{"embeddings":[["0.5"]]}'],
    ['an embedding holding a null entry', '{"embeddings":[[null]]}'],
  ])('refuses %s', async (_label: string, encoded: string) => {
    const body: unknown = encoded === 'null' ? null : JSON.parse(encoded);
    const provider = providerOver(fakeHttp({ status: 200, body }));

    const result = await provider.embed(TEXT);

    // Every one of these would otherwise reach `knowledge_chunk_embeddings` and
    // fail there: pgvector refuses a dimension-less value, `embedding_dimensions`
    // is read off the vector, and a NaN survives neither.
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(['embedding_response_unusable', 'embedding_vector_unusable']).toContain(result.code);
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

/** One provider over the given fake port, with this suite's model and deadline. */
function providerOver(http: EmbeddingHttpClient): OllamaEmbeddingProvider {
  return new OllamaEmbeddingProvider(http, {
    baseUrl: 'http://127.0.0.1:11434',
    model: MODEL,
    timeoutMs: 4_000,
  });
}

/** One model server answer, in the shape the endpoint returns. */
function answer(embeddings: ReadonlyArray<ReadonlyArray<number>>, model = MODEL): unknown {
  return { model, embeddings, total_duration: 1_000_000 };
}

/**
 * A fake port that answers every request the same way and records what it got.
 *
 * @param outcome - Either a canned response, or a thrown error.
 * @returns The port, with the requests it received.
 */
function fakeHttp(
  outcome: { readonly status: number; readonly body: unknown } | { readonly throws: Error },
): EmbeddingHttpClient & { readonly requests: EmbeddingHttpRequest[] } {
  const requests: EmbeddingHttpRequest[] = [];
  return {
    requests,
    post: (request: EmbeddingHttpRequest) => {
      requests.push(request);
      if ('throws' in outcome) {
        return Promise.reject(outcome.throws);
      }
      return Promise.resolve({ status: outcome.status, body: outcome.body });
    },
  };
}
