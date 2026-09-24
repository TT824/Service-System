import type { Request } from 'express';
import type { ResolvedSession } from '@kefu/core';

/**
 * The verified session of one request.
 *
 * A bearer token is turned into an identity in exactly one place, the global
 * {@link IdentitySourceGuard}, and that guard runs before any handler or
 * feature surface. The header-based access kernel then reads the identity from
 * here instead of resolving one itself, so a credential-backed request is
 * always scoped to the member the credential proved and can never fall back to
 * the demo/platform-administrator default.
 *
 * The carrier is a `WeakMap` keyed by the request object, which is a fresh
 * instance per HTTP request: entries are collected with the request they
 * describe and can never be observed by another one.
 */
const verifiedSessions = new WeakMap<Request, ResolvedSession>();

/**
 * Remember the session a request was verified against.
 *
 * @param request - The incoming HTTP request.
 * @param resolved - The session, account and access context the token proved.
 */
export function rememberVerifiedSession(request: Request, resolved: ResolvedSession): void {
  verifiedSessions.set(request, resolved);
}

/**
 * The session a request was verified against.
 *
 * @param request - The incoming HTTP request.
 * @returns The verified session, or `undefined` when none was resolved for this
 * request — either because it carried no credential or because it has not been
 * through the identity guard.
 */
export function verifiedSessionOf(request: Request): ResolvedSession | undefined {
  return verifiedSessions.get(request);
}
