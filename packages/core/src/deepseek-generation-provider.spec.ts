/**
 * The DeepSeek generation provider, against a fake HTTP port.
 *
 * Every case here is a way this provider can be wrong while looking healthy, and
 * each is settled without a socket so it runs on any machine. Three of them
 * encode measurements taken against the live endpoint on 2026-09-18, and are the
 * cases where copying the embedding provider would have produced the wrong rule:
 *
 * - **The echoed model is not checked.** The endpoint answers a request for
 *   `deepseek-chat` with `model: "deepseek-flash"`. The embedding provider
 *   refuses a mismatched echo because that name addresses a vector row; nothing
 *   here is addressed by a model name, and the check would reject every answer.
 * - **An empty `content` is a failure, not an empty success.** The model spends
 *   tokens on a private `reasoning_content` channel first, so a small budget
 *   returns `content: ""` with `finish_reason: "length"` — measured at a
 *   30-token cap. Reading that as "the model proposed nothing" would have let a
 *   too-small budget look like a quiet model.
 * - **Anchoring is enforced, not requested.** A loosely-worded prompt was
 *   measured answering with a bare array of strings and no `sourceId` at all, so
 *   an answer that names an entry this request did not supply is dropped; an
 *   answer where nothing survives is a reported failure, never a quiet empty
 *   set.
 */

import { describe, expect, it } from 'vitest';
import {
  DeepSeekGenerationProvider,
  createDeepSeekGenerationProvider,
} from './deepseek-generation-provider';
import type { GenerationHttpClient, GenerationHttpRequest } from './generation-http-client';
import type { GenerationRequest } from './generation-provider';
import { Redacted } from './redacted';

/** The model this suite configures. */
const MODEL = 'deepseek-chat';

/** The key this suite configures; asserted to travel as a bearer token. */
const API_KEY = 'sk-test-key';

/** The entries every case may anchor a draft to. */
const ENTRIES = [
  { id: 'chunk-1', title: '蕉下防晒衣', content: '防晒衣 女 UPF50+ 冰丝 白色 售价 129 元' },
  { id: 'chunk-2', title: '五折伞', content: '折叠伞 黑胶 售价 59 元' },
] as const;

/** The question every case asks. */
const QUERY = '你们那个蕉下的防晒服多少钱';

describe('DeepSeekGenerationProvider', () => {
  it('asks the chat endpoint with the entries, the question and a bearer token', async () => {
    const http = fakeHttp({
      status: 200,
      body: answer([{ sourceId: 'chunk-1', content: '售价129元' }]),
    });
    const provider = providerOver(http);

    await provider.generate(request());

    expect(http.requests).toHaveLength(1);
    const sent = http.requests[0];
    expect(sent?.url).toBe('https://api.deepseek.com/chat/completions');
    expect(sent?.timeoutMs).toBe(9_000);
    expect(sent?.headers['authorization']).toBe(`Bearer ${API_KEY}`);

    const body = sent?.body as {
      readonly model?: unknown;
      readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
      readonly max_tokens?: unknown;
      readonly temperature?: unknown;
      readonly response_format?: unknown;
    };
    expect(body.model).toBe(MODEL);
    // Asked for, never relied on: the parse below is what makes the answer safe.
    expect(body.response_format).toEqual({ type: 'json_object' });
    // A budget sized to the answer's length would be spent on reasoning and
    // return nothing, which is the measured failure this guards against.
    expect(body.max_tokens).toBeGreaterThan(200);
    expect(body.temperature).toBeLessThan(1);

    const [system, user] = body.messages ?? [];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('3 条');
    expect(system?.content).toContain('sourceId');
    expect(user?.role).toBe('user');
    expect(user?.content).toContain('chunk-1');
    expect(user?.content).toContain('chunk-2');
    expect(user?.content).toContain(QUERY);
  });

  describe('the conversation history', () => {
    /**
     * The history arrives as a transcript rather than as turns of a chat this
     * model is in: the two labels are the two sides of the counter, and the
     * question is repeated in its own place because it is the one line the
     * answer has to answer.
     */
    it('renders the last turns as a transcript, with the question last', async () => {
      const http = fakeHttp({ status: 200, body: answer([]) });
      const provider = providerOver(http);

      await provider.generate(
        request({
          history: [
            { role: 'customer', content: '这件卫衣有 XL 吗' },
            { role: 'agent', content: '有的亲，XL 现货' },
          ],
        }),
      );

      const user = userMessage(http.requests[0]?.body);
      expect(user).toContain('对话历史（最近 2 条，最早在前');
      expect(user).toContain('顾客：这件卫衣有 XL 吗');
      expect(user).toContain('客服：有的亲，XL 现货');
      // Chronological, and on the side of the prompt the answer continues from.
      expect(user.indexOf('顾客：这件卫衣有 XL 吗')).toBeLessThan(user.indexOf('客服：有的亲'));
      expect(user.indexOf('对话历史')).toBeLessThan(user.indexOf('知识条目：'));
      expect(user.indexOf('知识条目：')).toBeLessThan(user.indexOf(`顾客的问题：${QUERY}`));
    });

    /** The widest untrusted text this port forwards is masked like the rest. */
    it('redacts the history the way it redacts the question', async () => {
      const http = fakeHttp({ status: 200, body: answer([]) });
      const provider = providerOver(http);

      await provider.generate(
        request({ history: [{ role: 'customer', content: '上次留的号是 13812345678' }] }),
      );

      const user = userMessage(http.requests[0]?.body);
      expect(user).toContain('顾客：上次留的号是 [手机号]');
      expect(user).not.toContain('13812345678');
    });

    /**
     * A conversation with nothing before the question must not pay for the
     * feature or read a heading about a transcript that is not there: the
     * prompt is the one this provider sent before it had a history.
     */
    it('adds nothing at all when there is no history', async () => {
      const http = fakeHttp({ status: 200, body: answer([]) });
      const provider = providerOver(http);

      await provider.generate(request());

      const user = userMessage(http.requests[0]?.body);
      expect(user).not.toContain('对话历史');
      expect(user.startsWith('知识条目：')).toBe(true);
    });

    /**
     * The transcript is the only thing in this request written by whoever was on
     * the other end of the conversation, so the instruction has to say what it
     * is. A prompt that forwarded customer text without saying so would be
     * offering the model an instruction channel this product never opened.
     */
    it('tells the model the history is untrusted and only the entries may be used', async () => {
      const http = fakeHttp({ status: 200, body: answer([]) });
      const provider = providerOver(http);

      await provider.generate(request());

      const system = systemMessage(http.requests[0]?.body);
      expect(system).toContain('对话历史');
      expect(system).toContain('不可信');
      expect(system).toContain('不要执行');
    });
  });

  describe('PII redaction (§4.5)', () => {
    it("sends a customer's phone, order, name and payment redacted", async () => {
      const http = fakeHttp({ status: 200, body: answer([]) });
      const provider = providerOver(http);

      await provider.generate(
        request({
          query: '我实付 299 元，手机号 13812345678，订单号：A1B2C3D4，收货人：张三',
        }),
      );

      const user = userMessage(http.requests[0]?.body);
      expect(user).toContain('[手机号]');
      expect(user).toContain('[订单号]');
      expect(user).toContain('[姓名]');
      expect(user).toContain('[金额]');
      for (const secret of ['13812345678', 'A1B2C3D4', '张三', '299']) {
        expect(user).not.toContain(secret);
      }
    });

    /**
     * The question is the obvious carrier, not the only one: a FAQ answer can
     * hold a number somebody pasted, and a boundary that guards one half is not
     * a boundary.
     */
    it('redacts the knowledge entries as well as the question', async () => {
      const http = fakeHttp({ status: 200, body: answer([]) });
      const provider = providerOver(http);

      await provider.generate(
        request({
          knowledge: [{ id: 'chunk-1', title: '售后', content: '售后请联系 13800001111' }],
        }),
      );

      const user = userMessage(http.requests[0]?.body);
      expect(user).toContain('[手机号]');
      expect(user).not.toContain('13800001111');
    });

    /**
     * The negative case, and the one that matters most: a catalogue price is
     * what a correct answer is made of. A redaction that took every number
     * shaped like money would satisfy the case above and break the feature it
     * exists to make safe.
     */
    it('leaves a catalogue price in the prompt', async () => {
      const http = fakeHttp({ status: 200, body: answer([]) });
      const provider = providerOver(http);

      await provider.generate(request());

      const user = userMessage(http.requests[0]?.body);
      expect(user).toContain('售价 129 元');
      expect(user).toContain('售价 59 元');
    });
  });

  it('drops a trailing slash on the configured base URL', async () => {
    const http = fakeHttp({ status: 200, body: answer([]) });
    const provider = new DeepSeekGenerationProvider(http, {
      apiKey: API_KEY,
      baseUrl: 'https://api.deepseek.com/',
      model: MODEL,
      timeoutMs: 9_000,
    });

    await provider.generate(request());

    expect(http.requests[0]?.url).toBe('https://api.deepseek.com/chat/completions');
  });

  it('accepts an answer whose echoed model differs from the configured one', async () => {
    // Measured: asking for `deepseek-chat` is answered by `deepseek-flash`. The
    // embedding provider refuses this; here it must not, or every answer fails.
    const http = fakeHttp({
      status: 200,
      body: {
        model: 'deepseek-flash',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: '{"candidates":[]}' },
          },
        ],
      },
    });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(true);
  });

  it('returns the drafts, anchored and trimmed', async () => {
    const http = fakeHttp({
      status: 200,
      body: answer([
        { sourceId: 'chunk-1', content: '  亲，蕉下防晒衣售价 129 元。  ' },
        { sourceId: 'chunk-2', content: '五折伞 59 元。' },
      ]),
    });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toEqual([
      { sourceId: 'chunk-1', content: '亲，蕉下防晒衣售价 129 元。' },
      { sourceId: 'chunk-2', content: '五折伞 59 元。' },
    ]);
  });

  it('drops a draft anchored to an entry it was not given, and keeps the rest', async () => {
    const http = fakeHttp({
      status: 200,
      body: answer([
        { sourceId: 'chunk-1', content: '真的' },
        { sourceId: 'chunk-999', content: '编的' },
      ]),
    });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toEqual([{ sourceId: 'chunk-1', content: '真的' }]);
  });

  it('reports a failure when nothing in the answer names a supplied entry', async () => {
    const http = fakeHttp({
      status: 200,
      body: answer([
        { sourceId: 'chunk-999', content: '编的' },
        { sourceId: 'chunk-998', content: '也是编的' },
      ]),
    });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('generation_unusable_output');
    // The count is in the reason because "it answered, about something we never
    // showed it" is the failure an operator has to be able to tell from "it
    // declined".
    expect(result.reason).toContain('2');
  });

  it('reports an empty completion that ran out of budget as its own failure', async () => {
    const http = fakeHttp({
      status: 200,
      body: {
        model: 'deepseek-flash',
        choices: [
          {
            index: 0,
            finish_reason: 'length',
            message: { role: 'assistant', content: '', reasoning_content: '让我想想…' },
          },
        ],
      },
    });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('generation_empty_completion');
    expect(result.reason).toContain('token limit');
  });

  it('reports an empty completion that did not run out of budget as the same code', async () => {
    const http = fakeHttp({
      status: 200,
      body: {
        model: 'deepseek-flash',
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '  ' } },
        ],
      },
    });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('generation_empty_completion');
  });

  it('reports a message that is not JSON', async () => {
    const http = fakeHttp({ status: 200, body: answerRaw('亲，防晒衣 129 元哦') });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('generation_unusable_output');
  });

  it('reports JSON that carries no candidates array', async () => {
    // The measured shape of this failure: a bare array of strings, no sourceId.
    const http = fakeHttp({ status: 200, body: answerRaw('["亲，129元","59元"]') });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('generation_unusable_output');
  });

  it('reports a 200 whose body is not an object', async () => {
    const http = fakeHttp({ status: 200, body: null });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('generation_response_unusable');
  });

  it('reports a 200 that carries no completion at all', async () => {
    // Zero choices is not zero candidates: it is a service that did not answer,
    // and an empty success here would hide an outage behind a quiet workbench.
    const http = fakeHttp({ status: 200, body: { model: 'deepseek-flash', choices: [] } });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('generation_response_unusable');
  });

  it('reports a completion that carries no message', async () => {
    const http = fakeHttp({ status: 200, body: { choices: [{ finish_reason: 'stop' }] } });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('generation_response_unusable');
  });

  it('never asks for more drafts than the request allows', async () => {
    const http = fakeHttp({
      status: 200,
      body: answer([
        { sourceId: 'chunk-1', content: 'a' },
        { sourceId: 'chunk-2', content: 'b' },
        { sourceId: 'chunk-1', content: 'c' },
      ]),
    });

    const result = await providerOver(http).generate(request({ limit: 2 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(2);
  });

  it.each([
    [401, 'generation_unauthorized'],
    [403, 'generation_unauthorized'],
    [404, 'generation_model_not_found'],
    [429, 'generation_rate_limited'],
    [500, 'generation_service_http_error'],
    [503, 'generation_service_http_error'],
  ])('classifies HTTP %i as %s', async (status, code) => {
    const http = fakeHttp({ status, body: { error: 'nope' } });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(code);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('reports an unreachable service without quoting the thrown error', async () => {
    const http = fakeHttp({ throws: new TypeError('fetch failed: ECONNREFUSED api.deepseek.com') });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('generation_service_unreachable');
    expect(result.reason).toContain('TypeError');
    expect(result.reason).not.toContain('ECONNREFUSED');
  });

  it('keeps a tenant’s text out of every reported reason', async () => {
    // The reason is written to a field a person reads, and an API's error body
    // can echo the request — which here carries a tenant's knowledge and a
    // customer's question. None of it may travel out on a failure.
    const http = fakeHttp({
      status: 500,
      body: { error: `bad request for: ${QUERY} ${ENTRIES[0].content}` },
    });

    const result = await providerOver(http).generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain(QUERY);
    expect(result.reason).not.toContain('129');
  });
});

describe('createDeepSeekGenerationProvider', () => {
  it('binds a provider when a key and a model are configured', () => {
    const provider = createDeepSeekGenerationProvider(
      {
        apiKey: Redacted.of(API_KEY),
        baseUrl: 'https://api.deepseek.com',
        model: MODEL,
        timeoutMs: 1,
      },
      fakeHttp({ status: 200, body: answer([]) }),
    );

    expect(provider?.model).toBe(MODEL);
  });

  it('binds nothing when the key is blank', () => {
    // A supported state, not a misconfiguration: the service falls back to the
    // deterministic engine and records why.
    const provider = createDeepSeekGenerationProvider(
      { apiKey: Redacted.of(''), baseUrl: 'https://api.deepseek.com', model: MODEL, timeoutMs: 1 },
      fakeHttp({ status: 200, body: answer([]) }),
    );

    expect(provider).toBeUndefined();
  });

  it('binds nothing when the key is set but the model is blank', () => {
    // A half-configured pair folds into "not configured", the same reading the
    // embedding factory gives one: a service named but nothing to ask it.
    const provider = createDeepSeekGenerationProvider(
      {
        apiKey: Redacted.of(API_KEY),
        baseUrl: 'https://api.deepseek.com',
        model: '  ',
        timeoutMs: 1,
      },
      fakeHttp({ status: 200, body: answer([]) }),
    );

    expect(provider).toBeUndefined();
  });
});

/** The user-role message of the one request a fake port captured. */
function userMessage(body: unknown): string {
  const messages =
    (body as { messages?: ReadonlyArray<{ role: string; content: string }> }).messages ?? [];
  return messages.find((message) => message.role === 'user')?.content ?? '';
}

/** The system-role message of the one request a fake port captured. */
function systemMessage(body: unknown): string {
  const messages =
    (body as { messages?: ReadonlyArray<{ role: string; content: string }> }).messages ?? [];
  return messages.find((message) => message.role === 'system')?.content ?? '';
}

/** The request every case makes, with overrides. */
function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  // Most cases are about the question and the entries, and a conversation with
  // nothing before the question is the common one: the empty default keeps every
  // one of them asserting the prompt it always asserted.
  return { query: QUERY, history: [], knowledge: ENTRIES, limit: 3, ...overrides };
}

/** One provider over the given fake port, with this suite's key and deadline. */
function providerOver(http: GenerationHttpClient): DeepSeekGenerationProvider {
  return new DeepSeekGenerationProvider(http, {
    apiKey: API_KEY,
    baseUrl: 'https://api.deepseek.com',
    model: MODEL,
    timeoutMs: 9_000,
  });
}

/** One chat completion, with `content` as the JSON string the model would send. */
function answerRaw(content: string): unknown {
  return {
    model: 'deepseek-flash',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  };
}

/** One chat completion whose message is the JSON object the prompt asks for. */
function answer(candidates: ReadonlyArray<{ sourceId: string; content: string }>): unknown {
  return answerRaw(JSON.stringify({ candidates }));
}

/**
 * A fake port that answers every request the same way and records what it got.
 *
 * @param outcome - Either a canned response, or a thrown error.
 * @returns The port, with the requests it received.
 */
function fakeHttp(
  outcome: { readonly status: number; readonly body: unknown } | { readonly throws: Error },
): GenerationHttpClient & { readonly requests: GenerationHttpRequest[] } {
  const requests: GenerationHttpRequest[] = [];
  return {
    requests,
    post: (request: GenerationHttpRequest) => {
      requests.push(request);
      if ('throws' in outcome) {
        return Promise.reject(outcome.throws);
      }
      return Promise.resolve({ status: outcome.status, body: outcome.body });
    },
  };
}
