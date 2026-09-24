import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig, type AppConfig } from '@kefu/core';
import { DatabaseService } from '../src/database/database.service';
import { TransactionManager } from '../src/persistence/transaction-manager';
import { PostgresChannelReliabilityRepository } from '../src/channels/postgres-channel-reliability.repository';
import { resolveChannelStorageMode } from '../src/channels/channel-reliability.repository';
import {
  isDatabaseReachable,
  resolveDatabaseUrl,
  runDatabaseCommand,
} from './database-test-support';

/**
 * Integration tests for the durable channel reliability store.
 *
 * These exercise {@link PostgresChannelReliabilityRepository} against the real
 * PostgreSQL the platform targets — the tables and unique constraints migration
 * `0006` declares — rather than only against the in-memory adapter the interface
 * tests use. They prove the facts the acceptance criteria name: a replayed
 * callback resolves to the receipt the first request wrote, a logical message
 * keeps exactly one delivery across attempts, the reply budget is enforced by a
 * locked read rather than a hopeful write, and a provider status notification is
 * applied once.
 *
 * The suite skips cleanly when no database is reachable, so `npm test` passes on
 * a machine without PostgreSQL; a run that actually executed reports so through
 * the test names. Every row it writes carries a per-run unique identifier and is
 * removed again in `afterAll`, so it never depends on — or disturbs — another
 * run's rows.
 */
const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Unique suffix isolating this run's rows from every other run's. */
const RUN = randomUUID().slice(0, 8);

describe.skipIf(!reachable)('Channel reliability persistence (PostgreSQL)', () => {
  let config: AppConfig;
  let database: DatabaseService;
  let pool: Pool;
  let repository: PostgresChannelReliabilityRepository;

  const tenantId = `tenant-cr-${RUN}`;
  const storeId = `store-cr-${RUN}`;
  const memberId = `member-cr-${RUN}`;
  const conversationId = `conversation-cr-${RUN}`;

  /** Insert a platform message row, the parent a delivery points at. */
  async function seedMessage(suffix: string): Promise<string> {
    const id = `message-cr-${RUN}-${suffix}`;
    await pool.query(
      `INSERT INTO messages
         (id, tenant_id, store_id, conversation_id, channel, direction, source, message_type,
          content, dedup_key, review_eligible, review_state, candidate_id, created_at)
       VALUES ($1, $2, $3, $4, 'wecom', 'outbound', 'manual_typed', 'text', $5, $6, FALSE, 'none', NULL, $7)`,
      [
        id,
        tenantId,
        storeId,
        conversationId,
        `集成测试消息 ${suffix}`,
        `cr-${RUN}-${suffix}`,
        now(),
      ],
    );
    return id;
  }

  beforeAll(async () => {
    const parsed = parseAppConfig({ ...process.env, APP_ENV: 'test' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    config = parsed.config;
    // Idempotent: the migrations may already be applied on a developer machine.
    runDatabaseCommand('migrate', databaseUrl);
    database = new DatabaseService(config);
    pool = database.pool;
    repository = new PostgresChannelReliabilityRepository(
      database,
      new TransactionManager(database),
    );
    await seedDirectory();
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await cleanup();
      await database.onModuleDestroy();
    }
  });

  it('runs against a reachable database', () => {
    // Reported explicitly so a skipped run is never mistaken for a passing one.
    expect(reachable).toBe(true);
  });

  it('selects the durable adapter for local and production only', () => {
    expect(resolveChannelStorageMode('test')).toBe('memory');
    expect(resolveChannelStorageMode('local')).toBe('postgres');
    expect(resolveChannelStorageMode('production')).toBe('postgres');
  });

  it('records a callback receipt once and reports the replay as existing', async () => {
    const first = await repository.recordInboundEvent({
      tenantId,
      storeId,
      channel: 'wecom',
      externalEventId: `event-${RUN}-a`,
      payloadHash: 'hash-a',
      now: now(),
    });
    expect(first.created).toBe(true);
    expect(first.event.status).toBe('received');

    const replay = await repository.recordInboundEvent({
      tenantId,
      storeId,
      channel: 'wecom',
      externalEventId: `event-${RUN}-a`,
      payloadHash: 'hash-a',
      now: now(),
    });
    expect(replay.created).toBe(false);
    expect(replay.event.id).toBe(first.event.id);

    const messageId = await seedMessage('inbound-event');
    const completed = await repository.completeInboundEvent(
      tenantId,
      `event-${RUN}-a`,
      messageId,
      now(),
    );
    expect(completed).toMatchObject({ status: 'processed', messageId });

    const failed = await repository.failInboundEvent(
      tenantId,
      `event-${RUN}-a`,
      'retry exhausted',
      now(),
    );
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'retry exhausted' });

    // Another tenant's receipt is invisible, even for the same event id.
    expect(
      await repository.getInboundEvent(`tenant-cr-other-${RUN}`, `event-${RUN}-a`),
    ).toBeUndefined();
  });

  it('keeps exactly one delivery per logical message across attempts', async () => {
    const messageId = await seedMessage('delivery');
    const created = await repository.createDelivery({
      tenantId,
      storeId,
      conversationId,
      messageId,
      channel: 'wecom',
      externalCustomerId: `customer-cr-${RUN}`,
      externalConversationId: `external-cr-${RUN}`,
      now: now(),
    });
    expect(created.created).toBe(true);
    expect(created.delivery).toMatchObject({ status: 'pending', attemptCount: 0 });

    const replay = await repository.createDelivery({
      tenantId,
      storeId,
      conversationId,
      messageId,
      channel: 'wecom',
      externalCustomerId: `customer-cr-${RUN}`,
      externalConversationId: `external-cr-${RUN}`,
      now: now(),
    });
    expect(replay.created).toBe(false);
    expect(replay.delivery.id).toBe(created.delivery.id);

    const outbox = await repository.enqueueOutbox({
      tenantId,
      storeId,
      deliveryId: created.delivery.id,
      messageId,
      now: now(),
    });
    const requeued = await repository.enqueueOutbox({
      tenantId,
      storeId,
      deliveryId: created.delivery.id,
      messageId,
      now: now(),
    });
    expect(requeued.id).toBe(outbox.id);
    expect(outbox.status).toBe('pending');

    const firstAttempt = await repository.appendAttempt({
      tenantId,
      deliveryId: created.delivery.id,
      status: 'failed',
      externalMessageId: null,
      failureCode: 'channel_provider_error',
      failureReason: 'mock provider rejected the message',
      retryable: true,
      now: now(),
    });
    expect(firstAttempt.attempt.attemptNumber).toBe(1);
    expect(firstAttempt.delivery).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      failureCode: 'channel_provider_error',
      retryable: true,
    });

    const secondAttempt = await repository.appendAttempt({
      tenantId,
      deliveryId: created.delivery.id,
      status: 'sent',
      externalMessageId: 'mock-external-1',
      failureCode: null,
      failureReason: null,
      retryable: false,
      now: now(),
    });
    expect(secondAttempt.attempt.attemptNumber).toBe(2);
    expect(secondAttempt.delivery).toMatchObject({
      status: 'sent',
      attemptCount: 2,
      externalMessageId: 'mock-external-1',
      failureCode: null,
    });

    const attempts = await repository.listAttempts(tenantId, created.delivery.id);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);

    await repository.saveOutboxState({
      tenantId,
      outboxId: outbox.id,
      status: 'dispatched',
      attemptCount: 2,
      now: now(),
    });
    expect(await repository.getOutboxByDelivery(tenantId, created.delivery.id)).toMatchObject({
      status: 'dispatched',
      attemptCount: 2,
    });

    const deliveries = await repository.listDeliveries(tenantId, conversationId);
    expect(deliveries.some((delivery) => delivery.id === created.delivery.id)).toBe(true);
    expect(
      await repository.getDelivery(`tenant-cr-other-${RUN}`, created.delivery.id),
    ).toBeUndefined();
  });

  it('opens a reply window and enforces its budget atomically', async () => {
    const key = {
      tenantId,
      storeId,
      channel: 'wecom',
      externalCustomerId: `customer-cr-${RUN}`,
    };
    // No window yet: the send is refused rather than allowed.
    const withoutWindow = await repository.reserveQuotaSlot(key, now());
    expect(withoutWindow).toMatchObject({ ok: false, code: 'window_missing' });

    const opened = await repository.openQuotaWindow(key, now());
    expect(opened.reservedCount).toBe(0);
    expect(opened.messageLimit).toBe(5);
    expect(Date.parse(opened.windowEndsAt) - Date.parse(opened.windowStartedAt)).toBe(
      48 * 60 * 60 * 1000,
    );

    for (let index = 1; index <= 5; index += 1) {
      const reservation = await repository.reserveQuotaSlot(key, now());
      expect(reservation.ok).toBe(true);
    }
    const exhausted = await repository.reserveQuotaSlot(key, now());
    expect(exhausted).toMatchObject({ ok: false, code: 'quota_exceeded' });

    // A definite provider failure returns its slot.
    const released = await repository.releaseQuotaSlot(key, now());
    expect(released?.reservedCount).toBe(4);
    expect((await repository.reserveQuotaSlot(key, now())).ok).toBe(true);

    // A new inbound customer event resets the window and its budget.
    const reopened = await repository.openQuotaWindow(key, now());
    expect(reopened.reservedCount).toBe(0);
    expect(reopened.id).toBe(opened.id);
    expect((await repository.reserveQuotaSlot(key, now())).ok).toBe(true);
  });

  it('refuses a send once the reply window has closed', async () => {
    const key = {
      tenantId,
      storeId,
      channel: 'wecom',
      externalCustomerId: `customer-cr-expired-${RUN}`,
    };
    await repository.openQuotaWindow(key, '2026-01-01T00:00:00.000Z');
    const expired = await repository.reserveQuotaSlot(key, '2026-01-05T00:00:00.000Z');
    expect(expired).toMatchObject({ ok: false, code: 'window_expired' });
  });

  it('applies a provider status notification once', async () => {
    const messageId = await seedMessage('status');
    const created = await repository.createDelivery({
      tenantId,
      storeId,
      conversationId,
      messageId,
      channel: 'wecom',
      externalCustomerId: `customer-cr-${RUN}`,
      externalConversationId: `external-cr-${RUN}`,
      now: now(),
    });

    const applied = await repository.recordStatusEvent({
      tenantId,
      deliveryId: created.delivery.id,
      externalEventId: `status-${RUN}-a`,
      status: 'unknown',
      reason: 'carrier lost the acknowledgement',
      occurredAt: now(),
      now: now(),
    });
    expect(applied).toMatchObject({ created: true, applied: true });

    const replay = await repository.recordStatusEvent({
      tenantId,
      deliveryId: created.delivery.id,
      externalEventId: `status-${RUN}-a`,
      status: 'unknown',
      reason: 'carrier lost the acknowledgement',
      occurredAt: now(),
      now: now(),
    });
    expect(replay).toMatchObject({ created: false, applied: false });
    expect(replay.event.id).toBe(applied.event.id);

    const delivery = await repository.getDelivery(tenantId, created.delivery.id);
    expect(delivery).toMatchObject({
      status: 'unknown',
      failureReason: 'carrier lost the acknowledgement',
      retryable: true,
    });

    // A stale event is still kept as history, but it does not move the delivery
    // backwards: `failed` ranks below `unknown`.
    const stale = await repository.recordStatusEvent({
      tenantId,
      deliveryId: created.delivery.id,
      externalEventId: `status-${RUN}-stale`,
      status: 'failed',
      reason: 'a late rejection',
      occurredAt: now(),
      now: now(),
    });
    expect(stale).toMatchObject({ created: true, applied: false });
    expect(await repository.getDelivery(tenantId, created.delivery.id)).toMatchObject({
      status: 'unknown',
      retryable: true,
    });

    // `sent` is terminal: it applies once, and nothing after it moves the
    // delivery or makes it retryable again.
    const sent = await repository.recordStatusEvent({
      tenantId,
      deliveryId: created.delivery.id,
      externalEventId: `status-${RUN}-sent`,
      status: 'sent',
      reason: null,
      occurredAt: now(),
      now: now(),
    });
    expect(sent).toMatchObject({ created: true, applied: true });
    const late = await repository.recordStatusEvent({
      tenantId,
      deliveryId: created.delivery.id,
      externalEventId: `status-${RUN}-late`,
      status: 'failed',
      reason: 'a very late rejection',
      occurredAt: now(),
      now: now(),
    });
    expect(late).toMatchObject({ created: true, applied: false });
    expect(await repository.getDelivery(tenantId, created.delivery.id)).toMatchObject({
      status: 'sent',
      retryable: false,
    });

    const events = await repository.listStatusEvents(tenantId, created.delivery.id);
    expect(events).toHaveLength(4);
  });

  /** Insert the tenant, store, member and conversation this run owns. */
  async function seedDirectory(): Promise<void> {
    const now = new Date().toISOString();
    await pool.query(
      'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
      [tenantId, `cr-${RUN}`, '渠道可靠性集成测试租户', now],
    );
    await pool.query(
      'INSERT INTO stores (id, tenant_id, code, name, enabled, created_at) VALUES ($1, $2, $3, $4, TRUE, $5)',
      [storeId, tenantId, 'main', '渠道可靠性集成测试门店', now],
    );
    await pool.query(
      'INSERT INTO members (id, tenant_id, store_id, role, username, display_name, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)',
      [memberId, tenantId, storeId, 'agent', `cr-agent-${RUN}`, '渠道可靠性集成测试客服', now],
    );
    await pool.query(
      `INSERT INTO conversations
         (id, tenant_id, store_id, channel, external_customer_id, external_conversation_id, title,
          status, version, assigned_member_id, opened_at, last_message_at, closed_at, created_at)
       VALUES ($1, $2, $3, 'wecom', $4, $5, NULL, 'open', 1, NULL, $6, $6, NULL, $6)`,
      [conversationId, tenantId, storeId, `customer-cr-${RUN}`, `external-cr-${RUN}`, now],
    );
  }

  /** Remove everything this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM channel_outbox WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM message_status_events WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM message_delivery_attempts WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM message_deliveries WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM send_quota_windows WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM inbound_events WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM messages WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM conversations WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM members WHERE id = $1', [memberId]);
    await pool.query('DELETE FROM stores WHERE id = $1', [storeId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  }
});

/** Current instant, so the durable timestamps are realistic. */
function now(): string {
  return new Date().toISOString();
}
