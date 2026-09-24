/**
 * Platform and tenant administration.
 *
 * Where {@link AuthService} answers "who is calling", this service answers
 * "what may an administrator change": tenants, stores, members, the link that
 * binds an account to a member, the store scopes that narrow a member, and the
 * account lifecycle itself. Every mutation runs through the same
 * {@link AuthRepository} port as sign-in, so an administrative change is
 * durable in exactly the way a session is.
 *
 * Authorization is decided by the caller's {@link AccessContext} and is checked
 * *inside* this service, not only by the HTTP guard: a tenant administrator can
 * only ever reach their own tenant, and only a platform administrator can
 * create one.
 */

import {
  RandomAuthIdGenerator,
  SystemAuthClock,
  type AuthClock,
  type AuthIdGenerator,
} from './clock';
import { AuthError } from './errors';
import type { AuthRepository } from './ports';
import { assertAccessAllowed } from './access-context';
import { assertPasswordStrength, hashPassword } from './password';
import { deriveAccessState, effectiveDeviceStatus, isDeviceUsable } from './policy';
import { resolveServingStore } from './serving-store';
import type { Member, PlatformRole, Store, Tenant } from '../platform/types';
import { PLATFORM_ROLES } from '../platform/types';
import type {
  AccessContext,
  AccessState,
  AccountStatus,
  AuthSession,
  DevicePlatform,
  DeviceRevokedReason,
  DeviceStatus,
  MemberStoreScope,
  MemberUserLink,
  TrustedDevice,
  UserAccount,
} from './types';

/** Dependencies of {@link AuthAdminService}. */
export type AuthAdminServiceDeps = {
  readonly repository: AuthRepository;
  readonly clock?: AuthClock;
  readonly ids?: AuthIdGenerator;
};

/** Input for creating or updating a tenant. */
export type TenantInput = {
  readonly code: string;
  readonly name: string;
  readonly enabled?: boolean;
};

/** Input for creating a member. */
export type MemberInput = {
  readonly tenantId: string | null;
  /**
   * Store the member is written into. `null` is the whole answer for every role
   * but `agent`, whose row must carry one: an agent handed `null` gets the store
   * `resolveServingStore` picks.
   */
  readonly storeId: string | null;
  readonly role: PlatformRole;
  readonly username: string;
  readonly displayName: string;
  readonly enabled?: boolean;
};

/** Input for creating or updating a store. */
export type StoreInput = {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly enabled?: boolean;
};

/** Input for binding an account to a member. */
export type LinkMemberInput = {
  readonly userId: string;
  readonly memberId: string;
  readonly linkedBy: string | null;
};

/** Input for creating an account an administrator will hand to a person. */
export type CreateAccountInput = {
  readonly username: string;
  readonly displayName: string;
  /** Plain password, hashed before it is stored and never kept in the clear. */
  readonly password: string;
};

/** Input for granting a store scope to a member. */
export type StoreScopeInput = {
  readonly tenantId: string;
  readonly memberId: string;
  readonly storeId: string;
  readonly isPrimary?: boolean;
  readonly grantedBy: string | null;
};

/** Public account row an administrator may list (never carries a hash). */
export type AdminAccountView = {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly passwordConfigured: boolean;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  /**
   * Effective access state of the account right now, derived exactly like a
   * session's context: from the account status, its active member link, and
   * the enabled flags of that member and its tenant.
   */
  readonly accessState: AccessState;
  /** Member the account currently acts through, or `null` when unlinked. */
  readonly memberId: string | null;
  /** Tenant of that member, or `null` for a platform member. */
  readonly tenantId: string | null;
};

/** Outcome of an administrative account disable. */
export type DisableAccountResult = {
  readonly userId: string;
  readonly revokedSessions: number;
  /** Device credentials that stopped being trusted along with the account. */
  readonly revokedDevices: number;
};

/**
 * One trusted device as a platform administrator sees it.
 *
 * Deliberately not the caller's own {@link DeviceSummary}: `current` is a
 * question about *your* session among *your* devices, and an administrator
 * looking at someone else's account is neither. What is left is the lifecycle
 * an administrator acts on — never the credential or its fingerprint.
 */
export type AdminDeviceView = {
  readonly id: string;
  readonly label: string;
  readonly platform: DevicePlatform;
  /** Effective status: a device past its lifetime reads `expired` with no sweep. */
  readonly status: DeviceStatus;
  readonly trustedAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
};

/** Outcome of an administrative device revoke. */
export type RevokeAccountDeviceResult = {
  readonly userId: string;
  readonly deviceId: string;
  /** Sessions bound to that device that the revocation invalidated. */
  readonly revokedSessions: number;
};

/**
 * Whether the caller is a genuine platform principal.
 *
 * Platform authority is exactly two facts together: the member carries the
 * platform role *and* it is platform-level, so it belongs to no tenant. A
 * member that claims the role while sitting inside a tenant is not a platform
 * administrator — it is a tenant administrator claiming more than the platform
 * granted. Requiring both facts means such a record confers nothing even if it
 * reaches the database, which is what kept a merchant administrator from
 * escalating by minting one.
 *
 * This is the single predicate every platform-role branch in this service is
 * written on, so a branch added later cannot accidentally test the role alone.
 *
 * @param access - Access context of the caller.
 * @returns `true` only for a platform member holding the platform role.
 */
function isPlatformPrincipal(access: AccessContext): boolean {
  return access.role === 'platform_admin' && access.tenantId === null;
}

/**
 * Throw when the caller claims the platform role without platform scope.
 *
 * A `platform_admin` that belongs to a tenant is a contradictory record: the
 * role says it belongs to no tenant and the tenant says the opposite. It is the
 * exact row migration `0005` rejects, so it can only be a leftover from a
 * database that predates the invariant or a write that bypassed this service.
 *
 * Refusing it outright — rather than ignoring the role and judging it as a
 * tenant administrator — is deliberate: demoting it would hand the record the
 * tenant authority its tenant already grants, so minting the row would still
 * pay off. Failing closed everywhere is what makes the contradiction worthless.
 *
 * @param access - Access context of the caller.
 * @throws {AuthError} `access_denied` when the platform role is tenant-scoped.
 */
function assertPlatformRoleNotTenantScoped(access: AccessContext): void {
  if (access.role === 'platform_admin' && !isPlatformPrincipal(access)) {
    throw new AuthError('access_denied', 'platform administrator privileges are required');
  }
}

/**
 * Throw unless the caller is an active platform administrator.
 *
 * @param access - Access context of the caller.
 * @throws {AuthError} `pending_config` or `access_denied`.
 */
export function assertPlatformAdmin(access: AccessContext): void {
  assertAccessAllowed(access, 'business_data');
  if (!isPlatformPrincipal(access)) {
    throw new AuthError('access_denied', 'platform administrator privileges are required');
  }
}

/**
 * Throw unless the caller may administer a tenant.
 *
 * A platform administrator may administer any tenant. A tenant administrator
 * may administer exactly their own, which is what keeps one merchant's
 * directory invisible to another. The platform early return is written on the
 * platform-principal predicate, not on the role, so a tenant-scoped
 * `platform_admin` is refused here instead of being mistaken for one.
 *
 * @param access - Access context of the caller.
 * @param tenantId - Tenant the caller wants to change.
 * @throws {AuthError} `pending_config` or `access_denied`.
 */
export function assertTenantAdmin(access: AccessContext, tenantId: string | null): void {
  assertAccessAllowed(access, 'business_data');
  assertPlatformRoleNotTenantScoped(access);
  if (isPlatformPrincipal(access)) {
    return;
  }
  if (
    access.role !== 'merchant_admin' ||
    access.tenantId === null ||
    access.tenantId !== tenantId
  ) {
    throw new AuthError('access_denied', 'tenant administrator privileges are required');
  }
}

/** Administration of the platform directory and account lifecycle. */
export class AuthAdminService {
  readonly #repository: AuthRepository;
  readonly #clock: AuthClock;
  readonly #ids: AuthIdGenerator;

  /**
   * @param deps - Repository, clock and identifier source.
   */
  constructor(deps: AuthAdminServiceDeps) {
    this.#repository = deps.repository;
    this.#clock = deps.clock ?? new SystemAuthClock();
    this.#ids = deps.ids ?? new RandomAuthIdGenerator();
  }

  // --------------------------------------------------------------------------
  // Tenants
  // --------------------------------------------------------------------------

  /**
   * Every tenant.
   *
   * Only a platform principal sees the whole directory; everyone else sees at
   * most their own tenant, and a tenant-scoped `platform_admin` sees nothing at
   * all rather than being handed the tenant list its tenant would earn a
   * merchant administrator.
   *
   * @param access - Access context of the caller.
   * @returns Tenants visible to the caller.
   * @throws {AuthError} When the caller is not an administrator.
   */
  async listTenants(access: AccessContext): Promise<ReadonlyArray<Tenant>> {
    assertAccessAllowed(access, 'business_data');
    assertPlatformRoleNotTenantScoped(access);
    const tenants = await this.#repository.listTenants();
    if (isPlatformPrincipal(access)) {
      return tenants;
    }
    return tenants.filter((tenant) => tenant.id === access.tenantId);
  }

  /**
   * Create a tenant. Platform administrators only.
   *
   * Refused outright in this deployment, and the refusal is the point rather than
   * an oversight: the console was built for one company running its own
   * installation, so a second tenant has no screen, no switch and no seat that
   * could be attached to it — an operator who reached this would be creating a
   * row they cannot see or use. The method is kept, and reached only from the
   * endpoint, so that "the platform cannot do this" is a sentence in the code
   * rather than an absence somebody later reads as a gap.
   *
   * @param access - Access context of the caller.
   * @param input - Tenant code, name and enabled flag.
   * @returns The created tenant.
   * @throws {AuthError} `access_denied` for every caller: the deployment holds
   * exactly the one organisation it was installed for.
   */
  async createTenant(access: AccessContext, _input: TenantInput): Promise<Tenant> {
    assertPlatformAdmin(access);
    // Unconditional, and deliberately ahead of any body validation: the answer
    // must not depend on what was sent, or a later reader would take the
    // differing answers for a working endpoint with one broken case.
    throw new AuthError(
      'access_denied',
      'this deployment serves one organisation; creating a second is not supported',
    );
  }

  /**
   * Enable or disable a tenant.
   *
   * Refused in this deployment, and the reason is one step worse than
   * {@link createTenant}'s. The deployment holds a single enabled organisation,
   * and every business read resolves through it: switching it off leaves the
   * console loading, and the account center is the only screen that still
   * answers — which offers no way to switch it back on. The one row this could
   * act on is the one row it must not touch.
   *
   * @param access - Access context of the caller.
   * @param tenantId - Tenant that would be changed.
   * @param enabled - New enabled flag.
   * @returns The updated tenant.
   * @throws {AuthError} `access_denied` for every caller, whatever the argument.
   */
  async setTenantEnabled(
    access: AccessContext,
    _tenantId: string,
    _enabled: boolean,
  ): Promise<Tenant> {
    assertPlatformAdmin(access);
    throw new AuthError(
      'access_denied',
      'this deployment serves one organisation; it cannot be switched off from here',
    );
  }

  // --------------------------------------------------------------------------
  // Stores
  // --------------------------------------------------------------------------

  /**
   * Stores of a tenant.
   *
   * @param access - Access context of the caller.
   * @param tenantId - Tenant to list.
   * @returns Stores of the tenant, ordered by id.
   * @throws {AuthError} When the caller may not administer the tenant.
   */
  async listStores(access: AccessContext, tenantId: string): Promise<ReadonlyArray<Store>> {
    assertTenantAdmin(access, tenantId);
    return this.#repository.listStores(tenantId);
  }

  /**
   * Create a store inside a tenant.
   *
   * @param access - Access context of the caller.
   * @param input - Owning tenant, code, name and enabled flag.
   * @returns The created store.
   * @throws {AuthError} `not_found` for an unknown tenant, or a duplicate code.
   */
  async createStore(access: AccessContext, input: StoreInput): Promise<Store> {
    assertTenantAdmin(access, input.tenantId);
    await this.#requireTenant(input.tenantId);
    const code = requireText(input.code, 'store code');
    const existing = await this.#repository.listStores(input.tenantId);
    if (existing.some((store) => store.code.toLowerCase() === code.toLowerCase())) {
      throw new AuthError('identity_conflict', 'the store code is already in use');
    }
    const store: Store = {
      id: this.#ids.next('store'),
      tenantId: input.tenantId,
      code,
      name: requireText(input.name, 'store name'),
      enabled: input.enabled ?? true,
      createdAt: this.#clock.now(),
    };
    await this.#repository.saveStore(store);
    return store;
  }

  /**
   * Enable or disable a store.
   *
   * @param access - Access context of the caller.
   * @param storeId - Store to change.
   * @param enabled - New enabled flag.
   * @returns The updated store.
   * @throws {AuthError} `not_found` when the store does not exist.
   */
  async setStoreEnabled(access: AccessContext, storeId: string, enabled: boolean): Promise<Store> {
    const store = await this.#repository.findStoreById(storeId);
    if (store === undefined) {
      throw new AuthError('identity_not_bound', 'the store does not exist');
    }
    assertTenantAdmin(access, store.tenantId);
    const updated: Store = { ...store, enabled };
    await this.#repository.saveStore(updated);
    return updated;
  }

  // --------------------------------------------------------------------------
  // Members
  // --------------------------------------------------------------------------

  /**
   * Members of a tenant.
   *
   * @param access - Access context of the caller.
   * @param tenantId - Tenant to list.
   * @returns Members of the tenant, ordered by id.
   * @throws {AuthError} When the caller may not administer the tenant.
   */
  async listMembers(access: AccessContext, tenantId: string): Promise<ReadonlyArray<Member>> {
    assertTenantAdmin(access, tenantId);
    return this.#repository.listMembers(tenantId);
  }

  /**
   * Create a member inside a tenant, or a platform-level one.
   *
   * The role and the tenant are one decision, not two: a platform
   * administrator is platform-level and belongs to no tenant, and every other
   * role belongs to one. The pair is checked before anything is written, so a
   * tenant administrator can never mint a platform administrator — not even
   * one scoped to their own tenant.
   *
   * An `agent` may be created without a store and will get one; see
   * {@link #resolveMemberStore}.
   *
   * @param access - Access context of the caller.
   * @param input - Tenant, store (optional for an agent), role and profile.
   * @returns The created member.
   * @throws {AuthError} `access_denied` when the caller may not grant the role,
   * `invalid_request` for a bad role, store or role/tenant combination,
   * `not_found` for an unknown tenant.
   */
  async createMember(access: AccessContext, input: MemberInput): Promise<Member> {
    assertTenantAdmin(access, input.tenantId);
    if (input.tenantId === null) {
      assertPlatformAdmin(access);
    } else {
      await this.#requireTenant(input.tenantId);
    }
    assertRole(input.role);
    const storeId = await this.#resolveMemberStore(input);
    assertMemberScope(access, input.role, input.tenantId, storeId);
    await this.#assertStoreBelongsToTenant(storeId, input.tenantId);

    const member: Member = {
      id: this.#ids.next('member'),
      tenantId: input.tenantId,
      storeId,
      role: input.role,
      username: requireText(input.username, 'member username'),
      displayName: requireText(input.displayName, 'member display name'),
      enabled: input.enabled ?? true,
      createdAt: this.#clock.now(),
    };
    await this.#repository.saveMember(member);
    return member;
  }

  /**
   * The store a new member is written into.
   *
   * An `agent` handed no store gets the one {@link resolveServingStore} picks.
   * Nobody is asked, because there is nothing to ask about: the column is a
   * requirement of the schema rather than something the seat reads through — a
   * seat reaches every conversation of its tenant — so a question would be a
   * question with no consequence.
   *
   * Every other role keeps what it was handed: `null` is a fact about them (a
   * platform administrator belongs to no tenant; a merchant administrator owns
   * the whole one), not a value waiting to be filled in.
   *
   * @param input - The member about to be written.
   * @returns The store id to store on the row.
   */
  async #resolveMemberStore(input: MemberInput): Promise<string | null> {
    if (input.role !== 'agent' || input.storeId !== null || input.tenantId === null) {
      return input.storeId;
    }
    const store = await resolveServingStore({
      repository: this.#repository,
      ids: this.#ids,
      now: this.#clock.now(),
      tenantId: input.tenantId,
    });
    return store.id;
  }

  /**
   * Change a member's role.
   *
   * Moving a member to `platform_admin` is a platform decision and only a
   * platform-level member can hold the role, so a tenant administrator cannot
   * promote their way out of their tenant. The member's own tenant is the one
   * that counts here: it is the record being changed, and it does not move.
   *
   * @param access - Access context of the caller.
   * @param memberId - Member to change.
   * @param role - New role.
   * @returns The updated member.
   * @throws {AuthError} `access_denied` when the caller may not grant the role,
   * `not_found` or `invalid_request` for a bad role or role/tenant combination.
   */
  async setMemberRole(
    access: AccessContext,
    memberId: string,
    role: PlatformRole,
  ): Promise<Member> {
    assertRole(role);
    const member = await this.#requireMember(memberId);
    assertTenantAdmin(access, member.tenantId);
    assertMemberScope(access, role, member.tenantId, member.storeId);
    const updated: Member = { ...member, role };
    await this.#repository.saveMember(updated);
    return updated;
  }

  /**
   * Enable or disable a member.
   *
   * A disabled member resolves every session that acts through it to
   * `disabled`, which refuses even the account center — the account center is
   * for accounts that are merely unconfigured, not for members that were
   * deliberately switched off.
   *
   * @param access - Access context of the caller.
   * @param memberId - Member to change.
   * @param enabled - New enabled flag.
   * @returns The updated member.
   * @throws {AuthError} `not_found` when the member does not exist.
   */
  async setMemberEnabled(
    access: AccessContext,
    memberId: string,
    enabled: boolean,
  ): Promise<Member> {
    const member = await this.#requireMember(memberId);
    assertTenantAdmin(access, member.tenantId);
    const updated: Member = { ...member, enabled };
    await this.#repository.saveMember(updated);
    return updated;
  }

  // --------------------------------------------------------------------------
  // Member linkage
  // --------------------------------------------------------------------------

  /**
   * Bind an account to a member.
   *
   * A member has at most one active link, so rebinding revokes the previous one
   * instead of leaving two accounts able to act as the same member.
   *
   * @param access - Access context of the caller.
   * @param input - Account, member and the acting administrator.
   * @returns The created link.
   * @throws {AuthError} `not_found` when the account or member does not exist.
   */
  async linkMember(access: AccessContext, input: LinkMemberInput): Promise<MemberUserLink> {
    const member = await this.#requireMember(input.memberId);
    assertTenantAdmin(access, member.tenantId);
    const user = await this.#repository.getUser(input.userId);
    if (user === undefined) {
      throw new AuthError('identity_not_bound', 'the account does not exist');
    }

    const now = this.#clock.now();
    const previous = await this.#repository.getActiveLinkForMember(member.id);
    if (previous !== undefined) {
      if (previous.userId === input.userId) {
        return previous;
      }
      await this.#repository.saveLink({ ...previous, revokedAt: now, updatedAt: now });
      await this.#revokeSessionsForUser(previous.userId, now);
    }

    const link: MemberUserLink = {
      id: this.#ids.next('link'),
      userId: input.userId,
      tenantId: member.tenantId,
      memberId: member.id,
      linkedBy: input.linkedBy,
      linkedAt: now,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#repository.saveLink(link);
    return link;
  }

  /**
   * Revoke the active link of a member.
   *
   * The account keeps working: with no member link it resolves to
   * `pending_config`, so it can still reach its own account center.
   *
   * @param access - Access context of the caller.
   * @param memberId - Member whose link is revoked.
   * @returns The revoked link, or `null` when the member had none.
   * @throws {AuthError} `not_found` when the member does not exist.
   */
  async revokeLink(access: AccessContext, memberId: string): Promise<MemberUserLink | null> {
    const member = await this.#requireMember(memberId);
    assertTenantAdmin(access, member.tenantId);
    const link = await this.#repository.getActiveLinkForMember(memberId);
    if (link === undefined) {
      return null;
    }
    const now = this.#clock.now();
    const revoked: MemberUserLink = { ...link, revokedAt: now, updatedAt: now };
    await this.#repository.saveLink(revoked);
    return revoked;
  }

  // --------------------------------------------------------------------------
  // Store scopes
  // --------------------------------------------------------------------------

  /**
   * Active store scopes of a member.
   *
   * @param access - Access context of the caller.
   * @param memberId - Member to inspect.
   * @returns Active scopes of the member.
   * @throws {AuthError} `not_found` when the member does not exist.
   */
  async listStoreScopes(
    access: AccessContext,
    memberId: string,
  ): Promise<ReadonlyArray<MemberStoreScope>> {
    const member = await this.#requireMember(memberId);
    assertTenantAdmin(access, member.tenantId);
    if (member.tenantId === null) {
      return [];
    }
    return this.#repository.listActiveStoreScopes(member.tenantId, member.id);
  }

  /**
   * Grant a store scope to a member.
   *
   * @param access - Access context of the caller.
   * @param input - Tenant, member, store and primary flag.
   * @returns The granted scope.
   * @throws {AuthError} `not_found` for an unknown member or store, or
   * `access_denied` when the store is outside the tenant.
   */
  async grantStoreScope(access: AccessContext, input: StoreScopeInput): Promise<MemberStoreScope> {
    assertTenantAdmin(access, input.tenantId);
    const member = await this.#requireMember(input.memberId);
    if (member.tenantId !== input.tenantId) {
      throw new AuthError('access_denied', 'the member belongs to a different tenant');
    }
    const store = await this.#repository.getStore(input.tenantId, input.storeId);
    if (store === undefined) {
      throw new AuthError('identity_not_bound', 'the store does not exist in this tenant');
    }

    const now = this.#clock.now();
    if (input.isPrimary === true) {
      // The schema allows at most one primary scope per member, so promoting a
      // store demotes whichever one held the flag before.
      const scopes = await this.#repository.listActiveStoreScopes(input.tenantId, member.id);
      for (const scope of scopes) {
        if (scope.isPrimary && scope.storeId !== input.storeId) {
          await this.#repository.saveStoreScope({ ...scope, isPrimary: false, updatedAt: now });
        }
      }
    }

    const scope: MemberStoreScope = {
      tenantId: input.tenantId,
      memberId: member.id,
      storeId: store.id,
      isPrimary: input.isPrimary ?? false,
      grantedBy: input.grantedBy,
      grantedAt: now,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#repository.saveStoreScope(scope);
    return scope;
  }

  /**
   * Revoke a store scope from a member.
   *
   * @param access - Access context of the caller.
   * @param memberId - Member whose scope is revoked.
   * @param storeId - Store to remove from the member's scope.
   * @returns Whether a scope was revoked.
   * @throws {AuthError} `not_found` when the member does not exist.
   */
  async revokeStoreScope(
    access: AccessContext,
    memberId: string,
    storeId: string,
  ): Promise<{ revoked: boolean }> {
    const member = await this.#requireMember(memberId);
    assertTenantAdmin(access, member.tenantId);
    if (member.tenantId === null) {
      return { revoked: false };
    }
    const scopes = await this.#repository.listActiveStoreScopes(member.tenantId, member.id);
    if (!scopes.some((scope) => scope.storeId === storeId)) {
      return { revoked: false };
    }
    await this.#repository.revokeStoreScope(member.tenantId, member.id, storeId, this.#clock.now());
    return { revoked: true };
  }

  // --------------------------------------------------------------------------
  // Accounts
  // --------------------------------------------------------------------------

  /**
   * Create an account with a password.
   *
   * This is {@link AuthService.register} without registration's door: it writes
   * the same two rows — an `active` account carrying an encoded hash, and the
   * verified `password` identity that names it — and then stops. The account
   * holds no member link, so it reaches nothing but its own account center until
   * an administrator binds it with {@link linkMember}; that link is a separate
   * decision and this method makes no guess about which member was meant.
   *
   * Platform administrators only. An account is a platform-wide identity rather
   * than a tenant's property, which is the same reason disabling one is theirs
   * alone.
   *
   * @param access - Access context of the caller.
   * @param input - Username, display name and the password to hash.
   * @returns The new account, projected exactly like a listed one.
   * @throws {AuthError} `access_denied` when the caller is not a platform
   * administrator, `invalid_request` on a blank username or display name,
   * `password_too_weak` when the password fails the shared policy, and
   * `username_taken` when either the account table or the password identity
   * already holds that username.
   */
  async createAccount(access: AccessContext, input: CreateAccountInput): Promise<AdminAccountView> {
    assertPlatformAdmin(access);
    const username = input.username.trim();
    const displayName = input.displayName.trim();
    if (username.length === 0) {
      throw new AuthError('invalid_request', 'username must not be empty');
    }
    if (displayName.length === 0) {
      throw new AuthError('invalid_request', 'display name must not be empty');
    }
    // The same policy registration applies: an account an administrator made is
    // exactly as weak as one a person registered, so it cannot be held to less.
    assertPasswordStrength(input.password);

    // Both halves of a password sign-in have to be free. The account table holds
    // the display row and the identity table holds what login actually looks up,
    // and a row left over in either one would answer a later sign-in with the
    // wrong account.
    if ((await this.#repository.findUserByUsername(username)) !== undefined) {
      throw new AuthError('username_taken', 'the username is already registered');
    }
    if ((await this.#repository.findIdentity('password', username)) !== undefined) {
      throw new AuthError('username_taken', 'the username is already registered');
    }

    const now = this.#clock.now();
    const account: UserAccount = {
      id: this.#ids.next('user'),
      username,
      displayName,
      status: 'active',
      passwordHash: hashPassword(input.password),
      passwordUpdatedAt: now,
      failedLoginCount: 0,
      lockedUntil: null,
      // Nobody has signed in as this account yet, and it is not the creation
      // that makes a sign-in: `lastLoginAt` stays empty until one happens.
      lastLoginAt: null,
      avatarUrl: null,
      idempotencyKey: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#repository.saveUser(account);
    // A password identity exists exactly when there is a password to use it, so
    // the row never claims a credential the account does not have.
    await this.#repository.saveIdentity({
      id: this.#ids.next('identity'),
      userId: account.id,
      provider: 'password',
      subject: username,
      verified: true,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return this.#accountView(account, access);
  }

  /**
   * Accounts matching an optional username fragment.
   *
   * Each row carries the account's current linkage and effective access state,
   * so an administrator can see at a glance which accounts are usable and
   * which are still waiting for a member link. A platform administrator sees
   * every account; a tenant administrator still sees only the accounts of
   * their own tenant.
   *
   * @param access - Access context of the caller.
   * @param query - Optional case-insensitive fragment of username or display name.
   * @returns Public account rows, ordered by id.
   * @throws {AuthError} When the caller is not an administrator.
   */
  async listAccounts(
    access: AccessContext,
    query: string | undefined,
  ): Promise<ReadonlyArray<AdminAccountView>> {
    assertAccessAllowed(access, 'business_data');
    assertPlatformRoleNotTenantScoped(access);
    if (!isPlatformPrincipal(access) && access.role !== 'merchant_admin') {
      throw new AuthError('access_denied', 'administrator privileges are required');
    }
    const needle = query?.trim().toLowerCase() ?? '';
    const accounts = await this.#collectAccounts(access);
    const visible = accounts.filter(
      (account) =>
        needle.length === 0 ||
        account.username.toLowerCase().includes(needle) ||
        account.displayName.toLowerCase().includes(needle),
    );
    return Promise.all(visible.map((account) => this.#accountView(account, access)));
  }

  /**
   * Disable an account and revoke its sessions.
   *
   * An account is a platform-wide identity: the same account may act through
   * members of several tenants, so switching it off is not a decision any one
   * tenant owns. Only a platform administrator may make it, which is why the
   * caller is checked before the target account is even read.
   *
   * @param access - Access context of the caller.
   * @param userId - Account to disable.
   * @returns The account id and how many sessions were revoked.
   * @throws {AuthError} `access_denied` when the caller is not a platform
   * administrator, `identity_not_bound` when the account does not exist.
   */
  async disableAccount(access: AccessContext, userId: string): Promise<DisableAccountResult> {
    assertPlatformAdmin(access);
    const account = await this.#repository.getUser(userId);
    if (account === undefined) {
      throw new AuthError('identity_not_bound', 'the account does not exist');
    }
    const now = this.#clock.now();
    await this.#repository.saveUser({ ...account, status: 'disabled', updatedAt: now });
    const revokedSessions = await this.#revokeSessionsForUser(userId, now);
    // A device credential outlives the session it was created in, so disabling
    // the account has to reach it separately — otherwise switching the account
    // off would leave its remembered devices trusted for the rest of their term.
    const revokedDevices = await this.#revokeDevicesForUser(userId, 'admin', now);
    return { userId, revokedSessions, revokedDevices };
  }

  /**
   * Re-enable a previously disabled account.
   *
   * Like {@link disableAccount}, the account lifecycle belongs to the platform
   * administrator alone, so a tenant administrator is refused before the
   * account is read.
   *
   * @param access - Access context of the caller.
   * @param userId - Account to enable.
   * @returns The updated account.
   * @throws {AuthError} `access_denied` when the caller is not a platform
   * administrator, `identity_not_bound` when the account does not exist.
   */
  async enableAccount(access: AccessContext, userId: string): Promise<AdminAccountView> {
    assertPlatformAdmin(access);
    const account = await this.#repository.getUser(userId);
    if (account === undefined) {
      throw new AuthError('identity_not_bound', 'the account does not exist');
    }
    const updated: UserAccount = {
      ...account,
      status: 'active',
      failedLoginCount: 0,
      lockedUntil: null,
      updatedAt: this.#clock.now(),
    };
    await this.#repository.saveUser(updated);
    return this.#accountView(updated, access);
  }

  // --------------------------------------------------------------------------
  // Applications
  // --------------------------------------------------------------------------

  /**
   * Approve a pending registration: the account becomes an agent.
   *
   * Registration deliberately leaves an account holding nothing — `pending`, no
   * member link — and this is the one decision that changes that. It creates the
   * `agent` member the account will act through and links the two, so the very
   * next `GET /auth/session` the applicant's waiting tab makes resolves to
   * `active` and opens the console on the workbench.
   *
   * The tenant is not the administrator's to choose here, and that is the point
   * of this deployment's shape rather than an omission: there is one organisation
   * to join, so a chooser would be a question with one answer. The store is the
   * same kind of question, answered the same way: `members` requires a non-null
   * `store_id` of every `agent` (the kernel migration's CHECK), and
   * {@link resolveServingStore} supplies one — the store the tenant's seats
   * already serve in, or the default store if there is none. It is not asked of
   * the administrator because the column no longer decides anything the seat can
   * see: an agent reads the whole tenant.
   *
   * Safe to call twice: an interrupted approval is *resumed*, not repeated. A
   * member already carrying the account's username in that tenant is reused
   * rather than duplicated, and {@link linkMember} returns the existing link for
   * the same pair. Without that, a half-written first attempt would leave an
   * orphan member that the retry collides with, and the administrator would be
   * asked to clean up by hand after a click that is supposed to mean "yes".
   *
   * @param access - Access context of the caller.
   * @param userId - The pending account to approve.
   * @returns The account row, now linked and `active`.
   * @throws {AuthError} `access_denied` when the caller is not a platform
   * administrator, `identity_not_bound` when the account does not exist,
   * `invalid_request` when it is not awaiting approval or this deployment has no
   * enabled organisation to join.
   */
  async approveAccount(access: AccessContext, userId: string): Promise<AdminAccountView> {
    assertPlatformAdmin(access);
    const account = await this.#requirePendingAccount(userId);
    const tenant = await this.#deploymentTenant();

    const existing = (await this.#repository.listMembers(tenant.id)).find(
      (member) => member.username === account.username,
    );
    const member =
      existing ??
      (await this.createMember(access, {
        tenantId: tenant.id,
        storeId: null,
        role: 'agent',
        username: account.username,
        displayName: account.displayName,
      }));
    await this.linkMember(access, {
      memberId: member.id,
      userId: account.id,
      linkedBy: access.userId,
    });

    const approved: UserAccount = { ...account, status: 'active', updatedAt: this.#clock.now() };
    await this.#repository.saveUser(approved);
    return this.#accountView(approved, access);
  }

  /**
   * Reject a pending registration.
   *
   * Refusal is recorded as the account being switched *off* — the state an
   * administrator already reaches through {@link disableAccount}, and the state
   * the platform already refuses a sign-in for — rather than as a terminal state
   * of its own. The account lifecycle has exactly the values it needs; a fourth
   * would have to be taught to the policy, to the wire format and to every screen
   * that reads an access state, and would say that a rejected applicant walked up
   * to a different locked door than a disabled one did.
   *
   * It revokes the applicant's sessions, so the waiting tab stops being able to
   * ask. A rejection that left that tab polling would be a decision its subject
   * cannot observe.
   *
   * @param access - Access context of the caller.
   * @param userId - The pending account to reject.
   * @returns The account row, now disabled.
   * @throws {AuthError} `access_denied` when the caller is not a platform
   * administrator, `identity_not_bound` when the account does not exist,
   * `invalid_request` when it is not awaiting approval.
   */
  async rejectAccount(access: AccessContext, userId: string): Promise<AdminAccountView> {
    assertPlatformAdmin(access);
    const account = await this.#requirePendingAccount(userId);
    await this.disableAccount(access, userId);
    const rejected: UserAccount = { ...account, status: 'disabled', updatedAt: this.#clock.now() };
    return this.#accountView(rejected, access);
  }

  /**
   * The account behind an application, or a refusal explaining why it is not one.
   *
   * Approval and rejection are decisions about a *request*, so an account that is
   * already past that point is refused rather than quietly re-decided: approving
   * an active account would mean re-linking someone who is already inside, and
   * rejecting an active one would be firing them through a control labelled
   * "不通过". Both have their own controls.
   */
  async #requirePendingAccount(userId: string): Promise<UserAccount> {
    const account = await this.#repository.getUser(userId);
    if (account === undefined) {
      throw new AuthError('identity_not_bound', 'the account does not exist');
    }
    if (account.status !== 'pending') {
      throw new AuthError('invalid_request', 'the account is not awaiting approval');
    }
    return account;
  }

  /**
   * The organisation an approved agent joins.
   *
   * This deployment serves one company, so the answer is the first enabled tenant
   * — the same one the console lands a platform administrator on — and there is
   * deliberately no parameter to choose a different one. A tenant that is switched
   * off resolves every session through it to `pending_config`, so joining one
   * would approve an applicant straight into a second waiting room; that case is
   * reported instead.
   */
  async #deploymentTenant(): Promise<Tenant> {
    const tenant = (await this.#repository.listTenants()).find((candidate) => candidate.enabled);
    if (tenant === undefined) {
      throw new AuthError('invalid_request', 'this deployment has no enabled organisation to join');
    }
    return tenant;
  }

  // --------------------------------------------------------------------------
  // Trusted devices
  // --------------------------------------------------------------------------

  /**
   * Trusted devices of one account, newest first.
   *
   * Platform administrators only, for the same reason disabling an account is:
   * a device credential is a platform-wide identity artefact, not a tenant's
   * property, and a merchant administrator sees the members of their own tenant
   * rather than the accounts behind them.
   *
   * @param access - Access context of the caller.
   * @param userId - Account whose devices are read.
   * @returns Device lifecycle rows; never a credential or its fingerprint.
   * @throws {AuthError} `access_denied` when the caller is not a platform
   * administrator, `identity_not_bound` when the account does not exist.
   */
  async listAccountDevices(
    access: AccessContext,
    userId: string,
  ): Promise<ReadonlyArray<AdminDeviceView>> {
    assertPlatformAdmin(access);
    const account = await this.#repository.getUser(userId);
    if (account === undefined) {
      throw new AuthError('identity_not_bound', 'the account does not exist');
    }
    const now = this.#clock.now();
    const devices = await this.#repository.listDevices(userId);
    return devices.map((device) => toAdminDeviceView(device, now));
  }

  /**
   * Revoke one trusted device of an account and every session bound to it.
   *
   * The account itself keeps working: this retires one remembered device, not
   * the account. Revocation is recorded with the `admin` reason so the audit
   * trail distinguishes a support action from the user's own "forget this
   * device" and from the automatic retirement a password reset performs.
   *
   * @param access - Access context of the caller.
   * @param userId - Account the device must belong to.
   * @param deviceId - Device to revoke.
   * @returns The account, the device and how many sessions were invalidated.
   * @throws {AuthError} `access_denied` when the caller is not a platform
   * administrator, `device_not_found` when the device is not this account's,
   * `device_revoked` when it is already revoked.
   */
  async revokeAccountDevice(
    access: AccessContext,
    userId: string,
    deviceId: string,
  ): Promise<RevokeAccountDeviceResult> {
    assertPlatformAdmin(access);
    const device = await this.#repository.getDevice(deviceId);
    if (device === undefined || device.userId !== userId) {
      throw new AuthError('device_not_found', 'the device is not enrolled for this account');
    }
    const now = this.#clock.now();
    if (effectiveDeviceStatus(device, now) === 'revoked') {
      throw new AuthError('device_revoked', 'the device is already revoked');
    }

    await this.#repository.saveDevice({
      ...device,
      status: 'revoked',
      revokedAt: now,
      revokedReason: 'admin',
      updatedAt: now,
    });

    const bound = await this.#repository.listSessionsForDevice(deviceId);
    let revokedSessions = 0;
    for (const session of bound) {
      if (session.status === 'active') {
        const revokedSession: AuthSession = {
          ...session,
          status: 'revoked',
          revokedAt: now,
          revokedReason: 'admin_revoked',
          updatedAt: now,
        };
        await this.#repository.saveSession(revokedSession);
        revokedSessions += 1;
      }
    }
    return { userId, deviceId, revokedSessions };
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Project one account with the linkage and access state an administrator needs.
   *
   * The state is derived from live rows — the active member link, the member it
   * names and that member's tenant — with the same rules a session's access
   * context is built from, so the list and the caller's own context can never
   * disagree about what "usable" means. A missing member (a link to a deleted
   * member) is treated exactly like an unlinked account: `pending_config`.
   *
   * An account is platform-wide and may act through members of several tenants
   * at once, so which link the row names depends on who is asking. A tenant
   * administrator is shown the link into their own tenant and nothing else — a
   * row that named another tenant's member would describe access the caller
   * cannot see and must not be trusted to interpret. A platform administrator,
   * who is not scoped to a tenant, is shown the newest active link.
   *
   * @param account - Account to project.
   * @param access - Access context of the caller the row is projected for.
   */
  async #accountView(account: UserAccount, access: AccessContext): Promise<AdminAccountView> {
    const member = await this.#selectMemberFor(account.id, access);
    const tenant =
      member === undefined || member.tenantId === null
        ? undefined
        : await this.#repository.getTenant(member.tenantId);
    return toAdminAccountView(account, {
      accessState: deriveAccessState({
        accountStatus: account.status,
        memberEnabled: member === undefined ? null : member.enabled,
        tenantEnabled: tenant === undefined ? null : tenant.enabled,
        hasActiveMemberLink: member !== undefined,
      }),
      memberId: member?.id ?? null,
      tenantId: member?.tenantId ?? null,
    });
  }

  /**
   * The member an administrative row for one account should act through.
   *
   * Candidates are every active link of the account whose member still exists,
   * narrowed to the caller's own tenant unless the caller is a platform
   * principal. The narrowing compares the member's *actual* `tenantId`, not the
   * tenant recorded on the link: the link is a historical record of where it was
   * created, the member row is where the member belongs, and it is the member
   * the row would act through.
   *
   * Candidates are then ordered by `linkedAt` descending and by link id
   * descending. The ordering is what makes the projection independent of the
   * adapter: the durable adapter orders by `linked_at`, the in-memory one
   * returns insertion order, and neither breaks a tie, so only an explicit
   * order can guarantee the same row from either.
   *
   * @param userId - Account whose link is selected.
   * @param access - Access context of the caller the row is projected for.
   * @returns The selected member, or `undefined` when no link qualifies.
   */
  async #selectMemberFor(userId: string, access: AccessContext): Promise<Member | undefined> {
    const links = await this.#repository.listActiveLinksForUser(userId);
    const candidates: Array<{ readonly link: MemberUserLink; readonly member: Member }> = [];
    for (const link of links) {
      const member = await this.#repository.getMember(link.memberId);
      if (member === undefined || !isMemberVisibleTo(access, member)) {
        continue;
      }
      candidates.push({ link, member });
    }
    candidates.sort(compareLinkRecency);
    return candidates[0]?.member;
  }

  /** Every account the caller may see. */
  async #collectAccounts(access: AccessContext): Promise<ReadonlyArray<UserAccount>> {
    if (isPlatformPrincipal(access)) {
      return this.#repository.listAllAccounts();
    }
    if (access.tenantId === null) {
      return [];
    }
    const members = await this.#repository.listMembers(access.tenantId);
    const accounts = new Map<string, UserAccount>();
    for (const member of members) {
      const link = await this.#repository.getActiveLinkForMember(member.id);
      if (link === undefined) {
        continue;
      }
      const account = await this.#repository.getUser(link.userId);
      if (account !== undefined) {
        accounts.set(account.id, account);
      }
    }
    return [...accounts.values()];
  }

  /** @throws {AuthError} `not_found` when the tenant does not exist. */
  async #requireTenant(tenantId: string): Promise<Tenant> {
    const tenant = await this.#repository.getTenant(tenantId);
    if (tenant === undefined) {
      throw new AuthError('identity_not_bound', 'the tenant does not exist');
    }
    return tenant;
  }

  /** @throws {AuthError} `not_found` when the member does not exist. */
  async #requireMember(memberId: string): Promise<Member> {
    const member = await this.#repository.getMember(memberId);
    if (member === undefined) {
      throw new AuthError('identity_not_bound', 'the member does not exist');
    }
    return member;
  }

  /** @throws {AuthError} `access_denied` when the store is outside the tenant. */
  async #assertStoreBelongsToTenant(
    storeId: string | null,
    tenantId: string | null,
  ): Promise<void> {
    if (storeId === null) {
      return;
    }
    if (tenantId === null) {
      throw new AuthError('access_denied', 'a store requires a tenant');
    }
    const store = await this.#repository.getStore(tenantId, storeId);
    if (store === undefined) {
      throw new AuthError('identity_not_bound', 'the store does not exist in this tenant');
    }
  }

  /** Revoke every active session of an account. */
  /** Revoke every live trusted device of an account and report how many. */
  async #revokeDevicesForUser(
    userId: string,
    reason: DeviceRevokedReason,
    now: string,
  ): Promise<number> {
    const devices = await this.#repository.listDevices(userId);
    let revoked = 0;
    for (const device of devices) {
      if (isDeviceUsable(device, now)) {
        await this.#repository.saveDevice({
          ...device,
          status: 'revoked',
          revokedAt: now,
          revokedReason: reason,
          updatedAt: now,
        });
        revoked += 1;
      }
    }
    return revoked;
  }

  async #revokeSessionsForUser(userId: string, now: string): Promise<number> {
    const sessions = await this.#repository.listSessionsForUser(userId);
    let revoked = 0;
    for (const session of sessions) {
      if (session.status === 'active') {
        const revokedSession: AuthSession = {
          ...session,
          status: 'revoked',
          revokedAt: now,
          revokedReason: 'admin_revoked',
          updatedAt: now,
        };
        await this.#repository.saveSession(revokedSession);
        revoked += 1;
      }
    }
    return revoked;
  }
}

/** Reject an empty required text field. */
function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AuthError('invalid_request', `${label} must not be empty`);
  }
  return trimmed;
}

/** Reject a role the platform does not define. */
function assertRole(role: string): asserts role is PlatformRole {
  if (!(PLATFORM_ROLES as ReadonlyArray<string>).includes(role)) {
    throw new AuthError('invalid_request', 'the role is not recognized');
  }
}

/**
 * Reject a role the member's tenant context cannot hold.
 *
 * The platform invariant is exact: a `platform_admin` member is platform-level
 * — no tenant and no store — and every other role belongs to a tenant. It is
 * enforced here, before anything is persisted; the database constraint added by
 * migration `0005` states the same rule, so a write that skipped this guard is
 * refused by the schema instead of being stored.
 *
 * @param access - Access context of the caller granting the role.
 * @param role - Role the member would hold.
 * @param tenantId - Tenant the member would belong to.
 * @param storeId - Home store the member would carry.
 * @throws {AuthError} `access_denied` when the caller may not grant the role,
 * `invalid_request` when no valid member can have that role in that context.
 */
function assertMemberScope(
  access: AccessContext,
  role: PlatformRole,
  tenantId: string | null,
  storeId: string | null,
): void {
  if (role !== 'platform_admin') {
    if (tenantId === null) {
      throw new AuthError('invalid_request', 'a non-platform member must belong to a tenant');
    }
    return;
  }
  if (!isPlatformPrincipal(access)) {
    throw new AuthError('access_denied', 'platform administrator privileges are required');
  }
  if (tenantId !== null) {
    throw new AuthError('invalid_request', 'a platform administrator must not belong to a tenant');
  }
  if (storeId !== null) {
    throw new AuthError(
      'invalid_request',
      'a platform administrator must not be scoped to a store',
    );
  }
}

/**
 * Whether one member is inside the caller's own tenant scope.
 *
 * A platform principal is not scoped to a tenant at all, so every member
 * qualifies. Everyone else is compared on the member's actual `tenantId`
 * against the caller's own. A caller that is tenant-less but *not* a platform
 * principal qualifies for nothing: matching on two nulls would hand such a
 * caller every platform-level member, so the projection closes instead.
 *
 * @param access - Access context of the caller.
 * @param member - Member the link would act through.
 * @returns `true` when the caller may be shown this member.
 */
function isMemberVisibleTo(access: AccessContext, member: Member): boolean {
  if (isPlatformPrincipal(access)) {
    return true;
  }
  return access.tenantId !== null && member.tenantId === access.tenantId;
}

/**
 * Order candidate links newest first, breaking ties on the link id.
 *
 * `linkedAt` is compared as the ISO-8601 strings the repository stores, which
 * sort chronologically; ids are compared as plain strings so the result does
 * not depend on the runtime's locale. Both comparisons descending, so the
 * *last* link recorded is the one projected.
 *
 * @param a - First candidate.
 * @param b - Second candidate.
 * @returns A negative number when `a` is the newer link.
 */
function compareLinkRecency(
  a: { readonly link: MemberUserLink },
  b: { readonly link: MemberUserLink },
): number {
  if (a.link.linkedAt !== b.link.linkedAt) {
    return a.link.linkedAt < b.link.linkedAt ? 1 : -1;
  }
  if (a.link.id === b.link.id) {
    return 0;
  }
  return a.link.id < b.link.id ? 1 : -1;
}

/** Linkage and access facts resolved for one administrative account row. */
type AccountViewFacts = {
  readonly accessState: AccessState;
  readonly memberId: string | null;
  readonly tenantId: string | null;
};

/** Project an account into the administrative view. */
function toAdminAccountView(account: UserAccount, facts: AccountViewFacts): AdminAccountView {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    status: account.status,
    passwordConfigured: account.passwordHash !== null,
    lastLoginAt: account.lastLoginAt,
    createdAt: account.createdAt,
    accessState: facts.accessState,
    memberId: facts.memberId,
    tenantId: facts.tenantId,
  };
}

/** Project one stored device for an administrator, resolving its liveness. */
function toAdminDeviceView(device: TrustedDevice, now: string): AdminDeviceView {
  return {
    id: device.id,
    label: device.label,
    platform: device.platform,
    status: effectiveDeviceStatus(device, now),
    trustedAt: device.trustedAt,
    lastSeenAt: device.lastSeenAt,
    expiresAt: device.expiresAt,
    revokedAt: device.revokedAt,
  };
}
