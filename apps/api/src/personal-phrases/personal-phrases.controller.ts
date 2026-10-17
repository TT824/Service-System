import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { PersonalPhrase } from '@kefu/core';
import {
  bodyOptionalBoolean,
  bodyOptionalString,
  bodyOptionalStringArray,
  bodyRecord,
  bodyRequiredString,
} from '../http/request-body';
import { AccessService } from '../platform/access.service';
import { PersonalPhrasesService } from './personal-phrases.service';

/**
 * Personal quick phrase endpoints: one agent's own canned replies.
 *
 * A separate controller from `/knowledge` rather than a route under it, because
 * the two answer to different authorities. Knowledge writes are the tenant
 * administrator's (`AccessService.requireConfigurator`); these are open to every
 * member and confined to the caller — the acting agent is the only one who may
 * read or change a personal phrase, and an administrator is not an exception.
 * One controller whose permission rule depended on a path segment would be a
 * rule nobody can read off the code.
 *
 * The owner never appears in a path, a query or a body: it is the member the
 * session proved, resolved here and passed down. That is the whole isolation
 * story — there is no request that names somebody else.
 */
@Controller('personal-phrases')
export class PersonalPhrasesController {
  constructor(
    private readonly access: AccessService,
    private readonly phrases: PersonalPhrasesService,
  ) {}

  /** The caller's own phrases, newest first. */
  @Get()
  async list(@Req() req: Request): Promise<ReadonlyArray<PersonalPhrase>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.phrases.list(tenantId, member);
  }

  /** One of the caller's phrases; another member's id is a 404, not a 403. */
  @Get(':phraseId')
  async phrase(
    @Req() req: Request,
    @Param('phraseId') phraseId: string,
  ): Promise<PersonalPhrase> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.phrases.get(tenantId, member, phraseId);
  }

  /** Create a phrase for the caller. */
  @Post()
  async create(@Req() req: Request, @Body() body: unknown): Promise<PersonalPhrase> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    return this.phrases.create(tenantId, member, {
      // An omitted category (or an empty one) is not an error: the phrases page
      // files a phrase with no bucket under its own heuristic group, and the
      // empty string is how the form says "I did not pick one".
      category: bodyOptionalString(record, 'category') ?? '',
      title: bodyRequiredString(record, 'title'),
      keywords: bodyOptionalStringArray(record, 'keywords') ?? [],
      text: bodyRequiredString(record, 'text'),
    });
  }

  /** Change one of the caller's phrases; `{"enabled": false}` retires it. */
  @Patch(':phraseId')
  async update(
    @Req() req: Request,
    @Param('phraseId') phraseId: string,
    @Body() body: unknown,
  ): Promise<PersonalPhrase> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const category = bodyOptionalString(record, 'category');
    const title = bodyOptionalString(record, 'title');
    const keywords = bodyOptionalStringArray(record, 'keywords');
    const text = bodyOptionalString(record, 'text');
    const enabled = bodyOptionalBoolean(record, 'enabled');
    return this.phrases.update(tenantId, member, phraseId, {
      ...(category === undefined ? {} : { category }),
      ...(title === undefined ? {} : { title }),
      ...(keywords === undefined ? {} : { keywords }),
      ...(text === undefined ? {} : { text }),
      ...(enabled === undefined ? {} : { enabled }),
    });
  }
}
