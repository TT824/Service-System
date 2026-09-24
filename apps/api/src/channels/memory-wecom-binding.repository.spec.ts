import { describe, expect, it } from 'vitest';
import { createWeComBinding, WECOM_SYNC_LEASE_MS, type WeComChannelBinding } from '@kefu/core';
import { MemoryWecomBindingRepository } from './memory-wecom-binding.repository';

/**
 * Unit tests for the in-process binding and cursor store.
 *
 * The durable statements have their own PostgreSQL suite; what these prove is
 * that a `test` boot — the store every unit and interface test meets — follows
 * the *same* cursor rules: the same lease duration, the same compare-by-owner
 * transitions, the same refusal to advance to a blank position, and the same
 * answer for an account nobody bound. The store reaches them by calling
 * `@kefu/core`'s transitions, so a rule cannot be fixed for one store and left
 * broken in the other.
 */
const TENANT_ID = 'tenant-acme';
const OTHER_TENANT_ID = 'tenant-other';
const BINDING_ID = 'binding-1';

/** A fixed instant, so the granted lease is a literal. */
const NOW = '2026-03-01T12:00:00.000Z';

/** An instant past any lease taken at {@link NOW}. */
const LATER = new Date(Date.parse(NOW) + WECOM_SYNC_LEASE_MS + 1_000).toISOString();

/** Claim the binding's cursor for `owner` at `now`. */
function claim(
  repository: MemoryWecomBindingRepository,
  owner: string,
  now = NOW,
  tenantId = TENANT_ID,
) {
  return repository.claimCursor({ tenantId, bindingId: BINDING_ID, owner, now });
}

describe('MemoryWecomBindingRepository bindings', () => {
  it('resolves no account until one is bound, as an empty table does', async () => {
    const repository = new MemoryWecomBindingRepository();

    // Answering "not bound" is what the durable store answers for an empty
    // table, so the two environments agree instead of diverging.
    expect(await repository.findActiveBinding('ww-corp', 'wk-account')).toBeUndefined();
    expect(await repository.listBindings()).toEqual([]);
  });

  it('resolves an account it was asked to bind', async () => {
    const repository = new MemoryWecomBindingRepository();
    const binding = bound({ openKfId: 'wk-account' });

    expect(await repository.createBinding(binding)).toBe(true);

    expect(await repository.findActiveBinding('ww-corp', 'wk-account')).toEqual({
      id: binding.id,
      tenantId: TENANT_ID,
      storeId: binding.storeId,
      corpId: 'ww-corp',
      openKfId: 'wk-account',
    });
    // Another account, and another corp's same account, stay unbound: the pair
    // is the identity, so neither half alone resolves one.
    expect(await repository.findActiveBinding('ww-other', 'wk-account')).toBeUndefined();
    expect(await repository.findActiveBinding('ww-corp', 'wk-other')).toBeUndefined();
  });

  it('refuses a second active binding for one account but keeps a disabled one', async () => {
    const repository = new MemoryWecomBindingRepository();
    expect(await repository.createBinding(bound({ openKfId: 'wk-account' }))).toBe(true);

    // The durable store refuses this with `wecom_channel_bindings_active_key`;
    // the in-process store has to reach the same decision, because the console
    // is written against one behaviour and tested against this one.
    const second = bound({ id: 'binding-2', openKfId: 'wk-account', tenantId: OTHER_TENANT_ID });
    expect(await repository.createBinding(second)).toBe(false);
    expect(await repository.findActiveBinding('ww-corp', 'wk-account')).toMatchObject({
      tenantId: TENANT_ID,
    });

    // A switched-off row is not a candidate for anybody's callback, so two of
    // them may coexist and neither resolves the account on its own.
    const switchedOff = bound({
      id: 'binding-3',
      openKfId: 'wk-account',
      tenantId: OTHER_TENANT_ID,
      status: 'disabled',
      disabledAt: NOW,
    });
    expect(await repository.createBinding(switchedOff)).toBe(true);
    expect(await repository.findActiveBinding('ww-corp', 'wk-account')).toMatchObject({
      tenantId: TENANT_ID,
    });
  });

  it('lists every binding, disabled rows included, newest first', async () => {
    const repository = new MemoryWecomBindingRepository();
    await repository.createBinding(
      bound({ id: 'binding-old', openKfId: 'wk-old', createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    await repository.createBinding(
      bound({
        id: 'binding-off',
        openKfId: 'wk-off',
        status: 'disabled',
        disabledAt: NOW,
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
    );
    await repository.createBinding(
      bound({ id: 'binding-new', openKfId: 'wk-new', createdAt: '2026-03-01T00:00:00.000Z' }),
    );

    // A disabled row is the reason a later binding of the same account would be
    // refused, so the list a console reads has to be able to show it.
    expect((await repository.listBindings()).map((binding) => binding.id)).toEqual([
      'binding-new',
      'binding-off',
      'binding-old',
    ]);

    // Only the two active rows resolve, and the disabled one resolves nothing.
    expect(await repository.findActiveBinding('ww-corp', 'wk-off')).toBeUndefined();
    expect(await repository.findActiveBinding('ww-corp', 'wk-new')).toBeDefined();
  });
});

/** One binding to store, built by the shared rule rather than assembled here. */
function bound(overrides: Partial<WeComChannelBinding> = {}): WeComChannelBinding {
  const built = createWeComBinding({
    id: overrides.id ?? BINDING_ID,
    now: overrides.createdAt ?? NOW,
    draft: {
      tenantId: overrides.tenantId ?? TENANT_ID,
      storeId: overrides.storeId ?? 'store-acme-flagship',
      corpId: overrides.corpId ?? 'ww-corp',
      openKfId: overrides.openKfId ?? 'wk-account',
      enabled: overrides.status !== 'disabled',
    },
  });
  if (built === undefined) {
    throw new Error('the test draft was refused by the shared rule');
  }
  return { ...built, ...overrides };
}

describe('MemoryWecomBindingRepository cursor lease', () => {
  it('creates the cursor on a first claim with Core’s bounded lease', async () => {
    const repository = new MemoryWecomBindingRepository();

    const claimed = await claim(repository, 'owner-a');

    expect(claimed).toEqual({
      bindingId: BINDING_ID,
      tenantId: TENANT_ID,
      cursor: null,
      owner: 'owner-a',
      leaseExpiresAt: new Date(Date.parse(NOW) + WECOM_SYNC_LEASE_MS).toISOString(),
    });
  });

  it('refuses a second live claim and lets it through once the lease expires', async () => {
    const repository = new MemoryWecomBindingRepository();
    await claim(repository, 'owner-a');

    // One row per binding: a second concurrent notification contends for the
    // lease instead of pulling the same window from the same cursor.
    expect(await claim(repository, 'owner-b')).toBeUndefined();

    // A pull that died without releasing becomes recoverable exactly when Core
    // says it does, whichever store the environment selected.
    expect(await claim(repository, 'owner-b', LATER)).toMatchObject({ owner: 'owner-b' });
  });

  it('renews, advances and releases only for the owner that holds the lease', async () => {
    const repository = new MemoryWecomBindingRepository();
    await claim(repository, 'owner-a');
    const held = (owner: string) => ({
      tenantId: TENANT_ID,
      bindingId: BINDING_ID,
      owner,
      now: LATER,
    });

    expect(await repository.renewCursor(held('owner-b'))).toBe(false);
    expect(await repository.advanceCursor({ ...held('owner-b'), cursor: 'cursor-stale' })).toBe(
      false,
    );
    expect(await repository.releaseCursor(held('owner-b'))).toBe(false);

    expect(await repository.renewCursor(held('owner-a'))).toBe(true);
    expect(await repository.advanceCursor({ ...held('owner-a'), cursor: 'cursor-1' })).toBe(true);

    // Advancing keeps the claim, so a pull with more pages still owns the
    // account, and the renewal pushed the expiry out rather than leaving it.
    const afterAdvance = await claim(repository, 'owner-b', LATER);
    expect(afterAdvance).toBeUndefined();

    expect(await repository.releaseCursor({ ...held('owner-a'), now: LATER })).toBe(true);
    // Releasing ends the claim but keeps the position, so the next owner resumes
    // from where the pull actually reached.
    expect(await claim(repository, 'owner-b', LATER)).toMatchObject({
      cursor: 'cursor-1',
      owner: 'owner-b',
    });
  });

  it('refuses a blank position instead of overwriting the stored one', async () => {
    const repository = new MemoryWecomBindingRepository();
    await claim(repository, 'owner-a');
    await repository.advanceCursor({
      tenantId: TENANT_ID,
      bindingId: BINDING_ID,
      owner: 'owner-a',
      now: NOW,
      cursor: 'cursor-1',
    });

    // The predicate is Core's, so the in-process store refuses exactly what the
    // durable statement refuses: a page that produced no position cannot claim
    // forward progress, and the real position is not erased.
    for (const blank of ['', '   ']) {
      await expect(
        repository.advanceCursor({
          tenantId: TENANT_ID,
          bindingId: BINDING_ID,
          owner: 'owner-a',
          now: NOW,
          cursor: blank,
        }),
      ).rejects.toThrow(/must not be blank/);
    }

    await repository.releaseCursor({
      tenantId: TENANT_ID,
      bindingId: BINDING_ID,
      owner: 'owner-a',
      now: NOW,
    });
    expect(await claim(repository, 'owner-b', LATER)).toMatchObject({ cursor: 'cursor-1' });
  });

  it('never lets one tenant address another tenant’s cursor', async () => {
    const repository = new MemoryWecomBindingRepository();
    await claim(repository, 'owner-a');

    // The takeover keeps the *row's* tenant, exactly as the durable
    // `INSERT ... ON CONFLICT` does — the statement never rewrites `tenant_id`,
    // so the claim answers with the binding's own tenant rather than the
    // caller's.
    const takeover = await claim(repository, 'owner-b', LATER, OTHER_TENANT_ID);
    expect(takeover).toMatchObject({ tenantId: TENANT_ID, owner: 'owner-b' });

    // Every later mutation is scoped by tenant, so the caller that addressed the
    // row with the wrong tenant can neither extend nor end the claim it took.
    expect(
      await repository.renewCursor({
        tenantId: OTHER_TENANT_ID,
        bindingId: BINDING_ID,
        owner: 'owner-b',
        now: LATER,
      }),
    ).toBe(false);
    expect(
      await repository.releaseCursor({
        tenantId: OTHER_TENANT_ID,
        bindingId: BINDING_ID,
        owner: 'owner-b',
        now: LATER,
      }),
    ).toBe(false);
    expect(await claim(repository, 'owner-c', LATER)).toBeUndefined();
  });

  it('reports every mutation of an unknown binding as not applied', async () => {
    const repository = new MemoryWecomBindingRepository();
    const input = { tenantId: TENANT_ID, bindingId: 'binding-unknown', owner: 'owner-a', now: NOW };

    expect(await repository.renewCursor(input)).toBe(false);
    expect(await repository.advanceCursor({ ...input, cursor: 'cursor-1' })).toBe(false);
    expect(await repository.releaseCursor(input)).toBe(false);
  });
});
