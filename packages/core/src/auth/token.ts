/**
 * Bearer tokens, device credentials and their fingerprints.
 *
 * A token is 32 bytes of CSPRNG output encoded as base64url, so it is
 * unguessable rather than merely opaque. Only the SHA-256 fingerprint of a
 * token or device credential is ever persisted; the raw value exists solely in
 * the response that hands it to the client.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Entropy of an issued bearer token, in bytes. */
export const SESSION_TOKEN_BYTES = 32;

/** Entropy of an enrolled device credential, in bytes. */
export const DEVICE_CREDENTIAL_BYTES = 32;

/** Number of hexadecimal characters in a fingerprint. */
export const FINGERPRINT_HEX_LENGTH = 64;

/**
 * Issue a new bearer token.
 *
 * @param bytes - Entropy to draw; defaults to {@link SESSION_TOKEN_BYTES}.
 * @returns A base64url token. Handed to the client once and never stored.
 */
export function generateSessionToken(bytes: number = SESSION_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Issue a new device credential.
 *
 * @returns A base64url credential. Handed to the client once and never stored.
 */
export function generateDeviceCredential(): string {
  return randomBytes(DEVICE_CREDENTIAL_BYTES).toString('base64url');
}

/**
 * Fingerprint a token, credential or one-time code.
 *
 * SHA-256 is the right primitive here: the input already carries full entropy,
 * so a slow key-derivation function would only add latency to every request.
 *
 * @param secret - The raw value to fingerprint.
 * @returns A 64-character lowercase hexadecimal digest.
 */
export function fingerprintSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Compare two hexadecimal fingerprints without leaking their contents through
 * timing.
 *
 * @param left - First fingerprint.
 * @param right - Second fingerprint.
 * @returns `true` when both are equal.
 */
export function safeEqualFingerprint(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
