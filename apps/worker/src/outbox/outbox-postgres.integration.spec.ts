import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CHANNEL_OUTBOX_MAX_ATTEMPTS,
  isDeliveryRetryable,
  outboxRetryDelayMs,
  parseAppConfig,
  type ChannelResult,
  type MessageDeliveryStatus,
  type SendMessageInput,
  type SendMessageResult,
} from '@kefu/core';
import type { WecomOutboundTransport } from '@kefu/wecom';
import { WorkerDatabase } from '../database/worker-database';
import { OutboxProcessor } from './outbox-processor';
import { PostgresOutboxRepository } from './postgres-outbox.repository';

/**
 * Integration tests for the Worker's durable outbox store and delivery loop,
 * against the real PostgreSQL the platform targets.
 *
 * These are the acceptance criteria that can only be proved with a real
 * database and real concurrency: that two Workers racing over one queue can
 * never be handed the same attempt, that a dead Worker's claim is recovered
 * when its lease expires, that the retry schedule is finite and exponential,
 * that an `unknown` outcome is never retried automatically, that a `sent`
 * delivery can never be moved backwards, and that an entry left pending at its
 * attempt bound is abandoned rather than stuck for ever.
 *
 * The suite skips cleanly when no database is reachable, so `npm test` still
 * passes on a machine without PostgreSQL; every row it writes carries a
 * per-run unique identifier and is removed again in `afterAll`, so it neither
 * depends on another run's rows nor disturbs them.
 *
 * Two notes on this file's own plumbing, because both look like duplication:
 *
 * - **It does not import the API's test helpers.** A Worker test that reached
 *   into `apps/api` would make the two workspaces one workspace, which is the
 *   boundary the whole task exists to establish — so the handful of lines that
 *   locate the database and drive the migration runner live here instead. They
 *   are generic test plumbing: they name no channel and no provider.
 * - **The scope rows are seeded with plain SQL.** Seeding is not part of the
 *   Worker's contract (the API writes these rows in production), so it is
 *   written out here rather than given a production home it does not have.
 */

const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Unique suffix isolating this run's rows from every other run's. */
const RUN = randomUUID().slice(0, 8);

describe.skipIf(!reachable)('Worker outbox persistence and delivery (PostgreSQL)', () => {
  let database: WorkerDatabase;
  let repository: PostgresOutboxRepository;
  /** Tenants this run created, removed in `afterAll` in foreign-key order. */
  const tenants: string[] = [];
  /** A fixed instant the loop tests run at, so lease and window arithmetic is exact. */
  let fixedNow = '';

  beforeAll(async () => {
    // Idempotent: a developer machine may already have the migrations applied.
    runDatabaseCommand('migrate', databaseUrl);
    database = new WorkerDatabase(databaseUrl);
    repository = new PostgresOutboxRepository(database);
    fixedNow = nowIso();
  });

  afterAll(async () => {
    if (database !== undefined) {
      await cleanup();
      await database.close();
    }
  });

  /**
   * Take this run's queue entries out of play after every test.
   *
   * `claimDue` and `sweepExhausted` are platform-wide on purpose: a Worker
   * claims whatever is due, whoever queued it. So a test that leaves a due row
   * behind hands that row to the *next* test's tick. That is not hypothetical —
   * with the row the monotonicity test seeds left pending, the end-to-end test's
   * tick reported `claimed: 2, sent: 2`: it claimed and really sent another
   * test's message, so the one-transport-call assertion below it was measuring
   * two tests at once.
   *
   * Deleting the run's entries here restores the isolation every test here
   * assumes. `afterAll` still removes the rows, the scopes and the rest.
   *
   * Necessary, but not sufficient on a developer machine: a `npm run
   * dev:worker` left running against this same database claims on the same
   * platform-wide predicate, under the `worker-<pid>-<uuid>` owner built in
   * `worker.module.ts`. Measured — one run in eight failed with a scope row
   * leased to `worker-25040-…`, an id nothing in this suite's process can
   * produce. This suite is only conclusive with the dev Worker stopped.
   */
  afterEach(async () => {
    for (const tenantId of tenants) {
      await database.query('DELETE FROM channel_outbox WHERE tenant_id = $1', [tenantId]);
    }
  });

  it('runs against a reachable database', () => {
    // Reported explicitly, so a skipped run is never mistaken for a passing one.
    expect(reachable).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Claiming, exclusion and lease recovery
  // -------------------------------------------------------------------------

  it('claims a due entry once, spending an attempt and taking a lease', async () => {
    const scope = await createScope('claim');
    const entry = await seedQueuedEntry(scope, 'a');

    const claimed = await repository.claimDue('worker-a', nowIso(), 5);

    expect(claimed.map((record) => record.id)).toContain(entry.outboxId);
    const mine = claimed.find((record) => record.id === entry.outboxId);
    expect(mine).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      leaseOwner: 'worker-a',
    });
    // The lease length is Core's, and it is written together with the owner.
    expect(Date.parse(mine?.leaseExpiresAt ?? '')).toBe(Date.parse(mine?.updatedAt ?? '') + 60_000);

    const stored = await readOutbox(entry.outboxId);
    expect(stored).toMatchObject({ attempt_count: 1, lease_owner: 'worker-a' });
    expect(stored['lease_expires_at']).not.toBeNull();
  });

  it('never hands the same attempt to two workers claiming concurrently', async () => {
    const scope = await createScope('race');
    for (const label of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await seedQueuedEntry(scope, label);
    }
    const at = nowIso();
    const first = new PostgresOutboxRepository(database);
    const second = new PostgresOutboxRepository(database);

    // Two Workers, one queue, one instant. `FOR UPDATE SKIP LOCKED` is what this
    // proves: without it the second statement would block, and a claim that
    // merely read-then-wrote would let both take the same row.
    const [left, right] = await Promise.all([
      first.claimDue('worker-left', at, 4),
      second.claimDue('worker-right', at, 4),
    ]);

    const claimed = [...left, ...right];
    const ids = claimed.map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(claimed.length).toBeGreaterThan(0);
    for (const record of claimed) {
      // The claim spent exactly one attempt on the row it was handed.
      expect(record.attemptCount).toBe(1);
      expect(['worker-left', 'worker-right']).toContain(record.leaseOwner);
    }
    // Nothing in this scope was claimed twice, and every claimed row is leased.
    const rows = await database.rows(
      'SELECT attempt_count, lease_owner FROM channel_outbox WHERE tenant_id = $1',
      [scope.tenantId],
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row['attempt_count']).toBeLessThanOrEqual(1);
      if (row['attempt_count'] === 1) {
        expect(['worker-left', 'worker-right']).toContain(row['lease_owner']);
      }
    }
  });

  it('skips a live lease and recovers an expired one', async () => {
    const scope = await createScope('lease');
    const at = nowIso();
    const held = await seedQueuedEntry(scope, 'held', {
      attemptCount: 1,
      leaseOwner: 'worker-dead',
      leaseExpiresAt: new Date(Date.parse(at) + 60_000).toISOString(),
    });
    const expired = await seedQueuedEntry(scope, 'expired', {
      attemptCount: 1,
      leaseOwner: 'worker-dead',
      leaseExpiresAt: new Date(Date.parse(at) - 1_000).toISOString(),
    });
    const future = await seedQueuedEntry(scope, 'future', {
      availableAt: new Date(Date.parse(at) + 60 * 60 * 1000).toISOString(),
    });

    const claimed = await repository.claimDue('worker-a', at, 10);
    const mine = claimed.filter((record) => record.tenantId === scope.tenantId);

    expect(mine.map((record) => record.id)).toEqual([expired.outboxId]);
    expect(mine[0]).toMatchObject({ attemptCount: 2, leaseOwner: 'worker-a' });
    // The live lease and the not-yet-due entry were both left alone.
    expect(await readOutbox(held.outboxId)).toMatchObject({ lease_owner: 'worker-dead' });
    expect(await readOutbox(future.outboxId)).toMatchObject({
      attempt_count: 0,
      lease_owner: null,
    });
  });

  it('leaves an entry that is pending at its attempt bound unclaimable, then sweeps it', async () => {
    const scope = await createScope('sweep');
    // Exactly the state a Worker leaves behind when it dies holding the last
    // claim: pending, at the bound, and therefore refused by every future claim.
    const stuck = await seedQueuedEntry(scope, 'stuck', {
      attemptCount: CHANNEL_OUTBOX_MAX_ATTEMPTS,
      leaseOwner: 'worker-dead',
      leaseExpiresAt: new Date(Date.parse(nowIso()) - 1_000).toISOString(),
    });
    // A healthy Worker's final in-flight attempt: the same state, but leased.
    const inFlight = await seedQueuedEntry(scope, 'in-flight', {
      attemptCount: CHANNEL_OUTBOX_MAX_ATTEMPTS,
      leaseOwner: 'worker-alive',
      leaseExpiresAt: new Date(Date.parse(nowIso()) + 60_000).toISOString(),
    });

    const beforeSweep = await repository.claimDue('worker-a', nowIso(), 10);
    expect(beforeSweep.some((record) => record.id === stuck.outboxId)).toBe(false);

    const swept = await repository.sweepExhausted(nowIso());

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await readOutbox(stuck.outboxId)).toMatchObject({
      status: 'abandoned',
      attempt_count: CHANNEL_OUTBOX_MAX_ATTEMPTS,
      lease_owner: null,
    });
    // The recovery is recorded with a safe, platform-authored diagnostic.
    const stored = await readOutbox(stuck.outboxId);
    expect(stored['last_failure_code']).toBe('channel_delivery_unknown');
    expect(String(stored['last_failure_reason'])).toContain('dispatch attempts');
    // A live lease is never swept out from under the Worker that holds it.
    expect(await readOutbox(inFlight.outboxId)).toMatchObject({
      status: 'pending',
      lease_owner: 'worker-alive',
    });
  });

  // -------------------------------------------------------------------------
  // Retry schedule, terminal states and monotonicity
  // -------------------------------------------------------------------------

  it('reschedules on a finite exponential backoff and abandons at the bound', async () => {
    const scope = await createScope('backoff');
    const entry = await seedQueuedEntry(scope, 'slow');

    const delays: number[] = [];
    let cursor = Date.parse(nowIso());
    for (let attempt = 1; attempt <= CHANNEL_OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      const at = new Date(cursor).toISOString();
      const claimed = await repository.claimDue('worker-a', at, 10);
      const mine = claimed.find((record) => record.id === entry.outboxId);
      expect(mine).toBeDefined();
      if (mine === undefined) {
        return;
      }
      expect(mine.attemptCount).toBe(attempt);

      const released = await repository.releaseOutbox(
        mine,
        'worker-a',
        { code: 'channel_provider_error', reason: 'the provider rejected the message' },
        at,
      );
      if (attempt < CHANNEL_OUTBOX_MAX_ATTEMPTS) {
        // Scheduled, not retried immediately: the delay is Core's own schedule
        // for the attempts already spent, and the lease is given back.
        expect(released).toMatchObject({
          status: 'pending',
          attemptCount: attempt,
          leaseOwner: null,
        });
        const delay = Date.parse(released?.availableAt ?? '') - cursor;
        expect(delay).toBe(outboxRetryDelayMs(attempt));
        delays.push(delay);
        // Not due at the instant it was released...
        const early = await repository.claimDue('worker-a', at, 10);
        expect(early.some((record) => record.id === entry.outboxId)).toBe(false);
        // ...and due once the delay has passed.
        cursor += delay;
      } else {
        // The last attempt was spent by the claim, so the same release abandons:
        // there is no state where the entry is pending with no attempt left.
        expect(released).toMatchObject({ status: 'abandoned', leaseOwner: null });
      }
    }

    // Exponential and capped: each delay is strictly larger than the last, and
    // the whole schedule is bounded rather than open-ended.
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(await readOutbox(entry.outboxId)).toMatchObject({ status: 'abandoned' });
    expect(
      (await repository.claimDue('worker-a', new Date(cursor + 86_400_000).toISOString(), 10)).some(
        (record) => record.id === entry.outboxId,
      ),
    ).toBe(false);
  });

  it('abandons an unknown outcome with no automatic retry and no second delivery', async () => {
    const scope = await createScope('unknown');
    const entry = await seedQueuedEntry(scope, 'lost');
    const at = nowIso();
    const claimed = await repository.claimDue('worker-a', at, 10);
    const mine = claimed.find((record) => record.id === entry.outboxId);
    expect(mine).toBeDefined();
    if (mine === undefined) {
      return;
    }

    const appended = await repository.appendProviderAttempt({
      tenantId: scope.tenantId,
      deliveryId: entry.deliveryId,
      status: 'unknown',
      externalMessageId: null,
      failureCode: 'channel_delivery_unknown',
      failureReason: 'the provider response was lost',
      retryable: true,
      now: at,
    });
    expect(appended.attempt).toMatchObject({ attemptNumber: 1, status: 'unknown' });
    expect(appended.delivery).toMatchObject({ status: 'unknown' });
    expect(
      await repository.abandonOutbox(
        mine,
        'worker-a',
        {
          code: 'channel_delivery_unknown',
          reason: 'the provider response was lost',
        },
        at,
      ),
    ).toBe(true);

    expect(await readOutbox(entry.outboxId)).toMatchObject({
      status: 'abandoned',
      attempt_count: 1,
    });
    // Terminal means terminal: nothing claims it again, however much time passes.
    expect(
      (
        await repository.claimDue(
          'worker-a',
          new Date(Date.parse(at) + 86_400_000).toISOString(),
          10,
        )
      ).some((record) => record.id === entry.outboxId),
    ).toBe(false);
    // One logical message still has exactly one delivery, and one attempt.
    expect(await readDelivery(entry.deliveryId)).toMatchObject({
      status: 'unknown',
      attempt_count: 1,
    });
    expect(await countAttempts(entry.deliveryId)).toBe(1);
  });

  it('never moves a sent delivery backwards, whatever a later attempt observed', async () => {
    const scope = await createScope('monotonic');
    const entry = await seedQueuedEntry(scope, 'sent-label', {
      delivery: { status: 'sent', externalMessageId: 'wecom-already', attemptCount: 1 },
    });
    // The attempt that delivered it, so the history this test appends onto is
    // the history production would have.
    await seedAttempt(scope, entry.deliveryId, 1, 'sent', 'wecom-already');

    const appended = await repository.appendProviderAttempt({
      tenantId: scope.tenantId,
      deliveryId: entry.deliveryId,
      status: 'failed',
      externalMessageId: null,
      failureCode: 'channel_provider_error',
      failureReason: 'a very late rejection',
      retryable: true,
      now: nowIso(),
    });

    // The attempt is kept as immutable history — it did happen — but the
    // projection does not move, so the platform never re-offers a retry for a
    // message the customer already received.
    expect(appended.attempt).toMatchObject({ attemptNumber: 2, status: 'failed' });
    expect(appended.delivery).toMatchObject({
      status: 'sent',
      externalMessageId: 'wecom-already',
      attemptCount: 2,
    });
    expect(isDeliveryRetryable(appended.delivery.status)).toBe(false);

    // The window-refusal path is guarded the same way: a degradation decided
    // after a status callback landed cannot rewind an accepted message.
    expect(
      await repository.recordDegradation({
        tenantId: scope.tenantId,
        deliveryId: entry.deliveryId,
        failureCode: 'window_expired',
        failureReason: 'the 48-hour reply window closed',
        retryable: true,
        now: nowIso(),
      }),
    ).toBeUndefined();
    expect(await readDelivery(entry.deliveryId)).toMatchObject({ status: 'sent' });
    // One message, one delivery, two attempts: a retry is never a second delivery.
    expect(await countDeliveries(scope.tenantId, entry.messageId)).toBe(1);
    expect(await countAttempts(entry.deliveryId)).toBe(2);
  });

  it('reserves reply budget under a lock and refuses without an open window', async () => {
    const scope = await createScope('quota');
    const key = {
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      channel: 'wecom',
      externalCustomerId: scope.customerId,
    };

    expect(await repository.reserveQuotaSlot(key, nowIso())).toMatchObject({
      ok: false,
      code: 'window_missing',
    });

    await database.query(
      `INSERT INTO send_quota_windows
         (id, tenant_id, store_id, channel, external_customer_id, window_started_at,
          window_ends_at, message_limit, reserved_count, updated_at)
       VALUES ($1, $2, $3, 'wecom', $4, $5, $6, 5, 0, $5)`,
      [
        `window-${RUN}-quota`,
        scope.tenantId,
        scope.storeId,
        scope.customerId,
        nowIso(),
        new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      ],
    );

    // Five concurrent reservations against a five-message budget: the lock is
    // what makes exactly five of them succeed.
    const reservations = await Promise.all(
      Array.from({ length: 5 }, () => repository.reserveQuotaSlot(key, nowIso())),
    );
    expect(reservations.every((reservation) => reservation.ok)).toBe(true);
    expect(await repository.reserveQuotaSlot(key, nowIso())).toMatchObject({
      ok: false,
      code: 'quota_exceeded',
    });
    // A definite failure gives its slot back; an `unknown` outcome never does.
    await repository.releaseQuotaSlot(key, nowIso());
    expect(await repository.getQuotaWindow(key)).toMatchObject({ reservedCount: 4 });
  });

  // -------------------------------------------------------------------------
  // The whole loop against the real database
  // -------------------------------------------------------------------------

  it('delivers a queued entry end to end and reuses the queued delivery', async () => {
    const scope = await createScope('loop-ok');
    const entry = await seedQueuedEntry(scope, 'ok', { openWindow: true });
    const transport = new ScriptedTransport(() => ({
      ok: true,
      value: { externalMessageId: 'wecom-loop-1' },
    }));
    const processor = buildProcessor(transport);

    const result = await processor.runOnce();

    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(transport.calls).toHaveLength(1);
    // The request is the existing logical message, correlated on the existing
    // delivery — no second message and no second delivery is created.
    expect(transport.calls[0]).toMatchObject({
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      externalCustomerId: scope.customerId,
      messageType: 'text',
      content: `集成测试消息 ok`,
      correlationId: entry.deliveryId,
    });

    expect(await readOutbox(entry.outboxId)).toMatchObject({
      status: 'dispatched',
      attempt_count: 1,
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(await readDelivery(entry.deliveryId)).toMatchObject({
      status: 'sent',
      external_message_id: 'wecom-loop-1',
      attempt_count: 1,
    });
    expect(await countAttempts(entry.deliveryId)).toBe(1);
    expect(await countDeliveries(scope.tenantId, entry.messageId)).toBe(1);
    // The message the customer received spent one slot of the reply budget.
    expect(
      await repository.getQuotaWindow({
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        channel: 'wecom',
        externalCustomerId: scope.customerId,
      }),
    ).toMatchObject({ reservedCount: 1 });
  });

  it('leaves a lost provider response terminal with the budget still spent', async () => {
    const scope = await createScope('loop-unknown');
    const entry = await seedQueuedEntry(scope, 'unknown', { openWindow: true });
    const transport = new ScriptedTransport(() => ({
      ok: false,
      code: 'channel_delivery_unknown',
      message: 'the provider response was lost',
      retryable: true,
      deliveryUnknown: true,
    }));
    const processor = buildProcessor(transport);

    await processor.runOnce();

    expect(await readOutbox(entry.outboxId)).toMatchObject({ status: 'abandoned' });
    expect(await readDelivery(entry.deliveryId)).toMatchObject({ status: 'unknown' });
    expect(await countAttempts(entry.deliveryId)).toBe(1);
    // The provider may have delivered the message, so the slot is not returned.
    expect(
      await repository.getQuotaWindow({
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        channel: 'wecom',
        externalCustomerId: scope.customerId,
      }),
    ).toMatchObject({ reservedCount: 1 });

    // A second tick sends nothing: the entry is terminal, not queued again.
    await processor.runOnce();
    expect(transport.calls).toHaveLength(1);
  });

  it('closes a stale entry whose delivery was already sent, without sending again', async () => {
    const scope = await createScope('loop-stale');
    const entry = await seedQueuedEntry(scope, 'stale', {
      openWindow: true,
      delivery: { status: 'sent', externalMessageId: 'wecom-earlier' },
    });
    const transport = new ScriptedTransport(() => ({
      ok: true,
      value: { externalMessageId: 'wecom-should-not-happen' },
    }));
    const processor = buildProcessor(transport);

    const result = await processor.runOnce();

    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(transport.calls).toHaveLength(0);
    expect(await readOutbox(entry.outboxId)).toMatchObject({ status: 'dispatched' });
    expect(await readDelivery(entry.deliveryId)).toMatchObject({
      status: 'sent',
      external_message_id: 'wecom-earlier',
    });
    expect(await countAttempts(entry.deliveryId)).toBe(0);
  });

  it('re-validates its claim before sending and refuses a stale owner', async () => {
    const scope = await createScope('renew');
    const entry = await seedQueuedEntry(scope, 'renew');
    const at = nowIso();
    const claimed = await repository.claimDue('worker-a', at, 10);
    const mine = claimed.find((record) => record.id === entry.outboxId);
    expect(mine).toBeDefined();
    if (mine === undefined) {
      return;
    }

    // The renewal hands the send a whole lease, measured from the renewal.
    const later = new Date(Date.parse(at) + 30_000).toISOString();
    const renewed = await repository.renewOutboxLease(mine, 'worker-a', later);
    expect(renewed?.leaseExpiresAt).toBe(new Date(Date.parse(later) + 60_000).toISOString());
    expect(await readOutbox(entry.outboxId)).toMatchObject({ lease_owner: 'worker-a' });

    // A worker that does not hold the claim cannot renew it, and the stored
    // lease is left exactly as its owner wrote it.
    expect(await repository.renewOutboxLease(mine, 'worker-b', later)).toBeUndefined();
    expect(await readOutbox(entry.outboxId)).toMatchObject({ lease_owner: 'worker-a' });

    // A terminal entry has no claim to renew, whoever asks.
    await repository.completeOutbox(mine, 'worker-a', later);
    expect(await repository.renewOutboxLease(mine, 'worker-a', later)).toBeUndefined();
  });

  it('refuses to send a delivery the API already recorded as unknown, or as a terminal failure', async () => {
    const scope = await createScope('loop-resolved');
    const lost = await seedQueuedEntry(scope, 'lost', {
      openWindow: true,
      delivery: {
        status: 'unknown',
        failureCode: 'channel_delivery_unknown',
        retryable: true,
        attemptCount: 1,
      },
    });
    const refused = await seedQueuedEntry(scope, 'refused', {
      openWindow: true,
      delivery: {
        status: 'failed',
        failureCode: 'channel_provider_error',
        retryable: false,
        attemptCount: 2,
      },
    });
    const transport = new ScriptedTransport(() => ({
      ok: true,
      value: { externalMessageId: 'wecom-should-not-happen' },
    }));
    const processor = buildProcessor(transport);

    const result = await processor.runOnce();

    expect(result.sent).toBe(0);
    expect(transport.calls).toHaveLength(0);
    expect(await readOutbox(lost.outboxId)).toMatchObject({
      status: 'abandoned',
      last_failure_code: 'channel_delivery_unknown',
    });
    expect(await readOutbox(refused.outboxId)).toMatchObject({
      status: 'abandoned',
      last_failure_code: 'channel_provider_error',
    });
    // Neither was sent, so neither spent an attempt or a reply-budget slot.
    expect(await countAttempts(lost.deliveryId)).toBe(0);
    expect(await countAttempts(refused.deliveryId)).toBe(0);
    expect(
      await repository.getQuotaWindow({
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        channel: 'wecom',
        externalCustomerId: scope.customerId,
      }),
    ).toMatchObject({ reservedCount: 0 });

    // A second tick sends nothing: both entries are terminal, not queued again.
    await processor.runOnce();
    expect(transport.calls).toHaveLength(0);
  });

  it('still sends a delivery the API recorded as a retryable failure', async () => {
    const scope = await createScope('loop-retryable');
    const entry = await seedQueuedEntry(scope, 'retryable', {
      openWindow: true,
      delivery: {
        status: 'failed',
        failureCode: 'channel_provider_error',
        retryable: true,
        attemptCount: 1,
      },
    });
    const transport = new ScriptedTransport(() => ({
      ok: true,
      value: { externalMessageId: 'wecom-loop-retry' },
    }));
    const processor = buildProcessor(transport);

    const result = await processor.runOnce();

    expect(result.sent).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(await readOutbox(entry.outboxId)).toMatchObject({ status: 'dispatched' });
    // The retry appended to the existing delivery — one message, one delivery,
    // two attempts — rather than creating a second of either.
    expect(await readDelivery(entry.deliveryId)).toMatchObject({
      status: 'sent',
      attempt_count: 2,
    });
    expect(await countAttempts(entry.deliveryId)).toBe(1);
    expect(await countDeliveries(scope.tenantId, entry.messageId)).toBe(1);
    expect(
      await repository.getQuotaWindow({
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        channel: 'wecom',
        externalCustomerId: scope.customerId,
      }),
    ).toMatchObject({ reservedCount: 1 });
  });

  it('settles a post-provider write failure terminally instead of rescheduling', async () => {
    const scope = await createScope('loop-write-failure');
    const entry = await seedQueuedEntry(scope, 'write-failure', {
      openWindow: true,
      delivery: {
        status: 'failed',
        failureCode: 'channel_provider_error',
        retryable: true,
        attemptCount: 1,
      },
    });
    // An attempt numbered exactly as the Worker's next one, so recording the
    // outcome collides on `message_delivery_attempts`' unique index — a real
    // persistence failure *after* the provider has answered.
    await seedAttempt(scope, entry.deliveryId, 2, 'failed', null);
    const transport = new ScriptedTransport(() => ({
      ok: false,
      code: 'channel_provider_error',
      message: 'the provider rejected the message',
      retryable: true,
    }));
    const processor = buildProcessor(transport);

    const result = await processor.runOnce();

    expect(result.retried).toBe(0);
    expect(result.terminal).toBe(1);
    expect(transport.calls).toHaveLength(1);
    const stored = await readOutbox(entry.outboxId);
    expect(stored).toMatchObject({
      status: 'abandoned',
      lease_owner: null,
      lease_expires_at: null,
    });
    // Not rescheduled, and not given back: the provider was called, so the
    // message may have been delivered and its budget slot stays spent.
    expect(Date.parse(String(stored['available_at']))).toBeLessThanOrEqual(Date.parse(fixedNow));
    expect(
      await repository.getQuotaWindow({
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        channel: 'wecom',
        externalCustomerId: scope.customerId,
      }),
    ).toMatchObject({ reservedCount: 1 });
    // The recorded delivery state did not move either: the write never landed.
    expect(await readDelivery(entry.deliveryId)).toMatchObject({
      status: 'failed',
      attempt_count: 1,
    });

    // Terminal means terminal: a later tick does not send it a second time.
    await processor.runOnce();
    await processor.runOnce();
    expect(transport.calls).toHaveLength(1);
  });

  /**
   * Build the loop over the real store, with a scripted transport and a fixed
   * clock, so a tick's lease and window arithmetic is exactly reproducible.
   */
  function buildProcessor(transport: WecomOutboundTransport): OutboxProcessor {
    return new OutboxProcessor(repository, transport, {
      owner: `worker-it-${RUN}`,
      pollIntervalMs: 1_000,
      batchSize: 5,
      now: () => Date.parse(fixedNow),
    });
  }

  /** A transport that answers from a script and records every request. */
  class ScriptedTransport implements WecomOutboundTransport {
    readonly calls: SendMessageInput[] = [];

    constructor(private readonly answer: () => ChannelResult<SendMessageResult>) {}

    async sendMessage(input: SendMessageInput): Promise<ChannelResult<SendMessageResult>> {
      this.calls.push(input);
      return this.answer();
    }
  }

  // -------------------------------------------------------------------------
  // Seeding, reading and cleanup
  // -------------------------------------------------------------------------

  type Scope = {
    readonly tenantId: string;
    readonly storeId: string;
    readonly conversationId: string;
    readonly customerId: string;
  };

  type SeededEntry = {
    readonly outboxId: string;
    readonly deliveryId: string;
    readonly messageId: string;
  };

  /** Insert the tenant, store, conversation and customer one test owns. */
  async function createScope(label: string): Promise<Scope> {
    const scope: Scope = {
      tenantId: `tenant-ow-${RUN}-${label}`,
      storeId: `store-ow-${RUN}-${label}`,
      conversationId: `conversation-ow-${RUN}-${label}`,
      customerId: `customer-ow-${RUN}-${label}`,
    };
    tenants.push(scope.tenantId);
    const at = nowIso();
    await database.query(
      'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
      [scope.tenantId, `ow-${RUN}-${label}`, 'Worker 出箱集成测试租户', at],
    );
    await database.query(
      'INSERT INTO stores (id, tenant_id, code, name, enabled, created_at) VALUES ($1, $2, $3, $4, TRUE, $5)',
      [scope.storeId, scope.tenantId, 'main', 'Worker 出箱集成测试门店', at],
    );
    await database.query(
      `INSERT INTO conversations
         (id, tenant_id, store_id, channel, external_customer_id, external_conversation_id, title,
          status, version, assigned_member_id, opened_at, last_message_at, closed_at, created_at)
       VALUES ($1, $2, $3, 'wecom', $4, $5, NULL, 'open', 1, NULL, $6, $6, NULL, $6)`,
      [
        scope.conversationId,
        scope.tenantId,
        scope.storeId,
        scope.customerId,
        `wkCONV-${RUN}:${scope.customerId}`,
        at,
      ],
    );
    return scope;
  }

  /**
   * Insert one logical message, its delivery and its queued outbox entry.
   *
   * The three rows are the shape the API writes and the Worker consumes, so a
   * test starts from exactly the state a pending delivery is in in production.
   */
  async function seedQueuedEntry(
    scope: Scope,
    label: string,
    options: {
      readonly attemptCount?: number;
      readonly availableAt?: string;
      readonly leaseOwner?: string | null;
      readonly leaseExpiresAt?: string | null;
      readonly openWindow?: boolean;
      readonly delivery?: {
        readonly status?: MessageDeliveryStatus;
        readonly externalMessageId?: string | null;
        readonly attemptCount?: number;
        /** Failure code the API recorded on the delivery, if any. */
        readonly failureCode?: string | null;
        /** Whether the API's recorded failure is one a retry may still repeat. */
        readonly retryable?: boolean;
      };
    } = {},
  ): Promise<SeededEntry> {
    const at = nowIso();
    // The scope is part of every id: two tests may seed the same label, and a
    // message id is a primary key shared by the whole database, not by scope.
    const messageId = `message-${scope.tenantId}-${label}`;
    const deliveryId = `delivery-${scope.tenantId}-${label}`;
    const outboxId = `outbox-${scope.tenantId}-${label}`;

    await database.query(
      `INSERT INTO messages
         (id, tenant_id, store_id, conversation_id, channel, direction, source, message_type,
          content, dedup_key, review_eligible, review_state, candidate_id, created_at)
       VALUES ($1, $2, $3, $4, 'wecom', 'outbound', 'manual_typed', 'text', $5, $6, FALSE, 'none', NULL, $7)`,
      [
        messageId,
        scope.tenantId,
        scope.storeId,
        scope.conversationId,
        `集成测试消息 ${label}`,
        `ow-${RUN}-${label}`,
        at,
      ],
    );
    await database.query(
      `INSERT INTO message_deliveries
         (id, tenant_id, store_id, conversation_id, message_id, channel, external_customer_id,
          external_conversation_id, status, external_message_id, attempt_count, failure_code,
          failure_reason, retryable, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'wecom', $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
      [
        deliveryId,
        scope.tenantId,
        scope.storeId,
        scope.conversationId,
        messageId,
        scope.customerId,
        `wkCONV-${RUN}:${scope.customerId}`,
        options.delivery?.status ?? 'pending',
        options.delivery?.externalMessageId ?? null,
        options.delivery?.attemptCount ?? 0,
        options.delivery?.failureCode ?? null,
        options.delivery?.failureCode == null
          ? null
          : 'recorded by the API before the Worker claimed the entry',
        options.delivery?.retryable ?? false,
        at,
      ],
    );
    await database.query(
      `INSERT INTO channel_outbox
         (id, tenant_id, store_id, delivery_id, message_id, status, attempt_count, available_at,
          created_at, updated_at, lease_owner, lease_expires_at, last_failure_code,
          last_failure_reason)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $8, $9, $10, NULL, NULL)`,
      [
        outboxId,
        scope.tenantId,
        scope.storeId,
        deliveryId,
        messageId,
        options.attemptCount ?? 0,
        options.availableAt ?? fixedNow,
        at,
        options.leaseOwner ?? null,
        options.leaseExpiresAt ?? null,
      ],
    );
    if (options.openWindow === true) {
      await openQuotaWindow(scope);
    }
    return { outboxId, deliveryId, messageId };
  }

  /** Open a fresh five-message reply window, as an inbound event would. */
  async function openQuotaWindow(scope: Scope): Promise<void> {
    await database.query(
      `INSERT INTO send_quota_windows
         (id, tenant_id, store_id, channel, external_customer_id, window_started_at,
          window_ends_at, message_limit, reserved_count, updated_at)
       VALUES ($1, $2, $3, 'wecom', $4, $5, $6, 5, 0, $5)
       ON CONFLICT (tenant_id, store_id, channel, external_customer_id)
       DO UPDATE SET window_started_at = $5, window_ends_at = $6, message_limit = 5,
                     reserved_count = 0, updated_at = $5`,
      [
        `window-ow-${RUN}-${scope.customerId}`,
        scope.tenantId,
        scope.storeId,
        scope.customerId,
        fixedNow,
        new Date(Date.parse(fixedNow) + 48 * 60 * 60 * 1000).toISOString(),
      ],
    );
  }

  /** Insert one immutable delivery attempt, the history a retry appends to. */
  async function seedAttempt(
    scope: Scope,
    deliveryId: string,
    attemptNumber: number,
    status: MessageDeliveryStatus,
    externalMessageId: string | null,
  ): Promise<void> {
    await database.query(
      `INSERT INTO message_delivery_attempts
         (id, tenant_id, delivery_id, attempt_number, status, external_message_id, failure_code,
          failure_reason, retryable, attempted_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, FALSE, $7)`,
      [
        `attempt-${RUN}-${deliveryId}-${attemptNumber}`,
        scope.tenantId,
        deliveryId,
        attemptNumber,
        status,
        externalMessageId,
        nowIso(),
      ],
    );
  }

  /** Read the raw outbox row, so a test asserts what the database holds. */
  async function readOutbox(outboxId: string): Promise<Record<string, unknown>> {
    const rows = await database.rows('SELECT * FROM channel_outbox WHERE id = $1', [outboxId]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`test invariant: outbox entry ${outboxId} is missing`);
    }
    return row;
  }

  /** Read the raw delivery row, so a test asserts what the database holds. */
  async function readDelivery(deliveryId: string): Promise<Record<string, unknown>> {
    const rows = await database.rows('SELECT * FROM message_deliveries WHERE id = $1', [
      deliveryId,
    ]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`test invariant: delivery ${deliveryId} is missing`);
    }
    return row;
  }

  /** Count the immutable attempts recorded for one delivery. */
  async function countAttempts(deliveryId: string): Promise<number> {
    const rows = await database.rows(
      'SELECT COUNT(*)::int AS total FROM message_delivery_attempts WHERE delivery_id = $1',
      [deliveryId],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** Count the deliveries one logical message has. Must never exceed one. */
  async function countDeliveries(tenantId: string, messageId: string): Promise<number> {
    const rows = await database.rows(
      'SELECT COUNT(*)::int AS total FROM message_deliveries WHERE tenant_id = $1 AND message_id = $2',
      [tenantId, messageId],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  /** Remove every row this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    for (const tenantId of tenants) {
      await database.query('DELETE FROM channel_outbox WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM message_status_events WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM message_delivery_attempts WHERE tenant_id = $1', [
        tenantId,
      ]);
      await database.query('DELETE FROM message_deliveries WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM send_quota_windows WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM inbound_events WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM messages WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM conversations WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM members WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM stores WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
  }
});

/** Current instant, so durable timestamps are realistic. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Resolve the database the tests should talk to.
 *
 * Uses the same parser the Worker's entry point uses, so a test follows
 * `DATABASE_URL` when it is set and otherwise the documented local default.
 */
function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = parseAppConfig({ ...env, APP_ENV: 'test' });
  if (parsed._tag !== 'ok') {
    throw new Error(`test database configuration is invalid: ${parsed.error.message}`);
  }
  return parsed.config.databaseUrl.unwrap();
}

/**
 * Drive one `database/scripts` entrypoint, exactly as a developer would.
 *
 * The URL travels through the child environment, never through its command line.
 */
function runDatabaseCommand(command: 'migrate', url: string): void {
  execFileSync(
    process.execPath,
    [path.resolve(process.cwd(), 'database/scripts/migrate.cjs'), command],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    },
  );
}

/**
 * Child-process program that answers "is the database up?" with its exit code.
 *
 * Built by a function rather than held in a module constant, because the suite
 * decides `describe.skipIf(...)` at the top of this file: a `const` declared
 * down here would still be in its temporal dead zone at that point, and the
 * skip would silently read as "no database" on a machine that has one.
 */
function reachabilityProbe(): string {
  return [
    "const { Client } = require('pg');",
    'const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });',
    'client',
    '  .connect()',
    "  .then(() => client.query('SELECT 1'))",
    '  .then(() => client.end())',
    '  .then(() => process.exit(0))',
    '  .catch(() => process.exit(1));',
  ].join('\n');
}

/**
 * Probe the database with a bounded round trip.
 *
 * Synchronous on purpose: the suite has to decide `describe.skipIf(...)` while
 * Vitest collects it, before any hook has run.
 */
function isDatabaseReachable(url: string): boolean {
  try {
    execFileSync(process.execPath, ['-e', reachabilityProbe()], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}
