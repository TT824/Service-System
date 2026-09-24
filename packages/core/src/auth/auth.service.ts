/**
 * Authentication domain service.
 *
 * Owns the sign-in, registration, recovery, session, device and OIDC
 * workflows. It is a plain class over the {@link AuthRepository} port, the
 * provider interfaces, an injected clock and an injected identifier source, so
 * the exact behaviour that runs in production is the behaviour a unit test
 * exercises — no Nest container and no database required.
 *
 * Rules this service enforces, independent of the adapter:
 *
 * - a password is stored as an encoded scrypt hash and never returned;
 * - a bearer token is stored as a SHA-256 fingerprint and returned exactly once;
 * - a one-time code is single-use, expires, and burns after its attempt budget;
 * - a password reset, an account disable and a device revoke all revoke the
 *   sessions they invalidate, and the first two also retire the account's device
 *   credentials, because a device that was trusted on the strength of a
 *   credential must stop being trusted when that credential is replaced;
 * - a device credential is checked against its own expiry and revocation on
 *   every sign-in that presents one, so `expires_at` is enforced without a
 *   sweep job and a revocation takes effect on the next request;
 * - an external identity may only be bound to an account that already proved a
 *   verified local credential.
 */

import {
  RandomAuthIdGenerator,
  SystemAuthClock,
  type AuthClock,
  type AuthIdGenerator,
} from './clock';
import { AuthError } from './errors';
import {
  expireOtpIfElapsed,
  generateOtpCode,
  hashOtpCode,
  isOtpUsable,
  otpUnusableError,
  verifyOtpCode,
} from './otp';
import {
  assertPasswordStrength,
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  verifyPassword,
} from './password';
import {
  addMilliseconds,
  DEFAULT_AUTH_POLICY,
  effectiveDeviceStatus,
  isDeviceUsable,
  isOtpResendCoolingDown,
  isOtpSendRateLimited,
  type AuthPolicy,
} from './policy';
import { OnboardingService } from './onboarding.service';
import { namespacedIdentitySubject } from './providers';
import type { AuthRepository, TrialWorkspaceProvision } from './ports';
import type { OtpProvider, OidcProvider } from './providers';
import { fingerprintSecret, generateDeviceCredential, generateSessionToken } from './token';
import { assertAvatarDataUrl } from './avatar';
import { buildAccessContext, type AccessResolutionInput } from './access-context';
import type { Member, Store, Tenant } from '../platform/types';
import type {
  AccessContext,
  AccountStatus,
  AuthProvider,
  AuthSession,
  DevicePlatform,
  DeviceRevokedReason,
  DeviceSummary,
  MemberUserLink,
  OtpChannel,
  OtpChallenge,
  OtpDelivery,
  OtpPurpose,
  SessionAuthMethod,
  SessionRevokedReason,
  SessionSummary,
  TrustedDevice,
  UserAccount,
  UserIdentity,
} from './types';

/** Dependencies of {@link AuthService}. */
export type AuthServiceDeps = {
  readonly repository: AuthRepository;
  readonly otpProvider: OtpProvider;
  readonly oidcProvider: OidcProvider;
  /** Time source; defaults to the system clock. */
  readonly clock?: AuthClock;
  /** Identifier source; defaults to random UUIDs. */
  readonly ids?: AuthIdGenerator;
  /** Policy overrides; defaults to {@link DEFAULT_AUTH_POLICY}. */
  readonly policy?: AuthPolicy;
  /**
   * Trial workspace provisioning; defaults to one over the same repository.
   *
   * Overridable so a caller can supply the same instance the rest of an
   * application already holds, and so tests can drive provisioning failures.
   */
  readonly onboarding?: OnboardingService;
};

/** Request to issue a one-time code. */
export type SendOtpInput = {
  readonly subject: string;
  readonly channel: OtpChannel;
  readonly purpose: OtpPurpose;
};

/**
 * Public result of issuing a one-time code.
 *
 * The code is not part of the result {@link AuthService} produces: it exists
 * only in the delivery the provider performed. The optional member below is
 * the single, explicitly-guarded exception — it is filled in by the HTTP
 * composition boundary in local development only (see
 * `AUTH_DEVELOPMENT_OTP_VISIBLE`), and is absent everywhere else.
 */
export type SendOtpResult = {
  readonly challengeId: string;
  readonly subject: string;
  readonly channel: OtpChannel;
  readonly purpose: OtpPurpose;
  readonly expiresAt: string;
  readonly resent: boolean;
  /**
   * Local-development only: the code the deterministic local provider
   * delivered, so a developer can finish the sign-in loop without a real
   * SMS/e-mail provider.
   *
   * Never set by {@link AuthService}, never set for a production provider, and
   * never returned when `APP_ENV` is not `local`.
   */
  readonly developmentCode?: string;
};

/** Request to register an account with a verified one-time code. */
export type RegisterInput = {
  readonly subject: string;
  readonly channel: OtpChannel;
  readonly code: string;
  readonly username: string;
  readonly displayName: string;
  /** Optional initial password; when omitted the account has no password yet. */
  readonly password?: string;
};

/** Request to sign in with a username and password. */
export type LoginWithPasswordInput = {
  readonly username: string;
  readonly password: string;
  /**
   * Credential of a device the account chose to remember, when the client still
   * holds one. Optional, and never a substitute for the password: it only
   * decides whether this sign-in is recognised as coming from a trusted device.
   */
  readonly deviceCredential?: string;
  readonly clientFingerprint?: string;
};

/** Request to sign in with a one-time code. */
export type LoginWithOtpInput = {
  readonly subject: string;
  readonly channel: OtpChannel;
  readonly code: string;
  readonly clientFingerprint?: string;
};

/** Request to reset a password with a recovery code. */
export type ResetPasswordInput = {
  readonly subject: string;
  readonly channel: OtpChannel;
  readonly code: string;
  readonly newPassword: string;
};

/** Outcome of a password reset. */
export type ResetPasswordResult = {
  readonly userId: string;
  readonly revokedSessions: number;
  /** Device credentials that stopped being trusted, so the caller can say so. */
  readonly revokedDevices: number;
};

/**
 * Request to change the password of the signed-in account.
 *
 * The current password is required rather than optional: a bearer token is a
 * credential someone else can steal from a shared machine or an unlocked tab,
 * and demanding the password proves the person at the keyboard is the account
 * holder and not merely whoever found the session.
 */
export type ChangePasswordInput = {
  readonly token: string;
  readonly currentPassword: string;
  readonly newPassword: string;
};

/**
 * Outcome of a password change.
 *
 * `revokedSessions` counts the *other* sessions that were ended; the session
 * that made the change stays signed in, because the account holder is standing
 * in it.
 */
export type ChangePasswordResult = {
  readonly userId: string;
  readonly revokedSessions: number;
};

/** Request to end a session. */
export type LogoutInput = {
  readonly token: string;
  /** Also end every other session of the same account. */
  readonly allSessions?: boolean;
};

/** Outcome of a logout. */
export type LogoutResult = {
  readonly revokedSessions: number;
};

/** Request to bind an external OIDC identity to the signed-in account. */
export type BindOidcInput = {
  readonly token: string;
  readonly code: string;
  readonly redirectUri?: string;
};

/** Request to sign in through an OIDC identity. */
export type LoginWithOidcInput = {
  readonly code: string;
  readonly redirectUri?: string;
  readonly clientFingerprint?: string;
};

/** Request to remove a bound external identity. */
export type UnbindOidcInput = {
  readonly token: string;
  readonly identityId: string;
};

/** Request to remember a device. */
export type EnrollDeviceInput = {
  readonly token: string;
  readonly label: string;
  readonly platform: DevicePlatform;
};

/** Result of a signed-in action. */
export type SessionIssueResult = {
  /** The bearer token. Returned exactly once and never persisted in the clear. */
  readonly token: string;
  readonly session: AuthSession;
  readonly access: AccessContext;
};

/** A session together with the account and access context it resolves to. */
export type ResolvedSession = {
  readonly session: AuthSession;
  readonly account: UserAccount;
  readonly access: AccessContext;
};

/**
 * Outcome of an onboarding retry: the session as it now stands, and the
 * workspace the account acts through.
 */
export type OnboardingResult = ResolvedSession & {
  readonly workspace: TrialWorkspaceProvision;
};

/** Public identity view (never exposes storage internals). */
export type PublicIdentity = {
  readonly id: string;
  readonly provider: AuthProvider;
  readonly subject: string;
  readonly verified: boolean;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
};

/** Public account view (never exposes the password hash). */
export type PublicAccount = {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly passwordConfigured: boolean;
  readonly passwordUpdatedAt: string | null;
  readonly lastLoginAt: string | null;
  /** Base64 `data:` URL, or `null` when the account has no avatar. */
  readonly avatarUrl: string | null;
  readonly createdAt: string;
};

/** Everything the account center renders. */
export type AccountCenterView = {
  readonly account: PublicAccount;
  readonly identities: ReadonlyArray<PublicIdentity>;
  readonly access: AccessContext;
  readonly tenant: Tenant | null;
  readonly stores: ReadonlyArray<Store>;
  readonly members: ReadonlyArray<Member>;
  readonly sessions: ReadonlyArray<SessionSummary>;
  readonly devices: ReadonlyArray<DeviceSummary>;
};

/** Result of enrolling a device. */
export type EnrollDeviceResult = {
  /** The device credential. Returned exactly once and never persisted in the clear. */
  readonly credential: string;
  readonly device: DeviceSummary;
};

/** Sign-in credentials for a password failure, kept out of the happy path. */
const DUMMY_PASSWORD_PLAINTEXT = 'kefu-dummy-password-for-timing-equalisation';
let dummyPasswordHash: string | undefined;

/** Lazily computed hash used to equalise the cost of an unknown username. */
function dummyHash(): string {
  dummyPasswordHash ??= hashPassword(
    DUMMY_PASSWORD_PLAINTEXT,
    DEFAULT_SCRYPT_PARAMS,
    Buffer.alloc(16, 7),
  );
  return dummyPasswordHash;
}

/** Authentication workflows. */
export class AuthService {
  readonly #repository: AuthRepository;
  readonly #otpProvider: OtpProvider;
  readonly #oidcProvider: OidcProvider;
  readonly #clock: AuthClock;
  readonly #ids: AuthIdGenerator;
  readonly #policy: AuthPolicy;
  readonly #onboarding: OnboardingService;

  /**
   * @param deps - Repository, providers, clock, identifier source, policy and
   * onboarding.
   */
  constructor(deps: AuthServiceDeps) {
    this.#repository = deps.repository;
    this.#otpProvider = deps.otpProvider;
    this.#oidcProvider = deps.oidcProvider;
    this.#clock = deps.clock ?? new SystemAuthClock();
    this.#ids = deps.ids ?? new RandomAuthIdGenerator();
    this.#policy = deps.policy ?? DEFAULT_AUTH_POLICY;
    this.#onboarding =
      deps.onboarding ??
      new OnboardingService({
        repository: deps.repository,
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
        ...(deps.ids === undefined ? {} : { ids: deps.ids }),
      });
  }

  // ==========================================================================
  // One-time codes
  // ==========================================================================

  /**
   * Issue a one-time code to a destination.
   *
   * Enforces the rolling send budget and the resend cooldown, and keeps at most
   * one live challenge per destination and purpose: issuing a new code revokes
   * the outstanding one, so an older code can never be replayed.
   *
   * @param input - Destination, channel and purpose.
   * @returns Public challenge information; the code itself is only delivered.
   * @throws {AuthError} `otp_rate_limited` or `otp_resend_too_soon`.
   */
  async sendOtp(input: SendOtpInput): Promise<SendOtpResult> {
    const subject = normalizeSubject(input.subject);
    const now = this.#clock.now();
    const windowStart = addMilliseconds(now, -this.#policy.otp.windowMs);
    const issued = await this.#repository.listOtpIssuedAt(subject, input.purpose, windowStart);

    if (isOtpSendRateLimited(issued, now, this.#policy.otp)) {
      throw new AuthError(
        'otp_rate_limited',
        'too many one-time codes requested for this destination',
      );
    }

    const outstanding = await this.#repository.findPendingOtp(subject, input.purpose);
    if (outstanding !== undefined) {
      if (isOtpResendCoolingDown(issued, now, this.#policy.otp)) {
        throw new AuthError('otp_resend_too_soon', 'a one-time code was sent moments ago');
      }
      await this.#repository.saveOtp({
        ...outstanding,
        status: 'revoked',
        revokedAt: now,
        updatedAt: now,
      });
    }

    const user = await this.#resolveUserForSubject(input.channel, subject);
    const link =
      user === undefined ? undefined : await this.#repository.listActiveLinksForUser(user.id);
    const challengeId = this.#ids.next('otp');
    const code = generateOtpCode();
    const expiresAt = addMilliseconds(now, this.#policy.otp.ttlMs);
    const challenge: OtpChallenge = {
      id: challengeId,
      tenantId: link?.[0]?.tenantId ?? null,
      userId: user?.id ?? null,
      purpose: input.purpose,
      channel: input.channel,
      subject,
      codeHash: hashOtpCode(challengeId, code),
      codeAlgorithm: 'sha256',
      status: 'pending',
      failedAttempts: 0,
      maxAttempts: this.#policy.otp.maxAttempts,
      idempotencyKey: null,
      issuedAt: now,
      expiresAt,
      consumedAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#repository.saveOtp(challenge);

    const delivery: OtpDelivery = {
      challengeId,
      channel: input.channel,
      subject,
      purpose: input.purpose,
      code,
      expiresAt,
    };
    await this.#otpProvider.send(delivery);

    return {
      challengeId,
      subject,
      channel: input.channel,
      purpose: input.purpose,
      expiresAt,
      resent: outstanding !== undefined,
    };
  }

  // ==========================================================================
  // Registration and sign-in
  // ==========================================================================

  /**
   * Register an account from a verified one-time code: an application to serve.
   *
   * The code proves the caller controls the destination, so the account holds a
   * *verified* local identity. It starts `pending` and owns nothing else — no
   * tenant, no store, no member — because a self-service registration is a
   * request to become an agent, not a company being founded. This deployment
   * serves exactly one organisation and has exactly two roles, so a registration
   * that minted a workspace would mint a second organisation nobody asked for
   * (see `self-use` §1) and hand the applicant administrator rights over it.
   *
   * The session is still issued here rather than refused, and that is what makes
   * the waiting screen work: `pending` resolves to `pending_config`, so the new
   * account reaches exactly one surface — its own account center — while the
   * console stays closed. An administrator approving the application
   * ({@link AdminService.approveAccount}) flips the account to `active` and binds
   * it to an agent member; the waiting tab then re-verifies this same token and
   * walks in without registering again.
   *
   * @param input - Verified destination plus the account's profile.
   * @returns A signed-in session for the new account, closed to business data.
   * @throws {AuthError} `username_taken`, `password_too_weak` or an OTP failure.
   */
  async register(input: RegisterInput): Promise<SessionIssueResult> {
    const subject = normalizeSubject(input.subject);
    const username = normalizeSubject(input.username);
    const displayName = input.displayName.trim();
    if (displayName.length === 0) {
      throw new AuthError('invalid_request', 'display name must not be empty');
    }
    if (input.password !== undefined) {
      assertPasswordStrength(input.password);
    }

    await this.#consumeOtp({ subject, purpose: 'sign_in', code: input.code });

    if ((await this.#repository.findUserByUsername(username)) !== undefined) {
      throw new AuthError('username_taken', 'the username is already registered');
    }
    if ((await this.#repository.findIdentity('password', username)) !== undefined) {
      throw new AuthError('username_taken', 'the username is already registered');
    }
    if (
      input.channel === 'sms' &&
      (await this.#repository.findIdentity('phone', subject)) !== undefined
    ) {
      throw new AuthError('identity_conflict', 'the destination is already registered');
    }

    const now = this.#clock.now();
    const userId = this.#ids.next('user');
    const account: UserAccount = {
      id: userId,
      username,
      displayName,
      // Not `active`: nothing has decided this account may serve yet. `pending`
      // is the state the approval queue reads and the waiting screen renders.
      status: 'pending',
      passwordHash: input.password === undefined ? null : hashPassword(input.password),
      passwordUpdatedAt: input.password === undefined ? null : now,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: now,
      // A new account has no picture; the console draws the display name's
      // first letter until an operator picks one.
      avatarUrl: null,
      idempotencyKey: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#repository.saveUser(account);
    if (input.password !== undefined) {
      // A password identity only exists once there is a password to use it, so
      // an identity row never claims a credential the account does not have.
      await this.#createIdentity({
        userId,
        provider: 'password',
        subject: username,
        verified: true,
        now,
      });
    }
    if (input.channel === 'sms') {
      // The schema only admits a phone identity once the number was verified,
      // which is precisely what the consumed sign-in code just proved.
      await this.#createIdentity({
        userId,
        provider: 'phone',
        subject,
        verified: true,
        now,
      });
    }

    // Registration stops here. It used to call `provisionTrial` in a
    // deliberately swallowed try/catch, which is what made a self-service signup
    // its own company; that call is now the *approval* path's job
    // ({@link AdminService.approveAccount}) and no longer happens on this one.
    //
    // The account is deliberately left holding nothing: no member link, so
    // `deriveAccessState` resolves it to `pending_config` — the state the waiting
    // screen renders and the platform refuses every business endpoint for.
    return this.#issueSession({
      userId,
      authMethod: 'otp',
      deviceId: null,
      clientFingerprint: null,
    });
  }

  /**
   * Give an existing account the trial workspace it never got.
   *
   * **Nothing routes to this any more, and nothing may.** `POST
   * /auth/onboarding/retry` was its only caller and that route is gone: it mints
   * a tenant, a store and a merchant administrator, which is both an organisation
   * the operator never asked for and — now that registration stops at `pending`
   * — a way for any applicant to approve *themselves* by calling it. Approval is
   * {@link AdminService.approveAccount}'s job and only that.
   *
   * It is kept, with the onboarding service behind it, because the model and its
   * migrations are legitimate and deleting them would touch four files and two
   * e2e suites for no user-visible gain. Treat it as frozen, not as an available
   * door: re-adding a route to it re-opens every door at once.
   *
   * Safe to call repeatedly. Provisioning resolves an account that already has a
   * workspace instead of creating a second one, and this method then re-stamps
   * the caller's session onto that workspace — which is what makes the call
   * useful after an administrator linked, revoked or relinked the account: the
   * session follows the membership the account actually has, rather than the one
   * it was issued with.
   *
   * @param token - The caller's bearer token.
   * @returns The refreshed session, its access context and the workspace.
   * @throws {AuthError} When the presented session is not usable.
   */
  async retryOnboarding(token: string): Promise<OnboardingResult> {
    const resolved = await this.resolveSession(token);
    const workspace = await this.#onboarding.provisionTrial(resolved.account);

    // The session is re-pointed at the workspace before the access context is
    // rebuilt, so the context returned is the one the very next request will
    // resolve to — the caller does not have to rotate or sign in again.
    const now = this.#clock.now();
    const session: AuthSession = {
      ...resolved.session,
      tenantId: workspace.member.tenantId,
      memberId: workspace.member.id,
      updatedAt: now,
    };
    await this.#repository.saveSession(session);

    return {
      session,
      account: resolved.account,
      access: await this.#buildAccessContext(resolved.account, session),
      workspace,
    };
  }

  /**
   * Sign in with a username and a password.
   *
   * @param input - Username, password and optional client fingerprint.
   * @returns A signed-in session.
   * @throws {AuthError} `invalid_credentials`, `account_locked`,
   * `account_disabled` or `password_not_set`.
   */
  async loginWithPassword(input: LoginWithPasswordInput): Promise<SessionIssueResult> {
    const username = normalizeSubject(input.username);
    const user = await this.#repository.findUserByUsername(username);
    if (user === undefined) {
      // Spend the same work as a real verification so an unknown username is
      // not distinguishable from a wrong password by response time.
      verifyPassword(input.password, dummyHash());
      throw new AuthError('invalid_credentials', 'username or password is incorrect');
    }

    const now = this.#clock.now();
    const locked =
      user.status === 'locked' &&
      user.lockedUntil !== null &&
      Date.parse(user.lockedUntil) > Date.parse(now);
    if (locked) {
      throw new AuthError('account_locked', 'the account is temporarily locked');
    }
    if (user.status === 'disabled') {
      throw new AuthError('account_disabled', 'the account is disabled');
    }
    if (user.passwordHash === null) {
      throw new AuthError('password_not_set', 'the account has no password configured');
    }

    if (!verifyPassword(input.password, user.passwordHash)) {
      const failedLoginCount = user.failedLoginCount + 1;
      const shouldLock = failedLoginCount >= this.#policy.password.maxFailedLogins;
      await this.#repository.saveUser({
        ...user,
        failedLoginCount,
        status: shouldLock ? 'locked' : user.status === 'locked' ? 'active' : user.status,
        lockedUntil: shouldLock ? addMilliseconds(now, this.#policy.password.lockMs) : null,
        updatedAt: now,
      });
      throw new AuthError('invalid_credentials', 'username or password is incorrect');
    }

    await this.#repository.saveUser({
      ...user,
      status: user.status === 'locked' ? 'active' : user.status,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: now,
      updatedAt: now,
    });

    // The password above is what proved the caller; the credential only decides
    // whether this client is one the account already chose to remember. A
    // credential that does not check out therefore downgrades the sign-in to a
    // plain password sign-in rather than failing it — which is what makes a
    // revoked or expired device mean "no longer trusted" and never "locked out".
    const device = await this.#resolveTrustedDevice(input.deviceCredential, user.id, now);
    return this.#issueSession({
      userId: user.id,
      authMethod: device === null ? 'password' : 'trusted_device',
      deviceId: device?.id ?? null,
      clientFingerprint: input.clientFingerprint ?? null,
    });
  }

  /**
   * Sign in with a one-time code.
   *
   * @param input - Destination, channel and code.
   * @returns A signed-in session.
   * @throws {AuthError} An OTP failure, or `invalid_credentials` when no
   * account is bound to the destination.
   */
  async loginWithOtp(input: LoginWithOtpInput): Promise<SessionIssueResult> {
    const subject = normalizeSubject(input.subject);
    const challenge = await this.#consumeOtp({
      subject,
      purpose: 'sign_in',
      code: input.code,
      channel: input.channel,
    });
    const user =
      challenge.userId === null
        ? await this.#resolveUserForSubject(input.channel, subject)
        : await this.#repository.getUser(challenge.userId);
    if (user === undefined) {
      throw new AuthError('invalid_credentials', 'no account is bound to this destination');
    }
    this.#assertAccountUsable(user);

    const now = this.#clock.now();
    await this.#repository.saveUser({ ...user, lastLoginAt: now, updatedAt: now });
    return this.#issueSession({
      userId: user.id,
      authMethod: 'otp',
      deviceId: null,
      clientFingerprint: input.clientFingerprint ?? null,
    });
  }

  /**
   * Reset a password with a recovery code.
   *
   * Revokes every active session of the account, because a password reset is
   * precisely the moment an attacker who held the old credential loses it.
   *
   * @param input - Destination, recovery code and the new password.
   * @returns The account id and how many sessions were revoked.
   * @throws {AuthError} An OTP failure, `password_too_weak` or `password_reuse`.
   */
  async resetPassword(input: ResetPasswordInput): Promise<ResetPasswordResult> {
    assertPasswordStrength(input.newPassword);
    const subject = normalizeSubject(input.subject);
    const challenge = await this.#consumeOtp({
      subject,
      purpose: 'recover',
      code: input.code,
      channel: input.channel,
    });
    const user =
      challenge.userId === null
        ? await this.#resolveUserForSubject(input.channel, subject)
        : await this.#repository.getUser(challenge.userId);
    if (user === undefined) {
      throw new AuthError('otp_invalid', 'no account is bound to this destination');
    }
    if (user.passwordHash !== null && verifyPassword(input.newPassword, user.passwordHash)) {
      throw new AuthError('password_reuse', 'the new password must differ from the current one');
    }

    const now = this.#clock.now();
    await this.#repository.saveUser({
      ...user,
      passwordHash: hashPassword(input.newPassword),
      passwordUpdatedAt: now,
      failedLoginCount: 0,
      lockedUntil: null,
      status: user.status === 'locked' ? 'active' : user.status,
      updatedAt: now,
    });
    const revokedSessions = await this.#revokeSessionsForUser(user.id, 'admin_revoked', now);
    // The old password may have been in someone else's hands, which is the whole
    // reason for the reset — so every device remembered under it goes too, not
    // just the sessions. `compromised` is the accurate reason: the devices did
    // nothing wrong, the credential they rested on is no longer trustworthy.
    const revokedDevices = await this.#revokeDevicesForUser(user.id, 'compromised', now);
    await this.#revokeOutstandingChallenges(subject, now);
    return { userId: user.id, revokedSessions, revokedDevices };
  }

  /**
   * Change the password of the signed-in account.
   *
   * This is the *other* half of `resetPassword`, and the difference between them
   * is what the caller can prove. A reset proves control of a recovery
   * destination and therefore distrusts everything: it ends every session and
   * every remembered device, because the old password may have been in someone
   * else's hands. A change proves knowledge of the current password and
   * therefore distrusts nothing but the password itself — the operator stays
   * signed in, their remembered devices stay remembered, and only the *other*
   * sessions end, since those are the ones the account holder is not standing in
   * and cannot vouch for.
   *
   * @param input - Bearer token, the current password and the new one.
   * @returns The account id and how many other sessions were revoked.
   * @throws {AuthError} A session failure, `password_not_set`,
   * `password_mismatch`, `password_too_weak` or `password_reuse`.
   */
  async changePassword(input: ChangePasswordInput): Promise<ChangePasswordResult> {
    const resolved = await this.resolveSession(input.token);
    const user = resolved.account;
    if (user.passwordHash === null) {
      // An account that signs in with a one-time code or an external identity
      // has no password to change. Saying so is better than accepting a "current
      // password" that was never checked against anything.
      throw new AuthError('password_not_set', 'the account has no password credential');
    }
    if (!verifyPassword(input.currentPassword, user.passwordHash)) {
      throw new AuthError('password_mismatch', 'the current password is not correct');
    }
    // Checked before the new password is judged, so a caller who mistyped the
    // current one is told *that* rather than being sent to fix a new password
    // that was fine.
    assertPasswordStrength(input.newPassword);
    if (verifyPassword(input.newPassword, user.passwordHash)) {
      throw new AuthError('password_reuse', 'the new password must differ from the current one');
    }

    const now = this.#clock.now();
    await this.#repository.saveUser({
      ...user,
      passwordHash: hashPassword(input.newPassword),
      passwordUpdatedAt: now,
      // Whoever just proved they know the password is not a failed-login
      // attacker, so a lock accumulated before this point must not outlive it.
      failedLoginCount: 0,
      lockedUntil: null,
      status: user.status === 'locked' ? 'active' : user.status,
      updatedAt: now,
    });

    // Every other session, not every session: deleting the one that made the
    // change would sign the operator out of the form they just submitted.
    const sessions = await this.#repository.listSessionsForUser(user.id);
    let revokedSessions = 0;
    for (const session of sessions) {
      if (session.status === 'active' && session.id !== resolved.session.id) {
        await this.#revokeSession(session, 'admin_revoked', now);
        revokedSessions += 1;
      }
    }
    return { userId: user.id, revokedSessions };
  }

  /**
   * Replace the avatar of the signed-in account.
   *
   * This is a write to the caller's own identity, so it is the narrowest one in
   * this service: no session ends, no device is forgotten, nothing an operator
   * is signed into elsewhere changes. A picture is not a credential, and an
   * account that changes one has proved nothing new — which is why this route
   * asks for a live session and nothing else.
   *
   * `null` removes the avatar. Clearing is a real operation rather than a
   * degenerate one: the console falls back to the first letter of the display
   * name, which is a picture too, and an operator who dislikes one they uploaded
   * should not have to upload another to be rid of it.
   *
   * @param token - Bearer token of the caller.
   * @param avatarUrl - Base64 `data:` URL, or `null` to clear it.
   * @returns The public account as it now stands.
   * @throws {AuthError} A session failure, or `avatar_invalid` when the value is
   *   not a bounded image of an accepted type.
   */
  async setAvatar(token: string, avatarUrl: string | null): Promise<PublicAccount> {
    const resolved = await this.resolveSession(token);
    if (avatarUrl !== null) {
      assertAvatarDataUrl(avatarUrl);
    }
    const updated: UserAccount = {
      ...resolved.account,
      avatarUrl,
      updatedAt: this.#clock.now(),
    };
    await this.#repository.saveUser(updated);
    return toPublicAccount(updated);
  }

  // ==========================================================================
  // Sessions
  // ==========================================================================

  /**
   * Resolve a bearer token into a session, an account and an access context.
   *
   * Rotation reuse is detected here: a token that is no longer current but is
   * still recorded as the previous token of a live session is a replay of an
   * already-rotated credential, so the whole session is revoked.
   *
   * @param token - The bearer token presented by the client.
   * @returns Session, account and access context.
   * @throws {AuthError} `session_invalid`, `session_expired`, `session_revoked`,
   * `session_reuse_detected` or `account_disabled`.
   */
  async resolveSession(token: string): Promise<ResolvedSession> {
    const now = this.#clock.now();
    const fingerprint = fingerprintSecret(token);
    const session = await this.#repository.findSessionByFingerprint(fingerprint);
    if (session === undefined) {
      const rotated = await this.#repository.findSessionByPreviousFingerprint(fingerprint);
      if (rotated !== undefined && rotated.status === 'active') {
        await this.#revokeSession(rotated, 'reuse_detected', now);
        throw new AuthError(
          'session_reuse_detected',
          'a rotated bearer token was replayed; the session was revoked',
        );
      }
      throw new AuthError('session_invalid', 'the bearer token is not recognized');
    }
    // The account is loaded before the session status is judged so that an
    // account an administrator switched off reports `account_disabled` rather
    // than the less specific `session_revoked` its revocation left behind.
    const account = await this.#repository.getUser(session.userId);
    if (account === undefined) {
      await this.#revokeSession(session, 'admin_revoked', now);
      throw new AuthError('session_invalid', 'the session account no longer exists');
    }
    if (account.status === 'disabled') {
      await this.#revokeSession(session, 'admin_revoked', now);
      throw new AuthError('account_disabled', 'the account is disabled');
    }
    if (session.status === 'revoked') {
      throw new AuthError('session_revoked', 'the session was revoked');
    }
    if (Date.parse(session.expiresAt) <= Date.parse(now)) {
      await this.#repository.saveSession({ ...session, status: 'expired', updatedAt: now });
      throw new AuthError('session_expired', 'the session has expired');
    }

    const touched = this.#touchSession(session, now);
    if (touched !== session) {
      await this.#repository.saveSession(touched);
    }
    return {
      session: touched,
      account,
      access: await this.#buildAccessContext(account, touched),
    };
  }

  /**
   * Rotate a session's bearer token.
   *
   * The previous fingerprint stays on the record so a replay of the superseded
   * token is detectable by {@link resolveSession}.
   *
   * @param token - The current bearer token.
   * @returns A new token and the rotated session.
   * @throws {AuthError} When the presented session is not usable.
   */
  async rotateSession(token: string): Promise<SessionIssueResult> {
    const resolved = await this.resolveSession(token);
    const now = this.#clock.now();
    const nextToken = generateSessionToken();
    const rotated: AuthSession = {
      ...resolved.session,
      previousTokenFingerprint: resolved.session.tokenFingerprint,
      tokenFingerprint: fingerprintSecret(nextToken),
      expiresAt: addMilliseconds(now, this.#policy.session.ttlMs),
      lastSeenAt: now,
      updatedAt: now,
    };
    await this.#repository.saveSession(rotated);
    return { token: nextToken, session: rotated, access: resolved.access };
  }

  /**
   * End a session, optionally every session of the same account.
   *
   * Logging out is idempotent: an unknown or already-revoked token revokes
   * nothing and reports zero rather than failing.
   *
   * @param input - Bearer token and whether to end every session.
   * @returns How many sessions were revoked.
   */
  async logout(input: LogoutInput): Promise<LogoutResult> {
    const now = this.#clock.now();
    const session = await this.#repository.findSessionByFingerprint(fingerprintSecret(input.token));
    if (session === undefined) {
      return { revokedSessions: 0 };
    }
    if (input.allSessions === true) {
      return {
        revokedSessions: await this.#revokeSessionsForUser(session.userId, 'sign_out', now),
      };
    }
    if (session.status !== 'active') {
      return { revokedSessions: 0 };
    }
    await this.#revokeSession(session, 'sign_out', now);
    return { revokedSessions: 1 };
  }

  /**
   * Sessions of the signed-in account, newest first.
   *
   * @param token - Bearer token of the caller.
   * @returns Public session summaries; never a token or fingerprint.
   */
  async listSessions(token: string): Promise<ReadonlyArray<SessionSummary>> {
    const resolved = await this.resolveSession(token);
    const sessions = await this.#repository.listSessionsForUser(resolved.account.id);
    return sessions.map((session) => toSessionSummary(session, session.id === resolved.session.id));
  }

  // ==========================================================================
  // Trusted devices
  // ==========================================================================

  /**
   * Remember a device for the signed-in account.
   *
   * @param input - Bearer token, label and platform.
   * @returns The device credential (shown once) and its public summary.
   * @throws {AuthError} `device_limit_reached` equivalent when too many exist.
   */
  async enrollDevice(input: EnrollDeviceInput): Promise<EnrollDeviceResult> {
    const resolved = await this.resolveSession(input.token);
    const now = this.#clock.now();
    const existing = await this.#repository.listDevices(resolved.account.id);
    // Only devices that still work occupy a slot. Counting stored `active` rows
    // instead would let lapsed devices fill the budget permanently, and the
    // account could never remember a new one without an administrator.
    const active = existing.filter((device) => isDeviceUsable(device, now));
    if (active.length >= this.#policy.device.maxPerUser) {
      throw new AuthError(
        'device_limit_reached',
        'the account already has the maximum number of trusted devices',
      );
    }

    const credential = generateDeviceCredential();
    const device: TrustedDevice = {
      id: this.#ids.next('device'),
      userId: resolved.account.id,
      tenantId: resolved.access.tenantId,
      label: input.label.trim(),
      platform: input.platform,
      credentialFingerprint: fingerprintSecret(credential),
      status: 'active',
      idempotencyKey: null,
      trustedAt: now,
      expiresAt: addMilliseconds(now, this.#policy.device.ttlMs),
      lastSeenAt: now,
      revokedAt: null,
      revokedReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#repository.saveDevice(device);
    // The device being enrolled is the one the caller is using right now, so
    // the session that enrolled it becomes bound to it. Revoking the device
    // then reaches that session, which is what makes "revoke this device" mean
    // something more than hiding a row from a list.
    await this.#repository.saveSession({
      ...resolved.session,
      trustedDeviceId: device.id,
      updatedAt: now,
    });
    return { credential, device: toDeviceSummary(device, true, now) };
  }

  /**
   * Devices of the signed-in account, newest first.
   *
   * The status reported is the effective one, so a device whose lifetime has
   * run out reads as `expired` here even though its stored row still says
   * `active`.
   *
   * @param token - Bearer token of the caller.
   * @returns Public device summaries; never a credential or fingerprint.
   */
  async listDevices(token: string): Promise<ReadonlyArray<DeviceSummary>> {
    const resolved = await this.resolveSession(token);
    const now = this.#clock.now();
    const devices = await this.#repository.listDevices(resolved.account.id);
    return devices.map((device) =>
      toDeviceSummary(device, device.id === resolved.session.trustedDeviceId, now),
    );
  }

  /**
   * Revoke one trusted device and every session bound to it.
   *
   * A device that already lapsed is still revocable: revocation is the caller's
   * explicit "forget this", and recording it is more useful than refusing it.
   * Only a device that is already revoked is refused, because that is a genuine
   * contradiction of what the caller asked for.
   *
   * @param token - Bearer token of the caller.
   * @param deviceId - Device to revoke.
   * @returns How many sessions the revocation invalidated.
   * @throws {AuthError} `device_not_found` or `device_revoked`.
   */
  async revokeDevice(token: string, deviceId: string): Promise<{ revokedSessions: number }> {
    const resolved = await this.resolveSession(token);
    const device = await this.#repository.getDevice(deviceId);
    if (device === undefined || device.userId !== resolved.account.id) {
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
      revokedReason: 'user',
      updatedAt: now,
    });

    const bound = await this.#repository.listSessionsForDevice(device.id);
    let revokedSessions = 0;
    for (const session of bound) {
      if (session.status === 'active') {
        await this.#revokeSession(session, 'admin_revoked', now);
        revokedSessions += 1;
      }
    }
    return { revokedSessions };
  }

  // ==========================================================================
  // OIDC identities
  // ==========================================================================

  /**
   * Bind an external OIDC identity to the signed-in account.
   *
   * Binding is refused unless the account already proved a *verified local*
   * credential. Without that rule an attacker could pre-register an account for
   * an address they do not control and then claim the external identity that
   * legitimately belongs to someone else.
   *
   * @param input - Bearer token and authorization code.
   * @returns The bound identity.
   * @throws {AuthError} `identity_unverified`, `identity_conflict` or a
   * provider failure.
   */
  async bindOidc(input: BindOidcInput): Promise<PublicIdentity> {
    const resolved = await this.resolveSession(input.token);
    const identities = await this.#repository.listIdentities(resolved.account.id);
    if (!hasVerifiedLocalCredential(resolved.account, identities)) {
      throw new AuthError(
        'identity_unverified',
        'the account must verify a local credential before an external identity can be bound',
      );
    }

    const claims = await this.#oidcProvider.exchangeCode(
      input.code,
      ...(input.redirectUri === undefined ? [] : [input.redirectUri]),
    );
    const subject = namespacedIdentitySubject(claims.provider, claims.subject);
    const existing = await this.#repository.findIdentity('oidc', subject);
    if (existing !== undefined) {
      if (existing.userId === resolved.account.id) {
        return toPublicIdentity(existing);
      }
      throw new AuthError('identity_conflict', 'the external identity is already bound');
    }

    const identity = await this.#createIdentity({
      userId: resolved.account.id,
      provider: 'oidc',
      subject,
      verified: true,
      now: this.#clock.now(),
    });
    return toPublicIdentity(identity);
  }

  /**
   * Sign in through a bound external OIDC identity.
   *
   * @param input - Authorization code and optional client fingerprint.
   * @returns A signed-in session.
   * @throws {AuthError} `identity_not_found`, `account_disabled`,
   * `account_locked` or a provider failure.
   */
  async loginWithOidc(input: LoginWithOidcInput): Promise<SessionIssueResult> {
    const claims = await this.#oidcProvider.exchangeCode(
      input.code,
      ...(input.redirectUri === undefined ? [] : [input.redirectUri]),
    );
    const identity = await this.#repository.findIdentity(
      'oidc',
      namespacedIdentitySubject(claims.provider, claims.subject),
    );
    if (identity === undefined) {
      throw new AuthError('identity_not_found', 'no account is bound to this external identity');
    }
    const account = await this.#repository.getUser(identity.userId);
    if (account === undefined) {
      throw new AuthError('identity_not_found', 'no account is bound to this external identity');
    }
    this.#assertAccountUsable(account);

    const now = this.#clock.now();
    await this.#repository.saveUser({ ...account, lastLoginAt: now, updatedAt: now });
    return this.#issueSession({
      userId: account.id,
      authMethod: 'sso',
      deviceId: null,
      clientFingerprint: input.clientFingerprint ?? null,
    });
  }

  /**
   * Remove a bound external identity from the signed-in account.
   *
   * The last remaining sign-in credential cannot be removed: doing so would
   * lock the account out permanently.
   *
   * @param input - Bearer token and identity to remove.
   * @returns The removed identity's id.
   * @throws {AuthError} `identity_not_bound` or `identity_last_credential`.
   */
  async unbindOidc(input: UnbindOidcInput): Promise<{ identityId: string }> {
    const resolved = await this.resolveSession(input.token);
    const identity = await this.#repository.getIdentity(input.identityId);
    if (
      identity === undefined ||
      identity.userId !== resolved.account.id ||
      identity.provider !== 'oidc'
    ) {
      throw new AuthError(
        'identity_not_bound',
        'the external identity is not bound to this account',
      );
    }
    const identities = await this.#repository.listIdentities(resolved.account.id);
    const remaining = identities.filter((item) => item.id !== identity.id);
    if (!hasVerifiedLocalCredential({ ...resolved.account, passwordHash: null }, remaining)) {
      throw new AuthError(
        'identity_last_credential',
        'the last remaining sign-in credential cannot be removed',
      );
    }
    await this.#repository.deleteIdentity(identity.id);
    return { identityId: identity.id };
  }

  // ==========================================================================
  // Account center
  // ==========================================================================

  /**
   * The verified phone number of an account, or `null`.
   *
   * Exists for the two surfaces that name the signed-in operator — the session
   * endpoint and the console's own account menu — and for nothing else: it is a
   * contact detail, not an identity assertion, so it is never a way in and never
   * a way to look someone else up.
   *
   * Unverified numbers are skipped rather than returned. A phone identity only
   * proves its owner *once a code has come back from it*, and before that it is
   * a claim the registrant typed. Handing that claim to the UI would put a
   * number on screen under a label ("手机号") that asserts it is theirs.
   *
   * @param userId - Account whose number is wanted.
   * @returns The verified number, or `null` when there is none.
   */
  async verifiedPhone(userId: string): Promise<string | null> {
    const identities = await this.#repository.listIdentities(userId);
    const phone = identities.find(
      (identity) => identity.provider === 'phone' && identity.verified,
    );
    return phone?.subject ?? null;
  }

  /**
   * Build the account-center view for the signed-in account.
   *
   * Reachable in every access state except `disabled`, which is what makes the
   * account center the one surface a `pending_config` account can use.
   *
   * @param token - Bearer token of the caller.
   * @returns Account, identities, access context, directory facts and devices.
   * @throws {AuthError} `access_denied` when the account is disabled.
   */
  async accountCenter(token: string): Promise<AccountCenterView> {
    const resolved = await this.resolveSession(token);
    const access = resolved.access;
    // Read once so every device in the view is judged against the same instant.
    const now = this.#clock.now();
    const identities = await this.#repository.listIdentities(resolved.account.id);
    const sessions = await this.#repository.listSessionsForUser(resolved.account.id);
    const devices = await this.#repository.listDevices(resolved.account.id);
    const tenant =
      access.tenantId === null
        ? null
        : ((await this.#repository.getTenant(access.tenantId)) ?? null);
    const stores =
      access.tenantId === null ? [] : await this.#repository.listStores(access.tenantId);
    const members =
      access.tenantId === null ? [] : await this.#repository.listMembers(access.tenantId);

    return {
      account: toPublicAccount(resolved.account),
      identities: identities.map(toPublicIdentity),
      access,
      tenant,
      stores,
      members,
      sessions: sessions.map((session) =>
        toSessionSummary(session, session.id === resolved.session.id),
      ),
      devices: devices.map((device) =>
        toDeviceSummary(device, device.id === resolved.session.trustedDeviceId, now),
      ),
    };
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /** Verify and consume one challenge, enforcing expiry, attempts and replay. */
  async #consumeOtp(input: {
    readonly subject: string;
    readonly purpose: OtpPurpose;
    readonly code: string;
    readonly channel?: OtpChannel;
  }): Promise<OtpChallenge> {
    const now = this.#clock.now();
    const challenge = await this.#repository.findPendingOtp(input.subject, input.purpose);
    if (challenge === undefined) {
      // No live challenge. Report why the most recent one is gone, so replaying
      // a code reads as "already used" or "expired" rather than a vague miss.
      const recent = await this.#repository.listOtpsSince(
        input.subject,
        input.purpose,
        addMilliseconds(now, -this.#policy.otp.windowMs),
      );
      const previous = recent[recent.length - 1];
      if (previous !== undefined && previous.status !== 'pending') {
        throw otpUnusableError(previous, now);
      }
      throw new AuthError('otp_not_found', 'no one-time code was issued for this destination');
    }
    if (input.channel !== undefined && challenge.channel !== input.channel) {
      throw new AuthError('otp_invalid', 'the one-time code was issued for a different channel');
    }

    const expired = expireOtpIfElapsed(challenge, now);
    if (expired !== challenge) {
      await this.#repository.saveOtp(expired);
      throw otpUnusableError(challenge, now);
    }
    if (!isOtpUsable(challenge, now)) {
      throw otpUnusableError(challenge, now);
    }

    if (!verifyOtpCode(challenge.id, input.code.trim(), challenge.codeHash)) {
      const failedAttempts = challenge.failedAttempts + 1;
      const exhausted = failedAttempts >= challenge.maxAttempts;
      await this.#repository.saveOtp({
        ...challenge,
        failedAttempts,
        status: exhausted ? 'revoked' : 'pending',
        revokedAt: exhausted ? now : null,
        updatedAt: now,
      });
      throw new AuthError('otp_invalid', 'the one-time code is not correct');
    }

    const consumed: OtpChallenge = {
      ...challenge,
      status: 'consumed',
      consumedAt: now,
      updatedAt: now,
    };
    await this.#repository.saveOtp(consumed);
    return consumed;
  }

  /** Resolve the account a destination belongs to, when one exists. */
  async #resolveUserForSubject(
    channel: OtpChannel,
    subject: string,
  ): Promise<UserAccount | undefined> {
    if (channel === 'sms') {
      const identity = await this.#repository.findIdentity('phone', subject);
      return identity === undefined ? undefined : this.#repository.getUser(identity.userId);
    }
    // The schema has no email identity provider, so an email destination is
    // matched against the account's username (the common "email as login" shape).
    return this.#repository.findUserByUsername(subject);
  }

  /** Create an identity row, rejecting a duplicate provider/subject pair. */
  async #createIdentity(input: {
    readonly userId: string;
    readonly provider: AuthProvider;
    readonly subject: string;
    readonly verified: boolean;
    readonly now: string;
  }): Promise<UserIdentity> {
    const existing = await this.#repository.findIdentity(input.provider, input.subject);
    if (existing !== undefined) {
      if (existing.userId === input.userId) {
        return existing;
      }
      throw new AuthError('identity_conflict', 'the identity is already bound to another account');
    }
    const identity: UserIdentity = {
      id: this.#ids.next('identity'),
      userId: input.userId,
      provider: input.provider,
      subject: input.subject,
      verified: input.verified,
      verifiedAt: input.verified ? input.now : null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    await this.#repository.saveIdentity(identity);
    return identity;
  }

  /** Throw unless an account may sign in right now. */
  #assertAccountUsable(account: UserAccount): void {
    if (account.status === 'disabled') {
      throw new AuthError('account_disabled', 'the account is disabled');
    }
    const now = this.#clock.now();
    if (
      account.status === 'locked' &&
      account.lockedUntil !== null &&
      Date.parse(account.lockedUntil) > Date.parse(now)
    ) {
      throw new AuthError('account_locked', 'the account is temporarily locked');
    }
  }

  /** Issue a session and resolve the access context it starts in. */
  async #issueSession(input: {
    readonly userId: string;
    readonly authMethod: SessionAuthMethod;
    readonly deviceId: string | null;
    readonly clientFingerprint: string | null;
  }): Promise<SessionIssueResult> {
    const now = this.#clock.now();
    const links = await this.#repository.listActiveLinksForUser(input.userId);
    const link = links[0];

    await this.#enforceSessionBudget(input.userId, now);

    const token = generateSessionToken();
    const session: AuthSession = {
      id: this.#ids.next('session'),
      userId: input.userId,
      tenantId: link?.tenantId ?? null,
      memberId: link?.memberId ?? null,
      trustedDeviceId: input.deviceId,
      tokenFingerprint: fingerprintSecret(token),
      previousTokenFingerprint: null,
      rotationFamilyId: this.#ids.next('family'),
      authMethod: input.authMethod,
      status: 'active',
      mfaSatisfied: input.authMethod === 'otp' || input.authMethod === 'trusted_device',
      clientFingerprint:
        input.clientFingerprint === null ? null : fingerprintSecret(input.clientFingerprint),
      idempotencyKey: null,
      issuedAt: now,
      expiresAt: addMilliseconds(now, this.#policy.session.ttlMs),
      lastSeenAt: now,
      revokedAt: null,
      revokedReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#repository.saveSession(session);

    const account = await this.#repository.getUser(input.userId);
    if (account === undefined) {
      throw new AuthError('session_invalid', 'the session account no longer exists');
    }
    return { token, session, access: await this.#buildAccessContext(account, session) };
  }

  /** Revoke the oldest active sessions until the account is inside its budget. */
  async #enforceSessionBudget(userId: string, now: string): Promise<void> {
    const sessions = await this.#repository.listSessionsForUser(userId);
    const active = sessions.filter((session) => session.status === 'active');
    const excess = active.length - this.#policy.maxActiveSessionsPerUser + 1;
    if (excess <= 0) {
      return;
    }
    // `listSessionsForUser` is newest first, so the tail holds the oldest.
    for (const session of active.slice(-excess)) {
      await this.#revokeSession(session, 'admin_revoked', now);
    }
  }

  /** Build the access context of one session. */
  async #buildAccessContext(account: UserAccount, session: AuthSession): Promise<AccessContext> {
    const links = await this.#repository.listActiveLinksForUser(account.id);
    const link: MemberUserLink | undefined =
      links.find((candidate) => candidate.memberId === session.memberId) ?? links[0];

    let member: Member | undefined;
    if (link !== undefined) {
      const candidate = await this.#repository.getMember(link.memberId);
      if (
        candidate !== undefined &&
        candidate.id === link.memberId &&
        (candidate.tenantId === null || candidate.tenantId === link.tenantId)
      ) {
        member = candidate;
      }
    }

    const tenantId = member?.tenantId ?? null;
    const tenant: Tenant | null =
      tenantId === null ? null : ((await this.#repository.getTenant(tenantId)) ?? null);
    const storeScopes =
      member === undefined || tenantId === null
        ? []
        : await this.#repository.listActiveStoreScopes(tenantId, member.id);
    const tenantStores = tenantId === null ? [] : await this.#repository.listStores(tenantId);

    const input: AccessResolutionInput = {
      session,
      accountStatus: account.status,
      member: member ?? null,
      tenant,
      link: member === undefined ? undefined : link,
      storeScopes,
      tenantStores,
    };
    return buildAccessContext(input);
  }

  /** Touch a session's `last_seen_at` at most once per interval. */
  #touchSession(session: AuthSession, now: string): AuthSession {
    if (Date.parse(now) - Date.parse(session.lastSeenAt) < this.#policy.session.touchIntervalMs) {
      return session;
    }
    return { ...session, lastSeenAt: now, updatedAt: now };
  }

  /** Revoke one session. */
  async #revokeSession(
    session: AuthSession,
    reason: SessionRevokedReason,
    now: string,
  ): Promise<void> {
    if (session.status !== 'active') {
      return;
    }
    await this.#repository.saveSession({
      ...session,
      status: 'revoked',
      revokedAt: now,
      revokedReason: reason,
      updatedAt: now,
    });
  }

  /** Revoke every active session of an account and report how many. */
  async #revokeSessionsForUser(
    userId: string,
    reason: SessionRevokedReason,
    now: string,
  ): Promise<number> {
    const sessions = await this.#repository.listSessionsForUser(userId);
    let revoked = 0;
    for (const session of sessions) {
      if (session.status === 'active') {
        await this.#revokeSession(session, reason, now);
        revoked += 1;
      }
    }
    return revoked;
  }

  /**
   * Match a presented device credential to a live device of one account.
   *
   * Returns `null` — never an error — for a credential that is unknown, belongs
   * to a different account, is revoked, or has lapsed, because in every one of
   * those cases the answer to "is this device remembered?" is simply no. A
   * credential that does belong to a live device has its `last_seen_at` moved
   * forward, which is the only write a sign-in performs on it.
   *
   * The repository lookup is the point of the whole mechanism: it is what makes
   * a revocation effective on the next attempt instead of only hiding a row
   * from a list.
   *
   * @param credential - Raw credential presented by the client, if any.
   * @param userId - Account the credential would have to belong to.
   * @param now - Current instant.
   * @returns The matching live device, or `null`.
   */
  async #resolveTrustedDevice(
    credential: string | undefined,
    userId: string,
    now: string,
  ): Promise<TrustedDevice | null> {
    if (credential === undefined || credential.trim() === '') {
      return null;
    }
    const device = await this.#repository.findDeviceByFingerprint(fingerprintSecret(credential));
    if (device === undefined || device.userId !== userId || !isDeviceUsable(device, now)) {
      return null;
    }
    await this.#repository.saveDevice({ ...device, lastSeenAt: now, updatedAt: now });
    return device;
  }

  /** Revoke every live device of an account and report how many. */
  async #revokeDevicesForUser(
    userId: string,
    reason: DeviceRevokedReason,
    now: string,
  ): Promise<number> {
    const devices = await this.#repository.listDevices(userId);
    let revoked = 0;
    for (const device of devices) {
      // Devices that already lapsed are left as they are: they grant nothing, so
      // stamping them revoked would only inflate the count the caller reports.
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

  /** Revoke every pending challenge for a destination. */
  async #revokeOutstandingChallenges(subject: string, now: string): Promise<void> {
    const since = addMilliseconds(now, -this.#policy.otp.windowMs);
    for (const purpose of ['sign_in', 'recover', 'bind_identity', 'rebind_identity'] as const) {
      const challenges = await this.#repository.listOtpsSince(subject, purpose, since);
      for (const challenge of challenges) {
        if (challenge.status === 'pending') {
          await this.#repository.saveOtp({
            ...challenge,
            status: 'revoked',
            revokedAt: now,
            updatedAt: now,
          });
        }
      }
    }
  }
}

/** Normalise a destination or username for comparison and storage. */
function normalizeSubject(value: string): string {
  return value.trim();
}

/** Whether an account proved a verified local credential. */
function hasVerifiedLocalCredential(
  account: UserAccount,
  identities: ReadonlyArray<UserIdentity>,
): boolean {
  if (
    account.passwordHash !== null &&
    identities.some((identity) => identity.provider === 'password')
  ) {
    return true;
  }
  return identities.some(
    (identity) =>
      identity.verified && (identity.provider === 'password' || identity.provider === 'phone'),
  );
}

/** Project an account into its public shape. */
function toPublicAccount(account: UserAccount): PublicAccount {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    status: account.status,
    passwordConfigured: account.passwordHash !== null,
    passwordUpdatedAt: account.passwordUpdatedAt,
    lastLoginAt: account.lastLoginAt,
    avatarUrl: account.avatarUrl,
    createdAt: account.createdAt,
  };
}

/** Project an identity into its public shape. */
function toPublicIdentity(identity: UserIdentity): PublicIdentity {
  return {
    id: identity.id,
    provider: identity.provider,
    subject: identity.subject,
    verified: identity.verified,
    verifiedAt: identity.verifiedAt,
    createdAt: identity.createdAt,
  };
}

/** Project a session into its public shape. */
function toSessionSummary(session: AuthSession, current: boolean): SessionSummary {
  return {
    id: session.id,
    authMethod: session.authMethod,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    memberId: session.memberId,
    tenantId: session.tenantId,
    current,
  };
}

/** Project a device into its public shape. */
function toDeviceSummary(device: TrustedDevice, current: boolean, now: string): DeviceSummary {
  return {
    id: device.id,
    label: device.label,
    platform: device.platform,
    status: effectiveDeviceStatus(device, now),
    trustedAt: device.trustedAt,
    lastSeenAt: device.lastSeenAt,
    expiresAt: device.expiresAt,
    revokedAt: device.revokedAt,
    current,
  };
}
