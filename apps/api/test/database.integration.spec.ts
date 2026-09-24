import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  isDatabaseReachable,
  openDatabaseClient,
  readMigration,
  resolveDatabaseUrl,
  runDatabaseCommand,
} from './database-test-support';

/**
 * Database integration tests for the durable authentication foundation.
 *
 * Unlike the interface tests, these run against a real PostgreSQL instance and
 * assert the facts the migrations promise: the tables exist, the ledger reports
 * nothing pending, tenant/member/store integrity is structural, only hashed
 * credential material is accepted, the seed is idempotent and the down
 * migrations revert in dependency order.
 *
 * The suite skips itself when no database is reachable so it cannot turn a
 * machine without infrastructure into a red build; when it does run it drives
 * the real `database/scripts` entrypoints rather than duplicating their logic.
 *
 * Nothing here writes outside a transaction that is rolled back, so a run
 * leaves the database exactly as it found it.
 */

/** Tables the authentication migrations declare, in dependency order. */
const AUTH_TABLES = [
  'user_accounts',
  'user_identities',
  'member_user_links',
  'member_store_scopes',
  'otp_challenges',
  'trusted_devices',
  'auth_sessions',
] as const;

/** Constraints that make tenant/member/store integrity structural. */
const COMPOSITE_CONSTRAINTS = [
  'stores_tenant_id_id_key',
  'members_tenant_id_id_key',
  'member_store_scopes_tenant_id_member_id_fkey',
  'member_store_scopes_tenant_id_store_id_fkey',
  'member_user_links_tenant_id_member_id_fkey',
] as const;

/**
 * The member role/tenant invariant added by `0005`.
 *
 * Migration `0002` only required a tenant for non-platform roles, which let a
 * `platform_admin` row keep a tenant — a member that would resolve to a
 * platform role *and* a tenant context. `0005` makes the rule exact.
 */
const PLATFORM_ADMIN_TENANT_CONSTRAINT = 'members_platform_admin_tenant_check';

/** Seeded fixtures the in-process store also seeds; the durable copy must match. */
const SEEDED_TENANT_ID = 'tenant-acme';
const SEEDED_STORE_ID = 'store-acme-flagship';
const SEEDED_AGENT_ID = 'u-t1-agent-1';
const OTHER_TENANT_STORE_ID = 'store-beta-official';

/** A hash-shaped value; tests never store or assert on real credential material. */
const FINGERPRINT = 'f'.repeat(64);
const SHORT_FINGERPRINT = 'too-short-to-be-a-hash';

const databaseUrl = resolveDatabaseUrl();
const databaseReachable = isDatabaseReachable(databaseUrl);

if (!databaseReachable) {
  console.warn(
    'database integration tests skipped: no PostgreSQL answered at the configured DATABASE_URL',
  );
}

/** Run `body` inside a transaction that is always rolled back. */
async function withRolledBackTransaction(body: (client: Client) => Promise<void>): Promise<void> {
  const client = await openDatabaseClient(databaseUrl);
  try {
    await client.query('BEGIN');
    try {
      await body(client);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Assert PostgreSQL rejected `sql`, then recover the transaction. */
async function expectRejected(client: Client, sql: string, params: unknown[]): Promise<void> {
  await client.query('SAVEPOINT probe');
  await expect(client.query(sql, params)).rejects.toMatchObject({
    code: expect.stringMatching(/^23/),
  });
  await client.query('ROLLBACK TO SAVEPOINT probe');
}

async function tableExists(client: Client, table: string): Promise<boolean> {
  const result = await client.query<{ name: string | null }>(
    'SELECT to_regclass($1)::text AS name',
    [table],
  );
  return result.rows[0]?.name !== null && result.rows[0] !== undefined;
}

describe.skipIf(!databaseReachable)('durable authentication foundation (live PostgreSQL)', () => {
  // Bring the database to the state every assertion below assumes. Both
  // commands are idempotent, so a developer's already-migrated database is
  // left untouched.
  beforeAll(() => {
    runDatabaseCommand('migrate', databaseUrl);
    runDatabaseCommand('seed', databaseUrl);
  }, 120_000);

  it('reports a fully migrated schema with no pending work', () => {
    expect(runDatabaseCommand('status', databaseUrl)).toContain('0 pending');
    expect(runDatabaseCommand('check', databaseUrl)).toContain('schema smoke check passed');
  }, 60_000);

  it('exposes the authentication tables and their tenant-scoped constraints', async () => {
    await withRolledBackTransaction(async (client) => {
      for (const table of AUTH_TABLES) {
        expect(await tableExists(client, table), `missing table ${table}`).toBe(true);
      }
      const constraints = await client.query<{ conname: string }>(
        'SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])',
        [COMPOSITE_CONSTRAINTS],
      );
      expect(constraints.rows.map((row) => row.conname).sort()).toEqual(
        [...COMPOSITE_CONSTRAINTS].sort(),
      );
    });
  }, 60_000);

  it('rejects a platform administrator that belongs to a tenant', async () => {
    await withRolledBackTransaction(async (client) => {
      const constraint = await client.query<{ conname: string }>(
        'SELECT conname FROM pg_constraint WHERE conname = $1',
        [PLATFORM_ADMIN_TENANT_CONSTRAINT],
      );
      expect(constraint.rows.map((row) => row.conname)).toEqual([PLATFORM_ADMIN_TENANT_CONSTRAINT]);

      // A platform administrator with a tenant is exactly the row that used to
      // let a merchant administrator mint platform authority.
      await expectRejected(
        client,
        `INSERT INTO members (id, tenant_id, role, username, display_name, created_at)
         VALUES ('m-rogue-scoped-admin', $1, 'platform_admin', 'rogue-admin', '越权管理员', now())`,
        [SEEDED_TENANT_ID],
      );

      // A platform-level platform administrator is still valid...
      const platformAdmin = await client.query(
        `INSERT INTO members (id, tenant_id, role, username, display_name, created_at)
         VALUES ('m-integration-platform-admin', NULL, 'platform_admin', 'integration-root', '集成平台管理员', now())`,
      );
      expect(platformAdmin.rowCount).toBe(1);

      // ...and so is a tenant member with a tenant...
      const tenantMember = await client.query(
        `INSERT INTO members (id, tenant_id, role, username, display_name, created_at)
         VALUES ('m-integration-tenant-admin', $1, 'merchant_admin', 'integration-tenant-admin', '集成租户管理员', now())`,
        [SEEDED_TENANT_ID],
      );
      expect(tenantMember.rowCount).toBe(1);

      // ...while a non-platform member without one is not: the invariant holds
      // in both directions.
      await expectRejected(
        client,
        `INSERT INTO members (id, tenant_id, role, username, display_name, created_at)
         VALUES ('m-tenantless-admin', NULL, 'merchant_admin', 'tenantless-admin', '无租户管理员', now())`,
        [],
      );
    });
  }, 60_000);

  it('reverts and reapplies the platform administrator invariant', async () => {
    await withRolledBackTransaction(async (client) => {
      const constraintNames = async (): Promise<ReadonlyArray<string>> => {
        const result = await client.query<{ conname: string }>(
          'SELECT conname FROM pg_constraint WHERE conname = $1',
          [PLATFORM_ADMIN_TENANT_CONSTRAINT],
        );
        return result.rows.map((row) => row.conname);
      };

      expect(await constraintNames()).toEqual([PLATFORM_ADMIN_TENANT_CONSTRAINT]);

      // The down migration restores the constraint 0002 declared: a
      // tenant-scoped platform administrator is accepted again.
      await client.query(readMigration('0005_platform_admin_member_invariant.down.sql'));
      expect(await constraintNames()).toEqual([]);
      const legacy = await client.query(
        `INSERT INTO members (id, tenant_id, role, username, display_name, created_at)
         VALUES ('m-legacy-scoped-admin', $1, 'platform_admin', 'legacy-admin', '历史越权管理员', now())`,
        [SEEDED_TENANT_ID],
      );
      expect(legacy.rowCount).toBe(1);

      // Re-applying 0005 restores the strict rule. A database that still holds
      // such a row fails the migration loudly rather than silently keeping the
      // weak rule, so the row is removed first.
      await client.query(`DELETE FROM members WHERE id = 'm-legacy-scoped-admin'`);
      await client.query(readMigration('0005_platform_admin_member_invariant.up.sql'));
      expect(await constraintNames()).toEqual([PLATFORM_ADMIN_TENANT_CONSTRAINT]);
      await expectRejected(
        client,
        `INSERT INTO members (id, tenant_id, role, username, display_name, created_at)
         VALUES ('m-rogue-scoped-admin-2', $1, 'platform_admin', 'rogue-admin-2', '越权管理员', now())`,
        [SEEDED_TENANT_ID],
      );
    });
  }, 90_000);

  it('rejects a member store scope built from another tenant', async () => {
    await withRolledBackTransaction(async (client) => {
      await expectRejected(
        client,
        `INSERT INTO member_store_scopes
           (tenant_id, member_id, store_id, is_primary, granted_at, created_at, updated_at)
         VALUES ('tenant-acme', $1, $2, FALSE, now(), now(), now())`,
        [SEEDED_AGENT_ID, OTHER_TENANT_STORE_ID],
      );
    });
  }, 60_000);

  it('accepts a member store scope that stays inside its tenant', async () => {
    await withRolledBackTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO member_store_scopes
           (tenant_id, member_id, store_id, is_primary, granted_at, created_at, updated_at)
         VALUES ('tenant-acme', $1, 'store-acme-distribution', FALSE, now(), now(), now())`,
        [SEEDED_AGENT_ID],
      );
      expect(inserted.rowCount).toBe(1);
    });
  }, 60_000);

  it('accepts only hashed credential material and consistent session facts', async () => {
    await withRolledBackTransaction(async (client) => {
      await client.query(
        `INSERT INTO user_accounts (id, username, display_name, password_hash, created_at, updated_at)
         VALUES ('u-integration', 'integration-user', '集成测试账号', $1, now(), now())`,
        [FINGERPRINT],
      );

      // A raw password is not hash-shaped and must be refused.
      await expectRejected(
        client,
        `INSERT INTO user_accounts (id, username, display_name, password_hash, created_at, updated_at)
         VALUES ('u-raw', 'integration-raw', '原始口令账号', 'hunter2', now(), now())`,
        [],
      );
      // Usernames are unique regardless of case.
      await expectRejected(
        client,
        `INSERT INTO user_accounts (id, username, display_name, created_at, updated_at)
         VALUES ('u-case', 'INTEGRATION-USER', '大小写重名', now(), now())`,
        [],
      );
      // A stored token is a fingerprint, never a short literal.
      await expectRejected(
        client,
        `INSERT INTO auth_sessions
           (id, user_id, token_fingerprint, rotation_family_id, auth_method, issued_at, expires_at, last_seen_at, created_at, updated_at)
         VALUES ('s-short', 'u-integration', $1, 'family-1', 'password', now(), now() + interval '1 hour', now(), now(), now())`,
        [SHORT_FINGERPRINT],
      );
      // The same token can never belong to two sessions.
      await client.query(
        `INSERT INTO auth_sessions
           (id, user_id, token_fingerprint, rotation_family_id, auth_method, issued_at, expires_at, last_seen_at, created_at, updated_at)
         VALUES ('s-1', 'u-integration', $1, 'family-1', 'password', now(), now() + interval '1 hour', now(), now(), now())`,
        [FINGERPRINT],
      );
      await expectRejected(
        client,
        `INSERT INTO auth_sessions
           (id, user_id, token_fingerprint, rotation_family_id, auth_method, issued_at, expires_at, last_seen_at, created_at, updated_at)
         VALUES ('s-2', 'u-integration', $1, 'family-1', 'password', now(), now() + interval '1 hour', now(), now(), now())`,
        [FINGERPRINT],
      );
      // A revoked session must record when it was revoked.
      await expectRejected(
        client,
        `INSERT INTO auth_sessions
           (id, user_id, token_fingerprint, rotation_family_id, auth_method, status, issued_at, expires_at, last_seen_at, created_at, updated_at)
         VALUES ('s-3', 'u-integration', $1, 'family-1', 'otp', 'revoked', now(), now() + interval '1 hour', now(), now(), now())`,
        ['a'.repeat(64)],
      );
    });
  }, 60_000);

  it('keeps the seed idempotent and preserves the seeded fixtures', async () => {
    const second = runDatabaseCommand('seed', databaseUrl);
    expect(second).toContain('0 inserted');

    // The seed reports what it wrote; it must never echo the connection secret.
    const { password } = new URL(databaseUrl);
    if (password.length > 0) {
      expect(second).not.toContain(password);
    }

    await withRolledBackTransaction(async (client) => {
      const counts = await client.query<{ tenant: string; store: string; member: string }>(
        `SELECT (SELECT count(*) FROM tenants WHERE id = $1) AS tenant,
                (SELECT count(*) FROM stores WHERE id = $2) AS store,
                (SELECT count(*) FROM members WHERE id = $3) AS member`,
        [SEEDED_TENANT_ID, SEEDED_STORE_ID, SEEDED_AGENT_ID],
      );
      expect(counts.rows[0]).toEqual({ tenant: '1', store: '1', member: '1' });

      const scope = await client.query<{
        tenant_id: string;
        store_id: string;
        is_primary: boolean;
      }>(`SELECT tenant_id, store_id, is_primary FROM member_store_scopes WHERE member_id = $1`, [
        SEEDED_AGENT_ID,
      ]);
      expect(scope.rows).toContainEqual({
        tenant_id: SEEDED_TENANT_ID,
        store_id: SEEDED_STORE_ID,
        is_primary: true,
      });
    });
  }, 90_000);

  it('reverts and reapplies the authentication migrations in dependency order', async () => {
    await withRolledBackTransaction(async (client) => {
      for (const table of AUTH_TABLES) {
        expect(await tableExists(client, table)).toBe(true);
      }

      // Down files must run newest-first, and must leave nothing behind.
      await client.query(readMigration('0004_auth_sessions.down.sql'));
      await client.query(readMigration('0003_auth_identity.down.sql'));
      for (const table of AUTH_TABLES) {
        expect(await tableExists(client, table), `table ${table} survived the revert`).toBe(false);
      }

      // Up files must be repeatable: re-applying restores the same shape.
      await client.query(readMigration('0003_auth_identity.up.sql'));
      await client.query(readMigration('0004_auth_sessions.up.sql'));
      for (const table of AUTH_TABLES) {
        expect(await tableExists(client, table), `table ${table} was not restored`).toBe(true);
      }
    });
  }, 90_000);
});
