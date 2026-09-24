import { BadRequestException, Body, Controller, Get, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  AGENT_AVAILABILITY_STATUSES,
  type AgentAvailabilityStatus,
  type AgentPresence,
} from '@kefu/core';
import { bodyRecord, bodyRequiredString } from '../http/request-body';
import { AccessService } from '../platform/access.service';
import { AssignmentService } from './assignment.service';

/** Agent availability endpoints. */
@Controller('assignment')
export class AssignmentController {
  constructor(
    private readonly access: AccessService,
    private readonly assignment: AssignmentService,
  ) {}

  /** The acting member's own seat state. */
  @Get('presence')
  async presence(@Req() req: Request): Promise<AgentPresence | undefined> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.assignment.presence(tenantId, member);
  }

  /** Report the acting member's availability so the dispatcher can see the seat. */
  @Put('presence')
  async setPresence(@Req() req: Request, @Body() body: unknown): Promise<AgentPresence> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const status = this.statusFromBody(body);
    return this.assignment.setPresence(tenantId, member, status, new Date().toISOString());
  }

  /**
   * Refresh the acting member's liveness.
   *
   * Separate from {@link setPresence} because a heartbeat carries no status: the
   * browser says "still here", not "still accepting", and re-sending the status
   * every few seconds would make an accidental change indistinguishable from a
   * deliberate one.
   */
  @Post('presence/heartbeat')
  async heartbeat(@Req() req: Request): Promise<AgentPresence> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.assignment.heartbeat(tenantId, member, new Date().toISOString());
  }

  private statusFromBody(body: unknown): AgentAvailabilityStatus {
    const record = bodyRecord(body);
    const raw = bodyRequiredString(record, 'status');
    if (!(AGENT_AVAILABILITY_STATUSES as ReadonlyArray<string>).includes(raw)) {
      throw new BadRequestException(
        `status must be one of ${AGENT_AVAILABILITY_STATUSES.join(', ')}`,
      );
    }
    return raw as AgentAvailabilityStatus;
  }
}
