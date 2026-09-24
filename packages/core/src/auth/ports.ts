/**
 * The authentication storage port.
 *
 * One interface, two adapters: the deterministic in-memory adapter used by
 * `test` (and by unit tests directly), and the PostgreSQL adapter in
 * `apps/api/src/auth` that reads and writes the tables added by migrations
 * `0003`/`0004`. The domain service is written against this port only, so the
 * same workflow runs on both without a branch.
 *
 * Every method is asynchronous because the durable adapter is. Records are
 * immutable values: a mutation is a whole-record `save`, never an in-place
 * edit, so an adapter cannot accidentally share state with a caller.
 */

import type { AppEnvironment, AuthStorageMode } from '../app-config';
import type { Member, Store, Tenant } from '../platform/types';
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

/** Directory facts the platform administers. */
export type DirectoryRepository = {
  /** Every tenant, ordered by id. */
  listTenants(): Promise<ReadonlyArray<Tenant>>;
  /** One tenant by id. */
  getTenant(tenantId: string): Promise<Tenant | undefined>;
  /** Insert or replace a tenant. */
  saveTenant(tenant: Tenant): Promise<void>;

  /** Stores of one tenant, ordered by id. */
  listStores(tenantId: string): Promise<ReadonlyArray<Store>>;
  /** One store inside a tenant. */
  getStore(tenantId: string, storeId: string): Promise<Store | undefined>;
  /** One store by id, regardless of tenant. */
  findStoreById(storeId: string): Promise<Store | undefined>;
  /** Insert or replace a store. */
  saveStore(store: Store): Promise<void>;

  /** Members of one tenant, ordered by id. */
  listMembers(tenantId: string): Promise<ReadonlyArray<Member>>;
  /** One member by id. */
  getMember(memberId: string): Promise<Member | undefined>;
  /** Every member, ordered by id. */
  listAllMembers(): Promise<ReadonlyArray<Member>>;
  /** Insert or replace a member. */
  saveMember(member: Member): Promise<void>;
};

/**
 * A second directory that mirrors the writes of an in-memory directory.
 *
 * In `test` the platform is two in-process adapters: the authentication
 * directory the sign-in workflow reads, and the platform repository the
 * business surfaces read. They must describe one directory, or an account can
 * register successfully and then find that the tenant it was just given does
 * not exist as far as its own business endpoints are concerned. Wiring the same
 * store into both is what closes that gap, and it is deliberately one-way:
 * only the directory that owns the write path mirrors, so no second source of
 * truth is created — the durable adapters share one set of tables instead.
 *
 * Every method is an upsert keyed by row id: a mirrored write is a statement
 * that the row exists, not a request to append one, so replaying it — on
 * retry, or because both directories were seeded from the same facts — leaves
 * exactly one row behind.
 */
export type DirectoryMirror = {
  /** Insert or replace one tenant. */
  upsertTenant(tenant: Tenant): void;
  /** Insert or replace one store. */
  upsertStore(store: Store): void;
  /** Insert or replace one member. */
  upsertMember(member: Member): void;
};

/** Account and identity storage. */
export type IdentityRepository = {
  /** One account by id. */
  getUser(userId: string): Promise<UserAccount | undefined>;
  /** One account by case-insensitive username. */
  findUserByUsername(username: string): Promise<UserAccount | undefined>;
  /** Every account, ordered by id. Used only by platform administration. */
  listAllAccounts(): Promise<ReadonlyArray<UserAccount>>;
  /** Insert or replace an account. */
  saveUser(user: UserAccount): Promise<void>;

  /** One identity by provider and case-insensitive subject. */
  findIdentity(provider: string, subject: string): Promise<UserIdentity | undefined>;
  /** One identity by id. */
  getIdentity(identityId: string): Promise<UserIdentity | undefined>;
  /** Every identity of one account. */
  listIdentities(userId: string): Promise<ReadonlyArray<UserIdentity>>;
  /** Insert or replace an identity. */
  saveIdentity(identity: UserIdentity): Promise<void>;
  /** Remove an identity. */
  deleteIdentity(identityId: string): Promise<void>;
};

/** Member linkage and store scope storage. */
export type MembershipRepository = {
  /** The active (unrevoked) link of a member, if any. */
  getActiveLinkForMember(memberId: string): Promise<MemberUserLink | undefined>;
  /**
   * Every active link of one account, newest first.
   *
   * The order is part of the contract, not an adapter detail: when an account
   * holds more than one link, the most recently linked one is the membership a
   * new session starts on. Both adapters therefore order by `linkedAt`
   * descending and break ties by link id descending, so in-memory and durable
   * runs select the same membership.
   */
  listActiveLinksForUser(userId: string): Promise<ReadonlyArray<MemberUserLink>>;
  /** Insert or replace a link. */
  saveLink(link: MemberUserLink): Promise<void>;

  /** Active store scopes of one member inside a tenant. */
  listActiveStoreScopes(
    tenantId: string,
    memberId: string,
  ): Promise<ReadonlyArray<MemberStoreScope>>;
  /** Insert or replace a store scope. */
  saveStoreScope(scope: MemberStoreScope): Promise<void>;
  /** Revoke one store scope by stamping `revoked_at`. */
  revokeStoreScope(
    tenantId: string,
    memberId: string,
    storeId: string,
    revokedAt: string,
  ): Promise<void>;
};

/**
 * Records that make up one account's trial workspace.
 *
 * A trial workspace is the directory an account owns by itself: one tenant, its
 * default store, the merchant administrator member that runs it, and the link
 * that binds the account to that member. It is provisioned as one unit — see
 * {@link TrialProvisioningRepository}.
 */
export type TrialWorkspace = {
  readonly tenant: Tenant;
  /**
   * The store the workspace starts in.
   *
   * Provisioning always creates one. A workspace discovered for an account that
   * was configured by hand may not have one — an administrator can link an
   * account to a tenant-wide member before any store exists — in which case the
   * workspace is still that account's workspace.
   */
  readonly store: Store | null;
  readonly member: Member;
  readonly link: MemberUserLink;
};

/**
 * The rows to create for a trial workspace, plus the account they belong to.
 *
 * The store is not optional here, unlike in a discovered {@link TrialWorkspace}:
 * provisioning always creates the workspace's default store.
 */
export type TrialWorkspaceInput = {
  /** Account the workspace is provisioned for. */
  readonly userId: string;
  readonly tenant: Tenant;
  readonly store: Store;
  readonly member: Member;
  readonly link: MemberUserLink;
};

/**
 * Result of a provisioning call: the workspace, and whether this call made it.
 *
 * @remarks
 * `store` stays nullable because this type also carries a workspace the account
 * already had, which may have been built by hand in a tenant that has no stores
 * yet. A workspace this call *established* always has one.
 */
export type TrialWorkspaceProvision = TrialWorkspace & {
  /**
   * `true` when this call established the workspace — it wrote or re-activated
   * the link — and `false` when the account already had one and nothing was
   * written.
   */
  readonly provisioned: boolean;
};

/**
 * Trial-workspace provisioning.
 *
 * Separate from {@link MembershipRepository} because it is a unit of work, not
 * a record write: the four rows either all exist afterwards or none do. An
 * adapter that cannot offer that guarantee does not satisfy the port.
 */
export type TrialProvisioningRepository = {
  /**
   * The workspace one account already acts through, or `undefined`.
   *
   * "Already acts through" means an active link to a member that belongs to a
   * tenant — a platform administrator member belongs to no tenant and is
   * therefore never a workspace. The most recent such link wins.
   *
   * A disabled member still counts. Its account is `disabled` rather than
   * unconfigured, and answering `undefined` here would make the next call mint a
   * second tenant beside the one the account already owns.
   */
  findTrialWorkspace(userId: string): Promise<TrialWorkspace | undefined>;

  /**
   * Give one account its trial workspace, or return the one it has.
   *
   * Idempotent on the account, not on the rows handed in. When an account
   * already acts through a workspace, that workspace is returned with
   * `provisioned: false` and nothing is written, however the input differs, so
   * one account never ends up owning two tenants and a caller may retry without
   * checking what survived first.
   *
   * Restorative as well as idempotent. An account that has no active workspace
   * link but whose own trial tenant still exists — the shape an administrator
   * leaves behind by revoking the link — is linked back to that tenant's
   * merchant administrator member rather than given a second tenant: the input's
   * `tenant.code` is the account's natural key, and the existing rows are reused.
   * A tenant holding that code but no member the account could act through is a
   * genuine conflict and is refused with `idempotency_conflict`, because adopting
   * somebody else's tenant would be worse than failing.
   *
   * Atomic: a rejection leaves no tenant, store, member or link behind, so the
   * account is exactly as recoverable as it was before the call.
   */
  provisionTrialWorkspace(input: TrialWorkspaceInput): Promise<TrialWorkspaceProvision>;
};

/** One-time challenge, device and session storage. */
export type SessionRepository = {
  /** Insert or replace a one-time challenge. */
  saveOtp(challenge: OtpChallenge): Promise<void>;
  /** One challenge by id. */
  getOtp(challengeId: string): Promise<OtpChallenge | undefined>;
  /** The most recent pending challenge for a destination and purpose. */
  findPendingOtp(subject: string, purpose: OtpPurpose): Promise<OtpChallenge | undefined>;
  /** Instants of every challenge issued to a destination and purpose since `sinceIso`. */
  listOtpIssuedAt(
    subject: string,
    purpose: OtpPurpose,
    sinceIso: string,
  ): Promise<ReadonlyArray<string>>;
  /** Every challenge issued to a destination and purpose since `sinceIso`. */
  listOtpsSince(
    subject: string,
    purpose: OtpPurpose,
    sinceIso: string,
  ): Promise<ReadonlyArray<OtpChallenge>>;

  /** Insert or replace a trusted device. */
  saveDevice(device: TrustedDevice): Promise<void>;
  /** One device by id. */
  getDevice(deviceId: string): Promise<TrustedDevice | undefined>;
  /** One device by credential fingerprint. */
  findDeviceByFingerprint(fingerprint: string): Promise<TrustedDevice | undefined>;
  /** Every device of one account, newest first. */
  listDevices(userId: string): Promise<ReadonlyArray<TrustedDevice>>;

  /** Insert or replace a session. */
  saveSession(session: AuthSession): Promise<void>;
  /** One session by token fingerprint. */
  findSessionByFingerprint(fingerprint: string): Promise<AuthSession | undefined>;
  /**
   * One session whose *superseded* token has this fingerprint.
   *
   * A rotation records the token it replaced, so presenting a token that is no
   * longer current still identifies the session it belonged to — which is how a
   * replay of an already-rotated credential is detected.
   */
  findSessionByPreviousFingerprint(fingerprint: string): Promise<AuthSession | undefined>;
  /** One session by id. */
  getSession(sessionId: string): Promise<AuthSession | undefined>;
  /** Every session of one account, newest first. */
  listSessionsForUser(userId: string): Promise<ReadonlyArray<AuthSession>>;
  /** Every session bound to one trusted device. */
  listSessionsForDevice(deviceId: string): Promise<ReadonlyArray<AuthSession>>;
};

/** Complete authentication storage port. */
export type AuthRepository = DirectoryRepository &
  IdentityRepository &
  MembershipRepository &
  TrialProvisioningRepository &
  SessionRepository;

/**
 * Decide which storage adapter an environment uses.
 *
 * @param appEnv - Application runtime boundary.
 * @param mode - Configured storage mode.
 * @returns `memory` or `postgres`.
 */
export function resolveAuthStorageMode(
  appEnv: AppEnvironment,
  mode: AuthStorageMode,
): 'memory' | 'postgres' {
  if (mode === 'memory' || mode === 'postgres') {
    return mode;
  }
  return appEnv === 'test' ? 'memory' : 'postgres';
}
