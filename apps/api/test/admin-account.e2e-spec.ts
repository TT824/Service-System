import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig, SEEDED_PLATFORM_ADMIN_MEMBER_ID } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults } from '../src/configure-app';

const TENANT = 'tenant-acme';
const STORE = 'store-acme-flagship';
const API = '/api/v1';

/** Password of the accounts this suite creates. */
const PASSWORD = 'seat-made-by-an-administrator';

type DataEnvelope = { readonly data: unknown };
type ErrorEnvelope = { readonly code: string };
/** One in-flight supertest request, as `request(app).post(path)` returns it. */
type ApiRequest = ReturnType<ReturnType<typeof request>['post']>;

/**
 * Interface tests for the account-creation half of the self-use refactor.
 *
 * Registration used to be the only way an account could come into existence, so
 * closing it without this endpoint would have left the platform unable to put a
 * customer-service agent on duty at all. These tests walk the whole path an
 * administrator takes — make a seat, make an account, bind the two — and finish
 * by signing in as the agent over HTTP, which is the only assertion that proves
 * the credential written is a working one.
 *
 * The in-memory boundary is used (the `test` boundary), so the suite runs
 * without PostgreSQL; the durable adapter is covered by the PostgreSQL
 * integration suites.
 */
describe('Administrator-created accounts (interface)', () => {
  let app: INestApplication;
  /** Distinguishes the rows of each test, so no username collides across them. */
  let sequence = 0;

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
  });

  afterAll(async () => {
    await app.close();
  });

  /** A POST acting as the seeded platform administrator. */
  function adminPost(path: string): ApiRequest {
    return request(app.getHttpServer())
      .post(path)
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID);
  }

  it('walks a new seat from account creation to a working sign-in', async () => {
    sequence += 1;
    const suffix = String(sequence);
    const username = `seat-${suffix}`;

    const member = await adminPost(`${API}/admin/members`).send({
      tenant_id: TENANT,
      store_id: STORE,
      role: 'agent',
      username: `member-${suffix}`,
      display_name: `新坐席${suffix}`,
    });
    expect(member.status).toBe(201);
    const memberId = (member.body as DataEnvelope).data as { id: string };

    const created = await adminPost(`${API}/admin/accounts`).send({
      username,
      display_name: `新坐席${suffix}`,
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
    const account = (created.body as DataEnvelope).data as {
      id: string;
      username: string;
      accessState: string;
      memberId: string | null;
      passwordConfigured: boolean;
    };
    expect(account).toMatchObject({
      username,
      passwordConfigured: true,
      memberId: null,
      // Unlinked on purpose: which member this account acts as is the next
      // request's decision, not the creation's.
      accessState: 'pending_config',
    });
    // The response is a projection; no encoded credential travels in it.
    expect(JSON.stringify(created.body)).not.toContain('scrypt$');

    // The account exists and the password works before it is bound to anything.
    const beforeLink = await request(app.getHttpServer())
      .post(`${API}/auth/login/password`)
      .send({ username, password: PASSWORD });
    expect(beforeLink.status).toBe(200);
    const pendingToken = (beforeLink.body as DataEnvelope).data as { token: string };
    const pendingSession = await request(app.getHttpServer())
      .get(`${API}/auth/session`)
      .set('authorization', `Bearer ${pendingToken.token}`);
    expect(pendingSession.status).toBe(200);
    expect(
      ((pendingSession.body as DataEnvelope).data as { access: { accessState: string } }).access,
    ).toMatchObject({ accessState: 'pending_config' });

    const linked = await adminPost(`${API}/admin/members/${memberId.id}/link`).send({
      user_id: account.id,
    });
    expect(linked.status).toBe(200);

    // The same credential now reaches the tenant the seat belongs to.
    const signIn = await request(app.getHttpServer())
      .post(`${API}/auth/login/password`)
      .send({ username, password: PASSWORD });
    expect(signIn.status).toBe(200);
    const token = ((signIn.body as DataEnvelope).data as { token: string }).token;
    const session = await request(app.getHttpServer())
      .get(`${API}/auth/session`)
      .set('authorization', `Bearer ${token}`);
    expect(session.status).toBe(200);
    const access = (
      (session.body as DataEnvelope).data as {
        access: { role: string; tenantId: string | null; accessState: string };
      }
    ).access;
    expect(access).toMatchObject({ role: 'agent', tenantId: TENANT, accessState: 'active' });
  });

  it('refuses a username that is already taken', async () => {
    sequence += 1;
    const username = `seat-dupe-${sequence}`;
    const body = { username, display_name: '重复账号', password: PASSWORD };

    expect((await adminPost(`${API}/admin/accounts`).send(body)).status).toBe(201);
    const again = await adminPost(`${API}/admin/accounts`).send(body);
    expect(again.status).toBe(409);
    expect((again.body as ErrorEnvelope).code).toBe('conflict');
  });

  it('holds an administrator-created password to the same policy as registration', async () => {
    sequence += 1;
    const weak = await adminPost(`${API}/admin/accounts`).send({
      username: `seat-weak-${sequence}`,
      display_name: '弱口令',
      password: 'short',
    });
    expect(weak.status).toBe(400);
    expect((weak.body as ErrorEnvelope).code).toBe('bad_request');
  });

  it('refuses callers who are not platform administrators', async () => {
    sequence += 1;
    const body = {
      username: `seat-forbidden-${sequence}`,
      display_name: '越权创建',
      password: PASSWORD,
    };

    // A tenant administrator, and an agent, both reach the route and are refused
    // by the domain service rather than by the route itself.
    for (const member of ['u-t1-admin', 'u-t1-agent-1']) {
      const denied = await request(app.getHttpServer())
        .post(`${API}/admin/accounts`)
        .set('x-member-id', member)
        .send(body);
      expect(denied.status).toBe(403);
      expect((denied.body as ErrorEnvelope).code).toBe('forbidden');
    }
  });
});
