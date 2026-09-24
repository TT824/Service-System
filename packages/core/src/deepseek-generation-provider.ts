/**
 * DeepSeek's chat API as the suggestion engine's generation provider.
 *
 * This is the one implementation of {@link GenerationProvider}: it turns a
 * question plus the recalled knowledge into anchored drafts by asking an
 * OpenAI-shaped `/chat/completions` endpoint. It is written against the port
 * rather than against a client library, so everything that can be settled
 * without a socket — the endpoint, the request body, the prompt, and the
 * classification of every way an answer can be wrong — is settled in
 * `deepseek-generation-provider.spec.ts` against a fake
 * {@link GenerationHttpClient}.
 *
 * Every branch below was measured against the live endpoint on 2026-09-18
 * before it was written, and three of them are the opposite of what copying the
 * embedding provider would have produced:
 *
 * **The reported model is ignored.** The endpoint rewrites the name: a request
 * for `deepseek-chat` comes back with `model: "deepseek-flash"`. The embedding
 * provider refuses an answer whose echoed name differs, because that name
 * addresses a vector row; nothing here is addressed by a model name, so the
 * check would reject every answer and is not made.
 *
 * **An empty `content` is a failure with its own code.** The model behind this
 * endpoint is a reasoning model: it writes a private `reasoning_content` channel
 * before the answer, and a token budget that runs out mid-thought yields
 * `content: ""` with `finish_reason: "length"` — measured, at a 30-token cap.
 * Only `content` is ever read as the answer, and its absence is reported rather
 * than read as "the model proposed nothing".
 *
 * **The answer is asked to be JSON, and is still not trusted.** `response_format:
 * {"type":"json_object"}` is sent and the prompt asks for one exact shape, and
 * yet the measured failure mode of a loosely-worded prompt was a bare array of
 * strings with no `sourceId` anywhere in it. So the parse is strict: a candidate
 * survives only if it names an entry **this request supplied** and carries
 * non-empty text. An answer where nothing survives is a reported failure, not an
 * empty success — the difference between "the model declined" and "the model
 * answered about something we never showed it" is a difference an operator
 * needs, and it is the second one that is dangerous.
 *
 * **The `reason` is written to a field a person reads, so it carries no
 * payload.** The service's own error body is never quoted: it can echo the
 * request, and the request carries a tenant's knowledge and a customer's
 * question. What is reported instead is the status, and the one classification
 * worth deriving from it.
 *
 * The precondition is the composition root's: a key, a base URL and a model are
 * all configured. None is re-checked here — an instance that exists at all is
 * one the configuration named. {@link createDeepSeekGenerationProvider} is where
 * that naming happens.
 */

import type { AppConfig } from './app-config';
import { maskPii } from './content-safety/pii';
import type { GenerationHttpClient } from './generation-http-client';
import type {
  GeneratedCandidate,
  GenerationKnowledgeEntry,
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
} from './generation-provider';

/** The path a chat completion lives at, appended to the configured base URL. */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Token budget for one generation.
 *
 * Generous on purpose. The model spends tokens on `reasoning_content` before it
 * writes a character of `content`, so a budget sized to the answer's length is a
 * budget that gets spent on thinking and returns nothing — measured at 30. The
 * cap is a ceiling, not a reservation: an answer that needs 150 tokens is billed
 * for 150.
 */
const MAX_TOKENS = 1200;

/**
 * Sampling temperature.
 *
 * Low and fixed. Three drafts of the same reply should differ in phrasing, not
 * in what they claim is true, and the things this model must not invent — a
 * price, a stock level — are exactly the things a hot sampler invents.
 */
const TEMPERATURE = 0.3;

/** Where one generation provider sends its requests, and what it calls itself. */
export type DeepSeekGenerationOptions = {
  /** Bearer token (`DEEPSEEK_API_KEY`). */
  readonly apiKey: string;
  /** Base URL of the API, e.g. `https://api.deepseek.com`. */
  readonly baseUrl: string;
  /** Model to ask (`DEEPSEEK_MODEL`). */
  readonly model: string;
  /** Hard deadline for one request; see `AppConfig.generation.timeoutMs`. */
  readonly timeoutMs: number;
};

/** A generation provider backed by an OpenAI-shaped chat completions endpoint. */
export class DeepSeekGenerationProvider implements GenerationProvider {
  /** @inheritdoc */
  readonly model: string;

  readonly #url: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  /**
   * @param http - The outbound HTTP port; the only thing here that touches a socket.
   * @param options - Key, base URL, model and per-request deadline.
   */
  constructor(
    private readonly http: GenerationHttpClient,
    options: DeepSeekGenerationOptions,
  ) {
    this.model = options.model;
    // Trailing slashes dropped rather than rejected, for the embedding
    // provider's reason: every way an operator writes a base URL has to reach
    // the same endpoint, and `//chat/completions` is a 404 that reads as "the
    // API is broken".
    this.#url = `${options.baseUrl.replace(/\/+$/, '')}${CHAT_COMPLETIONS_PATH}`;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
  }

  /** @inheritdoc */
  async generate(request: GenerationRequest): Promise<GenerationResult> {
    // §4.5, applied at the socket rather than at the caller: this is the last
    // place a request exists before it belongs to somebody else, and a second
    // caller of this port cannot forget a step that is not its own.
    const redacted = redactForModel(request);

    let response;
    try {
      response = await this.http.post({
        url: this.#url,
        headers: { authorization: `Bearer ${this.#apiKey}` },
        body: {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt(request.limit) },
            { role: 'user', content: userPrompt(redacted.query, redacted.knowledge) },
          ],
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          // Asked for, never relied on: see the module note.
          response_format: { type: 'json_object' },
        },
        timeoutMs: this.#timeoutMs,
      });
    } catch (error: unknown) {
      return {
        ok: false,
        code: 'generation_service_unreachable',
        reason: `the generation service could not be reached: ${errorName(error)}`,
      };
    }

    if (response.status !== 200) {
      return { ok: false, ...classifyStatus(response.status, this.model) };
    }

    return readCandidates(response.body, request);
  }
}

/** The status of a non-200 answer, as a code and a reason. */
function classifyStatus(
  status: number,
  model: string,
): { readonly code: string; readonly reason: string } {
  if (status === 401 || status === 403) {
    // The key is wrong, expired, or not entitled to this model. Separated from
    // the generic HTTP error because it is the one an operator can fix without
    // reading anything else.
    return {
      code: 'generation_unauthorized',
      reason: `the generation service rejected the configured key (HTTP ${status})`,
    };
  }
  if (status === 404) {
    return {
      code: 'generation_model_not_found',
      reason: `the generation service does not know the model ${model}`,
    };
  }
  if (status === 429) {
    // Its own code because a demo that trips a rate limit must not read as a
    // broken deployment.
    return {
      code: 'generation_rate_limited',
      reason: 'the generation service is rate limiting this key',
    };
  }
  return {
    code: 'generation_service_http_error',
    reason: `the generation service answered HTTP ${status} for the model ${model}`,
  };
}

/**
 * The drafts out of one 200 answer, or why there are none usable.
 *
 * @param body - The parsed response body.
 * @param request - The request the answer belongs to, for its entries and limit.
 * @returns The anchored drafts, or a reported failure naming what was missing.
 */
function readCandidates(body: unknown, request: GenerationRequest): GenerationResult {
  if (typeof body !== 'object' || body === null) {
    return {
      ok: false,
      code: 'generation_response_unusable',
      reason: 'the generation service answered 200 with a body that carries no JSON object',
    };
  }

  const choices = (body as { readonly choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    // Zero choices is not "zero candidates": an answer with no completion in it
    // at all is a service that did not answer, and reporting it as an empty
    // success would hide an outage behind a quiet workbench.
    return {
      ok: false,
      code: 'generation_response_unusable',
      reason: 'the generation service answered 200 with no completion',
    };
  }

  const choice = choices[0] as { readonly message?: unknown; readonly finish_reason?: unknown };
  const message = choice.message;
  if (typeof message !== 'object' || message === null) {
    return {
      ok: false,
      code: 'generation_response_unusable',
      reason: 'the generation service answered 200 with a completion that carries no message',
    };
  }

  const content = (message as { readonly content?: unknown }).content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    // See the module note: a reasoning model that ran out of budget lands here,
    // and it must not read as "the model proposed nothing".
    return {
      ok: false,
      code: 'generation_empty_completion',
      reason:
        choice.finish_reason === 'length'
          ? 'the generation service stopped at its token limit before writing an answer (the model spends tokens on reasoning first; raise the provider token budget)'
          : 'the generation service answered 200 with an empty message',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      ok: false,
      code: 'generation_unusable_output',
      reason: 'the generation service answered 200 with a message that is not JSON',
    };
  }

  const raw = (parsed as { readonly candidates?: unknown }).candidates;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: 'generation_unusable_output',
      reason: 'the generation service answered 200 with JSON that carries no candidates array',
    };
  }

  const allowed = new Set(request.knowledge.map((entry) => entry.id));
  const candidates = raw
    .map((entry) => toCandidate(entry, allowed))
    .filter((candidate): candidate is GeneratedCandidate => candidate !== undefined)
    // More drafts than were asked for is the model ignoring the count. The
    // request's own limit wins; see the port's `limit`.
    .slice(0, request.limit);

  if (candidates.length === 0 && raw.length > 0) {
    // Answered, and none of it can be used. The common cause is worth naming
    // because it is the one this design exists to catch: the model wrote
    // plausible replies anchored to ids nobody sent.
    return {
      ok: false,
      code: 'generation_unusable_output',
      reason: `the generation service answered with ${raw.length} candidates, none of which named a knowledge entry it was given`,
    };
  }

  return { ok: true, candidates };
}

/**
 * One candidate, if it is usable.
 *
 * @param entry - One element of the model's `candidates` array.
 * @param allowed - The ids this request supplied; the only ids that survive.
 * @returns The candidate, or `undefined` when it is dropped.
 */
function toCandidate(entry: unknown, allowed: ReadonlySet<string>): GeneratedCandidate | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const sourceId = (entry as { readonly sourceId?: unknown }).sourceId;
  const content = (entry as { readonly content?: unknown }).content;
  if (typeof sourceId !== 'string' || !allowed.has(sourceId)) {
    // Dropped, never repaired: see the port's note on anchoring. A candidate
    // whose anchor cannot be re-read in the caller's scope is one that "select
    // and send" could not cite, and a set carrying it would look correct.
    return undefined;
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    return undefined;
  }
  return Object.freeze({ sourceId, content: content.trim() });
}

/** The instruction half of the prompt, for one requested count. */
function systemPrompt(limit: number): string {
  return [
    `你是电商客服话术助手。请根据给定的知识条目，为顾客的问题写 ${limit} 条可以直接发给顾客的中文回复。`,
    '要求：',
    '1. 只依据给出的知识条目，不得编造价格、库存、优惠或任何承诺；条目里没有的信息一个字都不要出现。',
    '2. 每条不超过 60 字，语气自然，像真人客服在打字。',
    '3. 每条回复都要挂在它依据的条目上，sourceId 必须是给定条目的 id 原文。',
    `只输出一个 JSON 对象，形如 {"candidates":[{"sourceId":"条目id","content":"回复正文"}]}，不要输出任何解释或 Markdown 代码块。`,
  ].join('\n');
}

/**
 * The request as a model vendor may see it: every field a customer could have
 * written, with their PII removed.
 *
 * Two redactions apply to this prompt and they are different in kind. The
 * entries carry only customer-visible fields — the catalogue's cost price,
 * wholesale price and tags never reach a knowledge slice, so they cannot reach
 * this prompt (see the product knowledge mapper); that is a *field* whitelist,
 * applied once upstream, where it is testable. What it does not do is stop a
 * phone number a customer typed into a question, or one sitting in a FAQ answer
 * somebody pasted a transcript into. That is this function's job, and it is the
 * reason the two cannot be collapsed into one another.
 *
 * The entries are masked as well as the question. A boundary that guards only
 * the half it expects to be dirty is not a boundary — the question is the
 * obvious carrier, not the only one.
 */
function redactForModel(request: GenerationRequest): {
  readonly query: string;
  readonly knowledge: ReadonlyArray<GenerationKnowledgeEntry>;
} {
  return {
    query: maskPii(request.query).text,
    knowledge: request.knowledge.map((entry) => ({
      ...entry,
      title: maskPii(entry.title).text,
      content: maskPii(entry.content).text,
    })),
  };
}

/**
 * The material half of the prompt: the entries, then the question.
 *
 * Rendered verbatim, because by the time a value arrives here it has passed
 * both gates above — the field whitelist and {@link redactForModel}. Anything
 * filtered at this point would be filtered a second time, in a place with no
 * way to say what it removed.
 */
function userPrompt(query: string, knowledge: ReadonlyArray<GenerationKnowledgeEntry>): string {
  const lines = knowledge.map(
    (entry) => `- id=${entry.id} 标题=${entry.title} 内容=${entry.content}`,
  );
  return `${['知识条目：', ...lines].join('\n')}\n\n顾客的问题：${query}`;
}

/**
 * The name of a thrown value, for a reason string.
 *
 * Only the name: a client's exception can carry a request body or a URL, and the
 * reason is written to a field a person reads.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The generation provider a configuration names, or `undefined` when it names none.
 *
 * The rule lives beside the only implementation because "what counts as not
 * configured" is a statement about *this* provider: a key with no model names a
 * service but not what to ask it, and answering nothing is safer than guessing —
 * the same reading the embedding factory gives a half-configured pair.
 *
 * A blank key or model is a **supported state, not a misconfiguration**: this
 * variable is deliberately absent from `PRODUCTION_REQUIRED_VARIABLES`, so a
 * deployment that did not buy generation starts, answers from its own knowledge,
 * and says so in the set's fallback reasons rather than refusing to boot.
 *
 * @param generation - The parsed `generation` section of the application config.
 * @param http - The outbound HTTP port the provider is built with.
 * @returns A provider, or `undefined` when the configuration names no key or model.
 */
export function createDeepSeekGenerationProvider(
  generation: AppConfig['generation'],
  http: GenerationHttpClient,
): GenerationProvider | undefined {
  const apiKey = generation.apiKey.unwrap().trim();
  if (apiKey === '' || generation.model.trim() === '') {
    return undefined;
  }
  return new DeepSeekGenerationProvider(http, {
    apiKey,
    baseUrl: generation.baseUrl,
    model: generation.model,
    timeoutMs: generation.timeoutMs,
  });
}
