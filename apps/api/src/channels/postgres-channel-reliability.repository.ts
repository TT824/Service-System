/**
 * Durable {@link ChannelReliabilityRepository} over the tables migration `0006`
 * declares.
 *
 * The adapter owns no authorization policy: the calling service has already
 * resolved the verified tenant scope, and every statement here is *additionally*
 * scoped by `tenant_id`, so a caller cannot reach another tenant's rows. What the
 * adapter owns is the durable half of the reliability rules:
 *
 * - Callback receipts, deliveries, status events and outbox entries are
 *   idempotent through the unique indexes the migration declares
 *   (`(tenant_id, channel, external_event_id)`, `(tenant_id, message_id)`,
 *   `(tenant_id, external_event_id)` and `(tenant_id, delivery_id)`), so two
 *   racing requests resolve to the row the first one wrote instead of a second
 *   one. An `INSERT ... ON CONFLICT DO NOTHING` that returns no row is not a
 *   failure; the existing row is read back and reported with `created: false`.
 * - The two mutations that must not be interleaved run inside one transaction on
 *   a locked row: reserving a reply-window slot (`SELECT ... FOR UPDATE`, then
 *   evaluate and increment) and appending an attempt (append, then move the
 *   delivery's latest state), so a caller can never observe an attempt whose
 *   outcome is not reflected in the delivery, or a window over its budget.
 *
 * The window/quota rule itself is not duplicated here: it comes from
 * `evaluateDeliveryWindow` in `@kefu/core`, the same function the in-process
 * adapter uses, so both adapters decide identically.
 *
 * All statements are parameterised; timestamps are normalised to ISO strings on
 * the way out so the durable records match the in-memory ones exactly.
 */

import { randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  advancesDeliveryStatus,
  DELIVERY_WINDOW_MESSAGE_LIMIT,
  deliveryWindowEndsAt,
  evaluateDeliveryWindow,
  isDeliveryFailureCode,
  isDeliveryRetryable,
  type ChannelOutboxRecord,
  type DeliveryAttempt,
  type DeliveryFailureCode,
  type InboundEvent,
  type MessageDelivery,
  type MessageStatusEvent,
  type SendQuotaWindow,
} from '@kefu/core';
import { DatabaseService } from '../database/database.service';
import { TransactionManager, type TransactionClient } from '../persistence/transaction-manager';
import {
  toBoolean,
  toIso,
  toIsoOrNull,
  toNumber,
  toText,
  toTextOrNull,
} from '../persistence/row-values';
import type {
  AppendAttemptInput,
  ChannelReliabilityRepository,
  ClaimOutboxForSendInput,
  CreateDeliveryInput,
  DeliveryRecord,
  EnqueueOutboxInput,
  InboundEventRecord,
  QuotaReservation,
  QuotaWindowKey,
  RecordDegradationInput,
  RecordInboundEventInput,
  RecordStatusEventInput,
  ReleaseOutboxClaimInput,
  SaveOutboxStateInput,
  StatusEventRecord,
} from './channel-reliability.repository';

/** Column list shared by every delivery `SELECT`/`RETURNING`. */
const DELIVERY_COLUMNS = `id, tenant_id, store_id, conversation_id, message_id, channel,
  external_customer_id, external_conversation_id, status, external_message_id,
  attempt_count, failure_code, failure_reason, retryable, created_at, updated_at`;

/** Column list shared by every attempt `SELECT`/`RETURNING`. */
const ATTEMPT_COLUMNS = `id, tenant_id, delivery_id, attempt_number, status,
  external_message_id, failure_code, failure_reason, retryable, attempted_at`;

/** Channel reliability store backed by the API-owned PostgreSQL pool. */
export class PostgresChannelReliabilityRepository implements ChannelReliabilityRepository {
  /**
   * @param database - The API-owned connection pool, used for reads.
   * @param transactions - The transactional boundary, used for the mutations
   * that must be atomic or must serialise against a concurrent one.
   */
  constructor(
    private readonly database: DatabaseService,
    private readonly transactions: TransactionManager,
  ) {}

  // --------------------------------------------------------------------------
  // Inbound callback receipts
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async recordInboundEvent(input: RecordInboundEventInput): Promise<InboundEventRecord> {
    const rows = await this.rows(
      `INSERT INTO inbound_events
         (id, tenant_id, store_id, channel, external_event_id, payload_hash, status,
          message_id, failure_reason, received_at, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'received', NULL, NULL, $7, NULL)
       ON CONFLICT (tenant_id, channel, external_event_id) DO NOTHING
       RETURNING *`,
      [
        `inbound-event-${randomUUID()}`,
        input.tenantId,
        input.storeId,
        input.channel,
        input.externalEventId,
        input.payloadHash,
        input.now,
      ],
    );
    const inserted = rows[0];
    if (inserted !== undefined) {
      return { event: toInboundEvent(inserted), created: true };
    }
    const existing = await this.getInboundEvent(input.tenantId, input.externalEventId);
    if (existing === undefined) {
      throw new Error('channel invariant: conflicting inbound event disappeared after insert');
    }
    return { event: existing, created: false };
  }

  /** @inheritdoc */
  async getInboundEvent(
    tenantId: string,
    externalEventId: string,
  ): Promise<InboundEvent | undefined> {
    const rows = await this.rows(
      `SELECT * FROM inbound_events
        WHERE tenant_id = $1 AND external_event_id = $2
        ORDER BY received_at
        LIMIT 1`,
      [tenantId, externalEventId],
    );
    return optional(rows[0], toInboundEvent);
  }

  /** @inheritdoc */
  async completeInboundEvent(
    tenantId: string,
    externalEventId: string,
    messageId: string,
    now: string,
  ): Promise<InboundEvent | undefined> {
    const rows = await this.rows(
      `UPDATE inbound_events
          SET status = 'processed', message_id = $3, failure_reason = NULL, processed_at = $4
        WHERE tenant_id = $1 AND external_event_id = $2
        RETURNING *`,
      [tenantId, externalEventId, messageId, now],
    );
    return optional(rows[0], toInboundEvent);
  }

  /** @inheritdoc */
  async failInboundEvent(
    tenantId: string,
    externalEventId: string,
    reason: string,
    now: string,
  ): Promise<InboundEvent | undefined> {
    const rows = await this.rows(
      `UPDATE inbound_events
          SET status = 'failed', failure_reason = $3, processed_at = $4
        WHERE tenant_id = $1 AND external_event_id = $2
        RETURNING *`,
      [tenantId, externalEventId, reason, now],
    );
    return optional(rows[0], toInboundEvent);
  }

  // --------------------------------------------------------------------------
  // Deliveries and attempts
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async createDelivery(input: CreateDeliveryInput): Promise<DeliveryRecord> {
    const rows = await this.rows(
      `INSERT INTO message_deliveries
         (id, tenant_id, store_id, conversation_id, message_id, channel, external_customer_id,
          external_conversation_id, status, external_message_id, attempt_count, failure_code,
          failure_reason, retryable, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NULL, 0, NULL, NULL, FALSE, $9, $9)
       ON CONFLICT (tenant_id, message_id) DO NOTHING
       RETURNING ${DELIVERY_COLUMNS}`,
      [
        `delivery-${randomUUID()}`,
        input.tenantId,
        input.storeId,
        input.conversationId,
        input.messageId,
        input.channel,
        input.externalCustomerId,
        input.externalConversationId,
        input.now,
      ],
    );
    const inserted = rows[0];
    if (inserted !== undefined) {
      return { delivery: toDelivery(inserted), created: true };
    }
    const existing = await this.getDeliveryByMessage(input.tenantId, input.messageId);
    if (existing === undefined) {
      throw new Error('channel invariant: conflicting delivery disappeared after insert');
    }
    return { delivery: existing, created: false };
  }

  /** @inheritdoc */
  async getDelivery(tenantId: string, deliveryId: string): Promise<MessageDelivery | undefined> {
    const rows = await this.rows(
      `SELECT ${DELIVERY_COLUMNS} FROM message_deliveries WHERE tenant_id = $1 AND id = $2`,
      [tenantId, deliveryId],
    );
    return optional(rows[0], toDelivery);
  }

  /** @inheritdoc */
  async getDeliveryByMessage(
    tenantId: string,
    messageId: string,
  ): Promise<MessageDelivery | undefined> {
    const rows = await this.rows(
      `SELECT ${DELIVERY_COLUMNS} FROM message_deliveries WHERE tenant_id = $1 AND message_id = $2`,
      [tenantId, messageId],
    );
    return optional(rows[0], toDelivery);
  }

  /** @inheritdoc */
  async listDeliveries(
    tenantId: string,
    conversationId: string,
  ): Promise<ReadonlyArray<MessageDelivery>> {
    const rows = await this.rows(
      `SELECT ${DELIVERY_COLUMNS} FROM message_deliveries
        WHERE tenant_id = $1 AND conversation_id = $2
        ORDER BY created_at, id`,
      [tenantId, conversationId],
    );
    return rows.map(toDelivery);
  }

  /**
   * @inheritdoc
   *
   * The row is locked first, so two concurrent attempts serialise: the loser
   * sees the committed attempt number and appends the next one rather than
   * reusing it.
   */
  async appendAttempt(
    input: AppendAttemptInput,
  ): Promise<{ readonly attempt: DeliveryAttempt; readonly delivery: MessageDelivery }> {
    return this.transactions.run(async (client) => {
      const current = await this.lockDelivery(client, input.tenantId, input.deliveryId);
      const attemptNumber = current.attemptCount + 1;
      const attemptRows = await this.statement(
        client,
        `INSERT INTO message_delivery_attempts
           (id, tenant_id, delivery_id, attempt_number, status, external_message_id,
            failure_code, failure_reason, retryable, attempted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${ATTEMPT_COLUMNS}`,
        [
          `delivery-attempt-${randomUUID()}`,
          input.tenantId,
          input.deliveryId,
          attemptNumber,
          input.status,
          input.externalMessageId,
          input.failureCode,
          input.failureReason,
          input.retryable,
          input.now,
        ],
      );
      const attempt = required(attemptRows[0], toAttempt);
      const deliveryRows = await this.statement(
        client,
        `UPDATE message_deliveries
            SET status = $3,
                external_message_id = COALESCE($4, external_message_id),
                attempt_count = $5,
                failure_code = $6,
                failure_reason = $7,
                retryable = $8,
                updated_at = $9
          WHERE tenant_id = $1 AND id = $2
          RETURNING ${DELIVERY_COLUMNS}`,
        [
          input.tenantId,
          input.deliveryId,
          input.status,
          input.externalMessageId,
          attemptNumber,
          input.failureCode,
          input.failureReason,
          input.retryable,
          input.now,
        ],
      );
      return { attempt, delivery: required(deliveryRows[0], toDelivery) };
    });
  }

  /** @inheritdoc */
  async recordDegradation(input: RecordDegradationInput): Promise<MessageDelivery> {
    const rows = await this.rows(
      `UPDATE message_deliveries
          SET status = 'pending', failure_code = $3, failure_reason = $4,
              retryable = $5, updated_at = $6
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${DELIVERY_COLUMNS}`,
      [
        input.tenantId,
        input.deliveryId,
        input.failureCode,
        input.failureReason,
        input.retryable,
        input.now,
      ],
    );
    const delivery = optional(rows[0], toDelivery);
    if (delivery === undefined) {
      throw new Error('channel invariant: delivery not found in tenant scope');
    }
    return delivery;
  }

  /** @inheritdoc */
  async listAttempts(
    tenantId: string,
    deliveryId: string,
  ): Promise<ReadonlyArray<DeliveryAttempt>> {
    const rows = await this.rows(
      `SELECT ${ATTEMPT_COLUMNS} FROM message_delivery_attempts
        WHERE tenant_id = $1 AND delivery_id = $2
        ORDER BY attempt_number`,
      [tenantId, deliveryId],
    );
    return rows.map(toAttempt);
  }

  // --------------------------------------------------------------------------
  // Provider status notifications
  // --------------------------------------------------------------------------

  /**
   * @inheritdoc
   *
   * The reply-window row is not involved; what the transaction protects is the
   * pair "status event + delivery state", which must move together. Idempotency
   * is the `(tenant_id, external_event_id)` unique index, so two racing
   * notifications apply exactly once.
   *
   * The notification is always inserted — the history is immutable — but the
   * delivery row is only moved when {@link advancesDeliveryStatus} allows it, so
   * a late or stale event cannot drag a `sent` delivery backwards and re-offer a
   * retry for a message the customer already received.
   */
  async recordStatusEvent(input: RecordStatusEventInput): Promise<StatusEventRecord> {
    return this.transactions.run(async (client) => {
      const existingRows = await this.statement(
        client,
        'SELECT * FROM message_status_events WHERE tenant_id = $1 AND external_event_id = $2',
        [input.tenantId, input.externalEventId],
      );
      const existing = optional(existingRows[0], toStatusEvent);
      if (existing !== undefined) {
        return { event: existing, created: false, applied: false };
      }
      const delivery = await this.lockDelivery(client, input.tenantId, input.deliveryId);
      const inserted = await this.statement(
        client,
        `INSERT INTO message_status_events
           (id, tenant_id, delivery_id, external_event_id, status, reason, occurred_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          `status-event-${randomUUID()}`,
          input.tenantId,
          delivery.id,
          input.externalEventId,
          input.status,
          input.reason,
          input.occurredAt,
          input.now,
        ],
      );
      if (!advancesDeliveryStatus(delivery.status, input.status)) {
        return { event: required(inserted[0], toStatusEvent), created: true, applied: false };
      }
      await this.statement(
        client,
        `UPDATE message_deliveries
            SET status = $3,
                failure_code = CASE WHEN $3 = 'sent' THEN NULL ELSE failure_code END,
                failure_reason = $4,
                retryable = $5,
                updated_at = $6
          WHERE tenant_id = $1 AND id = $2`,
        [
          input.tenantId,
          delivery.id,
          input.status,
          input.status === 'sent' ? null : input.reason,
          isDeliveryRetryable(input.status),
          input.now,
        ],
      );
      return { event: required(inserted[0], toStatusEvent), created: true, applied: true };
    });
  }

  /** @inheritdoc */
  async listStatusEvents(
    tenantId: string,
    deliveryId: string,
  ): Promise<ReadonlyArray<MessageStatusEvent>> {
    const rows = await this.rows(
      `SELECT * FROM message_status_events
        WHERE tenant_id = $1 AND delivery_id = $2
        ORDER BY occurred_at, id`,
      [tenantId, deliveryId],
    );
    return rows.map(toStatusEvent);
  }

  // --------------------------------------------------------------------------
  // Reply window and outbox
  // --------------------------------------------------------------------------

  /**
   * @inheritdoc
   *
   * A new inbound customer event *resets* the window, which is what the
   * customer-service rule says: the budget restarts from the latest customer
   * message rather than accumulating against the customer.
   */
  async openQuotaWindow(key: QuotaWindowKey, now: string): Promise<SendQuotaWindow> {
    const rows = await this.rows(
      `INSERT INTO send_quota_windows
         (id, tenant_id, store_id, channel, external_customer_id, window_started_at,
          window_ends_at, message_limit, reserved_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $6)
       ON CONFLICT (tenant_id, store_id, channel, external_customer_id)
       DO UPDATE SET window_started_at = EXCLUDED.window_started_at,
                     window_ends_at = EXCLUDED.window_ends_at,
                     message_limit = EXCLUDED.message_limit,
                     reserved_count = 0,
                     updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        `quota-window-${randomUUID()}`,
        key.tenantId,
        key.storeId,
        key.channel,
        key.externalCustomerId,
        now,
        deliveryWindowEndsAt(now),
        DELIVERY_WINDOW_MESSAGE_LIMIT,
      ],
    );
    return required(rows[0], toQuotaWindow);
  }

  /** @inheritdoc */
  async getQuotaWindow(key: QuotaWindowKey): Promise<SendQuotaWindow | undefined> {
    const rows = await this.rows(
      `SELECT * FROM send_quota_windows
        WHERE tenant_id = $1 AND store_id = $2 AND channel = $3 AND external_customer_id = $4`,
      [key.tenantId, key.storeId, key.channel, key.externalCustomerId],
    );
    return optional(rows[0], toQuotaWindow);
  }

  /**
   * @inheritdoc
   *
   * The window row is locked before it is evaluated, so the decision and the
   * increment are one step: two concurrent sends can never both read "one slot
   * left" and both take it.
   */
  async reserveQuotaSlot(key: QuotaWindowKey, now: string): Promise<QuotaReservation> {
    return this.transactions.run(async (client) => {
      const rows = await this.statement(
        client,
        `SELECT * FROM send_quota_windows
          WHERE tenant_id = $1 AND store_id = $2 AND channel = $3 AND external_customer_id = $4
          FOR UPDATE`,
        [key.tenantId, key.storeId, key.channel, key.externalCustomerId],
      );
      const decision = evaluateDeliveryWindow(optional(rows[0], toQuotaWindow), now);
      if (!decision.allowed) {
        return { ok: false, code: decision.code, reason: decision.reason };
      }
      const updated = await this.statement(
        client,
        `UPDATE send_quota_windows
            SET reserved_count = reserved_count + 1, updated_at = $2
          WHERE tenant_id = $1 AND id = $3
          RETURNING *`,
        [key.tenantId, now, decision.window.id],
      );
      return { ok: true, window: required(updated[0], toQuotaWindow) };
    });
  }

  /**
   * @inheritdoc
   *
   * The count never goes below zero: a definite failure that raced with a window
   * reset releases a slot the reset already returned, and refusing that would
   * make the whole delivery fail for a bookkeeping detail.
   */
  async releaseQuotaSlot(key: QuotaWindowKey, now: string): Promise<SendQuotaWindow | undefined> {
    const rows = await this.rows(
      `UPDATE send_quota_windows
          SET reserved_count = GREATEST(reserved_count - 1, 0), updated_at = $5
        WHERE tenant_id = $1 AND store_id = $2 AND channel = $3 AND external_customer_id = $4
        RETURNING *`,
      [key.tenantId, key.storeId, key.channel, key.externalCustomerId, now],
    );
    return optional(rows[0], toQuotaWindow);
  }

  /** @inheritdoc */
  async enqueueOutbox(input: EnqueueOutboxInput): Promise<ChannelOutboxRecord> {
    const rows = await this.rows(
      `INSERT INTO channel_outbox
         (id, tenant_id, store_id, delivery_id, message_id, status, attempt_count,
          available_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $6, $6)
       ON CONFLICT (tenant_id, delivery_id) DO NOTHING
       RETURNING *`,
      [
        `outbox-${randomUUID()}`,
        input.tenantId,
        input.storeId,
        input.deliveryId,
        input.messageId,
        input.now,
      ],
    );
    const inserted = rows[0];
    if (inserted !== undefined) {
      return toOutbox(inserted);
    }
    const existing = await this.getOutboxByDelivery(input.tenantId, input.deliveryId);
    if (existing === undefined) {
      throw new Error('channel invariant: conflicting outbox entry disappeared after insert');
    }
    return existing;
  }

  /**
   * @inheritdoc
   *
   * The same conditions the Worker's due-work claim applies, so exactly one of
   * the two can win an entry: `status = 'pending'` and no live lease. An expired
   * lease passes, which is the recovery path for a holder that died mid-send.
   * `attempt_count` is deliberately not touched — the attempt is counted where
   * it has always been counted, when the adapter was actually reached, so a
   * refusal before the provider does not spend one.
   */
  async claimOutboxForSend(
    input: ClaimOutboxForSendInput,
  ): Promise<ChannelOutboxRecord | undefined> {
    const rows = await this.rows(
      // The entry id and the two timestamps each get their own placeholder.
      // They cannot share one: PostgreSQL resolves a parameter to a single type
      // for the whole statement, so a `$2` that is both `id` (text) and a
      // timestamp comparison makes the comparison fail outright rather than
      // coerce — `operator does not exist: timestamp with time zone <= text`
      // — and `id = $2` would have compared the row's id against a clock
      // reading even if it had been typed.
      `UPDATE channel_outbox
          SET lease_owner = $3, lease_expires_at = $4, updated_at = $5
        WHERE tenant_id = $1 AND id = $2
          AND status = 'pending'
          AND (lease_expires_at IS NULL OR lease_expires_at <= $5)
        RETURNING *`,
      [
        input.tenantId,
        input.outboxId,
        input.owner,
        new Date(Date.parse(input.now) + input.leaseMs).toISOString(),
        input.now,
      ],
    );
    return optional(rows[0], toOutbox);
  }

  /** @inheritdoc */
  async releaseOutboxClaim(input: ReleaseOutboxClaimInput): Promise<void> {
    await this.rows(
      `UPDATE channel_outbox
          SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $3
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.outboxId, input.now],
    );
  }

  /** @inheritdoc */
  async saveOutboxState(input: SaveOutboxStateInput): Promise<ChannelOutboxRecord> {
    const rows = await this.rows(
      // The lease is given back in the same statement: every caller of this is
      // finishing the send it held the entry for, and a released entry is what
      // lets the Worker retry a pending one — or leave a dispatched one alone —
      // without waiting out a lease nobody holds any more.
      `UPDATE channel_outbox
          SET status = $3, attempt_count = $4, updated_at = $5,
              lease_owner = NULL, lease_expires_at = NULL
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [input.tenantId, input.outboxId, input.status, input.attemptCount, input.now],
    );
    const record = optional(rows[0], toOutbox);
    if (record === undefined) {
      throw new Error('channel invariant: outbox entry not found in tenant scope');
    }
    return record;
  }

  /** @inheritdoc */
  async getOutboxByDelivery(
    tenantId: string,
    deliveryId: string,
  ): Promise<ChannelOutboxRecord | undefined> {
    const rows = await this.rows(
      'SELECT * FROM channel_outbox WHERE tenant_id = $1 AND delivery_id = $2',
      [tenantId, deliveryId],
    );
    return optional(rows[0], toOutbox);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /** Lock and read one delivery inside a transaction, or fail the invariant. */
  private async lockDelivery(
    client: TransactionClient,
    tenantId: string,
    deliveryId: string,
  ): Promise<MessageDelivery> {
    const rows = await this.statement(
      client,
      `SELECT ${DELIVERY_COLUMNS} FROM message_deliveries
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [tenantId, deliveryId],
    );
    const delivery = optional(rows[0], toDelivery);
    if (delivery === undefined) {
      throw new Error('channel invariant: delivery not found in tenant scope');
    }
    return delivery;
  }

  /** Run one parameterised statement on the pool and return its result. */
  private async query(
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Promise<QueryResult<QueryResultRow>> {
    // The pool is typed as `unknown` rows because the driver cannot know the
    // schema; the row mappers below narrow every column they read.
    return (await this.database.pool.query(text, [...values])) as QueryResult<QueryResultRow>;
  }

  /** Run one parameterised statement on the pool and return its rows. */
  private async rows(
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Promise<ReadonlyArray<QueryResultRow>> {
    return (await this.query(text, values)).rows;
  }

  /** Run one parameterised statement on a transaction connection. */
  private async statement(
    client: TransactionClient,
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Promise<ReadonlyArray<QueryResultRow>> {
    const result = (await client.query(text, [...values])) as QueryResult<QueryResultRow>;
    return result.rows;
  }
}

/** Row-to-domain mapping for a callback receipt. */
function toInboundEvent(row: QueryResultRow): InboundEvent {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    channel: toText(row['channel']),
    externalEventId: toText(row['external_event_id']),
    payloadHash: toText(row['payload_hash']),
    status: toInboundStatus(row['status']),
    messageId: toTextOrNull(row['message_id']),
    failureReason: toTextOrNull(row['failure_reason']),
    receivedAt: toIso(row['received_at']),
    processedAt: toIsoOrNull(row['processed_at']),
  };
}

/** Row-to-domain mapping for a delivery. */
function toDelivery(row: QueryResultRow): MessageDelivery {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    conversationId: toText(row['conversation_id']),
    messageId: toText(row['message_id']),
    channel: toText(row['channel']),
    externalCustomerId: toText(row['external_customer_id']),
    externalConversationId: toText(row['external_conversation_id']),
    status: toDeliveryStatus(row['status']),
    externalMessageId: toTextOrNull(row['external_message_id']),
    attemptCount: toNumber(row['attempt_count']),
    failureCode: toFailureCode(row['failure_code']),
    failureReason: toTextOrNull(row['failure_reason']),
    retryable: toBoolean(row['retryable']),
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
  };
}

/** Row-to-domain mapping for one delivery attempt. */
function toAttempt(row: QueryResultRow): DeliveryAttempt {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    deliveryId: toText(row['delivery_id']),
    attemptNumber: toNumber(row['attempt_number']),
    status: toDeliveryStatus(row['status']),
    externalMessageId: toTextOrNull(row['external_message_id']),
    failureCode: toFailureCode(row['failure_code']),
    failureReason: toTextOrNull(row['failure_reason']),
    retryable: toBoolean(row['retryable']),
    attemptedAt: toIso(row['attempted_at']),
  };
}

/** Row-to-domain mapping for one provider status notification. */
function toStatusEvent(row: QueryResultRow): MessageStatusEvent {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    deliveryId: toText(row['delivery_id']),
    externalEventId: toText(row['external_event_id']),
    status: toDeliveryStatus(row['status']),
    reason: toTextOrNull(row['reason']),
    occurredAt: toIso(row['occurred_at']),
    createdAt: toIso(row['created_at']),
  };
}

/** Row-to-domain mapping for one reply window. */
function toQuotaWindow(row: QueryResultRow): SendQuotaWindow {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    channel: toText(row['channel']),
    externalCustomerId: toText(row['external_customer_id']),
    windowStartedAt: toIso(row['window_started_at']),
    windowEndsAt: toIso(row['window_ends_at']),
    messageLimit: toNumber(row['message_limit']),
    reservedCount: toNumber(row['reserved_count']),
    updatedAt: toIso(row['updated_at']),
  };
}

/** Row-to-domain mapping for one outbox entry. */
function toOutbox(row: QueryResultRow): ChannelOutboxRecord {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    deliveryId: toText(row['delivery_id']),
    messageId: toText(row['message_id']),
    status: toOutboxStatus(row['status']),
    attemptCount: toNumber(row['attempt_count']),
    availableAt: toIso(row['available_at']),
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
  };
}

/** Read a callback receipt status column, defaulting to `received`. */
function toInboundStatus(value: unknown): InboundEvent['status'] {
  return value === 'processed' || value === 'failed' ? value : 'received';
}

/** Read a delivery status column, defaulting to `pending`. */
function toDeliveryStatus(value: unknown): MessageDelivery['status'] {
  return value === 'sent' || value === 'failed' || value === 'unknown' ? value : 'pending';
}

/** Read an outbox status column, defaulting to `pending`. */
function toOutboxStatus(value: unknown): ChannelOutboxRecord['status'] {
  return value === 'dispatched' || value === 'abandoned' ? value : 'pending';
}

/** Read a nullable failure code column, keeping only codes the domain knows. */
function toFailureCode(value: unknown): DeliveryFailureCode | null {
  const text = toTextOrNull(value);
  return text !== null && isDeliveryFailureCode(text) ? text : null;
}

function optional<T>(
  row: QueryResultRow | undefined,
  map: (row: QueryResultRow) => T,
): T | undefined {
  return row === undefined ? undefined : map(row);
}

function required<T>(row: QueryResultRow | undefined, map: (row: QueryResultRow) => T): T {
  if (row === undefined) {
    throw new Error('channel invariant: statement returned no row');
  }
  return map(row);
}
