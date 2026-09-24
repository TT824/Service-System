import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAuthRepository } from './memory-repository';
import { KefuStore } from '../platform/store';
import {
  SEEDED_MEMBERS,
  SEEDED_PLATFORM_ADMIN_MEMBER_ID,
  SEEDED_STORES,
  SEEDED_TENANTS,
} from './directory-seed';
import { fingerprintSecret } from './token';
import { resolveAuthStorageMode } from './ports';
import { buildTrialWorkspace } from './trial-workspace';
import type { AuthSession, OtpChallenge, TrustedDevice, UserAccount, UserIdentity } from './types';

const NOW = '2026-09-10T00:00:00.000Z';

function account(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    id: 'user-0001',
    username: 'alice',
    displayName: 'Alice',
    status: 'active',
    passwordHash: null,
    passwordUpdatedAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    avatarUrl: null,
    idempotencyKey: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    id: 'identity-0001',
    userId: 'user-0001',
    provider: 'password',
    subject: 'alice',
    verified: true,
    verifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function challenge(overrides: Partial<OtpChallenge> = {}): OtpChallenge {
  return {
    id: 'otp-0001',
    tenantId: null,
    userId: null,
    purpose: 'sign_in',
    channel: 'sms',
    subject: '+8613800000000',
    codeHash: 'a'.repeat(64),
    codeAlgorithm: 'sha256',
    status: 'pending',
    failedAttempts: 0,
    maxAttempts: 5,
    idempotencyKey: null,
    issuedAt: NOW,
    expiresAt: '2026-09-10T00:05:00.000Z',
    consumedAt: null,
    revokedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function device(overrides: Partial<TrustedDevice> = {}): TrustedDevice {
  return {
    id: 'device-0001',
    userId: 'user-0001',
    tenantId: null,
    label: 'Laptop',
    platform: 'web',
    credentialFingerprint: fingerprintSecret('device-credential'),
    status: 'active',
    idempotencyKey: null,
    trustedAt: NOW,
    expiresAt: null,
    lastSeenAt: NOW,
    revokedAt: null,
    revokedReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    id: 'session-0001',
    userId: 'user-0001',
    tenantId: null,
    memberId: null,
    trustedDeviceId: null,
    tokenFingerprint: fingerprintSecret('token-1'),
    previousTokenFingerprint: null,
    rotationFamilyId: 'family-0001',
    authMethod: 'password',
    status: 'active',
    mfaSatisfied: false,
    clientFingerprint: null,
    idempotencyKey: null,
    issuedAt: NOW,
    expiresAt: '2026-09-10T12:00:00.000Z',
    lastSeenAt: NOW,
    revokedAt: null,
    revokedReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('InMemoryAuthRepository directory', () => {
  let repository: InMemoryAuthRepository;

  beforeEach(() => {
    repository = new InMemoryAuthRepository();
  });

  it('seeds the same directory the platform store seeds', async () => {
    const tenants = await repository.listTenants();
    const members = await repository.listAllMembers();
    expect(tenants.map((tenant) => tenant.id)).toEqual(
      SEEDED_TENANTS.map((tenant) => tenant.id).sort(),
    );
    expect(members.map((member) => member.id)).toEqual(
      SEEDED_MEMBERS.map((member) => member.id).sort(),
    );
    for (const seeded of SEEDED_STORES) {
      expect(await repository.findStoreById(seeded.id)).toEqual(seeded);
    }
  });

  it('starts empty when seeding is disabled', async () => {
    const empty = new InMemoryAuthRepository(false);
    expect(await repository.listTenants()).toHaveLength(SEEDED_TENANTS.length);
    expect(await empty.listTenants()).toHaveLength(0);
    expect(await empty.listAllMembers()).toHaveLength(0);
  });

  it('lists stores and members scoped to their tenant', async () => {
    const tenantId = SEEDED_TENANTS[0]?.id ?? '';
    const stores = await repository.listStores(tenantId);
    expect(stores.length).toBeGreaterThan(0);
    expect(stores.every((store) => store.tenantId === tenantId)).toBe(true);
    expect(await repository.getStore('tenant-does-not-exist', stores[0]?.id ?? '')).toBeUndefined();
  });

  it('stores and returns directory records', async () => {
    const member = SEEDED_MEMBERS[0];
    expect(member).toBeDefined();
    if (member === undefined) {
      return;
    }
    const updated = { ...member, enabled: false };
    await repository.saveMember(updated);
    expect(await repository.getMember(member.id)).toEqual(updated);
  });
});

describe('directory seed agreement', () => {
  it('describes exactly the directory the platform store seeds', () => {
    const store = new KefuStore();
    const tenants = store.listTenants();
    expect(SEEDED_TENANTS.map((tenant) => tenant.id).sort()).toEqual(
      tenants.map((tenant) => tenant.id).sort(),
    );
    for (const tenant of SEEDED_TENANTS) {
      expect(store.getTenant(tenant.id)).toEqual(tenant);
      expect(
        SEEDED_STORES.filter((seed) => seed.tenantId === tenant.id)
          .map((seed) => seed.id)
          .sort(),
      ).toEqual(
        store
          .listStores(tenant.id)
          .map((candidate) => candidate.id)
          .sort(),
      );
      expect(
        SEEDED_MEMBERS.filter((seed) => seed.tenantId === tenant.id)
          .map((seed) => seed.id)
          .sort(),
      ).toEqual(
        store
          .listMembers(tenant.id)
          .map((candidate) => candidate.id)
          .sort(),
      );
    }
    const platformAdmin = store.getMember(SEEDED_PLATFORM_ADMIN_MEMBER_ID);
    expect(platformAdmin).toEqual(
      SEEDED_MEMBERS.find((member) => member.id === SEEDED_PLATFORM_ADMIN_MEMBER_ID),
    );
  });
});

describe('InMemoryAuthRepository value semantics', () => {
  it('hands out copies, so a caller cannot mutate stored state', async () => {
    const repository = new InMemoryAuthRepository();
    await repository.saveUser(account());
    const first = await repository.getUser('user-0001');
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    (first as { username: string }).username = 'tampered';
    expect((await repository.getUser('user-0001'))?.username).toBe('alice');
  });
});

describe('InMemoryAuthRepository accounts', () => {
  let repository: InMemoryAuthRepository;

  beforeEach(async () => {
    repository = new InMemoryAuthRepository();
    await repository.saveUser(account());
    await repository.saveUser(account({ id: 'user-0002', username: 'Bob' }));
  });

  it('looks a username up case-insensitively and trims it', async () => {
    expect((await repository.findUserByUsername('ALICE'))?.id).toBe('user-0001');
    expect((await repository.findUserByUsername('  alice  '))?.id).toBe('user-0001');
    expect((await repository.findUserByUsername('bob'))?.id).toBe('user-0002');
    expect(await repository.findUserByUsername('carol')).toBeUndefined();
  });

  it('lists every account ordered by id', async () => {
    expect((await repository.listAllAccounts()).map((user) => user.id)).toEqual([
      'user-0001',
      'user-0002',
    ]);
  });

  it('finds identities case-insensitively by provider and subject', async () => {
    await repository.saveIdentity(identity());
    expect((await repository.findIdentity('password', 'ALICE'))?.userId).toBe('user-0001');
    expect(await repository.findIdentity('phone', 'alice')).toBeUndefined();
    expect((await repository.getIdentity('identity-0001'))?.subject).toBe('alice');
  });

  it('deletes an identity', async () => {
    await repository.saveIdentity(identity());
    await repository.deleteIdentity('identity-0001');
    expect(await repository.getIdentity('identity-0001')).toBeUndefined();
    expect(await repository.listIdentities('user-0001')).toHaveLength(0);
  });
});

describe('InMemoryAuthRepository one-time challenges', () => {
  let repository: InMemoryAuthRepository;

  beforeEach(() => {
    repository = new InMemoryAuthRepository();
  });

  it('returns the newest pending challenge for a destination and purpose', async () => {
    await repository.saveOtp(challenge({ id: 'otp-0001', issuedAt: '2026-09-10T00:00:00.000Z' }));
    await repository.saveOtp(challenge({ id: 'otp-0002', issuedAt: '2026-09-10T00:03:00.000Z' }));
    await repository.saveOtp(
      challenge({ id: 'otp-0003', purpose: 'recover', issuedAt: '2026-09-10T00:04:00.000Z' }),
    );
    await repository.saveOtp(
      challenge({ id: 'otp-0004', status: 'consumed', issuedAt: '2026-09-10T00:05:00.000Z' }),
    );
    expect((await repository.findPendingOtp('+8613800000000', 'sign_in'))?.id).toBe('otp-0002');
    expect((await repository.findPendingOtp('+8613800000000', 'recover'))?.id).toBe('otp-0003');
    expect(await repository.findPendingOtp('+8613900000000', 'sign_in')).toBeUndefined();
  });

  it('lists issue instants inside a window', async () => {
    await repository.saveOtp(challenge({ id: 'otp-0001', issuedAt: '2026-09-09T23:00:00.000Z' }));
    await repository.saveOtp(challenge({ id: 'otp-0002', issuedAt: '2026-09-10T00:03:00.000Z' }));
    const issued = await repository.listOtpIssuedAt(
      '+8613800000000',
      'sign_in',
      '2026-09-09T23:55:00.000Z',
    );
    expect(issued).toEqual(['2026-09-10T00:03:00.000Z']);
    expect(
      await repository.listOtpsSince('+8613800000000', 'sign_in', '2026-09-09T23:55:00.000Z'),
    ).toHaveLength(1);
  });
});

describe('InMemoryAuthRepository devices', () => {
  it('finds a device by credential fingerprint and lists newest first', async () => {
    const repository = new InMemoryAuthRepository();
    await repository.saveDevice(
      device({ id: 'device-0001', trustedAt: '2026-09-10T00:00:00.000Z' }),
    );
    await repository.saveDevice(
      device({
        id: 'device-0002',
        trustedAt: '2026-09-11T00:00:00.000Z',
        credentialFingerprint: fingerprintSecret('other'),
      }),
    );
    expect(
      (await repository.findDeviceByFingerprint(fingerprintSecret('device-credential')))?.id,
    ).toBe('device-0001');
    expect((await repository.listDevices('user-0001')).map((item) => item.id)).toEqual([
      'device-0002',
      'device-0001',
    ]);
  });
});

describe('InMemoryAuthRepository sessions', () => {
  let repository: InMemoryAuthRepository;

  beforeEach(async () => {
    repository = new InMemoryAuthRepository();
    await repository.saveSession(
      session({ id: 'session-0001', issuedAt: '2026-09-10T00:00:00.000Z' }),
    );
    await repository.saveSession(
      session({
        id: 'session-0002',
        issuedAt: '2026-09-11T00:00:00.000Z',
        tokenFingerprint: fingerprintSecret('token-2'),
        previousTokenFingerprint: fingerprintSecret('token-1'),
      }),
    );
  });

  it('finds a session by token fingerprint', async () => {
    expect((await repository.findSessionByFingerprint(fingerprintSecret('token-2')))?.id).toBe(
      'session-0002',
    );
    expect(await repository.findSessionByFingerprint(fingerprintSecret('unknown'))).toBeUndefined();
  });

  it('finds a session by its superseded token fingerprint', async () => {
    expect(
      (await repository.findSessionByPreviousFingerprint(fingerprintSecret('token-1')))?.id,
    ).toBe('session-0002');
    expect(
      await repository.findSessionByPreviousFingerprint(fingerprintSecret('unknown')),
    ).toBeUndefined();
  });

  it('lists sessions newest first and by device', async () => {
    expect((await repository.listSessionsForUser('user-0001')).map((item) => item.id)).toEqual([
      'session-0002',
      'session-0001',
    ]);
    expect((await repository.getSession('session-0001'))?.status).toBe('active');
    expect(await repository.listSessionsForDevice('device-0001')).toHaveLength(0);

    await repository.saveSession(
      session({
        id: 'session-0003',
        trustedDeviceId: 'device-0001',
        tokenFingerprint: fingerprintSecret('token-3'),
      }),
    );
    expect((await repository.listSessionsForDevice('device-0001')).map((item) => item.id)).toEqual([
      'session-0003',
    ]);
  });
});

describe('InMemoryAuthRepository store scopes', () => {
  it('returns only unrevoked scopes and revokes idempotently', async () => {
    const repository = new InMemoryAuthRepository();
    const memberId = SEEDED_MEMBERS[0]?.id ?? '';
    const tenantId = SEEDED_TENANTS[0]?.id ?? '';
    await repository.saveStoreScope({
      tenantId,
      memberId,
      storeId: 'store-a',
      isPrimary: true,
      grantedBy: null,
      grantedAt: NOW,
      revokedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await repository.listActiveStoreScopes(tenantId, memberId)).toHaveLength(1);

    await repository.revokeStoreScope(tenantId, memberId, 'store-a', NOW);
    expect(await repository.listActiveStoreScopes(tenantId, memberId)).toHaveLength(0);

    // Revoking twice is a no-op rather than an error.
    await repository.revokeStoreScope(tenantId, memberId, 'store-a', NOW);
    expect(await repository.listActiveStoreScopes(tenantId, memberId)).toHaveLength(0);
  });
});

describe('InMemoryAuthRepository member links', () => {
  it('tracks the active link of a member and of an account', async () => {
    const repository = new InMemoryAuthRepository();
    const memberId = SEEDED_MEMBERS[0]?.id ?? '';
    const link = {
      id: 'link-0001',
      userId: 'user-0001',
      tenantId: SEEDED_TENANTS[0]?.id ?? null,
      memberId,
      linkedBy: null,
      linkedAt: NOW,
      revokedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repository.saveLink(link);
    expect((await repository.getActiveLinkForMember(memberId))?.id).toBe('link-0001');
    expect((await repository.listActiveLinksForUser('user-0001')).map((item) => item.id)).toEqual([
      'link-0001',
    ]);

    await repository.saveLink({ ...link, revokedAt: NOW });
    expect(await repository.getActiveLinkForMember(memberId)).toBeUndefined();
    expect(await repository.listActiveLinksForUser('user-0001')).toHaveLength(0);
  });

  it('lists active links newest first, ties broken by descending id', async () => {
    const repository = new InMemoryAuthRepository();
    const [first, second] = SEEDED_MEMBERS;
    const older = '2026-09-01T00:00:00.000Z';
    const base = {
      userId: 'user-0001',
      tenantId: SEEDED_TENANTS[0]?.id ?? null,
      linkedBy: null,
      revokedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    // Written oldest-first, so insertion order cannot be what decides.
    await repository.saveLink({
      ...base,
      id: 'link-0001',
      memberId: first?.id ?? '',
      linkedAt: older,
    });
    await repository.saveLink({
      ...base,
      id: 'link-0002',
      memberId: second?.id ?? '',
      linkedAt: NOW,
    });
    // A revoke is not a link: it never appears.
    await repository.saveLink({
      ...base,
      id: 'link-0003',
      memberId: first?.id ?? '',
      linkedAt: NOW,
      revokedAt: NOW,
    });

    expect((await repository.listActiveLinksForUser('user-0001')).map((link) => link.id)).toEqual([
      'link-0002',
      'link-0001',
    ]);

    // Same instant: the higher id is the newer link, which is the order the
    // durable adapter's `ORDER BY linked_at DESC, id DESC` produces.
    await repository.saveLink({
      ...base,
      id: 'link-0004',
      memberId: first?.id ?? '',
      linkedAt: NOW,
    });
    expect((await repository.listActiveLinksForUser('user-0001')).map((link) => link.id)).toEqual([
      'link-0004',
      'link-0002',
      'link-0001',
    ]);
  });
});

describe('InMemoryAuthRepository trial workspaces', () => {
  /** Build the four rows a provisioning call writes, from an account. */
  function workspace(overrides: { userId?: string; tenantCode?: string } = {}) {
    return buildTrialWorkspace({
      account: account({ id: overrides.userId ?? 'user-0001' }),
      now: NOW,
      ids: {
        next: (prefix: string) => `${prefix}-0001`,
      },
    });
  }

  it('writes the tenant, store, member and link as one workspace', async () => {
    const repository = new InMemoryAuthRepository();
    const input = workspace();
    // The ids the shared generator would hand out are per-prefix, so a second
    // call would collide; the fixture uses one id per prefix on purpose.
    const result = await repository.provisionTrialWorkspace({
      ...input,
      tenant: { ...input.tenant, id: 'tenant-0001' },
      store: { ...input.store, id: 'store-0001', tenantId: 'tenant-0001' },
      member: { ...input.member, id: 'member-0001', tenantId: 'tenant-0001' },
      link: { ...input.link, id: 'link-0001', memberId: 'member-0001', tenantId: 'tenant-0001' },
    });

    expect(result.provisioned).toBe(true);
    expect((await repository.getTenant('tenant-0001'))?.code).toBe('trial-user-0001');
    expect((await repository.getStore('tenant-0001', 'store-0001'))?.code).toBe('main');
    expect((await repository.getMember('member-0001'))?.role).toBe('merchant_admin');
    expect((await repository.getActiveLinkForMember('member-0001'))?.userId).toBe('user-0001');

    const found = await repository.findTrialWorkspace('user-0001');
    expect(found?.tenant.id).toBe('tenant-0001');
    expect(found?.store?.id).toBe('store-0001');
    expect(found?.member.id).toBe('member-0001');
    expect(found?.link.id).toBe('link-0001');
  });

  it('returns the existing workspace instead of creating a second one', async () => {
    const repository = new InMemoryAuthRepository();
    const input = workspace();
    await repository.provisionTrialWorkspace({
      ...input,
      tenant: { ...input.tenant, id: 'tenant-0001' },
      store: { ...input.store, id: 'store-0001', tenantId: 'tenant-0001' },
      member: { ...input.member, id: 'member-0001', tenantId: 'tenant-0001' },
      link: { ...input.link, id: 'link-0001', memberId: 'member-0001', tenantId: 'tenant-0001' },
    });

    // Different rows, same account: the account's own workspace wins, and none
    // of the offered rows are written.
    const second = await repository.provisionTrialWorkspace(workspace({ userId: 'user-0001' }));
    expect(second.provisioned).toBe(false);
    expect(second.tenant.id).toBe('tenant-0001');
    expect(second.member.id).toBe('member-0001');
    expect(await repository.listStores('tenant-0001')).toHaveLength(1);
    expect(
      (await repository.listTenants()).filter((tenant) => tenant.code === 'trial-user-0001'),
    ).toHaveLength(1);
  });

  it('writes nothing when a row it needs is already taken', async () => {
    const repository = new InMemoryAuthRepository();
    const before = {
      tenants: await repository.listTenants(),
      stores: await repository.listStores(SEEDED_TENANTS[0]?.id ?? ''),
      members: await repository.listAllMembers(),
    };

    const input = workspace();
    // The tenant code is the account's natural key and is globally unique. A row
    // already holding it means a previous attempt wrote something this call
    // cannot complete, and the call must leave the directory exactly as it was.
    await repository.saveTenant({
      id: 'tenant-squatter',
      code: 'trial-user-0001',
      name: '已占用',
      enabled: true,
      createdAt: NOW,
    });

    await expect(
      repository.provisionTrialWorkspace({
        ...input,
        tenant: { ...input.tenant, id: 'tenant-0001' },
        store: { ...input.store, id: 'store-0001', tenantId: 'tenant-0001' },
        member: { ...input.member, id: 'member-0001', tenantId: 'tenant-0001' },
        link: { ...input.link, id: 'link-0001', memberId: 'member-0001', tenantId: 'tenant-0001' },
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    // No tenant, no store, no member and no link were added by the failed call.
    expect(await repository.getTenant('tenant-0001')).toBeUndefined();
    expect(await repository.getMember('member-0001')).toBeUndefined();
    expect(await repository.listActiveLinksForUser('user-0001')).toEqual([]);
    expect(
      (await repository.listTenants()).filter((tenant) => tenant.id !== 'tenant-squatter'),
    ).toEqual(before.tenants);
    expect(await repository.listAllMembers()).toEqual(before.members);
    expect(await repository.listStores(SEEDED_TENANTS[0]?.id ?? '')).toEqual(before.stores);
  });

  it('never treats a platform administrator member as a workspace', async () => {
    const repository = new InMemoryAuthRepository();
    const link = {
      id: 'link-platform',
      userId: 'user-0001',
      tenantId: null,
      memberId: SEEDED_PLATFORM_ADMIN_MEMBER_ID,
      linkedBy: null,
      linkedAt: NOW,
      revokedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repository.saveLink(link);
    expect(await repository.findTrialWorkspace('user-0001')).toBeUndefined();
  });

  it('reads a hand-built workspace as the account’s own', async () => {
    const repository = new InMemoryAuthRepository();
    const tenantId = SEEDED_TENANTS[0]?.id ?? '';
    // A tenant-wide member: no home store, so the workspace starts in the
    // tenant's first store rather than in none.
    await repository.saveLink({
      id: 'link-0001',
      userId: 'user-0001',
      tenantId,
      memberId: 'u-t1-admin',
      linkedBy: null,
      linkedAt: NOW,
      revokedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const found = await repository.findTrialWorkspace('user-0001');
    expect(found?.tenant.id).toBe(tenantId);
    expect(found?.member.id).toBe('u-t1-admin');
    expect(found?.store?.id).toBe('store-acme-distribution');
  });

  it('restores a storeless trial tenant under the tenant the account already owns', async () => {
    const repository = new InMemoryAuthRepository();
    const input = workspace();

    // What a previous provisioning left behind, under the ids that attempt
    // generated: the tenant, its merchant administrator and the link. The link was
    // revoked and the tenant's only store was removed afterwards, so the account
    // has no workspace at all while its own directory is still there — the state
    // the restore branch exists to recover.
    await repository.saveTenant({ ...input.tenant, id: 'tenant-existing' });
    await repository.saveMember({
      ...input.member,
      id: 'member-existing',
      tenantId: 'tenant-existing',
    });
    await repository.saveLink({
      ...input.link,
      id: 'link-existing',
      tenantId: 'tenant-existing',
      memberId: 'member-existing',
      revokedAt: NOW,
    });

    const restored = await repository.provisionTrialWorkspace(input);

    expect(restored.provisioned).toBe(true);
    expect(restored.tenant.id).toBe('tenant-existing');
    expect(restored.member.id).toBe('member-existing');
    // The store this retry creates belongs to the tenant that already exists. The
    // tenant id this attempt generated names a tenant that was never written, so a
    // store filed under it would belong to no tenant at all.
    expect(restored.store?.id).toBe('store-0001');
    expect(restored.store?.tenantId).toBe('tenant-existing');
    expect(await repository.listStores('tenant-0001')).toEqual([]);
    expect(await repository.listStores('tenant-existing')).toHaveLength(1);

    // The restore is readable: a store filed under an id no tenant owns would
    // leave the account looking storeless for every later request.
    const found = await repository.findTrialWorkspace('user-0001');
    expect(found?.tenant.id).toBe('tenant-existing');
    expect(found?.store?.id).toBe('store-0001');
    expect(found?.store?.code).toBe('main');
    expect(found?.store?.tenantId).toBe('tenant-existing');

    // A retry writes no second store.
    const again = await repository.provisionTrialWorkspace(input);
    expect(again.provisioned).toBe(false);
    expect(again.store?.id).toBe('store-0001');
    expect(await repository.listStores('tenant-existing')).toHaveLength(1);
  });

  it('refuses a storeless restore another account holds without writing its store', async () => {
    const repository = new InMemoryAuthRepository();
    const input = workspace();
    await repository.saveTenant({ ...input.tenant, id: 'tenant-existing' });
    await repository.saveMember({
      ...input.member,
      id: 'member-existing',
      tenantId: 'tenant-existing',
    });
    // The administrator hands the membership to a second account while the tenant
    // still has no store of its own.
    await repository.saveLink({
      id: 'link-0002',
      userId: 'user-0002',
      tenantId: 'tenant-existing',
      memberId: 'member-existing',
      linkedBy: null,
      linkedAt: NOW,
      revokedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(repository.provisionTrialWorkspace(input)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });

    // The refusal is decided before the store is written, so the directory is left
    // exactly as it was — in particular with no store row anywhere.
    expect(await repository.listStores('tenant-existing')).toEqual([]);
    expect(await repository.listStores('tenant-0001')).toEqual([]);
    expect(await repository.getStore('tenant-existing', 'store-0001')).toBeUndefined();
    expect((await repository.getActiveLinkForMember('member-existing'))?.userId).toBe('user-0002');
    expect(await repository.findTrialWorkspace('user-0001')).toBeUndefined();
  });
});

describe('InMemoryAuthRepository directory mirror', () => {
  /** Build the four rows a provisioning call writes, from an account. */
  function workspace(overrides: { userId?: string } = {}) {
    return buildTrialWorkspace({
      account: account({ id: overrides.userId ?? 'user-0001' }),
      now: NOW,
      ids: {
        next: (prefix: string) => `${prefix}-0001`,
      },
    });
  }

  /** Pin the fixture's ids so two calls in one test cannot collide. */
  function input() {
    const built = workspace();
    return {
      ...built,
      tenant: { ...built.tenant, id: 'tenant-0001' },
      store: { ...built.store, id: 'store-0001', tenantId: 'tenant-0001' },
      member: { ...built.member, id: 'member-0001', tenantId: 'tenant-0001' },
      link: { ...built.link, id: 'link-0001', memberId: 'member-0001', tenantId: 'tenant-0001' },
    };
  }

  it('publishes a provisioned workspace into the mirror it was given', async () => {
    const store = new KefuStore();
    const repository = new InMemoryAuthRepository(true, store);

    await repository.provisionTrialWorkspace(input());

    // This is what the platform business surfaces read: a request whose bearer
    // session names the trial tenant must find that tenant, its store and its
    // member in the platform directory, not only in the auth directory.
    expect(store.getTenant('tenant-0001')?.code).toBe('trial-user-0001');
    expect(store.getStore('tenant-0001', 'store-0001')?.code).toBe('main');
    expect(store.getMember('member-0001')?.role).toBe('merchant_admin');
    expect(store.listMembers('tenant-0001').map((member) => member.id)).toEqual(['member-0001']);
  });

  it('replays a mirrored write as an upsert rather than a second row', async () => {
    const store = new KefuStore();
    const repository = new InMemoryAuthRepository(true, store);
    const rows = input();
    const tenantsBefore = store.listTenants().length;

    await repository.saveTenant(rows.tenant);
    await repository.saveTenant(rows.tenant);
    await repository.saveStore(rows.store);
    await repository.saveStore(rows.store);
    await repository.saveMember(rows.member);
    await repository.saveMember(rows.member);

    expect(store.listTenants()).toHaveLength(tenantsBefore + 1);
    expect(store.listStores('tenant-0001')).toHaveLength(1);
    expect(store.listMembers('tenant-0001')).toHaveLength(1);
  });

  it('leaves the mirror’s seed alone, because both directories already hold it', async () => {
    const store = new KefuStore();
    const before = {
      tenants: store.listTenants().length,
      stores: store.listStores(SEEDED_TENANTS[0]?.id ?? '').length,
      members: store.listMembers(SEEDED_TENANTS[0]?.id ?? '').length,
    };

    const repository = new InMemoryAuthRepository(true, store);

    expect(store.listTenants()).toHaveLength(before.tenants);
    expect(store.listStores(SEEDED_TENANTS[0]?.id ?? '')).toHaveLength(before.stores);
    expect(store.listMembers(SEEDED_TENANTS[0]?.id ?? '')).toHaveLength(before.members);

    // The mirror also receives the re-activation of an existing row, and that is
    // still one row: the account keeps the membership it already had.
    const rows = input();
    await repository.provisionTrialWorkspace(rows);
    await repository.saveLink({ ...rows.link, revokedAt: NOW });
    await repository.provisionTrialWorkspace(rows);
    expect(store.listMembers('tenant-0001')).toHaveLength(1);
  });

  it('provisions without a mirror, so a direct construction still works', async () => {
    const repository = new InMemoryAuthRepository();

    const result = await repository.provisionTrialWorkspace(input());

    expect(result.provisioned).toBe(true);
    expect((await repository.getTenant('tenant-0001'))?.code).toBe('trial-user-0001');
  });

  it('refuses to re-activate a membership another account is actively holding', async () => {
    const repository = new InMemoryAuthRepository();
    const rows = input();
    await repository.provisionTrialWorkspace(rows);
    // The administrator revokes the account's link, then links that same member
    // to somebody else. Only one account may hold a membership at a time.
    await repository.saveLink({ ...rows.link, revokedAt: NOW });
    await repository.saveLink({
      ...rows.link,
      id: 'link-0002',
      userId: 'user-0002',
      linkedAt: NOW,
      revokedAt: null,
    });

    await expect(repository.provisionTrialWorkspace(rows)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });

    // The refusal changed nothing: the other account still holds the membership
    // and the refused account still has an inactive row for it.
    expect((await repository.getActiveLinkForMember('member-0001'))?.userId).toBe('user-0002');
    expect(await repository.findTrialWorkspace('user-0001')).toBeUndefined();
  });
});

describe('resolveAuthStorageMode', () => {
  it('honours an explicit mode in every environment', () => {
    expect(resolveAuthStorageMode('production', 'memory')).toBe('memory');
    expect(resolveAuthStorageMode('test', 'postgres')).toBe('postgres');
  });

  it('defaults to memory in test and postgres elsewhere', () => {
    expect(resolveAuthStorageMode('test', 'auto')).toBe('memory');
    expect(resolveAuthStorageMode('local', 'auto')).toBe('postgres');
    expect(resolveAuthStorageMode('production', 'auto')).toBe('postgres');
  });
});
