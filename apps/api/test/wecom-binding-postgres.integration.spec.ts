import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWeComBinding as buildBinding,
  parseAppConfig,
  WECOM_SYNC_LEASE_MS,
  type AppConfig,
  type WeComBindingDraft,
} from '@kefu/core';
import { DatabaseService } from '../src/database/database.service';
import { PostgresWecomBindingRepository } from '../src/channels/postgres-wecom-binding.repository';
import { resolveWecomBindingMode } from '../src/channels/wecom-binding.repository';
import { toIso } from '../src/persistence/row-values';
import {
  isDatabaseReachable,
  resolveDatabaseUrl,
  runDatabaseCommand,
} from './database-test-support';

/**
 * Integration tests for the durable WeCom account bindings and sync cursors.
 *
 * These exercise {@link PostgresWecomBindingRepository} against the real
 * PostgreSQL the platform targets — the tables and constraints migration `0007`
 * declares — rather than only against the in-process adapter the unit tests use.
 * They prove the facts the acceptance criteria name: only an *active* binding
 * resolves an account, a binding whose store belongs to another tenant resolves
 * nothing, an ambiguous account is impossible, and a cursor claim is one atomic
 * write whose renew/advance/release are compare-by-owner — the owner that
 * already holds a live lease may renew it, another owner still may not.
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

describe.skipIf(!reachable)('WeCom bindings and sync cursors (PostgreSQL)', () => {
  let config: AppConfig;
  let database: DatabaseService;
  let pool: Pool;
  let repository: PostgresWecomBindingRepository;

  const tenantId = `tenant-wb-${RUN}`;
  const storeId = `store-wb-${RUN}`;
  /** A second tenant, so a cross-tenant store can be built without touching one. */
  const otherTenantId = `tenant-wb-other-${RUN}`;
  const otherStoreId = `store-wb-other-${RUN}`;

  /** The provider account every binding in this run is about. */
  const corpId = `ww-wb-${RUN}`;
  const openKfId = `wkWB${RUN}`;

  /** One provider account per test, so the partial unique index never collides. */
  let account = 0;
  function nextAccount(): string {
    account += 1;
    return `${openKfId}-${account}`;
  }

  /** Insert one binding and return its id. */
  async function seedBinding(input: {
    readonly tenant: string;
    readonly store: string;
    readonly openKfId: string;
    readonly corpId?: string;
    readonly status?: 'active' | 'disabled';
  }): Promise<string> {
    const id = `binding-wb-${RUN}-${randomUUID().slice(0, 8)}`;
    const at = now();
    await pool.query(
      `INSERT INTO wecom_channel_bindings
         (id, tenant_id, store_id, corp_id, open_kfid, status, created_at, updated_at, disabled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
      [
        id,
        input.tenant,
        input.store,
        input.corpId ?? corpId,
        input.openKfId,
        input.status ?? 'active',
        at,
        input.status === 'disabled' ? at : null,
      ],
    );
    return id;
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
    repository = new PostgresWecomBindingRepository(database);
    await seedDirectory();
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
      [tenantId, `wb-${RUN}`, '企业微信绑定集成测试租户'],
      [otherTenantId, `wb-other-${RUN}`, '企业微信绑定集成测试另一租户'],
    ] as ReadonlyArray<readonly [string, string, string]>) {
      await pool.query(
        'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
        [id, code, name, at],
      );
    }
    for (const [id, tenant, code] of [
      [storeId, tenantId, 'main'],
      [otherStoreId, otherTenantId, 'main'],
    ] as ReadonlyArray<readonly [string, string, string]>) {
      await pool.query(
        'INSERT INTO stores (id, tenant_id, code, name, enabled, created_at) VALUES ($1, $2, $3, $4, TRUE, $5)',
        [id, tenant, code, '企业微信绑定集成测试门店', at],
      );
    }
  }

  /** Remove everything this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM wecom_sync_cursors WHERE tenant_id = ANY($1)', [
      [tenantId, otherTenantId],
    ]);
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
    expect(resolveWecomBindingMode('test')).toBe('memory');
    expect(resolveWecomBindingMode('local')).toBe('postgres');
    expect(resolveWecomBindingMode('production')).toBe('postgres');
  });

  it('resolves an active binding and refuses a disabled one', async () => {
    const kfId = nextAccount();
    const id = await seedBinding({ tenant: tenantId, store: storeId, openKfId: kfId });

    expect(await repository.findActiveBinding(corpId, kfId)).toEqual({
      id,
      tenantId,
      storeId,
      corpId,
      openKfId: kfId,
    });

    // Disabling the account takes it out of resolution without deleting the
    // row, so the scope that held it stays auditable.
    await pool.query(
      `UPDATE wecom_channel_bindings
          SET status = 'disabled', disabled_at = $2, updated_at = $2
        WHERE id = $1`,
      [id, now()],
    );
    expect(await repository.findActiveBinding(corpId, kfId)).toBeUndefined();
  });

  it('resolves nothing for another corp or another account', async () => {
    const kfId = nextAccount();
    await seedBinding({ tenant: tenantId, store: storeId, openKfId: kfId });

    expect(await repository.findActiveBinding(`ww-other-${RUN}`, kfId)).toBeUndefined();
    expect(await repository.findActiveBinding(corpId, `${kfId}-missing`)).toBeUndefined();
  });

  it('resolves nothing when the bound store belongs to another tenant', async () => {
    // The row is legal — `store_id` references `stores(id)` alone — so only the
    // read's own recheck can stop a callback from writing across a tenant.
    const kfId = nextAccount();
    await seedBinding({ tenant: tenantId, store: otherStoreId, openKfId: kfId });

    expect(await repository.findActiveBinding(corpId, kfId)).toBeUndefined();
  });

  it('makes an ambiguous account impossible, not merely unlikely', async () => {
    const kfId = nextAccount();
    await seedBinding({ tenant: tenantId, store: storeId, openKfId: kfId });

    // A second active row for the same provider account is rejected by the
    // partial unique index migration `0007` declares.
    await expect(
      seedBinding({ tenant: otherTenantId, store: otherStoreId, openKfId: kfId }),
    ).rejects.toThrow(/wecom_channel_bindings_active_key/);

    // A disabled row may coexist with it, because neither resolves a callback
    // on its own and rebinding an account that was switched off stays possible.
    await seedBinding({
      tenant: otherTenantId,
      store: otherStoreId,
      openKfId: kfId,
      status: 'disabled',
    });

    expect(await repository.findActiveBinding(corpId, kfId)).toMatchObject({
      tenantId,
      storeId,
    });
  });

  it('creates the cursor on a first claim and refuses a second live claim', async () => {
    const bindingId = await seedBinding({
      tenant: tenantId,
      store: storeId,
      openKfId: nextAccount(),
    });

    const claim = await repository.claimCursor({
      tenantId,
      bindingId,
      owner: 'owner-a',
      now: now(),
    });
    expect(claim).toMatchObject({ tenantId, bindingId, owner: 'owner-a', cursor: null });
    expect(Date.parse(claim?.leaseExpiresAt ?? '')).toBeGreaterThan(Date.now());

    // The claim is one atomic write, so a notification that loses the race is
    // told to come back rather than pulling the same window twice.
    expect(
      await repository.claimCursor({
        tenantId,
        bindingId,
        owner: 'owner-b',
        now: now(),
      }),
    ).toBeUndefined();
  });

  it('lets the owner renew its own live lease, and still refuses another owner', async () => {
    const bindingId = await seedBinding({
      tenant: tenantId,
      store: storeId,
      openKfId: nextAccount(),
    });

    // A pull that is still running: its lease is live — `WECOM_SYNC_LEASE_MS` is
    // a minute, so a claim made 30s ago has 30s left — and it has already stored
    // a position, which a renewal must not disturb.
    const started = new Date(Date.now() - 30_000).toISOString();
    const first = await repository.claimCursor({
      tenantId,
      bindingId,
      owner: 'owner-a',
      now: started,
    });
    expect(first).toBeDefined();
    expect(
      await repository.advanceCursor({
        tenantId,
        bindingId,
        owner: 'owner-a',
        now: started,
        cursor: 'cursor-1',
      }),
    ).toBe(true);

    // Same owner, live lease. The lease never lapsed, so only the predicate that
    // accepts *this owner's* own live lease can let this through — the takeover
    // of an expired lease is not what is being tested here.
    const renewedAt = now();
    const renewed = await repository.claimCursor({
      tenantId,
      bindingId,
      owner: 'owner-a',
      now: renewedAt,
    });
    expect(renewed).toMatchObject({
      bindingId,
      tenantId,
      owner: 'owner-a',
      cursor: 'cursor-1',
    });
    // The extension is Core's single lease length, measured from the renewal
    // instant, and it moved the expiry forward rather than leaving it alone.
    expect(Date.parse(renewed?.leaseExpiresAt ?? '')).toBe(
      Date.parse(renewedAt) + WECOM_SYNC_LEASE_MS,
    );
    expect(Date.parse(renewed?.leaseExpiresAt ?? '')).toBeGreaterThan(
      Date.parse(first?.leaseExpiresAt ?? ''),
    );

    // Another owner is still refused while that lease is live: the predicate was
    // widened to the holder, not to everybody.
    expect(
      await repository.claimCursor({
        tenantId,
        bindingId,
        owner: 'owner-b',
        now: now(),
      }),
    ).toBeUndefined();

    // And the renewal left the stored position exactly where the pull had it,
    // while the persisted expiry is the one the renewal reported. The column
    // comes back as a driver `Date`, so it is normalised the way every durable
    // adapter normalises it rather than through the driver's text format.
    const stored = await cursorRow(bindingId);
    expect(stored).toMatchObject({ cursor: 'cursor-1', lease_owner: 'owner-a' });
    expect(toIso(stored?.['lease_expires_at'])).toBe(renewed?.leaseExpiresAt);
  });

  it('renews, advances and releases only for the owner that holds the lease', async () => {
    const bindingId = await seedBinding({
      tenant: tenantId,
      store: storeId,
      openKfId: nextAccount(),
    });
    const claim = await repository.claimCursor({
      tenantId,
      bindingId,
      owner: 'owner-a',
      now: now(),
    });
    expect(claim).toBeDefined();

    // A stale owner is nobody's owner: every mutation is compare-by-owner.
    expect(
      await repository.renewCursor({
        tenantId,
        bindingId,
        owner: 'owner-b',
        now: now(),
      }),
    ).toBe(false);
    expect(
      await repository.advanceCursor({
        tenantId,
        bindingId,
        owner: 'owner-b',
        now: now(),
        cursor: 'cursor-stale',
      }),
    ).toBe(false);
    expect(
      await repository.releaseCursor({
        tenantId,
        bindingId,
        owner: 'owner-b',
        now: now(),
      }),
    ).toBe(false);

    expect(
      await repository.renewCursor({
        tenantId,
        bindingId,
        owner: 'owner-a',
        now: now(),
      }),
    ).toBe(true);
    expect(
      await repository.advanceCursor({
        tenantId,
        bindingId,
        owner: 'owner-a',
        now: now(),
        cursor: 'cursor-1',
      }),
    ).toBe(true);

    // Advancing records the position and keeps the claim: a pull with more pages
    // to fetch still owns the account.
    const stored = await cursorRow(bindingId);
    expect(stored?.['cursor']).toBe('cursor-1');
    expect(stored?.['lease_owner']).toBe('owner-a');
    expect(stored?.['last_synced_at']).not.toBeNull();

    // Releasing ends the claim, and the next owner resumes from the stored
    // cursor rather than from the top.
    expect(
      await repository.releaseCursor({
        tenantId,
        bindingId,
        owner: 'owner-a',
        now: now(),
      }),
    ).toBe(true);
    expect(await cursorRow(bindingId)).toMatchObject({
      cursor: 'cursor-1',
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(
      await repository.claimCursor({
        tenantId,
        bindingId,
        owner: 'owner-b',
        now: now(),
      }),
    ).toMatchObject({ cursor: 'cursor-1', owner: 'owner-b' });
  });

  it('refuses to advance a held cursor to a blank position', async () => {
    const bindingId = await seedBinding({
      tenant: tenantId,
      store: storeId,
      openKfId: nextAccount(),
    });
    await repository.claimCursor({ tenantId, bindingId, owner: 'owner-a', now: now() });
    await repository.advanceCursor({
      tenantId,
      bindingId,
      owner: 'owner-a',
      now: now(),
      cursor: 'cursor-1',
    });

    // A blank position is refused by the statement itself, before it can write a
    // row that would claim forward progress while storing no position at all —
    // the durable half of the invariant the transport enforces on a page.
    for (const blank of ['', '   ']) {
      await expect(
        repository.advanceCursor({
          tenantId,
          bindingId,
          owner: 'owner-a',
          now: now(),
          cursor: blank,
        }),
      ).rejects.toThrow(/must not be blank/);
    }
    expect(await cursorRow(bindingId)).toMatchObject({
      cursor: 'cursor-1',
      lease_owner: 'owner-a',
    });
  });

  it('lets an expired lease be reclaimed, and stops the old owner advancing it', async () => {
    const bindingId = await seedBinding({
      tenant: tenantId,
      store: storeId,
      openKfId: nextAccount(),
    });
    // A pull that died without releasing: its lease is simply in the past. The
    // margin is twice Core's `WECOM_SYNC_LEASE_MS`, so the seeded claim is
    // unambiguously expired rather than expired by a millisecond.
    const past = new Date(Date.now() - 120_000).toISOString();
    const claim = await repository.claimCursor({
      tenantId,
      bindingId,
      owner: 'owner-dead',
      now: past,
    });
    expect(claim).toBeDefined();

    const reclaimed = await repository.claimCursor({
      tenantId,
      bindingId,
      owner: 'owner-live',
      now: now(),
    });
    expect(reclaimed).toMatchObject({ owner: 'owner-live' });

    // The dead owner cannot move or release the newer claim, which is what keeps
    // a recovered cursor from being rewound by the attempt it recovered from.
    expect(
      await repository.advanceCursor({
        tenantId,
        bindingId,
        owner: 'owner-dead',
        now: now(),
        cursor: 'cursor-rewound',
      }),
    ).toBe(false);
    expect(
      await repository.releaseCursor({
        tenantId,
        bindingId,
        owner: 'owner-dead',
        now: now(),
      }),
    ).toBe(false);
    expect(await cursorRow(bindingId)).toMatchObject({ cursor: null, lease_owner: 'owner-live' });
  });

  it('never lets one tenant address another tenant’s cursor', async () => {
    const bindingId = await seedBinding({
      tenant: tenantId,
      store: storeId,
      openKfId: nextAccount(),
    });
    expect(
      await repository.claimCursor({
        tenantId,
        bindingId,
        owner: 'owner-a',
        now: now(),
      }),
    ).toBeDefined();

    // Same owner name, wrong tenant: the statement is scoped by `tenant_id`, so
    // it matches no row and the real claim is untouched.
    expect(
      await repository.renewCursor({
        tenantId: otherTenantId,
        bindingId,
        owner: 'owner-a',
        now: now(),
      }),
    ).toBe(false);
    expect(await cursorRow(bindingId)).toMatchObject({ lease_owner: 'owner-a' });
  });

  /** Read one cursor row as the durable table stores it. */
  async function cursorRow(bindingId: string): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query(
      `SELECT cursor, lease_owner, lease_expires_at, last_synced_at
         FROM wecom_sync_cursors WHERE binding_id = $1`,
      [bindingId],
    );
    return result.rows[0];
  }

  /** The binding row for one account, as the durable table stores it. */
  async function storedRow(openKfId: string): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query(
      `SELECT id, tenant_id, store_id, corp_id, open_kfid, status, disabled_at
         FROM wecom_channel_bindings WHERE corp_id = $1 AND open_kfid = $2`,
      [corpId, openKfId],
    );
    return result.rows[0];
  }

  /** One binding to write, built by the same rule the API builds one with. */
  function draftFor(openKfId: string, overrides: Partial<WeComBindingDraft> = {}) {
    return buildBinding({
      id: `wecom-binding-${RUN}-${randomUUID().slice(0, 8)}`,
      now: now(),
      draft: {
        tenantId,
        storeId,
        corpId,
        openKfId,
        enabled: true,
        ...overrides,
      },
    });
  }

  it('writes the row the shared rule built and resolves it afterwards', async () => {
    // The write path a real deployment now uses instead of a hand INSERT. What
    // has to hold is that the stored row is the *built* row — every column the
    // rule decided reaches the table — and that a callback on it resolves.
    const kfId = nextAccount();
    const binding = draftFor(kfId);
    if (binding === undefined) {
      throw new Error('the shared rule refused a complete draft');
    }

    expect(await repository.createBinding(binding)).toBe(true);
    expect(await storedRow(kfId)).toEqual({
      id: binding.id,
      tenant_id: tenantId,
      store_id: storeId,
      corp_id: corpId,
      open_kfid: kfId,
      status: 'active',
      disabled_at: null,
    });
    expect(await repository.findActiveBinding(corpId, kfId)).toEqual({
      id: binding.id,
      tenantId,
      storeId,
      corpId,
      openKfId: kfId,
    });
    expect(await repository.listBindings()).toContainEqual(binding);
  });

  it('refuses a second active binding for one account with the index, not a read', async () => {
    // Two writers racing is the case a read-then-write cannot answer, so the
    // refusal has to come from the partial unique index itself. The second
    // binding is otherwise complete and legal — another tenant, another store —
    // and is refused only because the account already resolves.
    const kfId = nextAccount();
    const first = draftFor(kfId);
    const second = draftFor(kfId, { tenantId: otherTenantId, storeId: otherStoreId });
    if (first === undefined || second === undefined) {
      throw new Error('the shared rule refused a complete draft');
    }

    expect(await repository.createBinding(first)).toBe(true);
    expect(await repository.createBinding(second)).toBe(false);

    // The row that was already resolving still resolves, to its own scope: a
    // create is not a rebind, and the loser must not have moved the account.
    expect(await storedRow(kfId)).toMatchObject({ id: first.id, tenant_id: tenantId });
    expect(await repository.findActiveBinding(corpId, kfId)).toMatchObject({ storeId });
  });

  it('stores a switched-off binding without letting it resolve', async () => {
    // `disabled_at` is written, not left empty: the table's own check is
    // `(status = 'disabled') = (disabled_at IS NOT NULL)`, so a row that got
    // this wrong would be rejected by PostgreSQL rather than stored quietly.
    const kfId = nextAccount();
    const off = draftFor(kfId, { enabled: false });
    if (off === undefined) {
      throw new Error('the shared rule refused a complete draft');
    }

    expect(await repository.createBinding(off)).toBe(true);
    expect((await storedRow(kfId))?.['status']).toBe('disabled');
    expect((await storedRow(kfId))?.['disabled_at']).not.toBeNull();
    expect(await repository.findActiveBinding(corpId, kfId)).toBeUndefined();
    expect(await repository.listBindings()).toContainEqual(off);

    // And a live binding may still be written for the same account afterwards,
    // because a switched-off row is not a candidate the index guards.
    const live = draftFor(kfId);
    if (live === undefined) {
      throw new Error('the shared rule refused a complete draft');
    }
    expect(await repository.createBinding(live)).toBe(true);
    expect(await repository.findActiveBinding(corpId, kfId)).toMatchObject({ id: live.id });
  });

  it('lists newer bindings first and never another run’s rows', async () => {
    // The list is what a console shows, so its order is part of the contract
    // rather than an accident of insertion. Only this run's rows are asserted:
    // other rows in the table belong to whoever else is running.
    const older = draftFor(nextAccount());
    const newer = draftFor(nextAccount());
    if (older === undefined || newer === undefined) {
      throw new Error('the shared rule refused a complete draft');
    }
    const early = { ...older, createdAt: '2020-01-01T00:00:00.000Z' };
    const late = { ...newer, createdAt: '2030-01-01T00:00:00.000Z' };

    expect(await repository.createBinding(early)).toBe(true);
    expect(await repository.createBinding(late)).toBe(true);

    const listed = await repository.listBindings();
    const order = listed
      .filter((binding) => binding.id === early.id || binding.id === late.id)
      .map((binding) => binding.id);
    expect(order).toEqual([late.id, early.id]);

    // And the whole list is ordered, not just this run's slice of it: a console
    // reads the first page, so the newest binding has to be on it whatever else
    // the table holds.
    const instants = listed.map((binding) => Date.parse(binding.createdAt));
    expect([...instants].sort((left, right) => right - left)).toEqual(instants);
  });
});

/** Current instant, so the durable timestamps are realistic. */
function now(): string {
  return new Date().toISOString();
}
