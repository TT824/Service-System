import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AccessService } from '../platform/access.service';
import { rememberRealtimeScope } from './realtime-scope';

/**
 * Authorize one event stream and remember the scope it may read.
 *
 * This is a guard rather than the first lines of the handler for a concrete
 * reason: a handler that throws on an event-stream route does not produce an
 * HTTP error. Nest turns the rejection into an observable error, the SSE writer
 * catches it, and the caller receives `200` with an `event: error` frame — so a
 * refused stream would be indistinguishable from an accepted one that failed
 * later, and no proxy or monitor could tell them apart either. A guard's
 * exception is thrown before any of that machinery, so a refusal here is the
 * ordinary JSON error envelope with a real status code (400, 401, 403 or 404).
 *
 * The scope is resolved with the very resolvers the REST readers use, so a seat
 * cannot be told about a store it could not have read over the API.
 */
@Injectable()
export class RealtimeScopeGuard implements CanActivate {
  /**
   * @param access - Resolves the acting member and its tenant/store scope.
   */
  constructor(private readonly access: AccessService) {}

  /** @inheritdoc */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const member = this.access.resolveMember(request);
    const tenantId = await this.access.resolveTenantScope(request, member);
    const storeId = await this.access.resolveStoreScope(member, tenantId, undefined);
    rememberRealtimeScope(request, { tenantId, storeId });
    return true;
  }
}
