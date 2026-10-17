import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { INTERNAL_ATTACHMENT_MAX_BYTES } from '@kefu/core';
import { bodyOptionalString, bodyRecord, bodyRequiredString } from '../http/request-body';
import { uploadTooLargeFilter } from '../http/upload-too-large.filter';
import { AccessService } from '../platform/access.service';
import {
  InternalAttachmentService,
  type InternalAttachmentView,
  type UploadedAttachmentFile,
} from './internal-attachment.service';
import {
  InternalChatService,
  type InternalMessageView,
  type InternalPeer,
  type InternalThreadView,
} from './internal-chat.service';

/**
 * multer 的内存保护线：比业务上限高 1 MiB。
 *
 * 不能直接把它设成业务上限。multer 在字节数**达到** `limits.fileSize` 时就抛
 * `LIMIT_FILE_SIZE`，而业务判据是「超过才拒」（`internalAttachment` 比的是 `>`），
 * 恰好等于上限的文件必须放行。设成同一个值等于把上限悄悄降掉一字节，而且报出来的
 * 是后备闸那句笼统的话，看不出差在哪儿 —— 与商品导入的两道闸同一个理由。
 */
const ATTACHMENT_UPLOAD_MEMORY_BACKSTOP_BYTES = INTERNAL_ATTACHMENT_MAX_BYTES.video + 1024 * 1024;

/**
 * 附件上传的闸门。
 *
 * 一个文件、少量文本字段：内部消息的其余内容都走 JSON 那条路，这里只收文件，
 * 不给调用方留下撑爆内存的口子。
 */
const ATTACHMENT_UPLOAD_INTERCEPTOR = FileInterceptor('file', {
  limits: {
    fileSize: ATTACHMENT_UPLOAD_MEMORY_BACKSTOP_BYTES,
    files: 1,
    fields: 4,
    fieldSize: 8 * 1024,
  },
});

/**
 * 越过后备闸的 413 收敛回 400。
 *
 * 措辞说的是**业务**上限（视频那一档），不是后备闸自己的字节数：被这条线拦住的
 * 请求已经越过了产品允许的体积，调用方需要知道的是「太大了」，而一个 52428800
 * 这样的数字只会让人以为平台在按字节谈判。
 */
const AttachmentUploadTooLargeFilter = uploadTooLargeFilter(
  `文件超过 ${String(INTERNAL_ATTACHMENT_MAX_BYTES.video / (1024 * 1024))} MiB 上限`,
);

/**
 * Internal collaboration endpoints: colleague-to-colleague chat.
 *
 * Separate from `/conversations` rather than a flag on it, because the two are
 * different authorities: a conversation read is scoped to a store and the
 * customer being served, while an internal thread is scoped to its two
 * participants and is not a customer fact at all. Folding them together would
 * mean one endpoint whose authorization depends on a column value.
 */
@Controller('internal-chat')
export class InternalChatController {
  constructor(
    private readonly access: AccessService,
    private readonly internalChat: InternalChatService,
    private readonly attachments: InternalAttachmentService,
  ) {}

  /** Colleagues of the tenant this seat may chat with. */
  @Get('peers')
  async peers(@Req() req: Request): Promise<ReadonlyArray<InternalPeer>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.internalChat.listPeers(tenantId, member);
  }

  /** The caller's internal threads, most recently active first. */
  @Get('threads')
  async threads(@Req() req: Request): Promise<ReadonlyArray<InternalThreadView>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.internalChat.listThreads(tenantId, member);
  }

  /**
   * Open (or find) the one-to-one thread with a colleague.
   *
   * `POST` rather than `GET` even though it is idempotent: it creates the thread
   * the first time, and a `GET` that writes is the kind of surprise a proxy's
   * retry turns into a duplicate.
   */
  @Post('threads')
  async openThread(@Req() req: Request, @Body() body: unknown): Promise<InternalThreadView> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const peerMemberId = bodyRequiredString(bodyRecord(body), 'peerMemberId');
    return this.internalChat.openDirectThread(tenantId, member, peerMemberId);
  }

  /** One thread's messages, oldest first. */
  @Get('threads/:threadId/messages')
  async messages(
    @Req() req: Request,
    @Param('threadId') threadId: string,
  ): Promise<ReadonlyArray<InternalMessageView>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.internalChat.messages(tenantId, member, threadId);
  }

  /**
   * Put one file into a thread, before any message names it.
   *
   * A route of its own, and a `POST` that creates only a draft: a message and
   * its file arrive in two requests because they are two facts with two
   * different failure modes. The upload can fail on size, type or the object
   * store, and when it does the sender is still at the keyboard and should be
   * told so; a single wrapped request would answer "消息发送失败" for a file the
   * platform never accepted, and the text would be lost with it.
   *
   * Membership is the thread's, checked by the service, so uploading where you
   * cannot speak is not a capability anyone has.
   *
   * @param req - The request, for the acting member and the tenant scope.
   * @param threadId - The thread the file is being sent in.
   * @param file - The multipart part named `file`.
   * @returns The stored draft, which the send request then names.
   */
  @Post('threads/:threadId/attachments')
  @UseInterceptors(ATTACHMENT_UPLOAD_INTERCEPTOR)
  @UseFilters(AttachmentUploadTooLargeFilter)
  async uploadAttachment(
    @Req() req: Request,
    @Param('threadId') threadId: string,
    @UploadedFile() file: UploadedAttachmentFile | undefined,
  ): Promise<InternalAttachmentView> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    if (file === undefined) {
      // multer fills this in only for a part actually named `file`; every other
      // shape of request is one this endpoint cannot answer, and saying which
      // field it wanted is more useful than a bare 400.
      throw new BadRequestException('the file must be sent as the multipart field "file"');
    }
    return this.attachments.upload({ tenantId, member, threadId, file });
  }

  /**
   * Append one message to a thread the caller takes part in.
   *
   * `content` and `attachmentId` are both optional and at least one is required:
   * a file with a caption and a file with none are the same kind of message, and
   * so are a caption with no file. The id is one the upload endpoint returned —
   * it is not a path, and a caller cannot name bytes this platform did not
   * write for them.
   */
  @Post('threads/:threadId/messages')
  async send(
    @Req() req: Request,
    @Param('threadId') threadId: string,
    @Body() body: unknown,
  ): Promise<InternalMessageView> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    return this.internalChat.send(tenantId, member, threadId, {
      content: bodyOptionalString(record, 'content'),
      attachmentId: bodyOptionalString(record, 'attachmentId'),
    });
  }
}
