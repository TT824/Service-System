import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { type SuggestionSet } from '@kefu/core';
import {
  bodyOptionalPositiveInt,
  bodyOptionalString,
  bodyRecord,
  bodyRequiredString,
} from '../http/request-body';
import { AccessService } from '../platform/access.service';
import { RetrievalService } from './retrieval.service';

/** Retrieval and suggestion endpoints used by the agent workspace. */
@Controller('retrieval')
export class RetrievalController {
  constructor(
    private readonly access: AccessService,
    private readonly retrieval: RetrievalService,
  ) {}

  /** Generate a source-aware suggestion set for one conversation. */
  @Post('suggestions')
  async suggest(@Req() req: Request, @Body() body: unknown): Promise<SuggestionSet> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const conversationId = bodyRequiredString(record, 'conversationId');
    const query = bodyOptionalString(record, 'query');
    const limit = bodyOptionalPositiveInt(record, 'limit');
    return this.retrieval.suggest(tenantId, member, {
      conversationId,
      ...(query === undefined ? {} : { query }),
      ...(limit === undefined ? {} : { limit }),
    });
  }

  /** Fetch one persisted suggestion set. */
  @Get('suggestions/:suggestionId')
  async get(
    @Req() req: Request,
    @Param('suggestionId') suggestionId: string,
  ): Promise<SuggestionSet> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.retrieval.get(tenantId, member, suggestionId);
  }
}
