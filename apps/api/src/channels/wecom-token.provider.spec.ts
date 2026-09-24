/**
 * The API's wiring of the shared WeCom access-token provider.
 *
 * The provider itself lives in `@kefu/wecom`, because the Worker acquires the
 * same token to deliver the same queue. What this spec pins is the half that is
 * the API's own: the provider is constructed with the API's configuration, and
 * the one deployment fact it reports back — "a token was actually fetched" — is
 * wired to {@link markWecomConnected}, so the channel surfaces keep reporting the
 * real transport's connectivity exactly as they did before the package existed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryWecomTokenCache,
  WecomTokenProvider,
  isWecomAuthenticationError,
  type WecomCredentialReader,
  type WecomTokenCache,
} from '@kefu/wecom';
import { resolveWecomCredentials, type WecomCredentialValues } from '@kefu/core';
import {
  describeWecomTransport,
  markWecomConnected,
  resetWecomConnectionState,
} from './wecom-transport';
import { FakeWecomHttp, TEST_KF_SECRET, realWecomConfig } from '../../test/wecom-callback-support';

/**
 * The environment half of the API's credential reader, with nothing stored.
 *
 * The API composes its real reader over the credential table; this suite is
 * about what the provider does with whatever a reader hands it, so it supplies
 * the same shape from the environment alone — the state a deployment that has
 * never connected anything from the console is in. That a stored set wins over
 * the environment is `@kefu/core`'s rule and is tested where the rule lives.
 */
function environmentReader(): WecomCredentialReader {
  return async () =>
    resolveWecomCredentials({ stored: undefined, environment: realWecomConfig().wecom });
}

/** A reader that answers with one fixed set, as the console's write would. */
function storedReader(values: WecomCredentialValues): WecomCredentialReader {
  return async () => ({ _tag: 'ready', values, origin: 'console' });
}

/** The one instant the fake clock starts from, so TTL arithmetic is readable. */
const START = new Date('2026-01-01T00:00:00.000Z');

/** WeCom's documented `expires_in`, and the margin the provider reserves. */
const EXPIRES_IN_SECONDS = 7200;
const REFRESH_MARGIN_SECONDS = 120;

/** A successful `gettoken` answer carrying a synthetic token. */
function tokenAnswer(token = 'test-access-token', expiresIn = EXPIRES_IN_SECONDS) {
  return {
    status: 200,
    body: { errcode: 0, errmsg: 'ok', access_token: token, expires_in: expiresIn },
  };
}

/** A token provider wired to the supplied port and cache. */
function providerFor(
  http: FakeWecomHttp,
  cache: WecomTokenCache = new MemoryWecomTokenCache(),
  credentials: WecomCredentialReader = environmentReader(),
) {
  return new WecomTokenProvider(http, cache, {
    credentials,
    timeoutMs: 3000,
    // The API's own binding for the shared provider's connection observer: the
    // package reports a proven token, the application decides what that means
    // for its channel surfaces.
    onConnectionProven: markWecomConnected,
  });
}

/** Whether the channel surfaces would report a proven connection. */
function realTransportConnected(): boolean {
  const config = realWecomConfig();
  return describeWecomTransport(
    config,
    resolveWecomCredentials({ stored: undefined, environment: config.wecom }),
  ).realTransportConnected;
}

describe('isWecomAuthenticationError', () => {
  it('recognises only the codes that mean "re-acquire the token and replay"', () => {
    for (const errcode of [40001, 40013, 40014, 41001, 42001]) {
      expect(isWecomAuthenticationError(errcode)).toBe(true);
    }
    for (const errcode of [0, -1, 95002, 40003, null]) {
      expect(isWecomAuthenticationError(errcode)).toBe(false);
    }
  });
});

describe('WecomTokenProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    resetWecomConnectionState();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetWecomConnectionState();
  });

  it('fetches a token once and then serves it from the cache', async () => {
    const http = new FakeWecomHttp(() => tokenAnswer());
    const provider = providerFor(http);

    expect(await provider.get()).toEqual({ ok: true, value: 'test-access-token' });
    expect(await provider.get()).toEqual({ ok: true, value: 'test-access-token' });

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.method).toBe('GET');
    expect(http.requests[0]?.url).toContain('corpid=ww-test-corp');
    expect(http.requests[0]?.url).toContain(`corpsecret=${TEST_KF_SECRET}`);
  });

  it('stores the token with the provider expiry minus the refresh margin', async () => {
    const cache = new MemoryWecomTokenCache();
    const stored: Array<{ key: string; ttlSeconds: number }> = [];
    const recording: WecomTokenCache = {
      get: (key) => cache.get(key),
      delete: (key) => cache.delete(key),
      set: async (key, token, ttlSeconds) => {
        stored.push({ key, ttlSeconds });
        await cache.set(key, token, ttlSeconds);
      },
    };
    const provider = providerFor(new FakeWecomHttp(() => tokenAnswer()), recording);

    await provider.get();

    expect(stored).toEqual([
      {
        key: 'wecom:kf-access-token:ww-test-corp',
        ttlSeconds: EXPIRES_IN_SECONDS - REFRESH_MARGIN_SECONDS,
      },
    ]);
  });

  it('refreshes once the cached token has expired', async () => {
    let issued = 0;
    const http = new FakeWecomHttp(() => tokenAnswer(`token-${++issued}`));
    const provider = providerFor(http);

    expect(await provider.get()).toEqual({ ok: true, value: 'token-1' });
    // One second before the stored TTL elapses the cache still answers.
    vi.setSystemTime(
      new Date(START.getTime() + (EXPIRES_IN_SECONDS - REFRESH_MARGIN_SECONDS - 1) * 1000),
    );
    expect(await provider.get()).toEqual({ ok: true, value: 'token-1' });
    expect(http.requests).toHaveLength(1);

    // Past it, the provider must ask WeCom again rather than hand out a token
    // that may already have expired upstream.
    vi.setSystemTime(
      new Date(START.getTime() + (EXPIRES_IN_SECONDS - REFRESH_MARGIN_SECONDS + 1) * 1000),
    );
    expect(await provider.get()).toEqual({ ok: true, value: 'token-2' });
    expect(http.requests).toHaveLength(2);
  });

  it('invalidate drops the cached token so the next call re-acquires it', async () => {
    let issued = 0;
    const http = new FakeWecomHttp(() => tokenAnswer(`token-${++issued}`));
    const provider = providerFor(http);

    await provider.get();
    await provider.invalidate();

    expect(await provider.get()).toEqual({ ok: true, value: 'token-2' });
    expect(http.requests).toHaveLength(2);
  });

  it('probe always asks WeCom, because a cached token proves nothing about the network', async () => {
    const http = new FakeWecomHttp(() => tokenAnswer());
    const provider = providerFor(http);

    await provider.get();
    expect(http.requests).toHaveLength(1);

    expect(await provider.probe()).toBe(true);
    expect(http.requests).toHaveLength(2);
  });

  it('remembers a successful probe briefly so a refresh cannot spend the quota', async () => {
    const http = new FakeWecomHttp(() => tokenAnswer());
    const provider = providerFor(http);

    expect(await provider.probe()).toBe(true);
    expect(await provider.probe()).toBe(true);
    expect(http.requests).toHaveLength(1);

    // Past the probe window the check is repeated.
    vi.setSystemTime(new Date(START.getTime() + 60_001));
    expect(await provider.probe()).toBe(true);
    expect(http.requests).toHaveLength(2);
  });

  it('does not remember a failed probe', async () => {
    const http = new FakeWecomHttp(() => ({ status: 200, body: { errcode: 40013 } }));
    const provider = providerFor(http);

    expect(await provider.probe()).toBe(false);
    expect(await provider.probe()).toBe(false);
    expect(http.requests).toHaveLength(2);
  });

  it('maps a rejected credential to a definite, non-retryable failure', async () => {
    const http = new FakeWecomHttp(() => ({
      status: 200,
      body: { errcode: 40001, errmsg: 'invalid credential' },
    }));

    expect(await providerFor(http).get()).toEqual({
      ok: false,
      code: 'channel_not_configured',
      message: 'WeCom rejected the customer-service credential (errcode 40001)',
      retryable: false,
    });
  });

  it('maps a provider-side failure to a retryable platform-authored one', async () => {
    // Hostile synthetic text in the field the provider controls, naming the very
    // credential and token a caller must never see.
    const hostile = 'system busy: corpsecret=test-kf-secret access_token=test-access-token';
    const http = new FakeWecomHttp(() => ({
      status: 503,
      body: { errcode: -1, errmsg: hostile },
    }));

    const failure = await providerFor(http).get();
    expect(failure).toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom token endpoint rejected the request (errcode -1)',
      retryable: true,
    });
    // The provider's sentence is unbounded text it controls, and this failure
    // reaches API results and log lines documented as platform-authored.
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain(hostile);
    expect(serialized).not.toContain('test-kf-secret');
    expect(serialized).not.toContain('test-access-token');
  });

  it('falls back to the HTTP status when the answer is not a WeCom error document', async () => {
    const http = new FakeWecomHttp(() => ({ status: 502, body: '<html>bad gateway</html>' }));

    expect(await providerFor(http).get()).toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom token endpoint answered with HTTP 502',
      retryable: true,
    });
  });

  it('maps an unreachable endpoint to a retryable failure instead of throwing', async () => {
    const http = new FakeWecomHttp(() => {
      throw new Error('socket hang up');
    });

    expect(await providerFor(http).get()).toEqual({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom token endpoint could not be reached',
      retryable: true,
    });
  });

  it('treats an answer with neither an errcode nor a token as a provider failure', async () => {
    const http = new FakeWecomHttp(() => ({ status: 200, body: { errmsg: 'ok' } }));

    expect(await providerFor(http).get()).toMatchObject({
      ok: false,
      code: 'channel_provider_error',
    });
  });

  it('claims a connection only after a token was actually fetched', async () => {
    const failing = providerFor(
      new FakeWecomHttp(() => ({ status: 200, body: { errcode: 40001 } })),
    );
    expect(await failing.get()).toMatchObject({ ok: false });
    expect(realTransportConnected()).toBe(false);

    const succeeding = providerFor(new FakeWecomHttp(() => tokenAnswer()));
    expect(await succeeding.get()).toMatchObject({ ok: true });
    expect(realTransportConnected()).toBe(true);
  });

  it('authenticates with what the reader says now, not with what it said first', async () => {
    // The reason the credentials are read rather than held: an operator typing
    // a set into the console must take effect without restarting this process.
    let current: WecomCredentialValues = {
      corpId: 'ww-first',
      kfSecret: 'first-secret',
      callbackToken: 'first-token',
      aesKey: 'a'.repeat(43),
      openKfId: 'wk-first',
    };
    const http = new FakeWecomHttp(() => tokenAnswer());
    const provider = providerFor(http, new MemoryWecomTokenCache(), async () => ({
      _tag: 'ready',
      values: current,
      origin: 'console',
    }));

    await provider.get();
    expect(http.requests[0]?.url).toContain('corpid=ww-first');
    expect(http.requests[0]?.url).toContain('corpsecret=first-secret');

    current = { ...current, corpId: 'ww-second', kfSecret: 'second-secret' };
    await provider.get();

    // A snapshot taken in the constructor would still be answering as the first
    // company here, and the first company's token would be served under it.
    expect(http.requests).toHaveLength(2);
    expect(http.requests[1]?.url).toContain('corpid=ww-second');
    expect(http.requests[1]?.url).toContain('corpsecret=second-secret');
  });

  it('acquires a token with a set stored from the console', async () => {
    const http = new FakeWecomHttp(() => tokenAnswer());

    expect(
      await providerFor(
        http,
        new MemoryWecomTokenCache(),
        storedReader({
          corpId: 'ww-console',
          kfSecret: 'secret-from-console',
          callbackToken: 'token-from-console',
          aesKey: 'a'.repeat(43),
          openKfId: 'wk-console',
        }),
      ).get(),
    ).toEqual({ ok: true, value: 'test-access-token' });
    expect(http.requests[0]?.url).toContain('corpid=ww-console');
    expect(http.requests[0]?.url).toContain('corpsecret=secret-from-console');
  });

  it('refuses without a request when the reader has no usable set', async () => {
    const http = new FakeWecomHttp(() => tokenAnswer());
    const provider = providerFor(http, new MemoryWecomTokenCache(), async () => ({
      _tag: 'unconfigured',
      origin: 'console',
      problems: [{ variable: 'WECOM_KF_SECRET', code: 'missing' }],
    }));

    expect(await provider.get()).toEqual({
      ok: false,
      code: 'channel_not_configured',
      message: 'the WeCom customer-service transport is not configured: WECOM_KF_SECRET',
      retryable: false,
    });
    // Not a probe either: there is nothing to prove, and asking WeCom would be
    // a request made with a credential the operator has not finished typing.
    expect(await provider.probe()).toBe(false);
    expect(http.requests).toEqual([]);
  });

  it('withdraws the connection claim once the provider stops answering', async () => {    const http = new FakeWecomHttp(() => tokenAnswer());
    const provider = providerFor(http);
    await provider.get();
    expect(realTransportConnected()).toBe(true);

    http.setHandler(() => {
      throw new Error('socket hang up');
    });
    vi.setSystemTime(new Date(START.getTime() + 8_000_000));
    expect(await provider.get()).toMatchObject({ ok: false });
    expect(realTransportConnected()).toBe(false);
  });
});
