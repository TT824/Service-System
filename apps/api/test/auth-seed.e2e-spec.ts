import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEDED_PLATFORM_ADMIN_MEMBER_ID, parseAppConfig } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults } from '../src/configure-app';
import {
  isDatabaseReachable,
  openDatabaseClient,
  resolveDatabaseUrl,
  runDatabaseCommand,
} from './database-test-support';

/**
 * Interface tests for the seeded administrator account.
 *
 * `npm run db:seed` provisions a real sign-in credential for the console, so
 * the durable fixtures have to satisfy three things at once: the documented
 * credential actually signs in through the running application, the resulting
 * session is a platform administrator session that can read the account list,
 * and a repeated seed never rewrites the credential it wrote the first time.
 *
 * The system under test is the real Nest application wired to the durable
 * authentication adapter, fed by the same `database/scripts` entrypoints a
 * developer runs, so nothing here depends on a hand-prepared database. The
 * suite skips cleanly when no PostgreSQL is reachable.
 */
const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Documented local credential written by the seed (see README). */
const SEEDED_ADMIN = { username: 'admin', password: 'Admin123456' };

/** Fixed account identity the seed claims, mirroring `database/scripts/seed.cjs`. */
const SEEDED_ADMIN_USER_ID = 'user-platform-admin';

/** Boot the API against the durable authentication adapter. */
async function bootDurable(): Promise<INestApplication> {
  const parsed = parseAppConfig({
    ...process.env,
    APP_ENV: 'test',
    AUTH_STORAGE: 'postgres',
    DATABASE_URL: databaseUrl,
  });
  if (parsed._tag !== 'ok') {
    throw new Error(`test configuration is invalid: ${parsed.error.message}`);
  }
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(parsed.config)],
  }).compile();
  const app = moduleRef.createNestApplication();
  applyHttpDefaults(app, parsed.config);
  await app.init();
  return app;
}

describe.skipIf(!reachable)('Seeded administrator account (PostgreSQL)', () => {
  let app: INestApplication;
  /** Sessions this suite issued, removed again in {@link afterAll}. */
  const issuedSessions: string[] = [];

  beforeAll(async () => {
    // Both commands are idempotent, so they are safe on a developer database.
    runDatabaseCommand('migrate', databaseUrl);
    runDatabaseCommand('seed', databaseUrl);
    app = await bootDurable();
  });

  afterAll(async () => {
    if (issuedSessions.length > 0) {
      const client = await openDatabaseClient(databaseUrl);
      try {
        await client.query('DELETE FROM auth_sessions WHERE id = ANY($1::text[])', [
          issuedSessions,
        ]);
      } finally {
        await client.end();
      }
    }
    if (app !== undefined) {
      await app.close();
    }
  });

  /** The supertest agent bound to the running application. */
  function api(): ReturnType<typeof request> {
    return request(app.getHttpServer());
  }

  it('runs against a reachable database', () => {
    // Reported explicitly so a skipped run is never mistaken for a passing one.
    expect(reachable).toBe(true);
  });

  it('signs in with the documented credential through the real application', async () => {
    const response = await api()
      .post('/api/v1/auth/login/password')
      .send({ username: SEEDED_ADMIN.username, password: SEEDED_ADMIN.password });

    expect(response.status).toBe(200);
    const sessionId = response.body.data.session.id as string;
    issuedSessions.push(sessionId);

    const access = response.body.data.access;
    // The seed's whole point: the account reaches tenant business data, and it
    // does so as a platform principal acting through the platform member.
    expect(access.accessState).toBe('active');
    expect(access.role).toBe('platform_admin');
    expect(access.member.id).toBe(SEEDED_PLATFORM_ADMIN_MEMBER_ID);
    expect(access.tenantId).toBeNull();
    expect(typeof response.body.data.token).toBe('string');
  });

  it('reads the account list as the seeded platform administrator', async () => {
    const signedIn = await api()
      .post('/api/v1/auth/login/password')
      .send({ username: SEEDED_ADMIN.username, password: SEEDED_ADMIN.password });
    expect(signedIn.status).toBe(200);
    const token = signedIn.body.data.token as string;
    issuedSessions.push(signedIn.body.data.session.id as string);

    const response = await api()
      .get('/api/v1/admin/accounts')
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    const rows = response.body.data as ReadonlyArray<Record<string, unknown>>;
    const admin = rows.find((row) => row.id === SEEDED_ADMIN_USER_ID);
    expect(admin).toBeDefined();
    expect(admin?.username).toBe(SEEDED_ADMIN.username);
    expect(admin?.accessState).toBe('active');
    expect(admin?.memberId).toBe(SEEDED_PLATFORM_ADMIN_MEMBER_ID);
    expect(admin?.tenantId).toBeNull();
    expect(admin?.passwordConfigured).toBe(true);
    // No response surface may carry credential material.
    expect(JSON.stringify(rows)).not.toContain('scrypt$');
  });

  it('leaves the credential it wrote untouched when the seed runs again', async () => {
    const client: Client = await openDatabaseClient(databaseUrl);
    try {
      const before = await client.query(
        'SELECT password_hash, password_updated_at FROM user_accounts WHERE id = $1',
        [SEEDED_ADMIN_USER_ID],
      );
      expect(before.rowCount).toBe(1);

      runDatabaseCommand('seed', databaseUrl);

      const after = await client.query(
        'SELECT password_hash, password_updated_at FROM user_accounts WHERE id = $1',
        [SEEDED_ADMIN_USER_ID],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);

      const counts = await client.query(
        `SELECT
           (SELECT count(*) FROM user_accounts WHERE lower(username) = $1)::int AS accounts,
           (SELECT count(*) FROM user_accounts WHERE id = $2)::int AS accounts_by_id,
           (SELECT count(*) FROM user_identities
              WHERE provider = 'password' AND lower(subject) = $1)::int AS password_identities,
           (SELECT count(*) FROM member_user_links
              WHERE member_id = $3 AND revoked_at IS NULL)::int AS active_member_links`,
        [SEEDED_ADMIN.username, SEEDED_ADMIN_USER_ID, SEEDED_PLATFORM_ADMIN_MEMBER_ID],
      );
      expect(counts.rows[0]).toEqual({
        accounts: 1,
        accounts_by_id: 1,
        password_identities: 1,
        active_member_links: 1,
      });
    } finally {
      await client.end();
    }
  });
});
