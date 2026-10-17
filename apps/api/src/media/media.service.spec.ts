import { describe, expect, it } from 'vitest';
import {
  CHANNEL_PROVIDER_WECOM,
  KefuStore,
  type ChannelResult,
  type Message,
  type MessageType,
  type UnifiedMedia,
} from '@kefu/core';
import { MemoryPlatformRepository } from '../platform/memory-platform.repository';
import { JsonLogger } from '../logging/json-logger';
import { MemoryMediaStorage } from '../../test/media-storage-support';
import { MESSAGE_MEDIA_MAX_BYTES, MessageMediaService } from './media.service';

const TENANT = 'tenant-acme';
const STORE = 'store-acme-flagship';

/** A logger that writes nothing: warn lines are expected here, not printed. */
function quietLogger(): JsonLogger {
  return new JsonLogger('fatal');
}

/** The provider handle an image callback carries. */
const MEDIA: UnifiedMedia = { mediaId: 'MEDIA_ID_1', mimeType: 'image/png' };

/** A four-byte PNG signature — enough to prove the bytes travelled intact. */
const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * A transport that answers one scripted download and records the asks.
 *
 * Only `fetchMedia` is implemented: {@link MessageMediaService.capture} takes a
 * `Pick<ChannelAdapter, 'fetchMedia'>`, and a double that could send or verify
 * would suggest this slice reaches further into the adapter than it does.
 */
class ScriptedFetch {
  readonly requests: string[] = [];

  /** The answer every fetch gives. */
  answer: ChannelResult<{ readonly mimeType: string; readonly bytes: Uint8Array }> = {
    ok: true,
    value: { mimeType: 'image/png', bytes: IMAGE_BYTES },
  };

  /** @inheritdoc */
  async fetchMedia(input: {
    readonly mediaId: string;
  }): Promise<ChannelResult<{ readonly mimeType: string; readonly bytes: Uint8Array }>> {
    this.requests.push(input.mediaId);
    return this.answer;
  }
}

/** A service over in-process stores, with the pieces a test needs kept. */
function harness(): {
  readonly service: MessageMediaService;
  readonly platform: MemoryPlatformRepository;
  readonly storage: MemoryMediaStorage;
  readonly channel: ScriptedFetch;
} {
  const platform = new MemoryPlatformRepository(new KefuStore());
  const storage = new MemoryMediaStorage();
  return {
    service: new MessageMediaService(platform, storage, quietLogger()),
    platform,
    storage,
    channel: new ScriptedFetch(),
  };
}

/** Ingest one message of the given type, returning the row as committed. */
async function ingested(
  platform: MemoryPlatformRepository,
  messageType: MessageType = 'image',
): Promise<Message> {
  const result = await platform.ingestInbound({
    tenantId: TENANT,
    storeId: STORE,
    channel: CHANNEL_PROVIDER_WECOM,
    externalCustomerId: 'wm-customer-media-1',
    externalConversationId: 'wkTEST0001:wm-customer-media-1',
    externalMessageId: `external-${messageType}-1`,
    messageType,
    content: messageType === 'image' ? '[图片]' : '[链接]',
    dedupKey: `wecom:external-${messageType}-1`,
    now: '2026-09-20T10:00:00.000Z',
  });
  return result.message;
}

describe('MessageMediaService.capture', () => {
  it('stores an image under the tenant namespace and points the message at it', async () => {
    const { service, platform, storage, channel } = harness();
    const message = await ingested(platform);

    const outcome = await service.capture({
      tenantId: TENANT,
      messageId: message.id,
      messageType: message.messageType,
      media: MEDIA,
      channel,
    });

    expect(channel.requests).toEqual(['MEDIA_ID_1']);
    expect(outcome).toEqual({
      ok: true,
      key: `tenants/${TENANT}/messages/${message.id}`,
      mimeType: 'image/png',
      bytes: IMAGE_BYTES.byteLength,
    });
    expect(storage.objects.get(`tenants/${TENANT}/messages/${message.id}`)?.bytes).toEqual(
      IMAGE_BYTES,
    );
    // The row and the object agree, which is what makes the transcript's image
    // reachable at all. The two absences are asserted rather than skipped: an
    // inbound picture has no file name of its own and no provider handle worth
    // keeping, and `null` is how every reader is told so.
    expect((await platform.getMessage(TENANT, message.id))?.media).toEqual({
      key: `tenants/${TENANT}/messages/${message.id}`,
      mimeType: 'image/png',
      bytes: IMAGE_BYTES.byteLength,
      name: null,
      providerMediaId: null,
    });
  });

  it('asks for nothing when the message is not an image', async () => {
    const { service, platform, storage, channel } = harness();
    const message = await ingested(platform, 'link');

    const outcome = await service.capture({
      tenantId: TENANT,
      messageId: message.id,
      messageType: message.messageType,
      media: MEDIA,
      channel,
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'not_an_image' });
    expect(channel.requests).toEqual([]);
    expect(storage.writes).toEqual([]);
  });

  it('leaves the message without media when the provider refuses the download', async () => {
    const { service, platform, storage, channel } = harness();
    const message = await ingested(platform);
    channel.answer = {
      ok: false,
      code: 'channel_provider_error',
      message: 'the media download was refused',
      retryable: false,
    };

    const outcome = await service.capture({
      tenantId: TENANT,
      messageId: message.id,
      messageType: message.messageType,
      media: MEDIA,
      channel,
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'download_failed' });
    // The provider's own words survive into the detail, because that is the only
    // place an operator can find out *why* the picture is missing.
    expect(outcome.ok ? '' : outcome.detail).toContain('the media download was refused');
    expect(storage.writes).toEqual([]);
    expect((await platform.getMessage(TENANT, message.id))?.media).toBeNull();
  });

  it('refuses to keep an image that is larger than the product allows', async () => {
    const { service, platform, storage, channel } = harness();
    const message = await ingested(platform);
    channel.answer = {
      ok: true,
      value: { mimeType: 'image/png', bytes: new Uint8Array(MESSAGE_MEDIA_MAX_BYTES + 1) },
    };

    const outcome = await service.capture({
      tenantId: TENANT,
      messageId: message.id,
      messageType: message.messageType,
      media: MEDIA,
      channel,
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'too_large' });
    expect(storage.writes).toEqual([]);
    expect((await platform.getMessage(TENANT, message.id))?.media).toBeNull();
  });

  it('keeps an image that is exactly the cap, so the boundary is inclusive', async () => {
    const { service, platform, storage, channel } = harness();
    const message = await ingested(platform);
    channel.answer = {
      ok: true,
      value: { mimeType: 'image/png', bytes: new Uint8Array(MESSAGE_MEDIA_MAX_BYTES) },
    };

    const outcome = await service.capture({
      tenantId: TENANT,
      messageId: message.id,
      messageType: message.messageType,
      media: MEDIA,
      channel,
    });

    expect(outcome).toMatchObject({ ok: true, bytes: MESSAGE_MEDIA_MAX_BYTES });
    expect(storage.writes).toHaveLength(1);
  });

  it('leaves the message without media when the object store refuses the write', async () => {
    const { service, platform, storage, channel } = harness();
    const message = await ingested(platform);
    storage.failure = { code: 'media_store_unreachable', reason: 'connect ECONNREFUSED' };

    const outcome = await service.capture({
      tenantId: TENANT,
      messageId: message.id,
      messageType: message.messageType,
      media: MEDIA,
      channel,
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'store_failed' });
    expect((await platform.getMessage(TENANT, message.id))?.media).toBeNull();
  });

  it('reports a missing message rather than claiming the picture was kept', async () => {
    const { service, storage, channel } = harness();

    const outcome = await service.capture({
      tenantId: TENANT,
      messageId: 'message-that-does-not-exist',
      messageType: 'image',
      media: MEDIA,
      channel,
    });

    // The write happened first and the attach found no row, so the bytes are an
    // orphan — saying so is the difference between a leak an operator can find
    // and one nobody knows about.
    expect(outcome).toMatchObject({ ok: false, reason: 'message_missing' });
    expect(storage.writes).toEqual(['tenants/tenant-acme/messages/message-that-does-not-exist']);
  });
});

describe('MessageMediaService.read', () => {
  it('reads back exactly the bytes that were stored', async () => {
    const { service, platform, channel } = harness();
    const message = await ingested(platform);
    await service.capture({
      tenantId: TENANT,
      messageId: message.id,
      messageType: message.messageType,
      media: MEDIA,
      channel,
    });

    const read = await service.read({ tenantId: TENANT, messageId: message.id });

    expect(read).toEqual({ ok: true, mimeType: 'image/png', bytes: IMAGE_BYTES });
  });

  it('answers not_found for a message that never had media', async () => {
    const { service, platform } = harness();
    const message = await ingested(platform, 'text');

    expect(await service.read({ tenantId: TENANT, messageId: message.id })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it('answers not_found rather than reaching another tenant', async () => {
    const { service, platform, channel } = harness();
    const message = await ingested(platform);
    await service.capture({
      tenantId: TENANT,
      messageId: message.id,
      messageType: message.messageType,
      media: MEDIA,
      channel,
    });

    // The tenant is not a filter applied after the lookup: a foreign tenant
    // simply has no such message, which is the whole reason the tenant travels
    // inside the signed URL.
    expect(await service.read({ tenantId: 'tenant-other', messageId: message.id })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it('separates an object that is gone from a store that is down', async () => {
    const { service, platform, storage, channel } = harness();
    const message = await ingested(platform);
    await service.capture({
      tenantId: TENANT,
      messageId: message.id,
      messageType: message.messageType,
      media: MEDIA,
      channel,
    });

    storage.objects.clear();
    expect(await service.read({ tenantId: TENANT, messageId: message.id })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });

    storage.failure = { code: 'media_store_unreachable', reason: 'connect ECONNREFUSED' };
    expect(await service.read({ tenantId: TENANT, messageId: message.id })).toMatchObject({
      ok: false,
      reason: 'storage_unavailable',
    });
  });
});
