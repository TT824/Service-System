import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';

type DataEnvelope = { request_id: string; data: unknown; meta: Record<string, never> };
type ErrorEnvelope = { request_id: string; code: string; message: string; details: unknown[] };

/**
 * Interface tests for personal quick phrases.
 *
 * The subject of these tests is not the CRUD but the isolation: a personal
 * phrase belongs to one member, so the assertions that matter are the ones
 * about who cannot see it. Every read and write below is driven as a different
 * seat of the same tenant — two agents and the administrator — plus one agent
 * of another tenant, because "yours" has to be narrower than "your tenant's"
 * and the administrator has to be no exception.
 *
 * The in-process store answers here. The durable adapter's half of the same
 * contract (the member id in the WHERE clause) is covered by
 * `platform-postgres.integration.spec.ts`.
 */
describe('Personal quick phrases (interface)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test' });
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
    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  /**
   * Requests acting as one member of the seeded demo directory.
   *
   * The header is set after the method, which is the only order supertest
   * accepts: a bare `request(server)` has no `.set` of its own.
   */
  const as = (memberId: string) => {
    const agent = () => request(app.getHttpServer());
    const header = { 'x-member-id': memberId };
    return {
      get: (path: string) => agent().get(path).set(header),
      post: (path: string) => agent().post(path).set(header),
      patch: (path: string) => agent().patch(path).set(header),
    };
  };

  /** Create a phrase as one member and answer the stored row. */
  async function createPhrase(
    memberId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await as(memberId).post('/api/v1/personal-phrases').send(body).expect(201);
    return (response.body as DataEnvelope).data as Record<string, unknown>;
  }

  /** The phrase list one member sees. */
  async function listPhrases(memberId: string): Promise<ReadonlyArray<Record<string, unknown>>> {
    const response = await as(memberId).get('/api/v1/personal-phrases').expect(200);
    return (response.body as DataEnvelope).data as ReadonlyArray<Record<string, unknown>>;
  }

  it('shows a phrase to its author alone — not to a colleague, not to the administrator, not to another tenant', async () => {
    const mine = await createPhrase('u-t1-agent-1', {
      title: '欢迎咨询',
      text: '您好，请问想了解哪款商品？',
      category: '售前',
      keywords: ['欢迎', '咨询'],
    });
    expect(mine).toMatchObject({
      tenantId: 'tenant-acme',
      memberId: 'u-t1-agent-1',
      title: '欢迎咨询',
      category: '售前',
      keywords: ['欢迎', '咨询'],
      enabled: true,
    });

    const own = await listPhrases('u-t1-agent-1');
    expect(own.map((phrase) => phrase['id'])).toContain(mine['id']);

    // The colleague shares the tenant, the store and the queue — and not this.
    expect(await listPhrases('u-t1-agent-2')).toEqual([]);
    // Knowledge writes belong to the administrator; a personal phrase does not.
    expect(await listPhrases('u-t1-admin')).toEqual([]);
    // Nor is the tenant boundary the only one that holds.
    expect(await listPhrases('u-t2-agent-1')).toEqual([]);
  });

  it('answers 404 rather than 403 for somebody else’s id, and changes nothing when it does', async () => {
    const mine = await createPhrase('u-t1-agent-1', {
      title: '只给我自己看',
      text: '这条不该被别人读到。',
    });
    const id = String(mine['id']);

    for (const memberId of ['u-t1-agent-2', 'u-t1-admin', 'u-t2-agent-1']) {
      const read = await as(memberId).get(`/api/v1/personal-phrases/${id}`).expect(404);
      expect((read.body as ErrorEnvelope).code).toBe('not_found');
      // A distinguishable "not yours" would confirm that the id names a phrase;
      // both cases answer the same, so the response cannot be used to probe.
      const write = await as(memberId)
        .patch(`/api/v1/personal-phrases/${id}`)
        .send({ title: '改掉', enabled: false })
        .expect(404);
      expect((write.body as ErrorEnvelope).code).toBe('not_found');
    }

    const after = await as('u-t1-agent-1').get(`/api/v1/personal-phrases/${id}`).expect(200);
    expect((after.body as DataEnvelope).data).toMatchObject({
      title: '只给我自己看',
      enabled: true,
    });
  });

  it('edits only the fields a patch names, lists newest first, and retires a phrase instead of deleting it', async () => {
    const older = await createPhrase('u-t1-agent-2', {
      title: '第一条',
      text: '内容一',
      keywords: ['甲'],
    });
    // The list order is by creation instant; let the clock move so the two rows
    // are ordered by it rather than by the id tie-break.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await createPhrase('u-t1-agent-2', { title: '第二条', text: '内容二' });

    const listed = await listPhrases('u-t1-agent-2');
    expect(listed.map((phrase) => phrase['id'])).toEqual([newer['id'], older['id']]);
    // No keywords sent means none stored, not a missing field.
    expect(newer['keywords']).toEqual([]);

    const patched = await as('u-t1-agent-2')
      .patch(`/api/v1/personal-phrases/${String(older['id'])}`)
      .send({ title: '改名了', enabled: false })
      .expect(200);
    expect((patched.body as DataEnvelope).data).toMatchObject({
      title: '改名了',
      // Untouched fields survive: `enabled:false` did not clear the words.
      keywords: ['甲'],
      text: '内容一',
      enabled: false,
    });

    // Retired, still the author's to bring back — there is no delete.
    const still = await as('u-t1-agent-2')
      .get(`/api/v1/personal-phrases/${String(older['id'])}`)
      .expect(200);
    expect((still.body as DataEnvelope).data).toMatchObject({ enabled: false });

    // And an empty array is a value: it clears the words rather than keeping them.
    const cleared = await as('u-t1-agent-2')
      .patch(`/api/v1/personal-phrases/${String(older['id'])}`)
      .send({ keywords: [] })
      .expect(200);
    expect((cleared.body as DataEnvelope).data).toMatchObject({ keywords: [], title: '改名了' });
  });

  it('refuses a body it cannot use', async () => {
    const untitled = await as('u-t1-agent-1')
      .post('/api/v1/personal-phrases')
      .send({ text: '只有正文' })
      .expect(400);
    expect((untitled.body as ErrorEnvelope).code).toBe('bad_request');

    const emptyPatch = await as('u-t1-agent-1')
      .patch('/api/v1/personal-phrases/personal-phrase-1')
      .send({})
      .expect(400);
    expect((emptyPatch.body as ErrorEnvelope).code).toBe('bad_request');

    // The form's `maxlength` is the contract; the server refuses the same length.
    const tooLong = await as('u-t1-agent-1')
      .post('/api/v1/personal-phrases')
      .send({ title: '标'.repeat(61), text: '正文' })
      .expect(400);
    expect((tooLong.body as ErrorEnvelope).code).toBe('bad_request');

    const wrongType = await as('u-t1-agent-1')
      .post('/api/v1/personal-phrases')
      .send({ title: '标题', text: '正文', keywords: '欢迎' })
      .expect(400);
    expect((wrongType.body as ErrorEnvelope).code).toBe('bad_request');
  });
});
