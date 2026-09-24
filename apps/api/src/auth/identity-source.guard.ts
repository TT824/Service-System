import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { allowsDemoIdentityHeaders, type AppConfig, type ResolvedSession } from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { API_PREFIX } from '../http/api-prefix';
import { toHttpException } from './auth-error.interceptor';
import { bearerTokenOf } from './bearer-token';
import { PUBLIC_ROUTE_KEY } from './public-route.decorator';
import { SessionAccessService } from './session-access.service';
import { rememberVerifiedSession } from './verified-identity';

/** Header carrying the demo acting member. */
const DEMO_MEMBER_HEADER = 'x-member-id';

/**
 * Refuses unauthenticated business requests before any handler runs.
 *
 * The guard answers one question: *does this request have a verified identity?*
 * A bearer token is not merely detected here, it is resolved against the
 * session repository, so a token that is unknown, malformed, expired, revoked,
 * replayed or bound to a disabled account is refused with 401 before a handler
 * or feature service can see the request — and it can never be mistaken for the
 * header-based default identity. The resolved session is remembered for the
 * request so the feature surfaces enforce the boundary of the member the
 * credential actually proved.
 *
 * The rules, in order:
 *
 * 1. In production the demo identity headers are refused outright, whether or
 *    not a bearer token is also present. A production request that tries to name
 *    its own identity is a spoofing attempt, not a fallback.
 * 2. Public routes (health probes, and the endpoints that establish an identity)
 *    pass untouched.
 * 3. A bearer token passes once its session is verified. The verification is
 *    memoised per request, so a request that reads its context from a guard, a
 *    controller and a service pays for exactly one session lookup.
 * 4. Outside production a demo identity header is accepted. `test` always
 *    allows it, `local` only with `AUTH_DEMO_IDENTITY_HEADERS=true`.
 * 5. Anything else is unauthenticated: 401 with the platform's stable
 *    `unauthorized` code.
 */
@Injectable()
export class IdentitySourceGuard implements CanActivate {
  /**
   * @param config - Parsed configuration, for the demo-header boundary.
   * @param reflector - Reads the `@Public()` marker off the route.
   * @param sessionAccess - Verifies the bearer session of the request.
   */
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
    private readonly sessionAccess: SessionAccessService,
  ) {}

  /** @inheritdoc */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();

    if (this.#presentsDemoIdentity(request) && !allowsDemoIdentityHeaders(this.config)) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: `${DEMO_MEMBER_HEADER} is not accepted in this environment`,
      });
    }

    if (this.#isPublic(context) || isHealthPath(request.path)) {
      return true;
    }
    if (bearerTokenOf(request) !== undefined) {
      rememberVerifiedSession(request, await this.#verifyBearer(request));
      return true;
    }
    if (allowsDemoIdentityHeaders(this.config)) {
      return true;
    }

    throw new UnauthorizedException('authentication is required');
  }

  /**
   * Verify the presented bearer token.
   *
   * Guards run before interceptors, so the domain failure is projected onto the
   * HTTP contract here rather than by {@link AuthErrorInterceptor}.
   *
   * @param request - Request carrying an `Authorization: Bearer` header.
   * @returns The verified session, account and access context.
   */
  async #verifyBearer(request: Request): Promise<ResolvedSession> {
    try {
      return await this.sessionAccess.resolve(request);
    } catch (error) {
      throw toHttpException(error);
    }
  }

  /** Whether the request carries a non-empty demo member header. */
  #presentsDemoIdentity(request: Request): boolean {
    const raw = request.header(DEMO_MEMBER_HEADER);
    return raw !== undefined && raw.trim().length > 0;
  }

  /** Whether the route (or its controller) is marked `@Public()`. */
  #isPublic(context: ExecutionContext): boolean {
    const marked = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return marked === true;
  }
}

/**
 * Whether a request path is one of the health probes.
 *
 * The health module is owned by an earlier task and carries no `@Public()`
 * marker, and it cannot be annotated from here without leaving this task's
 * scope. An orchestrator has no credential to present, so the probes are
 * recognised by path instead.
 *
 * @param path - Request path, with or without the global API prefix.
 * @returns `true` for the liveness and readiness endpoints.
 */
export function isHealthPath(path: string): boolean {
  const prefix = `/${API_PREFIX}`;
  const normalized = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return normalized === '/health' || normalized.startsWith('/health/');
}
