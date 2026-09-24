import { Controller, Get, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AccessService } from '../platform/access.service';
import {
  IdentityService,
  type AccountStatusPayload,
  type TenantDirectoryEntry,
} from './identity.service';

/** Account center and directory configuration endpoints. */
@Controller()
export class IdentityController {
  constructor(
    private readonly access: AccessService,
    private readonly identity: IdentityService,
  ) {}

  /** Current member account status plus channel and policy state. */
  @Get('access/status')
  status(@Req() req: Request): Promise<AccountStatusPayload> {
    const member = this.access.resolveMember(req);
    return this.identity.accountStatus(member);
  }

  /** Tenants the member may operate on, each with stores and members. */
  @Get('directory/tenants')
  tenants(@Req() req: Request): Promise<ReadonlyArray<TenantDirectoryEntry>> {
    const member = this.access.resolveMember(req);
    return this.identity.listAccessibleTenants(member);
  }

  /** One authorized tenant directory entry. */
  @Get('directory/tenants/:tenantId')
  tenant(@Req() req: Request, @Param('tenantId') tenantId: string): Promise<TenantDirectoryEntry> {
    const member = this.access.resolveMember(req);
    return this.identity.getDirectoryEntry(member, tenantId);
  }
}
