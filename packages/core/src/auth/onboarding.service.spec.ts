import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../platform/types';
import { FixedAuthClock, SequentialAuthIdGenerator, type AuthIdGenerator } from './clock';
import { SEEDED_PLATFORM_ADMIN_MEMBER_ID, SEEDED_TENANTS } from './directory-seed';
import { InMemoryAuthRepository } from './memory-repository';
import { OnboardingService } from './onboarding.service';
import type { TrialWorkspace } from './ports';
import { TRIAL_STORE_CODE, TRIAL_STORE_NAME, trialTenantCode } from './trial-workspace';
import type { MemberUserLink, UserAccount } from './types';

const NOW = '2026-09-10T00:00:00.000Z';
const ACME = SEEDED_TENANTS[0]?.id ?? '';
const BETA = SEEDED_TENANTS[1]?.id ?? '';
/** Seeded merchant administrators, one per tenant. */
const ACME_ADMIN_MEMBER = 'u-t1-admin';
const BETA_ADMIN_MEMBER = 'u-t2-admin';

/** An account as registration leaves it: active, with a verified identity. */
function account(id: string, overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    id,
    username: `merchant-${id}`,
    displayName: `商户 ${id}`,
    status: 'active',
    passwordHash: null,
    passwordUpdatedAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: NOW,
    avatarUrl: null,
    idempotencyKey: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** An identifier generator that counts how many it handed out. */
class CountingIdGenerator implements AuthIdGenerator {
  readonly #inner = new SequentialAuthIdGenerator();
  issued = 0;

  next(prefix: string): string {
    this.issued += 1;
    return this.#inner.next(prefix);
  }
}

type Harness = {
  readonly repository: InMemoryAuthRepository;
  readonly ids: CountingIdGenerator;
  readonly onboarding: OnboardingService;
};

function harness(): Harness {
  const repository = new InMemoryAuthRepository();
  const ids = new CountingIdGenerator();
  const onboarding = new OnboardingService({
    repository,
    clock: new FixedAuthClock(NOW),
    ids,
  });
  return { repository, ids, onboarding };
}

/**
 * The store of a workspace, asserted to exist.
 *
 * A workspace found for an account configured by hand may have no store, so the
 * port types it as nullable. Every workspace a provisioning call establishes
 * has one, which is what these tests assert.
 */
function requireStore(workspace: TrialWorkspace): Store {
  if (workspace.store === null) {
    throw new Error('the provisioned workspace has no default store');
  }
  return workspace.store;
}

describe('OnboardingService', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('gives a new account a tenant, a default store, a merchant admin and a link', async () => {
    const result = await h.onboarding.provisionTrial(account('user-0001'));

    expect(result.provisioned).toBe(true);
    expect(result.tenant.code).toBe(trialTenantCode('user-0001'));
    expect(result.tenant.name).toBe('商户 user-0001');
    expect(result.tenant.enabled).toBe(true);
    expect(result.tenant.createdAt).toBe(NOW);

    const store = requireStore(result);
    expect(store.tenantId).toBe(result.tenant.id);
    expect(store.code).toBe(TRIAL_STORE_CODE);
    expect(store.name).toBe(TRIAL_STORE_NAME);
    expect(store.enabled).toBe(true);

    expect(result.member.tenantId).toBe(result.tenant.id);
    // Tenant-wide, and a merchant administrator: the account owns its whole
    // trial tenant rather than one store inside somebody else's.
    expect(result.member.storeId).toBeNull();
    expect(result.member.role).toBe('merchant_admin');
    expect(result.member.username).toBe('merchant-user-0001');
    expect(result.member.enabled).toBe(true);

    expect(result.link.userId).toBe('user-0001');
    expect(result.link.tenantId).toBe(result.tenant.id);
    expect(result.link.memberId).toBe(result.member.id);
    expect(result.link.linkedBy).toBe('user-0001');
    expect(result.link.linkedAt).toBe(NOW);
    expect(result.link.revokedAt).toBeNull();
  });

  it('is idempotent on the account, not on the rows it is handed', async () => {
    const first = await h.onboarding.provisionTrial(account('user-0001'));
    const issuedAfterFirst = h.ids.issued;

    const second = await h.onboarding.provisionTrial(account('user-0001'));
    expect(second.provisioned).toBe(false);
    expect(second.tenant.id).toBe(first.tenant.id);
    expect(second.store?.id).toBe(requireStore(first).id);
    expect(second.member.id).toBe(first.member.id);
    expect(second.link.id).toBe(first.link.id);

    // A repeat call writes nothing, so it also allocates nothing.
    expect(h.ids.issued).toBe(issuedAfterFirst);
    expect(
      (await h.repository.listTenants()).filter(
        (tenant) => tenant.code === trialTenantCode('user-0001'),
      ),
    ).toHaveLength(1);
    expect(await h.repository.listStores(first.tenant.id)).toHaveLength(1);
    expect(await h.repository.listActiveLinksForUser('user-0001')).toHaveLength(1);
  });

  it('keeps each account in its own tenant', async () => {
    const alice = await h.onboarding.provisionTrial(account('user-0001'));
    const bob = await h.onboarding.provisionTrial(account('user-0002'));

    expect(bob.tenant.id).not.toBe(alice.tenant.id);
    expect(bob.member.id).not.toBe(alice.member.id);
    expect(bob.store?.id).not.toBe(requireStore(alice).id);
    expect(bob.store?.tenantId).toBe(bob.tenant.id);

    // Neither account can reach the other's directory through its own
    // workspace: the tenant it acts in holds exactly its own rows.
    expect((await h.repository.listMembers(alice.tenant.id)).map((m) => m.id)).toEqual([
      alice.member.id,
    ]);
    expect((await h.repository.listStores(alice.tenant.id)).map((s) => s.id)).toEqual([
      requireStore(alice).id,
    ]);
    expect((await h.repository.listStores(alice.tenant.id)).map((s) => s.tenantId)).toEqual([
      alice.tenant.id,
    ]);
  });

  it('adopts the workspace an administrator already built, instead of a second one', async () => {
    // An account an administrator linked by hand before any onboarding: it has
    // a workspace, so provisioning must not mint another tenant for it.
    const link: MemberUserLink = {
      id: 'link-0001',
      userId: 'user-0001',
      tenantId: ACME,
      memberId: ACME_ADMIN_MEMBER,
      linkedBy: SEEDED_PLATFORM_ADMIN_MEMBER_ID,
      linkedAt: NOW,
      revokedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await h.repository.saveLink(link);

    const result = await h.onboarding.provisionTrial(account('user-0001'));
    expect(result.provisioned).toBe(false);
    expect(result.tenant.id).toBe(ACME);
    expect(result.member.id).toBe(link.memberId);
    expect(result.link.id).toBe('link-0001');
    expect(h.ids.issued).toBe(0);
    expect(
      (await h.repository.listTenants()).filter(
        (tenant) => tenant.id !== ACME && tenant.id !== BETA,
      ),
    ).toEqual([]);
  });

  it('follows the newest link when an account holds more than one', async () => {
    const base = {
      userId: 'user-0001',
      linkedBy: null,
      revokedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await h.repository.saveLink({
      ...base,
      id: 'link-0001',
      tenantId: ACME,
      memberId: ACME_ADMIN_MEMBER,
      linkedAt: '2026-09-01T00:00:00.000Z',
    });
    await h.repository.saveLink({
      ...base,
      id: 'link-0002',
      tenantId: BETA,
      memberId: BETA_ADMIN_MEMBER,
      linkedAt: NOW,
    });

    const result = await h.onboarding.provisionTrial(account('user-0001'));
    expect(result.provisioned).toBe(false);
    expect(result.tenant.id).toBe(BETA);
    expect(result.link.id).toBe('link-0002');
  });

  it('restores the workspace of an account whose link was revoked', async () => {
    const first = await h.onboarding.provisionTrial(account('user-0001'));
    await h.repository.saveLink({ ...first.link, revokedAt: NOW, updatedAt: NOW });
    expect(await h.repository.findTrialWorkspace('user-0001')).toBeUndefined();

    const second = await h.onboarding.provisionTrial(account('user-0001'));
    expect(second.provisioned).toBe(true);
    // The account gets its own workspace back — the tenant, store and member it
    // already had — rather than a second set of rows beside the first.
    expect(second.tenant.id).toBe(first.tenant.id);
    expect(requireStore(second).id).toBe(requireStore(first).id);
    expect(second.member.id).toBe(first.member.id);
    expect(second.link.id).toBe(first.link.id);
    expect(second.link.revokedAt).toBeNull();
    expect(second.link.linkedAt).toBe(NOW);
    expect(await h.repository.listActiveLinksForUser('user-0001')).toHaveLength(1);
    expect(await h.repository.listStores(first.tenant.id)).toHaveLength(1);
    expect(await h.repository.listMembers(first.tenant.id)).toHaveLength(1);
  });
});
