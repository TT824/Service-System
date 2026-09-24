import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  KefuStore,
  PLATFORM_ADMIN_MEMBER_ID,
  conversationReadAccess,
  isAdministratorRole,
  type Conversation,
  type ConversationReadAccess,
  type Member,
  type ResolvedSession,
} from '@kefu/core';
import { bearerTokenOf } from '../auth/bearer-token';
import { verifiedSessionOf } from '../auth/verified-identity';
import { PLATFORM_REPOSITORY, type PlatformRepository } from './platform-repository';

/**
 * Resolves the acting member and the effective tenant scope of a request.
 *
 * Identity has two sources, and a verified credential always wins:
 *
 * - A bearer session the global identity guard resolved. The acting member is
 *   the member that session *proved*, taken straight from its
 *   `AccessContext` — the same value the account center and the administrative
 *   surfaces enforce. A credential-backed request therefore never re-reads the
 *   directory to decide who is calling.
 * - The `x-member-id` demo header, accepted only where the environment permits
 *   it (`test`, or `local` with `AUTH_DEMO_IDENTITY_HEADERS=true`). It defaults
 *   to the seeded platform administrator and refuses unknown or disabled
 *   members. Production refuses these headers outright in the global guard, so
 *   this branch is unreachable there.
 *
 * `x-tenant-id` narrows the tenant scope for a platform administrator. Merchant
 * administrators and agents are always scoped to their own tenant and are
 * refused when the header names a different tenant.
 *
 * Tenant and store scopes are validated against the platform repository, so the
 * scope a request is allowed to use is checked against the same durable
 * directory the request will read and write. The demo-header member lookup is
 * the one exception: `resolveMember` has to answer synchronously because
 * `SessionAccessService` calls it from inside its own context builder, and a
 * header identity only exists outside production.
 */
@Injectable()
export class AccessService {
  /**
   * @param repository - The platform business fact source the request will read
   * and write, used to validate tenant and store scope.
   * @param demoDirectory - Deterministic directory seed consulted only by the
   * non-production `x-member-id` demo path.
   */
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
    private readonly demoDirectory: KefuStore,
  ) {}

  /**
   * Resolve the acting member of a request.
   *
   * @param req - The incoming HTTP request.
   * @returns The member the request acts through.
   * @throws {UnauthorizedException} When a bearer was presented but not
   * verified, or when the member is unknown.
   * @throws {ForbiddenException} When the member is disabled, or when the
   * verified account has no member to act through.
   */
  resolveMember(req: Request): Member {
    const verified = verifiedSessionOf(req);
    if (verified !== undefined) {
      return verifiedMember(verified);
    }
    // A bearer token that reaches this point without a verified identity never
    // passed the global identity guard. Refuse it rather than fall back to the
    // demo/platform-administrator default: an unverified credential must not
    // obtain an identity.
    if (bearerTokenOf(req) !== undefined) {
      throw new UnauthorizedException('the bearer token was not verified');
    }

    const raw = req.header('x-member-id');
    const memberId =
      raw !== undefined && raw.trim().length > 0 ? raw.trim() : PLATFORM_ADMIN_MEMBER_ID;
    return this.#requireDemoMember(memberId);
  }

  /**
   * Resolve the effective tenant scope for a member.
   *
   * @param req - The HTTP request carrying `x-tenant-id` for platform admins.
   * @param member - The resolved acting member.
   * @returns The tenant id the request may operate on.
   */
  async resolveTenantScope(req: Request, member: Member): Promise<string> {
    if (member.tenantId !== null) {
      const headerTenant = req.header('x-tenant-id');
      if (
        headerTenant !== undefined &&
        headerTenant.trim().length > 0 &&
        headerTenant !== member.tenantId
      ) {
        throw new ForbiddenException('tenant scope mismatch');
      }
      if ((await this.repository.getTenant(member.tenantId)) === undefined) {
        throw new NotFoundException('tenant not found');
      }
      return member.tenantId;
    }

    const headerTenant = req.header('x-tenant-id');
    if (headerTenant === undefined || headerTenant.trim().length === 0) {
      throw new BadRequestException('x-tenant-id is required for platform administrator requests');
    }
    const tenantId = headerTenant.trim();
    if ((await this.repository.getTenant(tenantId)) === undefined) {
      throw new NotFoundException('tenant not found');
    }
    return tenantId;
  }

  /** Validate that an optional store id belongs to the tenant scope. */
  async assertStoreInTenant(tenantId: string, storeId: string | undefined): Promise<void> {
    if (storeId === undefined) {
      return;
    }
    if ((await this.repository.getStore(tenantId, storeId)) === undefined) {
      throw new BadRequestException('store is not part of the tenant scope');
    }
  }

  /**
   * Resolve the effective store filter for a read query.
   *
   * A store never narrows an actor. It is an implicit column the server fills
   * (see `resolveServingStore`) rather than a scope a member is pinned to, so
   * every role reads tenant-wide: an explicit filter is validated against the
   * tenant and then used as asked, and omitting it reads across the tenant.
   *
   * This is also the reason writes are still safe: agents lost no permission
   * here, because the write gate is {@link requireConfigurator} — a rule about
   * the role, never about the store.
   *
   * @param _member - The resolved acting member. Kept for the call sites; the
   * role no longer changes the answer.
   * @param tenantId - The effective tenant scope.
   * @param storeId - The requested store filter, if any.
   * @returns The effective store id to filter by, or `undefined` for the whole
   * tenant. Throws when the requested store is outside the tenant.
   */
  async resolveStoreScope(
    _member: Member,
    tenantId: string,
    storeId: string | undefined,
  ): Promise<string | undefined> {
    if (storeId !== undefined) {
      await this.assertStoreInTenant(tenantId, storeId);
    }
    return storeId;
  }

  /** Throw unless the member may mutate knowledge configuration. */
  requireConfigurator(member: Member): void {
    if (member.role !== 'merchant_admin' && member.role !== 'platform_admin') {
      throw new ForbiddenException('only tenant administrators may change knowledge');
    }
  }

  /**
   * Throw unless the member is a platform administrator.
   *
   * For the facts that belong to the platform rather than to a tenant: which
   * provider account a deployment answers for, and which scope its callbacks are
   * written into. A tenant administrator may read a channel's status; naming the
   * account the platform resolves is the platform's own act.
   */
  requirePlatformAdmin(member: Member): void {
    if (member.role !== 'platform_admin') {
      throw new ForbiddenException('platform administrator privileges are required');
    }
  }

  /** Look up a member of the demo directory used by `x-member-id` requests. */
  #requireDemoMember(memberId: string): Member {
    const member = this.demoDirectory.getMember(memberId);
    if (member === undefined) {
      throw new UnauthorizedException(`unknown member id`);
    }
    if (!member.enabled) {
      throw new ForbiddenException('member is disabled');
    }
    return member;
  }

  /**
   * How far this member may read one conversation, or `undefined` when it may not.
   *
   * The rule is core's ({@link conversationReadAccess}); this resolves the one
   * fact it needs — when the conversation last left this member's hands — and
   * reads it unconditionally, so the branch order stays the rule's own and not a
   * second copy here.
   *
   * @param tenantId - Effective tenant scope.
   * @param conversation - The conversation being read.
   * @param member - The reader.
   * @returns The reader's access, or `undefined` for a conversation it may not read.
   */
  async conversationReadAccess(
    tenantId: string,
    conversation: Conversation,
    member: Member,
  ): Promise<ConversationReadAccess | undefined> {
    return conversationReadAccess({
      conversation,
      readerMemberId: member.id,
      readerIsAdmin: isAdministratorRole(member.role),
      handedOffAt: await this.repository.lastHandoverFrom(tenantId, conversation.id, member.id),
    });
  }
}

/**
 * The member a verified session acts through.
 *
 * The member comes from the session's own access context, which is what the
 * account center and the administrative surfaces enforce, so every surface
 * agrees on who is calling. No directory read happens here: the context is
 * already the verified answer, and re-reading it would let a concurrent
 * directory change disagree with the session that was authorized.
 *
 * @param resolved - Session the identity guard verified.
 * @returns The member of this platform directory.
 * @throws {ForbiddenException} When the account is not configured for tenant
 * business data yet, or its member is disabled.
 */
function verifiedMember(resolved: ResolvedSession): Member {
  const member = resolved.access.member;
  if (member === null) {
    throw new ForbiddenException('the account is not configured for tenant business data');
  }
  if (!member.enabled) {
    throw new ForbiddenException('member is disabled');
  }
  return member;
}
