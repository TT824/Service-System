import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a route as reachable without an identity. */
export const PUBLIC_ROUTE_KEY = 'kefu:public-route';

/**
 * Mark a route (or a whole controller) as publicly reachable.
 *
 * Only the endpoints that *establish* an identity may be public: sign-in,
 * registration, one-time code delivery and password recovery. Everything else
 * requires a verified session, so the guard refuses an anonymous request before
 * a handler ever runs.
 *
 * @returns The decorator.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE_KEY, true);
