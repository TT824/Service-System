import { describe, expect, it } from 'vitest';
import { evaluateRetention, tenantRetentionPolicies, type RetentionExpiredItem } from './retention';
import { DEFAULT_RETENTION_DAYS } from './types';

const NOW = '2026-09-09T00:00:00.000Z';

describe('retention', () => {
  it('flags entities older than the retention window', () => {
    const expired = evaluateRetention({
      kind: 'message',
      id: 'message-1',
      tenantId: 'tenant-acme',
      lastActivityAt: '2020-01-01T00:00:00.000Z',
      entity: 'message',
      now: NOW,
    });
    expect(expired).not.toBeNull();
    expect(expired).toMatchObject<Partial<RetentionExpiredItem>>({
      kind: 'message',
      id: 'message-1',
      retentionDays: DEFAULT_RETENTION_DAYS.message,
    });
  });

  it('keeps entities inside the retention window', () => {
    const kept = evaluateRetention({
      kind: 'message',
      id: 'message-2',
      tenantId: 'tenant-acme',
      lastActivityAt: NOW,
      entity: 'message',
      now: NOW,
    });
    expect(kept).toBeNull();
  });

  it('respects an explicit shorter policy', () => {
    const expired = evaluateRetention({
      kind: 'audit_log',
      id: 'audit-1',
      tenantId: 'tenant-acme',
      lastActivityAt: '2026-09-01T00:00:00.000Z',
      entity: 'audit_log',
      retentionDays: 1,
      now: NOW,
    });
    expect(expired).not.toBeNull();
  });

  it('builds per-entity default policies for a tenant', () => {
    const policies = tenantRetentionPolicies('tenant-acme');
    expect(policies.length).toBe(Object.keys(DEFAULT_RETENTION_DAYS).length);
    expect(policies.every((policy) => policy.tenantId === 'tenant-acme')).toBe(true);
  });
});
