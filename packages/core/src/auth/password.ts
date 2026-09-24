/**
 * Password hashing.
 *
 * Passwords are hashed with Node's `scrypt` key-derivation function and stored
 * in a self-describing encoded string; the raw password never leaves this
 * module. The encoded form carries its own cost parameters so a future
 * parameter change can be rolled out by re-hashing on the next successful
 * sign-in without invalidating existing credentials.
 *
 * Encoded format: `scrypt$N=<n>,r=<r>,p=<p>$<salt-base64url>$<hash-base64url>`.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AuthError } from './errors';

/** scrypt cost parameters used for new passwords. */
export type ScryptParams = {
  /** CPU/memory cost (must be a power of two). */
  readonly n: number;
  /** Block size. */
  readonly r: number;
  /** Parallelisation factor. */
  readonly p: number;
  /** Derived key length in bytes. */
  readonly keyLength: number;
};

/**
 * Default cost parameters.
 *
 * `N=16384, r=8, p=1` needs about 16 MiB per hash, which stays inside Node's
 * default `maxmem` while remaining expensive enough to make offline guessing
 * unattractive for a customer-service console.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = Object.freeze({
  n: 16_384,
  r: 8,
  p: 1,
  keyLength: 64,
});

/** Number of random salt bytes mixed into every hash. */
export const PASSWORD_SALT_BYTES = 16;

/** Minimum accepted password length for a new or reset password. */
export const PASSWORD_MIN_LENGTH = 10;

/** Maximum accepted password length, bounding scrypt work per request. */
export const PASSWORD_MAX_LENGTH = 200;

/** Algorithm tag written into every encoded hash. */
export const PASSWORD_ALGORITHM = 'scrypt';

/**
 * Hash a password into its storable encoded form.
 *
 * @param plain - The raw password. Never stored and never logged.
 * @param params - Cost parameters; defaults to {@link DEFAULT_SCRYPT_PARAMS}.
 * @param salt - Deterministic salt for tests; defaults to a random salt.
 * @returns The encoded hash, safe to persist.
 */
export function hashPassword(
  plain: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
  salt?: Buffer,
): string {
  const effectiveSalt = salt ?? randomBytes(PASSWORD_SALT_BYTES);
  const derived = scryptSync(plain, effectiveSalt, params.keyLength, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: maxMemoryFor(params),
  });
  return [
    PASSWORD_ALGORITHM,
    `N=${params.n},r=${params.r},p=${params.p}`,
    effectiveSalt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Verify a password against an encoded hash.
 *
 * Any malformed or unsupported encoding is a failed verification, never a
 * thrown error: a corrupt row must not turn into a distinguishable response.
 *
 * @param plain - The candidate password.
 * @param encoded - The stored encoded hash.
 * @returns `true` when the password matches.
 */
export function verifyPassword(plain: string, encoded: string): boolean {
  const parsed = parseEncodedPassword(encoded);
  if (parsed === undefined) {
    return false;
  }
  const derived = scryptSync(plain, parsed.salt, parsed.hash.length, {
    N: parsed.params.n,
    r: parsed.params.r,
    p: parsed.params.p,
    maxmem: maxMemoryFor(parsed.params),
  });
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * Reject a password that cannot be stored as a credential.
 *
 * @param plain - The candidate password.
 * @throws {AuthError} `password_too_weak` when the password is unusable.
 */
export function assertPasswordStrength(plain: string): void {
  if (plain.length < PASSWORD_MIN_LENGTH || plain.length > PASSWORD_MAX_LENGTH) {
    throw new AuthError(
      'password_too_weak',
      `password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  if (plain.trim().length === 0) {
    // A password made only of whitespace meets the length bound but is both
    // trivially guessable and impossible to type reliably.
    throw new AuthError('password_too_weak', 'password must not be blank');
  }
}

/** Decoded parts of an encoded password hash. */
type ParsedEncodedPassword = {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly hash: Buffer;
};

function parseEncodedPassword(encoded: string): ParsedEncodedPassword | undefined {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_ALGORITHM) {
    return undefined;
  }
  const params = parseParamList(parts[1] ?? '');
  if (params === undefined) {
    return undefined;
  }
  const salt = decodeBase64Url(parts[2] ?? '');
  const hash = decodeBase64Url(parts[3] ?? '');
  if (salt === undefined || hash === undefined || hash.length !== params.keyLength) {
    return undefined;
  }
  return { params, salt, hash };
}

function parseParamList(raw: string): ScryptParams | undefined {
  const entries = new Map<string, number>();
  for (const pair of raw.split(',')) {
    const [key, value] = pair.split('=');
    if (key === undefined || value === undefined) {
      return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return undefined;
    }
    entries.set(key, parsed);
  }
  const n = entries.get('N');
  const r = entries.get('r');
  const p = entries.get('p');
  if (n === undefined || r === undefined || p === undefined) {
    return undefined;
  }
  if ((n & (n - 1)) !== 0 || n < 2) {
    return undefined;
  }
  return { n, r, p, keyLength: DEFAULT_SCRYPT_PARAMS.keyLength };
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (value.length === 0) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 0 ? undefined : decoded;
  } catch {
    return undefined;
  }
}

/**
 * Upper bound on memory scrypt may allocate for one hash.
 *
 * scrypt needs roughly `128 * N * r` bytes; the bound adds generous headroom
 * for the parameters themselves without letting a crafted hash request an
 * unbounded allocation.
 */
function maxMemoryFor(params: ScryptParams): number {
  return Math.max(32 * 1024 * 1024, 256 * params.n * params.r);
}
