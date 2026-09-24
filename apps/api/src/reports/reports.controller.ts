import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { type AuditEntry } from '@kefu/core';
import { AccessService } from '../platform/access.service';
import { ReportsService, type ReportSummary } from './reports.service';

/** Report and audit endpoints for dashboards and compliance views. */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly access: AccessService,
    private readonly reports: ReportsService,
  ) {}

  /** Aggregate tenant report snapshot. */
  @Get('summary')
  async summary(@Req() req: Request): Promise<ReportSummary> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.reports.summary(tenantId);
  }

  /** Tenant audit trail, newest first. */
  @Get('audit')
  async audit(
    @Req() req: Request,
    @Query('limit') limit?: string,
  ): Promise<ReadonlyArray<AuditEntry>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const parsedLimit = this.parseLimit(limit);
    return this.reports.audit(tenantId, parsedLimit);
  }

  private parseLimit(value: string | undefined): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return undefined;
    }
    return parsed;
  }
}
