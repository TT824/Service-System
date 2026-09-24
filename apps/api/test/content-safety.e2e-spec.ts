import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTENT_SAFETY_RULES,
  GENERATION_PROVIDER,
  parseAppConfig,
  type ContentSafetyRule,
  type GenerationProvider,
  type GenerationRequest,
} from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';

const CONVERSATION = 'conversation-acme-2';
const AGENT = 'u-t1-agent-1';
const TENANT_ADMIN = 'u-t1-admin';

const SUGGESTIONS_URL = '/api/v1/retrieval/suggestions';
const MESSAGES_URL = `/api/v1/conversations/${CONVERSATION}/messages`;
const REVIEW_QUEUE_URL = '/api/v1/review/queue';

/** The phrase the library bans, and the one it does not. */
const BANNED = '这款是全网最低价，快拍';
const CLEAN = '亲，这款有货的哦～';

type DataEnvelope = { request_id: string; data: unknown; meta: Record<string, never> };
type ErrorEnvelope = { code: string; message: string; details: ReadonlyArray<string> };

/** What the endpoint serializes one suggestion set as. */
type SuggestSet = {
  readonly provider: string;
  readonly candidates: ReadonlyArray<{ readonly content: string }>;
  readonly fallbackReasons: ReadonlyArray<string>;
};

/**
 * The two content-safety gates (§4.5, UC-17), over the real HTTP stack and the
 * real database.
 *
 * A unit test can show that `screenContent` blocks a phrase. What it cannot
 * show is that anything downstream *calls* it, and that is the whole of this
 * milestone: the library is worthless if the send path never asks it, and the
 * failure mode of a missing gate is identical to the failure mode of a working
 * one — a normal-looking request that succeeds.
 *
 * So every claim here is paired. The suite runs the same request twice against
 * two applications that differ in exactly one thing — the rule library — and
 * asserts that the verdict flips. That pairing is the falsification the plan
 * asks for: empty the library and the blocking must stop, or the blocking was
 * never coming from the library.
 *
 * The two gates are separate cases because they see different text. The
 * candidate gate screens what the engine and the model propose; the send gate
 * screens what a person typed, which is the only one of the two that can catch
 * a phrase no rule was written for when the candidate was generated.
 */
describe('Content safety (interface)', () => {
  describe('with the shipped rule library', () => {
    let app: INestApplication;
    const asked: GenerationRequest[] = [];

    beforeAll(async () => {
      app = await buildApp({ provider: draftingProvider(asked) });
    });

    afterAll(async () => {
      await app.close();
    });

    it('keeps a banned draft out of the persisted set and records why', async () => {
      const response = await request(app.getHttpServer())
        .post(SUGGESTIONS_URL)
        .set('x-member-id', AGENT)
        .send({ conversationId: CONVERSATION, query: '白色 M 现货' })
        .expect(201);

      const set = (response.body as DataEnvelope).data as SuggestSet;

      // The fixture has to offer two entries for this case to mean anything:
      // with one, "the banned draft is gone" and "the model answered nothing"
      // are the same observation.
      expect(asked[0]?.knowledge.length).toBeGreaterThanOrEqual(2);

      expect(set.candidates).toHaveLength(1);
      expect(set.candidates[0]?.content).toBe(CLEAN);
      expect(set.candidates.some((candidate) => candidate.content.includes('全网最低'))).toBe(
        false,
      );
      // The set is not silently short: a seat reading it can tell something was
      // removed, which is what "拦截结果提示客服" asks for.
      expect(set.fallbackReasons).toContain('content_blocked');
    });

    it('refuses an outbound message containing a banned phrase', async () => {
      const response = await request(app.getHttpServer())
        .post(MESSAGES_URL)
        .set('x-member-id', AGENT)
        .send({ content: BANNED, source: 'manual_typed', dedupKey: 'kefu-e2e-blocked-1' })
        .expect(400);

      const error = response.body as ErrorEnvelope;
      expect(error.code).toBe('bad_request');
      // The seat is told which phrase, not merely that something was wrong.
      //
      // It arrives in `details` because that is the only field the exception
      // filter forwards: `message` is always replaced with the status's own
      // text. Asserted as a pair so that a future change to that projection
      // fails here rather than silently degrading this response to a bare
      // "Bad Request" — which is a real thing this suite caught once.
      expect(error.message).toBe('Bad Request');
      expect(error.details.join('')).toContain('全网最低');
    });

    /**
     * UC-17 says a banned phrase must not reach the review queue. The queue is
     * derived from `messages` rows that are review-eligible, so the only way a
     * phrase enters it is by being sent — which is why this asserts through the
     * send endpoint rather than by inspecting a queue table that does not exist.
     */
    it('leaves no trace of a refused message in the review queue', async () => {
      await request(app.getHttpServer())
        .post(MESSAGES_URL)
        .set('x-member-id', AGENT)
        .send({ content: BANNED, source: 'direct_candidate', dedupKey: 'kefu-e2e-blocked-2' })
        .expect(400);

      const queue = await request(app.getHttpServer())
        .get(REVIEW_QUEUE_URL)
        .set('x-member-id', TENANT_ADMIN)
        .expect(200);

      const pending = (queue.body as DataEnvelope).data as ReadonlyArray<{ content: string }>;
      expect(pending.some((message) => message.content.includes('全网最低'))).toBe(false);
    });
  });

  /**
   * The falsification, and the reason the rule library is an injected token
   * rather than an import at the call sites. Every request below is identical
   * to one above; only the library is empty. If the blocking were coming from
   * anywhere but the library, these would fail.
   */
  describe('with the rule library emptied', () => {
    let app: INestApplication;
    const asked: GenerationRequest[] = [];

    beforeAll(async () => {
      app = await buildApp({ provider: draftingProvider(asked), rules: [] });
    });

    afterAll(async () => {
      await app.close();
    });

    it('lets the same banned draft into the persisted set', async () => {
      const response = await request(app.getHttpServer())
        .post(SUGGESTIONS_URL)
        .set('x-member-id', AGENT)
        .send({ conversationId: CONVERSATION, query: '白色 M 现货' })
        .expect(201);

      const set = (response.body as DataEnvelope).data as SuggestSet;
      expect(set.candidates).toHaveLength(2);
      expect(set.candidates.some((candidate) => candidate.content === BANNED)).toBe(true);
      expect(set.fallbackReasons).not.toContain('content_blocked');
    });

    it('accepts the same outbound message it refused a moment ago', async () => {
      const response = await request(app.getHttpServer())
        .post(MESSAGES_URL)
        .set('x-member-id', AGENT)
        .send({ content: BANNED, source: 'manual_typed', dedupKey: 'kefu-e2e-blocked-1' })
        .expect(201);

      const sent = (response.body as DataEnvelope).data as {
        readonly message: { readonly content: string };
      };
      expect(sent.message.content).toBe(BANNED);
    });
  });
});

/**
 * A provider whose first draft is a banned phrase and whose second is not.
 *
 * Two drafts from two entries, so that "one was removed" and "nothing came
 * back" stay distinguishable — a fake that answered with a single banned
 * candidate would make a working gate and a broken provider look alike.
 */
function draftingProvider(asked: GenerationRequest[]): GenerationProvider {
  return {
    model: 'fake-model',
    generate: (generationRequest: GenerationRequest) => {
      asked.push(generationRequest);
      return Promise.resolve({
        ok: true as const,
        candidates: generationRequest.knowledge.slice(0, 2).map((entry, index) => ({
          sourceId: entry.id,
          content: index === 0 ? BANNED : CLEAN,
        })),
      });
    },
  };
}

/** One application over the real stack, with the given library bound. */
async function buildApp(options: {
  readonly provider: GenerationProvider;
  /** Omitted to leave the shipped library in place. */
  readonly rules?: ReadonlyArray<ContentSafetyRule>;
}): Promise<INestApplication> {
  const parsed = parseAppConfig({ APP_ENV: 'test' });
  if (parsed._tag !== 'ok') {
    throw new Error(`test config could not be parsed: ${parsed.error.message}`);
  }

  let builder = Test.createTestingModule({
    imports: [AppModule.register(parsed.config)],
  })
    .overrideProvider(GENERATION_PROVIDER)
    .useValue(options.provider);

  if (options.rules !== undefined) {
    builder = builder.overrideProvider(CONTENT_SAFETY_RULES).useValue(options.rules);
  }

  const app = (await builder.compile()).createNestApplication();
  applyHttpDefaults(app, parsed.config);
  await app.init();
  attachJsonLogger(app);
  return app;
}
