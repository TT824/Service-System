import { BadRequestException, Body, Controller, Get, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  AGENT_AVAILABILITY_STATUSES,
  type AgentAvailabilityStatus,
  type AgentPresence,
} from '@kefu/core';
import { SessionAccessService } from '../auth/session-access.service';
import { bodyRecord, bodyRequiredString } from '../http/request-body';
import { AccessService } from '../platform/access.service';
import type { RoutingWeightEntry } from '../platform/platform-repository';
import { AssignmentService, type ConversationRouting } from './assignment.service';

/**
 * Agent availability endpoints.
 *
 * The 会话分流 routes live here too, because the policy they read and write is
 * what decides who an assignment reaches — the same fact `presence` reports and
 * the sweep acts on, not a separate configuration surface.
 */
@Controller('assignment')
export class AssignmentController {
  constructor(
    private readonly access: AccessService,
    private readonly sessionAccess: SessionAccessService,
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

  /**
   * The tenant's 会话分流 policy: every agent seat, its weight and its author.
   *
   * Tenant scope comes from `x-tenant-id` for a platform administrator and from
   * the member's own tenant for everybody else — the same resolution the roster
   * uses, because the policy is about that tenant's seats.
   */
  @Get('routing')
  async routing(@Req() req: Request): Promise<ConversationRouting> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.assignment.routing(
      await this.sessionAccess.requireBusiness(req),
      tenantId,
      new Date().toISOString(),
    );
  }

  /**
   * Set the weight of every seat the body names, leaving the others as they are.
   *
   * A `PUT` on the policy rather than a `POST` to a collection: the caller is not
   * creating a resource, it is submitting the ratios for the seats it is showing.
   * Names omitted from the body keep the weight they had.
   */
  @Put('routing')
  async saveRouting(@Req() req: Request, @Body() body: unknown): Promise<ConversationRouting> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.assignment.saveRouting(
      await this.sessionAccess.requireBusiness(req),
      tenantId,
      member.id,
      this.weightsFromBody(body),
      new Date().toISOString(),
    );
  }

  /**
   * Read the submitted weights out of a request body.
   *
   * Only the shape is checked here — that `weights` is an array of
   * `{ member_id, weight }`. Whether the number may be a weight at all, and
   * whether the member exists, are judged against the tenant's roster in the
   * service, which is the layer that can see it.
   */
  private weightsFromBody(body: unknown): ReadonlyArray<RoutingWeightEntry> {
    const raw = bodyRecord(body)['weights'];
    if (!Array.isArray(raw)) {
      throw new BadRequestException('weights must be an array');
    }
    return raw.map((entry) => {
      const record = bodyRecord(entry);
      const weight = record['weight'];
      if (typeof weight !== 'number') {
        throw new BadRequestException('weight must be a number');
      }
      return { memberId: bodyRequiredString(record, 'member_id'), weight };
    });
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
