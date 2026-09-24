/**
 * Durable {@link OutboxRepository} over the tables migrations `0006` and `0007`
 * declare.
 *
 * Every rule this adapter reproduces in SQL has exactly one definition, in
 * `@kefu/core`, and the comments below name it at each statement — the claim
 * predicate, the lease length, the attempt bound, the retry schedule and the
 * delivery-status ordering. Nothing here decides a policy of its own: it
 * expresses a Core decision in the one place a *concurrent* Worker can be
 * excluded from it.
 *
 * Three properties are the reason the SQL is written the way it is:
 *
 * - **The claim is one statement.** A CTE takes the due rows with
 *   `FOR UPDATE SKIP LOCKED` and the outer `UPDATE` claims them. A second Worker
 *   running the same statement concurrently skips what the first has locked, so
 *   the two can never be handed the same attempt — and because the lock lives
 *   only for the statement, the claim is committed before the provider is called.
 *   The `attempt_count` predicate has no "unless this owner already holds it"
 *   exception, exactly like {@link channelOutboxClaimRefusal}: a Worker that
 *   died is recovered by its *lease expiring*, never by claiming an entry whose
 *   budget is spent.
 * - **Every compare-by-owner write re-checks the owner in its `WHERE`.** A Worker
 *   whose lease expired and was taken over must not be able to complete,
 *   reschedule or abandon work it no longer owns, so `lease_owner = $owner` is
 *   part of the update rather than a read-then-write.
 * - **Two mutations run in one transaction.** Reserving a window slot (lock,
 *   evaluate, increment) and appending an attempt (lock the delivery, insert the
 *   attempt, re-project the delivery) must not be interleaved. Neither holds a
 *   lock across a provider call, because the processor calls the provider between
 *   them, not inside them.
 * - **The last statement before the provider call re-validates ownership.**
 *   {@link PostgresOutboxRepository.renewOutboxLease} matches on `lease_owner`, so
 *   a Worker that lost its claim while it was preparing is refused *before* it
 *   sends, and the same statement hands the send a full lease to run inside.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  CHANNEL_OUTBOX_LEASE_MS,
  CHANNEL_OUTBOX_MAX_ATTEMPTS,
  advancesDeliveryStatus,
  evaluateDeliveryWindow,
  isDeliveryFailureCode,
  outboxRetryDelayMs,
  type ChannelOutboxLeaseRecord,
  type DeliveryAttempt,
  type DeliveryFailureCode,
  type MessageDelivery,
  type MessageType,
  type SendQuotaWindow,
} from '@kefu/core';
import { WorkerDatabase } from '../database/worker-database';
import {
  toBoolean,
  toIso,
  toIsoOrNull,
  toNumber,
  toText,
  toTextOrNull,
} from '../database/row-values';
import type {
  OutboxFailure,
  OutboxMessage,
  OutboxRepository,
  ProviderAttemptInput,
  ProviderAttemptRecord,
  QuotaReservation,
  QuotaWindowKey,
} from './outbox-repository';

/** Column list shared by every delivery `SELECT`/`RETURNING`. */
const DELIVERY_COLUMNS = `id, tenant_id, store_id, conversation_id, message_id, channel,
  external_customer_id, external_conversation_id, status, external_message_id,
  attempt_count, failure_code, failure_reason, retryable, created_at, updated_at`;

/** Column list shared by every attempt `SELECT`/`RETURNING`. */
const ATTEMPT_COLUMNS = `id, tenant_id, delivery_id, attempt_number, status,
  external_message_id, failure_code, failure_reason, retryable, attempted_at`;

/** Outbox columns, including the `0007` claim state. */
const OUTBOX_COLUMN_NAMES: ReadonlyArray<string> = [
  'id',
  'tenant_id',
  'store_id',
  'delivery_id',
  'message_id',
  'status',
  'attempt_count',
  'available_at',
  'created_at',
  'updated_at',
  'lease_owner',
  'lease_expires_at',
  'last_failure_code',
  'last_failure_reason',
];

/** The same columns, unqualified, for a statement with a single table in scope. */
const OUTBOX_COLUMNS = OUTBOX_COLUMN_NAMES.join(', ');

/**
 * The same columns qualified with the claim's target alias.
 *
 * The claim's `FROM due` puts the CTE in scope, and the CTE selects `id`, so a
 * bare `RETURNING id` there is ambiguous and PostgreSQL refuses the whole
 * statement. Qualifying is what keeps the claim one statement.
 */
const CLAIMED_OUTBOX_COLUMNS = OUTBOX_COLUMN_NAMES.map((name) => `claimed.${name}`).join(', ');

/**
 * The claim, in one statement.
 *
 * The CTE's predicate is `channelOutboxClaimRefusal` written out:
 * `status = 'pending'` (`not_pending`), `attempt_count < $max`
 * (`attempts_exhausted`), no live lease (`lease_held`), `available_at <= now`
 * (`not_due`). An *expired* lease passes, which is the recovery path.
 *
 * `ORDER BY available_at, id` offers the oldest due work first and makes the
 * order total, so two Workers claiming concurrently take different rows rather
 * than racing on one. `SKIP LOCKED` is what turns that into a lock rather than a
 * queue: a row another Worker is claiming right now is passed over instead of
 * waited for, so a stuck claimant cannot stall its siblings.
 */
const CLAIM_DUE_SQL = `
WITH due AS (
  SELECT id FROM channel_outbox
   WHERE status = 'pending'
     AND attempt_count < $4
     AND available_at <= $2
     AND (lease_expires_at IS NULL OR lease_expires_at <= $2)
   ORDER BY available_at, id
   FOR UPDATE SKIP LOCKED
   LIMIT $5
)
UPDATE channel_outbox AS claimed
   SET attempt_count = claimed.attempt_count + 1,
       lease_owner = $1,
       lease_expires_at = $3,
       updated_at = $2
  FROM due
 WHERE claimed.id = due.id
RETURNING ${CLAIMED_OUTBOX_COLUMNS}`;

/** Platform-authored reason for an entry abandoned by the exhaustion sweep. */
const EXHAUSTED_RECOVERY_REASON = `the outbox entry spent its ${CHANNEL_OUTBOX_MAX_ATTEMPTS} dispatch attempts without a recorded outcome`;

/** Durable outbox store backed by the Worker-owned PostgreSQL pool. */
export class PostgresOutboxRepository implements OutboxRepository {
  /**
   * @param database - The Worker-owned connection pool.
   */
  constructor(private readonly database: WorkerDatabase) {}

  /** @inheritdoc */
  async claimDue(
    owner: string,
    now: string,
    limit: number,
  ): Promise<ReadonlyArray<ChannelOutboxLeaseRecord>> {
    assertOwner(owner);
    const rows = await this.database.rows(CLAIM_DUE_SQL, [
      owner,
      now,
      // The lease length is Core's, not this adapter's: a Worker and an operator
      // reading the row must agree on how long a claim lasts.
      new Date(Date.parse(now) + CHANNEL_OUTBOX_LEASE_MS).toISOString(),
      CHANNEL_OUTBOX_MAX_ATTEMPTS,
      Math.max(0, Math.trunc(limit)),
    ]);
    return rows.map(toOutboxLease);
  }

  /**
   * @inheritdoc
   *
   * One statement, deliberately. Every pending entry whose budget is spent and
   * whose lease is not live is abandoned at once — including the entry a Worker
   * claimed as its last attempt and then died on, which would otherwise be
   * pending and permanently unclaimable. A live lease is excluded so a healthy
   * Worker's final in-flight attempt is not swept out from under it.
   *
   * The failure code and reason are only filled in when the row has none: an
   * entry released normally already carries the attempt's own diagnostics, and
   * overwriting them would lose the reason it failed.
   */
  async sweepExhausted(now: string): Promise<number> {
    const rows = await this.database.rows(
      `UPDATE channel_outbox
          SET status = 'abandoned',
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_failure_code = COALESCE(last_failure_code, 'channel_delivery_unknown'),
              last_failure_reason = COALESCE(last_failure_reason, $3),
              updated_at = $1
        WHERE status = 'pending'
          AND attempt_count >= $2
          AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
        RETURNING id`,
      [now, CHANNEL_OUTBOX_MAX_ATTEMPTS, EXHAUSTED_RECOVERY_REASON],
    );
    return rows.length;
  }

  /**
   * @inheritdoc
   *
   * One statement, and the `WHERE` carries the whole decision: `status =
   * 'pending' AND lease_owner = $owner`. A Worker whose lease lapsed while it was
   * preparing has had `lease_owner` overwritten by whoever claimed the entry next,
   * so this update matches nothing and it learns to stop — it must not be able to
   * re-take a claim it lost, which is why the renewal is compare-by-owner rather
   * than compare-by-expiry.
   *
   * The expiry is set from `now`, not extended from the stored value, so the
   * caller gets a full lease to make the bounded provider call inside.
   */
  async renewOutboxLease(
    record: ChannelOutboxLeaseRecord,
    owner: string,
    now: string,
  ): Promise<ChannelOutboxLeaseRecord | undefined> {
    assertOwner(owner);
    const rows = await this.database.rows(
      `UPDATE channel_outbox
          SET lease_expires_at = $4, updated_at = $3
        WHERE tenant_id = $1 AND id = $2
          AND status = 'pending' AND lease_owner = $5
        RETURNING ${OUTBOX_COLUMNS}`,
      [
        record.tenantId,
        record.id,
        now,
        new Date(Date.parse(now) + CHANNEL_OUTBOX_LEASE_MS).toISOString(),
        owner,
      ],
    );
    return rows[0] === undefined ? undefined : toOutboxLease(rows[0]);
  }

  /** @inheritdoc */
  async completeOutbox(
    record: ChannelOutboxLeaseRecord,
    owner: string,
    now: string,
  ): Promise<boolean> {
    assertOwner(owner);
    const rows = await this.database.rows(
      `UPDATE channel_outbox
          SET status = 'dispatched',
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_failure_code = NULL,
              last_failure_reason = NULL,
              updated_at = $3
        WHERE tenant_id = $1 AND id = $2
          AND status = 'pending' AND lease_owner = $4
        RETURNING id`,
      [record.tenantId, record.id, now, owner],
    );
    return rows.length > 0;
  }

  /**
   * @inheritdoc
   *
   * The reschedule and the abandon are one statement, not a read followed by a
   * decision: `CASE WHEN attempt_count >= $max` mirrors
   * `releaseChannelOutboxAttempt`, which abandons in the same step that would
   * otherwise reschedule. The schedule itself is Core's `outboxRetryDelayMs`
   * evaluated against the record the claim returned — the attempt the claim just
   * spent is therefore included in the exponent, exactly as if the release had
   * been computed in memory.
   */
  async releaseOutbox(
    record: ChannelOutboxLeaseRecord,
    owner: string,
    failure: OutboxFailure,
    now: string,
  ): Promise<ChannelOutboxLeaseRecord | undefined> {
    assertOwner(owner);
    const nextAvailableAt = new Date(
      Date.parse(now) + outboxRetryDelayMs(record.attemptCount),
    ).toISOString();
    const rows = await this.database.rows(
      `UPDATE channel_outbox
          SET status = CASE WHEN attempt_count >= $5 THEN 'abandoned' ELSE 'pending' END,
              available_at = CASE WHEN attempt_count >= $5 THEN available_at ELSE $4 END,
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_failure_code = $6,
              last_failure_reason = $7,
              updated_at = $3
        WHERE tenant_id = $1 AND id = $2
          AND status = 'pending' AND lease_owner = $8
        RETURNING ${OUTBOX_COLUMNS}`,
      [
        record.tenantId,
        record.id,
        now,
        nextAvailableAt,
        CHANNEL_OUTBOX_MAX_ATTEMPTS,
        failure.code,
        failure.reason,
        owner,
      ],
    );
    return rows[0] === undefined ? undefined : toOutboxLease(rows[0]);
  }

  /** @inheritdoc */
  async abandonOutbox(
    record: ChannelOutboxLeaseRecord,
    owner: string,
    failure: OutboxFailure,
    now: string,
  ): Promise<boolean> {
    assertOwner(owner);
    const rows = await this.database.rows(
      `UPDATE channel_outbox
          SET status = 'abandoned',
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_failure_code = $4,
              last_failure_reason = $5,
              updated_at = $3
        WHERE tenant_id = $1 AND id = $2
          AND status = 'pending' AND lease_owner = $6
        RETURNING id`,
      [record.tenantId, record.id, now, failure.code, failure.reason, owner],
    );
    return rows.length > 0;
  }

  /** @inheritdoc */
  async getDelivery(tenantId: string, deliveryId: string): Promise<MessageDelivery | undefined> {
    const rows = await this.database.rows(
      `SELECT ${DELIVERY_COLUMNS} FROM message_deliveries WHERE tenant_id = $1 AND id = $2`,
      [tenantId, deliveryId],
    );
    return rows[0] === undefined ? undefined : toDelivery(rows[0]);
  }

  /** @inheritdoc */
  async getMessage(tenantId: string, messageId: string): Promise<OutboxMessage | undefined> {
    const rows = await this.database.rows(
      `SELECT id, tenant_id, message_type, content FROM messages
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, messageId],
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      id: toText(row['id']),
      tenantId: toText(row['tenant_id']),
      messageType: toMessageType(row['message_type']),
      content: toText(row['content']),
    };
  }

  /** @inheritdoc */
  async getQuotaWindow(key: QuotaWindowKey): Promise<SendQuotaWindow | undefined> {
    const rows = await this.database.rows(
      `SELECT * FROM send_quota_windows
        WHERE tenant_id = $1 AND store_id = $2 AND channel = $3 AND external_customer_id = $4`,
      [key.tenantId, key.storeId, key.channel, key.externalCustomerId],
    );
    return rows[0] === undefined ? undefined : toQuotaWindow(rows[0]);
  }

  /**
   * @inheritdoc
   *
   * `FOR UPDATE` on the window row is what makes the decision and the increment
   * one step, and `evaluateDeliveryWindow` is the same Core function the API's
   * store and the in-process adapter call — so a Worker and an API replica
   * cannot disagree about whether a message may be sent.
   */
  async reserveQuotaSlot(key: QuotaWindowKey, now: string): Promise<QuotaReservation> {
    return this.database.transaction(async (client) => {
      const rows = await statement(
        client,
        `SELECT * FROM send_quota_windows
          WHERE tenant_id = $1 AND store_id = $2 AND channel = $3 AND external_customer_id = $4
          FOR UPDATE`,
        [key.tenantId, key.storeId, key.channel, key.externalCustomerId],
      );
      const decision = evaluateDeliveryWindow(
        rows[0] === undefined ? undefined : toQuotaWindow(rows[0]),
        now,
      );
      if (!decision.allowed) {
        return { ok: false, code: decision.code, reason: decision.reason };
      }
      const updated = await statement(
        client,
        `UPDATE send_quota_windows
            SET reserved_count = reserved_count + 1, updated_at = $2
          WHERE tenant_id = $1 AND id = $3
          RETURNING *`,
        [key.tenantId, now, decision.window.id],
      );
      const row = updated[0];
      if (row === undefined) {
        throw new Error('outbox invariant: the reserved window disappeared');
      }
      return { ok: true, window: toQuotaWindow(row) };
    });
  }

  /**
   * @inheritdoc
   *
   * The count never goes below zero: a definite failure that raced with a window
   * reset releases a slot the reset already returned, and refusing that would
   * fail a whole delivery over a bookkeeping detail.
   */
  async releaseQuotaSlot(key: QuotaWindowKey, now: string): Promise<void> {
    await this.database.rows(
      `UPDATE send_quota_windows
          SET reserved_count = GREATEST(reserved_count - 1, 0), updated_at = $5
        WHERE tenant_id = $1 AND store_id = $2 AND channel = $3 AND external_customer_id = $4`,
      [key.tenantId, key.storeId, key.channel, key.externalCustomerId, now],
    );
  }

  /**
   * @inheritdoc
   *
   * The delivery row is locked, so two concurrent attempts on one delivery get
   * consecutive attempt numbers instead of colliding on the unique index — and
   * the *delivery's* status only moves when `advancesDeliveryStatus` allows it.
   * The attempt row is written either way: the attempt happened, and the history
   * is immutable. What the guard protects is the projection — a late attempt
   * that observed a failure must never drag a delivery the provider has already
   * accepted back out of `sent`, because that would re-offer a retry for a
   * message the customer already received.
   */
  async appendProviderAttempt(input: ProviderAttemptInput): Promise<ProviderAttemptRecord> {
    return this.database.transaction(async (client) => {
      const delivery = await lockDelivery(client, input.tenantId, input.deliveryId);
      const attemptNumber = delivery.attemptCount + 1;
      const attemptRows = await statement(
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
      const attemptRow = attemptRows[0];
      if (attemptRow === undefined) {
        throw new Error('outbox invariant: the appended attempt returned no row');
      }

      const nextStatus = advancesDeliveryStatus(delivery.status, input.status)
        ? input.status
        : delivery.status;
      const deliveryRows = await statement(
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
          nextStatus,
          input.externalMessageId,
          attemptNumber,
          input.failureCode,
          input.failureReason,
          input.retryable,
          input.now,
        ],
      );
      const deliveryRow = deliveryRows[0];
      if (deliveryRow === undefined) {
        throw new Error('outbox invariant: the updated delivery returned no row');
      }
      return { attempt: toAttempt(attemptRow), delivery: toDelivery(deliveryRow) };
    });
  }

  /**
   * @inheritdoc
   *
   * `status <> 'sent'` is the monotonicity guard. The window refusals are decided
   * before any provider call, so this writes no attempt row — but it must still
   * not be able to rewind a delivery the provider has already accepted, which a
   * plain `UPDATE` could do if a status callback landed between the claim and
   * this statement.
   */
  async recordDegradation(input: {
    readonly tenantId: string;
    readonly deliveryId: string;
    readonly failureCode: DeliveryFailureCode;
    readonly failureReason: string;
    readonly retryable: boolean;
    readonly now: string;
  }): Promise<MessageDelivery | undefined> {
    const rows = await this.database.rows(
      `UPDATE message_deliveries
          SET status = 'pending', failure_code = $3, failure_reason = $4,
              retryable = $5, updated_at = $6
        WHERE tenant_id = $1 AND id = $2 AND status <> 'sent'
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
    return rows[0] === undefined ? undefined : toDelivery(rows[0]);
  }
}

/** Reject an empty lease owner, which would make ownership unverifiable. */
function assertOwner(owner: string): void {
  if (owner.trim().length === 0) {
    throw new Error('outbox invariant: a lease owner must not be empty');
  }
}

/** Run one parameterised statement on a transaction connection. */
async function statement(
  client: PoolClient,
  text: string,
  values: ReadonlyArray<unknown> = [],
): Promise<ReadonlyArray<QueryResultRow>> {
  const result = await client.query(text, [...values]);
  return result.rows as ReadonlyArray<QueryResultRow>;
}

/** Lock and read one delivery inside a transaction, or fail the invariant. */
async function lockDelivery(
  client: PoolClient,
  tenantId: string,
  deliveryId: string,
): Promise<MessageDelivery> {
  const rows = await statement(
    client,
    `SELECT ${DELIVERY_COLUMNS} FROM message_deliveries
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE`,
    [tenantId, deliveryId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('outbox invariant: delivery not found in tenant scope');
  }
  return toDelivery(row);
}

/** Row-to-domain mapping for one outbox entry, including its claim state. */
function toOutboxLease(row: QueryResultRow): ChannelOutboxLeaseRecord {
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
    leaseOwner: toTextOrNull(row['lease_owner']),
    leaseExpiresAt: toIsoOrNull(row['lease_expires_at']),
    lastFailureCode: toFailureCode(row['last_failure_code']),
    lastFailureReason: toTextOrNull(row['last_failure_reason']),
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

/** Read an outbox status column, defaulting to `pending`. */
function toOutboxStatus(value: unknown): ChannelOutboxLeaseRecord['status'] {
  return value === 'dispatched' || value === 'abandoned' ? value : 'pending';
}

/** Read a delivery status column, defaulting to `pending`. */
function toDeliveryStatus(value: unknown): MessageDelivery['status'] {
  return value === 'sent' || value === 'failed' || value === 'unknown' ? value : 'pending';
}

/** Read a nullable failure code column, keeping only codes the domain knows. */
function toFailureCode(value: unknown): DeliveryFailureCode | null {
  const text = toTextOrNull(value);
  return text !== null && isDeliveryFailureCode(text) ? text : null;
}

/** Read a message-type column, defaulting to `text`. */
function toMessageType(value: unknown): MessageType {
  return value === 'image' || value === 'link' ? value : 'text';
}
