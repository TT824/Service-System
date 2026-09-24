/**
 * What an operator is allowed to read off the channel overview.
 *
 * The overview is the only thing the channel page renders, so these tests drive
 * {@link ChannelsService.overview} through all three modes and both probe
 * outcomes and assert the projection itself: whether a connection was proven,
 * what a failed probe is allowed to say, which callback controls exist, and that
 * nothing credential-shaped or provider-authored reaches the response.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANNEL_PROVIDER_WECOM,
  InMemoryAuthRepository,
  parseAppConfig,
  type AppConfig,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelResult,
  type Member,
  type WeComChannelBinding,
} from '@kefu/core';
import { ChannelDisabledException } from './channel-disabled.exception';
import { ChannelsService, type ChannelsOverview } from './channels.service';
import { MemoryWecomBindingRepository } from './memory-wecom-binding.repository';
import { MemoryWecomCredentialRepository } from './memory-wecom-credential.repository';
import type { WecomBindingRepository } from './wecom-binding.repository';
import { wecomCredentialReaderOf } from './wecom-credential.source';
import { resetWecomConnectionState } from './wecom-transport';
import type {
  WecomCallbackKind,
  WecomCallbackUrlInput,
  WecomRealTransport,
  WecomSyncPage,
  WecomSyncPullInput,
} from './real-wecom.adapter';
import {
  TEST_CALLBACK_TOKEN,
  TEST_ENCODING_AES_KEY,
  TEST_KF_SECRET,
  realWecomConfig,
} from '../../test/wecom-callback-support';

/**
 * Capabilities of a transport that can send and receive text, images and links.
 *
 * `sendImage` is `true` because the real adapter now binds both halves of an
 * image delivery — the temporary-media upload and the `media_id` send — so the
 * overview has to project that claim rather than the old refusal.
 */
const CAPABILITIES: ChannelCapabilities = Object.freeze({
  receiveText: true,
  receiveImage: true,
  sendText: true,
  sendImage: true,
  sendLink: true,
});

/** The stable refusal every operation this spec does not exercise answers with. */
function unused(): ChannelResult<never> {
  return {
    ok: false,
    code: 'channel_disabled',
    message: 'not exercised by this spec',
    retryable: false,
  };
}

/** A bound adapter that only reports its capabilities. */
const ADAPTER: ChannelAdapter = {
  channel: CHANNEL_PROVIDER_WECOM,
  capabilities: CAPABILITIES,
  verifyWebhook: async () => unused(),
  parseInboundMessage: async () => unused(),
  syncMessages: async () => unused(),
  sendMessage: async () => unused(),
  fetchMedia: async () => unused(),
  uploadMedia: async () => unused(),
};

/**
 * A real transport whose probe answer is chosen by the test.
 *
 * `probes` counts the live attempts so a test can prove the overview did not
 * consult a transport it had no reason to consult.
 */
class ProbeableTransport implements WecomRealTransport {
  probes = 0;

  /** @param reachable - What the next probe answers. */
  constructor(private readonly reachable: boolean) {}

  async verifyCallbackUrl(input: WecomCallbackUrlInput): Promise<ChannelResult<string>> {
    void input;
    return unused();
  }

  async probeConnection(): Promise<boolean> {
    this.probes += 1;
    return this.reachable;
  }

  /**
   * Re-check with the *current* credentials.
   *
   * Modelled as a probe rather than as the adapter's real
   * invalidate-then-probe, because what this fake is for is counting how many
   * times the overview consulted a transport — and a reconnect the overview
   * never asks for is one it must not count.
   */
  async reconnect(): Promise<boolean> {
    return this.probeConnection();
  }

  async readNotification(): Promise<ChannelResult<WecomCallbackKind>> {
    return unused();
  }

  async pullSyncMessages(input: WecomSyncPullInput): Promise<ChannelResult<WecomSyncPage>> {
    void input;
    return unused();
  }
}

/**
 * The administrator the overview is read as.
 *
 * A platform administrator acts for no single tenant, so it is the member that
 * sees every binding a store holds — the widest view this service offers, which
 * is the one a projection test has to be able to check.
 */
const PLATFORM_ADMIN: Member = {
  id: 'u-platform-admin',
  tenantId: null,
  storeId: null,
  role: 'platform_admin',
  username: 'admin',
  displayName: '平台管理员',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** A binding store that starts empty, as a fresh deployment's does. */
function emptyBindings(): MemoryWecomBindingRepository {
  return new MemoryWecomBindingRepository();
}

/**
 * One stored binding, as the store holds it.
 *
 * The creation instants are fixed and different, so the "newest first" order the
 * store promises is a fact a test can disprove by reversing it rather than an
 * accident of how fast two rows happened to be written.
 */
function storedBinding(overrides: Partial<WeComChannelBinding> = {}): WeComChannelBinding {
  const openKfId = overrides.openKfId ?? 'wk-account';
  return {
    id: `wecom-binding-${openKfId}`,
    tenantId: 'tenant-acme',
    storeId: 'store-acme-flagship',
    corpId: 'ww-acme',
    openKfId,
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    disabledAt: null,
    ...overrides,
  };
}

/** A service over the shared adapter, a chosen transport and empty bindings. */
function serviceOf(config: AppConfig, transport: WecomRealTransport | null): ChannelsService {
  return serviceOver(config, transport, emptyBindings());
}

/**
 * The same service over one named binding store.
 *
 * The credential store and its reader are built over the *same* bindings,
 * because that is what the production module does: the credential rules are
 * asked of the binding table, and a spec that paired them differently could
 * report a state the application cannot reach. Nothing here writes credentials —
 * this suite is about the projection, and a deployment that has never connected
 * anything is exactly the one that reports no stored verdict.
 */
function serviceOver(
  config: AppConfig,
  transport: WecomRealTransport | null,
  bindings: WecomBindingRepository,
): ChannelsService {
  const credentials = new MemoryWecomCredentialRepository(bindings);
  return new ChannelsService(
    config,
    ADAPTER,
    transport,
    bindings,
    credentials,
    wecomCredentialReaderOf({ repository: credentials, config }),
    new InMemoryAuthRepository(),
  );
}

/** Parse a configuration from an environment, failing loudly when it will not. */
function configOf(env: Readonly<Record<string, string>>): AppConfig {
  const result = parseAppConfig(env);
  if (result._tag !== 'ok') {
    throw new Error(`the test configuration did not parse: ${result.error.message}`);
  }
  return result.config;
}

/** The single wecom provider an overview reports. */
function wecomOf(overview: ChannelsOverview): ChannelsOverview['providers'][number] {
  const provider = overview.providers.find((entry) => entry.provider === 'wecom');
  if (provider === undefined) {
    throw new Error('the overview reported no wecom provider');
  }
  return provider;
}

describe('channel overview visibility', () => {
  beforeEach(() => {
    resetWecomConnectionState();
  });

  afterEach(() => {
    resetWecomConnectionState();
  });

  it('reports the Mock channel as operational and never as a live connection', async () => {
    const service = serviceOf(configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' }), null);

    const wecom = wecomOf(await service.overview(PLATFORM_ADMIN));

    expect(wecom).toMatchObject({
      mode: 'mock',
      enableRequested: false,
      credentialsPresent: false,
      operational: true,
      realTransportConnected: false,
      lastConnectionError: null,
      missingCredentials: [],
      capabilities: CAPABILITIES,
    });
  });

  it('turns the connection claim on only after a successful live probe', async () => {
    const transport = new ProbeableTransport(true);
    const service = serviceOf(realWecomConfig(), transport);

    const wecom = wecomOf(await service.overview(PLATFORM_ADMIN));

    expect(transport.probes).toBe(1);
    expect(wecom).toMatchObject({
      mode: 'real',
      credentialsPresent: true,
      realTransportConnected: true,
      lastConnectionError: null,
    });
  });

  it('records a failed probe as a safe, platform-authored diagnostic', async () => {
    const transport = new ProbeableTransport(false);
    const service = serviceOf(realWecomConfig(), transport);
    const before = Date.now();

    const wecom = wecomOf(await service.overview(PLATFORM_ADMIN));
    const error = wecom.lastConnectionError;

    expect(wecom.realTransportConnected).toBe(false);
    expect(error).not.toBeNull();
    expect(error?.code).toBe('wecom_probe_failed');
    expect(error?.message).toContain('no access token was returned');
    // The failure carries the instant it was observed, so an operator can tell a
    // stale error from the one the refresh they just pressed produced.
    const at = Date.parse(error?.at ?? '');
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThanOrEqual(before - 1_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('withdraws a recorded failure as soon as a later probe succeeds', async () => {
    const failing = serviceOf(realWecomConfig(), new ProbeableTransport(false));
    expect(wecomOf(await failing.overview(PLATFORM_ADMIN)).lastConnectionError).not.toBeNull();

    const recovering = serviceOf(realWecomConfig(), new ProbeableTransport(true));
    const wecom = wecomOf(await recovering.overview(PLATFORM_ADMIN));

    expect(wecom.realTransportConnected).toBe(true);
    expect(wecom.lastConnectionError).toBeNull();
  });

  it('names the missing variables instead of a probe failure when the boot is unconfigured', async () => {
    const transport = new ProbeableTransport(false);
    const service = serviceOf(
      configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'real', WECOM_ENABLED: 'true' }),
      transport,
    );

    const wecom = wecomOf(await service.overview(PLATFORM_ADMIN));

    expect(wecom).toMatchObject({
      mode: 'disabled',
      enableRequested: true,
      credentialsPresent: false,
      operational: false,
      realTransportConnected: false,
      // Nothing was attempted, so there is no connection error to report: the
      // actionable fact is the variable list.
      lastConnectionError: null,
    });
    expect(wecom.missingCredentials.length).toBeGreaterThan(0);
    // A transport that is refused on configuration must not be probed at all.
    expect(transport.probes).toBe(0);
  });

  it('keeps the credentials and the provider vocabulary out of the overview', async () => {
    const service = serviceOf(realWecomConfig(), new ProbeableTransport(false));

    const serialized = JSON.stringify(await service.overview(PLATFORM_ADMIN));

    for (const secret of [TEST_KF_SECRET, TEST_CALLBACK_TOKEN, TEST_ENCODING_AES_KEY]) {
      expect(secret.length).toBeGreaterThan(0);
      expect(serialized).not.toContain(secret);
    }
    for (const providerWord of ['errcode', 'errmsg', 'access_token', 'cgi-bin']) {
      expect(serialized).not.toContain(providerWord);
    }
  });

  it('withholds diagnostic Mock controls from the product overview', async () => {
    const mock = wecomOf(
      await serviceOf(configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' }), null).overview(
        PLATFORM_ADMIN,
      ),
    );
    const real = wecomOf(
      await serviceOf(realWecomConfig(), new ProbeableTransport(true)).overview(PLATFORM_ADMIN),
    );
    const disabled = wecomOf(
      await serviceOf(
        configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'real' }),
        new ProbeableTransport(false),
      ).overview(PLATFORM_ADMIN),
    );

    expect(mock.mockControls).toBeNull();
    expect(real.mockControls).toBeNull();
    expect(disabled.mockControls).toBeNull();
    expect(real.callbackVerifyPath).toBe('/api/v1/channels/wecom/callback');
  });

  it('reports what the bounded loop supports without claiming an unproven connection', async () => {
    const wecom = wecomOf(
      await serviceOf(configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' }), null).overview(
        PLATFORM_ADMIN,
      ),
    );

    // Capabilities are the transport's, not the provider's brochure: what the
    // overview publishes is exactly the bound adapter's own claim, and image
    // sending is on it only because upload and the media-id send are both wired.
    expect(wecom.capabilities).toEqual(CAPABILITIES);
    expect(wecom.capabilities.sendImage).toBe(true);
  });

  it('still refuses to push messages to real customers in every mode', async () => {
    const services = [
      serviceOf(configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' }), null),
      serviceOf(realWecomConfig(), new ProbeableTransport(true)),
      serviceOf(configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'real' }), null),
    ];

    for (const service of services) {
      expect(() => service.syncMessages()).toThrow(ChannelDisabledException);
    }
  });

  it('narrows the bindings it reports to the scope the reader administers', async () => {
    const store = emptyBindings();
    const mine = storedBinding({
      tenantId: 'tenant-acme',
      openKfId: 'wk-mine',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    });
    const theirs = storedBinding({
      tenantId: 'tenant-beta',
      storeId: 'store-beta-official',
      openKfId: 'wk-theirs',
    });
    expect(await store.createBinding(mine)).toBe(true);
    expect(await store.createBinding(theirs)).toBe(true);

    const service = serviceOver(configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' }), null, store);

    // A platform administrator acts for no tenant, so it is the one reader that
    // sees both; a tenant's administrator sees the one inside its own scope and
    // must not learn the other exists; a seat sees none, because which store a
    // provider account writes into is not a seat's fact.
    const every = await service.overview(PLATFORM_ADMIN);
    expect(every.bindings.map((binding) => binding.openKfId)).toEqual(['wk-mine', 'wk-theirs']);

    const tenantAdmin = await service.overview({ ...PLATFORM_ADMIN, tenantId: 'tenant-acme' });
    expect(tenantAdmin.bindings.map((binding) => binding.openKfId)).toEqual(['wk-mine']);

    const seat = await service.overview({
      ...PLATFORM_ADMIN,
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      role: 'agent',
    });
    expect(seat.bindings).toEqual([]);
  });

  it('reports a binding the platform wrote, so the console reads what a callback resolves', async () => {
    // The overview and the callback path read one store, so a binding that was
    // just written is what the console shows *and* what an inbound callback on
    // that account would resolve — not two accounts of the same fact.
    const store = emptyBindings();
    const service = serviceOver(configOf({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' }), null, store);

    const created = await service.createBinding({
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      corpId: 'ww-acme',
      openKfId: 'wk-live',
    });
    expect(created.ok).toBe(true);

    expect((await service.overview(PLATFORM_ADMIN)).bindings.map((b) => b.openKfId)).toEqual([
      'wk-live',
    ]);
    expect(await store.findActiveBinding('ww-acme', 'wk-live')).toMatchObject({
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
    });
  });
});
