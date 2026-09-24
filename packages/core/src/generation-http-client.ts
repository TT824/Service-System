/**
 * The outbound HTTP port of the generation provider.
 *
 * The shape is deliberately the embedding port's — `post`, JSON in, `{ status,
 * body }` out, a deadline on every request — and it is a **separate port rather
 * than that one reused**, for the reason the embedding port gives for not
 * reusing WeCom's: the two carry different traffic to different servers, and a
 * generation request has no business being expressible as an embedding one.
 * There is a second, harder reason here — **this port carries headers and the
 * embedding one does not.** A vector is asked for from a model server on a
 * private network; a draft is asked for from somebody's API with a bearer token
 * on it, so `authorization` has to be expressible. Widening the embedding port
 * to carry it would have put an auth header within reach of the index sweep,
 * which has none to send.
 *
 * Two things the embedding port already settled and this one inherits:
 *
 *   * **The body is returned parsed, and a non-JSON body is `null`** rather than
 *     a throw, so the provider decides what an unparseable answer means instead
 *     of being handed an exception it cannot classify.
 *   * **A request that cannot be completed at all throws** — DNS, a refused
 *     connection, or the deadline firing. "The server said no" and "the server
 *     was not there" are different facts, and only the second is a throw.
 */

/** One generation request. */
export type GenerationHttpRequest = {
  readonly url: string;
  /** JSON request body. */
  readonly body: unknown;
  /**
   * Headers to send, `authorization` among them.
   *
   * Built by the provider, never by the caller above it: the key belongs to the
   * provider's own configuration, and a header map handed down from a service
   * would be a place for it to travel further than it should.
   */
  readonly headers: Readonly<Record<string, string>>;
  /** Hard deadline for the whole request. */
  readonly timeoutMs: number;
};

/** One response with its JSON body already parsed. */
export type GenerationHttpResponse = {
  readonly status: number;
  /** Parsed JSON body, or `null` when the body was empty or not JSON. */
  readonly body: unknown;
};

/** Outbound HTTP port used by the generation provider. */
export interface GenerationHttpClient {
  /**
   * Perform one request.
   *
   * @param request - URL, JSON body, headers and deadline.
   * @returns The response status and parsed body.
   * @throws {Error} When the request cannot be completed at all (DNS, TLS, timeout).
   */
  post(request: GenerationHttpRequest): Promise<GenerationHttpResponse>;
}

/** Injection token carrying the bound {@link GenerationHttpClient}. */
export const GENERATION_HTTP_CLIENT = Symbol('GENERATION_HTTP_CLIENT');

/**
 * The production client: Node 20's global `fetch`.
 *
 * Every request is bounded by an `AbortController` deadline, so an API that
 * accepts the connection and then stalls surfaces as a failure the provider
 * reports instead of a request that never returns — which for this caller means
 * an agent's "generate" button that never comes back. The timer is cleared in a
 * `finally`, so a completed request leaves nothing behind on the event loop.
 */
export class FetchGenerationHttpClient implements GenerationHttpClient {
  /** @inheritdoc */
  async post(request: GenerationHttpRequest): Promise<GenerationHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...request.headers },
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
