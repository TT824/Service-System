import { randomUUID } from 'node:crypto';
import { BadRequestException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  internalAttachment,
  type InternalAttachmentKind,
  type InternalAttachmentRecord,
  type Member,
} from '@kefu/core';
import { decodedFileName } from '../http/uploaded-file-name';
import { JsonLogger } from '../logging/json-logger';
import {
  MEDIA_STORAGE,
  internalAttachmentObjectKey,
  type MediaStorage,
} from '../media/media-storage';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../platform/platform-repository';
import { InternalChatService } from './internal-chat.service';

/**
 * The fields this route uses off multer's file object.
 *
 * Declared here rather than pulled from `@types/multer`: one shape is not worth
 * a new dependency, and this is the shape the endpoint actually reads — the
 * other fields multer fills in are not facts this service is allowed to trust.
 */
export type UploadedAttachmentFile = {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
};

/** An attachment as its uploader's own request answers with. */
export type InternalAttachmentView = {
  readonly id: string;
  readonly kind: InternalAttachmentKind;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
};

/** What one read of stored bytes found. */
export type StoredInternalAttachment =
  | {
      readonly ok: true;
      readonly kind: InternalAttachmentKind;
      readonly fileName: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly ok: false;
      /** There is no such attachment, or its object is gone. */
      readonly reason: 'not_found' | 'storage_unavailable';
      readonly detail: string;
    };

/**
 * Files colleagues send each other: writing them at upload, reading them back
 * for the signed route.
 *
 * The two halves are one file because they are one subject, and because the rule
 * they share is the one worth stating: **an attachment exists only once its
 * bytes do.** That is the opposite of what the customer-media path does, and
 * deliberately so. There, the message has already arrived from the customer and
 * the bytes are a bonus the platform may lose; here the sender is sitting in
 * front of the screen and can be told "上传失败，请重试", so nothing is written
 * that claims a file nobody stored.
 *
 * Upload is authorized by thread membership, exactly like sending. There is no
 * separate "may upload" authority, because an upload nobody can send is not a
 * capability — it is a row waiting to be cleaned up.
 */
@Injectable()
export class InternalAttachmentService {
  /**
   * @param repository - Where attachment rows are kept.
   * @param storage - Where the bytes are kept.
   * @param internalChat - Thread membership, so upload and send cannot disagree
   *   about who may speak in a thread.
   * @param logger - Where a refusal explains itself.
   */
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    private readonly internalChat: InternalChatService,
    private readonly logger: JsonLogger,
  ) {}

  /**
   * Store one uploaded file as a draft in a thread the caller takes part in.
   *
   * The order is bytes first, row second, and it is the only order that holds
   * the rule above: a crash between the two leaves an object nobody references
   * (which the bucket's key namespace can enumerate and a later sweep can
   * delete), never a row promising bytes that were never written.
   *
   * @param input - The effective tenant, the uploading member, the thread, and
   *   the file as multer handed it over.
   * @returns The stored draft, identified by an id the send path can name.
   * @throws {NotFoundException} When the thread is not in this tenant.
   * @throws {ForbiddenException} When the caller is not a participant.
   * @throws {BadRequestException} When the file is unnameable, untyped, or over
   *   the limit for its kind.
   * @throws {HttpException} `503` when object storage refuses the write.
   */
  async upload(input: {
    readonly tenantId: string;
    readonly member: Member;
    readonly threadId: string;
    readonly file: UploadedAttachmentFile;
  }): Promise<InternalAttachmentView> {
    await this.internalChat.requireParticipation(input.tenantId, input.member, input.threadId);

    let validated: ReturnType<typeof internalAttachment>;
    try {
      validated = internalAttachment({
        fileName: decodedFileName(input.file.originalname),
        mimeType: input.file.mimetype,
        byteSize: input.file.size,
      });
    } catch (error) {
      // 数组形状不是随意的：全局过滤器只把 `message` 是**数组**的那一刻的条目收进
      // `details`，写成字符串的话前端只会看到「Bad Request」。原因必须能到达发件人，
      // 「文件超过 5 MiB」和「这个格式不支持」是两种不同的处置。
      throw new BadRequestException([
        error instanceof Error ? error.message : 'the file cannot be sent',
      ]);
    }

    const id = `internal-attachment-${randomUUID()}`;
    const objectKey = internalAttachmentObjectKey(input.tenantId, id);
    const stored = await this.storage.put({
      key: objectKey,
      mimeType: validated.mimeType,
      bytes: input.file.buffer,
    });
    if (!stored.ok) {
      this.logger.logStructured(
        'warn',
        'internal attachment was not stored',
        {
          tenant: input.tenantId,
          thread: input.threadId,
          kind: stored.code,
          detail: stored.reason,
        },
        InternalAttachmentService.name,
      );
      // A `503` and not a `500`: the store is the part that failed, the caller's
      // request was fine, and the same request will very likely work in a
      // minute. Saying so is what lets the sender retry instead of re-picking
      // the file.
      throw new HttpException(
        { code: 'service_unavailable', message: '附件存储暂时不可用，请稍后再试' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const record = await this.repository.createInternalAttachment({
      id,
      tenantId: input.tenantId,
      threadId: input.threadId,
      uploaderMemberId: input.member.id,
      kind: validated.kind,
      fileName: validated.fileName,
      mimeType: validated.mimeType,
      byteSize: validated.byteSize,
      objectKey,
      createdAt: new Date().toISOString(),
    });
    return toView(record);
  }

  /**
   * Read one message's stored bytes back.
   *
   * Tenant-scoped through the attachment lookup rather than a separate check:
   * the caller supplies the tenant the signature covered, and a message id from
   * another tenant simply does not resolve.
   *
   * @param input - The tenant and message the signature covered.
   * @returns The bytes, their content type and the kind that decides how they
   *   may be served, or why they could not be read.
   */
  async read(input: {
    readonly tenantId: string;
    readonly messageId: string;
  }): Promise<StoredInternalAttachment> {
    const record = await this.repository.getInternalMessageAttachment(
      input.tenantId,
      input.messageId,
    );
    if (record === undefined) {
      return { ok: false, reason: 'not_found', detail: 'no attachment for this message' };
    }
    const read = await this.storage.get(record.objectKey);
    if (!read.ok) {
      return {
        ok: false,
        reason: read.code === 'media_object_missing' ? 'not_found' : 'storage_unavailable',
        detail: read.reason,
      };
    }
    return {
      ok: true,
      kind: record.kind,
      fileName: record.fileName,
      mimeType: record.mimeType,
      bytes: read.value.bytes,
    };
  }
}

/**
 * Project a stored attachment onto what its uploader is told.
 *
 * The object key and the claiming message are deliberately absent: neither is a
 * fact the client needs, and the key is the platform's own addressing of the
 * bytes rather than anything a caller should be able to name.
 *
 * @param record - The stored row.
 * @returns The view.
 */
function toView(record: InternalAttachmentRecord): InternalAttachmentView {
  return {
    id: record.id,
    kind: record.kind,
    fileName: record.fileName,
    mimeType: record.mimeType,
    byteSize: record.byteSize,
  };
}
