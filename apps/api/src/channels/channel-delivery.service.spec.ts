import { describe, expect, it } from 'vitest';
import {
  CHANNEL_PROVIDER_WECOM,
  KefuStore,
  createUnifiedMessage,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelOutboxRecord,
  type ChannelResult,
  type Conversation,
  type Member,
  type Message,
  type SendMessageInput,
  type SendMessageResult,
  type UnifiedMessage,
  type WebhookVerificationInput,
  type WebhookVerificationResult,
} from '@kefu/core';
import { ChannelDeliveryService } from './channel-delivery.service';
import type { QuotaWindowKey } from './channel-reliability.repository';
import { MemoryChannelReliabilityRepository } from './memory-channel-reliability.repository';
import { MemoryPlatformRepository } from '../platform/memory-platform.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { JsonLogger } from '../logging/json-logger';
import { MessageMediaService } from '../media/media.service';
import { MemoryMediaStorage } from '../../test/media-storage-support';

/**
 * A logger that writes nothing.
 *
 * `fatal` is the highest level, so warn and error lines — which several of these
 * paths emit by design — are suppressed rather than printed over the results.
 */
function quietLogger(): JsonLogger {
  return new JsonLogger('fatal');
}

/** The member a callback is authorized for; only its scope is ever read. */
const MEMBER: Member = {
  id: 'member-agent-1',
  tenantId: 'tenant-acme',
  storeId: 'store-acme-flagship',
  role: 'agent',
  username: 'agent-1',
  displayName: '客服一号',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** The raw callback bytes, kept exactly as the transport delivered them. */
const RAW_BODY = '<xml><Encrypt><![CDATA[CIPHERTEXT]]></Encrypt></xml>';

/**
 * An adapter that records what the delivery service handed it.
 *
 * Only the verification path is exercised here, so everything else refuses to
 * run: a test that reaches another operation is a test that proved the wrong
 * thing, and it should fail loudly rather than pass quietly.
 */
class RecordingAdapter implements ChannelAdapter {
  readonly channel = CHANNEL_PROVIDER_WECOM;
  readonly capabilities: ChannelCapabilities = {
    receiveText: true,
    receiveImage: true,
    sendText: true,
    sendImage: false,
    sendLink: true,
  };
  readonly verifications: WebhookVerificationInput[] = [];

  /** Every media id the delivery service asked this transport to fetch. */
  readonly mediaFetches: string[] = [];

  /**
   * The answer `fetchMedia` gives.
   *
   * Defaults to a refusal rather than to invented bytes: a message this double
   * did not mean to carry a picture for would otherwise be stored as one, and a
   * test would pass on a picture nobody scripted.
   */
  mediaAnswer: ChannelResult<{ readonly mimeType: string; readonly bytes: Uint8Array }> = {
    ok: false,
    code: 'channel_invalid_request',
    message: 'the media fetch was not scripted by this double',
    retryable: false,
  };

  /**
   * The answer `parseInboundMessage` gives, writable after construction so a
   * test can keep one adapter per case without a second constructor shape.
   */
  parserAnswer: ChannelResult<UnifiedMessage> = {
    ok: false,
    code: 'channel_invalid_request',
    message: 'the callback payload was not parsed by this double',
    retryable: false,
  };

  /**
   * @param verification - The answer `verifyWebhook` gives.
   */
  constructor(private readonly verification: ChannelResult<WebhookVerificationResult>) {}

  /** @inheritdoc */
  async verifyWebhook(
    input: WebhookVerificationInput,
  ): Promise<ChannelResult<WebhookVerificationResult>> {
    this.verifications.push(input);
    return this.verification;
  }

  /** @inheritdoc */
  async parseInboundMessage(): Promise<ChannelResult<UnifiedMessage>> {
    return this.parserAnswer;
  }

  /** @inheritdoc */
  async syncMessages(): Promise<
    ChannelResult<{ readonly messages: ReadonlyArray<UnifiedMessage> }>
  > {
    throw new Error('syncMessages is not part of this test');
  }

  /** @inheritdoc */
  async sendMessage(_input: SendMessageInput): Promise<ChannelResult<SendMessageResult>> {
    throw new Error('sendMessage is not part of this test');
  }

  /** @inheritdoc */
  async fetchMedia(input: {
    readonly mediaId: string;
  }): Promise<ChannelResult<{ readonly mimeType: string; readonly bytes: Uint8Array }>> {
    this.mediaFetches.push(input.mediaId);
    return this.mediaAnswer;
  }

  /** @inheritdoc */
  async uploadMedia(): Promise<ChannelResult<{ readonly mediaId: string }>> {
    throw new Error('uploadMedia is not part of this test');
  }
}

/** A delivery service over the recording adapter and the in-process stores. */
function serviceWith(adapter: RecordingAdapter): ChannelDeliveryService {
  const platform = new MemoryPlatformRepository(new KefuStore());
  return new ChannelDeliveryService(
    platform,
    new MemoryChannelReliabilityRepository(),
    adapter,
    new RealtimeService(),
    new MessageMediaService(platform, new MemoryMediaStorage(), quietLogger()),
    quietLogger(),
  );
}

/**
 * The same service, with the stores kept so a test can assert what was — or,
 * for every refused provider callback, was not — written.
 *
 * The publisher is kept as well, so a test can assert which frames an ingest
 * announced: for this slice, "nothing was written" and "nothing was announced"
 * are the same claim about different readers. The object store is kept for the
 * same reason: a picture that was downloaded but not stored is a message whose
 * media column must stay empty.
 */
function providerHarness(adapter: RecordingAdapter): {
  readonly service: ChannelDeliveryService;
  readonly platform: MemoryPlatformRepository;
  readonly reliability: MemoryChannelReliabilityRepository;
  readonly realtime: RealtimeService;
  readonly storage: MemoryMediaStorage;
} {
  const platform = new MemoryPlatformRepository(new KefuStore());
  const reliability = new MemoryChannelReliabilityRepository();
  const realtime = new RealtimeService();
  const storage = new MemoryMediaStorage();
  return {
    service: new ChannelDeliveryService(
      platform,
      reliability,
      adapter,
      realtime,
      new MessageMediaService(platform, storage, quietLogger()),
      quietLogger(),
    ),
    platform,
    reliability,
    realtime,
    storage,
  };
}

/** The tenant and store the seeded platform directory already knows. */
const KNOWN_TENANT = 'tenant-acme';
const KNOWN_STORE = 'store-acme-flagship';

/** The external customer every provider callback in this block belongs to. */
const CUSTOMER = 'wm-customer-provider-1';

/** One callback the recording adapter maps, as the transport would have. */
function mappedCallback(overrides: {
  readonly tenantId?: string;
  readonly storeId?: string;
  readonly externalCustomerId?: string;
}): UnifiedMessage {
  return createUnifiedMessage({
    channel: CHANNEL_PROVIDER_WECOM,
    externalEventId: 'event-provider-1',
    tenantId: overrides.tenantId ?? KNOWN_TENANT,
    storeId: overrides.storeId ?? KNOWN_STORE,
    externalCustomerId: overrides.externalCustomerId ?? CUSTOMER,
    externalConversationId: `wkTEST0001:${CUSTOMER}`,
    externalMessageId: 'message-provider-1',
    direction: 'inbound',
    messageType: 'text',
    content: '请问什么时候发货？',
    dedupKey: 'wecom:message-provider-1',
    receivedAt: '2026-01-01T00:00:00.000Z',
  });
}

/**
 * The conversations of the seeded tenant that mention one external customer.
 *
 * The kernel store seeds conversations of its own, so "nothing was written" is
 * asserted against the identifiers this block owns rather than against an empty
 * table.
 */
async function conversationsFor(
  harness: { readonly platform: MemoryPlatformRepository },
  tenantId: string,
  externalCustomerId: string,
): Promise<ReadonlyArray<Conversation>> {
  const conversations = await harness.platform.listConversations(tenantId);
  return conversations.filter(
    (conversation) => conversation.externalCustomerId === externalCustomerId,
  );
}

/** The rejected-signature answer the recording adapter can give. */
const REJECTED: ChannelResult<WebhookVerificationResult> = {
  ok: false,
  code: 'channel_invalid_request',
  message: 'the callback msg_signature was rejected',
  retryable: false,
};

describe('ChannelDeliveryService callback verification', () => {
  it('hands the adapter the signature triple and the untouched raw bytes', async () => {
    const adapter = new RecordingAdapter({ ok: true, value: { verified: true } });
    const service = serviceWith(adapter);

    const outcome = await service.ingestWebhook({
      member: MEMBER,
      tenantId: 'tenant-acme',
      signature: 'signature-1',
      timestamp: '1700000000',
      nonce: 'nonce-1',
      rawBody: RAW_BODY,
    });

    // The adapter refused the payload, so the callback stops at the parse step
    // — which is exactly what proves verification ran with the real values.
    expect(outcome).toMatchObject({ ok: false, status: 400, code: 'bad_request' });
    expect(adapter.verifications).toEqual([
      {
        channel: 'wecom',
        signature: 'signature-1',
        timestamp: '1700000000',
        nonce: 'nonce-1',
        rawBody: RAW_BODY,
      },
    ]);
  });

  it('treats an absent timestamp or nonce as absent rather than inventing one', async () => {
    const adapter = new RecordingAdapter({ ok: true, value: { verified: true } });
    const service = serviceWith(adapter);

    await service.ingestWebhook({
      member: MEMBER,
      tenantId: 'tenant-acme',
      signature: 'signature-1',
      rawBody: RAW_BODY,
    });

    expect(adapter.verifications[0]).toMatchObject({ timestamp: null, nonce: null });
  });

  it('answers a rejected signature with the stable unauthorized envelope', async () => {
    const adapter = new RecordingAdapter(REJECTED);
    const service = serviceWith(adapter);

    expect(
      await service.ingestWebhook({
        member: MEMBER,
        tenantId: 'tenant-acme',
        signature: null,
        timestamp: '1700000000',
        nonce: 'nonce-1',
        rawBody: RAW_BODY,
      }),
    ).toEqual({ ok: false, status: 401, code: 'unauthorized', message: REJECTED.message });
  });

  it('forwards the same triple on the status callback path', async () => {
    const adapter = new RecordingAdapter(REJECTED);
    const service = serviceWith(adapter);

    const outcome = await service.applyStatusCallback({
      member: MEMBER,
      tenantId: 'tenant-acme',
      signature: 'signature-2',
      timestamp: '1700000123',
      nonce: 'nonce-2',
      rawBody: '{"deliveryId":"delivery-1","status":"delivered"}',
    });

    expect(outcome).toMatchObject({ ok: false, status: 401, code: 'unauthorized' });
    expect(adapter.verifications).toEqual([
      {
        channel: 'wecom',
        signature: 'signature-2',
        timestamp: '1700000123',
        nonce: 'nonce-2',
        rawBody: '{"deliveryId":"delivery-1","status":"delivered"}',
      },
    ]);
  });
});

/**
 * The provider-authenticated inbound path.
 *
 * A real provider callback carries no platform session, so this path takes no
 * member and no caller tenant: the signature is the credential and the scope the
 * adapter resolved is the identity. Every test here asserts *both* halves — the
 * refusal the caller sees and the absence of a write — because "refused" and
 * "refused without writing" are different claims and only the second one is the
 * security property.
 */
describe('ChannelDeliveryService provider-authenticated callbacks', () => {
  it('refuses a callback the adapter does not authenticate, and writes nothing', async () => {
    const adapter = new RecordingAdapter(REJECTED);
    const harness = providerHarness(adapter);

    const outcome = await harness.service.ingestProviderWebhook({
      signature: null,
      timestamp: '1700000000',
      nonce: 'nonce-1',
      rawBody: RAW_BODY,
    });

    expect(outcome).toEqual({
      ok: false,
      status: 401,
      code: 'unauthorized',
      message: REJECTED.message,
    });
    expect(adapter.verifications[0]).toMatchObject({ signature: null, rawBody: RAW_BODY });
    expect(
      await harness.reliability.getInboundEvent(KNOWN_TENANT, 'event-provider-1'),
    ).toBeUndefined();
    expect(await conversationsFor(harness, KNOWN_TENANT, CUSTOMER)).toEqual([]);
  });

  it('refuses an unbound provider account with the stable not-configured failure', async () => {
    const adapter = new RecordingAdapter({ ok: true, value: { verified: true } });
    adapter.parserAnswer = {
      ok: false,
      code: 'channel_not_configured',
      message: 'the WeCom customer-service callback is not bound to a platform tenant/store yet',
      retryable: false,
    };
    const harness = providerHarness(adapter);

    const outcome = await harness.service.ingestProviderWebhook({
      signature: 'signature-1',
      timestamp: '1700000000',
      nonce: 'nonce-1',
      rawBody: RAW_BODY,
    });

    // The provider's own refusal code survives onto the HTTP edge as
    // `503 channel_not_configured` — the same projection the callback URL
    // handshake uses — and never as a caller mistake or a generic outage.
    expect(outcome).toMatchObject({ ok: false, status: 503, code: 'channel_not_configured' });
    expect(await conversationsFor(harness, KNOWN_TENANT, CUSTOMER)).toEqual([]);
  });

  it('refuses a resolved scope the platform directory does not know, and writes nothing', async () => {
    const adapter = new RecordingAdapter({ ok: true, value: { verified: true } });
    adapter.parserAnswer = {
      ok: true,
      value: mappedCallback({ tenantId: 'tenant-ghost', storeId: 'store-ghost' }),
    };
    const harness = providerHarness(adapter);

    const outcome = await harness.service.ingestProviderWebhook({
      signature: 'signature-1',
      timestamp: '1700000000',
      nonce: 'nonce-1',
      rawBody: RAW_BODY,
    });

    expect(outcome).toMatchObject({ ok: false, status: 503, code: 'channel_not_configured' });
    // Neither the receipt nor the business data exists: the binding resolved to
    // a scope the platform cannot verify, so nothing downstream of it ran.
    expect(
      await harness.reliability.getInboundEvent('tenant-ghost', 'event-provider-1'),
    ).toBeUndefined();
    expect(await harness.platform.getTenant('tenant-ghost')).toBeUndefined();
    expect(await harness.platform.listConversations('tenant-ghost')).toEqual([]);
  });

  it('projects a not-configured transport as channel_not_configured rather than a caller mistake', async () => {
    const adapter = new RecordingAdapter({
      ok: false,
      code: 'channel_not_configured',
      message: 'the WeCom customer-service transport is not configured: WECOM_KF_SECRET',
      retryable: false,
    });
    const harness = providerHarness(adapter);

    const outcome = await harness.service.ingestProviderWebhook({
      signature: 'signature-1',
      timestamp: '1700000000',
      nonce: 'nonce-1',
      rawBody: RAW_BODY,
    });

    // The same projection the callback URL handshake answers with: a deployment
    // that never configured the channel did not fail to authenticate, and its
    // own stable code is what the error envelope has to carry.
    expect(outcome).toEqual({
      ok: false,
      status: 503,
      code: 'channel_not_configured',
      message: 'the WeCom customer-service transport is not configured: WECOM_KF_SECRET',
    });
    expect(await conversationsFor(harness, KNOWN_TENANT, CUSTOMER)).toEqual([]);
  });

  it('keeps a provider failure on the gateway mapping rather than calling it a configuration gap', async () => {
    const adapter = new RecordingAdapter({
      ok: false,
      code: 'channel_provider_error',
      message: 'the WeCom verification endpoint could not be reached',
      retryable: true,
    });
    const harness = providerHarness(adapter);

    const outcome = await harness.service.ingestProviderWebhook({
      signature: 'signature-1',
      timestamp: '1700000000',
      nonce: 'nonce-1',
      rawBody: RAW_BODY,
    });

    expect(outcome).toMatchObject({ ok: false, status: 502, code: 'bad_gateway' });
    expect(await conversationsFor(harness, KNOWN_TENANT, CUSTOMER)).toEqual([]);
  });

  it('ingests a signed callback whose resolved scope the platform knows, and replays idempotently', async () => {
    const adapter = new RecordingAdapter({ ok: true, value: { verified: true } });
    adapter.parserAnswer = { ok: true, value: mappedCallback({}) };
    const harness = providerHarness(adapter);
    const input = {
      signature: 'signature-1',
      timestamp: '1700000000',
      nonce: 'nonce-1',
      rawBody: RAW_BODY,
    } as const;

    const messagesBefore = (await harness.platform.listMessages(KNOWN_TENANT)).length;

    const first = await harness.service.ingestProviderWebhook(input);
    expect(first).toMatchObject({
      ok: true,
      value: { status: 'processed', created: true, eventId: 'event-provider-1' },
    });
    expect(await conversationsFor(harness, KNOWN_TENANT, CUSTOMER)).toHaveLength(1);
    expect(await harness.platform.listMessages(KNOWN_TENANT)).toHaveLength(messagesBefore + 1);

    const replay = await harness.service.ingestProviderWebhook(input);
    expect(replay).toMatchObject({
      ok: true,
      value: { status: 'duplicate', created: false, eventId: 'event-provider-1' },
    });
    // The replay returns the original result and writes nothing a second time,
    // which is the same contract the platform-identity path has.
    expect(await harness.platform.listMessages(KNOWN_TENANT)).toHaveLength(messagesBefore + 1);
  });
});

describe('ChannelDeliveryService inbound media', () => {
  /**
   * One image callback, as the transport would have mapped it.
   *
   * `media` is what a real mapper fills in for an image message — the provider's
   * handle rather than the bytes, which is all a callback carries.
   */
  function imageCallback(): UnifiedMessage {
    return createUnifiedMessage({
      channel: CHANNEL_PROVIDER_WECOM,
      externalEventId: 'event-image-1',
      tenantId: KNOWN_TENANT,
      storeId: KNOWN_STORE,
      externalCustomerId: CUSTOMER,
      externalConversationId: `wkTEST0001:${CUSTOMER}`,
      externalMessageId: 'message-image-1',
      direction: 'inbound',
      messageType: 'image',
      content: '[图片]',
      dedupKey: 'wecom:message-image-1',
      media: { mediaId: 'MEDIA_ID_1', mimeType: 'image/png' },
      receivedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  /** The one message this block wrote, as the repository now holds it. */
  async function ingestedMessage(harness: {
    readonly platform: MemoryPlatformRepository;
  }): Promise<Message> {
    const messages = (await harness.platform.listMessages(KNOWN_TENANT)).filter(
      (message) => message.messageType === 'image',
    );
    expect(messages).toHaveLength(1);
    return messages[0] as Message;
  }

  /** One authenticated callback carrying {@link imageCallback}. */
  function harnessFor(
    answer: ChannelResult<{ readonly mimeType: string; readonly bytes: Uint8Array }>,
  ): {
    readonly adapter: RecordingAdapter;
    readonly harness: ReturnType<typeof providerHarness>;
  } {
    const adapter = new RecordingAdapter({ ok: true, value: { verified: true } });
    adapter.parserAnswer = { ok: true, value: imageCallback() };
    adapter.mediaAnswer = answer;
    return { adapter, harness: providerHarness(adapter) };
  }

  const CALLBACK = {
    signature: 'signature-1',
    timestamp: '1700000000',
    nonce: 'nonce-1',
    rawBody: RAW_BODY,
  } as const;

  it('stores the picture a customer sent and points the message at it', async () => {
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const { adapter, harness } = harnessFor({
      ok: true,
      value: { mimeType: 'image/png', bytes: image },
    });

    const result = await harness.service.ingestProviderWebhook(CALLBACK);
    expect(result).toMatchObject({ ok: true, value: { status: 'processed', created: true } });

    // The provider's handle, not the message id: the download is addressed by
    // what the callback carried.
    expect(adapter.mediaFetches).toEqual(['MEDIA_ID_1']);

    const message = await ingestedMessage(harness);
    // The two nulls are part of the assertion: what the customer sent is an
    // unnamed picture whose provider handle is a copy that expires in days, and
    // both absences are recorded rather than left as `undefined`.
    expect(message.media).toEqual({
      key: `tenants/${KNOWN_TENANT}/messages/${message.id}`,
      mimeType: 'image/png',
      bytes: image.byteLength,
      name: null,
      providerMediaId: null,
    });
    // The bytes under that key are the ones the provider gave, which is what
    // makes the reference a fact rather than a promise.
    expect(harness.storage.objects.get(message.media?.key ?? '')?.bytes).toEqual(image);
    expect(harness.storage.writes).toEqual([`tenants/${KNOWN_TENANT}/messages/${message.id}`]);
  });

  it('keeps the message when the picture cannot be fetched, and leaves it with no media', async () => {
    const { adapter, harness } = harnessFor({
      ok: false,
      code: 'channel_provider_error',
      message: 'the media download was refused',
      retryable: false,
    });

    const result = await harness.service.ingestProviderWebhook(CALLBACK);

    // The callback is still answered as processed: the message is the customer's
    // whether or not the platform managed to keep the picture.
    expect(result).toMatchObject({ ok: true, value: { status: 'processed', created: true } });
    expect(adapter.mediaFetches).toEqual(['MEDIA_ID_1']);
    expect((await ingestedMessage(harness)).media).toBeNull();
    expect(harness.storage.writes).toEqual([]);
  });

  it('leaves a text message alone rather than asking the provider for media', async () => {
    const adapter = new RecordingAdapter({ ok: true, value: { verified: true } });
    adapter.parserAnswer = { ok: true, value: mappedCallback({}) };
    const harness = providerHarness(adapter);

    await harness.service.ingestProviderWebhook(CALLBACK);

    expect(adapter.mediaFetches).toEqual([]);
    expect(harness.storage.writes).toEqual([]);
  });
});

/**
 * An adapter that runs a hook while a send is in flight.
 *
 * This API sends a reply inline rather than waiting for the Worker, and the
 * state the outbox entry is in during that round trip — `pending`, lease free —
 * is exactly what the Worker's poll takes. The duplicate that would cause is
 * concurrent, so a test has to look *during* the send rather than after it:
 * `sendMessage` claims the entry the way the Worker would, before it answers.
 */
class ObservableSendAdapter extends RecordingAdapter {
  /** Answers sent, so a test can tell "not called" from "called and failed". */
  sendCount = 0;

  /** What the Worker-shaped claim found mid-send; `'not-attempted'` if never run. */
  workerClaimDuringSend: unknown = 'not-attempted';

  /**
   * The entry that claim contended for.
   *
   * Kept so a test can prove the claim was refused by a *live lease* rather than
   * by the entry not existing — a missing entry is refused too, and would let
   * the duplicate-send test pass while proving nothing.
   */
  workerClaimEntry: ChannelOutboxRecord | undefined;

  /**
   * @param reliability - The same store the service leases the entry in, so the
   *   hook contends for the real lease rather than a copy of it.
   */
  constructor(private readonly reliability: MemoryChannelReliabilityRepository) {
    super({ ok: true, value: { verified: true } });
  }

  /** @inheritdoc */
  override async sendMessage(input: SendMessageInput): Promise<ChannelResult<SendMessageResult>> {
    this.sendCount += 1;
    // `correlationId` is the delivery id — the same key the Worker looks the
    // entry up by, so this hook contends for the entry genuinely.
    const entry = await this.reliability.getOutboxByDelivery(input.tenantId, input.correlationId);
    this.workerClaimEntry = entry;
    this.workerClaimDuringSend = await this.reliability.claimOutboxForSend({
      tenantId: input.tenantId,
      outboxId: entry?.id ?? 'missing',
      owner: 'worker',
      now: new Date().toISOString(),
      leaseMs: 60_000,
    });
    return { ok: true, value: { externalMessageId: 'external-send-1' } };
  }
}

/** The outbound half of the loop: a store, an adapter and the service over them. */
function outboundHarness(): {
  readonly service: ChannelDeliveryService;
  readonly platform: MemoryPlatformRepository;
  readonly reliability: MemoryChannelReliabilityRepository;
  readonly adapter: ObservableSendAdapter;
} {
  const platform = new MemoryPlatformRepository(new KefuStore());
  const reliability = new MemoryChannelReliabilityRepository();
  const adapter = new ObservableSendAdapter(reliability);
  return {
    service: new ChannelDeliveryService(
      platform,
      reliability,
      adapter,
      new RealtimeService(),
      new MessageMediaService(platform, new MemoryMediaStorage(), quietLogger()),
      quietLogger(),
    ),
    platform,
    reliability,
    adapter,
  };
}

/** The reply-window key of the customer every case here replies to. */
function windowKeyOf(storeId: string = KNOWN_STORE): QuotaWindowKey {
  return {
    tenantId: KNOWN_TENANT,
    storeId,
    channel: CHANNEL_PROVIDER_WECOM,
    externalCustomerId: CUSTOMER,
  };
}

describe('ChannelDeliveryService outbox lease', () => {
  /** Seed one inbound message so there is a conversation and a message to reply to. */
  async function seedInbound(
    platform: MemoryPlatformRepository,
  ): Promise<{ readonly conversation: Conversation; readonly message: Message }> {
    const ingested = await platform.ingestInbound({
      tenantId: KNOWN_TENANT,
      storeId: KNOWN_STORE,
      channel: CHANNEL_PROVIDER_WECOM,
      externalCustomerId: CUSTOMER,
      externalConversationId: 'wm-conversation-lease-1',
      content: '在吗',
    });
    return { conversation: ingested.conversation, message: ingested.message };
  }

  it('holds the send lease for the whole provider round trip, so the Worker cannot send the same reply', async () => {
    const harness = outboundHarness();
    const { conversation, message } = await seedInbound(harness.platform);
    const now = new Date().toISOString();
    await harness.reliability.openQuotaWindow(windowKeyOf(), now);

    const delivery = await harness.service.dispatch(conversation, message);

    expect(delivery.status).toBe('sent');
    expect(harness.adapter.sendCount).toBe(1);
    // The claim contended for a real entry, so the refusal below is the lease
    // talking and not a lookup that found nothing.
    expect(harness.adapter.workerClaimEntry).toMatchObject({ status: 'pending' });
    // The claim the Worker's poll would have made, taken mid-send, found the
    // entry leased — which is the whole reason the reply is not sent twice.
    expect(harness.adapter.workerClaimDuringSend).toBeUndefined();
    // And once the send is done the entry is `dispatched`, so a later Worker
    // pass cannot take it either: the lease is released, not merely expired.
    expect(await harness.reliability.getOutboxByDelivery(KNOWN_TENANT, delivery.id)).toMatchObject({
      status: 'dispatched',
    });
  });

  it('gives the lease back when a reply is refused before the provider is called', async () => {
    const harness = outboundHarness();
    const { conversation, message } = await seedInbound(harness.platform);
    // No window is opened, so the reply is refused with `window_missing`.
    const delivery = await harness.service.dispatch(conversation, message);

    expect(delivery).toMatchObject({
      status: 'pending',
      failureCode: 'window_missing',
      retryable: true,
    });
    expect(harness.adapter.sendCount).toBe(0);
    // Nothing reached the adapter, so the entry must be immediately claimable
    // again — a refusal held under a lease would delay the retry it exists to
    // allow by the full lease for no reason at all.
    const entry = await harness.reliability.getOutboxByDelivery(KNOWN_TENANT, delivery.id);
    const reclaimed = await harness.reliability.claimOutboxForSend({
      tenantId: KNOWN_TENANT,
      outboxId: entry?.id ?? 'missing',
      owner: 'worker',
      now: new Date().toISOString(),
      leaseMs: 60_000,
    });
    expect(reclaimed).toMatchObject({ status: 'pending', attemptCount: 0 });
  });
});
