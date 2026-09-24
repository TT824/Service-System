import { describe, expect, it } from 'vitest';
import {
  assertPasswordStrength,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from './password';
import { isAuthError } from './errors';

const STRONG = 'correct-horse-battery-staple';

describe('password hashing', () => {
  it('verifies a password it hashed', () => {
    const encoded = hashPassword(STRONG);
    expect(verifyPassword(STRONG, encoded)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const encoded = hashPassword(STRONG);
    expect(verifyPassword(`${STRONG}!`, encoded)).toBe(false);
  });

  it('never stores the plaintext', () => {
    const encoded = hashPassword(STRONG);
    expect(encoded).not.toContain(STRONG);
  });

  it('salts every hash independently', () => {
    const first = hashPassword(STRONG);
    const second = hashPassword(STRONG);
    expect(first).not.toBe(second);
    expect(verifyPassword(STRONG, first)).toBe(true);
    expect(verifyPassword(STRONG, second)).toBe(true);
  });

  it('records the algorithm and its parameters in the encoding', () => {
    const encoded = hashPassword(STRONG);
    const parts = encoded.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe('N=16384,r=8,p=1');
    expect(parts[2]?.length).toBeGreaterThan(0);
    expect(parts[3]?.length).toBeGreaterThan(0);
  });

  it('accepts an explicit salt so a hash is reproducible', () => {
    const salt = Buffer.alloc(16, 3);
    const first = hashPassword(STRONG, undefined, salt);
    const second = hashPassword(STRONG, undefined, salt);
    expect(first).toBe(second);
  });

  it('returns false for a malformed encoding instead of throwing', () => {
    expect(verifyPassword(STRONG, 'not-a-hash')).toBe(false);
    expect(verifyPassword(STRONG, 'scrypt$N=16384,r=8,p=1$only-three-parts')).toBe(false);
    expect(verifyPassword(STRONG, 'bcrypt$N=16384,r=8,p=1$c2FsdA$aGFzaA')).toBe(false);
    expect(verifyPassword(STRONG, 'scrypt$N=abc,r=8,p=1$c2FsdA$aGFzaA')).toBe(false);
    expect(verifyPassword(STRONG, 'scrypt$N=16384,r=8,p=1$$aGFzaA')).toBe(false);
  });
});

describe('assertPasswordStrength', () => {
  it('accepts a password at the minimum length', () => {
    expect(() => assertPasswordStrength('a'.repeat(PASSWORD_MIN_LENGTH))).not.toThrow();
  });

  it('rejects a password below the minimum length', () => {
    try {
      assertPasswordStrength('a'.repeat(PASSWORD_MIN_LENGTH - 1));
      expect.unreachable('expected a password_too_weak failure');
    } catch (error) {
      expect(isAuthError(error)).toBe(true);
      if (isAuthError(error)) {
        expect(error.code).toBe('password_too_weak');
        expect(error.status).toBe(400);
      }
    }
  });

  it('rejects a password above the maximum length', () => {
    try {
      assertPasswordStrength('a'.repeat(PASSWORD_MAX_LENGTH + 1));
      expect.unreachable('expected a password_too_weak failure');
    } catch (error) {
      expect(isAuthError(error)).toBe(true);
      if (isAuthError(error)) {
        expect(error.code).toBe('password_too_weak');
      }
    }
  });

  it('rejects a whitespace-only password', () => {
    expect(() => assertPasswordStrength(' '.repeat(32))).toThrow();
  });
});
