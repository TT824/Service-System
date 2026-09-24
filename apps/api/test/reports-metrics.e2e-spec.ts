import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';

const AGENT = 'u-t1-agent-1';
const TENANT_ADMIN = 'u-t1-admin';

const SUMMARY_URL = '/api/v1/reports/summary';
const SUGGESTIONS_URL = '/api/v1/retrieval/suggestions';

type DataEnvelope = { request_id: string; data: unknown; meta: Record<string, never> };

/** One of the two rates as it crosses the wire. */
type RatioView = {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
};

/** One latency column as it crosses the wire. */
type DurationView = {
  readonly measured: number;
  readonly averageMs: number | null;
  readonly p50Ms: number | null;
  readonly p90Ms: number | null;
  readonly maxMs: number | null;
};

/** The §4.8 slice of the report summary. */
type MetricsView = {
  readonly scope: {
    readonly conversations: number;
    readonly conversationsWithSuggestions: number;
    readonly outboundInScope: number;
    readonly outboundOutsideScope: number;
    readonly unsourcedOutbound: number;
  };
  readonly firstResponse: {
    readonly fromQueue: DurationView;
    readonly fromFirstInbound: DurationView;
  };
  readonly adoption: RatioView;
  readonly manualTyping: RatioView;
  readonly sourceBreakdown: Readonly<Record<string, number>>;
};

/**
 * The §4.8 metrics over the real HTTP stack.
 *
 * The arithmetic is settled by `reports.spec.ts` against hand-built records.
 * What only an endpoint test can settle is the wiring: that the report reads
 * the two things the metrics are made of — the message log and the set of
 * conversations that have produced a suggestion set — and that the numbers
 * reach the client. The failure mode of a missing read is a report that still
 * looks perfect: `{ numerator: 0, denominator: 0, rate: null }` is exactly what
 * a working implementation returns for a tenant with nothing in scope, so the
 * cases below move the population and assert the change.
 *
 * Every number here is derived from the in-memory seed, whose timestamps are
 * fixed, rather than measured from the clock — a latency asserted against
 * `Date.now()` is a test that passes for the wrong reason.
 *
 * ## The two first-response columns, demonstrated on the seed
 *
 * The seed records *no* reply clock (`firstReplyAt` is null on all three
 * conversations) while its message log contains two real human replies. So the
 * stored column reports `measured: 0` and the log column reports `measured: 2`
 * with exact milliseconds. That divergence is not a fixture artefact — it is
 * the reason the report carries a second column, and here it is a fact about
 * the shipped seed rather than a claim in a comment.
 */
describe('Report metrics (interface)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    }).compile();

    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);
  });

  afterAll(async () => {
    await app.close();
  });

  /** The §4.8 slice of the report summary, as the tenant's admin sees it. */
  async function metrics(): Promise<MetricsView> {
    const response = await request(app.getHttpServer())
      .get(SUMMARY_URL)
      .set('x-member-id', TENANT_ADMIN)
      .expect(200);
    // The metrics are one field of the summary, not the summary itself: the
    // endpoint carries the pre-existing counts alongside them.
    const summary = (response.body as DataEnvelope).data as { readonly metrics: MetricsView };
    return summary.metrics;
  }

  /**
   * The scope is the §4.8 商品咨询 proxy — conversations that have produced a
   * suggestion set — so before anything generates one, nothing is measured.
   */
  it('measures nothing while no conversation has produced a suggestion set', async () => {
    const report = await metrics();

    expect(report.scope).toEqual({
      conversations: 3,
      conversationsWithSuggestions: 0,
      outboundInScope: 0,
      // The seed's five outbound messages: four on conversation-acme-1 and one
      // on conversation-acme-3. Accounted for, not lost.
      outboundOutsideScope: 5,
      unsourcedOutbound: 0,
    });
    expect(report.adoption).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(report.manualTyping).toEqual({ numerator: 0, denominator: 0, rate: null });
  });

  /**
   * The seed's own divergence, asserted rather than described: the stored reply
   * clock knows nothing, and the message log knows both customers' waits.
   */
  it('reads the customer’s wait from the message log where the stored clock is empty', async () => {
    const report = await metrics();

    expect(report.firstResponse.fromQueue).toEqual({
      measured: 0,
      averageMs: null,
      p50Ms: null,
      p90Ms: null,
      maxMs: null,
    });
    expect(report.firstResponse.fromFirstInbound).toEqual({
      measured: 2,
      // conversation-acme-1: inbound 09-01T02:00 → manual_typed 09-02T08:30.
      // conversation-acme-3: inbound 09-01T02:00 → manual_typed 09-05T11:00.
      averageMs: 243_900_000,
      p50Ms: 109_800_000,
      p90Ms: 378_000_000,
      maxMs: 378_000_000,
    });
  });

  /**
   * Generating a suggestion set is what moves a conversation into scope, and it
   * must move nothing else: no message is sent, so no response clock runs.
   */
  it('moves exactly the one conversation into scope and computes its rates', async () => {
    const before = await metrics();

    await request(app.getHttpServer())
      .post(SUGGESTIONS_URL)
      .set('x-member-id', AGENT)
      .send({ conversationId: 'conversation-acme-1', query: '黑色 XL 卫衣有货吗' })
      .expect(201);

    const after = await metrics();

    expect(after.scope).toEqual({
      conversations: 3,
      conversationsWithSuggestions: 1,
      outboundInScope: 4,
      outboundOutsideScope: 1,
      unsourcedOutbound: 0,
    });
    // §4.8's "单独统计": every one of the four in-scope sends in its own bucket.
    expect(after.sourceBreakdown).toEqual({
      direct_candidate: 2,
      edited_send: 1,
      manual_typed: 1,
      shortcut: 0,
      faq_auto: 0,
      other: 0,
    });
    // 采纳率 = 直接发送候选 / 已发送 = 2/4; 手打率 = 手打 / 已发送 = 1/4.
    expect(after.adoption).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });
    expect(after.manualTyping).toEqual({ numerator: 1, denominator: 4, rate: 0.25 });

    // The rates and the breakdown are one population read two ways.
    const bucketed = Object.values(after.sourceBreakdown).reduce((sum, n) => sum + n, 0);
    expect(bucketed).toBe(after.scope.outboundInScope);

    // Candidates were proposed; nobody replied, so neither clock moved.
    expect(after.firstResponse).toEqual(before.firstResponse);
  });

  /**
   * Scope is decided when the report is read, not when the message is written:
   * a send on a conversation that never produced a candidate stays out of the
   * rates rather than being back-filled into them.
   */
  it('keeps a send on an out-of-scope conversation out of the rates', async () => {
    const before = await metrics();

    await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/messages')
      .set('x-member-id', AGENT)
      .send({
        content: '亲，这款白色 M 有货的哦～',
        source: 'manual_typed',
        dedupKey: 'kefu-e2e-metrics-1',
      })
      .expect(201);

    const after = await metrics();

    // The scope is non-empty at this point — the case above put one
    // conversation in it — so this is not merely "everything is out of scope
    // and stayed that way". Asserted against the baseline rather than assumed,
    // because with an empty scope this whole case would pass for the wrong
    // reason.
    expect(before.scope.conversationsWithSuggestions).toBe(1);
    expect(before.scope.outboundInScope).toBe(4);
    expect(after.scope.outboundOutsideScope).toBe(before.scope.outboundOutsideScope + 1);
    expect(after.scope.outboundInScope).toBe(before.scope.outboundInScope);
    expect(after.adoption).toEqual(before.adoption);
    expect(after.manualTyping).toEqual(before.manualTyping);
  });
});
