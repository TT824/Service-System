import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GENERATION_PROVIDER,
  parseAppConfig,
  type GenerationProvider,
  type GenerationRequest,
} from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';

const TENANT = 'tenant-acme';
const STORE = 'store-acme-flagship';
const MEMBER = 'u-t1-agent-1';
const CONVERSATION = 'conversation-acme-2';
const SUGGESTIONS_URL = '/api/v1/retrieval/suggestions';

type DataEnvelope = { request_id: string; data: unknown; meta: Record<string, never> };

/** What the endpoint serializes one suggestion set as. */
type SuggestSet = {
  readonly id: string;
  readonly provider: string;
  readonly candidates: ReadonlyArray<Record<string, unknown>>;
  readonly fallbackReasons: ReadonlyArray<string>;
};

/**
 * The suggestion path with a generation provider bound, over the real HTTP
 * stack.
 *
 * The provider is the suite's own fake rather than one built from the
 * environment, for the reason the semantic recall suite gives about its
 * embedding model: a test that silently called a live API would be measuring
 * the environment, and here it would also be spending somebody's money. What
 * the fake buys is the thing a unit test cannot show — that the module binds the
 * token, that the service asks it, that a draft comes back **anchored to a real
 * entry**, and that the set says `deepseek` when it did.
 *
 * Four claims are worth stating because they are the ones this milestone
 * exists to make true:
 *
 *   * A set whose candidates a provider wrote records `provider: 'deepseek'`,
 *     and does **not** carry `no_generation_provider` — a set that said that
 *     while a model had written it would be a lie a client renders verbatim.
 *   * Each candidate's `tenantId`, `storeId` and `kind` come from the stored
 *     entry, never from the provider's answer, so a draft cannot point at
 *     another tenant's catalogue however the model is prompted.
 *   * A provider that fails leaves the workbench **not empty**: the
 *     deterministic engine's candidates are still there, under `provider:
 *     'none'` and the `generation_unavailable` reason.
 *   * With no provider bound at all the behaviour is exactly what it was before
 *     this milestone: engine candidates and `no_generation_provider`.
 */
describe('Retrieval generation (interface)', () => {
  describe('with a provider that delivers', () => {
    let app: INestApplication;
    /** Every request the fake was asked, so the prompt's inputs can be asserted. */
    const asked: GenerationRequest[] = [];

    beforeAll(async () => {
      const parsed = parseAppConfig({ APP_ENV: 'test' });
      if (parsed._tag !== 'ok') {
        throw new Error(`test config could not be parsed: ${parsed.error.message}`);
      }
      const fake: GenerationProvider = {
        model: 'fake-model',
        generate: (generationRequest: GenerationRequest) => {
          asked.push(generationRequest);
          // Echoes back the first entry it was given: a provider may only name
          // an entry the request supplied, so this is the one shape a real one
          // could answer with.
          const first = generationRequest.knowledge[0];
          return Promise.resolve({
            ok: true as const,
            candidates:
              first === undefined
                ? []
                : [{ sourceId: first.id, content: '亲，这款有货的，白色 M 码现货哦～' }],
          });
        },
      };

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.register(parsed.config)],
      })
        .overrideProvider(GENERATION_PROVIDER)
        .useValue(fake)
        .compile();

      app = moduleRef.createNestApplication();
      applyHttpDefaults(app, parsed.config);
      await app.init();
      attachJsonLogger(app);
    });

    afterAll(async () => {
      await app.close();
    });

    it('records a set the provider wrote, anchored to an entry the store holds', async () => {
      const response = await request(app.getHttpServer())
        .post(SUGGESTIONS_URL)
        .set('x-member-id', MEMBER)
        .send({ conversationId: CONVERSATION, query: '白色 M 现货' })
        .expect(201);

      const set = (response.body as DataEnvelope).data as SuggestSet;
      expect(set.provider).toBe('deepseek');
      expect(set.candidates).toHaveLength(1);

      const [candidate] = set.candidates;
      // The sentence is the provider's; the address is the entry's.
      expect(candidate?.['content']).toBe('亲，这款有货的，白色 M 码现货哦～');
      expect(candidate?.['tenantId']).toBe(TENANT);
      expect(candidate?.['storeId']).toBe(STORE);
      expect(typeof candidate?.['kind']).toBe('string');
      // Ranked from one, and scored zero because nothing was counted: the
      // engine's score is its own lexical measurement.
      expect(candidate?.['rank']).toBe(1);
      expect(candidate?.['score']).toBe(0);

      // A model wrote this set, so the reason that says no model exists must not
      // be on it.
      expect(set.fallbackReasons).not.toContain('no_generation_provider');

      // The provider was asked the same question the set was generated for, and
      // was offered knowledge to anchor to.
      expect(asked).toHaveLength(1);
      expect(asked[0]?.query).toBe('白色 M 现货');
      expect(asked[0]?.knowledge.length).toBeGreaterThan(0);
      expect(asked[0]?.limit).toBe(3);
      expect(candidate?.['sourceId']).toBe(asked[0]?.knowledge[0]?.id);
    });

    it('reads the anchored draft back with the provider it was stored under', async () => {
      const created = await request(app.getHttpServer())
        .post(SUGGESTIONS_URL)
        .set('x-member-id', MEMBER)
        .send({ conversationId: CONVERSATION, query: '白色 M 现货' })
        .expect(201);
      const id = ((created.body as DataEnvelope).data as SuggestSet).id;

      const fetched = await request(app.getHttpServer())
        .get(`${SUGGESTIONS_URL}/${id}`)
        .set('x-member-id', MEMBER)
        .expect(200);

      const set = (fetched.body as DataEnvelope).data as SuggestSet;
      expect(set.id).toBe(id);
      expect(set.provider).toBe('deepseek');
      expect(set.candidates[0]?.['content']).toBe('亲，这款有货的，白色 M 码现货哦～');
    });
  });

  describe('with a provider that fails', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const parsed = parseAppConfig({ APP_ENV: 'test' });
      if (parsed._tag !== 'ok') {
        throw new Error(`test config could not be parsed: ${parsed.error.message}`);
      }
      const failing: GenerationProvider = {
        model: 'fake-model',
        generate: () =>
          Promise.resolve({
            ok: false as const,
            code: 'generation_unauthorized',
            reason: 'the generation service rejected the configured key',
          }),
      };

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.register(parsed.config)],
      })
        .overrideProvider(GENERATION_PROVIDER)
        .useValue(failing)
        .compile();

      app = moduleRef.createNestApplication();
      applyHttpDefaults(app, parsed.config);
      await app.init();
      attachJsonLogger(app);
    });

    afterAll(async () => {
      await app.close();
    });

    it('falls back to the engine and says a configured provider did not deliver', async () => {
      const response = await request(app.getHttpServer())
        .post(SUGGESTIONS_URL)
        .set('x-member-id', MEMBER)
        .send({ conversationId: CONVERSATION, query: '白色 M 现货' })
        .expect(201);

      const set = (response.body as DataEnvelope).data as SuggestSet;
      expect(set.provider).toBe('none');
      // The workbench is never left empty by a provider that failed.
      expect(set.candidates.length).toBeGreaterThan(0);
      // `generation_unavailable` and not `no_generation_provider`: one is a
      // deployment that never bought this, the other is one that should look.
      expect(set.fallbackReasons).toContain('generation_unavailable');
      expect(set.fallbackReasons).not.toContain('no_generation_provider');
    });
  });

  describe('with no provider bound', () => {
    let app: INestApplication;

    beforeAll(async () => {
      // The configuration a deployment without a key has, and the one every
      // suite in this repository runs under: the factory binds nothing.
      const parsed = parseAppConfig({ APP_ENV: 'test', DEEPSEEK_API_KEY: '' });
      if (parsed._tag !== 'ok') {
        throw new Error(`test config could not be parsed: ${parsed.error.message}`);
      }
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.register(parsed.config)],
      }).compile();

      app = moduleRef.createNestApplication();
      applyHttpDefaults(app, parsed.config);
      await app.init();
      attachJsonLogger(app);
    });

    afterAll(async () => {
      await app.close();
    });

    it('keeps the pre-milestone behaviour exactly', async () => {
      const response = await request(app.getHttpServer())
        .post(SUGGESTIONS_URL)
        .set('x-member-id', MEMBER)
        .send({ conversationId: CONVERSATION, query: '白色 M 现货' })
        .expect(201);

      const set = (response.body as DataEnvelope).data as SuggestSet;
      expect(set.provider).toBe('none');
      expect(set.candidates.length).toBeGreaterThan(0);
      expect(set.fallbackReasons).toContain('no_generation_provider');
      expect(set.fallbackReasons).not.toContain('generation_unavailable');
    });
  });
});
