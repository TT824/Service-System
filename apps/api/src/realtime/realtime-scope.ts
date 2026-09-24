import type { Request } from 'express';
import type { RealtimeScope } from '@kefu/core';

/**
 * The scope one event stream is authorized to read.
 *
 * Resolved once, by {@link RealtimeScopeGuard}, before the response is switched
 * to the event stream, and read back by the controller. It is carried on the
 * request rather than recomputed because the two must not be able to disagree:
 * a stream authorized as one scope and filtered as another would either leak a
 * frame or silently withhold one.
 *
 * The carrier is a `WeakMap` keyed by the request object, which is a fresh
 * instance per HTTP request: entries are collected with the request they
 * describe and can never be observed by another one. The same idiom as the
 * verified session in `auth/verified-identity.ts`.
 */
const streamScopes = new WeakMap<Request, RealtimeScope>();

/**
 * Remember the scope a stream was authorized for.
 *
 * @param request - The incoming HTTP request.
 * @param scope - The tenant and store the stream may read.
 */
export function rememberRealtimeScope(request: Request, scope: RealtimeScope): void {
  streamScopes.set(request, scope);
}

/**
 * The scope a stream was authorized for.
 *
 * @param request - The incoming HTTP request.
 * @returns The scope, or `undefined` when the request has not been through
 * {@link RealtimeScopeGuard} — which a routed request cannot be, since the guard
 * runs before the handler.
 */
export function realtimeScopeOf(request: Request): RealtimeScope | undefined {
  return streamScopes.get(request);
}
