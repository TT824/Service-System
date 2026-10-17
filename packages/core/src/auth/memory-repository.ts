/**
 * Deterministic in-memory authentication adapter.
 *
 * Used by `APP_ENV=test` and by unit tests directly, where a real PostgreSQL
 * instance must not be required. It stores the same records the durable
 * adapter stores, seeded with the same directory facts the platform store
 * seeds, so a workflow exercised here behaves identically to one exercised
 * against PostgreSQL.
 *
 * Records handed out are copies: a caller cannot mutate stored state by
 * holding a reference, which keeps the adapter honest about the value
 * semantics of its port.
 */

import type { Member, Store, Tenant } from '../platform/types';
import { SEEDED_MEMBERS, SEEDED_STORES, SEEDED_TENANTS } from './directory-seed';
import { AuthError } from './errors';
import type {
  AuthRepository,
  DirectoryMirror,
  TrialWorkspace,
  TrialWorkspaceInput,
  TrialWorkspaceProvision,
} from './ports';
import type {
  AuthSession,
  MemberStoreScope,
  MemberUserLink,
  OtpChallenge,
  OtpPurpose,
  TrustedDevice,
  UserAccount,
  UserIdentity,
} from './types';

/**
 * In-memory {@link AuthRepository}.
 *
 * A fresh instance starts from the seeded directory and holds no accounts: an
 * account only exists once the workflow created it.
 */
export class InMemoryAuthRepository implements AuthRepository {
  #tenants = new Map<string, Tenant>();
  #stores = new Map<string, Store>();
  #members = new Map<string, Member>();
  #users = new Map<string, UserAccount>();
  #identities = new Map<string, UserIdentity>();
  #links = new Map<string, MemberUserLink>();
  #storeScopes = new Map<string, MemberStoreScope>();
  #otpChallenges = new Map<string, OtpChallenge>();
  #devices = new Map<string, TrustedDevice>();
  #sessions = new Map<string, AuthSession>();

  /**
   * @param seed - Whether to start from the seeded directory. Defaults to
   * `true`; pass `false` for a completely empty repository.
   * @param mirror - A second directory that receives every directory write this
   * adapter performs. Optional, so a unit test constructs the adapter on its own
   * exactly as before; the Nest composition passes the shared in-process store,
   * which is what makes the in-memory authentication directory and the in-memory
   * platform repository describe one directory instead of two.
   *
   * @remarks
   * The seed is not mirrored. Both directories start from the same deterministic
   * facts — a unit test asserts the two seeds agree — so replaying them through
   * the mirror would only rewrite identical rows.
   */
  constructor(
    seed = true,
    private readonly mirror?: DirectoryMirror,
  ) {
    if (seed) {
      for (const tenant of SEEDED_TENANTS) {
        this.#tenants.set(tenant.id, clone(tenant));
      }
      for (const store of SEEDED_STORES) {
        this.#stores.set(store.id, clone(store));
      }
      for (const member of SEEDED_MEMBERS) {
        this.#members.set(member.id, clone(member));
      }
    }
  }

  // --------------------------------------------------------------------------
  // Directory
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async listTenants(): Promise<ReadonlyArray<Tenant>> {
    return sortBy([...this.#tenants.values()], (tenant) => tenant.id).map(clone);
  }

  /** @inheritdoc */
  async getTenant(tenantId: string): Promise<Tenant | undefined> {
    return clone(this.#tenants.get(tenantId));
  }

  /** @inheritdoc */
  async saveTenant(tenant: Tenant): Promise<void> {
    this.#tenants.set(tenant.id, clone(tenant));
    this.mirror?.upsertTenant(clone(tenant));
  }

  /** @inheritdoc */
  async listStores(tenantId: string): Promise<ReadonlyArray<Store>> {
    return sortBy(
      [...this.#stores.values()].filter((store) => store.tenantId === tenantId),
      (store) => store.id,
    ).map(clone);
  }

  /** @inheritdoc */
  async getStore(tenantId: string, storeId: string): Promise<Store | undefined> {
    const store = this.#stores.get(storeId);
    return store !== undefined && store.tenantId === tenantId ? clone(store) : undefined;
  }

  /** @inheritdoc */
  async findStoreById(storeId: string): Promise<Store | undefined> {
    return clone(this.#stores.get(storeId));
  }

  /** @inheritdoc */
  async saveStore(store: Store): Promise<void> {
    this.#stores.set(store.id, clone(store));
    this.mirror?.upsertStore(clone(store));
  }

  /** @inheritdoc */
  async listMembers(tenantId: string): Promise<ReadonlyArray<Member>> {
    return sortBy(
      [...this.#members.values()].filter((member) => member.tenantId === tenantId),
      (member) => member.id,
    ).map(clone);
  }

  /** @inheritdoc */
  async getMember(memberId: string): Promise<Member | undefined> {
    return clone(this.#members.get(memberId));
  }

  /** @inheritdoc */
  async listAllMembers(): Promise<ReadonlyArray<Member>> {
    return sortBy([...this.#members.values()], (member) => member.id).map(clone);
  }

  /** @inheritdoc */
  async saveMember(member: Member): Promise<void> {
    this.#members.set(member.id, clone(member));
    this.mirror?.upsertMember(clone(member));
  }

  // --------------------------------------------------------------------------
  // Accounts and identities
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async getUser(userId: string): Promise<UserAccount | undefined> {
    return clone(this.#users.get(userId));
  }

  /** @inheritdoc */
  async findUserByUsername(username: string): Promise<UserAccount | undefined> {
    const wanted = username.trim().toLowerCase();
    for (const user of this.#users.values()) {
      if (user.username.trim().toLowerCase() === wanted) {
        return clone(user);
      }
    }
    return undefined;
  }

  /** @inheritdoc */
  async listAllAccounts(): Promise<ReadonlyArray<UserAccount>> {
    return sortBy([...this.#users.values()], (user) => user.id).map(clone);
  }

  /** @inheritdoc */
  async saveUser(user: UserAccount): Promise<void> {
    this.#users.set(user.id, clone(user));
  }

  /** @inheritdoc */
  async findIdentity(provider: string, subject: string): Promise<UserIdentity | undefined> {
    const wanted = subject.trim().toLowerCase();
    for (const identity of this.#identities.values()) {
      if (identity.provider === provider && identity.subject.trim().toLowerCase() === wanted) {
        return clone(identity);
      }
    }
    return undefined;
  }

  /** @inheritdoc */
  async getIdentity(identityId: string): Promise<UserIdentity | undefined> {
    return clone(this.#identities.get(identityId));
  }

  /** @inheritdoc */
  async listIdentities(userId: string): Promise<ReadonlyArray<UserIdentity>> {
    return sortBy(
      [...this.#identities.values()].filter((identity) => identity.userId === userId),
      (identity) => identity.id,
    ).map(clone);
  }

  /** @inheritdoc */
  async saveIdentity(identity: UserIdentity): Promise<void> {
    this.#identities.set(identity.id, clone(identity));
  }

  /** @inheritdoc */
  async deleteIdentity(identityId: string): Promise<void> {
    this.#identities.delete(identityId);
  }

  // --------------------------------------------------------------------------
  // Membership and store scope
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async getActiveLinkForMember(memberId: string): Promise<MemberUserLink | undefined> {
    for (const link of this.#links.values()) {
      if (link.memberId === memberId && link.revokedAt === null) {
        return clone(link);
      }
    }
    return undefined;
  }

  /** @inheritdoc */
  async listActiveLinksForUser(userId: string): Promise<ReadonlyArray<MemberUserLink>> {
    return [...this.#links.values()]
      .filter((link) => link.userId === userId && link.revokedAt === null)
      .sort(compareLinkRecency)
      .map(clone);
  }

  /** @inheritdoc */
  async saveLink(link: MemberUserLink): Promise<void> {
    this.#links.set(link.id, clone(link));
  }

  /** @inheritdoc */
  async listMemberAvatars(
    memberIds: ReadonlyArray<string>,
  ): Promise<ReadonlyMap<string, string>> {
    const wanted = new Set(memberIds);
    const avatars = new Map<string, string>();
    for (const link of this.#links.values()) {
      if (!wanted.has(link.memberId) || link.revokedAt !== null) {
        continue;
      }
      const avatar = this.#users.get(link.userId)?.avatarUrl ?? null;
      if (avatar !== null) {
        avatars.set(link.memberId, avatar);
      }
    }
    return avatars;
  }

  // --------------------------------------------------------------------------
  // Trial workspace
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async findTrialWorkspace(userId: string): Promise<TrialWorkspace | undefined> {
    const links = await this.listActiveLinksForUser(userId);
    for (const link of links) {
      const member = this.#members.get(link.memberId);
      // A member without a tenant is a platform administrator: it administers
      // the platform as a whole and owns no workspace of its own.
      if (member === undefined || member.tenantId === null) {
        continue;
      }
      const tenant = this.#tenants.get(member.tenantId);
      if (tenant === undefined) {
        continue;
      }
      return clone({
        tenant,
        store: this.#defaultStore(tenant.id, member.storeId),
        member,
        link,
      });
    }
    return undefined;
  }

  /** @inheritdoc */
  async provisionTrialWorkspace(input: TrialWorkspaceInput): Promise<TrialWorkspaceProvision> {
    const existing = await this.findTrialWorkspace(input.userId);
    if (existing !== undefined) {
      return { ...existing, provisioned: false };
    }

    // This account's own trial tenant, by the natural key that identifies it.
    const own = [...this.#tenants.values()].find((tenant) => tenant.code === input.tenant.code);

    // Every decision is taken before the first write, so a rejected call has
    // written nothing at all: there is no state to compensate for and no
    // half-provisioned account to clean up.
    if (own === undefined) {
      this.#assertTenantFree(input.tenant);
      this.#assertStoreFree(input.store);
      this.#assertMemberFree(input.member);
      this.#assertLinkFree(input.link);
      // Every directory write goes through the saving methods, never the maps
      // directly, so a mirrored directory cannot miss a row this call creates.
      await this.saveTenant(input.tenant);
      await this.saveStore(input.store);
      await this.saveMember(input.member);
      this.#links.set(input.link.id, clone(input.link));
      return clone({
        tenant: input.tenant,
        store: input.store,
        member: input.member,
        link: input.link,
        provisioned: true,
      });
    }

    const member = this.#ownTrialMember(own, input.member);

    // A membership has exactly one active holder. The durable schema enforces
    // that with a unique index over the active rows; this is the same rule, and
    // it is checked before anything is written so the refusal leaves no partial
    // workspace behind. Without it, re-activating this account's own revoked row
    // would hand one membership to two accounts.
    const holder = [...this.#links.values()].find(
      (candidate) => candidate.memberId === member.id && candidate.revokedAt === null,
    );
    if (holder !== undefined && holder.userId !== input.userId) {
      throw new AuthError(
        'idempotency_conflict',
        `member ${member.id} is already linked to another account`,
      );
    }

    // The store belongs to the tenant that already exists, so a store written to
    // fill the gap carries that tenant's id: the id this attempt generated names
    // a tenant that was never written, and a store filed under it would belong to
    // no tenant — invisible to every later read of the workspace. This is the
    // last write of the restore, so a refusal above has left nothing behind.
    const store =
      this.#defaultStore(own.id, member.storeId) ??
      (await this.#addDefaultStore(own, { ...input.store, tenantId: own.id }));

    // The link is re-established, not duplicated: an account that held this
    // membership before keeps its row and simply gets it back.
    const previous = [...this.#links.values()].find(
      (candidate) => candidate.userId === input.userId && candidate.memberId === member.id,
    );
    const link: MemberUserLink =
      previous === undefined
        ? clone(input.link)
        : {
            ...clone(previous),
            linkedAt: input.link.linkedAt,
            revokedAt: null,
            updatedAt: input.link.updatedAt,
          };
    this.#links.set(link.id, link);

    return clone({ tenant: clone(own), store, member, link, provisioned: true });
  }

  /** The store a workspace starts in: the member's own, else the tenant's first. */
  #defaultStore(tenantId: string, preferredStoreId: string | null): Store | null {
    const stores = this.#storesOf(tenantId);
    if (preferredStoreId === null) {
      return stores[0] === undefined ? null : clone(stores[0]);
    }
    const preferred = stores.find((store) => store.id === preferredStoreId) ?? stores[0];
    return preferred === undefined ? null : clone(preferred);
  }

  /** Stores of one tenant, ordered by id. */
  #storesOf(tenantId: string): Store[] {
    return [...this.#stores.values()]
      .filter((store) => store.tenantId === tenantId)
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  /**
   * The member of an existing trial tenant that the account acts through.
   *
   * Identified by what provisioning wrote: the account's own username, in the
   * role provisioning grants. A tenant carrying the account's code without such
   * a member was not provisioned for this account — adopting it would put the
   * account inside a directory that is not its own — so the call is refused.
   */
  #ownTrialMember(tenant: Tenant, offered: Member): Member {
    const member = [...this.#members.values()].find(
      (candidate) =>
        candidate.tenantId === tenant.id &&
        candidate.username === offered.username &&
        candidate.role === offered.role,
    );
    if (member === undefined) {
      throw new AuthError(
        'idempotency_conflict',
        `tenant ${tenant.code} already exists without a member for this account`,
      );
    }
    return clone(member);
  }

  /** Add the offered default store to a tenant that has none. */
  async #addDefaultStore(tenant: Tenant, store: Store): Promise<Store> {
    if (this.#stores.has(store.id) || this.#storesOf(tenant.id).length > 0) {
      throw new AuthError(
        'idempotency_conflict',
        `store ${store.code} already exists in tenant ${tenant.id}`,
      );
    }
    await this.saveStore(store);
    return clone(store);
  }

  /** Reject a tenant id or code that is already taken. */
  #assertTenantFree(tenant: Tenant): void {
    if (
      this.#tenants.has(tenant.id) ||
      [...this.#tenants.values()].some((candidate) => candidate.code === tenant.code)
    ) {
      throw new AuthError(
        'idempotency_conflict',
        `tenant ${tenant.code} already exists; refusing to provision a second one`,
      );
    }
  }

  /** Reject a store id, or a store code inside the tenant, that is taken. */
  #assertStoreFree(store: Store): void {
    const taken =
      this.#stores.has(store.id) ||
      this.#storesOf(store.tenantId).some((candidate) => candidate.code === store.code);
    if (taken) {
      throw new AuthError(
        'idempotency_conflict',
        `store ${store.code} already exists in tenant ${store.tenantId}`,
      );
    }
  }

  /** Reject a member id that is taken, which a write would otherwise overwrite. */
  #assertMemberFree(member: Member): void {
    if (this.#members.has(member.id)) {
      throw new AuthError(
        'idempotency_conflict',
        `member ${member.id} already exists; refusing to provision a second one`,
      );
    }
  }

  /** Reject a link id that is taken, or a member that already has an active link. */
  #assertLinkFree(link: MemberUserLink): void {
    const taken =
      this.#links.has(link.id) ||
      [...this.#links.values()].some(
        (candidate) => candidate.memberId === link.memberId && candidate.revokedAt === null,
      );
    if (taken) {
      throw new AuthError(
        'idempotency_conflict',
        `member ${link.memberId} already has an active link`,
      );
    }
  }

  /** @inheritdoc */
  async listActiveStoreScopes(
    tenantId: string,
    memberId: string,
  ): Promise<ReadonlyArray<MemberStoreScope>> {
    return sortBy(
      [...this.#storeScopes.values()].filter(
        (scope) =>
          scope.tenantId === tenantId && scope.memberId === memberId && scope.revokedAt === null,
      ),
      (scope) => scope.storeId,
    ).map(clone);
  }

  /** @inheritdoc */
  async saveStoreScope(scope: MemberStoreScope): Promise<void> {
    this.#storeScopes.set(scopeKey(scope.tenantId, scope.memberId, scope.storeId), clone(scope));
  }

  /** @inheritdoc */
  async revokeStoreScope(
    tenantId: string,
    memberId: string,
    storeId: string,
    revokedAt: string,
  ): Promise<void> {
    const key = scopeKey(tenantId, memberId, storeId);
    const scope = this.#storeScopes.get(key);
    if (scope === undefined || scope.revokedAt !== null) {
      return;
    }
    this.#storeScopes.set(key, { ...clone(scope), revokedAt, updatedAt: revokedAt });
  }

  // --------------------------------------------------------------------------
  // One-time challenges
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async saveOtp(challenge: OtpChallenge): Promise<void> {
    this.#otpChallenges.set(challenge.id, clone(challenge));
  }

  /** @inheritdoc */
  async getOtp(challengeId: string): Promise<OtpChallenge | undefined> {
    return clone(this.#otpChallenges.get(challengeId));
  }

  /** @inheritdoc */
  async findPendingOtp(subject: string, purpose: OtpPurpose): Promise<OtpChallenge | undefined> {
    const candidates = [...this.#otpChallenges.values()].filter(
      (challenge) =>
        challenge.subject === subject &&
        challenge.purpose === purpose &&
        challenge.status === 'pending',
    );
    return clone(sortBy(candidates, (challenge) => challenge.issuedAt).reverse()[0]);
  }

  /** @inheritdoc */
  async listOtpIssuedAt(
    subject: string,
    purpose: OtpPurpose,
    sinceIso: string,
  ): Promise<ReadonlyArray<string>> {
    const challenges = await this.listOtpsSince(subject, purpose, sinceIso);
    return challenges.map((challenge) => challenge.issuedAt);
  }

  /** @inheritdoc */
  async listOtpsSince(
    subject: string,
    purpose: OtpPurpose,
    sinceIso: string,
  ): Promise<ReadonlyArray<OtpChallenge>> {
    const since = Date.parse(sinceIso);
    return sortBy(
      [...this.#otpChallenges.values()].filter(
        (challenge) =>
          challenge.subject === subject &&
          challenge.purpose === purpose &&
          Date.parse(challenge.issuedAt) >= since,
      ),
      (challenge) => challenge.issuedAt,
    ).map(clone);
  }

  // --------------------------------------------------------------------------
  // Trusted devices
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async saveDevice(device: TrustedDevice): Promise<void> {
    this.#devices.set(device.id, clone(device));
  }

  /** @inheritdoc */
  async getDevice(deviceId: string): Promise<TrustedDevice | undefined> {
    return clone(this.#devices.get(deviceId));
  }

  /** @inheritdoc */
  async findDeviceByFingerprint(fingerprint: string): Promise<TrustedDevice | undefined> {
    for (const device of this.#devices.values()) {
      if (device.credentialFingerprint === fingerprint) {
        return clone(device);
      }
    }
    return undefined;
  }

  /** @inheritdoc */
  async listDevices(userId: string): Promise<ReadonlyArray<TrustedDevice>> {
    return sortBy(
      [...this.#devices.values()].filter((device) => device.userId === userId),
      (device) => device.trustedAt,
    )
      .reverse()
      .map(clone);
  }

  // --------------------------------------------------------------------------
  // Sessions
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async saveSession(session: AuthSession): Promise<void> {
    this.#sessions.set(session.id, clone(session));
  }

  /** @inheritdoc */
  async findSessionByFingerprint(fingerprint: string): Promise<AuthSession | undefined> {
    for (const session of this.#sessions.values()) {
      if (session.tokenFingerprint === fingerprint) {
        return clone(session);
      }
    }
    return undefined;
  }

  /** @inheritdoc */
  async findSessionByPreviousFingerprint(fingerprint: string): Promise<AuthSession | undefined> {
    for (const session of this.#sessions.values()) {
      if (session.previousTokenFingerprint === fingerprint) {
        return clone(session);
      }
    }
    return undefined;
  }

  /** @inheritdoc */
  async getSession(sessionId: string): Promise<AuthSession | undefined> {
    return clone(this.#sessions.get(sessionId));
  }

  /** @inheritdoc */
  async listSessionsForUser(userId: string): Promise<ReadonlyArray<AuthSession>> {
    return sortBy(
      [...this.#sessions.values()].filter((session) => session.userId === userId),
      (session) => session.issuedAt,
    )
      .reverse()
      .map(clone);
  }

  /** @inheritdoc */
  async listSessionsForDevice(deviceId: string): Promise<ReadonlyArray<AuthSession>> {
    return sortBy(
      [...this.#sessions.values()].filter((session) => session.trustedDeviceId === deviceId),
      (session) => session.issuedAt,
    )
      .reverse()
      .map(clone);
  }
}

function scopeKey(tenantId: string, memberId: string, storeId: string): string {
  return `${tenantId} ${memberId} ${storeId}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sortBy<T>(values: T[], key: (value: T) => string): T[] {
  return values.sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

/**
 * Order links the way the durable adapter orders them: newest first, ties
 * broken by descending id. The port makes the order a contract, because the
 * first active link of an account is the membership its next session starts on.
 */
function compareLinkRecency(left: MemberUserLink, right: MemberUserLink): number {
  if (left.linkedAt !== right.linkedAt) {
    return left.linkedAt < right.linkedAt ? 1 : -1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? 1 : -1;
}
