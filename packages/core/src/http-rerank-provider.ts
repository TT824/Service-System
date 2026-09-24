/**
 * The retrieval sidecar as the read path's rerank provider.
 *
 * This is the one implementation of {@link RerankProvider}: it asks a service
 * that speaks the contract in `services/retrieval/app.py` to score each
 * (question, slice) pair, and it is written against the port rather than against
 * anything Python-shaped, so everything that can be settled without a socket —
 * the endpoint, the request body, and the classification of every way an answer
 * can be wrong — is settled in `http-rerank-provider.spec.ts` against a fake
 * {@link RerankHttpClient}.
 *
 * Three rules, and they are the embedding provider's rules restated because this
 * is the second place they can be broken:
 *
 * **The answer must describe exactly the documents that were sent.** The service
 * replies with `{index, score}` pairs rather than a list in request order, so a
 * service that dropped one, answered one twice, or answered an index that was
 * never sent has produced something that *looks* like a ranking and would be
 * attached, position by position, to the wrong slices. Every one of those is a
 * refusal here rather than a best-effort realignment — a reranker that silently
 * scores the wrong slice is worse than a reranker that did not run, because the
 * fused order it replaces was at least derived from this question.
 *
 * **The model is echoed, and a mismatch is a refusal.** Same reason as the
 * embedding provider's, one step weaker: nothing is *stored* under this name, so
 * a mismatch cannot corrupt a row — but it means every score in the answer
 * describes a model the caller did not configure, which is indistinguishable
 * from a reranker that simply is not helping. The service refuses the request
 * first (it knows what it loaded); this refuses the answer, so the rule holds
 * even against a service that does not.
 *
 * **A `reason` carries no payload, and that rule is absolute.** The reason is
 * written to a log an operator reads, and what this request carries is a buyer's
 * question and a batch of slice texts — a tenant's own content. So the service's
 * error body is never quoted, not even though *our* service's body is a fixed
 * `{code, reason}` pair that could not contain one: the rule has to hold for the
 * endpoint this provider is pointed at, not for the endpoint it was written
 * against, and a body read here is a body read from whatever answers. What is
 * reported instead is the status code, the model name, and the one
 * classification worth deriving from the status (409 is a model mismatch, 503 is
 * an unloaded model — the two failures this pair of modules can actually
 * produce).
 *
 * The precondition is the composition root's: both a base URL and a model name
 * are configured. Neither is re-checked here — an instance that exists at all is
 * one the configuration named. {@link createHttpRerankProvider} is where that
 * naming happens.
 */

import type { AppConfig } from './app-config';
import type { RerankHttpClient } from './rerank-http-client';
import type { RerankOutcome, RerankProvider } from './rerank-provider';

/** The path the sidecar's rerank endpoint lives at, appended to the configured base URL. */
const RERANK_PATH = '/rerank';

/** Where one rerank provider reads from, and what it calls itself. */
export type HttpRerankOptions = {
  /** Base URL of the sidecar, e.g. `http://127.0.0.1:8000`. */
  readonly baseUrl: string;
  /** The model the sidecar is expected to have loaded. */
  readonly model: string;
  /** Hard deadline for one request; see `AppConfig.rerank.timeoutMs`. */
  readonly timeoutMs: number;
};

/** A rerank provider backed by the retrieval sidecar. */
export class HttpRerankProvider implements RerankProvider {
  /** @inheritdoc */
  readonly model: string;

  readonly #url: string;
  readonly #timeoutMs: number;

  /**
   * @param http - The outbound HTTP port; the only thing here that touches a socket.
   * @param options - Base URL, model name and per-request deadline.
   */
  constructor(
    private readonly http: RerankHttpClient,
    options: HttpRerankOptions,
  ) {
    this.model = options.model;
    // Trailing slashes are dropped rather than rejected, for the reason the
    // embedding provider gives: every way an operator writes a base URL has to
    // reach the same endpoint, and `//rerank` is a 404 that reads as "the
    // sidecar is broken".
    this.#url = `${options.baseUrl.replace(/\/+$/, '')}${RERANK_PATH}`;
    this.#timeoutMs = options.timeoutMs;
  }

  /** @inheritdoc */
  async rerank(query: string, documents: ReadonlyArray<string>): Promise<RerankOutcome> {
    // Nothing to score is not a failure, and it is not worth a round trip: the
    // caller asked for the scores of no documents, and an empty list is that
    // answer. A fusion that recalled nothing reaches here on every empty search.
    if (documents.length === 0) {
      return { ok: true, scores: [] };
    }

    let response;
    try {
      response = await this.http.post({
        url: this.#url,
        // The model travels with every call so that a sidecar running a
        // different one can refuse rather than answer about the wrong model.
        body: { model: this.model, query, documents },
        timeoutMs: this.#timeoutMs,
      });
    } catch (error: unknown) {
      return {
        ok: false,
        code: 'rerank_service_unreachable',
        reason: `the rerank service could not be reached: ${errorName(error)}`,
      };
    }

    if (response.status !== 200) {
      return { ok: false, ...reasonForStatus(response.status, this.model) };
    }

    return readScores(response.body, this.model, documents.length);
  }
}

/** The code and reason for a non-200 answer, derived from the status alone. */
function reasonForStatus(
  status: number,
  model: string,
): { readonly code: string; readonly reason: string } {
  if (status === 409) {
    return {
      code: 'rerank_model_mismatch',
      reason: `the rerank service is not running the model ${model}`,
    };
  }
  if (status === 503) {
    return {
      code: 'rerank_model_unavailable',
      reason: `the rerank service has not loaded the model ${model} yet`,
    };
  }
  return {
    code: 'rerank_service_http_error',
    reason: `the rerank service answered HTTP ${status} for the model ${model}`,
  };
}

/**
 * One score per document, out of one 200 answer, or why there is none.
 *
 * The answer is read as a *set* of positions rather than as a ranking: the
 * caller sorts, and what this function owes it is a number for every document it
 * sent and for no other. A repeated index is refused because one document would
 * get two scores and another none; an out-of-range index is refused because it
 * describes a document that was not sent; a missing one is refused because the
 * array it would leave behind has a hole in it that the caller cannot see.
 *
 * @param body - The parsed response body.
 * @param model - The model this provider asked for.
 * @param count - How many documents were sent, and so how many scores are owed.
 * @returns The scores aligned to the documents, or a reported failure.
 */
function readScores(body: unknown, model: string, count: number): RerankOutcome {
  if (typeof body !== 'object' || body === null) {
    return {
      ok: false,
      code: 'rerank_response_unusable',
      reason: 'the rerank service answered 200 with a body that carries no JSON object',
    };
  }

  const echoed = (body as { readonly model?: unknown }).model;
  if (typeof echoed === 'string' && echoed !== model) {
    // See the module note: every score below describes a model this caller did
    // not ask for.
    return {
      ok: false,
      code: 'rerank_model_mismatch',
      reason: `the rerank service scored with the model ${echoed} while this provider asked for ${model}`,
    };
  }

  const results = (body as { readonly results?: unknown }).results;
  if (!Array.isArray(results)) {
    return {
      ok: false,
      code: 'rerank_response_unusable',
      reason: 'the rerank service answered 200 without a list of results',
    };
  }

  // Filled rather than left sparse: `new Array(n)` produces holes, and
  // `Array.prototype.some` skips holes — so the completeness check at the end of
  // this function would pass over exactly the missing positions it exists to
  // find, and an answer that dropped a document would come back as `ok`.
  const scores: Array<number | undefined> = new Array<number | undefined>(count).fill(undefined);
  for (const entry of results) {
    if (typeof entry !== 'object' || entry === null) {
      return {
        ok: false,
        code: 'rerank_response_unusable',
        reason: 'the rerank service answered 200 with a result that is not an object',
      };
    }
    const index = (entry as { readonly index?: unknown }).index;
    const score = (entry as { readonly score?: unknown }).score;

    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count) {
      return {
        ok: false,
        code: 'rerank_response_unusable',
        reason: `the rerank service answered 200 with a result for a document that was not sent (of ${count})`,
      };
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      // `NaN` and `Infinity` are the two that matter: a `NaN` sorts
      // inconsistently against everything, so one would make the caller's
      // ordering depend on the sort implementation rather than on the model.
      return {
        ok: false,
        code: 'rerank_response_unusable',
        reason: 'the rerank service answered 200 with a score that is not a finite number',
      };
    }
    if (scores[index] !== undefined) {
      return {
        ok: false,
        code: 'rerank_response_unusable',
        reason: 'the rerank service answered 200 with two results for the same document',
      };
    }
    scores[index] = score;
  }

  if (scores.some((score) => score === undefined)) {
    return {
      ok: false,
      code: 'rerank_response_unusable',
      reason: `the rerank service answered 200 with ${results.length} results instead of one per document (of ${count})`,
    };
  }

  // Every position filled, which the checks above make a total of the set, not a
  // guess about the count.
  return { ok: true, scores: scores as ReadonlyArray<number> };
}

/**
 * The name of a thrown value, for a reason string.
 *
 * Only the name: a client's exception can carry a request body or a URL, and the
 * reason is written to a log an operator reads.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The rerank provider a configuration names, or `undefined` when it names none.
 *
 * The rule is the embedding one, and it lives beside the only implementation for
 * the same reason: "what counts as not configured" is a statement about *this*
 * provider. A *half*-configured pair is folded into the same answer — a base URL
 * with no model names a service but not which model the caller believes is
 * behind it, and answering nothing is safer than choosing a name to send.
 *
 * Unlike the embedding pair, neither variable is on the production required
 * list: a deployment with no reranker answers with the fused order, which is
 * exactly what every deployment answered before this module existed, while a
 * deployment with no embedding service silently indexes nothing. Required
 * variables are for the failures that are invisible.
 *
 * @param rerank - The parsed `rerank` section of the application config.
 * @param http - The outbound HTTP port the provider is built with.
 * @returns A provider, or `undefined` when the configuration names no model.
 */
export function createHttpRerankProvider(
  rerank: AppConfig['rerank'],
  http: RerankHttpClient,
): RerankProvider | undefined {
  if (rerank.baseUrl.trim() === '' || rerank.model.trim() === '') {
    return undefined;
  }
  return new HttpRerankProvider(http, rerank);
}
