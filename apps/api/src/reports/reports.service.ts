import { Inject, Injectable } from '@nestjs/common';
import {
  computeReportMetrics,
  type AuditEntry,
  type ReportMetrics,
  type RetentionSummary,
} from '@kefu/core';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../platform/platform-repository';

/** Aggregate report snapshot for one tenant. */
export type ReportSummary = {
  readonly tenantId: string;
  readonly conversations: {
    readonly open: number;
    readonly claimed: number;
    readonly closed: number;
    readonly total: number;
  };
  readonly messages: {
    readonly inbound: number;
    readonly outbound: number;
    readonly total: number;
  };
  readonly review: {
    readonly pending: number;
    readonly approvedPhrases: number;
  };
  readonly retention: RetentionSummary;
  /**
   * The §4.8 metrics — 话术采纳率, 手打率 and 首响时间.
   *
   * Computed in `@kefu/core/platform/reports`, not here: the rules that decide
   * what these numbers mean are the acceptance criteria, and they belong where
   * they can be unit-tested against hand-built records. This service's job is
   * to gather the input.
   */
  readonly metrics: ReportMetrics;
};

const DEFAULT_AUDIT_LIMIT = 200;

/**
 * Reports and audit behavior.
 *
 * Summaries are computed from the tenant's persisted records, so a report shows
 * the same facts the workspace shows and survives a restart. Retention is
 * evaluated against the tenant policy windows and reported as counts (a future
 * worker performs physical cleanup); nothing here deletes anything.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository) {}

  async summary(tenantId: string): Promise<ReportSummary> {
    const [conversations, messages, pending, approvedPhrases, suggestionSets] = await Promise.all([
      this.repository.listConversations(tenantId),
      this.repository.listMessages(tenantId),
      this.repository.listReviewQueue(tenantId),
      this.repository.listApprovedPhrases(tenantId),
      // The 商品咨询 proxy. Only the conversation ids are used, but the sets
      // themselves are read so the report's scope has one definition, in the
      // repository, rather than a second query written here.
      this.repository.listSuggestionSets(tenantId),
    ]);
    const now = new Date().toISOString();
    return {
      tenantId,
      conversations: {
        open: conversations.filter((conversation) => conversation.status === 'open').length,
        claimed: conversations.filter((conversation) => conversation.status === 'claimed').length,
        closed: conversations.filter((conversation) => conversation.status === 'closed').length,
        total: conversations.length,
      },
      messages: {
        inbound: messages.filter((message) => message.direction === 'inbound').length,
        outbound: messages.filter((message) => message.direction === 'outbound').length,
        total: messages.length,
      },
      review: {
        pending: pending.length,
        approvedPhrases: approvedPhrases.length,
      },
      retention: await this.repository.summarizeRetention(tenantId, now),
      metrics: computeReportMetrics({
        conversations,
        messages,
        conversationsWithSuggestions: new Set(suggestionSets.map((set) => set.conversationId)),
      }),
    };
  }

  /** List tenant audit entries, newest first, capped at the requested limit. */
  async audit(tenantId: string, limit?: number): Promise<ReadonlyArray<AuditEntry>> {
    const entries = await this.repository.listAudit(tenantId);
    const capped = limit ?? DEFAULT_AUDIT_LIMIT;
    const effectiveLimit = capped < 1 ? DEFAULT_AUDIT_LIMIT : Math.min(capped, 500);
    return entries.slice(0, effectiveLimit);
  }
}
