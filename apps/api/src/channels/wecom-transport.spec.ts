import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WECOM_REAL_REQUIRED_VARIABLES,
  parseAppConfig,
  resolveWecomCredentials,
  type AppConfig,
} from '@kefu/core';
import {
  describeWecomTransport,
  markWecomConnected,
  resetWecomConnectionState,
  type WecomTransportStatus,
} from './wecom-transport';
import {
  TEST_CALLBACK_TOKEN,
  TEST_CORP_ID,
  TEST_ENCODING_AES_KEY,
  TEST_KF_SECRET,
  TEST_OPEN_KF_ID,
} from '../../test/wecom-callback-support';

/** Parse a configuration from an environment, failing loudly when it will not. */
function configOf(env: Readonly<Record<string, string>>): AppConfig {
  const result = parseAppConfig(env);
  if (result._tag !== 'ok') {
    throw new Error(`the test configuration did not parse: ${result.error.message}`);
  }
  return result.config;
}

/**
 * The status of one environment, with nothing stored.
 *
 * The description takes the credential *resolution* rather than the
 * configuration alone, because a credential can come from either the
 * environment or the console. This suite is about the environment half, so it
 * resolves from an empty store — the state every deployment is in until an
 * operator types something — and the stored half is tested where the rule lives,
 * in `@kefu/core`'s `resolveWecomCredentials` suite.
 */
function statusOf(config: AppConfig): WecomTransportStatus {
  return describeWecomTransport(
    config,
    resolveWecomCredentials({ stored: undefined, environment: config.wecom }),
  );
}

/** The complete set of variables a real-mode boot needs. */
const REAL_ENV = {
  APP_ENV: 'test',
  WECOM_TRANSPORT: 'real',
  WECOM_CORP_ID: TEST_CORP_ID,
  WECOM_KF_SECRET: TEST_KF_SECRET,
  WECOM_TOKEN: TEST_CALLBACK_TOKEN,
  WECOM_AES_KEY: TEST_ENCODING_AES_KEY,
  WECOM_OPEN_KFID: TEST_OPEN_KF_ID,
} as const;

describe('describeWecomTransport', () => {
  beforeEach(() => {
    resetWecomConnectionState();
  });

  afterEach(() => {
    resetWecomConnectionState();
  });

  it('reports the Mock transport as operational and never as a real connection', () => {
    const status = statusOf(configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' }));

    expect(status).toMatchObject({
      provider: 'wecom',
      mode: 'mock',
      enableRequested: false,
      credentialsPresent: false,
      operational: true,
      realTransportConnected: false,
      missingCredentials: [],
    });
    expect(status.note).toContain('No real enterprise WeChat connection exists');
  });

  it('reports the Mock transport as credential-complete when the environment supplies them', () => {
    const status = statusOf(
      configOf({
        APP_ENV: 'test',
        WECOM_TRANSPORT: 'mock',
        WECOM_ENABLED: 'true',
        WECOM_CORP_ID: TEST_CORP_ID,
        WECOM_AGENT_ID: '1000002',
        WECOM_SECRET: 'test-app-secret',
        WECOM_TOKEN: TEST_CALLBACK_TOKEN,
        WECOM_AES_KEY: TEST_ENCODING_AES_KEY,
      }),
    );

    expect(status).toMatchObject({
      mode: 'mock',
      enableRequested: true,
      credentialsPresent: true,
      operational: true,
      realTransportConnected: false,
    });
  });

  it('names every missing real-mode variable and claims nothing is connected', () => {
    const status = statusOf(
      configOf({
        APP_ENV: 'test',
        WECOM_TRANSPORT: 'real',
        WECOM_ENABLED: 'true',
        WECOM_CORP_ID: TEST_CORP_ID,
      }),
    );

    expect(status).toMatchObject({
      mode: 'disabled',
      enableRequested: true,
      credentialsPresent: false,
      operational: false,
      realTransportConnected: false,
      missingCredentials: ['WECOM_KF_SECRET', 'WECOM_TOKEN', 'WECOM_AES_KEY', 'WECOM_OPEN_KFID'],
    });
    expect(status.note).toContain('credentials are incomplete');
  });

  it('never lets a self-built application credential stand in for the customer-service one', () => {
    // WECOM_SECRET/WECOM_AGENT_ID describe a self-built application. The
    // customer-service API stopped accepting that secret, so a real-mode boot
    // that supplies it and no WECOM_KF_SECRET must stay disabled.
    const status = statusOf(
      configOf({
        ...REAL_ENV,
        WECOM_KF_SECRET: '',
        WECOM_AGENT_ID: '1000002',
        WECOM_SECRET: 'test-app-secret',
      }),
    );

    expect(status.mode).toBe('disabled');
    expect(status.credentialsPresent).toBe(false);
    expect(status.missingCredentials).toEqual(['WECOM_KF_SECRET']);
  });

  it('lists only variable names, in declaration order', () => {
    const status = statusOf(
      configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'real', WECOM_OPEN_KFID: TEST_OPEN_KF_ID }),
    );

    expect(status.missingCredentials).toEqual([
      'WECOM_CORP_ID',
      'WECOM_KF_SECRET',
      'WECOM_TOKEN',
      'WECOM_AES_KEY',
    ]);
    for (const name of status.missingCredentials) {
      expect(WECOM_REAL_REQUIRED_VARIABLES).toContain(name);
    }
  });

  it('reports a configured but unproven real transport without claiming a connection', () => {
    const status = statusOf(configOf(REAL_ENV));

    expect(status).toMatchObject({
      mode: 'real',
      enableRequested: false,
      credentialsPresent: true,
      // Callback and send paths are wired, but this build claims an operational
      // loop only for the Mock, which closes in-process; a real deployment's
      // round trip is unproven.
      operational: false,
      realTransportConnected: false,
      missingCredentials: [],
    });
    expect(status.note).toContain('has not proven it can reach enterprise WeChat');
  });

  it('claims a connection only after the real transport proved one', () => {
    markWecomConnected(true);
    const status = statusOf(configOf(REAL_ENV));

    expect(status).toMatchObject({ mode: 'real', realTransportConnected: true });
    expect(status.note).toContain('connected');

    markWecomConnected(false);
    expect(statusOf(configOf(REAL_ENV)).realTransportConnected).toBe(false);
  });

  it('reports no connection error while nothing has been attempted', () => {
    const status = statusOf(configOf(REAL_ENV));

    expect(status.realTransportConnected).toBe(false);
    expect(status.lastConnectionError).toBeNull();
    expect(status.note).toContain('has not proven it can reach enterprise WeChat');
  });

  it('records a failed real probe with a stable code, message and time', () => {
    markWecomConnected(false, '2026-03-04T05:06:07.000Z');
    const status = statusOf(configOf(REAL_ENV));

    expect(status).toMatchObject({
      mode: 'real',
      realTransportConnected: false,
      lastConnectionError: {
        code: 'wecom_probe_failed',
        at: '2026-03-04T05:06:07.000Z',
      },
    });
    expect(status.lastConnectionError?.message).toContain('no access token was returned');
    expect(status.note).toContain('last token probe did not return a token');
  });

  it('clears a recorded failure as soon as a probe succeeds', () => {
    markWecomConnected(false, '2026-03-04T05:06:07.000Z');
    markWecomConnected(true, '2026-03-04T05:07:00.000Z');

    const status = statusOf(configOf(REAL_ENV));

    expect(status.realTransportConnected).toBe(true);
    // A failure the next attempt disproved must not stay on screen.
    expect(status.lastConnectionError).toBeNull();
  });

  it('reports no connection error on the Mock or on a disabled channel', () => {
    // The same failed-probe record must stay invisible where no probe of this
    // build produced it: a Mock boot and an unconfigured real boot.
    markWecomConnected(false, '2026-03-04T05:06:07.000Z');

    expect(
      statusOf(configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' }))
        .lastConnectionError,
    ).toBeNull();
    expect(
      statusOf(
        configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'real', WECOM_ENABLED: 'true' }),
      ).lastConnectionError,
    ).toBeNull();
  });

  it('names which of the two places the credentials came from', () => {
    // `none` is not "unconfigured": it is the Mock, which authenticates with
    // nothing at all. The two real answers are the two places an operator can
    // edit, and the note tells them which one to edit.
    expect(statusOf(configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' })).credentialSource).toBe(
      'none',
    );
    expect(statusOf(configOf(REAL_ENV)).credentialSource).toBe('environment');

    const stored = describeWecomTransport(
      configOf(REAL_ENV),
      resolveWecomCredentials({
        stored: {
          corpId: 'ww-from-the-console',
          kfSecret: 'a-secret-an-operator-typed',
          callbackToken: 'a-token-an-operator-typed',
          aesKey: TEST_ENCODING_AES_KEY,
          openKfId: 'wk-from-the-console',
        },
        environment: configOf(REAL_ENV).wecom,
      }),
    );

    // A stored set wins for being stored, not for being complete — which is
    // what keeps a half-typed one from being quietly replaced by `.env` and
    // reporting a connection the operator did not configure. What the *note*
    // says about where to fix it only matters once something is missing, which
    // the next test covers.
    expect(stored).toMatchObject({ mode: 'real', credentialSource: 'console' });
  });

  it('reports a half-typed stored set as the console\'s problem, not the environment\'s', () => {
    const status = describeWecomTransport(
      configOf(REAL_ENV),
      resolveWecomCredentials({
        stored: {
          corpId: TEST_CORP_ID,
          kfSecret: TEST_KF_SECRET,
          callbackToken: TEST_CALLBACK_TOKEN,
          // One character short: the AES key length is the one rule a value can
          // fail while looking right in the form.
          aesKey: TEST_ENCODING_AES_KEY.slice(0, -1),
          openKfId: TEST_OPEN_KF_ID,
        },
        environment: configOf(REAL_ENV).wecom,
      }),
    );

    expect(status).toMatchObject({
      mode: 'disabled',
      credentialsPresent: false,
      credentialSource: 'console',
      missingCredentials: ['WECOM_AES_KEY'],
    });
    expect(status.note).toContain('credentialSource is "console"');
  });

  it('keeps every credential and every provider word out of the reported failure', () => {
    markWecomConnected(false, '2026-03-04T05:06:07.000Z');
    const serialized = JSON.stringify(statusOf(configOf(REAL_ENV)));

    // Neither the credential values the environment supplied nor anything a
    // provider would have written may reach a browser through this field.
    for (const secret of [TEST_KF_SECRET, TEST_CALLBACK_TOKEN, TEST_ENCODING_AES_KEY]) {
      expect(secret.length).toBeGreaterThan(0);
      expect(serialized).not.toContain(secret);
    }
    for (const providerWord of ['errcode', 'errmsg', 'access_token', 'cgi-bin', 'invalid corpid']) {
      expect(serialized).not.toContain(providerWord);
    }
  });
});
