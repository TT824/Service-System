/**
 * One-time code generation, hashing and lifecycle rules.
 *
 * A code is generated from the CSPRNG, delivered by a provider, and persisted
 * only as `sha256(<challenge id>:<code>)`. The challenge id is the per-row salt:
 * it is already unique and non-secret, so no extra salt column is needed and a
 * code cannot be replayed against a different challenge.
 *
 * Every lifecycle decision is a pure function of the challenge and "now", so
 * expiry, attempt limits and replay prevention are unit-testable without a
 * database or a sleeping test.
 */

import { createHash, randomInt } from 'node:crypto';
import { AuthError } from './errors';
import { safeEqualFingerprint } from './token';
import type { OtpChallenge } from './types';

/** Digest algorithm recorded in `otp_challenges.code_algorithm`. */
export const OTP_CODE_ALGORITHM = 'sha256';

/** Number of digits in an issued code. */
export const OTP_CODE_LENGTH = 6;

/** Largest code value, bounding the CSPRNG range. */
const OTP_CODE_MAX = 10 ** OTP_CODE_LENGTH;

/**
 * Issue a new one-time code.
 *
 * Uses `randomInt`, which draws from the CSPRNG with rejection sampling, so
 * every code in the range is equally likely.
 *
 * @returns A zero-padded numeric code.
 */
export function generateOtpCode(): string {
  return String(randomInt(0, OTP_CODE_MAX)).padStart(OTP_CODE_LENGTH, '0');
}

/**
 * Hash a code for storage.
 *
 * @param challengeId - The challenge the code belongs to; used as the salt.
 * @param code - The plaintext code.
 * @returns A 64-character hexadecimal digest.
 */
export function hashOtpCode(challengeId: string, code: string): string {
  return createHash('sha256').update(`${challengeId}:${code}`, 'utf8').digest('hex');
}

/**
 * Verify a submitted code against a stored hash.
 *
 * @param challengeId - The challenge the code belongs to.
 * @param code - The submitted code.
 * @param codeHash - The stored hash.
 * @returns `true` when the code matches.
 */
export function verifyOtpCode(challengeId: string, code: string, codeHash: string): boolean {
  return safeEqualFingerprint(hashOtpCode(challengeId, code), codeHash);
}

/**
 * Check whether a challenge is past its expiry.
 *
 * @param challenge - The challenge to inspect.
 * @param nowIso - Current instant.
 * @returns `true` when the challenge can no longer be used.
 */
export function isOtpExpired(challenge: OtpChallenge, nowIso: string): boolean {
  return Date.parse(challenge.expiresAt) <= Date.parse(nowIso);
}

/**
 * Check whether a challenge may still be verified.
 *
 * A challenge is usable only while it is pending, unexpired and has attempts
 * left. Replay is therefore impossible by construction: `consumed` and
 * `revoked` are terminal, and a verified challenge is moved to `consumed` in
 * the same write that accepts the code.
 *
 * @param challenge - The challenge to inspect.
 * @param nowIso - Current instant.
 * @returns `true` when a code may still be submitted.
 */
export function isOtpUsable(challenge: OtpChallenge, nowIso: string): boolean {
  if (challenge.status !== 'pending') {
    return false;
  }
  if (isOtpExpired(challenge, nowIso)) {
    return false;
  }
  return challenge.failedAttempts < challenge.maxAttempts;
}

/**
 * Describe why a challenge cannot be used, as the failure to raise.
 *
 * @param challenge - The challenge that was inspected.
 * @param nowIso - Current instant.
 * @returns The stable failure the caller should throw.
 */
export function otpUnusableError(challenge: OtpChallenge, nowIso: string): AuthError {
  if (challenge.status === 'consumed') {
    return new AuthError('otp_consumed', 'the one-time code has already been used');
  }
  if (challenge.status === 'revoked') {
    return new AuthError('otp_expired', 'the one-time code is no longer valid');
  }
  if (isOtpExpired(challenge, nowIso)) {
    return new AuthError('otp_expired', 'the one-time code has expired');
  }
  return new AuthError('otp_attempts_exceeded', 'too many failed one-time code attempts');
}

/**
 * Expire a challenge if its window has closed.
 *
 * @param challenge - The challenge to advance.
 * @param nowIso - Current instant.
 * @returns The challenge, moved to `expired` when its window closed.
 */
export function expireOtpIfElapsed(challenge: OtpChallenge, nowIso: string): OtpChallenge {
  if (challenge.status !== 'pending' || !isOtpExpired(challenge, nowIso)) {
    return challenge;
  }
  return {
    ...challenge,
    status: 'expired',
    revokedAt: nowIso,
    updatedAt: nowIso,
  };
}
