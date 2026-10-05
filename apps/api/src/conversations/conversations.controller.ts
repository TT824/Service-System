import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  MESSAGE_SOURCES,
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
import { AccessService } from '../platform/access.service';
import {
  ConversationsService,
  type ConversationDetail,
  type ConversationPoolEntry,
  type TransferTarget,
} from './conversations.service';

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
