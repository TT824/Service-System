/**
 * The outbound HTTP port of the rerank provider.
 *
 * No rerank caller in this repository calls `fetch` itself. Every request to the
 * reranker goes through {@link RerankHttpClient}, so a unit test binds a fake
 * client and proves the whole provider — the endpoint, the request body, the
 * reading of scores, the classification of every way the service can answer —
 * without a socket. The one implementation that does reach the network stays a
 * thin, reviewable wrapper around Node's global `fetch`.
 *
 * **Why this is a second port rather than a second use of the embedding one.**
 * The two are structurally identical — one JSON `POST`, one deadline, a status
 * and a parsed body back — and that identity is exactly why the question is
 * worth answering rather than skipping. The repository already draws this line
 * once: `embedding-http-client.ts` is not `@kefu/wecom`'s `WecomHttpClient`,
 * "because they carry different traffic to different servers, and an embedding
 * request has no business being expressible as a WeCom one". A rerank request
 * carries a buyer's question *and* a batch of slice texts to the sidecar, and
 * the shape of what it may ever send is different in kind from what an embedding
 * request may send — one slice, one text. Generalising the two into a
 * `ModelHttpClient` would delete that distinction to save sixty lines, and the
 * distinction is the thing that stops a rerank-shaped body (a question and its
 * candidates, i.e. a conversation) from becoming expressible as an embedding
 * request during some later refactor. The duplication is a decision; the module
 * says so here so that a reader does not undo it as an oversight.
 *
 * The rest of the shape is the embedding port's, deliberately: `post` rather
 * than `send` (one endpoint, one verb), no multipart (the body is JSON and
 * always will be), responses as `{ status, body }` with a non-JSON body becoming
 * `null` rather than throwing, and **a failure to complete the request at all
 * throws** — DNS, a refused connection, or the deadline firing. "The service
 * said no" and "the service was not there" are different facts, and the provider
 * converts the second into a reported failure so nothing above this port has to
 * catch anything.
 */

/** One rerank request. */
export type RerankHttpRequest = {
  readonly url: string;
  /** JSON request body: the question, the candidates and the model name. */
  readonly body: unknown;
  /**
   * Hard deadline for the whole request.
   *
   * A rerank is N forward passes where an embedding is one, so this is
   * configured separately rather than borrowed — see `DEFAULT_RERANK_TIMEOUT_MS`
   * for what the number is and why.
   */
  readonly timeoutMs: number;
};

/** One response with its JSON body already parsed. */
export type RerankHttpResponse = {
  readonly status: number;
  /** Parsed JSON body, or `null` when the body was empty or not JSON. */
  readonly body: unknown;
};

/** Outbound HTTP port used by the rerank provider. */
export interface RerankHttpClient {
  /**
   * Perform one request.
   *
   * @param request - URL, JSON body and deadline.
   * @returns The response status and parsed body.
   * @throws {Error} When the request cannot be completed at all (DNS, TLS, timeout).
   */
  post(request: RerankHttpRequest): Promise<RerankHttpResponse>;
}

/** Injection token carrying the bound {@link RerankHttpClient}. */
export const RERANK_HTTP_CLIENT = Symbol('RERANK_HTTP_CLIENT');

/**
 * The production client: Node 20's global `fetch`.
 *
 * Every request is bounded by an `AbortController` deadline, so a reranker that
 * accepts the connection and then stalls on a cold model surfaces as a failure
 * the provider reports instead of a request that never returns. The timer is
 * cleared in a `finally`, so a completed request leaves nothing behind on the
 * event loop.
 */
export class FetchRerankHttpClient implements RerankHttpClient {
  /** @inheritdoc */
  async post(request: RerankHttpRequest): Promise<RerankHttpResponse> {
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
