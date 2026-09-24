import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAppConfig, WECOM_AES_KEY_LENGTH, type AppConfig } from '@kefu/core';
import { DatabaseService } from '../src/database/database.service';
import { PostgresWecomCredentialRepository } from '../src/channels/postgres-wecom-credential.repository';
import { resolveWecomCredentialMode } from '../src/channels/wecom-credential.repository';
import {
  isDatabaseReachable,
  resolveDatabaseUrl,
  runDatabaseCommand,
} from './database-test-support';

/**
 * Integration tests for the durable WeCom credentials.
 *
 * These exercise {@link PostgresWecomCredentialRepository} against the real
 * PostgreSQL the platform targets — the table and constraint migration `0017`
 * declares — rather than only against the in-process adapter the unit tests use.
 * They prove what the in-process store *cannot*: that a credential set is
 * refused for a binding whose store belongs to another tenant (the one guard
 * that needs the `stores` table, and the reason 连接 cannot report success on a
 * scope the transport would never pick up), that switching a credentialed
 * account off takes its credentials out of the connection and switching it back
 * on restores them, and that deleting a binding takes its credentials with it.
 *
 * The suite skips cleanly when no database is reachable, so `npm test` passes on
 * a machine without PostgreSQL; a run that actually executed reports so through
 * the test names. Every row it writes carries a per-run unique identifier and is
 * removed again in `afterAll`, so it never depends on — or disturbs — another
 * run's rows.
 */
const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Unique suffix isolating this run's rows from every other run's. */
const RUN = randomUUID().slice(0, 8);

describe.skipIf(!reachable)('WeCom credentials (PostgreSQL)', () => {
  let config: AppConfig;
  let database: DatabaseService;
  let pool: Pool;
  let repository: PostgresWecomCredentialRepository;

  const tenantId = `tenant-wc-${RUN}`;
  const storeId = `store-wc-${RUN}`;
  /** A second tenant, so a cross-tenant store can be built without touching one. */
  const otherTenantId = `tenant-wc-other-${RUN}`;
  const otherStoreId = `store-wc-other-${RUN}`;

  /** The provider account every binding in this run is about. */
  const corpId = `ww-wc-${RUN}`;
  const openKfId = `wkWC${RUN}`;

  /** One provider account per test, so the partial unique index never collides. */
  let account = 0;
  function nextAccount(): string {
    account += 1;
    return `${openKfId}-${account}`;
  }

  /** The five values an operator would type, all of them usable. */
  const values = {
    corpId,
    kfSecret: 'kf-secret-from-console',
    callbackToken: 'callback-token-from-console',
    aesKey: 'k'.repeat(WECOM_AES_KEY_LENGTH),
    openKfId,
  };

  /** Insert one binding and return its id. */
  async function seedBinding(input: {
    readonly tenant: string;
    readonly store: string;
    readonly openKfId: string;
    readonly status?: 'active' | 'disabled';
  }): Promise<string> {
    const id = `binding-wc-${RUN}-${randomUUID().slice(0, 8)}`;
    const at = now();
    await pool.query(
      `INSERT INTO wecom_channel_bindings
         (id, tenant_id, store_id, corp_id, open_kfid, status, created_at, updated_at, disabled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
      [
        id,
        input.tenant,
        input.store,
        corpId,
        input.openKfId,
        input.status ?? 'active',
        at,
        input.status === 'disabled' ? at : null,
      ],
    );
    return id;
  }

  /** Write the typed values onto one binding. */
  function save(bindingId: string, overrides: Partial<typeof values> = {}) {
    return repository.saveCredentials({
      tenantId,
      bindingId,
      values: { ...values, ...overrides },
      now: now(),
      updatedBy: null,
    });
  }

  beforeAll(async () => {
    const parsed = parseAppConfig({ ...process.env, APP_ENV: 'test' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    config = parsed.config;
    // Idempotent: the migrations may already be applied on a developer machine.
    runDatabaseCommand('migrate', databaseUrl);
    database = new DatabaseService(config);
    pool = database.pool;
    repository = new PostgresWecomCredentialRepository(database);
    await seedDirectory();
  });

  beforeEach(async () => {
    // 「Exactly one credentialed account」 is what the read is about, so each
    // test starts from no credentials of this run's own. Scoped to this run's
    // bindings, so a parallel suite's rows are never touched.
    await pool.query(
      `DELETE FROM wecom_channel_credentials
        WHERE binding_id IN (SELECT id FROM wecom_channel_bindings WHERE tenant_id = ANY($1))`,
      [[tenantId, otherTenantId]],
    );
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await cleanup();
      await database.onModuleDestroy();
    }
  });

  /** Two tenants, each with a store, so cross-tenant isolation is testable. */
  async function seedDirectory(): Promise<void> {
    const at = now();
    for (const [id, code, name] of [
      [tenantId, `wc-${RUN}`, '企业微信凭证集成测试租户'],
      [otherTenantId, `wc-other-${RUN}`, '企业微信凭证集成测试另一租户'],
    ] as ReadonlyArray<readonly [string, string, string]>) {
      await pool.query(
        'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
        [id, code, name, at],
      );
    }
    for (const [id, tenant] of [
      [storeId, tenantId],
      [otherStoreId, otherTenantId],
    ] as ReadonlyArray<readonly [string, string]>) {
      await pool.query(
        'INSERT INTO stores (id, tenant_id, code, name, enabled, created_at) VALUES ($1, $2, $3, $4, TRUE, $5)',
        [id, tenant, 'main', '企业微信凭证集成测试门店', at],
      );
    }
  }

  /** Remove everything this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    // Credentials go with their bindings through migration `0017`'s cascade; the
    // delete is explicit anyway so a broken cascade fails here rather than
    // leaving rows behind.
    await pool.query(
      `DELETE FROM wecom_channel_credentials
        WHERE binding_id IN (SELECT id FROM wecom_channel_bindings WHERE tenant_id = ANY($1))`,
      [[tenantId, otherTenantId]],
    );
    await pool.query('DELETE FROM wecom_channel_bindings WHERE tenant_id = ANY($1)', [
      [tenantId, otherTenantId],
    ]);
    await pool.query('DELETE FROM stores WHERE tenant_id = ANY($1)', [[tenantId, otherTenantId]]);
    await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [[tenantId, otherTenantId]]);
  }

  it('runs against a reachable database', () => {
    // Reported explicitly so a skipped run is never mistaken for a passing one.
    expect(reachable).toBe(true);
  });

  it('selects the durable adapter for local and production only', () => {
    expect(resolveWecomCredentialMode('test')).toBe('memory');
    expect(resolveWecomCredentialMode('local')).toBe('postgres');
    expect(resolveWecomCredentialMode('production')).toBe('postgres');
  });

  it('stores a set and reads it back joined to its binding', async () => {
    const kfId = nextAccount();
    const bindingId = await seedBinding({ tenant: tenantId, store: storeId, openKfId: kfId });

    expect(await save(bindingId, { openKfId: kfId })).toBe(true);

    expect(await repository.readCurrentCredentials()).toEqual({
      bindingId,
      tenantId,
      storeId,
      corpId,
      openKfId: kfId,
      kfSecret: values.kfSecret,
      callbackToken: values.callbackToken,
      aesKey: values.aesKey,
      verifiedAt: null,
      verifiedError: null,
      updatedAt: expect.any(String),
    });
  });

  it('refuses a credential set the scope cannot carry, without an error', async () => {
    // The row is legal — `store_id` references `stores(id)` alone — so a binding
    // can name another tenant's store. Storing credentials on it would let 连接
    // report success on a set the transport never picks up, so the write refuses
    // it by matching no row.
    const kfId = nextAccount();
    const bindingId = await seedBinding({ tenant: tenantId, store: otherStoreId, openKfId: kfId });

    expect(await save(bindingId, { openKfId: kfId })).toBe(false);
    expect(await repository.readCurrentCredentials()).toBeUndefined();
  });

  it('refuses a disabled binding and another tenant’s binding', async () => {
    const kfId = nextAccount();
    const disabled = await seedBinding({
      tenant: tenantId,
      store: storeId,
      openKfId: kfId,
      status: 'disabled',
    });

    expect(await save(disabled, { openKfId: kfId })).toBe(false);

    const active = await seedBinding({ tenant: tenantId, store: storeId, openKfId: kfId });
    expect(
      await repository.saveCredentials({
        tenantId: otherTenantId,
        bindingId: active,
        values: { ...values, openKfId: kfId },
        now: now(),
        updatedBy: null,
      }),
    ).toBe(false);
    expect(await repository.readCurrentCredentials()).toBeUndefined();
  });

  it('clears the stored verdict when the values are replaced', async () => {
    const kfId = nextAccount();
    const bindingId = await seedBinding({ tenant: tenantId, store: storeId, openKfId: kfId });
    await save(bindingId, { openKfId: kfId });
    await repository.recordVerification({
      tenantId,
      bindingId,
      now: now(),
      error: null,
    });
    expect((await repository.readCurrentCredentials())?.verifiedAt).not.toBeNull();

    await save(bindingId, { openKfId: kfId, kfSecret: 'a-newer-secret' });

    // A verdict belongs to the values it was reached on.
    const current = await repository.readCurrentCredentials();
    expect(current?.verifiedAt).toBeNull();
    expect(current?.verifiedError).toBeNull();
    expect(current?.kfSecret).toBe('a-newer-secret');
  });

  it('records both outcomes of a connection attempt, and refuses a stranger', async () => {
    const kfId = nextAccount();
    const bindingId = await seedBinding({ tenant: tenantId, store: storeId, openKfId: kfId });
    await save(bindingId, { openKfId: kfId });

    // Migration `0017`'s check constraint requires an instant beside a reason,
    // so a failure carries both and a success carries the instant alone.
    expect(
      await repository.recordVerification({
        tenantId,
        bindingId,
        now: now(),
        error: `errcode 40001 on wkWC${RUN}`,
      }),
    ).toBe(true);
    expect(await repository.readCurrentCredentials()).toMatchObject({
      verifiedError: `errcode 40001 on wkWC${RUN}`,
    });

    expect(
      await repository.recordVerification({ tenantId, bindingId, now: now(), error: null }),
    ).toBe(true);
    expect(await repository.readCurrentCredentials()).toMatchObject({
      verifiedAt: expect.any(String),
      verifiedError: null,
    });

    // An unknown binding and another tenant's binding are both refused, and the
    // stored verdict stays the one that was reached.
    expect(
      await repository.recordVerification({
        tenantId,
        bindingId: `binding-wc-${RUN}-missing`,
        now: now(),
        error: null,
      }),
    ).toBe(false);
    expect(
      await repository.recordVerification({
        tenantId: otherTenantId,
        bindingId,
        now: now(),
        error: 'must not be stored',
      }),
    ).toBe(false);
    expect((await repository.readCurrentCredentials())?.verifiedError).toBeNull();
  });

  it('refuses a second credentialed account, and refuses to read two', async () => {
    const first = nextAccount();
    const second = nextAccount();
    const firstId = await seedBinding({ tenant: tenantId, store: storeId, openKfId: first });
    const secondId = await seedBinding({ tenant: tenantId, store: storeId, openKfId: second });
    await save(firstId, { openKfId: first });
    expect((await repository.readCurrentCredentials())?.openKfId).toBe(first);

    // One transport cannot serve two accounts, so the store refuses the second
    // write rather than letting the connection that works become ambiguous.
    expect(await save(secondId, { openKfId: second })).toBe(false);
    expect((await repository.readCurrentCredentials())?.openKfId).toBe(first);

    // The read refuses two as well, for the state only a hand-edited database
    // reaches: a row inserted around the guard must not be picked silently.
    await pool.query(
      `INSERT INTO wecom_channel_credentials
         (binding_id, kf_secret, callback_token, aes_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [secondId, 'kf-written-by-hand', 'token-written-by-hand', values.aesKey, now()],
    );
    expect(await repository.readCurrentCredentials()).toBeUndefined();
  });

  it('takes a switched-off account out of the connection and back in', async () => {
    const kfId = nextAccount();
    const bindingId = await seedBinding({ tenant: tenantId, store: storeId, openKfId: kfId });
    await save(bindingId, { openKfId: kfId });
    await repository.recordVerification({ tenantId, bindingId, now: now(), error: null });

    // `disabled_at` moves with the status: migration `0007`'s check constraint
    // makes the two one fact rather than an ambiguous state.
    await pool.query(
      `UPDATE wecom_channel_bindings SET status = 'disabled', disabled_at = $2 WHERE id = $1`,
      [bindingId, now()],
    );
    expect(await repository.readCurrentCredentials()).toBeUndefined();

    // Switching it back on restores the connection, verdict and all: the values
    // never stopped being true, the account was just not being served.
    await pool.query(
      `UPDATE wecom_channel_bindings SET status = 'active', disabled_at = NULL WHERE id = $1`,
      [bindingId],
    );
    expect(await repository.readCurrentCredentials()).toMatchObject({
      bindingId,
      verifiedAt: expect.any(String),
    });
  });

  it('takes the credentials with the binding when it is deleted', async () => {
    const kfId = nextAccount();
    const bindingId = await seedBinding({ tenant: tenantId, store: storeId, openKfId: kfId });
    await save(bindingId, { openKfId: kfId });

    await pool.query('DELETE FROM wecom_channel_bindings WHERE id = $1', [bindingId]);

    // Migration `0017`'s cascade, and the reason credentials are keyed by the
    // binding rather than kept in a table of their own: a set that outlived its
    // binding would be a secret nothing can ever use.
    const left = await pool.query(
      'SELECT binding_id FROM wecom_channel_credentials WHERE binding_id = $1',
      [bindingId],
    );
    expect(left.rows).toEqual([]);
  });
});

/** Current instant, as the domain's ISO-8601 strings are written. */
function now(): string {
  return new Date().toISOString();
}
