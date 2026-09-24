import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_HEX_LENGTH,
  fingerprintSecret,
  generateDeviceCredential,
  generateSessionToken,
  safeEqualFingerprint,
  SESSION_TOKEN_BYTES,
} from './token';

describe('bearer tokens', () => {
  it('issues a high-entropy url-safe token', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes base64url-encode to 43 characters with no padding.
    expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it('never issues the same token twice', () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      tokens.add(generateSessionToken());
    }
    expect(tokens.size).toBe(200);
  });

  it('honours an explicit byte length', () => {
    expect(generateSessionToken(SESSION_TOKEN_BYTES + 16).length).toBeGreaterThan(
      generateSessionToken(SESSION_TOKEN_BYTES).length,
    );
  });

  it('issues a distinct device credential', () => {
    const credential = generateDeviceCredential();
    expect(credential).not.toBe(generateSessionToken());
    expect(credential).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('fingerprints', () => {
  it('is a deterministic sha-256 hex digest', () => {
    const fingerprint = fingerprintSecret('a-secret-value');
    expect(fingerprint).toHaveLength(FINGERPRINT_HEX_LENGTH);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintSecret('a-secret-value')).toBe(fingerprint);
  });

  it('does not contain the secret it fingerprints', () => {
    expect(fingerprintSecret('a-secret-value')).not.toContain('a-secret-value');
  });

  it('differs for different secrets', () => {
    expect(fingerprintSecret('one')).not.toBe(fingerprintSecret('two'));
  });
});

describe('safeEqualFingerprint', () => {
  it('accepts identical fingerprints', () => {
    const fingerprint = fingerprintSecret('a-secret-value');
    expect(safeEqualFingerprint(fingerprint, fingerprint)).toBe(true);
  });

  it('rejects different fingerprints', () => {
    expect(safeEqualFingerprint(fingerprintSecret('one'), fingerprintSecret('two'))).toBe(false);
  });

  it('rejects fingerprints of different length without throwing', () => {
    expect(safeEqualFingerprint('abc', fingerprintSecret('one'))).toBe(false);
  });
});
