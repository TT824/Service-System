import { describe, expect, it } from 'vitest';
import {
  expireOtpIfElapsed,
  generateOtpCode,
  hashOtpCode,
  isOtpExpired,
  isOtpUsable,
  otpUnusableError,
  OTP_CODE_ALGORITHM,
  OTP_CODE_LENGTH,
  verifyOtpCode,
} from './otp';
import type { OtpChallenge } from './types';

function challenge(overrides: Partial<OtpChallenge> = {}): OtpChallenge {
  return {
    id: 'otp-0001',
    tenantId: null,
    userId: null,
    purpose: 'sign_in',
    channel: 'sms',
    subject: '+8613800000000',
    codeHash: hashOtpCode('otp-0001', '123456'),
    codeAlgorithm: OTP_CODE_ALGORITHM,
    status: 'pending',
    failedAttempts: 0,
    maxAttempts: 5,
    idempotencyKey: null,
    issuedAt: '2026-09-10T00:00:00.000Z',
    expiresAt: '2026-09-10T00:05:00.000Z',
    consumedAt: null,
    revokedAt: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('generateOtpCode', () => {
  it('always produces a fixed-length numeric code', () => {
    for (let index = 0; index < 500; index += 1) {
      const code = generateOtpCode();
      expect(code).toHaveLength(OTP_CODE_LENGTH);
      expect(code).toMatch(/^[0-9]{6}$/);
    }
  });

  it('produces more than one distinct value', () => {
    const codes = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      codes.add(generateOtpCode());
    }
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('code hashing', () => {
  it('is a deterministic 64-character hex digest', () => {
    const hash = hashOtpCode('otp-0001', '123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOtpCode('otp-0001', '123456')).toBe(hash);
  });

  it('never contains the code it hashes', () => {
    expect(hashOtpCode('otp-0001', '123456')).not.toContain('123456');
  });

  it('salts with the challenge id, so one code cannot be replayed on another', () => {
    expect(hashOtpCode('otp-0001', '123456')).not.toBe(hashOtpCode('otp-0002', '123456'));
    expect(verifyOtpCode('otp-0002', '123456', hashOtpCode('otp-0001', '123456'))).toBe(false);
  });

  it('verifies only the exact code', () => {
    const hash = hashOtpCode('otp-0001', '123456');
    expect(verifyOtpCode('otp-0001', '123456', hash)).toBe(true);
    expect(verifyOtpCode('otp-0001', '123457', hash)).toBe(false);
    expect(verifyOtpCode('otp-0001', '12345', hash)).toBe(false);
    expect(verifyOtpCode('otp-0001', '', hash)).toBe(false);
  });
});

describe('challenge lifecycle', () => {
  it('is unexpired inside its window and expired at the boundary', () => {
    expect(isOtpExpired(challenge(), '2026-09-10T00:04:59.999Z')).toBe(false);
    expect(isOtpExpired(challenge(), '2026-09-10T00:05:00.000Z')).toBe(true);
    expect(isOtpExpired(challenge(), '2026-09-10T00:05:00.001Z')).toBe(true);
  });

  it('is usable only while pending, unexpired and under its attempt budget', () => {
    expect(isOtpUsable(challenge(), '2026-09-10T00:01:00.000Z')).toBe(true);
    expect(isOtpUsable(challenge(), '2026-09-10T00:05:00.000Z')).toBe(false);
    expect(isOtpUsable(challenge({ status: 'consumed' }), '2026-09-10T00:01:00.000Z')).toBe(false);
    expect(isOtpUsable(challenge({ status: 'revoked' }), '2026-09-10T00:01:00.000Z')).toBe(false);
    expect(isOtpUsable(challenge({ failedAttempts: 5 }), '2026-09-10T00:01:00.000Z')).toBe(false);
  });

  it('describes the reason a challenge is unusable', () => {
    const now = '2026-09-10T00:01:00.000Z';
    expect(otpUnusableError(challenge({ status: 'consumed' }), now).code).toBe('otp_consumed');
    expect(otpUnusableError(challenge({ status: 'revoked' }), now).code).toBe('otp_expired');
    expect(otpUnusableError(challenge(), '2026-09-10T00:05:00.000Z').code).toBe('otp_expired');
    expect(otpUnusableError(challenge({ failedAttempts: 5 }), now).code).toBe(
      'otp_attempts_exceeded',
    );
  });

  it('moves an elapsed challenge to expired with a terminal timestamp', () => {
    const expired = expireOtpIfElapsed(challenge(), '2026-09-10T00:06:00.000Z');
    expect(expired.status).toBe('expired');
    expect(expired.revokedAt).toBe('2026-09-10T00:06:00.000Z');
    expect(isOtpUsable(expired, '2026-09-10T00:06:00.000Z')).toBe(false);
  });

  it('leaves a live or already-terminal challenge untouched', () => {
    const live = challenge();
    expect(expireOtpIfElapsed(live, '2026-09-10T00:01:00.000Z')).toBe(live);
    const consumed = challenge({ status: 'consumed', consumedAt: '2026-09-10T00:01:00.000Z' });
    expect(expireOtpIfElapsed(consumed, '2026-09-10T00:06:00.000Z')).toBe(consumed);
  });
});
