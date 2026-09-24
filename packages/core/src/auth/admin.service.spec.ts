import { beforeEach, describe, expect, it } from 'vitest';
import { assertPlatformAdmin, assertTenantAdmin, AuthAdminService } from './admin.service';
import { AuthService } from './auth.service';
import { buildAccessContext, type AccessResolutionInput } from './access-context';
import { FixedAuthClock, SequentialAuthIdGenerator } from './clock';
import { isAuthError } from './errors';
import { InMemoryAuthRepository } from './memory-repository';
import { LocalOidcProvider, LocalOtpProvider } from './providers';
import { DEFAULT_AUTH_POLICY } from './policy';
import { TRIAL_STORE_CODE, TRIAL_STORE_NAME } from './trial-workspace';
import {
  SEEDED_MEMBERS,
  SEEDED_PLATFORM_ADMIN_MEMBER_ID,
  SEEDED_STORES,
  SEEDED_TENANTS,
} from './directory-seed';
import type { Member, Store, Tenant } from '../platform/types';
import type { AccessContext, AuthSession, MemberUserLink } from './types';

const START = '2026-09-10T00:00:00.000Z';
const PHONE = '+8613800000000';
const PASSWORD = 'correct-horse-battery-staple';
const ACME = SEEDED_TENANTS[0]?.id ?? '';
const BETA = SEEDED_TENANTS[1]?.id ?? '';

/** One of ACME's stores, found by its code so a renamed id cannot pass silently. */
function storeId(code: string): string {
  return SEEDED_STORES.find((store) => store.tenantId === ACME && store.code === code)?.id ?? '';
}

const FLAGSHIP = storeId('flagship');
const DISTRIBUTION = storeId('distribution');

type Harness = {
  readonly repository: InMemoryAuthRepository;
  readonly otpProvider: LocalOtpProvider;
  readonly clock: FixedAuthClock;
  readonly auth: AuthService;
  readonly admin: AuthAdminService;
};

function harness(): Harness {
  const repository = new InMemoryAuthRepository();
  const otpProvider = new LocalOtpProvider();
  const clock = new FixedAuthClock(START);
  const ids = new SequentialAuthIdGenerator();
  const auth = new AuthService({
    repository,
    otpProvider,
    oidcProvider: new LocalOidcProvider(),
    clock,
    ids,
    policy: DEFAULT_AUTH_POLICY,
  });
  const admin = new AuthAdminService({ repository, clock, ids });
  return { repository, otpProvider, clock, auth, admin };
}

/**
 * Register an account through the real workflow and return its session.
 *
 * Registration stops at `pending`: it is an application to serve, and it leaves
 * the account holding no tenant, store or member. These tests are about what an
 * administrator does *after* that gate, so the fixture carries the account
 * through it.
 *
 * It uses `enableAccount` rather than `approveAccount` deliberately. Approval
 * creates the agent member it links the account to, and half of these tests are
 * about members the test itself creates — an approval in the fixture would put a
 * second member in the tenant and change what `listMembers` answers. Enabling
 * moves the account's own lifecycle and nothing else, which is exactly the
 * precondition these tests used to get for free.
 */
async function registerAccount(h: Harness, subject = PHONE, username = 'alice') {
  const issued = await registerPending(h, subject, username);
  await h.admin.enableAccount(PLATFORM_ADMIN(), issued.access.userId);
  return issued;
}

/**
 * Register and stop exactly where registration stops: `pending`, and an applicant.
 *
 * The counterpart of {@link registerAccount}, for the tests whose subject *is* the
 * approval decision — they need an account an administrator may still approve,
 * and approving anything else is refused on purpose.
 */
async function registerPending(h: Harness, subject = PHONE, username = 'alice') {
  await h.auth.sendOtp({ subject, channel: 'sms', purpose: 'sign_in' });
  const code = h.otpProvider.lastDeliveryFor(subject)?.code ?? '';
  return h.auth.register({
    subject,
    channel: 'sms',
    code,
    username,
    displayName: 'Alice',
    password: PASSWORD,
  });
}

/** A member row for a test that needs one the seed does not provide. */
function memberFixture(id: string, storeId: string): Member {
  return {
    id,
    tenantId: ACME,
    storeId,
    role: 'agent',
    username: id,
    displayName: id,
    enabled: true,
    createdAt: START,
  };
}

/** Switch every store of the tenant off, the state a fresh deployment starts in. */
async function disableEveryStore(h: Harness): Promise<void> {
  for (const store of await h.repository.listStores(ACME)) {
    await h.repository.saveStore({ ...store, enabled: false });
  }
}

/**
 * Read back a member by the id an admin view reported.
 *
 * The views answer with `memberId`, not the row, and the row is what carries the
 * store — which is the whole question in the approval cases below.
 */
async function memberById(h: Harness, memberId: string | null): Promise<Member> {
  const member = (await h.repository.listMembers(ACME)).find(
    (candidate) => candidate.id === memberId,
  );
  if (member === undefined) {
    throw new Error(`no member ${String(memberId)} in ${ACME}`);
  }
  return member;
}

/** Switch seeded agents off, which is how a test staffs a different store. */
async function retireAgents(h: Harness, ids: ReadonlyArray<string>): Promise<void> {
  for (const id of ids) {
    const member = await h.repository.getMember(id);
    if (member === undefined) {
      throw new Error(`the seed no longer carries member ${id}`);
    }
    await h.repository.saveMember({ ...member, enabled: false });
  }
}

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    id: 'session-context',
    userId: 'user-context',
    tenantId: null,
    memberId: null,
    trustedDeviceId: null,
    tokenFingerprint: 'f'.repeat(64),
    previousTokenFingerprint: null,
    rotationFamilyId: 'family-context',
    authMethod: 'password',
    status: 'active',
    mfaSatisfied: false,
    clientFingerprint: null,
    idempotencyKey: null,
    issuedAt: START,
    expiresAt: '2026-09-10T12:00:00.000Z',
    lastSeenAt: START,
    revokedAt: null,
    revokedReason: null,
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

/**
 * One active link written straight into the repository.
 *
 * The account-projection tests need control the `linkMember` workflow does not
 * give them: an exact `linkedAt`, an exact link id, and an insertion order that
 * is *not* chronological. Writing the row directly is the only way to build
 * those fixtures.
 *
 * @param id - Link id, which also decides ties.
 * @param userId - Account the link belongs to.
 * @param memberId - Member the link points at.
 * @param tenantId - Tenant recorded on the link itself.
 * @param linkedAt - Instant the link was made.
 * @returns The link row.
 */
function linkRow(
  id: string,
  userId: string,
  memberId: string,
  tenantId: string | null,
  linkedAt: string,
): MemberUserLink {
  return {
    id,
    userId,
    tenantId,
    memberId,
    linkedBy: null,
    linkedAt,
    revokedAt: null,
    createdAt: linkedAt,
    updatedAt: linkedAt,
  };
}

function memberOf(id: string) {
  const member = SEEDED_MEMBERS.find((candidate) => candidate.id === id);
  if (member === undefined) {
    throw new Error(`seeded member ${id} is missing`);
  }
  return member;
}

/** Access context of one member record, as the guard would resolve it. */
function contextOfMember(member: Member): AccessContext {
  const input: AccessResolutionInput = {
    session: session(),
    accountStatus: 'active',
    member,
    tenant:
      member.tenantId === null
        ? null
        : (SEEDED_TENANTS.find((tenant) => tenant.id === member.tenantId) ?? null),
    link: { id: `link-${member.id}` },
    storeScopes: [],
    tenantStores: [],
  };
  return buildAccessContext(input);
}

/** Access context of a seeded member, as the guard would resolve it. */
function contextFor(memberId: string): AccessContext {
  return contextOfMember(memberOf(memberId));
}

const PLATFORM_ADMIN = () => contextFor(SEEDED_PLATFORM_ADMIN_MEMBER_ID);
const ACME_ADMIN = () => contextFor('u-t1-admin');
const ACME_AGENT = () => contextFor('u-t1-agent-1');
const BETA_ADMIN = () => contextFor('u-t2-admin');

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected a ${code} failure`);
  } catch (error) {
    expect(isAuthError(error)).toBe(true);
    if (isAuthError(error)) {
      expect(error.code).toBe(code);
    }
  }
}

/** Synchronous counterpart of {@link expectCode}, for the assertion helpers. */
function expectThrowCode(action: () => unknown, code: string): void {
  try {
    action();
    expect.unreachable(`expected a ${code} failure`);
  } catch (error) {
    expect(isAuthError(error)).toBe(true);
    if (isAuthError(error)) {
      expect(error.code).toBe(code);
    }
  }
}

/**
 * Access context of a tenant-scoped `platform_admin`.
 *
 * The member row this builds is the one the platform invariant forbids and
 * migration `0005` rejects: the platform role held *inside* a tenant. It is
 * written straight into the repository because the service can no longer mint
 * it, and the context is then derived by the real session resolution, so the
 * test drives exactly the context the HTTP guard would hand to the service.
 *
 * @param h - Harness to build the rogue identity in.
 * @returns The rogue context and the account id it acts through.
 */
async function roguePlatformAdmin(
  h: Harness,
): Promise<{ readonly userId: string; readonly access: AccessContext }> {
  const registered = await registerAccount(h);
  // The account holds no link of its own, so the rogue row below is the link its
  // session actually resolves to — the test asserts against the contradiction it
  // is about rather than against a membership registration handed out.
  await h.repository.saveMember({
    id: 'u-rogue-admin',
    tenantId: ACME,
    storeId: null,
    role: 'platform_admin',
    username: 'rogue-admin',
    displayName: '越权管理员',
    enabled: true,
    createdAt: START,
  });
  await h.repository.saveLink({
    id: 'link-rogue-admin',
    userId: registered.access.userId,
    tenantId: ACME,
    memberId: 'u-rogue-admin',
    linkedBy: null,
    linkedAt: START,
    revokedAt: null,
    createdAt: START,
    updatedAt: START,
  });
  const resolved = await h.auth.resolveSession(registered.token);
  return { userId: registered.access.userId, access: resolved.access };
}

describe('authorization assertions', () => {
  it('requires platform administrator privileges to administer the platform', () => {
    expect(() => assertPlatformAdmin(PLATFORM_ADMIN())).not.toThrow();
    expect(() => assertPlatformAdmin(ACME_ADMIN())).toThrow();
    expect(() => assertPlatformAdmin(ACME_AGENT())).toThrow();
  });

  it('lets a tenant administrator reach only their own tenant', () => {
    expect(() => assertTenantAdmin(PLATFORM_ADMIN(), ACME)).not.toThrow();
    expect(() => assertTenantAdmin(ACME_ADMIN(), ACME)).not.toThrow();
    expect(() => assertTenantAdmin(BETA_ADMIN(), ACME)).toThrow();
    expect(() => assertTenantAdmin(ACME_AGENT(), ACME)).toThrow();
    expect(() => assertTenantAdmin(ACME_ADMIN(), null)).toThrow();
  });

  it('refuses a platform administrator whose member belongs to a tenant', async () => {
    const scoped = contextOfMember({
      ...memberOf(SEEDED_PLATFORM_ADMIN_MEMBER_ID),
      tenantId: ACME,
    });
    // The member record claims the platform role, so nothing but the tenant
    // context can refuse it — which is exactly the invariant that stops tenant
    // administration from becoming platform authority.
    expect(scoped.role).toBe('platform_admin');
    expect(scoped.tenantId).toBe(ACME);
    await expectCode((async () => assertPlatformAdmin(scoped))(), 'access_denied');
  });
});

describe('AuthAdminService tenants', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('lists every tenant for a platform administrator and one for a tenant administrator', async () => {
    expect(await h.admin.listTenants(PLATFORM_ADMIN())).toHaveLength(SEEDED_TENANTS.length);
    const scoped = await h.admin.listTenants(ACME_ADMIN());
    expect(scoped.map((tenant) => tenant.id)).toEqual([ACME]);
  });

  // The two write endpoints are frozen in this deployment, and the assertions
  // below are about the *refusal* rather than about what it used to do. They are
  // deliberately keyed on the same answer for every argument: a differing answer
  // would read as a working endpoint with one broken case, and a later reader
  // would try to fix that case.
  it('refuses to create a second organisation, whatever the body says', async () => {
    const bodies = [
      { code: 'gamma', name: '伽马科技' },
      { code: 'ACME', name: 'Duplicate' },
      { code: 'gamma', name: '   ' },
      { code: '', name: '' },
    ];
    for (const body of bodies) {
      await expectCode(h.admin.createTenant(PLATFORM_ADMIN(), body), 'access_denied');
    }
    expect(await h.repository.listTenants()).toHaveLength(SEEDED_TENANTS.length);
  });

  it('refuses to create one for a tenant administrator too, and for the same reason', async () => {
    // Role is checked first, so the answer here names the caller; the guard above
    // is what the refusal is really about, and it holds for anyone who gets past.
    await expectCode(
      h.admin.createTenant(ACME_ADMIN(), { code: 'gamma', name: '伽马科技' }),
      'access_denied',
    );
  });

  it('refuses to switch the organisation off or on', async () => {
    for (const enabled of [false, true]) {
      await expectCode(h.admin.setTenantEnabled(PLATFORM_ADMIN(), ACME, enabled), 'access_denied');
    }
    await expectCode(
      h.admin.setTenantEnabled(PLATFORM_ADMIN(), 'tenant-does-not-exist', false),
      'access_denied',
    );
    // The row is untouched, which is the whole point: the console still loads.
    expect((await h.repository.getTenant(ACME))?.enabled).toBe(true);
  });
});

describe('AuthAdminService stores', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('creates a store inside the caller’s tenant', async () => {
    const store = await h.admin.createStore(ACME_ADMIN(), {
      tenantId: ACME,
      code: 'outlet',
      name: '云集奥莱店',
    });
    expect(store.tenantId).toBe(ACME);
    expect(await h.admin.listStores(ACME_ADMIN(), ACME)).toHaveLength(3);
  });

  it('refuses a store in another tenant', async () => {
    await expectCode(
      h.admin.createStore(BETA_ADMIN(), { tenantId: ACME, code: 'outlet', name: '云集奥莱店' }),
      'access_denied',
    );
  });

  it('refuses a duplicate store code', async () => {
    await expectCode(
      h.admin.createStore(ACME_ADMIN(), { tenantId: ACME, code: 'FLAGSHIP', name: '重复' }),
      'identity_conflict',
    );
  });

  it('refuses a store for an unknown tenant', async () => {
    await expectCode(
      h.admin.createStore(PLATFORM_ADMIN(), {
        tenantId: 'tenant-does-not-exist',
        code: 'outlet',
        name: '云集奥莱店',
      }),
      'identity_not_bound',
    );
  });

  it('disables a store', async () => {
    const stores = await h.admin.listStores(ACME_ADMIN(), ACME);
    const target = stores[0];
    if (target === undefined) {
      throw new Error('the tenant has no seeded store');
    }
    await h.admin.setStoreEnabled(ACME_ADMIN(), target.id, false);
    expect((await h.repository.findStoreById(target.id))?.enabled).toBe(false);
  });

  it('rejects an unknown store', async () => {
    await expectCode(
      h.admin.setStoreEnabled(PLATFORM_ADMIN(), 'store-does-not-exist', false),
      'identity_not_bound',
    );
  });
});

describe('AuthAdminService members', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('creates a member scoped to a store of the tenant', async () => {
    const stores = await h.admin.listStores(ACME_ADMIN(), ACME);
    const store = stores[0];
    const member = await h.admin.createMember(ACME_ADMIN(), {
      tenantId: ACME,
      storeId: store?.id ?? null,
      role: 'agent',
      username: 'agent-03',
      displayName: '客服小新',
    });
    expect(member.role).toBe('agent');
    expect((await h.repository.getMember(member.id))?.storeId).toBe(store?.id);
  });

  it('refuses a store that belongs to another tenant', async () => {
    const betaStores = await h.admin.listStores(BETA_ADMIN(), SEEDED_TENANTS[1]?.id ?? '');
    await expectCode(
      h.admin.createMember(ACME_ADMIN(), {
        tenantId: ACME,
        storeId: betaStores[0]?.id ?? null,
        role: 'agent',
        username: 'agent-03',
        displayName: '客服小新',
      }),
      'identity_not_bound',
    );
  });

  it('refuses an unknown role', async () => {
    await expectCode(
      h.admin.createMember(ACME_ADMIN(), {
        tenantId: ACME,
        storeId: null,
        role: 'superuser' as never,
        username: 'agent-03',
        displayName: '客服小新',
      }),
      'invalid_request',
    );
  });

  it('changes a role', async () => {
    await h.admin.setMemberRole(ACME_ADMIN(), 'u-t1-agent-1', 'merchant_admin');
    expect((await h.repository.getMember('u-t1-agent-1'))?.role).toBe('merchant_admin');
    await expectCode(
      h.admin.setMemberRole(ACME_ADMIN(), 'u-t1-agent-1', 'root' as never),
      'invalid_request',
    );
  });

  it('disables a member', async () => {
    await h.admin.setMemberEnabled(ACME_ADMIN(), 'u-t1-agent-1', false);
    expect((await h.repository.getMember('u-t1-agent-1'))?.enabled).toBe(false);
  });

  it('refuses to administer another tenant’s member', async () => {
    await expectCode(
      h.admin.setMemberEnabled(BETA_ADMIN(), 'u-t1-agent-1', false),
      'access_denied',
    );
    await expectCode(h.admin.listMembers(BETA_ADMIN(), ACME), 'access_denied');
    await expectCode(
      h.admin.setMemberRole(ACME_AGENT(), 'u-t1-agent-2', 'merchant_admin'),
      'access_denied',
    );
  });

  it('rejects an unknown member', async () => {
    await expectCode(
      h.admin.setMemberEnabled(PLATFORM_ADMIN(), 'u-does-not-exist', false),
      'identity_not_bound',
    );
  });

  it('refuses to create a platform administrator inside a tenant', async () => {
    await expectCode(
      h.admin.createMember(ACME_ADMIN(), {
        tenantId: ACME,
        storeId: null,
        role: 'platform_admin',
        username: 'rogue-admin',
        displayName: '越权管理员',
      }),
      'access_denied',
    );
    // Nothing was persisted: the tenant directory is exactly as it was seeded.
    const members = await h.admin.listMembers(ACME_ADMIN(), ACME);
    expect(members).toHaveLength(3);
    expect(members.some((member) => member.role === 'platform_admin')).toBe(false);
  });

  it('refuses to promote a tenant member to platform administrator', async () => {
    await expectCode(
      h.admin.setMemberRole(ACME_ADMIN(), 'u-t1-agent-1', 'platform_admin'),
      'access_denied',
    );
    expect((await h.repository.getMember('u-t1-agent-1'))?.role).toBe('agent');
    await expectCode(
      h.admin.setMemberRole(BETA_ADMIN(), 'u-t1-agent-1', 'platform_admin'),
      'access_denied',
    );
  });

  it('lets a platform administrator create a platform member with no tenant or store', async () => {
    const member = await h.admin.createMember(PLATFORM_ADMIN(), {
      tenantId: null,
      storeId: null,
      role: 'platform_admin',
      username: 'root-2',
      displayName: '平台管理员二',
    });
    expect(member.role).toBe('platform_admin');
    expect(member.tenantId).toBeNull();
    expect((await h.repository.getMember(member.id))?.storeId).toBeNull();
  });

  it('rejects a role and tenant combination the platform does not define', async () => {
    // A platform administrator is platform-level; an administrator of a tenant
    // is not a platform administrator. Both halves of the invariant are
    // enforced before anything is persisted.
    await expectCode(
      h.admin.createMember(PLATFORM_ADMIN(), {
        tenantId: ACME,
        storeId: null,
        role: 'platform_admin',
        username: 'rogue-admin',
        displayName: '越权管理员',
      }),
      'invalid_request',
    );
    await expectCode(
      h.admin.createMember(PLATFORM_ADMIN(), {
        tenantId: null,
        storeId: null,
        role: 'merchant_admin',
        username: 'tenantless-admin',
        displayName: '无租户管理员',
      }),
      'invalid_request',
    );
    await expectCode(
      h.admin.setMemberRole(PLATFORM_ADMIN(), SEEDED_PLATFORM_ADMIN_MEMBER_ID, 'merchant_admin'),
      'invalid_request',
    );
    expect((await h.repository.getMember(SEEDED_PLATFORM_ADMIN_MEMBER_ID))?.role).toBe(
      'platform_admin',
    );
  });
});

describe('AuthAdminService member linkage', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('links an account to a member and activates its access', async () => {
    const registered = await registerAccount(h);
    expect((await h.auth.resolveSession(registered.token)).access.accessState).toBe(
      'pending_config',
    );

    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: SEEDED_PLATFORM_ADMIN_MEMBER_ID,
    });

    const resolved = await h.auth.resolveSession(registered.token);
    expect(resolved.access.accessState).toBe('active');
    expect(resolved.access.tenantId).toBe(ACME);
    expect(resolved.access.role).toBe('agent');
    expect(resolved.access.member?.id).toBe('u-t1-agent-1');
    // The linked seat reaches the whole enabled tenant, not just its own store.
    expect(resolved.access.authorizedStoreIds).toEqual([
      'store-acme-distribution',
      'store-acme-flagship',
    ]);
  });

  it('is idempotent for the same account and member', async () => {
    const registered = await registerAccount(h);
    const first = await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });
    const second = await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });
    expect(second.id).toBe(first.id);
  });

  it('moves a member from one account to another and revokes the old one', async () => {
    const first = await registerAccount(h);
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: first.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });

    h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    const second = await registerAccount(h, '+8613900000000', 'bob');
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: second.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });

    // The first account's sessions carried the old member binding, so moving
    // the member revokes them rather than leaving a stale tenant binding alive.
    await expectCode(h.auth.resolveSession(first.token), 'session_revoked');
    expect((await h.repository.getActiveLinkForMember('u-t1-agent-1'))?.userId).toBe(
      second.access.userId,
    );

    // Signing in again lands on pending_config: the account is intact but no
    // longer holds a member.
    const fresh = await h.auth.loginWithPassword({ username: 'alice', password: PASSWORD });
    expect(fresh.access.accessState).toBe('pending_config');
    expect(fresh.access.tenantId).toBeNull();
  });

  it('refuses to link an unknown account or member', async () => {
    const registered = await registerAccount(h);
    await expectCode(
      h.admin.linkMember(PLATFORM_ADMIN(), {
        userId: 'user-does-not-exist',
        memberId: 'u-t1-agent-1',
        linkedBy: null,
      }),
      'identity_not_bound',
    );
    await expectCode(
      h.admin.linkMember(PLATFORM_ADMIN(), {
        userId: registered.access.userId,
        memberId: 'u-does-not-exist',
        linkedBy: null,
      }),
      'identity_not_bound',
    );
  });

  it('revokes a link, returning the account to pending_config', async () => {
    const registered = await registerAccount(h);
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });
    const revoked = await h.admin.revokeLink(PLATFORM_ADMIN(), 'u-t1-agent-1');
    expect(revoked?.revokedAt).not.toBeNull();

    const resolved = await h.auth.resolveSession(registered.token);
    expect(resolved.access.accessState).toBe('pending_config');
    expect(await h.admin.revokeLink(PLATFORM_ADMIN(), 'u-t1-agent-1')).toBeNull();
  });

  it('refuses to link a member of another tenant', async () => {
    const registered = await registerAccount(h);
    await expectCode(
      h.admin.linkMember(BETA_ADMIN(), {
        userId: registered.access.userId,
        memberId: 'u-t1-agent-1',
        linkedBy: null,
      }),
      'access_denied',
    );
  });

  it('keeps link and member administration inside the caller’s own tenant', async () => {
    const registered = await registerAccount(h);
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });

    await expectCode(h.admin.revokeLink(BETA_ADMIN(), 'u-t1-agent-1'), 'access_denied');
    await expectCode(
      h.admin.setMemberEnabled(BETA_ADMIN(), 'u-t1-agent-1', false),
      'access_denied',
    );

    // The refused calls changed nothing: the link is intact and the member is
    // still enabled for its own tenant.
    expect((await h.repository.getActiveLinkForMember('u-t1-agent-1'))?.userId).toBe(
      registered.access.userId,
    );
    expect((await h.repository.getMember('u-t1-agent-1'))?.enabled).toBe(true);
  });
});

describe('AuthAdminService store scopes', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('narrows a member to the stores it was granted', async () => {
    const registered = await registerAccount(h);
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t1-admin',
      linkedBy: null,
    });

    let resolved = await h.auth.resolveSession(registered.token);
    expect(resolved.access.authorizedStoreIds).toEqual([
      'store-acme-distribution',
      'store-acme-flagship',
    ]);

    await h.admin.grantStoreScope(PLATFORM_ADMIN(), {
      tenantId: ACME,
      memberId: 'u-t1-admin',
      storeId: 'store-acme-distribution',
      isPrimary: true,
      grantedBy: SEEDED_PLATFORM_ADMIN_MEMBER_ID,
    });
    resolved = await h.auth.resolveSession(registered.token);
    expect(resolved.access.authorizedStoreIds).toEqual(['store-acme-distribution']);
  });

  it('keeps at most one primary scope per member', async () => {
    await h.admin.grantStoreScope(PLATFORM_ADMIN(), {
      tenantId: ACME,
      memberId: 'u-t1-admin',
      storeId: 'store-acme-flagship',
      isPrimary: true,
      grantedBy: null,
    });
    await h.admin.grantStoreScope(PLATFORM_ADMIN(), {
      tenantId: ACME,
      memberId: 'u-t1-admin',
      storeId: 'store-acme-distribution',
      isPrimary: true,
      grantedBy: null,
    });
    const scopes = await h.admin.listStoreScopes(PLATFORM_ADMIN(), 'u-t1-admin');
    expect(scopes.filter((scope) => scope.isPrimary).map((scope) => scope.storeId)).toEqual([
      'store-acme-distribution',
    ]);
  });

  it('revokes a scope', async () => {
    await h.admin.grantStoreScope(PLATFORM_ADMIN(), {
      tenantId: ACME,
      memberId: 'u-t1-admin',
      storeId: 'store-acme-distribution',
      grantedBy: null,
    });
    await expect(
      h.admin.revokeStoreScope(PLATFORM_ADMIN(), 'u-t1-admin', 'store-acme-distribution'),
    ).resolves.toEqual({ revoked: true });
    expect(await h.admin.listStoreScopes(PLATFORM_ADMIN(), 'u-t1-admin')).toHaveLength(0);
    await expect(
      h.admin.revokeStoreScope(PLATFORM_ADMIN(), 'u-t1-admin', 'store-acme-distribution'),
    ).resolves.toEqual({ revoked: false });
  });

  it('refuses a store of another tenant', async () => {
    await expectCode(
      h.admin.grantStoreScope(ACME_ADMIN(), {
        tenantId: ACME,
        memberId: 'u-t1-admin',
        storeId: 'store-beta-official',
        grantedBy: null,
      }),
      'identity_not_bound',
    );
    await expectCode(
      h.admin.grantStoreScope(ACME_ADMIN(), {
        tenantId: ACME,
        memberId: 'u-t2-admin',
        storeId: 'store-acme-flagship',
        grantedBy: null,
      }),
      'access_denied',
    );
  });
});

describe('AuthAdminService accounts', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('disables an account and revokes its sessions', async () => {
    const registered = await registerAccount(h);
    const extra = await h.auth.loginWithPassword({ username: 'alice', password: PASSWORD });

    const result = await h.admin.disableAccount(PLATFORM_ADMIN(), registered.access.userId);
    expect(result.revokedSessions).toBe(2);
    expect((await h.repository.getUser(registered.access.userId))?.status).toBe('disabled');
    await expectCode(h.auth.resolveSession(registered.token), 'account_disabled');
    await expectCode(h.auth.resolveSession(extra.token), 'account_disabled');
    await expectCode(
      h.auth.loginWithPassword({ username: 'alice', password: PASSWORD }),
      'account_disabled',
    );
  });

  it('disables an account and retires its remembered devices', async () => {
    const registered = await registerAccount(h);
    const enrolled = await h.auth.enrollDevice({
      token: registered.token,
      label: 'Work laptop',
      platform: 'web',
    });

    const result = await h.admin.disableAccount(PLATFORM_ADMIN(), registered.access.userId);

    expect(result.revokedDevices).toBe(1);
    const stored = await h.repository.getDevice(enrolled.device.id);
    expect(stored?.status).toBe('revoked');
    expect(stored?.revokedReason).toBe('admin');
  });

  it('re-enables an account', async () => {
    const registered = await registerAccount(h);
    await h.admin.disableAccount(PLATFORM_ADMIN(), registered.access.userId);
    const view = await h.admin.enableAccount(PLATFORM_ADMIN(), registered.access.userId);
    expect(view.status).toBe('active');
    await expect(
      h.auth.loginWithPassword({ username: 'alice', password: PASSWORD }),
    ).resolves.toBeDefined();
  });

  it('rejects an unknown account', async () => {
    await expectCode(h.admin.disableAccount(PLATFORM_ADMIN(), 'user-nobody'), 'identity_not_bound');
    await expectCode(h.admin.enableAccount(PLATFORM_ADMIN(), 'user-nobody'), 'identity_not_bound');
  });

  it('lists accounts visible to the caller and never exposes a hash', async () => {
    const registered = await registerAccount(h);
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });

    const all = await h.admin.listAccounts(PLATFORM_ADMIN(), undefined);
    expect(all.map((account) => account.username)).toEqual(['alice']);
    expect(all[0]?.passwordConfigured).toBe(true);
    expect(JSON.stringify(all)).not.toContain('scrypt$');

    const filtered = await h.admin.listAccounts(PLATFORM_ADMIN(), 'ALI');
    expect(filtered).toHaveLength(1);
    expect(await h.admin.listAccounts(PLATFORM_ADMIN(), 'nobody')).toHaveLength(0);
  });

  it('scopes the account list to the tenant of a tenant administrator', async () => {
    const registered = await registerAccount(h);
    expect(await h.admin.listAccounts(ACME_ADMIN(), undefined)).toHaveLength(0);

    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });
    expect((await h.admin.listAccounts(ACME_ADMIN(), undefined)).map((a) => a.username)).toEqual([
      'alice',
    ]);
    expect(await h.admin.listAccounts(BETA_ADMIN(), undefined)).toHaveLength(0);
  });

  it('reports the member linkage and access state of every listed account', async () => {
    const registered = await registerPending(h);

    // An applicant: the row reports exactly what the account's own session does —
    // no link, no tenant, and the waiting state that closes the console.
    const waiting = await h.admin.listAccounts(PLATFORM_ADMIN(), 'ALICE');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.accessState).toBe('pending_config');
    expect(waiting[0]?.memberId).toBeNull();
    expect(waiting[0]?.tenantId).toBeNull();

    // Approval is what gives the account a membership, and the row then names the
    // very membership the account's own session resolves to.
    await h.admin.approveAccount(PLATFORM_ADMIN(), registered.access.userId);
    const session = await h.auth.resolveSession(registered.token);
    const own = await h.admin.listAccounts(PLATFORM_ADMIN(), 'ALICE');
    expect(own).toHaveLength(1);
    expect(own[0]?.accessState).toBe('active');
    expect(own[0]?.accessState).toBe(session.access.accessState);
    expect(own[0]?.memberId).toBe(session.access.member?.id);
    expect(own[0]?.tenantId).toBe(session.access.tenantId);

    // Taken out of service by revoking that link, the row reports the same
    // unconfigured state the account's session does.
    await h.admin.revokeLink(PLATFORM_ADMIN(), session.access.member?.id ?? '');
    const pending = await h.admin.listAccounts(PLATFORM_ADMIN(), 'ALICE');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.accessState).toBe('pending_config');
    expect(pending[0]?.memberId).toBeNull();
    expect(pending[0]?.tenantId).toBeNull();

    // Linked to a member of a seeded tenant, the row names that member and
    // tenant — the newest link the account holds.
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });
    const linked = await h.admin.listAccounts(PLATFORM_ADMIN(), undefined);
    expect(linked[0]?.accessState).toBe('active');
    expect(linked[0]?.memberId).toBe('u-t1-agent-1');
    expect(linked[0]?.tenantId).toBe(ACME);

    // A platform member has no tenant, and is still fully usable.
    const second = await registerAccount(h, '+8613800000001', 'bob');
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: second.access.userId,
      memberId: SEEDED_PLATFORM_ADMIN_MEMBER_ID,
      linkedBy: null,
    });
    const platform = (await h.admin.listAccounts(PLATFORM_ADMIN(), 'bob'))[0];
    expect(platform?.accessState).toBe('active');
    expect(platform?.memberId).toBe(SEEDED_PLATFORM_ADMIN_MEMBER_ID);
    expect(platform?.tenantId).toBeNull();

    // The state follows the live member, tenant and account facts.
    await h.admin.setMemberEnabled(PLATFORM_ADMIN(), 'u-t1-agent-1', false);
    expect((await h.admin.listAccounts(PLATFORM_ADMIN(), 'alice'))[0]?.accessState).toBe(
      'disabled',
    );

    await h.admin.setMemberEnabled(PLATFORM_ADMIN(), 'u-t1-agent-1', true);
    // The tenant flag is written straight to the repository: the endpoint that
    // used to do it is frozen (`setTenantEnabled`), and what this case is about
    // is the projection, not the write.
    const acme = await h.repository.getTenant(ACME);
    await h.repository.saveTenant({ ...(acme as Tenant), enabled: false });
    expect((await h.admin.listAccounts(PLATFORM_ADMIN(), 'alice'))[0]?.accessState).toBe(
      'pending_config',
    );

    await h.repository.saveTenant({ ...(acme as Tenant), enabled: true });
    await h.admin.disableAccount(PLATFORM_ADMIN(), registered.access.userId);
    const disabled = (await h.admin.listAccounts(PLATFORM_ADMIN(), 'alice'))[0];
    expect(disabled?.accessState).toBe('disabled');
    expect(disabled?.status).toBe('disabled');

    // Re-enabling reports the recomputed state, not the stale one.
    const reEnabled = await h.admin.enableAccount(PLATFORM_ADMIN(), registered.access.userId);
    expect(reEnabled.accessState).toBe('active');
    expect(reEnabled.memberId).toBe('u-t1-agent-1');
  });

  it('keeps the account list of a tenant administrator inside their own tenant', async () => {
    const acme = await registerAccount(h);
    const beta = await registerAccount(h, '+8613800000002', 'carol');
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: acme.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: beta.access.userId,
      memberId: 'u-t2-agent-1',
      linkedBy: null,
    });

    const visible = await h.admin.listAccounts(ACME_ADMIN(), undefined);
    expect(visible.map((account) => account.username)).toEqual(['alice']);
    expect(visible[0]?.tenantId).toBe(ACME);
    expect(visible[0]?.memberId).toBe('u-t1-agent-1');
  });

  it('refuses account administration to a non-administrator', async () => {
    const registered = await registerAccount(h);
    await expectCode(
      h.admin.disableAccount(ACME_AGENT(), registered.access.userId),
      'access_denied',
    );
    await expectCode(h.admin.listAccounts(ACME_AGENT(), undefined), 'access_denied');
  });

  it('refuses account enable and disable to a tenant administrator of the account’s own tenant', async () => {
    const acme = await registerAccount(h, PHONE, 'acme-user');
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: acme.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });

    // The account acts through a member of the caller's own tenant, which used
    // to be enough. The account lifecycle is platform-wide, not per-tenant, so
    // a tenant administrator no longer reaches it at all.
    await expectCode(h.admin.disableAccount(ACME_ADMIN(), acme.access.userId), 'access_denied');
    await expectCode(h.admin.enableAccount(ACME_ADMIN(), acme.access.userId), 'access_denied');
    expect((await h.repository.getUser(acme.access.userId))?.status).toBe('active');
  });

  it('refuses account enable and disable after a foreign account is linked into the tenant', async () => {
    const beta = await registerAccount(h, PHONE, 'beta-user');
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: beta.access.userId,
      memberId: 'u-t2-agent-1',
      linkedBy: null,
    });

    // Binding another tenant's account to a member of the caller's own tenant
    // must not hand the caller authority over the account's global lifecycle.
    await h.admin.linkMember(ACME_ADMIN(), {
      userId: beta.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });
    await expectCode(h.admin.disableAccount(ACME_ADMIN(), beta.access.userId), 'access_denied');
    await expectCode(h.admin.enableAccount(ACME_ADMIN(), beta.access.userId), 'access_denied');
    expect((await h.repository.getUser(beta.access.userId))?.status).toBe('active');

    // The platform administrator still administers the multi-tenant account,
    // and the account keeps both links throughout.
    await h.admin.disableAccount(PLATFORM_ADMIN(), beta.access.userId);
    expect((await h.repository.getUser(beta.access.userId))?.status).toBe('disabled');
    const enabled = await h.admin.enableAccount(PLATFORM_ADMIN(), beta.access.userId);
    expect(enabled.status).toBe('active');
    expect(
      (await h.repository.listActiveLinksForUser(beta.access.userId))
        .map((link) => link.memberId)
        .sort(),
    ).toEqual(['u-t1-agent-1', 'u-t2-agent-1']);
  });

  it('refuses tenant account administration for an account with no link to the tenant', async () => {
    const registered = await registerAccount(h);
    await expectCode(
      h.admin.disableAccount(ACME_ADMIN(), registered.access.userId),
      'access_denied',
    );
    await expectCode(
      h.admin.enableAccount(ACME_ADMIN(), registered.access.userId),
      'access_denied',
    );
    expect((await h.repository.getUser(registered.access.userId))?.status).toBe('active');
  });
});

/**
 * The queue a registration lands in, and the two decisions an administrator makes
 * about it.
 *
 * A registration mints nothing and closes the console behind `pending_config`;
 * approval is the only thing that changes either. These tests pin both halves
 * together, because either one alone still admits the bug that matters — an
 * applicant who lets themselves in, or an approval that approves nobody.
 */
describe('application approval', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('turns a pending applicant into an agent of the deployment’s organisation', async () => {
    const registered = await registerPending(h);
    expect((await h.auth.resolveSession(registered.token)).access.accessState).toBe(
      'pending_config',
    );

    await h.admin.approveAccount(PLATFORM_ADMIN(), registered.access.userId);

    // The very session the applicant was already holding now opens the console —
    // that is what lets the waiting tab walk in without registering again.
    const resolved = await h.auth.resolveSession(registered.token);
    expect(resolved.access.accessState).toBe('active');
    expect(resolved.access.role).toBe('agent');
    expect(resolved.access.tenantId).toBe(ACME);
    // An agent must have a store — `members` has `CHECK (role <> 'agent' OR
    // store_id IS NOT NULL)`, which this in-memory repository does not enforce and
    // PostgreSQL does, so the *value* is what has to be asserted here. It is the
    // store the tenant's existing agents already serve in, not an arbitrary one:
    // the column is what decides which conversations the agent can see.
    expect(resolved.access.member?.storeId).toBe(FLAGSHIP);
    expect(resolved.access.member?.storeId).not.toBeNull();

    const row = (await h.admin.listAccounts(PLATFORM_ADMIN(), 'ALICE'))[0];
    expect(row?.status).toBe('active');
    expect(row?.accessState).toBe('active');
    expect(row?.memberId).toBe(resolved.access.member?.id);
  });

  it('sends a new agent where the serving agents are, not to the tenant’s first store', async () => {
    // The seed cannot tell the two rules apart on its own: both seeded agents
    // serve in the flagship store, which is also ACME's first store. Switching
    // them off and staffing the *other* store is what makes "the first enabled
    // store" answer a different id from "where the work is".
    await retireAgents(h, ['u-t1-agent-1', 'u-t1-agent-2']);
    await h.repository.saveMember({
      ...memberFixture('u-distribution-agent', DISTRIBUTION),
      enabled: true,
    });

    const registered = await registerPending(h);
    await h.admin.approveAccount(PLATFORM_ADMIN(), registered.access.userId);

    const resolved = await h.auth.resolveSession(registered.token);
    expect(resolved.access.member?.storeId).toBe(DISTRIBUTION);
  });

  it('creates the default store rather than refusing to approve into a tenant without one', async () => {
    // Refusing was right while a store screen existed, and became the wrong
    // answer the moment it stopped existing: an operator staring at an empty
    // deployment could not approve anyone and had nowhere to create a store. The
    // kernel still requires the agent to carry one, so one is supplied.
    await disableEveryStore(h);
    const registered = await registerPending(h);

    const approved = await h.admin.approveAccount(PLATFORM_ADMIN(), registered.access.userId);

    const member = await memberById(h, approved.memberId);
    expect(member.role).toBe('agent');
    const fallback = (await h.repository.listStores(ACME)).find((store) => store.enabled);
    expect(fallback?.code).toBe(TRIAL_STORE_CODE);
    expect(fallback?.name).toBe(TRIAL_STORE_NAME);
    expect(member.storeId).toBe(fallback?.id);
  });

  it('re-enables an existing default store instead of writing a second one', async () => {
    // The code is a tenant-scoped natural key, so a duplicate would collide; and
    // a switched-off default store means settings were changed, not that a new
    // store is wanted.
    await disableEveryStore(h);
    const existing: Store = {
      id: 'store-acme-main',
      tenantId: ACME,
      code: TRIAL_STORE_CODE,
      name: TRIAL_STORE_NAME,
      enabled: false,
      createdAt: START,
    };
    await h.repository.saveStore(existing);
    const registered = await registerPending(h);

    const approved = await h.admin.approveAccount(PLATFORM_ADMIN(), registered.access.userId);

    const stores = await h.repository.listStores(ACME);
    const defaults = stores.filter((store) => store.code === TRIAL_STORE_CODE);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe(existing.id);
    expect(defaults[0]?.enabled).toBe(true);
    expect((await memberById(h, approved.memberId)).storeId).toBe(existing.id);
  });

  it('refuses an account that is not awaiting approval, rather than deciding twice', async () => {
    // Already past the gate: re-approving would relink someone who is inside, and
    // the control that means "approve" must not also mean "let back in".
    const registered = await registerAccount(h);

    await expectCode(
      h.admin.approveAccount(PLATFORM_ADMIN(), registered.access.userId),
      'invalid_request',
    );
    await expectCode(
      h.admin.rejectAccount(PLATFORM_ADMIN(), registered.access.userId),
      'invalid_request',
    );
  });

  it('resumes an approval that was interrupted, instead of making a second member', async () => {
    const registered = await registerPending(h);
    // The half-written first attempt: the member exists, the link does not, and
    // the account is still an applicant.
    await h.repository.saveMember({
      id: 'u-halfway',
      tenantId: ACME,
      storeId: null,
      role: 'agent',
      username: 'alice',
      displayName: 'Alice',
      enabled: true,
      createdAt: h.clock.now(),
    });

    await h.admin.approveAccount(PLATFORM_ADMIN(), registered.access.userId);

    const resolved = await h.auth.resolveSession(registered.token);
    expect(resolved.access.accessState).toBe('active');
    expect(resolved.access.member?.id).toBe('u-halfway');
    const members = (await h.admin.listMembers(PLATFORM_ADMIN(), ACME)).filter(
      (member) => member.username === 'alice',
    );
    expect(members).toHaveLength(1);
  });

  it('rejects an applicant by switching the account off and taking its sessions', async () => {
    const registered = await registerPending(h);

    const row = await h.admin.rejectAccount(PLATFORM_ADMIN(), registered.access.userId);

    expect(row.status).toBe('disabled');
    expect(row.accessState).toBe('disabled');
    // The waiting tab keeps polling with this token; a rejection it cannot
    // observe is not a decision the applicant has been given. `account_disabled`
    // rather than `session_revoked` because the account is the reason: the
    // console reads that code as "this token is finished" and returns to sign-in.
    await expectCode(h.auth.resolveSession(registered.token), 'account_disabled');
    expect(await h.admin.listAccounts(PLATFORM_ADMIN(), 'ALICE')).toHaveLength(1);
    expect((await h.admin.listAccounts(PLATFORM_ADMIN(), 'ALICE'))[0]?.accessState).toBe(
      'disabled',
    );
  });

  it('is a platform administrator’s decision, not a tenant’s', async () => {
    const registered = await registerPending(h);

    await expectCode(
      h.admin.approveAccount(ACME_ADMIN(), registered.access.userId),
      'access_denied',
    );
    await expectCode(
      h.admin.rejectAccount(ACME_AGENT(), registered.access.userId),
      'access_denied',
    );
  });

  it('refuses to approve anyone when there is no organisation to join', async () => {
    // Every tenant switched off. Approving here would resolve the new agent to
    // `pending_config` again — a second waiting room reached through a button
    // that says the wait is over.
    const registered = await registerPending(h);
    for (const tenant of SEEDED_TENANTS) {
      await h.repository.saveTenant({ ...tenant, enabled: false });
    }

    await expectCode(
      h.admin.approveAccount(PLATFORM_ADMIN(), registered.access.userId),
      'invalid_request',
    );
    expect((await h.auth.resolveSession(registered.token)).access.accessState).toBe(
      'pending_config',
    );
  });
});

/**
 * The administrator's view of an account's remembered devices.
 *
 * This is the surface that takes a device away from an operator who has lost it,
 * so it has to be reachable for the *right* account and no other, and revoking
 * has to reach the sessions the device holds — otherwise the device is merely
 * missing from a list while still signed in.
 */
describe('AuthAdminService account devices', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  /** Register an account and remember one device for it. */
  async function accountWithDevice(label = 'Work laptop') {
    const registered = await registerAccount(h);
    const enrolled = await h.auth.enrollDevice({
      token: registered.token,
      label,
      platform: 'web',
    });
    return { registered, enrolled };
  }

  it('lists the devices of the account the caller named', async () => {
    const { registered, enrolled } = await accountWithDevice();

    const devices = await h.admin.listAccountDevices(PLATFORM_ADMIN(), registered.access.userId);

    expect(devices.map((device) => device.id)).toEqual([enrolled.device.id]);
    expect(devices[0]?.label).toBe('Work laptop');
    expect(devices[0]?.status).toBe('active');
    // An administrator's device row is about somebody else, so it neither
    // carries nor invents a `current` flag.
    expect(JSON.stringify(devices)).not.toContain('current');
    expect(JSON.stringify(devices)).not.toContain('fingerprint');
  });

  it('reports the effective status of a device that has lapsed', async () => {
    const { registered, enrolled } = await accountWithDevice();
    // Backdate the stored lifetime so it is in the past at the fixed clock. The
    // row still says `active`, so the `expired` below can only come from the
    // read-time rule — the same one the owner's own device list applies.
    const stored = await h.repository.getDevice(enrolled.device.id);
    if (stored === undefined) throw new Error('the enrolled device was not stored');
    expect(stored.status).toBe('active');
    await h.repository.saveDevice({ ...stored, expiresAt: '2026-09-09T00:00:00.000Z' });

    const devices = await h.admin.listAccountDevices(PLATFORM_ADMIN(), registered.access.userId);

    expect(devices[0]?.status).toBe('expired');
    expect((await h.repository.getDevice(enrolled.device.id))?.status).toBe('active');
  });

  it('reports an account with no devices as empty rather than failing', async () => {
    const registered = await registerAccount(h);

    await expect(
      h.admin.listAccountDevices(PLATFORM_ADMIN(), registered.access.userId),
    ).resolves.toEqual([]);
  });

  it('refuses the device list of a non-administrator', async () => {
    const { registered } = await accountWithDevice();

    await expectCode(
      h.admin.listAccountDevices(ACME_AGENT(), registered.access.userId),
      'access_denied',
    );
    await expectCode(
      h.admin.listAccountDevices(ACME_ADMIN(), registered.access.userId),
      'access_denied',
    );
  });

  it('refuses the device list of an unknown account', async () => {
    await expectCode(
      h.admin.listAccountDevices(PLATFORM_ADMIN(), 'user-nobody'),
      'identity_not_bound',
    );
  });

  it('revokes a device, its bound session and nothing else', async () => {
    const { registered, enrolled } = await accountWithDevice();
    // A second session that was never bound to the device must survive.
    const other = await h.auth.loginWithPassword({ username: 'alice', password: PASSWORD });

    const result = await h.admin.revokeAccountDevice(
      PLATFORM_ADMIN(),
      registered.access.userId,
      enrolled.device.id,
    );

    expect(result).toEqual({
      userId: registered.access.userId,
      deviceId: enrolled.device.id,
      revokedSessions: 1,
    });
    const stored = await h.repository.getDevice(enrolled.device.id);
    expect(stored?.status).toBe('revoked');
    expect(stored?.revokedReason).toBe('admin');
    await expectCode(h.auth.resolveSession(registered.token), 'session_revoked');
    await expect(h.auth.resolveSession(other.token)).resolves.toBeDefined();
  });

  it('refuses a device that is not enrolled for the named account', async () => {
    const first = await accountWithDevice();
    // A second account with a device of its own: the id is real, the pairing is
    // not, and an administrator must not reach across accounts with it.
    await h.auth.sendOtp({ subject: '+8613800000001', channel: 'sms', purpose: 'sign_in' });
    const code = h.otpProvider.lastDeliveryFor('+8613800000001')?.code ?? '';
    const second = await h.auth.register({
      subject: '+8613800000001',
      channel: 'sms',
      code,
      username: 'bob',
      displayName: 'Bob',
      password: PASSWORD,
    });
    const foreign = await h.auth.enrollDevice({
      token: second.token,
      label: 'Bob laptop',
      platform: 'web',
    });

    await expectCode(
      h.admin.revokeAccountDevice(
        PLATFORM_ADMIN(),
        first.registered.access.userId,
        foreign.device.id,
      ),
      'device_not_found',
    );
    // Neither device moved.
    expect((await h.repository.getDevice(foreign.device.id))?.status).toBe('active');
    expect((await h.repository.getDevice(first.enrolled.device.id))?.status).toBe('active');
  });

  it('refuses an unknown device', async () => {
    const { registered } = await accountWithDevice();

    await expectCode(
      h.admin.revokeAccountDevice(PLATFORM_ADMIN(), registered.access.userId, 'device-nobody'),
      'device_not_found',
    );
  });

  it('refuses to revoke a device twice', async () => {
    const { registered, enrolled } = await accountWithDevice();
    await h.admin.revokeAccountDevice(
      PLATFORM_ADMIN(),
      registered.access.userId,
      enrolled.device.id,
    );

    await expectCode(
      h.admin.revokeAccountDevice(PLATFORM_ADMIN(), registered.access.userId, enrolled.device.id),
      'device_revoked',
    );
  });

  it('revokes a device that had already lapsed', async () => {
    // Revocation is the administrator's explicit "forget this", so a stray
    // expired row is exactly what they are trying to retire.
    const { registered, enrolled } = await accountWithDevice();
    const stored = await h.repository.getDevice(enrolled.device.id);
    if (stored === undefined) throw new Error('the enrolled device was not stored');
    await h.repository.saveDevice({ ...stored, expiresAt: '2026-09-09T00:00:00.000Z' });

    const result = await h.admin.revokeAccountDevice(
      PLATFORM_ADMIN(),
      registered.access.userId,
      enrolled.device.id,
    );

    expect(result.revokedSessions).toBe(1);
    expect((await h.repository.getDevice(enrolled.device.id))?.revokedReason).toBe('admin');
  });

  it('refuses device revocation to a non-administrator', async () => {
    const { registered, enrolled } = await accountWithDevice();

    await expectCode(
      h.admin.revokeAccountDevice(ACME_AGENT(), registered.access.userId, enrolled.device.id),
      'access_denied',
    );
    expect((await h.repository.getDevice(enrolled.device.id))?.status).toBe('active');
  });
});

/**
 * What one listed account row says, from the point of view of one caller.
 *
 * An account is platform-wide and may act through members of several tenants,
 * so the same account is a different row to different administrators. These
 * tests always ask the *same* question — "which member and tenant does the row
 * name, and is it usable" — so they read the row the same way every time.
 */
describe('AuthAdminService account projection across tenants', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('shows a tenant administrator only the link into their own tenant', async () => {
    const registered = await registerAccount(h);

    // Bound into Beta first and Acme second. The in-memory adapter hands links
    // back in insertion order, so a projection that took the first result would
    // describe the Acme administrator's row with Beta's member and tenant.
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t2-agent-1',
      linkedBy: null,
    });
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });

    const acme = await h.admin.listAccounts(ACME_ADMIN(), undefined);
    expect(acme.map((account) => account.username)).toEqual(['alice']);
    expect(acme[0]?.memberId).toBe('u-t1-agent-1');
    expect(acme[0]?.tenantId).toBe(ACME);
    expect(acme[0]?.accessState).toBe('active');

    // The other tenant sees its own link, not the shared account's newest one.
    const beta = await h.admin.listAccounts(BETA_ADMIN(), undefined);
    expect(beta.map((account) => account.username)).toEqual(['alice']);
    expect(beta[0]?.memberId).toBe('u-t2-agent-1');
    expect(beta[0]?.tenantId).toBe(BETA);
    expect(beta[0]?.accessState).toBe('active');
  });

  it('matches on the member’s own tenant, not the tenant recorded on the link', async () => {
    const registered = await registerAccount(h);

    // Two links, written Beta first. One really is Beta's; the other *claims*
    // Beta on the link row while pointing at a member that actually belongs to
    // Acme. The member row is what the projected account would act through, so
    // the member's own tenant is what decides — a projection that read the
    // tenant off the link would drop the second link and fall back to the first.
    await h.repository.saveLink(
      linkRow('link-beta', registered.access.userId, 'u-t2-agent-1', BETA, START),
    );
    await h.repository.saveLink(
      linkRow('link-mislabelled', registered.access.userId, 'u-t1-agent-1', BETA, START),
    );

    const acme = await h.admin.listAccounts(ACME_ADMIN(), undefined);
    expect(acme).toHaveLength(1);
    expect(acme[0]?.memberId).toBe('u-t1-agent-1');
    expect(acme[0]?.tenantId).toBe(ACME);
  });

  it('shows a platform administrator the newest link, whichever order the adapter returns', async () => {
    const first = await registerAccount(h, PHONE, 'alice');
    const second = await registerAccount(h, '+8613800000003', 'bob');

    const older = '2026-09-10T00:00:00.000Z';
    const newer = '2026-09-10T01:00:00.000Z';

    // The same two links for each account, written in opposite insertion
    // orders: the row must depend on `linkedAt` alone, never on the order the
    // repository happened to hand the links back in.
    await h.repository.saveLink(
      linkRow('link-old-first', first.access.userId, 'u-t2-agent-1', BETA, older),
    );
    await h.repository.saveLink(
      linkRow('link-new-last', first.access.userId, 'u-t1-agent-1', ACME, newer),
    );
    await h.repository.saveLink(
      linkRow('link-new-first', second.access.userId, 'u-t1-admin', ACME, newer),
    );
    await h.repository.saveLink(
      linkRow('link-old-last', second.access.userId, 'u-t2-admin', BETA, older),
    );

    const views = new Map(
      (await h.admin.listAccounts(PLATFORM_ADMIN(), undefined)).map((view) => [view.id, view]),
    );
    expect(views.get(first.access.userId)?.memberId).toBe('u-t1-agent-1');
    expect(views.get(first.access.userId)?.tenantId).toBe(ACME);
    expect(views.get(second.access.userId)?.memberId).toBe('u-t1-admin');
    expect(views.get(second.access.userId)?.tenantId).toBe(ACME);
  });

  it('breaks a tied linkedAt on the link id, whichever order the adapter returns', async () => {
    const tied = '2026-09-10T02:00:00.000Z';

    /**
     * List one account whose two active links carry the same `linkedAt`.
     *
     * With the timestamps equal, only the link id can decide the row — and the
     * two directories below write the same pair of ids in opposite orders, so
     * the result has to match or the adapter is deciding.
     */
    async function tiedRow(order: ReadonlyArray<'acme' | 'beta'>) {
      const fresh = harness();
      const registered = await registerAccount(fresh);
      const links = {
        acme: linkRow('link-a', registered.access.userId, 'u-t1-agent-1', ACME, tied),
        beta: linkRow('link-b', registered.access.userId, 'u-t2-agent-1', BETA, tied),
      };
      for (const side of order) {
        await fresh.repository.saveLink(links[side]);
      }
      const view = (await fresh.admin.listAccounts(PLATFORM_ADMIN(), undefined))[0];
      return { memberId: view?.memberId ?? null, tenantId: view?.tenantId ?? null };
    }

    // `link-b` sorts above `link-a`, so Beta wins both times.
    await expect(tiedRow(['acme', 'beta'])).resolves.toEqual({
      memberId: 'u-t2-agent-1',
      tenantId: BETA,
    });
    await expect(tiedRow(['beta', 'acme'])).resolves.toEqual({
      memberId: 'u-t2-agent-1',
      tenantId: BETA,
    });
  });

  it('reports an account with no qualifying link as unconfigured', async () => {
    const registered = await registerAccount(h);

    // A link whose member row no longer exists. The row must read exactly like
    // an unlinked account rather than naming a member that is gone.
    await h.repository.saveLink(
      linkRow('link-orphan', registered.access.userId, 'u-gone', ACME, START),
    );

    const view = (await h.admin.listAccounts(PLATFORM_ADMIN(), undefined))[0];
    expect(view?.accessState).toBe('pending_config');
    expect(view?.memberId).toBeNull();
    expect(view?.tenantId).toBeNull();
  });
});

describe('administration of a tenant an administrator does not own', () => {
  it('is refused end to end', async () => {
    const h = harness();
    await expectCode(
      h.admin.createStore(BETA_ADMIN(), { tenantId: ACME, code: 'x', name: 'X' }),
      'access_denied',
    );
    await expectCode(
      h.admin.createMember(BETA_ADMIN(), {
        tenantId: ACME,
        storeId: null,
        role: 'agent',
        username: 'x',
        displayName: 'X',
      }),
      'access_denied',
    );
  });
});

describe('platform administrator escalation chain', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('stops a tenant administrator before platform authority can be acquired', async () => {
    const registered = await registerAccount(h);
    // The account holds no membership at all, so the only one it could ever act
    // through is the one the caller is about to try to mint.

    // 1. Mint a platform administrator of the caller's own tenant. Refused, so
    //    no member exists for the caller to act through.
    await expectCode(
      h.admin.createMember(ACME_ADMIN(), {
        tenantId: ACME,
        storeId: null,
        role: 'platform_admin',
        username: 'rogue-admin',
        displayName: '越权管理员',
      }),
      'access_denied',
    );
    // 2. Promote an own-tenant member instead. Refused too, and the member is
    //    left exactly as it was.
    await expectCode(
      h.admin.setMemberRole(ACME_ADMIN(), 'u-t1-agent-1', 'platform_admin'),
      'access_denied',
    );
    expect((await h.repository.getMember('u-t1-agent-1'))?.role).toBe('agent');

    // 3. Binding the account to an own-tenant member is legitimate and still
    //    works — it simply confers the member's real role, nothing more.
    await h.admin.linkMember(ACME_ADMIN(), {
      userId: registered.access.userId,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });
    const resolved = await h.auth.resolveSession(registered.token);
    expect(resolved.access.role).toBe('agent');
    expect(resolved.access.tenantId).toBe(ACME);

    // 4. The global account lifecycle stays out of reach with the stable code.
    await expectCode(
      h.admin.disableAccount(ACME_ADMIN(), registered.access.userId),
      'access_denied',
    );
    await expectCode(
      h.admin.enableAccount(ACME_ADMIN(), registered.access.userId),
      'access_denied',
    );
    expect((await h.repository.getUser(registered.access.userId))?.status).toBe('active');
  });

  it('grants no platform authority when a tenant-scoped platform_admin row exists', async () => {
    const registered = await registerAccount(h);

    // A row a database that predates the invariant — or a write that bypassed
    // this service — could still hold: a platform administrator that belongs to
    // a tenant. The authorization decision must fail closed on it.
    await h.repository.saveMember({
      id: 'u-rogue-admin',
      tenantId: ACME,
      storeId: null,
      role: 'platform_admin',
      username: 'rogue-admin',
      displayName: '越权管理员',
      enabled: true,
      createdAt: START,
    });
    await h.repository.saveLink({
      id: 'link-rogue-admin',
      userId: registered.access.userId,
      tenantId: ACME,
      memberId: 'u-rogue-admin',
      linkedBy: null,
      linkedAt: START,
      revokedAt: null,
      createdAt: START,
      updatedAt: START,
    });

    const resolved = await h.auth.resolveSession(registered.token);
    expect(resolved.access.role).toBe('platform_admin');
    expect(resolved.access.tenantId).toBe(ACME);
    await expectCode(
      h.admin.disableAccount(resolved.access, registered.access.userId),
      'access_denied',
    );
    expect((await h.repository.getUser(registered.access.userId))?.status).toBe('active');
  });
});

/**
 * The blast radius of a tenant-scoped `platform_admin`.
 *
 * The row is contradictory: the platform role says "belongs to no tenant", the
 * tenant says the opposite. It is refused as a platform principal everywhere,
 * and it is deliberately *not* demoted to the tenant authority its tenant would
 * otherwise grant — otherwise minting the row would still pay off. Every
 * assertion below is paired with a "nothing changed" check, so a surface that
 * silently accepted the call is a failure, not just a wrong status code.
 */
describe('tenant-scoped platform administrator', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('is refused platform authority and tenant authority alike', async () => {
    const { access } = await roguePlatformAdmin(h);
    expect(access.role).toBe('platform_admin');
    expect(access.tenantId).toBe(ACME);
    expectThrowCode(() => assertPlatformAdmin(access), 'access_denied');
    expectThrowCode(() => assertTenantAdmin(access, ACME), 'access_denied');
    expectThrowCode(() => assertTenantAdmin(access, BETA), 'access_denied');
  });

  it('cannot list every tenant', async () => {
    const { access } = await roguePlatformAdmin(h);
    await expectCode(h.admin.listTenants(access), 'access_denied');
  });

  it('cannot list or create stores in any tenant, including its own', async () => {
    const { access } = await roguePlatformAdmin(h);
    await expectCode(h.admin.listStores(access, BETA), 'access_denied');
    await expectCode(h.admin.listStores(access, ACME), 'access_denied');
    await expectCode(
      h.admin.createStore(access, { tenantId: BETA, code: 'rogue', name: '越权门店' }),
      'access_denied',
    );
    await expectCode(
      h.admin.createStore(access, { tenantId: ACME, code: 'rogue', name: '越权门店' }),
      'access_denied',
    );
    await expectCode(
      h.admin.setStoreEnabled(access, 'store-beta-official', false),
      'access_denied',
    );
    // Neither directory gained a store, and the foreign one is still enabled.
    expect(await h.repository.listStores(BETA)).toHaveLength(1);
    expect(await h.repository.listStores(ACME)).toHaveLength(2);
    expect((await h.repository.findStoreById('store-beta-official'))?.enabled).toBe(true);
  });

  it('cannot administer members, links or store scopes of any tenant', async () => {
    const { access } = await roguePlatformAdmin(h);
    await expectCode(h.admin.listMembers(access, BETA), 'access_denied');
    await expectCode(h.admin.listMembers(access, ACME), 'access_denied');
    await expectCode(
      h.admin.createMember(access, {
        tenantId: ACME,
        storeId: null,
        role: 'agent',
        username: 'rogue-agent',
        displayName: '越权客服',
      }),
      'access_denied',
    );
    await expectCode(
      h.admin.setMemberRole(access, 'u-t1-agent-1', 'merchant_admin'),
      'access_denied',
    );
    await expectCode(h.admin.setMemberEnabled(access, 'u-t1-agent-1', false), 'access_denied');
    await expectCode(
      h.admin.linkMember(access, {
        userId: 'user-nobody',
        memberId: 'u-t1-agent-1',
        linkedBy: null,
      }),
      'access_denied',
    );
    await expectCode(h.admin.revokeLink(access, 'u-t1-agent-1'), 'access_denied');
    await expectCode(h.admin.listStoreScopes(access, 'u-t1-admin'), 'access_denied');
    await expectCode(
      h.admin.grantStoreScope(access, {
        tenantId: ACME,
        memberId: 'u-t1-admin',
        storeId: 'store-acme-flagship',
        grantedBy: null,
      }),
      'access_denied',
    );
    await expectCode(
      h.admin.revokeStoreScope(access, 'u-t1-admin', 'store-acme-flagship'),
      'access_denied',
    );

    // The member kept its role and stayed enabled, and gained no link or scope.
    expect((await h.repository.getMember('u-t1-agent-1'))?.role).toBe('agent');
    expect((await h.repository.getMember('u-t1-agent-1'))?.enabled).toBe(true);
    expect(await h.repository.listActiveStoreScopes(ACME, 'u-t1-admin')).toHaveLength(0);
    expect(await h.repository.getActiveLinkForMember('u-t1-agent-1')).toBeUndefined();
  });

  it('cannot list every account', async () => {
    const { access } = await roguePlatformAdmin(h);
    await expectCode(h.admin.listAccounts(access, undefined), 'access_denied');
    await expectCode(h.admin.listAccounts(access, 'rogue'), 'access_denied');
  });

  it('cannot create or change a tenant', async () => {
    const { access } = await roguePlatformAdmin(h);
    // Whatever the directory held before the refused calls — the seeded tenants
    // plus the account's own trial tenant — it holds exactly that afterwards.
    const before = (await h.repository.listTenants()).map((tenant) => tenant.id).sort();
    await expectCode(
      h.admin.createTenant(access, { code: 'rogue', name: '越权租户' }),
      'access_denied',
    );
    await expectCode(h.admin.setTenantEnabled(access, ACME, false), 'access_denied');
    expect((await h.repository.getTenant(ACME))?.enabled).toBe(true);
    expect((await h.repository.listTenants()).map((tenant) => tenant.id).sort()).toEqual(before);
    expect(before).toContain(ACME);
  });

  it('cannot invoke the account lifecycle', async () => {
    const { userId, access } = await roguePlatformAdmin(h);
    await expectCode(h.admin.disableAccount(access, userId), 'access_denied');
    await expectCode(h.admin.enableAccount(access, userId), 'access_denied');
    expect((await h.repository.getUser(userId))?.status).toBe('active');
  });

  it('leaves genuine administrators of both levels untouched', async () => {
    // The rogue row is in the same directory throughout, so a predicate that
    // over-blocks would show up here rather than in the tests above.
    await roguePlatformAdmin(h);

    // A platform administrator still sees every tenant — the whole directory,
    // including the trial tenant the registered account was given — while a
    // tenant administrator sees exactly their own.
    const directory = (await h.repository.listTenants()).map((tenant) => tenant.id).sort();
    expect(directory).toEqual(expect.arrayContaining(SEEDED_TENANTS.map((t) => t.id)));
    expect((await h.admin.listTenants(PLATFORM_ADMIN())).map((tenant) => tenant.id).sort()).toEqual(
      directory,
    );
    expect((await h.admin.listTenants(ACME_ADMIN())).map((tenant) => tenant.id)).toEqual([ACME]);

    const store = await h.admin.createStore(PLATFORM_ADMIN(), {
      tenantId: BETA,
      code: 'extra',
      name: '补充门店',
    });
    expect(store.tenantId).toBe(BETA);

    expect((await h.admin.listStores(ACME_ADMIN(), ACME)).length).toBeGreaterThan(0);
    await expect(
      h.admin.setMemberRole(ACME_ADMIN(), 'u-t1-agent-1', 'merchant_admin'),
    ).resolves.toMatchObject({ role: 'merchant_admin' });
  });
});

/**
 * Account creation (G0 of the self-use refactor).
 *
 * The endpoint exists because registration used to be the only way an account
 * could be born, and the console is about to stop offering it. What matters is
 * therefore not the row count but that the account it writes is a *usable
 * login*: a real encoded hash, a verified password identity, and a sign-in that
 * succeeds through the same path the login screen uses.
 */
describe('AuthAdminService account creation', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  const INPUT = {
    username: 'agent02',
    displayName: '客服二号',
    password: PASSWORD,
  };

  it('creates an unlinked account whose password actually signs in', async () => {
    const created = await h.admin.createAccount(PLATFORM_ADMIN(), INPUT);

    expect(created).toMatchObject({
      username: 'agent02',
      displayName: '客服二号',
      status: 'active',
      passwordConfigured: true,
      memberId: null,
      tenantId: null,
      lastLoginAt: null,
    });
    // No member link yet: that is the state the binding console fixes, not a
    // failure to create.
    expect(created.accessState).toBe('pending_config');

    const stored = await h.repository.getUser(created.id);
    expect(stored?.passwordHash).toMatch(/^scrypt\$/);
    expect(JSON.stringify(created)).not.toContain('scrypt$');

    // The acceptance test for the whole gap: the credential works at the door.
    const signedIn = await h.auth.loginWithPassword({
      username: INPUT.username,
      password: INPUT.password,
    });
    const resolved = await h.auth.resolveSession(signedIn.token);
    expect(resolved.access.userId).toBe(created.id);

    const identities = await h.repository.listIdentities(created.id);
    expect(
      identities.map((identity) => [identity.provider, identity.subject, identity.verified]),
    ).toEqual([['password', 'agent02', true]]);
  });

  it('follows the binding workflow: link it and the account reaches a tenant', async () => {
    const created = await h.admin.createAccount(PLATFORM_ADMIN(), INPUT);
    await h.admin.linkMember(PLATFORM_ADMIN(), {
      userId: created.id,
      memberId: 'u-t1-agent-1',
      linkedBy: null,
    });

    const linked = (await h.admin.listAccounts(PLATFORM_ADMIN(), 'agent02')).find(
      (account) => account.id === created.id,
    );
    expect(linked?.memberId).toBe('u-t1-agent-1');
    expect(linked?.tenantId).toBe(ACME);

    const signedIn = await h.auth.loginWithPassword({
      username: INPUT.username,
      password: INPUT.password,
    });
    const resolved = await h.auth.resolveSession(signedIn.token);
    expect(resolved.access.tenantId).toBe(ACME);
    expect(resolved.access.role).toBe('agent');
  });

  it('refuses a username that is already taken, in either spelling', async () => {
    await h.admin.createAccount(PLATFORM_ADMIN(), INPUT);

    await expectCode(h.admin.createAccount(PLATFORM_ADMIN(), INPUT), 'username_taken');
    await expectCode(
      h.admin.createAccount(PLATFORM_ADMIN(), { ...INPUT, username: ' AGENT02 ' }),
      'username_taken',
    );

    // A registered account occupies the username just as firmly: registration and
    // creation write the same two rows, so they must disagree about nothing.
    await registerAccount(h, PHONE, 'alice');
    await expectCode(
      h.admin.createAccount(PLATFORM_ADMIN(), { ...INPUT, username: 'alice' }),
      'username_taken',
    );
  });

  it('holds an administrative account to the registration password policy', async () => {
    await expectCode(
      h.admin.createAccount(PLATFORM_ADMIN(), { ...INPUT, password: 'short' }),
      'password_too_weak',
    );
    expect(await h.repository.findUserByUsername(INPUT.username)).toBeUndefined();
  });

  it('refuses a blank username or display name', async () => {
    await expectCode(
      h.admin.createAccount(PLATFORM_ADMIN(), { ...INPUT, username: '   ' }),
      'invalid_request',
    );
    await expectCode(
      h.admin.createAccount(PLATFORM_ADMIN(), { ...INPUT, displayName: '  ' }),
      'invalid_request',
    );
  });

  it('is a platform administrator action only', async () => {
    await expectCode(h.admin.createAccount(ACME_ADMIN(), INPUT), 'access_denied');
    await expectCode(h.admin.createAccount(ACME_AGENT(), INPUT), 'access_denied');
    await expectCode(h.admin.createAccount(BETA_ADMIN(), INPUT), 'access_denied');

    const rogue = await roguePlatformAdmin(h);
    await expectCode(h.admin.createAccount(rogue.access, INPUT), 'access_denied');
    expect(await h.repository.findUserByUsername(INPUT.username)).toBeUndefined();
  });
});
