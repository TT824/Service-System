/**
 * Review policy and approval rules.
 *
 * Review policy is platform-wide configuration. Only a platform super
 * administrator may modify it; merchant administrators and agents are refused
 * (403 at the HTTP boundary). Approving a candidate-backed outbound message
 * writes a tenant-scoped approved phrase and an audit entry.
 */

import {
  isReviewEligibleSource,
  REVIEW_ELIGIBLE_SOURCES,
  type Member,
  type MessageSource,
  type ReviewPolicy,
} from './types';

/** Input used to create the platform-wide review policy. */
export type ReviewPolicyInput = {
  readonly requireReview: boolean;
  readonly requireReviewForSources: ReadonlyArray<MessageSource>;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
};

/** Create a platform-scoped review policy. */
export function createReviewPolicy(input: ReviewPolicyInput): ReviewPolicy {
  return Object.freeze({
    id: 'review-policy-platform',
    scope: 'platform',
    requireReview: input.requireReview,
    requireReviewForSources: Object.freeze([...input.requireReviewForSources]),
    updatedBy: input.updatedBy,
    updatedAt: input.updatedAt,
  });
}

/** The default policy: candidate-backed messages are reviewed, others are not. */
export function defaultReviewPolicy(): ReviewPolicy {
  return createReviewPolicy({
    requireReview: true,
    requireReviewForSources: [...REVIEW_ELIGIBLE_SOURCES],
    updatedBy: null,
    updatedAt: null,
  });
}

/**
 * Check whether a member may modify the platform review policy.
 *
 * The policy is platform-wide, so the actor must be a genuine platform
 * principal: the platform role held at platform level. A member that carries
 * `platform_admin` *inside* a tenant is the contradictory row the `0005`
 * invariant forbids, and it resolves to platform authority and a tenant scope
 * at the same time. Granting it the global policy would let a member/account
 * link mint platform authority, so the tenant scope alone disqualifies it.
 *
 * @param member - The acting member (already resolved from the request).
 * @returns `true` only for an enabled, platform-level super administrator.
 */
export function canModifyReviewPolicy(member: Member): boolean {
  return member.enabled && member.role === 'platform_admin' && member.tenantId === null;
}

/** Outcome of validating a policy update. */
export type ReviewPolicyUpdateResult =
  | { readonly ok: true; readonly policy: ReviewPolicy }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate and apply a review policy update.
 *
 * @param _current - The current policy (kept for a future merge strategy).
 * @param next - The requested policy fields.
 * @returns The updated policy or a stable validation error.
 */
export function updateReviewPolicy(
  _current: ReviewPolicy,
  next: ReviewPolicyInput,
): ReviewPolicyUpdateResult {
  const invalidSource = next.requireReviewForSources.find(
    (source) => !isReviewEligibleSource(source),
  );
  if (invalidSource !== undefined) {
    return {
      ok: false,
      reason: `review sources are limited to eligible candidate sources: ${invalidSource}`,
    };
  }
  return { ok: true, policy: createReviewPolicy(next) };
}
