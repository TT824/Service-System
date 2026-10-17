import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthAdminService,
  AuthError,
  AuthService,
  LocalOidcProvider,
  LocalOtpProvider,
  buildTrialWorkspace,
  parseAppConfig,
  trialTenantCode,
  type AccessContext,
  type AppConfig,
  type TrialWorkspaceInput,
  type TrialWorkspaceProvision,
  type UserAccount,
  verifyPassword,
} from '@kefu/core';
import { PostgresAuthRepository } from '../src/auth/postgres-auth.repository';
import { DatabaseService } from '../src/database/database.service';
import { TransactionManager } from '../src/persistence/transaction-manager';
import {
  isDatabaseReachable,
  resolveDatabaseUrl,
  runDatabaseCommand,
} from './database-test-support';

/**
 * Integration tests for the durable authentication adapter.
 *
 * These exercise {@link PostgresAuthRepository} against the real PostgreSQL the
 * platform targets — the tables and CHECK constraints added by migrations `0003`
 * and `0004` — and then run the whole sign-in workflow through it, so the port
 * the domain services depend on is proven against the durable schema rather than
 * only against the in-memory adapter.
 *
 * The suite skips cleanly when no database is reachable, so `npm test` passes on
 * a machine without PostgreSQL; a run that actually executed reports so through
 * the test names. Every row it writes carries a per-run unique identifier, so it
 * never depends on — or disturbs — the seeded directory.
 */
const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Unique suffix isolating this run's rows from every other run's. */
const RUN = randomUUID().slice(0, 8);
/** Password used by the workflow account. */
const PASSWORD = 'correct-horse-battery-staple';
/** Password the recovery flow switches to. */
const NEW_PASSWORD = 'a-completely-different-passphrase';
/** A one-pixel PNG: the smallest picture the schema's CHECK will accept. */
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A destination no other row can collide with.
 *
 * A one-time code destination is opaque routing data to the platform — it is
 * trimmed and stored, never parsed — so the suite only has to make it unique.
 *
 * @param name - Test-scoped discriminator.
 * @returns The destination to send a code to.
 */
function destination(name: string): string {
  return `+8613-${RUN}-${name}`;
}

/**
 * A realistic token fingerprint.
 *
 * The durable schema refuses a `token_fingerprint` shorter than a real digest,
 * which is exactly the guard that keeps a raw token from ever being stored: a
 * value this short could only be a credential in disguise.
 *
 * @param name - Test-scoped discriminator.
 * @returns A 64-character fingerprint.
 */
function fingerprint(name: string): string {
  return `${RUN}-${name}`.padEnd(64, '0').slice(0, 64);
}

describe.skipIf(!reachable)('Authentication persistence (PostgreSQL)', () => {
  let config: AppConfig;
  let database: DatabaseService;
  let repository: PostgresAuthRepository;
  let auth: AuthService;
  let otp: LocalOtpProvider;
  let pool: Pool;

  /** Ids created by this run, removed again in {@link cleanup}. */
  const created = {
    tenants: [] as string[],
    stores: [] as string[],
    members: [] as string[],
    users: [] as string[],
  };

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
    repository = new PostgresAuthRepository(database, new TransactionManager(database));
    otp = new LocalOtpProvider();
    auth = new AuthService({ repository, otpProvider: otp, oidcProvider: new LocalOidcProvider() });
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await cleanup();
      await database.onModuleDestroy();
    }
  });

  /** Remove everything this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    if (created.users.length > 0) {
      await pool.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::text[])', [
        created.users,
      ]);
      await pool.query('DELETE FROM trusted_devices WHERE user_id = ANY($1::text[])', [
        created.users,
      ]);
      await pool.query('DELETE FROM otp_challenges WHERE user_id = ANY($1::text[])', [
        created.users,
      ]);
      await pool.query('DELETE FROM member_user_links WHERE user_id = ANY($1::text[])', [
        created.users,
      ]);
      await pool.query('DELETE FROM user_identities WHERE user_id = ANY($1::text[])', [
        created.users,
      ]);
      await pool.query('DELETE FROM user_accounts WHERE id = ANY($1::text[])', [created.users]);
    }
    if (created.members.length > 0) {
      await pool.query('DELETE FROM member_user_links WHERE member_id = ANY($1::text[])', [
        created.members,
      ]);
      await pool.query('DELETE FROM member_store_scopes WHERE member_id = ANY($1::text[])', [
        created.members,
      ]);
      await pool.query('DELETE FROM members WHERE id = ANY($1::text[])', [created.members]);
    }
    if (created.stores.length > 0) {
      await pool.query('DELETE FROM stores WHERE id = ANY($1::text[])', [created.stores]);
    }
    if (created.tenants.length > 0) {
      await pool.query('DELETE FROM tenants WHERE id = ANY($1::text[])', [created.tenants]);
    }
    if (created.users.length > 0) {
      // Registration provisions the account's own trial workspace, and a test
      // that only needs the account itself — the remembered-device sign-in,
      // say — has no workspace to hand back to `track`. The tenant code is
      // derived from the account id (`trialTenantCode`), so deleting by that
      // code covers every workspace this run provisioned, tracked or not.
      // Last, so the per-table deletes above keep their foreign-key order and
      // the cascade only ever removes rows nothing else in this run needs.
      await pool.query('DELETE FROM tenants WHERE code = ANY($1::text[])', [
        created.users.map(trialTenantCode),
      ]);
    }
  }

  it('runs against a reachable database', () => {
    // Reported explicitly so a skipped run is never mistaken for a passing one.
    expect(reachable).toBe(true);
  });

  it('round-trips directory rows through the durable schema', async () => {
    const tenantId = `tenant-it-${RUN}`;
    const storeId = `store-it-${RUN}`;
    const memberId = `member-it-${RUN}`;
    const now = new Date().toISOString();
    created.tenants.push(tenantId);
    created.stores.push(storeId);
    created.members.push(memberId);

    await repository.saveTenant({
      id: tenantId,
      code: `it-${RUN}`,
      name: '集成测试租户',
      enabled: true,
      createdAt: now,
    });
    await repository.saveStore({
      id: storeId,
      tenantId,
      code: 'main',
      name: '集成测试门店',
      enabled: true,
      createdAt: now,
    });
    await repository.saveMember({
      id: memberId,
      tenantId,
      storeId,
      role: 'agent',
      username: `it-member-${RUN}`,
      displayName: '集成测试客服',
      enabled: true,
      createdAt: now,
    });

    expect((await repository.getTenant(tenantId))?.code).toBe(`it-${RUN}`);
    // `enabled` survives the round trip as a boolean, not as a driver string.
    expect((await repository.getTenant(tenantId))?.enabled).toBe(true);
    expect((await repository.listStores(tenantId)).map((store) => store.id)).toEqual([storeId]);
    const member = await repository.getMember(memberId);
    expect(member?.role).toBe('agent');
    expect(member?.storeId).toBe(storeId);
    // TIMESTAMPTZ comes back as a Date; the adapter must normalise it to ISO.
    expect(member?.createdAt).toBe(now);
  });

  it('round-trips an account, its identity and its session', async () => {
    const userId = randomUUID();
    const now = new Date().toISOString();
    created.users.push(userId);

    await repository.saveUser({
      id: userId,
      username: `it-user-${RUN}`,
      displayName: '集成测试账号',
      status: 'active',
      passwordHash: null,
      passwordUpdatedAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      avatarUrl: null,
      idempotencyKey: null,
      createdAt: now,
      updatedAt: now,
    });
    await repository.saveIdentity({
      id: randomUUID(),
      userId,
      provider: 'phone',
      subject: destination('identity'),
      verified: true,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // The username lookup is case- and whitespace-insensitive by design.
    expect((await repository.findUserByUsername(`it-user-${RUN}`))?.id).toBe(userId);
    expect((await repository.findUserByUsername(`  IT-USER-${RUN.toUpperCase()}  `))?.id).toBe(
      userId,
    );

    const sessionId = randomUUID();
    await repository.saveSession({
      id: sessionId,
      userId,
      tenantId: null,
      memberId: null,
      trustedDeviceId: null,
      tokenFingerprint: fingerprint('token'),
      previousTokenFingerprint: fingerprint('previous'),
      rotationFamilyId: randomUUID(),
      authMethod: 'password',
      status: 'active',
      mfaSatisfied: false,
      clientFingerprint: null,
      idempotencyKey: null,
      issuedAt: now,
      expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
      lastSeenAt: now,
      revokedAt: null,
      revokedReason: null,
      createdAt: now,
      updatedAt: now,
    });

    expect((await repository.findSessionByFingerprint(fingerprint('token')))?.id).toBe(sessionId);
    // Rotation replay detection depends on this lookup finding the successor.
    expect((await repository.findSessionByPreviousFingerprint(fingerprint('previous')))?.id).toBe(
      sessionId,
    );
    expect((await repository.listSessionsForUser(userId)).map((session) => session.id)).toEqual([
      sessionId,
    ]);
  });

  it('stores a one-time code only as a hash the schema accepts', async () => {
    const now = new Date().toISOString();
    const subject = destination('challenge');
    const challengeId = randomUUID();

    await repository.saveOtp({
      id: challengeId,
      tenantId: null,
      userId: null,
      purpose: 'sign_in',
      channel: 'sms',
      subject,
      codeHash: 'a'.repeat(64),
      codeAlgorithm: 'sha256',
      status: 'pending',
      failedAttempts: 0,
      maxAttempts: 5,
      idempotencyKey: null,
      issuedAt: now,
      expiresAt: new Date(Date.parse(now) + 300_000).toISOString(),
      consumedAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    expect((await repository.findPendingOtp(subject, 'sign_in'))?.id).toBe(challengeId);
    expect(await repository.listOtpIssuedAt(subject, 'sign_in', now)).toEqual([now]);
    expect((await repository.listOtpsSince(subject, 'sign_in', now)).map((row) => row.id)).toEqual([
      challengeId,
    ]);
  });

  it('runs the whole sign-in workflow against PostgreSQL', async () => {
    const subject = destination('flow');
    const username = `it-flow-${RUN}`;

    const sent = await auth.sendOtp({ subject, channel: 'sms', purpose: 'sign_in' });
    const delivered = otp.lastDeliveryFor(subject);
    expect(delivered?.challengeId).toBe(sent.challengeId);

    const registered = await auth.register({
      subject,
      channel: 'sms',
      code: delivered?.code ?? '',
      username,
      displayName: '集成测试流程账号',
      password: PASSWORD,
    });
    created.users.push(registered.session.userId);
    // Registration is an application, not a provisioning: it leaves a durable
    // account, identity and session behind, and no organisation. Nothing is
    // minted here, and the account center is the whole of what it reaches.
    expect(registered.access.accessState).toBe('pending_config');
    expect(registered.access.role).toBeNull();
    expect(registered.access.tenantId).toBeNull();
    expect(registered.access.member).toBeNull();
    expect(await repository.findTrialWorkspace(registered.session.userId)).toBeUndefined();

    const resolved = await auth.resolveSession(registered.token);
    expect(resolved.account.username).toBe(username);

    // It can sign in, and the durable sign-in says the same thing registration
    // did rather than promoting the account on the way through.
    const signedIn = await auth.loginWithPassword({ username, password: PASSWORD });
    created.users.push(signedIn.session.userId);
    expect(signedIn.access.accessState).toBe('pending_config');

    // The trial-workspace model is still durable and still correct — it is kept,
    // with no route to it, because the tables and their migrations are
    // legitimate (see `AuthService.retryOnboarding`). Driving it directly here
    // is what proves the rows survive a round trip through PostgreSQL. It is
    // deliberately *not* the path registration takes any more.
    const retried = await auth.retryOnboarding(signedIn.token);
    expect(retried.workspace.provisioned).toBe(true);
    const workspace = retried.workspace;
    created.tenants.push(workspace.tenant.id);
    created.members.push(workspace.member.id);
    if (workspace.store !== null) {
      created.stores.push(workspace.store.id);
    }
    expect(workspace.tenant.code).toBe(trialTenantCode(registered.session.userId));
    expect(workspace.member.tenantId).toBe(workspace.tenant.id);
    expect(workspace.store?.code).toBe('main');
    expect(workspace.link.memberId).toBe(workspace.member.id);
    expect(workspace.link.revokedAt).toBeNull();
    // The session is stamped onto the workspace, and the door stays shut
    // anyway: the access state is the bell's decision, so this frozen call can
    // no longer promote an applicant to an active account on its own.
    expect(retried.access.accessState).toBe('pending_config');
    expect(retried.access.tenantId).toBe(workspace.tenant.id);

    // Provisioning again finds the durable workspace and returns it unchanged:
    // the account keeps exactly one tenant, one store, one member and one link.
    const again = await auth.retryOnboarding(signedIn.token);
    expect(again.workspace.provisioned).toBe(false);
    expect(again.workspace.tenant.id).toBe(workspace.tenant.id);
    expect(again.workspace.member.id).toBe(workspace.member.id);
    expect(
      (await repository.listMembers(workspace.tenant.id)).filter(
        (member) => member.role === 'merchant_admin',
      ),
    ).toHaveLength(1);
    expect(await repository.listStores(workspace.tenant.id)).toHaveLength(1);

    const rotated = await auth.rotateSession(signedIn.token);
    expect(rotated.session.id).toBe(signedIn.session.id);

    const center = await auth.accountCenter(rotated.token);
    expect(center.identities.some((identity) => identity.provider === 'phone')).toBe(true);

    const device = await auth.enrollDevice({
      token: rotated.token,
      label: '集成测试设备',
      platform: 'web',
    });
    expect((await auth.listDevices(rotated.token)).map((entry) => entry.id)).toEqual([
      device.device.id,
    ]);
    await auth.revokeDevice(rotated.token, device.device.id);

    // The device revoke killed the session it was bound to.
    await expect(auth.resolveSession(rotated.token)).rejects.toMatchObject({
      code: 'session_revoked',
    });
  });

  /**
   * An account row that exists but has no trial workspace yet.
   *
   * Provisioning is what is under test here, so the account is written directly
   * rather than through registration: the suite needs a durable account that
   * outlives a refused provisioning call, which is exactly the state a failed
   * registration leaves behind.
   *
   * @param name - Test-scoped discriminator, kept unique by {@link RUN}.
   * @returns The account row.
   */
  async function accountWithoutWorkspace(name: string): Promise<UserAccount> {
    const now = new Date().toISOString();
    const account: UserAccount = {
      id: randomUUID(),
      username: `it-${name}-${RUN}`,
      displayName: `集成测试${name}账号`,
      status: 'active',
      passwordHash: null,
      passwordUpdatedAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      avatarUrl: null,
      idempotencyKey: null,
      createdAt: now,
      updatedAt: now,
    };
    created.users.push(account.id);
    await repository.saveUser(account);
    return account;
  }

  /**
   * The four rows a provisioning call would write for one account.
   *
   * Every id carries this run's discriminator, so a leftover row can never make
   * a test pass or fail for a reason the test did not cause.
   *
   * @param account - Account the workspace is built for.
   * @returns The tenant, store, member and link to hand to the adapter.
   */
  function trialInput(account: UserAccount): TrialWorkspaceInput {
    return buildTrialWorkspace({
      account,
      now: new Date().toISOString(),
      ids: {
        next: (prefix: string) => `${prefix}-${RUN}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  /** Record the directory rows of a provisioning result for cleanup. */
  function track(workspace: TrialWorkspaceProvision): void {
    created.tenants.push(workspace.tenant.id);
    created.members.push(workspace.member.id);
    if (workspace.store !== null) {
      created.stores.push(workspace.store.id);
    }
  }

  it('reads each member picture through the link that account holds', async () => {
    // The picture lives on the account and the member reaches it through an
    // active link, so the answer is a join — and the failure mode a join has and
    // a per-row read does not is picking up somebody else's row. Two members of
    // two different accounts, only one of which has a picture, is the smallest
    // arrangement in which that mistake is visible.
    const withPicture = await accountWithoutWorkspace('avatar');
    const withoutPicture = await accountWithoutWorkspace('noavatar');
    const first = await repository.provisionTrialWorkspace(trialInput(withPicture));
    const second = await repository.provisionTrialWorkspace(trialInput(withoutPicture));
    track(first);
    track(second);
    await repository.saveUser({
      ...withPicture,
      avatarUrl: ONE_PIXEL_PNG,
      updatedAt: new Date().toISOString(),
    });

    const both = await repository.listMemberAvatars([first.member.id, second.member.id]);
    expect(both.get(first.member.id)).toBe(ONE_PIXEL_PNG);
    // An account that exists and holds no picture is absent, not an empty
    // string: the caller falls back to the display name's first letter.
    expect(both.has(second.member.id)).toBe(false);

    // Asked one at a time, each answer is still about that member alone.
    expect((await repository.listMemberAvatars([first.member.id])).size).toBe(1);
    expect((await repository.listMemberAvatars([second.member.id])).size).toBe(0);
    expect((await repository.listMemberAvatars([])).size).toBe(0);

    // A revoked link is a former holder, not a colleague: the whole point of
    // revoking it is that the member stops standing for that account, and its
    // picture is part of what the member stood for.
    await repository.saveLink({
      ...first.link,
      revokedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect((await repository.listMemberAvatars([first.member.id])).size).toBe(0);
  });

  it('rolls a partially provisioned workspace back when a later write fails', async () => {
    // A workspace that really exists, so the failure can reuse a committed id.
    const holder = await accountWithoutWorkspace('holder');
    const committed = await repository.provisionTrialWorkspace(trialInput(holder));
    track(committed);
    expect(committed.provisioned).toBe(true);

    const account = await accountWithoutWorkspace('rollback');
    const input = trialInput(account);
    // The link row is the last write of a fresh provisioning, and this one names
    // an id that is already committed: the insert fails on the primary key, after
    // the tenant, the store and the member have already been written in the same
    // transaction. That is the shape every mid-provisioning failure has, whatever
    // the constraint that fires.
    const colliding: TrialWorkspaceInput = {
      ...input,
      link: { ...input.link, id: committed.link.id },
    };

    // The failure is reported as the documented conflict — never as a raw
    // driver error, which is what a caller would otherwise see as a 500.
    const error = await repository
      .provisionTrialWorkspace(colliding)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: 'idempotency_conflict' });

    // Not one directory row of the failed call survived...
    expect(await repository.getTenant(input.tenant.id)).toBeUndefined();
    expect(await repository.findStoreById(input.store.id)).toBeUndefined();
    expect(await repository.getMember(input.member.id)).toBeUndefined();
    expect(await repository.findTrialWorkspace(account.id)).toBeUndefined();
    // ...the committed workspace is untouched...
    expect((await repository.getTenant(committed.tenant.id))?.code).toBe(
      trialTenantCode(holder.id),
    );
    expect(await repository.findTrialWorkspace(holder.id)).toBeDefined();
    // ...and the account remains, so the attempt can simply be repeated.
    expect((await repository.getUser(account.id))?.status).toBe('active');

    const recovered = await repository.provisionTrialWorkspace(trialInput(account));
    track(recovered);
    expect(recovered.provisioned).toBe(true);
    expect(recovered.member.role).toBe('merchant_admin');
    expect(recovered.member.tenantId).toBe(recovered.tenant.id);
    expect(recovered.tenant.code).toBe(trialTenantCode(account.id));
  });

  it('answers the documented conflict when the trial member belongs to another account', async () => {
    const owner = await accountWithoutWorkspace('owner');
    const input = trialInput(owner);
    const provisioned = await repository.provisionTrialWorkspace(input);
    track(provisioned);
    expect(provisioned.provisioned).toBe(true);

    // The administrator revokes the account's own link and hands the membership
    // to a second account: only one account holds a membership at a time.
    const now = new Date().toISOString();
    await repository.saveLink({ ...provisioned.link, revokedAt: now, updatedAt: now });
    const other = await accountWithoutWorkspace('other');
    await repository.saveLink({
      ...provisioned.link,
      id: randomUUID(),
      userId: other.id,
      linkedAt: now,
      updatedAt: now,
    });

    // Asking for the workspace back finds the account's own tenant and its own
    // member, but that member is held by somebody else. The adapter has to say
    // so through the port's own refusal type rather than let the partial unique
    // index over the active links surface as a raw 500.
    const error = await repository
      .provisionTrialWorkspace(trialInput(owner))
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: 'idempotency_conflict' });

    // Nothing moved and nothing was duplicated.
    expect((await repository.getActiveLinkForMember(provisioned.member.id))?.userId).toBe(other.id);
    expect(await repository.findTrialWorkspace(owner.id)).toBeUndefined();
    expect(await repository.findTrialWorkspace(other.id)).toBeDefined();
    expect(await repository.listStores(provisioned.tenant.id)).toHaveLength(1);
    expect(await repository.listMembers(provisioned.tenant.id)).toHaveLength(1);

    // Handing the membership back makes the same call succeed, and the account
    // lands in the workspace it already owned rather than in a second one.
    const held = await repository.getActiveLinkForMember(provisioned.member.id);
    if (held === undefined) {
      throw new Error('the second account did not end up holding the membership');
    }
    await repository.saveLink({ ...held, revokedAt: now, updatedAt: now });

    const recovered = await repository.provisionTrialWorkspace(trialInput(owner));
    expect(recovered.provisioned).toBe(true);
    expect(recovered.tenant.id).toBe(provisioned.tenant.id);
    expect(recovered.member.id).toBe(provisioned.member.id);
    expect(recovered.link.revokedAt).toBeNull();
  });

  it('restores a storeless trial tenant under the tenant the account already owns', async () => {
    const account = await accountWithoutWorkspace('storeless');
    const provisioned = await repository.provisionTrialWorkspace(trialInput(account));
    track(provisioned);
    expect(provisioned.provisioned).toBe(true);
    const storeId = provisioned.store?.id;
    if (storeId === undefined) {
      throw new Error('the first provisioning created no store');
    }
    const tenantId = provisioned.tenant.id;

    // An existing trial tenant with no default store: the administrator removed
    // the tenant's only store and revoked the account's link at the same time.
    await pool.query('DELETE FROM stores WHERE id = $1', [storeId]);
    const now = new Date().toISOString();
    await repository.saveLink({ ...provisioned.link, revokedAt: now, updatedAt: now });
    expect(await repository.findTrialWorkspace(account.id)).toBeUndefined();

    // The retry restores the account into the tenant it already owns and creates
    // the missing store there. The freshly generated input names a tenant that
    // was never written, so a store filed under it is a foreign-key violation
    // rather than the documented conflict.
    const restored = await repository.provisionTrialWorkspace(trialInput(account));
    track(restored);

    expect(restored.provisioned).toBe(true);
    expect(restored.tenant.id).toBe(tenantId);
    expect(restored.member.id).toBe(provisioned.member.id);
    expect(restored.store?.tenantId).toBe(tenantId);
    expect(await repository.listStores(tenantId)).toHaveLength(1);

    // The store is readable through the workspace read, not only through the
    // provisioning result.
    const found = await repository.findTrialWorkspace(account.id);
    expect(found?.tenant.id).toBe(tenantId);
    expect(found?.store?.id).toBe(restored.store?.id);

    // Repeated calls stay idempotent: one store, one member, one tenant.
    const again = await repository.provisionTrialWorkspace(trialInput(account));
    expect(again.provisioned).toBe(false);
    expect(again.store?.id).toBe(restored.store?.id);
    expect(await repository.listStores(tenantId)).toHaveLength(1);
    expect(await repository.listMembers(tenantId)).toHaveLength(1);
  });

  it('validates a remembered device against the durable table on sign-in', async () => {
    const subject = destination('remembered');
    const username = `it-remembered-${RUN}`;

    await auth.sendOtp({ subject, channel: 'sms', purpose: 'sign_in' });
    const registered = await auth.register({
      subject,
      channel: 'sms',
      code: otp.lastDeliveryFor(subject)?.code ?? '',
      username,
      displayName: '集成测试记住设备账号',
      password: PASSWORD,
    });
    created.users.push(registered.session.userId);

    const device = await auth.enrollDevice({
      token: registered.token,
      label: '集成测试记住设备',
      platform: 'web',
    });

    // `findDeviceByFingerprint` reaches `trusted_devices` for the first time
    // here: until a client could present a credential, no code path ever called
    // it, so the unique fingerprint index had never been exercised.
    const remembered = await auth.loginWithPassword({
      username,
      password: PASSWORD,
      deviceCredential: device.credential,
    });
    expect(remembered.session.authMethod).toBe('trusted_device');
    expect(remembered.session.trustedDeviceId).toBe(device.device.id);

    // A credential that was never issued matches no row and leaves the sign-in
    // as an ordinary password one.
    const unissued = await auth.loginWithPassword({
      username,
      password: PASSWORD,
      deviceCredential: 'a-credential-that-was-never-issued',
    });
    expect(unissued.session.authMethod).toBe('password');
    expect(unissued.session.trustedDeviceId).toBeNull();

    // The reset has to retire the device on the durable row, with the reason the
    // schema's CHECK constraint admits.
    await auth.sendOtp({ subject, channel: 'sms', purpose: 'recover' });
    const reset = await auth.resetPassword({
      subject,
      channel: 'sms',
      code: otp.lastDeliveryFor(subject)?.code ?? '',
      newPassword: NEW_PASSWORD,
    });
    expect(reset.revokedDevices).toBe(1);

    const stored = await repository.getDevice(device.device.id);
    expect(stored?.status).toBe('revoked');
    expect(stored?.revokedReason).toBe('compromised');

    const afterReset = await auth.loginWithPassword({
      username,
      password: NEW_PASSWORD,
      deviceCredential: device.credential,
    });
    expect(afterReset.session.authMethod).toBe('password');
    expect(afterReset.session.trustedDeviceId).toBeNull();
  });

  it('creates a signable account through the durable schema', async () => {
    // Creating an account in the console is the one producer of accounts left
    // once registration is closed, so it is proven against the real tables and
    // not only against the in-memory adapter: the account row, the identity row
    // that reserves the username, and a sign-in that actually resolves.
    const username = `it-created-${RUN}`;
    const password = 'an-administrator-made-password';
    const admin = new AuthAdminService({ repository });
    const access: AccessContext = {
      userId: 'it-admin',
      sessionId: 'it-session',
      accountStatus: 'active',
      accessState: 'active',
      member: null,
      tenantId: null,
      storeId: null,
      role: 'platform_admin',
      authorizedStoreIds: [],
      authMethod: 'header',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };

    const account = await admin.createAccount(access, {
      username,
      displayName: '集成测试新建账号',
      password,
    });
    created.users.push(account.id);
    // Unlinked, so it stops at the account center until someone binds a member.
    expect(account.accessState).toBe('pending_config');
    expect(account.passwordConfigured).toBe(true);
    expect(JSON.stringify(account)).not.toContain(password);

    const stored = await pool.query('SELECT password_hash FROM user_accounts WHERE id = $1', [
      account.id,
    ]);
    const hash = stored.rows[0]?.password_hash;
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain(password);
    // The hash is the domain's own encoding, so the durable verifier accepts it.
    expect(verifyPassword(password, hash)).toBe(true);

    // The identity row is what reserves the username for password sign-in; a
    // later registration checks it before it checks anything else.
    const identities = await pool.query(
      'SELECT provider, subject, verified FROM user_identities WHERE user_id = $1 ORDER BY provider',
      [account.id],
    );
    expect(identities.rows).toEqual([{ provider: 'password', subject: username, verified: true }]);

    const signedIn = await auth.loginWithPassword({ username, password });
    expect(signedIn.session.userId).toBe(account.id);
    expect(signedIn.access.accessState).toBe('pending_config');

    // Uniqueness holds against the durable schema in either spelling, whichever
    // producer asks next.
    await expect(
      admin.createAccount(access, {
        username: username.toUpperCase(),
        displayName: '重名账号',
        password,
      }),
    ).rejects.toMatchObject({ code: 'username_taken' });
  });
});
