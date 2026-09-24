import { describe, expect, it } from 'vitest';
import {
  LocalOtpProvider,
  parseAppConfig,
  UnconfiguredOtpProvider,
  type AppConfig,
  type OtpDelivery,
  type OtpProvider,
} from '@kefu/core';
import { resolveDevelopmentOtpCode } from './development-otp';

const CHALLENGE_ID = 'otp-reveal-1';
const CODE = '123456';
const SUBJECT = '+8613800000000';

/** Deliver one code through a local provider and return that provider. */
async function localProviderWithCode(): Promise<LocalOtpProvider> {
  const provider = new LocalOtpProvider();
  await provider.send(delivery());
  return provider;
}

/** A delivery carrying {@link CODE}. */
function delivery(): OtpDelivery {
  return {
    challengeId: CHALLENGE_ID,
    channel: 'sms',
    subject: SUBJECT,
    purpose: 'sign_in',
    code: CODE,
    expiresAt: '2026-09-10T00:05:00.000Z',
  };
}

/** Parse a configuration, failing loudly when the fixture is wrong. */
function configOf(env: Record<string, string>): AppConfig {
  const parsed = parseAppConfig(env);
  if (parsed._tag !== 'ok') {
    throw new Error(`fixture configuration is invalid: ${parsed.error.message}`);
  }
  return parsed.config;
}

/** A complete production environment, so the parse succeeds. */
const PRODUCTION_ENV: Record<string, string> = {
  APP_ENV: 'production',
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user:pass@db.example.internal:5432/kefu',
  REDIS_URL: 'redis://redis.example.internal:6379',
  OBJECT_STORAGE_ENDPOINT: 'minio.example.internal',
  OBJECT_STORAGE_PORT: '9000',
  OBJECT_STORAGE_USE_SSL: 'true',
  OBJECT_STORAGE_ACCESS_KEY: 'prod-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'prod-secret-key',
  OBJECT_STORAGE_BUCKET: 'media',
  CORS_ORIGINS: 'https://console.example.com',
  EMBEDDING_BASE_URL: 'http://embedding.example.internal:11434',
  EMBEDDING_MODEL: 'qwen3-embedding:0.6b',
  MEDIA_URL_SECRET: 'prod-media-url-secret',
};

describe('resolveDevelopmentOtpCode', () => {
  it('reveals the code in local development when the operator opted in', async () => {
    const provider = await localProviderWithCode();
    const config = configOf({
      APP_ENV: 'local',
      AUTH_DEVELOPMENT_OTP_VISIBLE: 'true',
      AUTH_STORAGE: 'memory',
    });

    expect(resolveDevelopmentOtpCode({ config, provider, challengeId: CHALLENGE_ID })).toBe(CODE);
  });

  it('stays silent in local development without the opt-in', async () => {
    const provider = await localProviderWithCode();
    const config = configOf({ APP_ENV: 'local', AUTH_STORAGE: 'memory' });

    expect(config.auth.developmentOtpVisible).toBe(false);
    expect(
      resolveDevelopmentOtpCode({ config, provider, challengeId: CHALLENGE_ID }),
    ).toBeUndefined();
  });

  it.each(['test', 'production'])(
    'never reveals the code in %s, even with the flag set to true',
    async (appEnv) => {
      const provider = await localProviderWithCode();
      const config = configOf({
        ...(appEnv === 'production' ? PRODUCTION_ENV : {}),
        APP_ENV: appEnv,
        AUTH_DEVELOPMENT_OTP_VISIBLE: 'true',
      });

      expect(config.auth.developmentOtpVisible).toBe(true);
      expect(
        resolveDevelopmentOtpCode({ config, provider, challengeId: CHALLENGE_ID }),
      ).toBeUndefined();
    },
  );

  it('never reveals a code through a provider that is not the local one', async () => {
    const config = configOf({
      APP_ENV: 'local',
      AUTH_DEVELOPMENT_OTP_VISIBLE: 'true',
      AUTH_STORAGE: 'memory',
    });
    const unconfigured = new UnconfiguredOtpProvider('no adapter installed');
    // A provider that merely calls itself `local` must not inherit the reveal.
    const lookalike: OtpProvider = { kind: 'local', send: async () => undefined };

    expect(
      resolveDevelopmentOtpCode({ config, provider: unconfigured, challengeId: CHALLENGE_ID }),
    ).toBeUndefined();
    expect(
      resolveDevelopmentOtpCode({ config, provider: lookalike, challengeId: CHALLENGE_ID }),
    ).toBeUndefined();
  });

  it('reveals nothing for a challenge the provider never delivered', async () => {
    const provider = await localProviderWithCode();
    const config = configOf({
      APP_ENV: 'local',
      AUTH_DEVELOPMENT_OTP_VISIBLE: 'true',
      AUTH_STORAGE: 'memory',
    });

    expect(
      resolveDevelopmentOtpCode({ config, provider, challengeId: 'otp-other' }),
    ).toBeUndefined();
  });
});
