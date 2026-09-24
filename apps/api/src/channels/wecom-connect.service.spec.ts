/**
 * What the console's 连接 button actually does.
 *
 * {@link ChannelsService.connectWecom} is the only writer of a stored WeCom
 * credential and the only caller of the transport's `reconnect`, so these tests
 * drive it through every outcome an operator can be shown and assert the
 * *effect* of each: what was written, what the transport was asked, what the
 * answer says, and — for the refusals — what was left alone. The stored verdict,
 * the binding the connection writes through, and the reader the rest of the
 * application authenticates with are read back here rather than assumed, because
 * "the button returned 200" and "the deployment is connected" are two different
 * claims and only the second one matters.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANNEL_PROVIDER_WECOM,
  InMemoryAuthRepository,
  WECOM_AES_KEY_LENGTH,
  parseAppConfig,
  type AppConfig,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelResult,
  type Member,
  type WeComChannelBinding,
} from '@kefu/core';
import type { WecomCredentialReader } from '@kefu/wecom';
import { ChannelsService, type ChannelsOverview } from './channels.service';
import { MemoryWecomBindingRepository } from './memory-wecom-binding.repository';
import { MemoryWecomCredentialRepository } from './memory-wecom-credential.repository';
import { wecomCredentialReaderOf } from './wecom-credential.source';
import { resetWecomConnectionState } from './wecom-transport';
import type {
  WecomCallbackKind,
  WecomCallbackUrlInput,
  WecomRealTransport,
  WecomSyncPage,
  WecomSyncPullInput,
} from './real-wecom.adapter';
import { TEST_CORP_ID, TEST_OPEN_KF_ID } from '../../test/wecom-callback-support';

/** The tenant the console connects for. */
const TENANT_ID = 'tenant-acme';

/** The five values an operator would type into the form. */
const TYPED = {
  corpId: TEST_CORP_ID,
  kfSecret: 'kf-secret-typed-into-the-console',
  callbackToken: 'callback-token-typed-into-the-console',
  aesKey: 'k'.repeat(WECOM_AES_KEY_LENGTH),
  openKfId: TEST_OPEN_KF_ID,
} as const;

/** The platform administrator who is doing the typing. */
const ADMIN: Member = {
  id: 'u-platform-admin',
  tenantId: null,
  storeId: null,
  role: 'platform_admin',
  username: 'admin',
  displayName: '平台管理员',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const CAPABILITIES: ChannelCapabilities = Object.freeze({
  receiveText: true,
  receiveImage: true,
  sendText: true,
  sendImage: true,
  sendLink: true,
});

/** The stable refusal every capability this spec does not exercise answers with. */
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
 * A transport whose reconnect answer is chosen by the test.
 *
 * The attempt count is kept in a counter the *test* holds rather than on the
 * instance, so a test can read it without having to keep a reference to a fake
 * the builder created — and so it still reads zero on the path where no
 * transport was built at all, which is the one where "never asked" matters most.
 */
class ReconnectableTransport implements WecomRealTransport {
  /**
   * @param reachable - What the next `reconnect` answers.
   * @param attempts - Counter incremented once per reconnect.
   */
  constructor(
    private readonly reachable: boolean,
    private readonly attempts: { count: number },
  ) {}

  async reconnect(): Promise<boolean> {
    this.attempts.count += 1;
    return this.reachable;
  }

  /** Recorded through {@link reconnect} only; the other members are not used. */
  async probeConnection(): Promise<boolean> {
    return this.reachable;
  }

  async verifyCallbackUrl(_input: WecomCallbackUrlInput): Promise<ChannelResult<string>> {
    return unused();
  }

  async readNotification(): Promise<ChannelResult<WecomCallbackKind>> {
    return unused();
  }

  async pullSyncMessages(_input: WecomSyncPullInput): Promise<ChannelResult<WecomSyncPage>> {
    return unused();
  }
}

/**
 * A service over the shared adapter, a transport, its own stores and directory.
 *
 * The credential store, its reader and the binding store are all the *same*
 * in-process objects, exactly as the module composes them: the rules are asked of
 * one directory, and a spec that paired a store with a reader over a different
 * one could report a state the application cannot reach.
 */
function build(options: { readonly reachable?: boolean; readonly noTransport?: boolean } = {}) {
  const config = parseConfig();
  const bindings = new MemoryWecomBindingRepository();
  const credentials = new MemoryWecomCredentialRepository(bindings);
  const reader: WecomCredentialReader = wecomCredentialReaderOf({
    repository: credentials,
    config,
  });
  const reconnects = { count: 0 };
  const transport =
    options.noTransport === true
      ? null
      : new ReconnectableTransport(options.reachable ?? true, reconnects);
  const service = new ChannelsService(
    config,
    ADAPTER,
    transport,
    bindings,
    credentials,
    reader,
    new InMemoryAuthRepository(),
  );
  return { service, bindings, credentials, reader, reconnects };
}

/** Parse the test environment, failing loudly when it will not. */
function parseConfig(): AppConfig {
  const result = parseAppConfig({ APP_ENV: 'test', WECOM_TRANSPORT: 'real' });
  if (result._tag !== 'ok') {
    throw new Error(`the test configuration did not parse: ${result.error.message}`);
  }
  return result.config;
}

/** A refusal assertion that also keeps the failure's type usable. */
function expectFailure(outcome: unknown, expected: Record<string, unknown>): void {
  expect(outcome).toMatchObject({ ok: false, ...expected });
}

/** The overview as the administrator sees it, for the stored verdict. */
function overviewOf(service: ChannelsService): Promise<ChannelsOverview> {
  return service.overview(ADMIN);
}

/** One stored binding, as the store holds it. */
function storedBinding(overrides: Partial<WeComChannelBinding> = {}): WeComChannelBinding {
  return {
    id: 'wecom-binding-1',
    tenantId: TENANT_ID,
    storeId: 'store-acme-flagship',
    corpId: TEST_CORP_ID,
    openKfId: TEST_OPEN_KF_ID,
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    disabledAt: null,
    ...overrides,
  };
}

describe('ChannelsService.connectWecom', () => {
  beforeEach(() => {
    resetWecomConnectionState();
  });

  afterEach(() => {
    resetWecomConnectionState();
  });

  it('stores the typed values, proves them, and answers with the verdict', async () => {
    const { service, credentials, reader, reconnects } = build();

    const outcome = await service.connectWecom({
      tenantId: TENANT_ID,
      values: TYPED,
      updatedBy: ADMIN.id,
    });

    expect(outcome).toMatchObject({
      ok: true,
      value: { connected: true, credentialSource: 'console', verifiedError: null },
    });
    expect(reconnects.count).toBe(1);

    // The load-bearing assertion: the rest of the application now authenticates
    // with what was typed, read back through the reader the transport actually
    // asks — not through the row this test happened to write.
    expect(await reader()).toEqual({ _tag: 'ready', values: TYPED, origin: 'console' });
    const stored = await credentials.readCurrentCredentials();
    expect(stored).toMatchObject({ verifiedError: null });
    expect(stored?.verifiedAt).not.toBeNull();
  });

  it('keeps a set WeCom refused, and says so in the platform’s own words', async () => {
    const { service, credentials, reader } = build({ reachable: false });

    const outcome = await service.connectWecom({
      tenantId: TENANT_ID,
      values: TYPED,
      updatedBy: ADMIN.id,
    });

    // `connected: false` is a `200`: the values were accepted and are in effect.
    // What failed is the connection, and the operator has to be able to tell
    // those apart or the form would invite them to retype a correct secret.
    expect(outcome).toMatchObject({
      ok: true,
      value: { connected: false, credentialSource: 'console' },
    });
    const value = outcome.ok ? outcome.value : undefined;
    // The one sentence the live status uses for the same failure, so the stored
    // verdict and the status line cannot describe it two ways.
    expect(value?.verifiedError).toBe(
      'no access token was returned by enterprise WeChat: the customer-service credential was ' +
        'refused or the endpoint could not be reached',
    );
    expect(value?.verifiedError).not.toContain(TYPED.kfSecret);

    // Stored anyway: a wrong secret is a wrong secret, and refusing to keep the
    // set would leave the operator with no way to correct one field of five.
    expect(await reader()).toMatchObject({ _tag: 'ready', origin: 'console' });
    expect((await credentials.readCurrentCredentials())?.verifiedError).toBe(value?.verifiedError);
  });

  it('refuses an unusable set by naming the fields, and writes nothing', async () => {
    const { service, credentials, reconnects } = build();

    expectFailure(
      await service.connectWecom({
        tenantId: TENANT_ID,
        values: { ...TYPED, aesKey: 'too-short' },
        updatedBy: ADMIN.id,
      }),
      {
        status: 400,
        code: 'bad_request',
        message: 'the WeCom credential is not usable: WECOM_AES_KEY',
      },
    );

    // The fields, never the values: this message reaches a browser.
    expect(await credentials.readCurrentCredentials()).toBeUndefined();
    expect(reconnects.count).toBe(0);
  });

  it('refuses a Mock build rather than storing a set nothing can prove', async () => {
    const { service, credentials, reconnects } = build({ noTransport: true });

    expectFailure(
      await service.connectWecom({ tenantId: TENANT_ID, values: TYPED, updatedBy: ADMIN.id }),
      {
        status: 503,
        code: 'channel_disabled',
        message: 'no real WeCom customer-service transport is bound in this build',
      },
    );
    expect(await credentials.readCurrentCredentials()).toBeUndefined();
    expect(reconnects.count).toBe(0);
  });

  it('refuses a second account over one that is already connected', async () => {
    const { service, credentials, reconnects } = build();
    await service.connectWecom({ tenantId: TENANT_ID, values: TYPED, updatedBy: ADMIN.id });

    expectFailure(
      await service.connectWecom({
        tenantId: TENANT_ID,
        values: { ...TYPED, openKfId: 'wk-a-second-account' },
        updatedBy: ADMIN.id,
      }),
      {
        status: 409,
        code: 'conflict',
        message: 'this deployment is already connected to another customer-service account',
      },
    );

    // The connection that worked is still the one in effect, and the refused
    // attempt never reached the provider.
    expect((await credentials.readCurrentCredentials())?.openKfId).toBe(TEST_OPEN_KF_ID);
    expect(reconnects.count).toBe(1);
  });

  it('binds the account it is connecting, and reuses the binding after that', async () => {
    const { service, bindings } = build();

    const first = await service.connectWecom({
      tenantId: TENANT_ID,
      values: TYPED,
      updatedBy: ADMIN.id,
    });
    expect(first.ok).toBe(true);

    // There is no binding form in the console, so connecting has to create one —
    // and it has to name a store, which the platform's own rule picks rather
    // than the operator.
    const created = await bindings.listBindings();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      tenantId: TENANT_ID,
      corpId: TEST_CORP_ID,
      openKfId: TEST_OPEN_KF_ID,
      status: 'active',
    });
    expect(created[0]?.storeId).not.toBe('');

    // Typing the same account again means 「connect this account」, not 「bind it
    // somewhere else」: the second attempt reuses the row instead of adding one.
    const again = await service.connectWecom({
      tenantId: TENANT_ID,
      values: { ...TYPED, kfSecret: 'a-corrected-secret' },
      updatedBy: ADMIN.id,
    });
    expect(again.ok).toBe(true);
    expect(await bindings.listBindings()).toHaveLength(1);
  });

  it('connects an account that is already bound, without a second row', async () => {
    const { service, bindings, credentials } = build();
    expect(await bindings.createBinding(storedBinding())).toBe(true);

    const outcome = await service.connectWecom({
      tenantId: TENANT_ID,
      values: TYPED,
      updatedBy: ADMIN.id,
    });

    expect(outcome).toMatchObject({ ok: true, value: { bindingId: 'wecom-binding-1' } });
    expect(await bindings.listBindings()).toHaveLength(1);
    expect(await credentials.readCurrentCredentials()).toMatchObject({ bindingId: 'wecom-binding-1' });
  });

  it('reports the stored verdict on the overview, and none before anything is proven', async () => {
    const { service } = build();

    // Nothing stored: no verdict. Not "disconnected" — nothing has been tried.
    expect((await overviewOf(service)).credentialVerdict).toBeNull();

    await service.connectWecom({ tenantId: TENANT_ID, values: TYPED, updatedBy: ADMIN.id });

    const reported = (await overviewOf(service)).credentialVerdict;
    expect(reported).toMatchObject({ connected: true, credentialSource: 'console' });
    expect(reported?.verifiedAt).toBeTruthy();
  });

  it('never returns a typed value', async () => {
    const { service } = build();

    const outcome = await service.connectWecom({
      tenantId: TENANT_ID,
      values: TYPED,
      updatedBy: ADMIN.id,
    });

    // The answer reaches a browser and, on a failure, a log line. Every one of
    // the five values is a credential, and none of them may be in it.
    const serialized = JSON.stringify(outcome);
    for (const secret of [TYPED.kfSecret, TYPED.callbackToken, TYPED.aesKey]) {
      expect(secret.length).toBeGreaterThan(0);
      expect(serialized).not.toContain(secret);
    }
  });
});
