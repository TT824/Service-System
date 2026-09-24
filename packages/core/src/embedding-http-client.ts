/**
 * The outbound HTTP port of the embedding provider.
 *
 * No embedding caller in this repository calls `fetch` itself. Every request to
 * a model server goes through {@link EmbeddingHttpClient}, so a unit test binds a
 * fake client and proves the whole provider — the endpoint, the request body, the
 * parsing of a vector, the classification of every way a model server can answer
 * — without a socket. The one implementation that does reach the network stays a
 * thin, reviewable wrapper around Node's global `fetch`.
 *
 * The shape is `@kefu/wecom`'s `WecomHttpClient`, deliberately: it is the
 * repository's one existing answer to "who is allowed to touch the network, and
 * how long may it take", and a second, differently-shaped answer would be a
 * second policy. What it is *not* is the same port — the two are separate seams
 * because they carry different traffic to different servers, and an embedding
 * request has no business being expressible as a WeCom one.
 *
 * Two things are narrower than the WeCom port, and both for the same reason —
 * one endpoint, one verb:
 *
 *   * **`post` rather than `send`.** The embedding service is asked one question
 *     (`POST /api/embed`); a `method` field would be a choice with one option,
 *     and a port that cannot express a `GET` cannot grow a `GET` by accident.
 *   * **No multipart.** The request body is JSON and always will be: slice text
 *     goes in a JSON document.
 *
 * Responses are returned as `{ status, body }` with the body already parsed. A
 * non-JSON body becomes `null` rather than throwing, so the provider decides what
 * an unparseable answer means instead of being handed an exception it cannot
 * classify.
 *
 * **A failure to complete the request at all throws** — DNS, a refused
 * connection, or the deadline below firing. That is the same line the WeCom port
 * draws, and it is the right one here too: "the server said no" and "the server
 * was not there" are different facts, and only the second is a throw. The
 * provider converts it into a reported failure, so nothing above this port has to
 * catch anything.
 */

/** One embedding request. */
export type EmbeddingHttpRequest = {
  readonly url: string;
  /** JSON request body. */
  readonly body: unknown;
  /**
   * Hard deadline for the whole request, so a stalled model server cannot hang a
   * caller — and, through it, one tick of the index sweep.
   */
  readonly timeoutMs: number;
};

/** One response with its JSON body already parsed. */
export type EmbeddingHttpResponse = {
  readonly status: number;
  /** Parsed JSON body, or `null` when the body was empty or not JSON. */
  readonly body: unknown;
};

/** Outbound HTTP port used by the embedding provider. */
export interface EmbeddingHttpClient {
  /**
   * Perform one request.
   *
   * @param request - URL, JSON body and deadline.
   * @returns The response status and parsed body.
   * @throws {Error} When the request cannot be completed at all (DNS, TLS, timeout).
   */
  post(request: EmbeddingHttpRequest): Promise<EmbeddingHttpResponse>;
}

/** Injection token carrying the bound {@link EmbeddingHttpClient}. */
export const EMBEDDING_HTTP_CLIENT = Symbol('EMBEDDING_HTTP_CLIENT');

/**
 * The production client: Node 20's global `fetch`.
 *
 * Every request is bounded by an `AbortController` deadline, so a model server
 * that accepts the connection and then stalls surfaces as a failure the provider
 * reports instead of a request that never returns. The timer is cleared in a
 * `finally`, so a completed request leaves nothing behind on the event loop.
 */
export class FetchEmbeddingHttpClient implements EmbeddingHttpClient {
  /** @inheritdoc */
  async post(request: EmbeddingHttpRequest): Promise<EmbeddingHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, body: parseJsonBody(text) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parse a response body, treating anything that is not JSON as absent. */
function parseJsonBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
