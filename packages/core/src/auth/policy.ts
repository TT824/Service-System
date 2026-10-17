/**
 * Authentication policy: lifetimes, limits, lockout and access-state rules.
 *
 * Keeping the numbers in one frozen value means the OTP window a challenge is
 * created with, the window the verifier checks and the window a test advances
 * a clock past can never drift apart. The access-state rules are pure
 * functions so the `pending_config` boundary is testable on its own.
 */

import type { AccessState, AccountStatus, DeviceStatus, TrustedDevice, UserAccount } from './types';

/** One-time code policy. */
export type OtpPolicy = {
  /** Code lifetime in milliseconds. */
  readonly ttlMs: number;
  /** Failed verification attempts allowed before the challenge is burned. */
  readonly maxAttempts: number;
  /** Codes a single subject may request inside {@link windowMs}. */
  readonly maxSendsPerWindow: number;
  /** Rolling window the send budget is counted over. */
  readonly windowMs: number;
  /** Minimum delay between two sends to the same subject. */
  readonly resendCooldownMs: number;
};

/** Password sign-in policy. */
export type PasswordPolicy = {
  /** Consecutive failures before the account is locked. */
  readonly maxFailedLogins: number;
  /** How long a locked account stays locked. */
  readonly lockMs: number;
};

/** Session policy. */
export type SessionPolicy = {
  /** Bearer session lifetime. */
  readonly ttlMs: number;
  /**
   * Minimum delay between two `last_seen_at` writes of one session.
   *
   * A read-only request would otherwise write a row every time it resolves a
   * token; at this interval the column stays useful without turning every
   * authorised request into a write.
   */
  readonly touchIntervalMs: number;
};

/** Trusted device policy. */
export type DevicePolicy = {
  /** How long a remembered device stays trusted. */
  readonly ttlMs: number;
  /** Devices one account may keep enrolled. */
  readonly maxPerUser: number;
};

/** Complete authentication policy. */
export type AuthPolicy = {
  readonly otp: OtpPolicy;
  readonly password: PasswordPolicy;
  readonly session: SessionPolicy;
  readonly device: DevicePolicy;
  /** Maximum number of parallel bearer sessions per account. */
  readonly maxActiveSessionsPerUser: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Documented default policy, shared by every environment unless overridden. */
export const DEFAULT_AUTH_POLICY: AuthPolicy = Object.freeze({
  otp: Object.freeze({
    ttlMs: 5 * MINUTE,
    maxAttempts: 5,
    maxSendsPerWindow: 3,
    windowMs: 15 * MINUTE,
    resendCooldownMs: MINUTE,
  }),
  password: Object.freeze({
    // Three strikes, not five: this is a self-hosted deployment reached by a
    // handful of known staff, and a five-attempt budget mostly locked out the
    // person who mistyped, not an attacker. The counter is still cleared by a
    // successful sign-in — see `loginWithPassword`.
    maxFailedLogins: 3,
    lockMs: 15 * MINUTE,
  }),
  session: Object.freeze({
    ttlMs: 12 * HOUR,
    touchIntervalMs: MINUTE,
  }),
  device: Object.freeze({
    ttlMs: 30 * DAY,
    maxPerUser: 10,
  }),
  maxActiveSessionsPerUser: 20,
});

/**
 * The status a stored trusted device really has right now.
 *
 * Expiry is a read-time fact, not a stored one: no sweep ever rewrites a row
 * whose `expires_at` has passed, so a lapsed device is still `active` on disk
 * and only reads as `expired` here. This is the same shape as agent presence in
 * `platform/assignment.ts` — the record carries the instant, the reader decides
 * whether it still counts — which is why there is no expiry job to run.
 *
 * A device expires *at* its `expiresAt` instant, so `expiresAt === now` is
 * already expired. A `null` `expiresAt` never lapses on its own, but revocation
 * still applies to it.
 *
 * @param device - Stored device fields that decide liveness.
 * @param nowIso - Current instant.
 * @returns `revoked` or `expired` when the device is past use, else `active`.
 */
export function effectiveDeviceStatus(
  device: Pick<TrustedDevice, 'status' | 'expiresAt'>,
  nowIso: string,
): DeviceStatus {
  if (device.status !== 'active') {
    // `revoked` and `expired` are terminal, and `revoked` outranks `expired`:
    // a device that was both revoked and left to lapse stays revoked, because
    // that is why it stopped being trusted.
    return device.status;
  }
  if (device.expiresAt === null) {
    return 'active';
  }
  return Date.parse(device.expiresAt) <= Date.parse(nowIso) ? 'expired' : 'active';
}

/**
 * Whether a device credential presented by a client still grants trust.
 *
 * @param device - Stored device fields that decide liveness.
 * @param nowIso - Current instant.
 * @returns `true` only while the device is neither revoked nor expired.
 */
export function isDeviceUsable(
  device: Pick<TrustedDevice, 'status' | 'expiresAt'>,
  nowIso: string,
): boolean {
  return effectiveDeviceStatus(device, nowIso) === 'active';
}

/**
 * The status an account really has right now.
 *
 * A lock is a read-time fact, exactly like device expiry above: nothing sweeps
 * the table when `locked_until` passes, so the row keeps reading `locked` until
 * the next *successful* sign-in rewrites it to `active`. Taking that stored value
 * verbatim would keep a session that is already signed in out of every business
 * surface long after the lock lapsed, which contradicts the rule
 * {@link deriveAccessState} states for it — a locked account cannot act "until
 * the lock expires". A lock therefore holds only while its instant is still
 * ahead.
 *
 * A `locked` row with no instant is treated as unlocked, matching the sign-in
 * check, which refuses to lock an account it cannot date.
 *
 * @param account - Stored account fields that decide usability.
 * @param nowIso - Current instant.
 * @returns `locked` while the lock holds, `active` once it has lapsed, and every
 * other stored status unchanged.
 */
export function effectiveAccountStatus(
  account: Pick<UserAccount, 'status' | 'lockedUntil'>,
  nowIso: string,
): AccountStatus {
  if (account.status !== 'locked') {
    return account.status;
  }
  if (account.lockedUntil === null) {
    return 'active';
  }
  return Date.parse(account.lockedUntil) > Date.parse(nowIso) ? 'locked' : 'active';
}

/** Facts the access state is derived from. */
export type AccessStateInput = {
  readonly accountStatus: AccountStatus;
  /**
   * Whether the acting member is enabled; `null` when the session does not act
   * through a member at all (a freshly registered account).
   */
  readonly memberEnabled: boolean | null;
  /** `null` when the acting member is a platform member without a tenant. */
  readonly tenantEnabled: boolean | null;
  /** Whether the account has an unrevoked link to the acting member. */
  readonly hasActiveMemberLink: boolean;
};

/**
 * Derive the effective access state of a session.
 *
 * `pending_config` is the state of an account that authenticated successfully
 * but whose tenant/member configuration is not usable yet: a freshly
 * registered account, an account whose member link was revoked, or a member
 * whose tenant was disabled. Such a session may reach the account center but
 * must not read tenant business data.
 *
 * @param input - Account, member and tenant facts.
 * @returns The effective access state.
 */
export function deriveAccessState(input: AccessStateInput): AccessState {
  if (input.accountStatus === 'disabled') {
    return 'disabled';
  }
  if (input.accountStatus === 'locked') {
    // A locked account cannot act at all until the lock expires.
    return 'disabled';
  }
  if (input.accountStatus === 'pending') {
    return 'pending_config';
  }
  if (input.memberEnabled === false) {
    return 'disabled';
  }
  if (input.memberEnabled === null || !input.hasActiveMemberLink) {
    return 'pending_config';
  }
  if (input.tenantEnabled === false) {
    return 'pending_config';
  }
  return 'active';
}

/**
 * Whether the access state may reach the account center.
 *
 * @param state - Effective access state.
 * @returns `true` for every state except `disabled`.
 */
export function allowsAccountCenter(state: AccessState): boolean {
  return state !== 'disabled';
}

/**
 * Whether the access state may reach tenant business data.
 *
 * @param state - Effective access state.
 * @returns `true` only for `active`.
 */
export function allowsBusinessData(state: AccessState): boolean {
  return state === 'active';
}

/**
 * Count how many timestamps fall inside a rolling window.
 *
 * @param timestamps - Instants to test.
 * @param nowIso - Current instant.
 * @param windowMs - Window length in milliseconds.
 * @returns The number of instants inside `(now - windowMs, now]`.
 */
export function countWithinWindow(
  timestamps: ReadonlyArray<string>,
  nowIso: string,
  windowMs: number,
): number {
  const now = Date.parse(nowIso);
  const floor = now - windowMs;
  return timestamps.filter((instant) => {
    const value = Date.parse(instant);
    return value > floor && value <= now;
  }).length;
}

/**
 * Whether a rolling send budget is exhausted.
 *
 * @param timestamps - Instants of previous sends.
 * @param nowIso - Current instant.
 * @param policy - One-time code policy.
 * @returns `true` when another send must be refused.
 */
export function isOtpSendRateLimited(
  timestamps: ReadonlyArray<string>,
  nowIso: string,
  policy: OtpPolicy,
): boolean {
  return countWithinWindow(timestamps, nowIso, policy.windowMs) >= policy.maxSendsPerWindow;
}

/**
 * Whether the resend cooldown is still active.
 *
 * @param timestamps - Instants of previous sends.
 * @param nowIso - Current instant.
 * @param policy - One-time code policy.
 * @returns `true` when a new send must wait.
 */
export function isOtpResendCoolingDown(
  timestamps: ReadonlyArray<string>,
  nowIso: string,
  policy: OtpPolicy,
): boolean {
  const latest = latestInstant(timestamps);
  if (latest === undefined) {
    return false;
  }
  return Date.parse(nowIso) - Date.parse(latest) < policy.resendCooldownMs;
}

/**
 * Add a duration to an instant.
 *
 * @param instantIso - Base instant.
 * @param durationMs - Duration in milliseconds.
 * @returns The resulting instant as an ISO-8601 string.
 */
export function addMilliseconds(instantIso: string, durationMs: number): string {
  return new Date(Date.parse(instantIso) + durationMs).toISOString();
}

/** Most recent instant in a list, if any. */
export function latestInstant(timestamps: ReadonlyArray<string>): string | undefined {
  let latest: string | undefined;
  for (const instant of timestamps) {
    if (latest === undefined || Date.parse(instant) > Date.parse(latest)) {
      latest = instant;
    }
  }
  return latest;
}
