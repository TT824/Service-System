import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import {
  AuthService,
  KefuStore,
  assertAccessAllowed,
  allowsDemoIdentityHeaders,
  buildAccessContext,
  type AccessContext,
  type AppConfig,
  type ResolvedSession,
} from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { AccessService } from '../platform/access.service';
import { bearerTokenOf } from './bearer-token';

/**
 * Resolves the access context of a request from its bearer session.
 *
 * This is the credential-backed counterpart of the header-based
 * {@link AccessService}: it turns the `Authorization: Bearer <token>` header
 * into the same {@link AccessContext} shape, so a surface can enforce the
 * account/member/tenant/store boundary without knowing how the caller proved
 * who they were.
 *
 * Two identity sources exist and only one is ever used for a given request:
 *
 * 1. A bearer token, verified against the session repository. This is the only
 *    source production accepts.
 * 2. The `x-member-id` / `x-tenant-id` demo headers, accepted exclusively
 *    outside production (always in `test`, in `local` only with
 *    `AUTH_DEMO_IDENTITY_HEADERS=true`) and only when no bearer token was
 *    presented. The resulting context reports `authMethod: 'header'` so nothing
 *    downstream can mistake it for a verified credential.
 *
 * Resolution is memoised per request: a request that reads its context from a
 * guard, a controller and a service pays for exactly one session lookup and one
 * `last_seen_at` write.
 */
@Injectable()
export class SessionAccessService {
  /**
   * Per-request cache of resolved sessions.
   *
   * Keyed by the request object, which is a fresh instance per HTTP request, so
   * entries are collected with the request. The token itself is never a key, and
   * the service is a singleton per application, so the cache cannot outlive the
   * requests it describes.
   */
  readonly #cache = new WeakMap<Request, Promise<ResolvedSession>>();

  /**
   * @param auth - Domain service that verifies a bearer token.
   * @param config - Parsed configuration, for the demo-header boundary.
   * @param platformAccess - Header-based resolver used only by the demo path.
   * @param store - Platform kernel directory, used only by the demo path.
   */
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly platformAccess: AccessService,
    private readonly store: KefuStore,
  ) {}

  /**
   * Resolve the bearer session of a request.
   *
   * @param req - The incoming HTTP request.
   * @returns The verified session, its account and its access context.
   * @throws {UnauthorizedException} When no bearer token is presented.
   * @throws {AuthError} When the token is unknown, expired, revoked, replayed or
   * belongs to an account that is no longer usable.
   */
  resolve(req: Request): Promise<ResolvedSession> {
    const token = bearerTokenOf(req);
    if (token === undefined) {
      throw new UnauthorizedException('a bearer token is required');
    }
    const cached = this.#cache.get(req);
    if (cached !== undefined) {
      return cached;
    }
    const pending = this.auth.resolveSession(token);
    this.#cache.set(req, pending);
    return pending;
  }

  /**
   * Resolve the access context of a request.
   *
   * A bearer token always wins. Without one, the demo identity headers are used
   * when this environment allows them; otherwise the request is unauthenticated.
   *
   * @param req - The incoming HTTP request.
   * @returns The resolved access context.
   * @throws {UnauthorizedException} When the request carries no usable identity.
   */
  async resolveAccess(req: Request): Promise<AccessContext> {
    if (bearerTokenOf(req) !== undefined) {
      const resolved = await this.resolve(req);
      return resolved.access;
    }
    if (!allowsDemoIdentityHeaders(this.config)) {
      throw new UnauthorizedException('a bearer token is required');
    }
    return this.#demoAccess(req);
  }

  /**
   * Resolve the context of a request that needs tenant business data.
   *
   * @param req - The incoming HTTP request.
   * @returns The resolved access context.
   * @throws {AuthError} `pending_config` when the account is not configured for
   * business data, `access_denied` when it is disabled.
   */
  async requireBusiness(req: Request): Promise<AccessContext> {
    const access = await this.resolveAccess(req);
    assertAccessAllowed(access, 'business_data');
    return access;
  }

  /**
   * Resolve the context of a request that only needs the account center.
   *
   * @param req - The incoming HTTP request.
   * @returns The resolved access context.
   * @throws {AuthError} `access_denied` when the account is disabled.
   */
  async requireAccountCenter(req: Request): Promise<AccessContext> {
    const access = await this.resolveAccess(req);
    assertAccessAllowed(access, 'account_center');
    return access;
  }

  /**
   * Build the access context of a demo identity header request.
   *
   * The context is assembled from the same directory facts a session-backed one
   * uses — the member, its tenant, its stores — so a demo request is scoped
   * exactly like the credential-backed request it stands in for. There is no
   * account behind a header identity, so the member id is reported as the acting
   * user and the access state is derived from the member and tenant alone.
   *
   * The `x-tenant-id` header is deliberately *not* consulted: an access context
   * carries the tenant of the member it acts through, and a request that names a
   * different tenant is refused downstream by the same tenant-administrator
   * check a session-backed request would hit.
   */
  async #demoAccess(req: Request): Promise<AccessContext> {
    const member = this.platformAccess.resolveMember(req);
    const tenantId = member.tenantId;
    const tenant = tenantId === null ? null : (this.store.getTenant(tenantId) ?? null);
    const stores = tenantId === null ? [] : this.store.listStores(tenantId);
    const context = buildAccessContext({
      session: {
        id: `demo:${member.id}`,
        userId: member.id,
        tenantId,
        memberId: member.id,
        trustedDeviceId: null,
        tokenFingerprint: '',
        previousTokenFingerprint: null,
        rotationFamilyId: `demo:${member.id}`,
        // Placeholder: the context returned below reports `header`, because no
        // session was ever issued for a demo identity.
        authMethod: 'sso',
        status: 'active',
        mfaSatisfied: false,
        clientFingerprint: null,
        idempotencyKey: null,
        issuedAt: member.createdAt,
        expiresAt: member.createdAt,
        lastSeenAt: member.createdAt,
        revokedAt: null,
        revokedReason: null,
        createdAt: member.createdAt,
        updatedAt: member.createdAt,
      },
      accountStatus: 'active',
      member,
      tenant,
      link: { id: `demo:${member.id}` },
      storeScopes: [],
      tenantStores: stores,
    });
    return { ...context, authMethod: 'header' };
  }
}
