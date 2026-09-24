import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AuthAdminService,
  PLATFORM_ROLES,
  type AccessContext,
  type AdminAccountView,
  type AdminDeviceView,
  type AgentPresence,
  type DisableAccountResult,
  type Member,
  type MemberStoreScope,
  type MemberUserLink,
  type PlatformRole,
  type RevokeAccountDeviceResult,
  type Store,
  type Tenant,
} from '@kefu/core';
import { AssignmentService } from '../assignment/assignment.service';
import { SessionAccessService } from '../auth/session-access.service';
import {
  bodyOptionalBoolean,
  bodyOptionalString,
  bodyRecord,
  bodyRequiredString,
} from '../http/request-body';

/**
 * Platform and tenant administration endpoints.
 *
 * Authorization is enforced by the domain service, not by the route: every
 * method resolves the caller's access context first and passes it down, so a
 * platform administrator reaches every tenant while a merchant administrator
 * reaches exactly their own. A caller who is not authenticated never gets here
 * (the global guard refuses them), and a caller whose account is not configured
 * for tenant business data is refused with `pending_config`.
 *
 * Responses never carry credential material — an account row reports whether a
 * password is configured, never a hash.
 */
@Controller('admin')
export class AdminController {
  /**
   * @param admin - Directory and account administration service.
   * @param assignment - Seat availability, for the roster's presence read.
   * @param sessionAccess - Resolves the caller's access context.
   */
  constructor(
    private readonly admin: AuthAdminService,
    private readonly assignment: AssignmentService,
    private readonly sessionAccess: SessionAccessService,
  ) {}

  // --------------------------------------------------------------------------
  // Tenants
  // --------------------------------------------------------------------------

  /** Tenants the caller may administer. */
  @Get('tenants')
  async listTenants(@Req() req: Request): Promise<ReadonlyArray<Tenant>> {
    return this.admin.listTenants(await this.#access(req));
  }

  /** Create a tenant. */
  @Post('tenants')
  @HttpCode(HttpStatus.CREATED)
  async createTenant(@Req() req: Request, @Body() body: unknown): Promise<Tenant> {
    const record = bodyRecord(body);
    const enabled = bodyOptionalBoolean(record, 'enabled');
    return this.admin.createTenant(await this.#access(req), {
      code: bodyRequiredString(record, 'code'),
      name: bodyRequiredString(record, 'name'),
      ...(enabled === undefined ? {} : { enabled }),
    });
  }

  /** Enable or disable a tenant. */
  @Post('tenants/:tenantId/enabled')
  @HttpCode(HttpStatus.OK)
  async setTenantEnabled(
    @Req() req: Request,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<Tenant> {
    return this.admin.setTenantEnabled(
      await this.#access(req),
      tenantId,
      requireEnabled(bodyRecord(body)),
    );
  }

  // --------------------------------------------------------------------------
  // Stores
  // --------------------------------------------------------------------------

  /** Stores of one tenant. */
  @Get('tenants/:tenantId/stores')
  async listStores(
    @Req() req: Request,
    @Param('tenantId') tenantId: string,
  ): Promise<ReadonlyArray<Store>> {
    return this.admin.listStores(await this.#access(req), tenantId);
  }

  /** Create a store inside a tenant. */
  @Post('stores')
  @HttpCode(HttpStatus.CREATED)
  async createStore(@Req() req: Request, @Body() body: unknown): Promise<Store> {
    const record = bodyRecord(body);
    const enabled = bodyOptionalBoolean(record, 'enabled');
    return this.admin.createStore(await this.#access(req), {
      tenantId: bodyRequiredString(record, 'tenant_id'),
      code: bodyRequiredString(record, 'code'),
      name: bodyRequiredString(record, 'name'),
      ...(enabled === undefined ? {} : { enabled }),
    });
  }

  /** Enable or disable a store. */
  @Post('stores/:storeId/enabled')
  @HttpCode(HttpStatus.OK)
  async setStoreEnabled(
    @Req() req: Request,
    @Param('storeId') storeId: string,
    @Body() body: unknown,
  ): Promise<Store> {
    return this.admin.setStoreEnabled(
      await this.#access(req),
      storeId,
      requireEnabled(bodyRecord(body)),
    );
  }

  // --------------------------------------------------------------------------
  // Members, roles and member links
  // --------------------------------------------------------------------------

  /** Members of one tenant. */
  @Get('tenants/:tenantId/members')
  async listMembers(
    @Req() req: Request,
    @Param('tenantId') tenantId: string,
  ): Promise<ReadonlyArray<Member>> {
    return this.admin.listMembers(await this.#access(req), tenantId);
  }

  /**
   * Every seat's availability in one tenant, for the roster's lamps.
   *
   * Read-only, and about seats rather than people: a member with no row has never
   * reported in and is absent from the answer, which the console reads as 离线 —
   * the same thing the platform's dispatcher reads it as. The shape is
   * `agent_presence` verbatim, including the store the seat sits in.
   */
  @Get('tenants/:tenantId/presence')
  async listPresence(
    @Req() req: Request,
    @Param('tenantId') tenantId: string,
  ): Promise<ReadonlyArray<AgentPresence>> {
    return this.assignment.tenantPresence(await this.#access(req), tenantId);
  }

  /** Create a member in a tenant. */
  @Post('members')
  @HttpCode(HttpStatus.CREATED)
  async createMember(@Req() req: Request, @Body() body: unknown): Promise<Member> {
    const record = bodyRecord(body);
    const storeId = bodyOptionalString(record, 'store_id');
    const tenantId = bodyOptionalString(record, 'tenant_id');
    const enabled = bodyOptionalBoolean(record, 'enabled');
    return this.admin.createMember(await this.#access(req), {
      tenantId: tenantId === undefined || tenantId.length === 0 ? null : tenantId,
      storeId: storeId === undefined || storeId.length === 0 ? null : storeId,
      role: requireRole(record),
      username: bodyRequiredString(record, 'username'),
      displayName: bodyRequiredString(record, 'display_name'),
      ...(enabled === undefined ? {} : { enabled }),
    });
  }

  /** Change a member's role. */
  @Post('members/:memberId/role')
  @HttpCode(HttpStatus.OK)
  async setMemberRole(
    @Req() req: Request,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ): Promise<Member> {
    return this.admin.setMemberRole(
      await this.#access(req),
      memberId,
      requireRole(bodyRecord(body)),
    );
  }

  /** Enable or disable a member. */
  @Post('members/:memberId/enabled')
  @HttpCode(HttpStatus.OK)
  async setMemberEnabled(
    @Req() req: Request,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ): Promise<Member> {
    return this.admin.setMemberEnabled(
      await this.#access(req),
      memberId,
      requireEnabled(bodyRecord(body)),
    );
  }

  /** Bind an account to a member. */
  @Post('members/:memberId/link')
  @HttpCode(HttpStatus.OK)
  async linkMember(
    @Req() req: Request,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ): Promise<MemberUserLink> {
    const access = await this.#access(req);
    return this.admin.linkMember(access, {
      userId: bodyRequiredString(bodyRecord(body), 'user_id'),
      memberId,
      linkedBy: access.userId,
    });
  }

  /** Revoke the active link of a member. */
  @Delete('members/:memberId/link')
  @HttpCode(HttpStatus.OK)
  async revokeLink(
    @Req() req: Request,
    @Param('memberId') memberId: string,
  ): Promise<{ readonly revoked: boolean }> {
    const link = await this.admin.revokeLink(await this.#access(req), memberId);
    return { revoked: link !== null };
  }

  // --------------------------------------------------------------------------
  // Store scopes
  // --------------------------------------------------------------------------

  /** Active store scopes of a member. */
  @Get('members/:memberId/store-scopes')
  async listStoreScopes(
    @Req() req: Request,
    @Param('memberId') memberId: string,
  ): Promise<ReadonlyArray<MemberStoreScope>> {
    return this.admin.listStoreScopes(await this.#access(req), memberId);
  }

  /** Grant a store scope to a member. */
  @Post('store-scopes')
  @HttpCode(HttpStatus.CREATED)
  async grantStoreScope(@Req() req: Request, @Body() body: unknown): Promise<MemberStoreScope> {
    const access = await this.#access(req);
    const record = bodyRecord(body);
    const isPrimary = bodyOptionalBoolean(record, 'is_primary');
    return this.admin.grantStoreScope(access, {
      tenantId: bodyRequiredString(record, 'tenant_id'),
      memberId: bodyRequiredString(record, 'member_id'),
      storeId: bodyRequiredString(record, 'store_id'),
      grantedBy: access.userId,
      ...(isPrimary === undefined ? {} : { isPrimary }),
    });
  }

  /** Revoke a store scope from a member. */
  @Delete('members/:memberId/store-scopes/:storeId')
  @HttpCode(HttpStatus.OK)
  async revokeStoreScope(
    @Req() req: Request,
    @Param('memberId') memberId: string,
    @Param('storeId') storeId: string,
  ): Promise<{ readonly revoked: boolean }> {
    return this.admin.revokeStoreScope(await this.#access(req), memberId, storeId);
  }

  // --------------------------------------------------------------------------
  // Accounts
  // --------------------------------------------------------------------------

  /**
   * Create an account with a password.
   *
   * The account is created unlinked, which is the state the binding workflow
   * below expects: it appears among the pending accounts and becomes usable
   * once an administrator binds it to a member.
   */
  @Post('accounts')
  @HttpCode(HttpStatus.CREATED)
  async createAccount(@Req() req: Request, @Body() body: unknown): Promise<AdminAccountView> {
    const record = bodyRecord(body);
    return this.admin.createAccount(await this.#access(req), {
      username: bodyRequiredString(record, 'username'),
      displayName: bodyRequiredString(record, 'display_name'),
      password: bodyRequiredString(record, 'password'),
    });
  }

  /** Accounts visible to the caller, optionally filtered by a fragment. */
  @Get('accounts')
  async listAccounts(
    @Req() req: Request,
    @Query('q') query?: string,
  ): Promise<ReadonlyArray<AdminAccountView>> {
    return this.admin.listAccounts(await this.#access(req), query);
  }

  /** Disable an account and revoke every session it holds. */
  @Post('accounts/:userId/disable')
  @HttpCode(HttpStatus.OK)
  async disableAccount(
    @Req() req: Request,
    @Param('userId') userId: string,
  ): Promise<DisableAccountResult> {
    return this.admin.disableAccount(await this.#access(req), userId);
  }

  /** Re-enable a disabled account. */
  @Post('accounts/:userId/enable')
  @HttpCode(HttpStatus.OK)
  async enableAccount(
    @Req() req: Request,
    @Param('userId') userId: string,
  ): Promise<AdminAccountView> {
    return this.admin.enableAccount(await this.#access(req), userId);
  }

  /**
   * Approve a pending registration.
   *
   * The applicant becomes an agent of this deployment's single organisation and
   * can enter the console on the session it already holds — nothing is returned
   * to them but a session that now resolves to `active`.
   */
  @Post('accounts/:userId/approve')
  @HttpCode(HttpStatus.OK)
  async approveAccount(
    @Req() req: Request,
    @Param('userId') userId: string,
  ): Promise<AdminAccountView> {
    return this.admin.approveAccount(await this.#access(req), userId);
  }

  /** Reject a pending registration, and revoke the sessions it is waiting on. */
  @Post('accounts/:userId/reject')
  @HttpCode(HttpStatus.OK)
  async rejectAccount(
    @Req() req: Request,
    @Param('userId') userId: string,
  ): Promise<AdminAccountView> {
    return this.admin.rejectAccount(await this.#access(req), userId);
  }

  /** Remembered devices of one account. */
  @Get('accounts/:userId/devices')
  async listAccountDevices(
    @Req() req: Request,
    @Param('userId') userId: string,
  ): Promise<ReadonlyArray<AdminDeviceView>> {
    return this.admin.listAccountDevices(await this.#access(req), userId);
  }

  /** Revoke one remembered device of an account and every session bound to it. */
  @Post('accounts/:userId/devices/:deviceId/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeAccountDevice(
    @Req() req: Request,
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ): Promise<RevokeAccountDeviceResult> {
    return this.admin.revokeAccountDevice(await this.#access(req), userId, deviceId);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * The caller's access context, restricted to tenant business data.
   *
   * Every administrative surface is tenant business data, so a
   * `pending_config` administrator is refused here rather than deeper in a
   * service, and the refusal is the dedicated `pending_config` code.
   */
  #access(req: Request): Promise<AccessContext> {
    return this.sessionAccess.requireBusiness(req);
  }
}

/** Read a required `enabled` boolean. */
function requireEnabled(record: Record<string, unknown>): boolean {
  const value = bodyOptionalBoolean(record, 'enabled');
  if (value === undefined) {
    throw new BadRequestException('enabled must be a boolean');
  }
  return value;
}

/** Read and validate a required `role` field. */
function requireRole(record: Record<string, unknown>): PlatformRole {
  const value = bodyRequiredString(record, 'role');
  if (!PLATFORM_ROLES.includes(value as PlatformRole)) {
    throw new BadRequestException(`role must be one of ${PLATFORM_ROLES.join(', ')}`);
  }
  return value as PlatformRole;
}
