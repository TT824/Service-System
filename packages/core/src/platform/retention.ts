/**
 * Retention evaluation.
 *
 * Retention is expressed as per-entity day windows. An entity with an activity
 * timestamp older than its window is considered expired and becomes a cleanup
 * candidate. The MVP exposes deterministic retention summaries; a future worker
 * performs the physical purge.
 */

import { DEFAULT_RETENTION_DAYS, type RetentionEntity, type TenantRetentionPolicy } from './types';

/** A retention candidate carrying the age in days and the governing policy. */
export type RetentionExpiredItem = {
  readonly kind: string;
  readonly id: string;
  readonly tenantId: string;
  readonly ageDays: number;
  readonly retentionDays: number;
};

/** Input for {@link evaluateRetention}. */
export type RetentionEvaluationInput = {
  readonly kind: string;
  readonly id: string;
  readonly tenantId: string;
  readonly lastActivityAt: string;
  readonly entity: RetentionEntity;
  readonly retentionDays?: number;
  readonly now: string;
};

/**
 * Decide whether an entity is past its retention window.
 *
 * @param input - Entity identity and activity timestamp plus the retention
 * window (defaulting to the platform-wide default for the entity kind).
 * @returns An expired item when the entity is older than the window.
 */
export function evaluateRetention(input: RetentionEvaluationInput): RetentionExpiredItem | null {
  const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS[input.entity];
  const lastActivityMs = Date.parse(input.lastActivityAt);
  if (Number.isNaN(lastActivityMs)) {
    return null;
  }
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    return null;
  }
  const ageDays = (nowMs - lastActivityMs) / 86_400_000;
  if (ageDays < retentionDays) {
    return null;
  }
  return {
    kind: input.kind,
    id: input.id,
    tenantId: input.tenantId,
    ageDays,
    retentionDays,
  };
}

/** Default retention policy for a tenant (falls back to platform defaults). */
export function tenantRetentionPolicies(
  tenantId: string | null,
): ReadonlyArray<TenantRetentionPolicy> {
  return (Object.keys(DEFAULT_RETENTION_DAYS) as ReadonlyArray<RetentionEntity>).map((entity) => ({
    tenantId,
    entity,
    retentionDays: DEFAULT_RETENTION_DAYS[entity],
  }));
}

/** Aggregate retention summary for one tenant. */
export type RetentionSummary = {
  readonly tenantId: string;
  readonly evaluatedAt: string;
  readonly policies: ReadonlyArray<TenantRetentionPolicy>;
  readonly expiredCountByEntity: Readonly<Record<string, number>>;
  readonly totalExpired: number;
};
