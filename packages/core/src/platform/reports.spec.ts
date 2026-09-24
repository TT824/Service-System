/**
 * The §4.8 metrics, over hand-built records.
 *
 * Every case here is a way a number can look authoritative while meaning
 * something other than what its name says, which is the only failure mode that
 * matters for a report: a wrong metric is not visibly broken, it is quietly
 * believed. Three of them are specific to this platform and are why the suite
 * exists rather than being covered by the endpoint test:
 *
 * - **An automated reply must not end the customer's wait.** `countsAsFirstReply`
 *   excludes `other`, and the offline auto-reply is recorded as `other`. A
 *   naive earliest-outbound would report a half-second first response for a
 *   customer who waited nine seconds for a person.
 * - **The stored first-response pair is overwritten across rounds.**
 *   `reopenConversation` clears `firstReplyAt` and deliberately leaves
 *   `firstResponseStartedAt`, so the number the workbench already shows becomes
 *   a span across the closed gap. This is asserted, not hidden — it is the
 *   reason the report carries a second column.
 * - **Scope is the §4.8 proxy, and it is load-bearing.** The same messages
 *   measure nothing when no conversation produced a suggestion set.
 */

import { describe, expect, it } from 'vitest';
import {
  computeReportMetrics,
  type MetricConversation,
  type MetricMessage,
  type ReportMetricsInput,
} from './reports';
import type { MessageSource } from './types';

/** The instant every fixture is measured from. */
const T0 = '2026-09-20T10:00:00.000Z';

/** An ISO timestamp `offsetMs` after {@link T0}. */
function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

/** A conversation, with its first-response timestamps defaulted to unmeasured. */
function conversation(
  id: string,
  startedAt: string | null = null,
  repliedAt: string | null = null,
): MetricConversation {
  return { id, firstResponseStartedAt: startedAt, firstReplyAt: repliedAt };
}

/** A customer message. */
function inbound(conversationId: string, createdAt: string): MetricMessage {
  return { conversationId, direction: 'inbound', source: null, createdAt };
}

/** A seat message of the given source. */
function outbound(conversationId: string, source: MessageSource, createdAt: string): MetricMessage {
  return { conversationId, direction: 'outbound', source, createdAt };
}

/** The metrics for the given records, with every conversation assumed in scope. */
function metricsOf(
  conversations: ReadonlyArray<MetricConversation>,
  messages: ReadonlyArray<MetricMessage>,
): ReturnType<typeof computeReportMetrics> {
  const input: ReportMetricsInput = {
    conversations,
    messages,
    conversationsWithSuggestions: new Set(conversations.map((each) => each.id)),
  };
  return computeReportMetrics(input);
}

describe('computeReportMetrics', () => {
  /**
   * The block's acceptance criterion, literally: one adopted, one edited and
   * one typed message, and all three §4.8 numbers exact.
   */
  it('computes the three numbers from one adopted, one edited and one typed send', () => {
    const metrics = metricsOf(
      [conversation('c1'), conversation('c2'), conversation('c3')],
      [
        inbound('c1', at(0)),
        outbound('c1', 'direct_candidate', at(1_000)),
        inbound('c2', at(0)),
        outbound('c2', 'edited_send', at(2_000)),
        inbound('c3', at(0)),
        outbound('c3', 'manual_typed', at(3_000)),
      ],
    );

    // 采纳率: 直接发送候选 / 已发送 (1 of 3).
    expect(metrics.adoption).toEqual({ numerator: 1, denominator: 3, rate: 1 / 3 });
    // 手打率: 未用候选直接手打 / 已发送 (1 of 3).
    expect(metrics.manualTyping).toEqual({ numerator: 1, denominator: 3, rate: 1 / 3 });
    // 首响: 1 s, 2 s, 3 s.
    expect(metrics.firstResponse.fromFirstInbound).toEqual({
      measured: 3,
      averageMs: 2_000,
      p50Ms: 2_000,
      p90Ms: 3_000,
      maxMs: 3_000,
    });
    // §4.8's "单独统计" for the remaining sources, and the edited send is its
    // own bucket rather than folded into adoption.
    expect(metrics.sourceBreakdown).toEqual({
      direct_candidate: 1,
      edited_send: 1,
      manual_typed: 1,
      shortcut: 0,
      faq_auto: 0,
      other: 0,
    });
    expect(metrics.scope.outboundInScope).toBe(3);
  });

  /**
   * The two rates and the breakdown must be the same population read two ways.
   * A breakdown that quietly covered a different set would be a second,
   * unaudited definition of the metric.
   */
  it('accounts for every in-scope outbound message exactly once', () => {
    const metrics = metricsOf(
      [conversation('c1'), conversation('c2')],
      [
        inbound('c1', at(0)),
        outbound('c1', 'direct_candidate', at(1_000)),
        outbound('c1', 'shortcut', at(2_000)),
        outbound('c1', 'faq_auto', at(3_000)),
        // Neither in the breakdown nor in a numerator: nobody recorded where
        // this one came from.
        { conversationId: 'c1', direction: 'outbound', source: null, createdAt: at(4_000) },
        outbound('c2', 'manual_typed', at(5_000)),
      ],
    );

    const bucketed = Object.values(metrics.sourceBreakdown).reduce((sum, n) => sum + n, 0);
    expect(metrics.scope.unsourcedOutbound).toBe(1);
    expect(bucketed).toBe(4);
    expect(metrics.scope.outboundInScope).toBe(bucketed + metrics.scope.unsourcedOutbound);
    // The unrecorded one is in scope but is not evidence for either rate.
    expect(metrics.adoption.denominator).toBe(4);
    expect(metrics.manualTyping.denominator).toBe(4);
  });

  /**
   * The scope is the §4.8 商品咨询 proxy, so it has to be the thing deciding
   * the denominator. Identical messages, no suggestion set, no measurement.
   */
  it('measures nothing when no conversation has produced a suggestion set', () => {
    const input: ReportMetricsInput = {
      conversations: [conversation('c1'), conversation('c2')],
      messages: [
        inbound('c1', at(0)),
        outbound('c1', 'direct_candidate', at(1_000)),
        outbound('c2', 'manual_typed', at(2_000)),
      ],
      conversationsWithSuggestions: new Set(),
    };

    const metrics = computeReportMetrics(input);

    expect(metrics.adoption).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(metrics.manualTyping).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(metrics.scope).toMatchObject({ outboundInScope: 0, outboundOutsideScope: 2 });
    // The messages exist and are counted as out of scope — not lost.
    expect(Object.values(metrics.sourceBreakdown).every((n) => n === 0)).toBe(true);
  });

  /**
   * A rate over nothing is undefined, not zero. At pilot start this is the
   * difference between "no seat adopts candidates" and "nothing sent yet".
   */
  it('reports a rate of null rather than zero for an empty population', () => {
    const metrics = metricsOf([conversation('c1')], [inbound('c1', at(0))]);

    expect(metrics.adoption.rate).toBeNull();
    expect(metrics.manualTyping.rate).toBeNull();
  });

  /**
   * The negative case for the customer's wait, and the one most likely to be
   * got wrong: the offline auto-reply is an outbound and is the earliest one.
   */
  it('does not let an automated reply end the customer’s wait', () => {
    const metrics = metricsOf(
      [conversation('c1', T0, at(9_000))],
      [
        inbound('c1', at(0)),
        outbound('c1', 'other', at(500)),
        outbound('c1', 'manual_typed', at(9_000)),
      ],
    );

    // A half-second auto-reply is not a person answering.
    expect(metrics.firstResponse.fromFirstInbound.p50Ms).toBe(9_000);
  });

  it('does not count an outbound that precedes the customer’s question', () => {
    const metrics = metricsOf(
      [conversation('c1')],
      [outbound('c1', 'manual_typed', at(1_000)), inbound('c1', at(5_000))],
    );

    expect(metrics.firstResponse.fromFirstInbound.measured).toBe(0);
  });

  /**
   * The stored pair's known drift, asserted rather than papered over.
   *
   * Round one is answered in a second; the conversation closes; round two
   * arrives an hour later and is answered. `firstResponseStartedAt` still holds
   * the original pool entry, so the platform's own column now reports the whole
   * hour as the customer's first wait.
   */
  it('reports the stored first-response column drifting across a reopened round', () => {
    const metrics = metricsOf(
      [conversation('c1', at(0), at(3_600_000))],
      [
        inbound('c1', at(0)),
        outbound('c1', 'direct_candidate', at(1_000)),
        inbound('c1', at(3_000_000)),
        outbound('c1', 'direct_candidate', at(3_600_000)),
      ],
    );

    expect(metrics.firstResponse.fromQueue.p50Ms).toBe(3_600_000);
    // The message log knows the customer's actual first wait was one second.
    expect(metrics.firstResponse.fromFirstInbound.p50Ms).toBe(1_000);
  });

  it('agrees with the stored column for a conversation with a single round', () => {
    const metrics = metricsOf(
      [conversation('c1', at(0), at(1_500)), conversation('c2', at(0), at(2_500))],
      [
        inbound('c1', at(0)),
        outbound('c1', 'direct_candidate', at(1_500)),
        inbound('c2', at(0)),
        outbound('c2', 'direct_candidate', at(2_500)),
      ],
    );

    expect(metrics.firstResponse.fromFirstInbound).toEqual(metrics.firstResponse.fromQueue);
  });

  it('leaves an unmeasured conversation out instead of counting it as instant', () => {
    const metrics = metricsOf(
      [conversation('c1', at(0), at(1_000)), conversation('c2')],
      [inbound('c1', at(0)), outbound('c1', 'direct_candidate', at(1_000)), inbound('c2', at(0))],
    );

    expect(metrics.firstResponse.fromQueue).toMatchObject({ measured: 1, p50Ms: 1_000 });
    expect(metrics.firstResponse.fromFirstInbound).toMatchObject({ measured: 1, p50Ms: 1_000 });
  });

  it('reports empty latency summaries for a tenant with no conversations', () => {
    const metrics = computeReportMetrics({
      conversations: [],
      messages: [],
      conversationsWithSuggestions: new Set(),
    });

    expect(metrics.firstResponse.fromQueue).toEqual({
      measured: 0,
      averageMs: null,
      p50Ms: null,
      p90Ms: null,
      maxMs: null,
    });
    expect(metrics.scope.conversations).toBe(0);
  });
});
