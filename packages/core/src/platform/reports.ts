/**
 * The §4.8 business metrics, as pure functions over records already stored.
 *
 * These are the numbers the MVP is accepted on — 话术采纳率 ≥ 60%, 手打率 ≤ 20%,
 * 首响较纯人工降低 30%+ — so the rules that decide them live here, in the
 * domain, rather than in the report service. The service gathers records; this
 * file decides what they mean. That split is what lets the acceptance criterion
 * ("构造 1 采纳 + 1 编辑 + 1 手打，三个比率精确可算") be settled by a unit test
 * rather than by a running stack.
 *
 * ## What is measured, and what is assumed
 *
 * §4.8 keys both rates to 意图为商品咨询. This platform has no intent
 * classifier, so per the 09-20 decision the proxy is: **a conversation counts
 * as a 商品咨询 once it has produced a suggestion set**. One consequence is
 * visible in the shape below and worth stating rather than discovering later:
 * **the two denominators collapse into one.** §4.8 gives 采纳率 the extra clause
 * 且系统已生成候选话术 and gives 手打率 no such clause, so the two could only
 * differ where intent exists without a suggestion set — which the proxy makes
 * impossible by construction. Both rates divide by the same population, and
 * {@link ReportMetrics.scope} reports that population so the reading is
 * auditable instead of assumed.
 *
 * §4.8 also requires 快捷短语、FAQ、自动回复和编辑后发送 to be counted
 * separately. That is {@link ReportMetrics.sourceBreakdown}: every in-scope
 * outbound message lands in exactly one bucket, so the rates and the breakdown
 * add up to the same population. A breakdown that did not reconcile would be a
 * second, quieter definition of the same thing.
 */

import { firstResponseDurationMs } from './assignment';
import {
  MESSAGE_SOURCES,
  countsAsFirstReply,
  type Conversation,
  type Message,
  type MessageSource,
} from './types';

/** A population count and the rate it yields. */
export type RatioSummary = {
  readonly numerator: number;
  readonly denominator: number;
  /**
   * The fraction in `[0, 1]`, or `null` when the denominator is zero.
   *
   * `null` rather than `0`: a rate over an empty population is undefined, and a
   * report printing 0% for it would say "no seat ever adopts a candidate" when
   * the truth is "nothing was in scope yet". At pilot start, with a fresh
   * tenant, that is the difference between a failing metric and an empty one.
   */
  readonly rate: number | null;
};

/** Latency over the conversations that could be measured. */
export type DurationSummary = {
  /** How many conversations contributed. Zero makes every field below `null`. */
  readonly measured: number;
  readonly averageMs: number | null;
  readonly p50Ms: number | null;
  readonly p90Ms: number | null;
  readonly maxMs: number | null;
};

/** How many in-scope outbound messages came from each source. */
export type MessageSourceBreakdown = Readonly<Record<MessageSource, number>>;

/** The §4.8 metrics for one tenant snapshot. */
export type ReportMetrics = {
  /**
   * The populations the rates were taken over.
   *
   * Reported because a rate without its denominator is not a measurement. The
   * three outbound counts reconcile — `outboundInScope` equals the breakdown's
   * total plus `unsourcedOutbound`, and together with `outboundOutsideScope`
   * they sum to every outbound message the tenant has — so an operator can tell
   * "the desk stopped using candidates" from "the desk left the measured scope".
   */
  readonly scope: {
    readonly conversations: number;
    readonly conversationsWithSuggestions: number;
    readonly outboundInScope: number;
    readonly outboundOutsideScope: number;
    /**
     * Outbound messages whose source is unrecorded, excluded from the breakdown.
     *
     * `Message.source` is nullable, and a message whose provenance nobody
     * recorded is not evidence of any of the six sources. Folding it into
     * `other` would invent a fact about it.
     */
    readonly unsourcedOutbound: number;
  };
  readonly firstResponse: {
    /** The platform's own field: `firstResponseStartedAt` → `firstReplyAt`. */
    readonly fromQueue: DurationSummary;
    /**
     * The same question asked of the message log: first inbound → first
     * human-equivalent reply after it.
     *
     * Two columns rather than one because the stored field is not a durable
     * record of the customer's first wait. {@link reopenConversation} clears
     * `firstReplyAt` for a new round while deliberately leaving
     * `firstResponseStartedAt` alone, so a conversation that was closed and
     * reopened gets its stored pair *overwritten* with (first-ever pool entry →
     * latest round's reply) — a span that crosses the closed gap and is neither
     * the first response nor the current round's. The message log cannot drift
     * that way, which is why this column is computed from it. On today's data
     * the two agree to the millisecond for every conversation with a single
     * round, so a divergence here is a finding, not noise.
     */
    readonly fromFirstInbound: DurationSummary;
  };
  readonly adoption: RatioSummary;
  readonly manualTyping: RatioSummary;
  readonly sourceBreakdown: MessageSourceBreakdown;
};

/** The fields of a conversation this file reads. */
export type MetricConversation = Pick<
  Conversation,
  'id' | 'firstResponseStartedAt' | 'firstReplyAt'
>;

/** The fields of a message this file reads. */
export type MetricMessage = Pick<Message, 'conversationId' | 'direction' | 'source' | 'createdAt'>;

/** The records one metrics snapshot is computed from. */
export type ReportMetricsInput = {
  readonly conversations: ReadonlyArray<MetricConversation>;
  readonly messages: ReadonlyArray<MetricMessage>;
  /**
   * Conversations that have produced at least one suggestion set.
   *
   * The §4.8 商品咨询 proxy, passed as an id set rather than as suggestion
   * records so this file depends on the one fact it uses.
   */
  readonly conversationsWithSuggestions: ReadonlySet<string>;
};

/**
 * Compute the §4.8 metrics for one tenant snapshot.
 *
 * @param input - The tenant's conversations, messages and the suggestion-set
 *   proxy population.
 * @returns The metrics, including the populations they were taken over.
 */
export function computeReportMetrics(input: ReportMetricsInput): ReportMetrics {
  const { conversations, messages, conversationsWithSuggestions } = input;

  const inboundByConversation = new Map<string, MetricMessage[]>();
  const outboundByConversation = new Map<string, MetricMessage[]>();
  for (const message of messages) {
    const bucket = message.direction === 'inbound' ? inboundByConversation : outboundByConversation;
    const existing = bucket.get(message.conversationId);
    if (existing === undefined) {
      bucket.set(message.conversationId, [message]);
    } else {
      existing.push(message);
    }
  }

  const breakdown = emptyBreakdown();
  let outboundInScope = 0;
  let outboundOutsideScope = 0;
  let unsourcedOutbound = 0;

  for (const message of outboundByConversation.values()) {
    for (const outbound of message) {
      if (!conversationsWithSuggestions.has(outbound.conversationId)) {
        outboundOutsideScope += 1;
        continue;
      }
      outboundInScope += 1;
      if (outbound.source === null) {
        unsourcedOutbound += 1;
        continue;
      }
      breakdown[outbound.source] += 1;
    }
  }

  const denominator = outboundInScope - unsourcedOutbound;

  return {
    scope: {
      conversations: conversations.length,
      conversationsWithSuggestions: conversationsWithSuggestions.size,
      outboundInScope,
      outboundOutsideScope,
      unsourcedOutbound,
    },
    firstResponse: {
      fromQueue: summarizeDurations(
        conversations.map((conversation) =>
          firstResponseDurationMs(conversation.firstResponseStartedAt, conversation.firstReplyAt),
        ),
      ),
      fromFirstInbound: summarizeDurations(
        conversations.map((conversation) =>
          customerWaitMs(
            inboundByConversation.get(conversation.id) ?? [],
            outboundByConversation.get(conversation.id) ?? [],
          ),
        ),
      ),
    },
    adoption: ratio(breakdown.direct_candidate, denominator),
    manualTyping: ratio(breakdown.manual_typed, denominator),
    sourceBreakdown: Object.freeze(breakdown),
  };
}

/**
 * How long the customer waited for a human-equivalent reply, from their first
 * inbound message.
 *
 * The reply is the first one that {@link countsAsFirstReply} and that does not
 * precede the question — an outbound sent before the customer said anything is
 * not an answer to it. Outbound messages whose source is unrecorded are not
 * admitted: this column exists to be independent ground truth, and letting a
 * message of unknown provenance stand in for a person would defeat that.
 *
 * @param inbound - The conversation's inbound messages, unordered.
 * @param outbound - The conversation's outbound messages, unordered.
 * @returns The elapsed milliseconds, or `undefined` when either end is missing.
 */
function customerWaitMs(
  inbound: ReadonlyArray<MetricMessage>,
  outbound: ReadonlyArray<MetricMessage>,
): number | undefined {
  const askedAt = earliestMs(inbound, () => true);
  if (askedAt === undefined) {
    return undefined;
  }
  const answeredAt = earliestMs(
    outbound,
    (message) => message.source !== null && countsAsFirstReply(message.source),
  );
  if (answeredAt === undefined || answeredAt < askedAt) {
    return undefined;
  }
  return answeredAt - askedAt;
}

/** The earliest `createdAt` among the messages a predicate accepts. */
function earliestMs(
  messages: ReadonlyArray<MetricMessage>,
  accepts: (message: MetricMessage) => boolean,
): number | undefined {
  let earliest: number | undefined;
  for (const message of messages) {
    if (!accepts(message)) {
      continue;
    }
    const at = Date.parse(message.createdAt);
    if (Number.isNaN(at)) {
      continue;
    }
    if (earliest === undefined || at < earliest) {
      earliest = at;
    }
  }
  return earliest;
}

/** Summarize the durations that could be measured, ignoring the ones that could not. */
function summarizeDurations(values: ReadonlyArray<number | undefined>): DurationSummary {
  const measured = values.filter((value): value is number => value !== undefined).sort(ascending);
  if (measured.length === 0) {
    return { measured: 0, averageMs: null, p50Ms: null, p90Ms: null, maxMs: null };
  }
  const total = measured.reduce((sum, value) => sum + value, 0);
  return {
    measured: measured.length,
    averageMs: Math.round(total / measured.length),
    p50Ms: percentile(measured, 0.5),
    p90Ms: percentile(measured, 0.9),
    maxMs: measured[measured.length - 1] ?? null,
  };
}

/** The nearest-rank percentile of an ascending array; `fraction` in `(0, 1]`. */
function percentile(sorted: ReadonlyArray<number>, fraction: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.min(Math.max(Math.ceil(fraction * sorted.length), 1), sorted.length);
  return sorted[rank - 1] ?? null;
}

/** A rate, or `null` when nothing was in scope to rate. */
function ratio(numerator: number, denominator: number): RatioSummary {
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}

/** Compare two numbers ascending, for `Array.prototype.sort`. */
function ascending(left: number, right: number): number {
  return left - right;
}

/**
 * A zero count for every source.
 *
 * Built by enumerating the union rather than by listing the six names, so a
 * seventh source added to `MESSAGE_SOURCES` appears here at zero instead of
 * silently vanishing from the breakdown.
 */
function emptyBreakdown(): Record<MessageSource, number> {
  const counts = {} as Record<MessageSource, number>;
  for (const source of MESSAGE_SOURCES) {
    counts[source] = 0;
  }
  return counts;
}
