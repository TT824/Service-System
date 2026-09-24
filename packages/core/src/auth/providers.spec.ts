import { describe, expect, it } from 'vitest';
import { isAuthError } from './errors';
import {
  LOCAL_OIDC_PROVIDER_KEY,
  localOidcSubject,
  LocalOidcProvider,
  LocalOtpProvider,
  namespacedIdentitySubject,
  resolveOidcProvider,
  resolveOtpProvider,
} from './providers';
import type { OtpDelivery } from './types';

const DELIVERY: OtpDelivery = {
  challengeId: 'otp-0001',
  channel: 'sms',
  subject: '+8613800000000',
  purpose: 'sign_in',
  code: '123456',
  expiresAt: '2026-09-10T00:05:00.000Z',
};

describe('LocalOtpProvider', () => {
  it('records the delivered code unmodified', async () => {
    const provider = new LocalOtpProvider();
    await provider.send(DELIVERY);
    expect(provider.kind).toBe('local');
    expect(provider.deliveries()).toHaveLength(1);
    expect(provider.lastDeliveryFor('+8613800000000')).toEqual({
      challengeId: 'otp-0001',
      channel: 'sms',
      subject: '+8613800000000',
      purpose: 'sign_in',
      code: '123456',
      expiresAt: '2026-09-10T00:05:00.000Z',
    });
  });

  it('returns the newest delivery for a destination', async () => {
    const provider = new LocalOtpProvider();
    await provider.send({ ...DELIVERY, code: '111111' });
    await provider.send({ ...DELIVERY, challengeId: 'otp-0002', code: '222222' });
    await provider.send({ ...DELIVERY, subject: '+8613900000000', code: '333333' });
    expect(provider.lastDeliveryFor('+8613800000000')?.code).toBe('222222');
    expect(provider.lastDeliveryFor('+8613900000000')?.code).toBe('333333');
    expect(provider.lastDeliveryFor('+8613700000000')).toBeUndefined();
  });

  it('hands out copies and can be cleared', async () => {
    const provider = new LocalOtpProvider();
    await provider.send(DELIVERY);
    const snapshot = provider.deliveries();
    provider.clear();
    expect(snapshot).toHaveLength(1);
    expect(provider.deliveries()).toHaveLength(0);
  });

  it('reads a code back by challenge, and only for a delivery it recorded', async () => {
    const provider = new LocalOtpProvider();
    await provider.send({ ...DELIVERY, code: '111111' });
    await provider.send({ ...DELIVERY, challengeId: 'otp-0002', code: '222222' });

    // Looked up by challenge, not by destination: two challenges for the same
    // subject never hand back each other's code.
    expect(provider.codeForChallenge('otp-0001')).toBe('111111');
    expect(provider.codeForChallenge('otp-0002')).toBe('222222');
    expect(provider.codeForChallenge('otp-unknown')).toBeUndefined();
    expect(new LocalOtpProvider().codeForChallenge('otp-0001')).toBeUndefined();
  });
});

describe('resolveOtpProvider', () => {
  it('uses the deterministic local provider outside production', () => {
    expect(resolveOtpProvider({ appEnv: 'local', configured: '' }).kind).toBe('local');
    expect(resolveOtpProvider({ appEnv: 'test', configured: '' }).kind).toBe('local');
  });

  it('fails closed in production without an explicit provider', async () => {
    const provider = resolveOtpProvider({ appEnv: 'production', configured: '' });
    expect(provider.kind).toBe('unconfigured');
    await expect(provider.send(DELIVERY)).rejects.toMatchObject({
      code: 'provider_not_configured',
    });
  });

  it('fails closed in production even when a provider is named, until one is installed', async () => {
    const provider = resolveOtpProvider({ appEnv: 'production', configured: 'aliyun-sms' });
    expect(provider.kind).toBe('unconfigured');
    try {
      await provider.send(DELIVERY);
      expect.unreachable('expected the unconfigured provider to fail closed');
    } catch (error) {
      expect(isAuthError(error)).toBe(true);
      if (isAuthError(error)) {
        expect(error.code).toBe('provider_not_configured');
        expect(error.status).toBe(503);
        expect(error.message).toContain('aliyun-sms');
      }
    }
  });
});

describe('LocalOidcProvider', () => {
  it('maps a code to a stable subject', async () => {
    const provider = new LocalOidcProvider();
    const first = await provider.exchangeCode('authorization-code-1');
    const second = await provider.exchangeCode('authorization-code-1');
    expect(first).toEqual(second);
    expect(first.provider).toBe(LOCAL_OIDC_PROVIDER_KEY);
    expect(first.subject).toMatch(/^[0-9a-f]{24}$/);
  });

  it('never embeds the authorization code in what it returns', async () => {
    const provider = new LocalOidcProvider();
    const claims = await provider.exchangeCode('authorization-code-1');
    expect(JSON.stringify(claims)).not.toContain('authorization-code-1');
  });

  it('maps different codes to different subjects', async () => {
    const provider = new LocalOidcProvider();
    const first = await provider.exchangeCode('authorization-code-1');
    const second = await provider.exchangeCode('authorization-code-2');
    expect(first.subject).not.toBe(second.subject);
  });

  it('rejects an empty code', async () => {
    await expect(new LocalOidcProvider().exchangeCode('   ')).rejects.toMatchObject({
      code: 'provider_error',
    });
  });

  it('namespaces the subject under the configured issuer', async () => {
    const claims = await new LocalOidcProvider('acme-idp').exchangeCode('code');
    expect(claims.provider).toBe('acme-idp');
    expect(localOidcSubject('code')).toBe(claims.subject);
  });
});

describe('resolveOidcProvider', () => {
  it('uses the deterministic local provider outside production', () => {
    expect(resolveOidcProvider({ appEnv: 'local', configured: '' }).kind).toBe(
      LOCAL_OIDC_PROVIDER_KEY,
    );
    expect(resolveOidcProvider({ appEnv: 'test', configured: 'keycloak' }).kind).toBe(
      LOCAL_OIDC_PROVIDER_KEY,
    );
  });

  it('fails closed in production', async () => {
    const provider = resolveOidcProvider({ appEnv: 'production', configured: '' });
    expect(provider.kind).toBe('unconfigured');
    await expect(provider.exchangeCode('code')).rejects.toMatchObject({
      code: 'provider_not_configured',
    });
  });
});

describe('namespacedIdentitySubject', () => {
  it('folds the issuer into the subject', () => {
    expect(namespacedIdentitySubject('acme-idp', 'abc123')).toBe('acme-idp:abc123');
  });

  it('keeps two issuers using the same subject apart', () => {
    expect(namespacedIdentitySubject('idp-a', 'user-1')).not.toBe(
      namespacedIdentitySubject('idp-b', 'user-1'),
    );
  });
});
