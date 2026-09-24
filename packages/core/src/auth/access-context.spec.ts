import { describe, expect, it } from 'vitest';
import {
  assertAccessAllowed,
  buildAccessContext,
  isStoreAuthorized,
  resolveStoreFilter,
  type AccessResolutionInput,
} from './access-context';
import { isAuthError } from './errors';
import { SEEDED_MEMBERS, SEEDED_STORES, SEEDED_TENANTS } from './directory-seed';
import type { AuthSession, MemberStoreScope } from './types';

const NOW = '2026-09-10T00:00:00.000Z';
const ACME = SEEDED_TENANTS[0];
const BETA = SEEDED_TENANTS[1];
const FLAGSHIP = SEEDED_STORES[0];
const DISTRIBUTION = SEEDED_STORES[1];

function findMember(id: string) {
  const member = SEEDED_MEMBERS.find((candidate) => candidate.id === id);
  if (member === undefined) {
    throw new Error(`seeded member ${id} is missing`);
  }
  return member;
}

function scope(storeId: string, overrides: Partial<MemberStoreScope> = {}): MemberStoreScope {
  return {
    tenantId: ACME?.id ?? '',
    memberId: 'u-t1-agent-1',
    storeId,
    isPrimary: false,
    grantedBy: null,
    grantedAt: NOW,
    revokedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    id: 'session-0001',
    userId: 'user-0001',
    tenantId: ACME?.id ?? null,
    memberId: 'u-t1-agent-1',
    trustedDeviceId: null,
    tokenFingerprint: 'f'.repeat(64),
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

function input(overrides: Partial<AccessResolutionInput> = {}): AccessResolutionInput {
  return {
    session: session(),
    accountStatus: 'active',
    member: findMember('u-t1-agent-1'),
    tenant: ACME ?? null,
    link: { id: 'link-0001' },
    storeScopes: [],
    tenantStores: SEEDED_STORES.filter((store) => store.tenantId === ACME?.id),
    ...overrides,
  };
}

describe('buildAccessContext', () => {
  it('is active for a linked member of an enabled tenant', () => {
    const context = buildAccessContext(input());
    expect(context.accessState).toBe('active');
    expect(context.userId).toBe('user-0001');
    expect(context.sessionId).toBe('session-0001');
    expect(context.tenantId).toBe(ACME?.id);
    expect(context.role).toBe('agent');
    expect(context.member?.id).toBe('u-t1-agent-1');
    expect(context.authMethod).toBe('password');
    expect(context.expiresAt).toBe('2026-09-10T12:00:00.000Z');
  });

  it('is pending_config for an account with no member, and authorizes no store', () => {
    const context = buildAccessContext(
      input({ member: null, tenant: null, link: undefined, storeScopes: [], tenantStores: [] }),
    );
    expect(context.accessState).toBe('pending_config');
    expect(context.member).toBeNull();
    expect(context.tenantId).toBeNull();
    expect(context.storeId).toBeNull();
    expect(context.role).toBeNull();
    expect(context.authorizedStoreIds).toEqual([]);
  });

  it('is pending_config when the member link was revoked', () => {
    const context = buildAccessContext(input({ link: undefined }));
    expect(context.accessState).toBe('pending_config');
    expect(context.member?.id).toBe('u-t1-agent-1');
  });

  it('is pending_config when the tenant is disabled', () => {
    const context = buildAccessContext(
      input({ tenant: ACME === undefined ? null : { ...ACME, enabled: false } }),
    );
    expect(context.accessState).toBe('pending_config');
  });

  it('is disabled when the member is disabled', () => {
    const context = buildAccessContext(
      input({ member: { ...findMember('u-t1-agent-1'), enabled: false } }),
    );
    expect(context.accessState).toBe('disabled');
  });

  it('is disabled when the account is disabled', () => {
    expect(buildAccessContext(input({ accountStatus: 'disabled' })).accessState).toBe('disabled');
  });

  it('is active for a platform member without a tenant', () => {
    const context = buildAccessContext(
      input({
        member: findMember('u-platform-admin'),
        tenant: null,
        tenantStores: [],
      }),
    );
    expect(context.accessState).toBe('active');
    expect(context.role).toBe('platform_admin');
    expect(context.tenantId).toBeNull();
    expect(context.authorizedStoreIds).toEqual([]);
  });
});

describe('authorized stores', () => {
  it('takes its stores from the granted scopes, not from the home store', () => {
    const context = buildAccessContext(input({ storeScopes: [scope(DISTRIBUTION?.id ?? '')] }));
    expect(context.authorizedStoreIds).toEqual([DISTRIBUTION?.id ?? '']);
  });

  it('ignores revoked scopes', () => {
    const context = buildAccessContext(
      input({
        storeScopes: [
          scope(DISTRIBUTION?.id ?? ''),
          scope(FLAGSHIP?.id ?? '', { revokedAt: NOW }),
        ],
      }),
    );
    // A revoked grant is not a grant. Were it honored the home store would show
    // up here, which is what this case exists to catch.
    expect(context.authorizedStoreIds).toEqual([DISTRIBUTION?.id ?? '']);
  });

  it('falls back to the whole enabled tenant when nothing narrows the member', () => {
    const context = buildAccessContext(input({ member: findMember('u-t1-admin') }));
    expect(context.authorizedStoreIds).toEqual([FLAGSHIP?.id ?? '', DISTRIBUTION?.id ?? ''].sort());
  });

  it('excludes a disabled store from a tenant-wide fallback', () => {
    const context = buildAccessContext(
      input({
        storeScopes: [scope('store-acme-closed')],
        tenantStores: [
          ...SEEDED_STORES.filter((store) => store.tenantId === ACME?.id),
          {
            id: 'store-acme-closed',
            tenantId: ACME?.id ?? '',
            code: 'closed',
            name: '已停业门店',
            enabled: false,
            createdAt: NOW,
          },
        ],
      }),
    );
    expect(isStoreAuthorized(context, 'store-acme-closed')).toBe(true);

    const tenantWide = buildAccessContext(
      input({
        member: findMember('u-t1-admin'),
        tenantStores: [
          ...SEEDED_STORES.filter((store) => store.tenantId === ACME?.id),
          {
            id: 'store-acme-closed',
            tenantId: ACME?.id ?? '',
            code: 'closed',
            name: '已停业门店',
            enabled: false,
            createdAt: NOW,
          },
        ],
      }),
    );
    expect(isStoreAuthorized(tenantWide, 'store-acme-closed')).toBe(false);
  });

  it('never authorizes another tenant’s store', () => {
    const context = buildAccessContext(input());
    expect(isStoreAuthorized(context, FLAGSHIP?.id ?? '')).toBe(true);
    expect(isStoreAuthorized(context, SEEDED_STORES[2]?.id ?? '')).toBe(false);
    expect(isStoreAuthorized(context, BETA?.id ?? '')).toBe(false);
  });
});

describe('resolveStoreFilter', () => {
  it('accepts a requested store inside the scope', () => {
    const context = buildAccessContext(input());
    expect(resolveStoreFilter(context, FLAGSHIP?.id ?? '')).toBe(FLAGSHIP?.id);
  });

  it('refuses a requested store outside the scope', () => {
    const context = buildAccessContext(input());
    try {
      resolveStoreFilter(context, SEEDED_STORES[2]?.id ?? '');
      expect.unreachable('expected an access_denied failure');
    } catch (error) {
      expect(isAuthError(error)).toBe(true);
      if (isAuthError(error)) {
        expect(error.code).toBe('access_denied');
        expect(error.status).toBe(403);
      }
    }
  });

  it("does not default to the member's home store when none is requested", () => {
    expect(resolveStoreFilter(buildAccessContext(input()), undefined)).toBeUndefined();
  });

  it('defaults to no filter for a tenant-wide member', () => {
    expect(
      resolveStoreFilter(
        buildAccessContext(input({ member: findMember('u-t1-admin') })),
        undefined,
      ),
    ).toBeUndefined();
  });
});

describe('assertAccessAllowed', () => {
  it('allows the account center in every state but disabled', () => {
    expect(() => assertAccessAllowed(buildAccessContext(input()), 'account_center')).not.toThrow();
    const pending = buildAccessContext(input({ member: null, tenant: null, link: undefined }));
    expect(() => assertAccessAllowed(pending, 'account_center')).not.toThrow();
  });

  it('refuses the account center for a disabled context', () => {
    try {
      assertAccessAllowed(
        buildAccessContext(input({ accountStatus: 'disabled' })),
        'account_center',
      );
      expect.unreachable('expected an access_denied failure');
    } catch (error) {
      expect(isAuthError(error)).toBe(true);
      if (isAuthError(error)) {
        expect(error.code).toBe('access_denied');
      }
    }
  });

  it('refuses business data for a pending_config context with the dedicated code', () => {
    const pending = buildAccessContext(input({ member: null, tenant: null, link: undefined }));
    try {
      assertAccessAllowed(pending, 'business_data');
      expect.unreachable('expected a pending_config failure');
    } catch (error) {
      expect(isAuthError(error)).toBe(true);
      if (isAuthError(error)) {
        expect(error.code).toBe('pending_config');
        expect(error.status).toBe(403);
      }
    }
  });

  it('allows business data for an active context', () => {
    expect(() => assertAccessAllowed(buildAccessContext(input()), 'business_data')).not.toThrow();
  });
});
