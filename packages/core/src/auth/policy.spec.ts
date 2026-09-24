import { describe, expect, it } from 'vitest';
import {
  addMilliseconds,
  allowsAccountCenter,
  allowsBusinessData,
  countWithinWindow,
  DEFAULT_AUTH_POLICY,
  deriveAccessState,
  effectiveDeviceStatus,
  isDeviceUsable,
  isOtpResendCoolingDown,
  isOtpSendRateLimited,
  latestInstant,
} from './policy';

describe('deriveAccessState', () => {
  it('is active when the account, member, link and tenant are all usable', () => {
    expect(
      deriveAccessState({
        accountStatus: 'active',
        memberEnabled: true,
        tenantEnabled: true,
        hasActiveMemberLink: true,
      }),
    ).toBe('active');
  });

  it('is active for a platform member without a tenant', () => {
    expect(
      deriveAccessState({
        accountStatus: 'active',
        memberEnabled: true,
        tenantEnabled: null,
        hasActiveMemberLink: true,
      }),
    ).toBe('active');
  });

  it('is pending_config when the account has no member yet', () => {
    expect(
      deriveAccessState({
        accountStatus: 'active',
        memberEnabled: null,
        tenantEnabled: null,
        hasActiveMemberLink: false,
      }),
    ).toBe('pending_config');
  });

  it('is pending_config when the member link is missing or revoked', () => {
    expect(
      deriveAccessState({
        accountStatus: 'active',
        memberEnabled: true,
        tenantEnabled: true,
        hasActiveMemberLink: false,
      }),
    ).toBe('pending_config');
  });

  it('is pending_config when the tenant is disabled', () => {
    expect(
      deriveAccessState({
        accountStatus: 'active',
        memberEnabled: true,
        tenantEnabled: false,
        hasActiveMemberLink: true,
      }),
    ).toBe('pending_config');
  });

  it('is pending_config for a pending account', () => {
    expect(
      deriveAccessState({
        accountStatus: 'pending',
        memberEnabled: true,
        tenantEnabled: true,
        hasActiveMemberLink: true,
      }),
    ).toBe('pending_config');
  });

  it('is disabled when the account or its member is switched off', () => {
    expect(
      deriveAccessState({
        accountStatus: 'disabled',
        memberEnabled: true,
        tenantEnabled: true,
        hasActiveMemberLink: true,
      }),
    ).toBe('disabled');
    expect(
      deriveAccessState({
        accountStatus: 'locked',
        memberEnabled: true,
        tenantEnabled: true,
        hasActiveMemberLink: true,
      }),
    ).toBe('disabled');
    expect(
      deriveAccessState({
        accountStatus: 'active',
        memberEnabled: false,
        tenantEnabled: true,
        hasActiveMemberLink: true,
      }),
    ).toBe('disabled');
  });
});

describe('surface rules', () => {
  it('lets every state but disabled reach the account center', () => {
    expect(allowsAccountCenter('active')).toBe(true);
    expect(allowsAccountCenter('pending_config')).toBe(true);
    expect(allowsAccountCenter('disabled')).toBe(false);
  });

  it('lets only an active state reach tenant business data', () => {
    expect(allowsBusinessData('active')).toBe(true);
    expect(allowsBusinessData('pending_config')).toBe(false);
    expect(allowsBusinessData('disabled')).toBe(false);
  });
});

describe('one-time code rate limiting', () => {
  const policy = DEFAULT_AUTH_POLICY.otp;
  const now = '2026-09-10T00:10:00.000Z';

  it('counts only instants inside the rolling window', () => {
    const instants = ['2026-09-09T23:50:00.000Z', '2026-09-10T00:05:00.000Z', now];
    expect(countWithinWindow(instants, now, policy.windowMs)).toBe(2);
  });

  it('refuses a send once the budget is spent', () => {
    expect(isOtpSendRateLimited([], now, policy)).toBe(false);
    expect(
      isOtpSendRateLimited(['2026-09-10T00:00:00.000Z', '2026-09-10T00:05:00.000Z'], now, policy),
    ).toBe(false);
    expect(
      isOtpSendRateLimited(
        ['2026-09-10T00:00:00.000Z', '2026-09-10T00:05:00.000Z', '2026-09-10T00:09:00.000Z'],
        now,
        policy,
      ),
    ).toBe(true);
  });

  it('forgets instants that aged out of the window', () => {
    expect(
      isOtpSendRateLimited(
        ['2026-09-09T23:00:00.000Z', '2026-09-09T23:10:00.000Z', '2026-09-09T23:20:00.000Z'],
        now,
        policy,
      ),
    ).toBe(false);
  });

  it('cools down immediately after a send and releases after the cooldown', () => {
    expect(isOtpResendCoolingDown([], now, policy)).toBe(false);
    expect(isOtpResendCoolingDown(['2026-09-10T00:09:30.000Z'], now, policy)).toBe(true);
    expect(isOtpResendCoolingDown(['2026-09-10T00:09:00.000Z'], now, policy)).toBe(false);
  });

  it('reports the most recent instant', () => {
    expect(latestInstant([])).toBeUndefined();
    expect(latestInstant(['2026-09-10T00:00:00.000Z', '2026-09-10T00:09:00.000Z'])).toBe(
      '2026-09-10T00:09:00.000Z',
    );
  });
});

describe('addMilliseconds', () => {
  it('adds and subtracts a duration', () => {
    expect(addMilliseconds('2026-09-10T00:00:00.000Z', 60_000)).toBe('2026-09-10T00:01:00.000Z');
    expect(addMilliseconds('2026-09-10T00:00:00.000Z', -60_000)).toBe('2026-09-09T23:59:00.000Z');
  });
});

describe('effectiveDeviceStatus', () => {
  const NOW = '2026-09-10T00:00:00.000Z';

  it('is active while the lifetime has not run out', () => {
    expect(
      effectiveDeviceStatus({ status: 'active', expiresAt: addMilliseconds(NOW, 1000) }, NOW),
    ).toBe('active');
  });

  it('expires exactly at the instant it lapses', () => {
    expect(effectiveDeviceStatus({ status: 'active', expiresAt: NOW }, NOW)).toBe('expired');
    expect(
      effectiveDeviceStatus({ status: 'active', expiresAt: addMilliseconds(NOW, -1) }, NOW),
    ).toBe('expired');
  });

  it('never lapses on its own when there is no expiry', () => {
    expect(effectiveDeviceStatus({ status: 'active', expiresAt: null }, NOW)).toBe('active');
  });

  it('keeps a device that was already retired retired', () => {
    // A revoked device stays revoked even past the instant it would have lapsed:
    // revocation is why it stopped being trusted, and the reason must not be
    // rewritten by the passage of time.
    expect(effectiveDeviceStatus({ status: 'revoked', expiresAt: NOW }, NOW)).toBe('revoked');
    expect(effectiveDeviceStatus({ status: 'revoked', expiresAt: null }, NOW)).toBe('revoked');
    expect(effectiveDeviceStatus({ status: 'expired', expiresAt: null }, NOW)).toBe('expired');
  });
});

describe('isDeviceUsable', () => {
  const NOW = '2026-09-10T00:00:00.000Z';

  it('is true only for a live device', () => {
    expect(isDeviceUsable({ status: 'active', expiresAt: addMilliseconds(NOW, 1) }, NOW)).toBe(
      true,
    );
    expect(isDeviceUsable({ status: 'active', expiresAt: NOW }, NOW)).toBe(false);
    expect(isDeviceUsable({ status: 'revoked', expiresAt: null }, NOW)).toBe(false);
    expect(isDeviceUsable({ status: 'expired', expiresAt: null }, NOW)).toBe(false);
  });
});

describe('DEFAULT_AUTH_POLICY', () => {
  it('is frozen and consistent', () => {
    expect(Object.isFrozen(DEFAULT_AUTH_POLICY)).toBe(true);
    expect(DEFAULT_AUTH_POLICY.otp.ttlMs).toBeGreaterThan(0);
    expect(DEFAULT_AUTH_POLICY.otp.maxAttempts).toBeGreaterThan(0);
    expect(DEFAULT_AUTH_POLICY.password.maxFailedLogins).toBeGreaterThan(0);
    expect(DEFAULT_AUTH_POLICY.session.ttlMs).toBeGreaterThan(0);
    expect(DEFAULT_AUTH_POLICY.session.touchIntervalMs).toBeLessThan(
      DEFAULT_AUTH_POLICY.session.ttlMs,
    );
    expect(DEFAULT_AUTH_POLICY.maxActiveSessionsPerUser).toBeGreaterThan(0);
  });
});
