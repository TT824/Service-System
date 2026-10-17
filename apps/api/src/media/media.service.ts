import { Inject, Injectable } from '@nestjs/common';
import type { ChannelAdapter, MessageMedia, MessageType, UnifiedMedia } from '@kefu/core';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../platform/platform-repository';
import { JsonLogger } from '../logging/json-logger';
import {
  MEDIA_STORAGE,
  mediaObjectKey,
  type MediaStorage,
  type MediaStorageFailureCode,
} from './media-storage';

/**
 * What the platform keeps of a customer's media, and how it hands it back.
 *
 * Two halves of one subject, which is why they share a file: the write half runs
 * during ingest, where a picture is fetched and stored, and the read half runs
 * when a transcript asks for it through the signed route.
 *
 * The rule that shapes both is the same: **the message is the customer's, the
 * bytes are a bonus.** A capture never throws and never fails the callback — a
 * provider that cannot be reached, a picture too large to keep or an object
 * store that is down all end as "this message has no stored media", which the
 * transcript already knows how to show. Only the read half is allowed to
 * disappoint a caller, because by then the caller asked for bytes specifically.
 */

/**
 * The largest image the platform will keep, in bytes.
 *
 * A product rule rather than a transport bound: a WeCom image is capped at 2 MB
 * by the provider, so this is the point past which a body is not something a
 * customer's session can legitimately carry — a wrong media id, a provider
 * change, or an object that grew. Refusing here is what makes the stored
 * `media_bytes` a value the console can lay out a transcript with.
 */
export const MESSAGE_MEDIA_MAX_BYTES = 2 * 1024 * 1024;

/** Why a message ended up with no stored media. */
export type MediaCaptureRefusal =
  /** The message is not one the platform keeps media for (only images are). */
  | 'not_an_image'
  /** The provider refused, or could not be reached. */
  | 'download_failed'
  /** The image is larger than {@link MESSAGE_MEDIA_MAX_BYTES}. */
  | 'too_large'
  /** The object store refused the write, or could not be reached. */
  | 'store_failed'
  /** No message with that id in that tenant — nothing to attach media to. */
  | 'message_missing';

/** What one capture did. */
export type MediaCaptureOutcome =
  | {
      readonly ok: true;
      readonly key: string;
      readonly mimeType: string;
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly reason: MediaCaptureRefusal;
      /** One line for the log: the provider's or the store's own words, bounded. */
      readonly detail: string;
    };

/** What one read found. */
export type StoredMediaRead =
  | { readonly ok: true; readonly mimeType: string; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      /** The message or its object is not there. */
      readonly reason: 'not_found' | 'storage_unavailable';
      readonly detail: string;
    };

/** Keeps and serves the media of customer messages. */
@Injectable()
export class MessageMediaService {
  /**
   * @param platform - Business fact source, for the message the media belongs to.
   * @param storage - Where the bytes are kept.
   * @param logger - Where a refusal explains itself.
   */
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly platform: PlatformRepository,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    private readonly logger: JsonLogger,
  ) {}

  /**
   * Fetch a message's media from the provider and write it to object storage.
   *
   * Called after the message row exists, never inside its transaction: a MinIO
   * round trip must not hold a database transaction open, and the media write is
   * a second fact about a message that is already durable.
   *
   * @param input - The message, the provider's reference, and how to fetch it.
   * @returns What was stored, or why nothing was. Never throws.
   */
  async capture(input: {
    readonly tenantId: string;
    readonly messageId: string;
    readonly messageType: MessageType;
    readonly media: UnifiedMedia;
    readonly channel: Pick<ChannelAdapter, 'fetchMedia'>;
  }): Promise<MediaCaptureOutcome> {
    if (input.messageType !== 'image') {
      // Only pictures are stored in this slice. A voice note or a file carries a
      // media id too, but nothing in the product asks for those bytes back yet,
      // and keeping them would be storage with no reader.
      return this.#refuse(input, 'not_an_image', input.messageType);
    }

    const fetched = await input.channel.fetchMedia({ mediaId: input.media.mediaId });
    if (!fetched.ok) {
      return this.#refuse(
        input,
        'download_failed',
        `${fetched.code}: ${fetched.message ?? 'the provider refused the download'}`,
      );
    }
    if (fetched.value.bytes.byteLength > MESSAGE_MEDIA_MAX_BYTES) {
      return this.#refuse(
        input,
        'too_large',
        `${String(fetched.value.bytes.byteLength)} bytes exceeds ${String(MESSAGE_MEDIA_MAX_BYTES)}`,
      );
    }

    const key = mediaObjectKey(input.tenantId, input.messageId);
    const stored = await this.storage.put({
      key,
      mimeType: fetched.value.mimeType,
      bytes: fetched.value.bytes,
    });
    if (!stored.ok) {
      return this.#refuse(input, 'store_failed', `${stored.code}: ${stored.reason}`);
    }

    const attached = await this.platform.attachMessageMedia({
      tenantId: input.tenantId,
      messageId: input.messageId,
      key: stored.value.key,
      mimeType: stored.value.mimeType,
      bytes: stored.value.bytes,
    });
    if (!attached) {
      // The object is written and the row is gone — a message deleted between
      // the insert and this write. The bytes are now an orphan the bucket's own
      // namespace can enumerate; saying so is all that is left to do, and the
      // transcript shows the placeholder it would have shown anyway.
      return this.#refuse(input, 'message_missing', 'the message row no longer exists');
    }
    return {
      ok: true,
      key: stored.value.key,
      mimeType: stored.value.mimeType,
      bytes: stored.value.bytes,
    };
  }

  /**
   * Read one message's stored media back.
   *
   * Tenant-scoped through the message lookup rather than a separate check: the
   * caller supplies the tenant the signature covered, and a message id from
   * another tenant simply does not resolve.
   *
   * @param input - The tenant and message the signature covered.
   * @returns The bytes and their content type, or why they could not be read.
   */
  async read(input: {
    readonly tenantId: string;
    readonly messageId: string;
  }): Promise<StoredMediaRead> {
    const media = await this.#storedMediaOf(input);
    if (media === null) {
      return { ok: false, reason: 'not_found', detail: 'no stored media for this message' };
    }
    const read = await this.storage.get(media.key);
    if (!read.ok) {
      return { ok: false, reason: storageRefusalOf(read.code), detail: read.reason };
    }
    return { ok: true, mimeType: read.value.mimeType, bytes: read.value.bytes };
  }

  /**
   * Refuse a capture, with a line explaining it.
   *
   * The structured log is where the *precise* reason lives: the message row
   * records only that it has no media, which is all a reader of the transcript
   * needs, while "the provider said 40007" or "3.1 MB" is evidence for whoever
   * has to explain a missing picture later. Logged here rather than at the call
   * site because this is the only place the reason is still known.
   *
   * @param input - The message that was being captured.
   * @param reason - Why nothing was kept.
   * @param detail - The provider's or the store's own words, bounded.
   * @returns The refusal, so call sites read `return this.#refuse(…)`.
   */
  #refuse(
    input: { readonly tenantId: string; readonly messageId: string },
    reason: MediaCaptureRefusal,
    detail: string,
  ): MediaCaptureOutcome {
    this.logger.logStructured(
      'warn',
      'customer media was not stored',
      { tenant: input.tenantId, message: input.messageId, reason, detail },
      MessageMediaService.name,
    );
    return { ok: false, reason, detail };
  }

  /**
   * The media reference a message carries, if it carries one.
   *
   * Returns the reference rather than the message: the caller wants the key, and
   * handing back the row would leave every caller to re-establish what this
   * lookup has already established — that the media is there.
   */
  async #storedMediaOf(input: {
    readonly tenantId: string;
    readonly messageId: string;
  }): Promise<MessageMedia | null> {
    const message = await this.platform.getMessage(input.tenantId, input.messageId);
    if (message === undefined) {
      return null;
    }
    return message.media;
  }
}

/** Map a storage failure onto what the read route can answer with. */
function storageRefusalOf(code: MediaStorageFailureCode): 'not_found' | 'storage_unavailable' {
  return code === 'media_object_missing' ? 'not_found' : 'storage_unavailable';
}
