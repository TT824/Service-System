import { describe, expect, it } from 'vitest';
import type { Member } from './types';
import {
  MESSAGE_SOURCES,
  REVIEW_ELIGIBLE_SOURCES,
  countsAsFirstReply,
  isReviewEligibleSource,
} from './types';
import { canModifyReviewPolicy, defaultReviewPolicy, updateReviewPolicy } from './review';

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: 'u-1',
    tenantId: null,
    storeId: null,
    role: 'platform_admin',
    username: 'root',
    displayName: '平台管理员',
    enabled: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('review policy', () => {
  it('limits policy modification to platform super administrators', () => {
    expect(canModifyReviewPolicy(member({ role: 'platform_admin' }))).toBe(true);
    expect(canModifyReviewPolicy(member({ role: 'merchant_admin', tenantId: 'tenant-acme' }))).toBe(
      false,
    );
    expect(canModifyReviewPolicy(member({ role: 'agent', tenantId: 'tenant-acme' }))).toBe(false);
    expect(canModifyReviewPolicy(member({ enabled: false }))).toBe(false);
  });

  it('refuses the platform role when it is held inside a tenant', () => {
    // The contradictory record migration `0005` forbids: the platform role
    // carried by a tenant-scoped member. It resolves to platform authority and
    // a tenant context at once, so it must never reach the global policy.
    const scoped = member({ role: 'platform_admin', tenantId: 'tenant-acme' });
    expect(canModifyReviewPolicy(scoped)).toBe(false);

    const scopedStore = member({
      role: 'platform_admin',
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
    });
    expect(canModifyReviewPolicy(scopedStore)).toBe(false);
  });

  it('marks only candidate-backed sources as review eligible', () => {
    expect(isReviewEligibleSource('direct_candidate')).toBe(true);
    expect(isReviewEligibleSource('edited_send')).toBe(true);
    expect(isReviewEligibleSource('manual_typed')).toBe(false);
    expect(isReviewEligibleSource('shortcut')).toBe(false);
    expect(isReviewEligibleSource('faq_auto')).toBe(false);
    expect(isReviewEligibleSource('other')).toBe(false);
    expect(REVIEW_ELIGIBLE_SOURCES).toEqual(['direct_candidate', 'edited_send']);
  });

  it('counts every source except the automated one as a reply to the customer', () => {
    expect(countsAsFirstReply('direct_candidate')).toBe(true);
    expect(countsAsFirstReply('edited_send')).toBe(true);
    expect(countsAsFirstReply('manual_typed')).toBe(true);
    expect(countsAsFirstReply('shortcut')).toBe(true);
    expect(countsAsFirstReply('faq_auto')).toBe(true);
    // The offline auto-reply is the only automated send, so it must not stop a
    // clock that measures how long the customer waited for a person.
    expect(countsAsFirstReply('other')).toBe(false);
  });

  it('agrees with the review rule that no eligible source is the automated one', () => {
    for (const source of MESSAGE_SOURCES) {
      if (!countsAsFirstReply(source)) {
        expect(isReviewEligibleSource(source)).toBe(false);
      }
    }
  });

  it('rejects a policy update that enables a metrics-only source', () => {
    const result = updateReviewPolicy(defaultReviewPolicy(), {
      requireReview: true,
      requireReviewForSources: ['manual_typed'],
      updatedBy: 'u-platform-admin',
      updatedAt: '2026-09-09T00:00:00.000Z',
    });
    expect(result).toMatchObject({ ok: false });
  });

  it('applies a valid policy update', () => {
    const result = updateReviewPolicy(defaultReviewPolicy(), {
      requireReview: false,
      requireReviewForSources: [...REVIEW_ELIGIBLE_SOURCES],
      updatedBy: 'u-platform-admin',
      updatedAt: '2026-09-09T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.policy.requireReview).toBe(false);
    expect(result.policy.scope).toBe('platform');
    expect(result.policy.updatedBy).toBe('u-platform-admin');
  });
});
