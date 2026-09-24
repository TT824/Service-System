import { Body, Controller, Get, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  type ApprovedPhrase,
  type Message,
  type MessageSource,
  type ReviewPolicy,
} from '@kefu/core';
import {
  bodyOptionalBoolean,
  bodyOptionalStringArray,
  bodyRecord,
  bodyRequiredString,
} from '../http/request-body';
import { AccessService } from '../platform/access.service';
import { ReviewService, type ApprovalPayload } from './review.service';

/** Review endpoints: policy, pending queue and approvals. */
@Controller('review')
export class ReviewController {
  constructor(
    private readonly access: AccessService,
    private readonly review: ReviewService,
  ) {}

  /** Read the platform-wide review policy. */
  @Get('policy')
  policy(@Req() req: Request): Promise<ReviewPolicy> {
    this.access.resolveMember(req);
    return this.review.policy();
  }

  /** Update the review policy (platform administrator only). */
  @Patch('policy')
  updatePolicy(@Req() req: Request, @Body() body: unknown): Promise<ReviewPolicy> {
    const member = this.access.resolveMember(req);
    const record = bodyRecord(body);
    const requireReview = bodyOptionalBoolean(record, 'requireReview');
    const sources = bodyOptionalStringArray(record, 'requireReviewForSources');
    return this.review.updatePolicy(member, {
      ...(requireReview === undefined ? {} : { requireReview }),
      ...(sources === undefined
        ? {}
        : { requireReviewForSources: sources as ReadonlyArray<MessageSource> }),
    });
  }

  /** List the pending review queue within the actor store scope. */
  @Get('queue')
  async queue(
    @Req() req: Request,
    @Query('storeId') storeId?: string,
  ): Promise<ReadonlyArray<Message>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.review.queue(tenantId, member, storeId);
  }

  /** Approve a candidate-backed message. */
  @Post('approve')
  async approve(@Req() req: Request, @Body() body: unknown): Promise<ApprovalPayload> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    return this.review.approve(tenantId, member, bodyRequiredString(record, 'messageId'));
  }

  /** List approved phrases in the tenant. */
  @Get('phrases')
  async phrases(@Req() req: Request): Promise<ReadonlyArray<ApprovedPhrase>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.review.phrases(tenantId);
  }
}
