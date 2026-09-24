/**
 * A local model server as the index sweep's embedding provider.
 *
 * This is the one implementation of {@link EmbeddingProvider}: it turns a slice's
 * text into a vector by asking a model server that speaks Ollama's HTTP API. It
 * is written against the port rather than against a client library, so everything
 * that can be settled without a socket — the endpoint, the request body, and the
 * classification of every way an answer can be wrong — is settled in
 * `ollama-embedding-provider.spec.ts` against a fake {@link EmbeddingHttpClient}.
 *
 * Three rules are the port's, restated here because this is where they can be
 * broken:
 *
 * **`model` is the configured name, and the answer must agree with it.** The name
 * is part of a vector row's address, so a provider that reports one name while
 * the server embedded with another has written vectors that nothing can find
 * again. The server echoes the model it used; when that echo is present and
 * differs, this provider **refuses the result** rather than storing it — a loud
 * failure with a fixable cause ("name the model the way the server does") beats a
 * row that is silently addressed by a lie.
 *
 * **`embed` reads the text and nothing else.** No prefix, no context, no
 * instruction template: `content_hash` covers `content` alone, and a vector
 * computed from anything more than the text would be filed under a hash that does
 * not describe it — which is the only thing that can ever say the vector is
 * stale.
 *
 * **A failure is a value.** Every way this can go wrong — an unreachable server,
 * a non-200 answer, a body that carries no vector, numbers that are not finite, a
 * vector of zeros — comes back as `{ ok: false, code, reason }`, because that
 * report is what lands in `index_error` and what decides whether the slice is
 * retried. Nothing above this class has to catch anything.
 *
 * **The `reason` is written to a database column an operator reads, so it carries
 * no payload.** The model server's own error body is never quoted: it can echo
 * the request, and the request is a tenant's slice text. What is reported instead
 * is the status code, plus the one classification that is worth deriving from it
 * (404 is a model that was never pulled, which is the common real failure).
 *
 * The precondition is the composition root's: both a base URL and a model name
 * are configured. Neither is re-checked here — an instance that exists at all is
 * one the configuration named. {@link createOllamaEmbeddingProvider} is where that
 * naming happens, for both compositions that need a provider.
 */

import type { AppConfig } from './app-config';
import type { EmbeddingHttpClient } from './embedding-http-client';
import type { EmbeddingProvider, EmbeddingResult } from './embedding-provider';

/** The path Ollama's embedding endpoint lives at, appended to the configured base URL. */
const EMBEDDING_PATH = '/api/embed';

/** Where one embedding provider reads from, and what it calls itself. */
export type OllamaEmbeddingOptions = {
  /** Base URL of the model server, e.g. `http://127.0.0.1:11434`. */
  readonly baseUrl: string;
  /** Model to embed with; part of a vector row's address. */
  readonly model: string;
  /** Hard deadline for one request; see `AppConfig.embedding.timeoutMs`. */
  readonly timeoutMs: number;
};

/** An embedding provider backed by a model server that speaks Ollama's API. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  /** @inheritdoc */
  readonly model: string;

  readonly #url: string;
  readonly #timeoutMs: number;

  /**
   * @param http - The outbound HTTP port; the only thing here that touches a socket.
   * @param options - Base URL, model name and per-request deadline.
   */
  constructor(
    private readonly http: EmbeddingHttpClient,
    options: OllamaEmbeddingOptions,
  ) {
    this.model = options.model;
    // Trailing slashes are dropped rather than rejected: every way an operator
    // writes a base URL has to reach the same endpoint, and `//api/embed` is a
    // 404 that reads as "the server is broken".
    this.#url = `${options.baseUrl.replace(/\/+$/, '')}${EMBEDDING_PATH}`;
    this.#timeoutMs = options.timeoutMs;
  }

  /** @inheritdoc */
  async embed(content: string): Promise<EmbeddingResult> {
    let response;
    try {
      response = await this.http.post({
        url: this.#url,
        // One input per request: the slice's text, under the field the endpoint
        // expects. The model travels with every call because it addresses every
        // row the answer will produce.
        body: { model: this.model, input: content },
        timeoutMs: this.#timeoutMs,
      });
    } catch (error: unknown) {
      return {
        ok: false,
        code: 'embedding_service_unreachable',
        reason: `the embedding service could not be reached: ${errorName(error)}`,
      };
    }

    if (response.status !== 200) {
      return {
        ok: false,
        code:
          response.status === 404 ? 'embedding_model_not_found' : 'embedding_service_http_error',
        reason:
          response.status === 404
            ? `the embedding service does not know the model ${this.model}`
            : `the embedding service answered HTTP ${response.status} for the model ${this.model}`,
      };
    }

    return readVector(response.body, this.model);
  }
}

/**
 * The vector out of one 200 answer, or why there is none.
 *
 * Every branch below is a way a server that answered successfully still did not
 * produce something this job may store. They are checked here, before the write,
 * because the alternative is a constraint violation from inside the INSERT — with
 * the attempt already spent and a stack trace instead of a reason.
 *
 * @param body - The parsed response body.
 * @param model - The model this provider's rows are addressed by.
 * @returns The vector, or a reported failure naming what was missing.
 */
function readVector(body: unknown, model: string): EmbeddingResult {
  if (typeof body !== 'object' || body === null) {
    return {
      ok: false,
      code: 'embedding_response_unusable',
      reason: 'the embedding service answered 200 with a body that carries no JSON object',
    };
  }

  const echoed = (body as { readonly model?: unknown }).model;
  if (typeof echoed === 'string' && echoed !== model) {
    // See the module note: the name addresses the row, and this answer would be
    // filed under one the server did not use.
    return {
      ok: false,
      code: 'embedding_model_mismatch',
      reason: `the embedding service embedded with the model ${echoed} while this provider addresses its rows by ${model}`,
    };
  }

  const embeddings = (body as { readonly embeddings?: unknown }).embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== 1) {
    // Exactly one, because exactly one input was sent: a different count means
    // the answer's pairing with this text is unknown, and taking the first entry
    // would attach a vector to text it may not describe.
    return {
      ok: false,
      code: 'embedding_response_unusable',
      reason: `the embedding service answered 200 with ${countOf(embeddings)} instead of one embedding`,
    };
  }

  const vector = embeddings[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    return {
      ok: false,
      code: 'embedding_response_unusable',
      reason: 'the embedding service answered 200 with an empty embedding',
    };
  }
  if (!vector.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) {
    // `NaN` and `Infinity` are the two that matter: pgvector stores neither, and
    // a vector full of them would be indexed and never be matchable.
    return {
      ok: false,
      code: 'embedding_vector_unusable',
      reason:
        'the embedding service answered 200 with a vector that is not a list of finite numbers',
    };
  }

  if (!vector.some((value: unknown) => value !== 0)) {
    // Finite, the right width, and still not a direction — which is the one shape
    // the check above cannot see. pgvector's cosine distance against a zero vector
    // is `NaN` (measured against the development database: `'[0,0,0]'::vector <=>
    // '[1,2,3]'::vector` is `NaN`), and `NaN` sorts *above* every real similarity
    // under the `ORDER BY score DESC` both recall legs use. Storing one would not
    // degrade a ranking, it would put that slice first for every question ever
    // asked. A model server that answers this way is broken; the refusal belongs
    // here, where it still has a reason an operator can act on.
    return {
      ok: false,
      code: 'embedding_vector_unusable',
      reason: 'the embedding service answered 200 with a vector of zeros, which has no direction',
    };
  }

  return { ok: true, vector };
}

/** How many embeddings an answer carried, for a reason string. */
function countOf(embeddings: unknown): string {
  return Array.isArray(embeddings) ? `${embeddings.length} embeddings` : 'no embedding list';
}

/**
 * The name of a thrown value, for a reason string.
 *
 * Only the name: a client's exception can carry a request body or a URL, and the
 * reason is written to a column an operator reads.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The embedding provider a configuration names, or `undefined` when it names none.
 *
 * The rule is four lines, and it lives beside the only implementation because
 * "what counts as not configured" is a statement about *this* provider: a second
 * one (a hosted API behind a key, say) would say it differently, and it should say
 * it in its own module rather than in the composition roots. Both compositions
 * that need a provider — the Worker's sweep and the API's semantic recall leg —
 * call this, so `undefined` means the same thing on both sides.
 *
 * A *half*-configured pair is deliberately folded into the same answer: a base URL
 * with no model names a server but not which rows the vectors it returns belong
 * to, and answering nothing is safer than choosing a name. Production does not
 * rely on this — both variables are required there, so a deployment that would
 * silently index nothing fails to start instead.
 *
 * @param embedding - The parsed `embedding` section of the application config.
 * @param http - The outbound HTTP port the provider is built with.
 * @returns A provider, or `undefined` when the configuration names no model.
 */
export function createOllamaEmbeddingProvider(
  embedding: AppConfig['embedding'],
  http: EmbeddingHttpClient,
): EmbeddingProvider | undefined {
  if (embedding.baseUrl.trim() === '' || embedding.model.trim() === '') {
    return undefined;
  }
  return new OllamaEmbeddingProvider(http, embedding);
}
