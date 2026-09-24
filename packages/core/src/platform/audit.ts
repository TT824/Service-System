/**
 * Audit entry construction.
 *
 * Every meaningful mutation writes an immutable audit entry so retention,
 * tenant review and the report views can observe who did what, when, and under
 * which tenant. Audit entries are always recorded with an actor and a tenant
 * scope when the action is tenant-owned.
 */

import { AUDIT_ACTIONS, type AuditEntry } from './types';

/** Stable audit actions re-exported for convenience. */
export { AUDIT_ACTIONS };

/** Input used to construct an audit entry. */
export type AuditEntryInput = {
  readonly id?: string;
  readonly tenantId: string | null;
  readonly actorMemberId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt?: string;
};

/** Create an immutable audit entry with defaults applied. */
export function createAuditEntry(input: AuditEntryInput): AuditEntry {
  return Object.freeze({
    id:
      input.id ??
      `audit-${input.createdAt ?? new Date().toISOString()}-${input.targetType}-${input.targetId ?? 'global'}`,
    tenantId: input.tenantId,
    actorMemberId: input.actorMemberId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}
