import { describe, expect, it } from 'vitest';
import { createWeComBinding, WECOM_AES_KEY_LENGTH, type WeComChannelBinding } from '@kefu/core';
import { MemoryWecomBindingRepository } from './memory-wecom-binding.repository';
import { MemoryWecomCredentialRepository } from './memory-wecom-credential.repository';
import type { WecomCredentialRepository } from './wecom-credential.repository';

/**
 * Unit tests for the in-process credential store.
 *
 * The durable statements have their own PostgreSQL suite; what these prove is
 * that a `test` boot follows the *same* durable decisions — credentials belong
 * to an active binding in one tenant, a replacement clears the verdict, and two
 * credentialed accounts are refused rather than picked from. What they cannot
 * prove is the one condition that needs the `stores` table; that the binding's
 * store still belongs to its tenant is proved against PostgreSQL.
 */
const TENANT_ID = 'tenant-acme';
const OTHER_TENANT_ID = 'tenant-other';
const BINDING_ID = 'binding-1';
const SECOND_BINDING_ID = 'binding-2';

/** A fixed instant, so the stored timestamps are literals. */
const NOW = '2026-03-01T12:00:00.000Z';
const LATER = '2026-03-01T12:05:00.000Z';

/** The five values an operator would type, all of them usable. */
const VALUES = {
  corpId: 'ww-corp',
  kfSecret: 'kf-secret-from-console',
  callbackToken: 'callback-token-from-console',
  aesKey: 'k'.repeat(WECOM_AES_KEY_LENGTH),
  openKfId: 'wk-account',
};

/** A store with one active binding already in it. */
async function storeWithBinding(): Promise<{
  readonly credentials: WecomCredentialRepository;
  readonly bindings: MemoryWecomBindingRepository;
}> {
  const bindings = new MemoryWecomBindingRepository();
  await bindings.createBinding(bound());
  return { credentials: new MemoryWecomCredentialRepository(bindings), bindings };
}

/** One stored binding, built by the shared rule so it is a legal row. */
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

describe('MemoryWecomCredentialRepository', () => {
  it('holds nothing until something is written, as an empty table does', async () => {
    const { credentials } = await storeWithBinding();

    expect(await credentials.readCurrentCredentials()).toBeUndefined();
  });

  it('reads back a written set joined to its binding', async () => {
    const { credentials } = await storeWithBinding();

    expect(
      await credentials.saveCredentials({
        tenantId: TENANT_ID,
        bindingId: BINDING_ID,
        values: VALUES,
        now: NOW,
        updatedBy: 'account-admin',
      }),
    ).toBe(true);

    // The provider identity comes back from the *binding*, not from what was
    // typed: a credential row cannot disagree with the account it hangs off.
    expect(await credentials.readCurrentCredentials()).toEqual({
      bindingId: BINDING_ID,
      tenantId: TENANT_ID,
      storeId: 'store-acme-flagship',
      corpId: 'ww-corp',
      openKfId: 'wk-account',
      kfSecret: VALUES.kfSecret,
      callbackToken: VALUES.callbackToken,
      aesKey: VALUES.aesKey,
      verifiedAt: null,
      verifiedError: null,
      updatedAt: NOW,
    });
  });

  it('refuses a binding that is not active', async () => {
    const bindings = new MemoryWecomBindingRepository();
    await bindings.createBinding(bound({ status: 'disabled' }));
    const credentials = new MemoryWecomCredentialRepository(bindings);

    // A disabled account resolves no callback, so credentials on it could only
    // ever be failed ones.
    expect(
      await credentials.saveCredentials({
        tenantId: TENANT_ID,
        bindingId: BINDING_ID,
        values: VALUES,
        now: NOW,
        updatedBy: null,
      }),
    ).toBe(false);
    expect(await credentials.readCurrentCredentials()).toBeUndefined();
  });

  it('refuses a binding that belongs to another tenant', async () => {
    const { credentials } = await storeWithBinding();

    // The durable statement carries `tenant_id = $2`, so this write matches no
    // row; the in-process store has to refuse it for the same reason.
    expect(
      await credentials.saveCredentials({
        tenantId: OTHER_TENANT_ID,
        bindingId: BINDING_ID,
        values: VALUES,
        now: NOW,
        updatedBy: null,
      }),
    ).toBe(false);
    expect(await credentials.readCurrentCredentials()).toBeUndefined();
  });

  it('clears the verdict when the values are replaced', async () => {
    const { credentials } = await storeWithBinding();
    await save(credentials, NOW);
    expect(
      await credentials.recordVerification({
        tenantId: TENANT_ID,
        bindingId: BINDING_ID,
        now: NOW,
        error: 'invalid credential',
      }),
    ).toBe(true);
    expect((await credentials.readCurrentCredentials())?.verifiedError).toBe('invalid credential');

    await save(credentials, LATER, { ...VALUES, kfSecret: 'a-newer-secret' });

    // 「上次验证成功」 is a fact about the values it was reached on; new values
    // have no verdict until somebody tries to connect with them.
    const current = await credentials.readCurrentCredentials();
    expect(current?.verifiedAt).toBeNull();
    expect(current?.verifiedError).toBeNull();
    expect(current?.kfSecret).toBe('a-newer-secret');
    expect(current?.updatedAt).toBe(LATER);
  });

  it('records both outcomes of a connection attempt, and who it is about', async () => {
    const { credentials } = await storeWithBinding();
    await save(credentials, NOW);

    // Success: an instant and no reason.
    expect(
      await credentials.recordVerification({
        tenantId: TENANT_ID,
        bindingId: BINDING_ID,
        now: NOW,
        error: null,
      }),
    ).toBe(true);
    expect(await credentials.readCurrentCredentials()).toMatchObject({
      verifiedAt: NOW,
      verifiedError: null,
    });

    // Failure: the same instant plus the provider's own words, which is what the
    // console shows verbatim.
    expect(
      await credentials.recordVerification({
        tenantId: TENANT_ID,
        bindingId: BINDING_ID,
        now: LATER,
        error: 'errcode 40001: invalid secret',
      }),
    ).toBe(true);
    expect(await credentials.readCurrentCredentials()).toMatchObject({
      verifiedAt: LATER,
      verifiedError: 'errcode 40001: invalid secret',
    });
  });

  it('refuses to record a verdict for an unknown binding or another tenant', async () => {
    const { credentials } = await storeWithBinding();
    await save(credentials, NOW);

    expect(
      await credentials.recordVerification({
        tenantId: TENANT_ID,
        bindingId: 'binding-nobody-bound',
        now: NOW,
        error: null,
      }),
    ).toBe(false);
    expect(
      await credentials.recordVerification({
        tenantId: OTHER_TENANT_ID,
        bindingId: BINDING_ID,
        now: NOW,
        error: null,
      }),
    ).toBe(false);
    // The verdict that was there is still the one that was there.
    expect((await credentials.readCurrentCredentials())?.verifiedAt).toBeNull();
  });

  it('refuses to connect a second account over a live one', async () => {
    const { credentials, bindings } = await storeWithBinding();
    await bindings.createBinding(bound({ id: SECOND_BINDING_ID, openKfId: 'wk-second' }));
    await save(credentials, NOW);

    // One transport cannot serve two accounts, and picking the newest would send
    // one company's replies under an identity nobody chose — so the second write
    // is refused rather than stored, and the first connection survives it.
    expect(
      await credentials.saveCredentials({
        tenantId: TENANT_ID,
        bindingId: SECOND_BINDING_ID,
        values: { ...VALUES, openKfId: 'wk-second' },
        now: LATER,
        updatedBy: null,
      }),
    ).toBe(false);
    expect((await credentials.readCurrentCredentials())?.bindingId).toBe(BINDING_ID);

    // Re-writing the account that already holds them is not a second one.
    expect(await save(credentials, LATER)).toBe(true);

    // A second account that has no credentials is not an ambiguity either: the
    // deployment still connects with the one account that was set up.
    const single = await storeWithBinding();
    await save(single.credentials, NOW);
    expect((await single.credentials.readCurrentCredentials())?.bindingId).toBe(BINDING_ID);
  });
});

/** Write {@link VALUES} (or a variation) as the deployment's credentials. */
function save(
  repository: WecomCredentialRepository,
  now: string,
  values = VALUES,
): Promise<boolean> {
  return repository.saveCredentials({
    tenantId: TENANT_ID,
    bindingId: BINDING_ID,
    values,
    now,
    updatedBy: null,
  });
}
