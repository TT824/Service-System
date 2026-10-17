import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import {
  MESSAGE_SOURCES,
  OUTBOUND_MEDIA_MAX_BYTES,
  type Conversation,
  type ConversationAssignment,
  type MessageSource,
} from '@kefu/core';
import type { DispatchedMessage } from '../channels/channel-delivery.service';
import {
  bodyOptionalPositiveInt,
  bodyOptionalString,
  bodyRecord,
  bodyRequiredString,
} from '../http/request-body';
import { uploadTooLargeFilter } from '../http/upload-too-large.filter';
import { AccessService } from '../platform/access.service';
import {
  ConversationsService,
  type ConversationDetail,
  type ConversationPoolEntry,
  type TransferTarget,
  type UploadedOutboundMediaFile,
} from './conversations.service';

/**
 * multer 的内存保护线：比业务上限高 1 MiB。
 *
 * 与内部聊天的附件上传同一个理由：multer 在字节数**达到** `limits.fileSize` 时
 * 就抛 `LIMIT_FILE_SIZE`，而业务判据是「超过才拒」（`outboundMedia` 比的是 `>`），
 * 恰好等于上限的文件必须放行。设成同一个值等于把上限悄悄降掉一字节，报出来的还是
 * 后备闸那句笼统的话。
 *
 * 取三档里最大的那一档（文件 20 MiB），因为一个路由收三种媒体：按照片那一档设，
 * 一个 15 MiB 的文档还没到业务判据就被拦在这里，报的还是「照片太大」。
 */
const MEDIA_UPLOAD_MEMORY_BACKSTOP_BYTES = OUTBOUND_MEDIA_MAX_BYTES.file + 1024 * 1024;

/**
 * 出站附件上传的闸门。
 *
 * 一个文件、最多几个文本字段：其余字段走 JSON 那条路，这里不给调用方留下撑爆
 * 内存的口子。
 */
const MEDIA_UPLOAD_INTERCEPTOR = FileInterceptor('file', {
  limits: {
    fileSize: MEDIA_UPLOAD_MEMORY_BACKSTOP_BYTES,
    files: 1,
    fields: 4,
    fieldSize: 8 * 1024,
  },
});

/**
 * 越过后备闸的 413 收敛回 400。
 *
 * 措辞说的是**业务**上限（三档里最大的那一档），不是后备闸自己的字节数：被这条
 * 线拦住的请求已经越过了产品允许的体积，调用方需要知道的是「太大了」。
 */
const MediaUploadTooLargeFilter = uploadTooLargeFilter(
  `附件超过 ${String(OUTBOUND_MEDIA_MAX_BYTES.file / (1024 * 1024))} MiB 上限`,
);

/** Conversation workspace endpoints. */
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly access: AccessService,
    private readonly conversations: ConversationsService,
  ) {}

  /** List conversations in the actor tenant scope. */
  @Get()
  async list(
    @Req() req: Request,
    @Query('storeId') storeId?: string,
  ): Promise<ReadonlyArray<Conversation>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.conversations.list(tenantId, member, storeId);
  }

  /**
   * The conversations waiting to be served, in the actor store scope.
   *
   * Declared before the `:conversationId` route on purpose: Nest matches routes
   * in declaration order, so a literal path declared after a parametrised one is
   * captured as that parameter — `/conversations/pool` would arrive as a request
   * for a conversation literally named `pool` and 404.
   */
  @Get('pool')
  async pool(
    @Req() req: Request,
    @Query('storeId') storeId?: string,
  ): Promise<ReadonlyArray<ConversationPoolEntry>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.conversations.pool(tenantId, member, storeId);
  }

  /** One conversation with its messages. */
  @Get(':conversationId')
  async detail(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
  ): Promise<ConversationDetail> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.conversations.detail(tenantId, member, conversationId);
  }

  /** Live accepting colleagues eligible to receive a handover. */

  /** Every assignment attempt on one conversation, newest first. */
  @Get(':conversationId/assignments')
  async assignments(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
  ): Promise<ReadonlyArray<ConversationAssignment>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.conversations.assignments(tenantId, conversationId, member);
  }

  /** Claim an open conversation (optimistic version check). */
  @Post(':conversationId/claim')
  async claim(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<Conversation> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const expectedVersion = this.versionFromBody(body);
    return this.conversations.claim(tenantId, conversationId, member, expectedVersion);
  }

  /** Return a claimed conversation to the pool. */
  @Post(':conversationId/return')
  async returnToPool(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<Conversation> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const expectedVersion = this.versionFromBody(body);
    return this.conversations.returnToPool(tenantId, conversationId, member, expectedVersion);
  }

  /**
   * The seats this conversation may be transferred to right now.
   *
   * Read-only, and answered by the transfer route's own eligibility rule, so the
   * picker cannot offer a colleague the transfer would refuse.
   */
  @Get(':conversationId/transfer-targets')
  async transferTargets(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
  ): Promise<ReadonlyArray<TransferTarget>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.conversations.transferTargets(tenantId, conversationId, member);
  }

  /** Transfer a claimed conversation to another member. */
  @Post(':conversationId/transfer')
  async transfer(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<Conversation> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const expectedVersion = this.versionFromBody(record);
    const toMemberId = bodyRequiredString(record, 'toMemberId');
    return this.conversations.transfer(
      tenantId,
      conversationId,
      member,
      expectedVersion,
      toMemberId,
    );
  }

  /** Close an open or claimed conversation. */
  @Post(':conversationId/close')
  async close(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<Conversation> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const expectedVersion = this.versionFromBody(body);
    return this.conversations.close(tenantId, conversationId, member, expectedVersion);
  }

  /**
   * Send an outbound message from the agent workspace.
   *
   * The response carries the recorded message *and* its delivery projection, so
   * the workspace can show whether the reply actually reached the provider
   * instead of assuming it did.
   */
  @Post(':conversationId/messages')
  async send(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<DispatchedMessage> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const content = bodyRequiredString(record, 'content');
    const source = this.sourceFromBody(record);
    const dedupKey = bodyOptionalString(record, 'dedupKey');
    const candidateId = bodyOptionalString(record, 'candidateId');
    return this.conversations.sendMessage(tenantId, conversationId, member, {
      content,
      source,
      ...(dedupKey === undefined ? {} : { dedupKey }),
      ...(candidateId === undefined ? {} : { candidateId }),
    });
  }

  /**
   * Send the customer a picture, a clip or a document.
   *
   * A route of its own rather than a field on the send above, because the two
   * carry different things: the JSON route's body is a sentence, this one's is
   * bytes, and a request cannot be both. Keeping them apart is also what lets
   * each keep its own gate — this one has multer's memory backstop in front of
   * the service's own judgement, and the text route has neither.
   *
   * One request, not two, is the deliberate opposite of the internal-chat
   * upload: there the file is a draft that a later message names, because the
   * provider's handle does not exist until the send and expires three days
   * later. Here the file *is* the message, so there is nothing to hold between
   * two requests — and a draft left behind by a seat who changed their mind
   * would be an object, a database row and an expiring provider handle, all
   * three of which are work for a cleanup nobody has written.
   *
   * @param req - The request, for the acting member and the tenant scope.
   * @param conversationId - The conversation being replied to.
   * @param file - The multipart part named `file`.
   * @returns The recorded message and its delivery projection, as the text send
   *   answers.
   */
  @Post(':conversationId/messages/media')
  @UseInterceptors(MEDIA_UPLOAD_INTERCEPTOR)
  @UseFilters(MediaUploadTooLargeFilter)
  async sendMedia(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @UploadedFile() file: UploadedOutboundMediaFile | undefined,
    @Body() body: unknown,
  ): Promise<DispatchedMessage> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    if (file === undefined) {
      // multer fills this in only for a part actually named `file`; every other
      // shape of request is one this endpoint cannot answer, and saying which
      // field it wanted is more useful than a bare 400.
      throw new BadRequestException('the file must be sent as the multipart field "file"');
    }
    // The multipart body beside the part is text, and `source` and `dedupKey`
    // are the only two this route reads — the same two the JSON send reads, so
    // a retry that hits the wrong endpoint still carries a dedup key.
    const record = bodyRecord(body);
    const source = this.sourceFromBody(record);
    const dedupKey = bodyOptionalString(record, 'dedupKey');
    return this.conversations.sendMediaMessage(tenantId, conversationId, member, {
      file,
      source,
      ...(dedupKey === undefined ? {} : { dedupKey }),
    });
  }

  private versionFromBody(body: unknown): number {
    const record = bodyRecord(body);
    const value = bodyOptionalPositiveInt(record, 'expectedVersion');
    if (value === undefined) {
      throw new BadRequestException('expectedVersion must be a positive integer');
    }
    return value;
  }

  private sourceFromBody(record: Record<string, unknown>): MessageSource {
    const raw = bodyOptionalString(record, 'source');
    const source: MessageSource = raw === undefined ? 'manual_typed' : (raw as MessageSource);
    if (!MESSAGE_SOURCES.includes(source)) {
      throw new BadRequestException(`source must be one of ${MESSAGE_SOURCES.join(', ')}`);
    }
    return source;
  }
}
