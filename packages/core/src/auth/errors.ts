/**
 * Stable authentication error contract.
 *
 * Authentication failures cross the HTTP boundary as the platform's existing
 * `{ request_id, code, message, details }` envelope, so this module maps a
 * domain failure code onto one of the platform's stable `ApiErrorCode` values.
 * The domain code stays available to callers and tests, while the message a
 * client sees is always the generic reason for that HTTP status — the filter in
 * `apps/api` owns that projection, so no credential detail can leak.
 */

import type { ApiErrorCode } from '../error-body';

/** Machine-readable authentication failure codes. */
export type AuthErrorCode =
  | 'invalid_request'
  | 'invalid_credentials'
  | 'account_locked'
  | 'account_disabled'
  | 'account_not_active'
  | 'username_taken'
  | 'password_not_set'
  | 'password_too_weak'
  | 'password_reuse'
  | 'password_mismatch'
  | 'avatar_invalid'
  | 'identity_conflict'
  | 'identity_not_found'
  | 'identity_not_bound'
  | 'identity_unverified'
  | 'identity_last_credential'
  | 'otp_not_found'
  | 'otp_invalid'
  | 'otp_expired'
  | 'otp_consumed'
  | 'otp_attempts_exceeded'
  | 'otp_rate_limited'
  | 'otp_resend_too_soon'
  | 'session_invalid'
  | 'session_expired'
  | 'session_revoked'
  | 'session_reuse_detected'
  | 'device_not_found'
  | 'device_revoked'
  | 'device_limit_reached'
  | 'provider_not_configured'
  | 'provider_error'
  | 'identity_source_forbidden'
  | 'access_denied'
  | 'pending_config'
  | 'idempotency_conflict';

/** HTTP status a domain failure is projected onto. */
export type AuthErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 503;

const STATUS_BY_CODE: Readonly<Record<AuthErrorCode, AuthErrorStatus>> = Object.freeze({
  // Authentication failures are 401: the caller is not authenticated.
  invalid_request: 400,
  invalid_credentials: 401,
  account_locked: 401,
  account_disabled: 403,
  account_not_active: 403,
  username_taken: 409,
  password_not_set: 400,
  password_too_weak: 400,
  password_reuse: 400,
  // Deliberately 400 and not 401: the caller *is* authenticated — they are
  // changing their own password through a live session — and the one thing that
  // was wrong is the string they typed into "current password". A 401 here would
  // tell every client to treat a typo as an expired session and sign the
  // operator out of the page they are standing on.
  password_mismatch: 400,
  // One code for every reason an avatar was refused — too long, not a data URL,
  // a media type off the allow-list, bytes that are not what they claim. A
  // caller cannot act differently on any of them: the picture it drew is not
  // one the platform will keep, and the console rules all four out before it
  // sends, so the only one that ever reaches a client is a hand-made request.
  avatar_invalid: 400,
  identity_conflict: 409,
  identity_not_found: 401,
  identity_not_bound: 404,
  identity_unverified: 403,
  identity_last_credential: 409,
  // Every one-time-code verification failure is an authentication failure: in
  // each flow that consumes a code the caller is asserting an identity, and a
  // distinct status for "no code was ever issued" would tell an attacker which
  // destinations the platform has challenged.
  otp_not_found: 401,
  otp_invalid: 401,
  otp_expired: 401,
  otp_consumed: 409,
  otp_attempts_exceeded: 401,
  otp_rate_limited: 429,
  otp_resend_too_soon: 429,
  session_invalid: 401,
  session_expired: 401,
  session_revoked: 401,
  session_reuse_detected: 401,
  device_not_found: 404,
  device_revoked: 409,
  device_limit_reached: 409,
  provider_not_configured: 503,
  provider_error: 503,
  identity_source_forbidden: 403,
  access_denied: 403,
  pending_config: 403,
  idempotency_conflict: 409,
});

/**
 * An authentication/authorization failure with a stable domain code.
 *
 * The optional `details` are for server-side diagnostics and tests; the HTTP
 * filter projects them through the same sanitiser as every other error, so a
 * caller-supplied value can never turn into a leaked credential.
 */
export class AuthError extends Error {
  readonly _tag = 'auth_error' as const;

  /**
   * @param code - Stable machine-readable failure code.
   * @param message - Safe, non-secret description for logs and tests.
   * @param details - Optional non-secret diagnostic details.
   */
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly details: ReadonlyArray<unknown> = [],
  ) {
    super(message);
    this.name = 'AuthError';
  }

  /** HTTP status this failure is projected onto. */
  get status(): AuthErrorStatus {
    return STATUS_BY_CODE[this.code];
  }

  /** Platform-level stable error code for this failure. */
  get apiCode(): ApiErrorCode {
    // 锁定单独成一个码，不跟着状态码降级：密码可能是对的，只是这段时间内一律
    // 拒绝收下。合成 `unauthorized` 会把「等一会儿再试」说成「凭据不对」，而这
    // 正是操作者以为密码或账号坏了的原因。
    if (this.code === 'account_locked') {
      return 'account_locked';
    }
    switch (this.status) {
      case 400:
        return 'bad_request';
      case 401:
        return 'unauthorized';
      case 403:
        return 'forbidden';
      case 404:
        return 'not_found';
      case 409:
        return 'conflict';
      case 429:
        return 'too_many_requests';
      case 503:
        return 'service_unavailable';
      default:
        return 'internal_error';
    }
  }
}

/**
 * Check whether a value is an {@link AuthError}.
 *
 * @param value - Value to inspect.
 * @returns `true` when the value carries a stable auth failure code.
 */
export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}
