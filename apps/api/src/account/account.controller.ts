import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type AccessContext, type AccountCenterView } from '@kefu/core';
import { bearerTokenOf } from '../auth/bearer-token';
import { SessionAccessService } from '../auth/session-access.service';

/**
 * Account-center endpoints.
 *
 * These are the surfaces a `pending_config` account can still reach: an account
 * whose member link was revoked, or whose tenant was switched off, keeps access
 * to its own profile, sessions and devices while tenant business data stays
 * closed. The access context is resolved once and reused, so the account center
 * and the business surfaces enforce the exact same boundary.
 */
@Controller('account')
export class AccountController {
  /**
   * @param auth - Domain service that owns the account views.
   * @param sessionAccess - Resolves the caller's access context.
   */
  constructor(
    private readonly auth: AuthService,
    private readonly sessionAccess: SessionAccessService,
  ) {}

  /**
   * The caller's effective access context.
   *
   * Deliberately reachable with either identity source, including a
   * `pending_config` account: it is how a client discovers *why* its business
   * requests are refused.
   */
  @Get('access')
  async access(@Req() req: Request): Promise<{ readonly access: AccessContext }> {
    const access = await this.sessionAccess.requireAccountCenter(req);
    return { access };
  }

  /**
   * The full account center: profile, identities, directories, sessions and
   * devices.
   *
   * Requires a real bearer session, because there is nothing to show for a demo
   * identity header — it names a member, not an account.
   */
  @Get('center')
  async center(@Req() req: Request): Promise<AccountCenterView> {
    await this.sessionAccess.requireAccountCenter(req);
    const token = bearerTokenOf(req);
    if (token === undefined) {
      throw new UnauthorizedException('the account center requires a bearer session');
    }
    return this.auth.accountCenter(token);
  }
}
