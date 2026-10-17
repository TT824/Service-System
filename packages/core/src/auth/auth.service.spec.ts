import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { FixedAuthClock, SequentialAuthIdGenerator } from './clock';
import { SEEDED_TENANTS } from './directory-seed';
import { isAuthError } from './errors';
import { InMemoryAuthRepository } from './memory-repository';
import { DEFAULT_AUTH_POLICY } from './policy';
import type { TrialWorkspaceInput, TrialWorkspaceProvision } from './ports';
import { LocalOidcProvider, LocalOtpProvider, LOCAL_OIDC_PROVIDER_KEY } from './providers';
import { TRIAL_TENANT_CODE_PREFIX, trialTenantCode } from './trial-workspace';
import type { AuthSession } from './types';

const START = '2026-09-10T00:00:00.000Z';
const PHONE = '+8613800000000';
const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-completely-different-passphrase';
const HOUR = 60 * 60 * 1000;

type Harness = {
  readonly repository: InMemoryAuthRepository;
  readonly otpProvider: LocalOtpProvider;
  readonly oidcProvider: LocalOidcProvider;
  readonly clock: FixedAuthClock;
  readonly service: AuthService;
};

function harness(): Harness {
  const repository = new InMemoryAuthRepository();
  const otpProvider = new LocalOtpProvider();
  const oidcProvider = new LocalOidcProvider();
  const clock = new FixedAuthClock(START);
  const service = new AuthService({
    repository,
    otpProvider,
    oidcProvider,
    clock,
    ids: new SequentialAuthIdGenerator(),
    policy: DEFAULT_AUTH_POLICY,
  });
  return { repository, otpProvider, oidcProvider, clock, service };
}

/**
 * An in-memory directory that refuses every workspace write.
 *
 * Stands in for a storage failure — an unreachable database, a constraint a retry
 * will not hit again — without inventing a second repository shape. Registration
 * must not reach it at all, so a registration driven through this repository is
 * the sharpest way to say so: it can only come back with a session if it never
 * asked the directory for anything.
 */
class FailingProvisionRepository extends InMemoryAuthRepository {
  /** @inheritdoc */
  override async provisionTrialWorkspace(
    _input: TrialWorkspaceInput,
  ): Promise<TrialWorkspaceProvision> {
    throw new Error('the directory is unavailable');
  }
}

/** Issue a code and read it back from the deterministic local provider. */
async function issueCode(
  h: Harness,
  purpose: 'sign_in' | 'recover' = 'sign_in',
  subject = PHONE,
): Promise<string> {
  await h.service.sendOtp({ subject, channel: 'sms', purpose });
  const delivery = h.otpProvider.lastDeliveryFor(subject);
  if (delivery === undefined) {
    throw new Error('the local provider recorded no delivery');
  }
  return delivery.code;
}

/** Register an account through the real workflow and return its session. */
async function registerAccount(
  h: Harness,
  overrides: { username?: string; subject?: string; password?: string } = {},
) {
  const subject = overrides.subject ?? PHONE;
  const username = overrides.username ?? 'alice';
  const password = overrides.password ?? PASSWORD;
  const code = await issueCode(h, 'sign_in', subject);
  return h.service.register({
    subject,
    channel: 'sms',
    code,
    username,
    displayName: 'Alice',
    password,
  });
}

/** Assert a call fails with a specific stable auth code. */
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

describe('AuthService.sendOtp', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('delivers a six-digit code and persists only its hash', async () => {
    const result = await h.service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' });
    const delivery = h.otpProvider.lastDeliveryFor(PHONE);
    expect(delivery?.code).toMatch(/^[0-9]{6}$/);
    expect(result.challengeId).toBe(delivery?.challengeId);
    expect(result.expiresAt).toBe('2026-09-10T00:05:00.000Z');
    expect(result.resent).toBe(false);

    const stored = await h.repository.getOtp(result.challengeId);
    expect(stored?.codeHash).toHaveLength(64);
    expect(stored?.codeHash).not.toContain(delivery?.code ?? '');
    expect(JSON.stringify(stored)).not.toContain(delivery?.code ?? '');

    // The service itself never hands the code back, not even as the optional
    // local-development field: revealing it is the HTTP boundary's decision,
    // and only there is the environment known.
    expect(result).not.toHaveProperty('developmentCode');
    expect(JSON.stringify(result)).not.toContain(delivery?.code ?? '');
  });

  it('trims the destination before storing it', async () => {
    const result = await h.service.sendOtp({
      subject: `  ${PHONE}  `,
      channel: 'sms',
      purpose: 'sign_in',
    });
    expect(result.subject).toBe(PHONE);
    expect(h.otpProvider.lastDeliveryFor(PHONE)?.subject).toBe(PHONE);
  });

  it('refuses a resend inside the cooldown', async () => {
    await h.service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' });
    await expectCode(
      h.service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' }),
      'otp_resend_too_soon',
    );
  });

  it('revokes the outstanding code when a new one is issued', async () => {
    const first = await h.service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' });
    h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    const second = await h.service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' });

    expect(second.resent).toBe(true);
    expect(second.challengeId).not.toBe(first.challengeId);
    expect((await h.repository.getOtp(first.challengeId))?.status).toBe('revoked');
    expect(h.otpProvider.lastDeliveryFor(PHONE)?.challengeId).toBe(second.challengeId);
  });

  it('refuses a fourth send inside the rolling window', async () => {
    for (let index = 0; index < DEFAULT_AUTH_POLICY.otp.maxSendsPerWindow; index += 1) {
      await h.service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' });
      h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    }
    await expectCode(
      h.service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' }),
      'otp_rate_limited',
    );
  });

  it('counts the send budget per destination and purpose', async () => {
    await h.service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' });
    // A different purpose and a different destination each get their own budget.
    await expect(
      h.service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'recover' }),
    ).resolves.toBeDefined();
    await expect(
      h.service.sendOtp({ subject: '+8613900000000', channel: 'sms', purpose: 'sign_in' }),
    ).resolves.toBeDefined();
  });

  it('fails closed when the resolved provider refuses to send', async () => {
    const failing = new AuthService({
      repository: new InMemoryAuthRepository(),
      otpProvider: {
        kind: 'unconfigured',
        send: () => Promise.reject(new Error('provider_not_configured')),
      },
      oidcProvider: new LocalOidcProvider(),
      clock: new FixedAuthClock(START),
    });
    await expect(
      failing.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' }),
    ).rejects.toThrow();
  });
});

describe('AuthService.register', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('creates a pending account with a hashed password and a verified phone identity', async () => {
    const session = await registerAccount(h);
    const account = await h.repository.findUserByUsername('alice');
    // `pending`, not `active`: registration is an application to serve, and this
    // is the status the approval queue reads.
    expect(account?.status).toBe('pending');
    expect(account?.passwordHash).not.toBeNull();
    expect(account?.passwordHash).not.toContain(PASSWORD);
    expect(account?.passwordHash?.startsWith('scrypt$')).toBe(true);

    const identities = await h.repository.listIdentities(account?.id ?? '');
    expect(identities.map((identity) => identity.provider).sort()).toEqual(['password', 'phone']);
    expect(identities.every((identity) => identity.verified)).toBe(true);
    expect(session.access.accountStatus).toBe('pending');
  });

  it('leaves a new account holding no tenant, store, member or link', async () => {
    const session = await registerAccount(h);

    // A registration is not a company. This deployment serves one organisation
    // and has two roles, so nothing is minted here: the account waits, and what
    // it can reach is its own account center and nothing else.
    expect(session.access.accessState).toBe('pending_config');
    expect(session.access.role).toBeNull();
    expect(session.access.tenantId).toBeNull();
    expect(session.access.member).toBeNull();

    expect(await h.repository.findTrialWorkspace(session.access.userId)).toBeUndefined();
    expect(await h.repository.listTenants()).toEqual(SEEDED_TENANTS);
  });

  it('gives the retry one workspace at most, though nothing routes to it any more', async () => {
    // `retryOnboarding` is kept with the workspace model behind it but has no
    // route (see `AuthController`): it mints a tenant, which is both an
    // organisation nobody asked for and — now that approval is a separate
    // decision — a way for an applicant to approve themselves. Its own behaviour
    // still has to hold, because it is the reason the model is kept at all.
    const session = await registerAccount(h);
    expect(await h.repository.findTrialWorkspace(session.access.userId)).toBeUndefined();

    const retried = await h.service.retryOnboarding(session.token);
    expect(retried.workspace.provisioned).toBe(true);

    const again = await h.service.retryOnboarding(session.token);
    expect(again.workspace.provisioned).toBe(false);
    expect(again.workspace.tenant.id).toBe(retried.workspace.tenant.id);
    expect(again.workspace.member.id).toBe(retried.workspace.member.id);
    expect(again.workspace.link.id).toBe(retried.workspace.link.id);

    const tenants = (await h.repository.listTenants()).filter(
      (tenant) => tenant.code === trialTenantCode(session.access.userId),
    );
    expect(tenants).toHaveLength(1);
    expect(await h.repository.listStores(retried.workspace.tenant.id)).toHaveLength(1);
  });

  it('never asks the directory for a workspace, even one that refuses to write', async () => {
    // The directory fails every write. Registration used to swallow that failure
    // and carry on; now it must not call it at all, and this is what says so: a
    // registration that reached for a workspace would come back without a
    // session.
    const repository = new FailingProvisionRepository();
    const otpProvider = new LocalOtpProvider();
    const service = new AuthService({
      repository,
      otpProvider,
      oidcProvider: new LocalOidcProvider(),
      clock: new FixedAuthClock(START),
      ids: new SequentialAuthIdGenerator(),
      policy: DEFAULT_AUTH_POLICY,
    });
    await service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' });
    const code = otpProvider.lastDeliveryFor(PHONE)?.code ?? '';

    const session = await service.register({
      subject: PHONE,
      channel: 'sms',
      code,
      username: 'alice',
      displayName: 'Alice',
      password: PASSWORD,
    });

    // The registration went through while the directory refused every write.
    // That is only possible because registration never asked it for anything —
    // which is the whole claim of this test; a workspace write that failed and
    // was swallowed would look exactly the same from here.
    expect(session.access.accessState).toBe('pending_config');
    expect(session.access.member).toBeNull();
    expect(
      (await repository.listTenants()).filter((tenant) =>
        tenant.code.startsWith(TRIAL_TENANT_CODE_PREFIX),
      ),
    ).toEqual([]);
    expect(await repository.listActiveLinksForUser(session.access.userId)).toEqual([]);
    expect((await repository.listAllAccounts()).map((account) => account.id)).toEqual([
      session.access.userId,
    ]);
  });

  it('does not claim a password credential when none was supplied', async () => {
    const code = await issueCode(h);
    const session = await h.service.register({
      subject: PHONE,
      channel: 'sms',
      code,
      username: 'bob',
      displayName: 'Bob',
    });
    const account = await h.repository.getUser(session.access.userId);
    expect(account?.passwordHash).toBeNull();
    const identities = await h.repository.listIdentities(session.access.userId);
    expect(identities.map((identity) => identity.provider)).toEqual(['phone']);
  });

  it('consumes the code, so it cannot be replayed', async () => {
    const code = await issueCode(h);
    await h.service.register({
      subject: PHONE,
      channel: 'sms',
      code,
      username: 'alice',
      displayName: 'Alice',
      password: PASSWORD,
    });
    await expectCode(
      h.service.register({
        subject: PHONE,
        channel: 'sms',
        code,
        username: 'carol',
        displayName: 'Carol',
        password: PASSWORD,
      }),
      'otp_consumed',
    );
  });

  it('rejects a wrong code and counts the attempt', async () => {
    const result = await h.service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' });
    await expectCode(
      h.service.register({
        subject: PHONE,
        channel: 'sms',
        code: '000000',
        username: 'alice',
        displayName: 'Alice',
        password: PASSWORD,
      }),
      'otp_invalid',
    );
    const stored = await h.repository.getOtp(result.challengeId);
    expect(stored?.failedAttempts).toBe(1);
    expect(stored?.status).toBe('pending');
  });

  it('burns the challenge once the attempt budget is spent', async () => {
    const result = await h.service.sendOtp({ subject: PHONE, channel: 'sms', purpose: 'sign_in' });
    for (let attempt = 0; attempt < DEFAULT_AUTH_POLICY.otp.maxAttempts; attempt += 1) {
      await expectCode(
        h.service.register({
          subject: PHONE,
          channel: 'sms',
          code: '000000',
          username: 'alice',
          displayName: 'Alice',
          password: PASSWORD,
        }),
        'otp_invalid',
      );
    }
    const lastAttempt = await h.repository.getOtp(result.challengeId);
    expect(lastAttempt?.status).toBe('revoked');
    expect(lastAttempt?.failedAttempts).toBe(DEFAULT_AUTH_POLICY.otp.maxAttempts);
  });

  it('rejects an expired code', async () => {
    const code = await issueCode(h);
    h.clock.advance(DEFAULT_AUTH_POLICY.otp.ttlMs);
    await expectCode(
      h.service.register({
        subject: PHONE,
        channel: 'sms',
        code,
        username: 'alice',
        displayName: 'Alice',
        password: PASSWORD,
      }),
      'otp_expired',
    );
  });

  it('rejects a duplicate username', async () => {
    await registerAccount(h);
    const code = await issueCode(h, 'sign_in', '+8613900000000');
    await expectCode(
      h.service.register({
        subject: '+8613900000000',
        channel: 'sms',
        code,
        username: 'ALICE',
        displayName: 'Alice Again',
        password: PASSWORD,
      }),
      'username_taken',
    );
  });

  it('rejects a destination that is already registered', async () => {
    await registerAccount(h);
    h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    const code = await issueCode(h);
    await expectCode(
      h.service.register({
        subject: PHONE,
        channel: 'sms',
        code,
        username: 'different-name',
        displayName: 'Different Name',
        password: PASSWORD,
      }),
      'identity_conflict',
    );
  });

  it('rejects a weak password', async () => {
    const code = await issueCode(h);
    await expectCode(
      h.service.register({
        subject: PHONE,
        channel: 'sms',
        code,
        username: 'alice',
        displayName: 'Alice',
        password: 'short',
      }),
      'password_too_weak',
    );
  });

  it('rejects an empty display name', async () => {
    const code = await issueCode(h);
    await expectCode(
      h.service.register({
        subject: PHONE,
        channel: 'sms',
        code,
        username: 'alice',
        displayName: '   ',
        password: PASSWORD,
      }),
      'invalid_request',
    );
  });
});

describe('AuthService.loginWithPassword', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await registerAccount(h);
  });

  it('signs in with the right password', async () => {
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    expect(session.access.authMethod).toBe('password');
    // Signing in approves nobody. The account is the same applicant it was: a
    // password proves it is the same person asking, and the waiting screen is
    // still where they land.
    expect(session.access.accessState).toBe('pending_config');
    const resolved = await h.service.resolveSession(session.token);
    expect(resolved.account.username).toBe('alice');
  });

  it('accepts a case-insensitive username', async () => {
    await expect(
      h.service.loginWithPassword({ username: 'ALICE', password: PASSWORD }),
    ).resolves.toBeDefined();
  });

  it('rejects a wrong password', async () => {
    await expectCode(
      h.service.loginWithPassword({ username: 'alice', password: 'not-the-password' }),
      'invalid_credentials',
    );
  });

  it('rejects an unknown username with the same code', async () => {
    await expectCode(
      h.service.loginWithPassword({ username: 'nobody', password: PASSWORD }),
      'invalid_credentials',
    );
  });

  it('rejects an account without a password', async () => {
    const code = await issueCode(h, 'sign_in', '+8613900000000');
    await h.service.register({
      subject: '+8613900000000',
      channel: 'sms',
      code,
      username: 'bob',
      displayName: 'Bob',
    });
    await expectCode(
      h.service.loginWithPassword({ username: 'bob', password: PASSWORD }),
      'password_not_set',
    );
  });

  it('locks the account after the configured number of failures', async () => {
    for (let attempt = 0; attempt < DEFAULT_AUTH_POLICY.password.maxFailedLogins; attempt += 1) {
      await expectCode(
        h.service.loginWithPassword({ username: 'alice', password: 'wrong-password' }),
        'invalid_credentials',
      );
    }
    const account = await h.repository.findUserByUsername('alice');
    expect(account?.status).toBe('locked');
    await expectCode(
      h.service.loginWithPassword({ username: 'alice', password: PASSWORD }),
      'account_locked',
    );
  });

  it('releases the lock once the lock window elapses', async () => {
    for (let attempt = 0; attempt < DEFAULT_AUTH_POLICY.password.maxFailedLogins; attempt += 1) {
      await expectCode(
        h.service.loginWithPassword({ username: 'alice', password: 'wrong-password' }),
        'invalid_credentials',
      );
    }
    h.clock.advance(DEFAULT_AUTH_POLICY.password.lockMs);
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    expect(session.access.accountStatus).toBe('active');
  });

  it('does not strand a signed-in session once the lock window elapses', async () => {
    // A session opened while the account was healthy has to outlive the lock:
    // otherwise locking the account silently turns the console the sign-in
    // already opened into a wall of refusals until the next sign-in.
    const live = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    for (let attempt = 0; attempt < DEFAULT_AUTH_POLICY.password.maxFailedLogins; attempt += 1) {
      await expectCode(
        h.service.loginWithPassword({ username: 'alice', password: 'wrong-password' }),
        'invalid_credentials',
      );
    }
    expect((await h.service.resolveSession(live.token)).access.accessState).toBe('disabled');

    h.clock.advance(DEFAULT_AUTH_POLICY.password.lockMs);

    // The row still reads `locked` — only a successful sign-in rewrites it — yet
    // the lock has lapsed, so the session is usable again. Alice holds no member
    // link, so her ordinary state is `pending_config` rather than `active`.
    expect((await h.repository.findUserByUsername('alice'))?.status).toBe('locked');
    expect((await h.service.resolveSession(live.token)).access.accessState).toBe(
      'pending_config',
    );
  });

  it('resets the failure counter after a successful sign-in', async () => {
    await expectCode(
      h.service.loginWithPassword({ username: 'alice', password: 'wrong-password' }),
      'invalid_credentials',
    );
    await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    expect((await h.repository.findUserByUsername('alice'))?.failedLoginCount).toBe(0);
  });

  it('leaves the account usable after two failures and locks on the third', async () => {
    for (const attempt of [1, 2]) {
      await expectCode(
        h.service.loginWithPassword({ username: 'alice', password: 'wrong-password' }),
        'invalid_credentials',
      );
      const account = await h.repository.findUserByUsername('alice');
      expect(account?.status).not.toBe('locked');
      expect(account?.failedLoginCount).toBe(attempt);
    }
    await expectCode(
      h.service.loginWithPassword({ username: 'alice', password: 'wrong-password' }),
      'invalid_credentials',
    );
    expect((await h.repository.findUserByUsername('alice'))?.status).toBe('locked');
  });

  it('gives the two-failure budget back after a successful sign-in', async () => {
    // The counter is consecutive, so signing in has to wipe it: otherwise a
    // mistyped password from an earlier session would spend the budget for a
    // later one, and the third strike would arrive looking like the first.
    for (let attempt = 0; attempt < DEFAULT_AUTH_POLICY.password.maxFailedLogins - 1; attempt += 1) {
      await expectCode(
        h.service.loginWithPassword({ username: 'alice', password: 'wrong-password' }),
        'invalid_credentials',
      );
    }
    await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    await expectCode(
      h.service.loginWithPassword({ username: 'alice', password: 'wrong-password' }),
      'invalid_credentials',
    );
    const account = await h.repository.findUserByUsername('alice');
    expect(account?.status).not.toBe('locked');
    expect(account?.failedLoginCount).toBe(1);
  });

  it('refuses a disabled account', async () => {
    const account = await h.repository.findUserByUsername('alice');
    if (account === undefined) {
      throw new Error('the registered account is missing');
    }
    await h.repository.saveUser({ ...account, status: 'disabled' });
    await expectCode(
      h.service.loginWithPassword({ username: 'alice', password: PASSWORD }),
      'account_disabled',
    );
  });
});

describe('AuthService.loginWithOtp', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await registerAccount(h);
  });

  it('signs in with a valid code', async () => {
    h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    const code = await issueCode(h);
    const session = await h.service.loginWithOtp({ subject: PHONE, channel: 'sms', code });
    expect(session.access.authMethod).toBe('otp');
    expect(session.access.userId).toBe((await h.repository.findUserByUsername('alice'))?.id);
  });

  it('rejects a code issued for another channel', async () => {
    h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    const code = await issueCode(h);
    await expectCode(
      h.service.loginWithOtp({ subject: PHONE, channel: 'email', code }),
      'otp_invalid',
    );
  });

  it('rejects an unknown destination', async () => {
    const other = '+8613911111111';
    await h.service.sendOtp({ subject: other, channel: 'sms', purpose: 'sign_in' });
    const code = h.otpProvider.lastDeliveryFor(other)?.code ?? '';
    await expectCode(
      h.service.loginWithOtp({ subject: other, channel: 'sms', code }),
      'invalid_credentials',
    );
  });

  it('refuses a disabled account', async () => {
    const account = await h.repository.findUserByUsername('alice');
    if (account === undefined) {
      throw new Error('the registered account is missing');
    }
    await h.repository.saveUser({ ...account, status: 'disabled' });
    h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    const code = await issueCode(h);
    await expectCode(
      h.service.loginWithOtp({ subject: PHONE, channel: 'sms', code }),
      'account_disabled',
    );
  });
});

describe('AuthService.resetPassword', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await registerAccount(h);
  });

  it('changes the password and revokes every active session', async () => {
    const first = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    const second = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });

    h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    const code = await issueCode(h, 'recover');
    const result = await h.service.resetPassword({
      subject: PHONE,
      channel: 'sms',
      code,
      newPassword: NEW_PASSWORD,
    });

    expect(result.revokedSessions).toBe(3);
    await expectCode(h.service.resolveSession(first.token), 'session_revoked');
    await expectCode(h.service.resolveSession(second.token), 'session_revoked');

    await expect(
      h.service.loginWithPassword({ username: 'alice', password: NEW_PASSWORD }),
    ).resolves.toBeDefined();
    await expectCode(
      h.service.loginWithPassword({ username: 'alice', password: PASSWORD }),
      'invalid_credentials',
    );
  });

  it('rejects reusing the current password', async () => {
    h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    const code = await issueCode(h, 'recover');
    await expectCode(
      h.service.resetPassword({ subject: PHONE, channel: 'sms', code, newPassword: PASSWORD }),
      'password_reuse',
    );
  });

  it('rejects a weak new password before consuming the code', async () => {
    h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    const challenge = await h.service.sendOtp({
      subject: PHONE,
      channel: 'sms',
      purpose: 'recover',
    });
    const code = h.otpProvider.lastDeliveryFor(PHONE)?.code ?? '';
    await expectCode(
      h.service.resetPassword({ subject: PHONE, channel: 'sms', code, newPassword: 'short' }),
      'password_too_weak',
    );
    expect((await h.repository.getOtp(challenge.challengeId))?.status).toBe('pending');
  });

  it('clears a lockout', async () => {
    for (let attempt = 0; attempt < DEFAULT_AUTH_POLICY.password.maxFailedLogins; attempt += 1) {
      await expectCode(
        h.service.loginWithPassword({ username: 'alice', password: 'wrong-password' }),
        'invalid_credentials',
      );
    }
    h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    const code = await issueCode(h, 'recover');
    await h.service.resetPassword({
      subject: PHONE,
      channel: 'sms',
      code,
      newPassword: NEW_PASSWORD,
    });
    await expect(
      h.service.loginWithPassword({ username: 'alice', password: NEW_PASSWORD }),
    ).resolves.toBeDefined();
  });

  it('retires the remembered devices along with the sessions', async () => {
    const first = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    const enrolled = await h.service.enrollDevice({
      token: first.token,
      label: 'Work laptop',
      platform: 'web',
    });

    h.clock.advance(DEFAULT_AUTH_POLICY.otp.resendCooldownMs);
    const code = await issueCode(h, 'recover');
    const result = await h.service.resetPassword({
      subject: PHONE,
      channel: 'sms',
      code,
      newPassword: NEW_PASSWORD,
    });

    expect(result.revokedDevices).toBe(1);
    const stored = await h.repository.getDevice(enrolled.device.id);
    expect(stored?.status).toBe('revoked');
    expect(stored?.revokedReason).toBe('compromised');

    // The essence of the acceptance criterion: the credential the client still
    // holds no longer marks this device as remembered.
    const after = await h.service.loginWithPassword({
      username: 'alice',
      password: NEW_PASSWORD,
      deviceCredential: enrolled.credential,
    });
    expect(after.session.authMethod).toBe('password');
    expect(after.session.trustedDeviceId).toBeNull();
  });

  it('counts only the devices it actually retired', async () => {
    const first = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    const lapsed = await h.service.enrollDevice({
      token: first.token,
      label: 'Old laptop',
      platform: 'web',
    });

    // The first device lapses on its own; the second is enrolled just before the
    // reset, so it is still live when the reset happens.
    h.clock.advance(DEFAULT_AUTH_POLICY.device.ttlMs - 1000);
    const second = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    const live = await h.service.enrollDevice({
      token: second.token,
      label: 'New laptop',
      platform: 'web',
    });

    h.clock.advance(1000);
    const code = await issueCode(h, 'recover');
    const result = await h.service.resetPassword({
      subject: PHONE,
      channel: 'sms',
      code,
      newPassword: NEW_PASSWORD,
    });

    expect(result.revokedDevices).toBe(1);
    expect((await h.repository.getDevice(live.device.id))?.status).toBe('revoked');
    // A device that had already lapsed is left as it is: it granted nothing, so
    // rewriting it would only misreport how many credentials were retired.
    expect((await h.repository.getDevice(lapsed.device.id))?.status).toBe('active');
  });
});

describe('AuthService.changePassword', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await registerAccount(h);
  });

  /** Two live sessions for the same account: one to keep, one to lose. */
  async function twoSessions(): Promise<{
    keeper: Awaited<ReturnType<AuthService['loginWithPassword']>>;
    other: Awaited<ReturnType<AuthService['loginWithPassword']>>;
  }> {
    const keeper = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    const other = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    return { keeper, other };
  }

  it('changes the password, keeps the caller signed in and revokes the others', async () => {
    const { keeper, other } = await twoSessions();

    const result = await h.service.changePassword({
      token: keeper.token,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    // Registration left a session of its own, so the account held three: the one
    // the caller is standing on and two others. Both others go, and only they:
    // ending the session in the operator's hands would end the screen they are
    // typing on.
    expect(result.revokedSessions).toBe(2);
    const live = await h.repository.listSessionsForUser(keeper.access.userId);
    expect(live.filter((session) => session.status === 'active').map((session) => session.id)).toEqual(
      [keeper.session.id],
    );
    await expect(h.service.resolveSession(keeper.token)).resolves.toBeDefined();
    await expectCode(h.service.resolveSession(other.token), 'session_revoked');

    await expect(
      h.service.loginWithPassword({ username: 'alice', password: NEW_PASSWORD }),
    ).resolves.toBeDefined();
    await expectCode(
      h.service.loginWithPassword({ username: 'alice', password: PASSWORD }),
      'invalid_credentials',
    );
  });

  it('refuses a wrong current password and leaves the credential alone', async () => {
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });

    await expectCode(
      h.service.changePassword({
        token: session.token,
        currentPassword: 'not-the-password',
        newPassword: NEW_PASSWORD,
      }),
      'password_mismatch',
    );

    // A refusal that still wrote would be a refusal that signed the operator out
    // of their own account.
    await expect(
      h.service.loginWithPassword({ username: 'alice', password: PASSWORD }),
    ).resolves.toBeDefined();
    await expectCode(
      h.service.loginWithPassword({ username: 'alice', password: NEW_PASSWORD }),
      'invalid_credentials',
    );
  });

  it('refuses a new password under the shared policy, and anything else still works', async () => {
    const { keeper, other } = await twoSessions();

    await expectCode(
      h.service.changePassword({ token: keeper.token, currentPassword: PASSWORD, newPassword: 'short' }),
      'password_too_weak',
    );

    // A rejected change must not have revoked the second session on its way out.
    await expect(h.service.resolveSession(other.token)).resolves.toBeDefined();
    await expect(
      h.service.loginWithPassword({ username: 'alice', password: PASSWORD }),
    ).resolves.toBeDefined();
  });

  it('refuses repeating the current password', async () => {
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    await expectCode(
      h.service.changePassword({
        token: session.token,
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
      }),
      'password_reuse',
    );
  });

  it('refuses an account that has no password credential', async () => {
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    const account = await h.repository.findUserByUsername('alice');
    if (account === undefined) {
      throw new Error('the registered account is missing');
    }
    await h.repository.saveUser({ ...account, passwordHash: null });

    await expectCode(
      h.service.changePassword({
        token: session.token,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
      'password_not_set',
    );
  });

  it('clears a lockout that was in place when the password changed', async () => {
    // The session is opened before the lockout: a locked account still holds the
    // sessions it opened while it was healthy, which is the only door left to an
    // operator who has just locked themselves out.
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    for (let attempt = 0; attempt < DEFAULT_AUTH_POLICY.password.maxFailedLogins; attempt += 1) {
      await expectCode(
        h.service.loginWithPassword({ username: 'alice', password: 'wrong-password' }),
        'invalid_credentials',
      );
    }
    await expectCode(
      h.service.loginWithPassword({ username: 'alice', password: PASSWORD }),
      'account_locked',
    );

    // Choosing a new password through a live session is the same recovery as
    // choosing one with a code.
    await expect(
      h.service.changePassword({
        token: session.token,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    ).resolves.toBeDefined();
    await expect(
      h.service.loginWithPassword({ username: 'alice', password: NEW_PASSWORD }),
    ).resolves.toBeDefined();
  });

  it('refuses a session that is no longer usable', async () => {
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    await h.service.logout({ token: session.token });

    await expectCode(
      h.service.changePassword({
        token: session.token,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
      'session_revoked',
    );
  });
});

describe('AuthService.verifiedPhone', () => {
  it('returns the number of a verified phone identity', async () => {
    const h = harness();
    await registerAccount(h);
    const account = await h.repository.findUserByUsername('alice');
    if (account === undefined) {
      throw new Error('the registered account is missing');
    }

    await expect(h.service.verifiedPhone(account.id)).resolves.toBe(PHONE);
  });

  it('reports nothing for an account that has no number at all', async () => {
    const h = harness();
    const session = await registerAccount(h);
    for (const identity of await h.repository.listIdentities(session.access.userId)) {
      if (identity.provider === 'phone') {
        await h.repository.deleteIdentity(identity.id);
      }
    }

    // The seeded platform administrator is in exactly this state, which is why
    // the console has to be able to fall back to the username.
    await expect(h.service.verifiedPhone(session.access.userId)).resolves.toBeNull();
  });

  it('ignores an unverified number', async () => {
    const h = harness();
    const session = await registerAccount(h);
    const identities = await h.repository.listIdentities(session.access.userId);
    const phone = identities.find((identity) => identity.provider === 'phone');
    if (phone === undefined) {
      throw new Error('registration recorded no phone identity');
    }
    await h.repository.saveIdentity({ ...phone, verified: false });

    await expect(h.service.verifiedPhone(session.access.userId)).resolves.toBeNull();
  });
});

describe('AuthService.logout', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await registerAccount(h);
  });

  it('revokes the presented session', async () => {
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    await expect(h.service.logout({ token: session.token })).resolves.toEqual({
      revokedSessions: 1,
    });
    await expectCode(h.service.resolveSession(session.token), 'session_revoked');
  });

  it('revokes every session when asked', async () => {
    const first = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    const second = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    await expect(h.service.logout({ token: second.token, allSessions: true })).resolves.toEqual({
      revokedSessions: 3,
    });
    await expectCode(h.service.resolveSession(first.token), 'session_revoked');
  });

  it('is idempotent for an unknown or already revoked token', async () => {
    await expect(h.service.logout({ token: 'not-a-real-token' })).resolves.toEqual({
      revokedSessions: 0,
    });
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    await h.service.logout({ token: session.token });
    await expect(h.service.logout({ token: session.token })).resolves.toEqual({
      revokedSessions: 0,
    });
  });
});

describe('AuthService.resolveSession', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
  });

  it('rejects an unknown token', async () => {
    await expectCode(h.service.resolveSession('not-a-real-token'), 'session_invalid');
  });

  it('expires a session past its lifetime', async () => {
    const session = await registerAccount(h);
    h.clock.advance(DEFAULT_AUTH_POLICY.session.ttlMs);
    await expectCode(h.service.resolveSession(session.token), 'session_expired');
    expect((await h.repository.getSession(session.session.id))?.status).toBe('expired');
  });

  it('keeps working inside the lifetime', async () => {
    const session = await registerAccount(h);
    h.clock.advance(DEFAULT_AUTH_POLICY.session.ttlMs - 1000);
    await expect(h.service.resolveSession(session.token)).resolves.toBeDefined();
  });

  it('revokes the session of an account that was disabled', async () => {
    const session = await registerAccount(h);
    const account = await h.repository.findUserByUsername('alice');
    if (account === undefined) {
      throw new Error('the registered account is missing');
    }
    await h.repository.saveUser({ ...account, status: 'disabled' });
    await expectCode(h.service.resolveSession(session.token), 'account_disabled');
    expect((await h.repository.getSession(session.session.id))?.status).toBe('revoked');
  });

  it('never persists the bearer token in the clear', async () => {
    const session = await registerAccount(h);
    const stored = await h.repository.findSessionByFingerprint(session.session.tokenFingerprint);
    expect(stored?.tokenFingerprint).not.toBe(session.token);
    expect(JSON.stringify(stored)).not.toContain(session.token);
  });

  it('refreshes last_seen_at only after the touch interval', async () => {
    const session = await registerAccount(h);
    const before = await h.repository.getSession(session.session.id);
    h.clock.advance(DEFAULT_AUTH_POLICY.session.touchIntervalMs - 1);
    await h.service.resolveSession(session.token);
    expect((await h.repository.getSession(session.session.id))?.lastSeenAt).toBe(
      before?.lastSeenAt,
    );

    h.clock.advance(1);
    await h.service.resolveSession(session.token);
    expect((await h.repository.getSession(session.session.id))?.lastSeenAt).toBe(
      '2026-09-10T00:01:00.000Z',
    );
  });
});

describe('AuthService.rotateSession', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
  });

  it('replaces the token and keeps the session working', async () => {
    const session = await registerAccount(h);
    const rotated = await h.service.rotateSession(session.token);
    expect(rotated.token).not.toBe(session.token);
    expect(rotated.session.id).toBe(session.session.id);

    const resolved = await h.service.resolveSession(rotated.token);
    expect(resolved.session.previousTokenFingerprint).toBe(session.session.tokenFingerprint);
  });

  it('detects a replay of the superseded token and revokes the session', async () => {
    const session = await registerAccount(h);
    const rotated = await h.service.rotateSession(session.token);

    await expectCode(h.service.resolveSession(session.token), 'session_reuse_detected');
    const revoked = await h.repository.getSession(session.session.id);
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revokedReason).toBe('reuse_detected');

    // The rotated token is dead too, which is the point of revoking the family.
    await expectCode(h.service.resolveSession(rotated.token), 'session_revoked');
  });
});

describe('AuthService trusted devices', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
  });

  /** Register an account and remember the device the caller is using. */
  async function rememberDevice() {
    const session = await registerAccount(h);
    const enrolled = await h.service.enrollDevice({
      token: session.token,
      label: 'Work laptop',
      platform: 'web',
    });
    return { session, enrolled };
  }

  it('enrols the current device and never returns the credential again', async () => {
    const session = await registerAccount(h);
    const enrolled = await h.service.enrollDevice({
      token: session.token,
      label: 'Work laptop',
      platform: 'web',
    });
    expect(enrolled.credential).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(enrolled.device.current).toBe(true);

    const stored = await h.repository.getDevice(enrolled.device.id);
    expect(stored?.credentialFingerprint).not.toBe(enrolled.credential);
    expect(JSON.stringify(stored)).not.toContain(enrolled.credential);

    const devices = await h.service.listDevices(session.token);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.label).toBe('Work laptop');
    expect(JSON.stringify(devices)).not.toContain(enrolled.credential);
  });

  it('revokes the device and every session bound to it', async () => {
    const session = await registerAccount(h);
    const enrolled = await h.service.enrollDevice({
      token: session.token,
      label: 'Work laptop',
      platform: 'web',
    });

    await expect(h.service.revokeDevice(session.token, enrolled.device.id)).resolves.toEqual({
      revokedSessions: 1,
    });
    const stored = await h.repository.getDevice(enrolled.device.id);
    expect(stored?.status).toBe('revoked');
    expect(stored?.revokedReason).toBe('user');
    await expectCode(h.service.resolveSession(session.token), 'session_revoked');
  });

  it('refuses an unknown device and a second revoke', async () => {
    const session = await registerAccount(h);
    await expectCode(
      h.service.revokeDevice(session.token, 'device-does-not-exist'),
      'device_not_found',
    );

    const enrolled = await h.service.enrollDevice({
      token: session.token,
      label: 'Work laptop',
      platform: 'web',
    });
    const other = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    await h.service.revokeDevice(other.token, enrolled.device.id);
    await expectCode(h.service.revokeDevice(other.token, enrolled.device.id), 'device_revoked');
  });

  it('refuses a device enrolled by another account', async () => {
    const session = await registerAccount(h);
    const enrolled = await h.service.enrollDevice({
      token: session.token,
      label: 'Work laptop',
      platform: 'web',
    });
    const otherCode = await issueCode(h, 'sign_in', '+8613900000000');
    const other = await h.service.register({
      subject: '+8613900000000',
      channel: 'sms',
      code: otherCode,
      username: 'bob',
      displayName: 'Bob',
      password: PASSWORD,
    });
    await expectCode(h.service.revokeDevice(other.token, enrolled.device.id), 'device_not_found');
  });

  it('recognises a live credential as the reason the device is remembered', async () => {
    const { enrolled } = await rememberDevice();

    const again = await h.service.loginWithPassword({
      username: 'alice',
      password: PASSWORD,
      deviceCredential: enrolled.credential,
    });

    expect(again.session.authMethod).toBe('trusted_device');
    expect(again.session.trustedDeviceId).toBe(enrolled.device.id);
    // A remembered device is what stands in for the second factor, which is the
    // whole point of remembering one.
    expect(again.session.mfaSatisfied).toBe(true);
    expect((await h.repository.getDevice(enrolled.device.id))?.lastSeenAt).toBe(h.clock.now());
  });

  it('signs in with the password alone when no credential is presented', async () => {
    await rememberDevice();

    const plain = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });

    expect(plain.session.authMethod).toBe('password');
    expect(plain.session.trustedDeviceId).toBeNull();
    expect(plain.session.mfaSatisfied).toBe(false);
  });

  it('drops the device trust the moment it is revoked, without blocking the sign-in', async () => {
    const { session, enrolled } = await rememberDevice();

    await h.service.revokeDevice(session.token, enrolled.device.id);
    const after = await h.service.loginWithPassword({
      username: 'alice',
      password: PASSWORD,
      deviceCredential: enrolled.credential,
    });

    // The credential lost its effect on the very next sign-in, and the account
    // is not locked out by holding a stale one.
    expect(after.session.authMethod).toBe('password');
    expect(after.session.trustedDeviceId).toBeNull();
  });

  it('ignores an unknown credential', async () => {
    await rememberDevice();

    const attempt = await h.service.loginWithPassword({
      username: 'alice',
      password: PASSWORD,
      deviceCredential: 'this-was-never-issued',
    });

    expect(attempt.session.authMethod).toBe('password');
    expect(attempt.session.trustedDeviceId).toBeNull();
  });

  it('ignores a credential that belongs to another account', async () => {
    const { enrolled } = await rememberDevice();
    const otherCode = await issueCode(h, 'sign_in', '+8613900000000');
    await h.service.register({
      subject: '+8613900000000',
      channel: 'sms',
      code: otherCode,
      username: 'bob',
      displayName: 'Bob',
      password: PASSWORD,
    });

    const attempt = await h.service.loginWithPassword({
      username: 'bob',
      password: PASSWORD,
      deviceCredential: enrolled.credential,
    });

    expect(attempt.session.authMethod).toBe('password');
    expect(attempt.session.trustedDeviceId).toBeNull();
    // Someone else presenting the credential must not count as the device being
    // seen, and must not bind the device to the other account's session.
    expect((await h.repository.getDevice(enrolled.device.id))?.lastSeenAt).toBe(START);
    expect(await h.repository.listSessionsForDevice(enrolled.device.id)).toHaveLength(1);
  });

  it('lapses a device on the read path, without rewriting the stored row', async () => {
    const { enrolled } = await rememberDevice();

    h.clock.advance(DEFAULT_AUTH_POLICY.device.ttlMs - 1000);
    const atEdge = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    expect((await h.service.listDevices(atEdge.token))[0]?.status).toBe('active');

    h.clock.advance(1000);
    const past = await h.service.loginWithPassword({
      username: 'alice',
      password: PASSWORD,
      deviceCredential: enrolled.credential,
    });
    expect(past.session.authMethod).toBe('password');
    expect((await h.service.listDevices(past.token))[0]?.status).toBe('expired');
    // No sweep job ever ran; the row still says what it always said.
    expect((await h.repository.getDevice(enrolled.device.id))?.status).toBe('active');
  });

  it('lets a lapsed device give up its slot in the device budget', async () => {
    const { session } = await rememberDevice();
    for (let index = 1; index < DEFAULT_AUTH_POLICY.device.maxPerUser; index += 1) {
      await h.service.enrollDevice({
        token: session.token,
        label: `Extra ${index}`,
        platform: 'web',
      });
    }
    await expectCode(
      h.service.enrollDevice({ token: session.token, label: 'Over budget', platform: 'web' }),
      'device_limit_reached',
    );

    h.clock.advance(DEFAULT_AUTH_POLICY.device.ttlMs);
    const fresh = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    await expect(
      h.service.enrollDevice({ token: fresh.token, label: 'After the lapse', platform: 'web' }),
    ).resolves.toBeDefined();
  });
});

describe('AuthService OIDC identities', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('binds an external identity to an account with a verified local credential', async () => {
    const session = await registerAccount(h);
    const identity = await h.service.bindOidc({
      token: session.token,
      code: 'authorization-code-1',
    });
    expect(identity.provider).toBe('oidc');
    expect(identity.subject.startsWith(`${LOCAL_OIDC_PROVIDER_KEY}:`)).toBe(true);
    expect(identity.verified).toBe(true);
  });

  it('is idempotent for the same account and code', async () => {
    const session = await registerAccount(h);
    const first = await h.service.bindOidc({ token: session.token, code: 'authorization-code-1' });
    const second = await h.service.bindOidc({ token: session.token, code: 'authorization-code-1' });
    expect(second.id).toBe(first.id);
    expect(await h.repository.listIdentities(session.access.userId)).toHaveLength(3);
  });

  it('refuses an identity already bound to another account', async () => {
    const session = await registerAccount(h);
    await h.service.bindOidc({ token: session.token, code: 'authorization-code-1' });

    const otherCode = await issueCode(h, 'sign_in', '+8613900000000');
    const other = await h.service.register({
      subject: '+8613900000000',
      channel: 'sms',
      code: otherCode,
      username: 'bob',
      displayName: 'Bob',
      password: PASSWORD,
    });
    await expectCode(
      h.service.bindOidc({ token: other.token, code: 'authorization-code-1' }),
      'identity_conflict',
    );
  });

  it('requires a verified local credential before binding', async () => {
    const code = await issueCode(h);
    const session = await h.service.register({
      subject: PHONE,
      channel: 'sms',
      code,
      username: 'alice',
      displayName: 'Alice',
    });
    // The phone identity is the account's only credential; withdraw its
    // verification and binding must be refused.
    const identities = await h.repository.listIdentities(session.access.userId);
    for (const identity of identities) {
      await h.repository.saveIdentity({ ...identity, verified: false, verifiedAt: null });
    }
    await expectCode(
      h.service.bindOidc({ token: session.token, code: 'authorization-code-1' }),
      'identity_unverified',
    );
  });

  it('signs in through a bound identity', async () => {
    const session = await registerAccount(h);
    await h.service.bindOidc({ token: session.token, code: 'authorization-code-1' });

    const oidcSession = await h.service.loginWithOidc({ code: 'authorization-code-1' });
    expect(oidcSession.access.authMethod).toBe('sso');
    expect(oidcSession.access.userId).toBe(session.access.userId);
  });

  it('refuses an unbound identity', async () => {
    await expectCode(h.service.loginWithOidc({ code: 'never-bound' }), 'identity_not_found');
  });

  it('refuses to sign in through an identity of a disabled account', async () => {
    const session = await registerAccount(h);
    await h.service.bindOidc({ token: session.token, code: 'authorization-code-1' });
    const account = await h.repository.getUser(session.access.userId);
    if (account === undefined) {
      throw new Error('the registered account is missing');
    }
    await h.repository.saveUser({ ...account, status: 'disabled' });
    await expectCode(h.service.loginWithOidc({ code: 'authorization-code-1' }), 'account_disabled');
  });

  it('unbinds an external identity while a local credential remains', async () => {
    const session = await registerAccount(h);
    const identity = await h.service.bindOidc({
      token: session.token,
      code: 'authorization-code-1',
    });
    await expect(
      h.service.unbindOidc({ token: session.token, identityId: identity.id }),
    ).resolves.toEqual({ identityId: identity.id });
    await expectCode(
      h.service.loginWithOidc({ code: 'authorization-code-1' }),
      'identity_not_found',
    );
  });

  it('refuses to remove the last remaining credential', async () => {
    const session = await registerAccount(h);
    const identity = await h.service.bindOidc({
      token: session.token,
      code: 'authorization-code-1',
    });
    // An operator removed the local password; the external identity is now the
    // account's only way in, so removing it would lock the account out.
    const identities = await h.repository.listIdentities(session.access.userId);
    for (const candidate of identities) {
      if (candidate.provider !== 'oidc') {
        await h.repository.deleteIdentity(candidate.id);
      }
    }
    await expectCode(
      h.service.unbindOidc({ token: session.token, identityId: identity.id }),
      'identity_last_credential',
    );
  });

  it('refuses to unbind an identity of another account or an unknown id', async () => {
    const session = await registerAccount(h);
    await expectCode(
      h.service.unbindOidc({ token: session.token, identityId: 'identity-does-not-exist' }),
      'identity_not_bound',
    );

    const otherCode = await issueCode(h, 'sign_in', '+8613900000000');
    const other = await h.service.register({
      subject: '+8613900000000',
      channel: 'sms',
      code: otherCode,
      username: 'bob',
      displayName: 'Bob',
      password: PASSWORD,
    });
    const foreign = await h.service.bindOidc({ token: other.token, code: 'authorization-code-9' });
    await expectCode(
      h.service.unbindOidc({ token: session.token, identityId: foreign.id }),
      'identity_not_bound',
    );
  });
});

describe('AuthService.accountCenter', () => {
  it('is reachable in pending_config and hides credential material', async () => {
    const h = harness();
    const session = await registerAccount(h);
    const view = await h.service.accountCenter(session.token);

    expect(view.access.accessState).toBe('pending_config');
    expect(view.account.username).toBe('alice');
    expect(view.account.passwordConfigured).toBe(true);
    expect(view.identities.map((identity) => identity.provider).sort()).toEqual([
      'password',
      'phone',
    ]);
    expect(view.sessions).toHaveLength(1);
    expect(view.sessions[0]?.current).toBe(true);
    expect(view.devices).toHaveLength(0);
    expect(view.tenant).toBeNull();
    expect(view.stores).toEqual([]);
    expect(view.members).toEqual([]);

    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain(session.token);
    expect(serialised).not.toContain('passwordHash');
  });

  it('is refused for a disabled account', async () => {
    const h = harness();
    const session = await registerAccount(h);
    const account = await h.repository.getUser(session.access.userId);
    if (account === undefined) {
      throw new Error('the registered account is missing');
    }
    await h.repository.saveUser({ ...account, status: 'disabled' });
    await expectCode(h.service.accountCenter(session.token), 'account_disabled');
  });
});

describe('AuthService session budget', () => {
  it('evicts the oldest session once the budget is exceeded', async () => {
    const h = harness();
    const policy = { ...DEFAULT_AUTH_POLICY, maxActiveSessionsPerUser: 2 };
    const service = new AuthService({
      repository: h.repository,
      otpProvider: h.otpProvider,
      oidcProvider: h.oidcProvider,
      clock: h.clock,
      ids: new SequentialAuthIdGenerator(),
      policy,
    });
    const code = await issueCode(h);
    const first = await service.register({
      subject: PHONE,
      channel: 'sms',
      code,
      username: 'alice',
      displayName: 'Alice',
      password: PASSWORD,
    });
    h.clock.advance(HOUR);
    const second = await service.loginWithPassword({ username: 'alice', password: PASSWORD });
    h.clock.advance(HOUR);
    const third = await service.loginWithPassword({ username: 'alice', password: PASSWORD });

    await expectCode(service.resolveSession(first.token), 'session_revoked');
    await expect(service.resolveSession(second.token)).resolves.toBeDefined();
    await expect(service.resolveSession(third.token)).resolves.toBeDefined();
  });
});

describe('AuthService session listing', () => {
  it('marks the current session and reports the account sessions newest first', async () => {
    const h = harness();
    const first = await registerAccount(h);
    h.clock.advance(HOUR);
    const second = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });

    const sessions = await h.service.listSessions(second.token);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.current)).toEqual([true, false]);
    expect(sessions[0]?.id).toBe(second.session.id);
    expect(sessions[1]?.id).toBe(first.session.id);
    expect(JSON.stringify(sessions)).not.toContain(second.token);
  });

  it('omits sessions of another account', async () => {
    const h = harness();
    await registerAccount(h);
    const otherCode = await issueCode(h, 'sign_in', '+8613900000000');
    const other = await h.service.register({
      subject: '+8613900000000',
      channel: 'sms',
      code: otherCode,
      username: 'bob',
      displayName: 'Bob',
      password: PASSWORD,
    });
    const sessions: ReadonlyArray<AuthSession> = await h.repository.listSessionsForUser(
      other.access.userId,
    );
    expect(sessions).toHaveLength(1);
    expect((await h.service.listSessions(other.token)).every((session) => session.current)).toBe(
      true,
    );
  });
});

describe('AuthService.setAvatar', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await registerAccount(h);
  });

  /** A one-pixel PNG: the smallest picture the route will take. */
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('stores the picture where the session will read it back', async () => {
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });

    const account = await h.service.setAvatar(session.token, PNG);

    expect(account.avatarUrl).toBe(PNG);
    // The return value is not what the console draws from: `/auth/session`
    // reports the account it resolved, so the assertion that matters is the one
    // that reads the row back through the same door the console uses.
    const resolved = await h.service.resolveSession(session.token);
    expect(resolved.account.avatarUrl).toBe(PNG);
  });

  it('clears the picture when handed null', async () => {
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    await h.service.setAvatar(session.token, PNG);

    const account = await h.service.setAvatar(session.token, null);

    expect(account.avatarUrl).toBeNull();
    expect((await h.service.resolveSession(session.token)).account.avatarUrl).toBeNull();
  });

  it('changes nothing else about the account or its sessions', async () => {
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    const sessionsBefore = await h.repository.listSessionsForUser(session.access.userId);
    const accountBefore = await h.repository.getUser(session.access.userId);

    await h.service.setAvatar(session.token, PNG);

    // A picture is not a credential: nothing an operator proved by signing in
    // changes, so nothing they are signed into elsewhere may be ended by this.
    const sessionsAfter = await h.repository.listSessionsForUser(session.access.userId);
    expect(sessionsAfter.map((live) => live.id)).toEqual(sessionsBefore.map((live) => live.id));
    expect(sessionsAfter.every((live) => live.status === 'active')).toBe(true);
    // One field, and only one: an avatar change that also touched the password
    // hash or the lockout counter would be a write nobody asked for.
    expect(await h.repository.getUser(session.access.userId)).toEqual({
      ...accountBefore,
      avatarUrl: PNG,
    });
  });

  it('refuses a value it cannot store and writes nothing', async () => {
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    await h.service.setAvatar(session.token, PNG);

    await expectCode(h.service.setAvatar(session.token, 'not-a-picture'), 'avatar_invalid');

    // The previous picture is still the one on file: a refusal that still wrote
    // would take an operator's avatar away for typing the wrong thing.
    expect((await h.repository.getUser(session.access.userId))?.avatarUrl).toBe(PNG);
  });

  it('refuses an account that is no longer signed in', async () => {
    const session = await h.service.loginWithPassword({ username: 'alice', password: PASSWORD });
    await h.service.logout({ token: session.token });

    await expectCode(h.service.setAvatar(session.token, PNG), 'session_revoked');
    expect((await h.repository.getUser(session.access.userId))?.avatarUrl).toBeNull();
  });
});
