import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  canModifyReviewPolicy,
  isReviewEligibleSource,
  updateReviewPolicy,
  type ApprovalResult,
  type ApprovedPhrase,
  type Member,
  type Message,
  type MessageSource,
  type ReviewPolicy,
} from '@kefu/core';
import { AccessService } from '../platform/access.service';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../platform/platform-repository';

/** Review policy update request after body validation. */
export type ReviewPolicyUpdate = {
  readonly requireReview?: boolean;
  readonly requireReviewForSources?: ReadonlyArray<MessageSource>;
};

/** Outcome of an approval mutation. */
export type ApprovalPayload = {
  readonly message: Message;
  readonly phrase: ApprovedPhrase;
};

/**
 * Review behavior: platform review policy, the pending review queue and
 * approvals that write tenant-scoped approved phrases plus audit entries.
 *
 * The policy is platform-wide, so it is read and written without a tenant
 * argument, while the queue, the approvals and the phrases are always scoped to
 * the acting tenant. An approval writes the message state, the phrase and the
 * audit entry as one durable unit, so a half-approved message cannot be read
 * back after a crash.
 */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
    private readonly access: AccessService,
  ) {}

  policy(): Promise<ReviewPolicy> {
    return this.repository.getReviewPolicy();
  }

  /** Apply a review policy update; only a platform administrator may do so. */
  async updatePolicy(member: Member, input: ReviewPolicyUpdate): Promise<ReviewPolicy> {
    if (!canModifyReviewPolicy(member)) {
      throw new ForbiddenException('only the platform administrator may change the review policy');
    }
    if (input.requireReviewForSources !== undefined) {
      const invalidSource = input.requireReviewForSources.find(
        (source) => !isReviewEligibleSource(source),
      );
      if (invalidSource !== undefined) {
        throw new BadRequestException(
          `review sources are limited to eligible candidate sources: ${invalidSource}`,
        );
      }
    }

    const current = await this.repository.getReviewPolicy();
    const now = new Date().toISOString();
    const outcome = updateReviewPolicy(current, {
      requireReview: input.requireReview ?? current.requireReview,
      requireReviewForSources: input.requireReviewForSources ?? current.requireReviewForSources,
      updatedBy: member.id,
      updatedAt: now,
    });
    if (!outcome.ok) {
      throw new BadRequestException(outcome.reason);
    }
    const stored = await this.repository.setReviewPolicy(outcome.policy);
    await this.repository.appendAudit({
      tenantId: null,
      actorMemberId: member.id,
      action: AUDIT_ACTIONS.policyUpdated,
      targetType: 'review-policy',
      targetId: stored.id,
      metadata: {
        requireReview: stored.requireReview,
        requireReviewForSources: [...stored.requireReviewForSources],
      },
      createdAt: now,
    });
    return stored;
  }

  async queue(tenantId: string, member: Member, storeId?: string): Promise<ReadonlyArray<Message>> {
    const scope = await this.access.resolveStoreScope(member, tenantId, storeId);
    return this.repository.listReviewQueue(tenantId, scope);
  }

  /** Approve a candidate-backed message; returns the message and approved phrase. */
  async approve(tenantId: string, member: Member, messageId: string): Promise<ApprovalPayload> {
    const message = await this.repository.getMessage(tenantId, messageId);
    if (message === undefined) {
      throw new NotFoundException('message not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, message.storeId);
    const result: ApprovalResult = await this.repository.approveMessage(
      tenantId,
      messageId,
      member.id,
      new Date().toISOString(),
    );
    if (!result.ok) {
      switch (result.code) {
        case 'not_found':
          throw new NotFoundException(result.reason);
        case 'not_eligible':
          throw new BadRequestException(result.reason);
        case 'already_reviewed':
          throw new ConflictException(result.reason);
      }
    }
    return { message: result.message, phrase: result.phrase };
  }

  phrases(tenantId: string): Promise<ReadonlyArray<ApprovedPhrase>> {
    return this.repository.listApprovedPhrases(tenantId);
  }
}
