/**
 * The export queue and its sources, in SQL.
 *
 * Every statement here is scoped by the job's own `tenant_id`, which comes from
 * the row rather than from the caller: the Worker serves every tenant, so the job
 * is the only thing that says whose data may be read — and a query that took the
 * tenant from anywhere else could be pointed at another tenant's conversation by
 * a payload.
 *
 * **This file's customer aggregate is the API's aggregate, re-said.**
 * `apps/api/src/exports/exports.service.ts` runs the same `DISTINCT ON` for the
 * page. The duplication is deliberate and bounded: the row is mapped by one
 * shared function (`toCustomerSummary` in `@kefu/core`), and the two queries
 * differ in exactly the thing that should differ — the page is limited to
 * `CUSTOMER_PAGE_LIMIT` and ordered for reading, while the export is limited to
 * `EXPORT_CUSTOMER_LIMIT + 1` so the renderer can *refuse* an export over the cap
 * instead of silently truncating it. A single shared query would have to carry
 * both callers' limits and would answer neither question plainly.
 */

import {
  EXPORT_CUSTOMER_LIMIT,
  EXPORT_JOB_KIND,
  EXPORT_MESSAGE_LIMIT,
  channelDisplayName,
  customerNickname,
  likeContainsPattern,
  readExportJobPayload,
  toCustomerSummary,
  type CustomerRow,
  type TranscriptMessage,
} from '@kefu/core';
import type { QueryResultRow } from 'pg';
import type { WorkerDatabase } from '../database/worker-database';
import {
  toIso,
  toNumber,
  toText,
  toTextOrNull,
} from '../database/row-values';
import type {
  ArtifactWrite,
  ClaimedExportJob,
  ExportJobRepository,
  ExportSource,
} from './export-job-repository';

/** The durable export queue. */
export class PostgresExportJobRepository implements ExportJobRepository {
  /**
   * @param db - The Worker-owned pool.
   */
  constructor(private readonly db: WorkerDatabase) {}

  /**
   * @inheritdoc
   *
   * The batch is chosen in a `MATERIALIZED` CTE rather than in the `UPDATE`'s
   * `WHERE … IN (SELECT … LIMIT n)`, and the reason is not style. Written as a
   * direct sub-select, the planner is free to run the inner `LIMIT` as a semi-join
   * subplan that is re-scanned once per candidate row — and each rescan re-reads a
   * `jobs` table that this same command is in the middle of updating, so the batch
   * can grow behind the `LIMIT`. That is a claim of *more than `limit` rows*, which
   * means more than one Worker loop holding the same job. Materialising the batch
   * first fixes its membership before any row is touched, so the statement cannot
   * return more rows than asked for whatever plan the planner picks.
   */
  async claimDue(now: string, limit: number): Promise<ReadonlyArray<ClaimedExportJob>> {
    const rows = await this.db.rows(
      `
      WITH batch AS MATERIALIZED (
        SELECT id
        FROM jobs
        WHERE kind = $3 AND status = 'pending'
        ORDER BY created_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs
      SET status = 'running', started_at = $1::timestamptz, updated_at = $1::timestamptz
      WHERE id IN (SELECT id FROM batch)
      RETURNING id, tenant_id, payload, created_at
      `,
      [now, Math.max(0, Math.trunc(limit)), EXPORT_JOB_KIND],
    );
    return rows.map(toClaimedJob);
  }

  /** @inheritdoc */
  async reclaimStale(now: string, leaseMs: number): Promise<number> {
    const result = await this.db.query(
      `
      UPDATE jobs
      SET status = 'pending', started_at = NULL, updated_at = $1::timestamptz
      WHERE kind = $3
        AND status = 'running'
        AND started_at IS NOT NULL
        AND started_at < ($1::timestamptz - ($2::int * INTERVAL '1 millisecond'))
      `,
      [now, Math.max(0, Math.trunc(leaseMs)), EXPORT_JOB_KIND],
    );
    return result.rowCount ?? 0;
  }

  /** @inheritdoc */
  async readSource(job: ClaimedExportJob): Promise<ExportSource | null> {
    if (job.request === null) {
      // The processor refuses such a job before it asks for a source.
      return null;
    }
    return job.request.scope === 'conversation'
      ? this.#readConversation(job.tenantId, job.request.conversationId)
      : this.#readCustomers(job.tenantId, job.request.filter);
  }

  /** @inheritdoc */
  async recordSuccess(
    jobId: string,
    artifacts: ReadonlyArray<ArtifactWrite>,
    rowCount: number,
    now: string,
  ): Promise<void> {
    await this.db.transaction(async (client) => {
      for (const artifact of artifacts) {
        await client.query(
          `
          INSERT INTO job_artifacts
            (job_id, format, file_name, content_type, bytes, byte_count, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
          ON CONFLICT (job_id, format) DO UPDATE
          SET file_name = EXCLUDED.file_name,
              content_type = EXCLUDED.content_type,
              bytes = EXCLUDED.bytes,
              byte_count = EXCLUDED.byte_count,
              created_at = EXCLUDED.created_at
          `,
          [
            jobId,
            artifact.format,
            artifact.fileName,
            artifact.contentType,
            artifact.bytes,
            artifact.bytes.byteLength,
            now,
          ],
        );
      }
      await client.query(
        `
        UPDATE jobs
        SET status = 'succeeded',
            result = $2::jsonb,
            error = NULL,
            finished_at = $3::timestamptz,
            updated_at = $3::timestamptz
        WHERE id = $1
        `,
        [jobId, JSON.stringify({ rowCount }), now],
      );
    });
  }

  /** @inheritdoc */
  async recordFailure(jobId: string, error: string, now: string): Promise<void> {
    await this.db.query(
      `
      UPDATE jobs
      SET status = 'failed',
          error = $2,
          finished_at = $3::timestamptz,
          updated_at = $3::timestamptz
      WHERE id = $1
      `,
      [jobId, error, now],
    );
  }

  /**
   * One customer's conversation, as one transcript section.
   *
   * Two reads rather than one join: the heading is a fact about the conversation,
   * not about its messages, and joining it would repeat it on every row.
   *
   * @param tenantId - The job's tenant.
   * @param conversationId - The conversation to read.
   * @returns The source, or `null` when the conversation is gone.
   */
  async #readConversation(tenantId: string, conversationId: string): Promise<ExportSource | null> {
    const conversation = await this.db.rows(
      `
      SELECT title, external_customer_id, channel
      FROM conversations
      WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, conversationId],
    );
    const row = conversation[0];
    if (row === undefined) {
      return null;
    }

    // One row more than the cap: the renderer needs to be able to tell "exactly
    // at the cap" from "over it", because a transcript that stops in the middle
    // reads like a conversation that ended there.
    const messages = await this.db.rows(
      `
      SELECT direction, content, created_at
      FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2
      ORDER BY created_at, id
      LIMIT $3
      `,
      [tenantId, conversationId, EXPORT_MESSAGE_LIMIT + 1],
    );

    const nickname = customerNickname(toTextOrNull(row['title']), toText(row['external_customer_id']));
    return {
      scope: 'conversation',
      sections: [
        {
          heading: `${nickname} · ${channelDisplayName(toText(row['channel']))}`,
          messages: messages.map(toTranscriptMessage),
        },
      ],
    };
  }

  /**
   * Every customer a filter names, capped one row over the export limit.
   *
   * @param tenantId - The job's tenant.
   * @param filter - The stored filter, already normalised.
   * @returns The customers.
   */
  async #readCustomers(
    tenantId: string,
    filter: {
      readonly query: string | null;
      readonly from: string | null;
      readonly to: string | null;
    },
  ): Promise<ExportSource> {
    const rows = await this.db.rows(
      `
      SELECT ranked.channel,
             ranked.external_customer_id,
             ranked.title,
             ranked.last_message_at,
             ranked.last_conversation_id,
             ranked.conversation_count
      FROM (
        SELECT DISTINCT ON (channel, external_customer_id)
               channel,
               external_customer_id,
               title,
               last_message_at,
               id AS last_conversation_id,
               count(*) OVER (PARTITION BY channel, external_customer_id) AS conversation_count
        FROM conversations
        WHERE tenant_id = $1
          AND ($2::timestamptz IS NULL OR last_message_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR last_message_at <= $3::timestamptz)
          AND (
            $4::text IS NULL
            OR external_customer_id ILIKE $4::text ESCAPE '\\'
            OR title ILIKE $4::text ESCAPE '\\'
          )
        ORDER BY channel, external_customer_id, last_message_at DESC, id DESC
      ) ranked
      ORDER BY ranked.last_message_at DESC, ranked.external_customer_id
      LIMIT $5
      `,
      [
        tenantId,
        filter.from,
        filter.to,
        filter.query === null ? null : likeContainsPattern(filter.query),
        EXPORT_CUSTOMER_LIMIT + 1,
      ],
    );
    return {
      scope: 'customers',
      customers: rows.map((row) =>
        toCustomerSummary({
          channel: toText(row['channel']),
          external_customer_id: toText(row['external_customer_id']),
          title: toTextOrNull(row['title']),
          last_message_at: toIso(row['last_message_at']),
          last_conversation_id: toText(row['last_conversation_id']),
          conversation_count: toNumber(row['conversation_count']),
        } satisfies CustomerRow),
      ),
    };
  }
}

/**
 * Read one claimed row as a {@link ClaimedExportJob}.
 *
 * The payload is read by `@kefu/core`, the same module that wrote it. A payload
 * that cannot be read becomes `request: null` rather than a guess: the processor
 * fails that job with a reason, which the operator can see, instead of rendering
 * the wrong export, which nobody can.
 *
 * @param row - The claimed row.
 * @returns The job.
 */
function toClaimedJob(row: QueryResultRow): ClaimedExportJob {
  const payload = readExportJobPayload(row['payload']);
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    scope: payload?.scope ?? 'conversation',
    label: payload?.label ?? toText(row['id']),
    createdAt: toIso(row['created_at']),
    request:
      payload === null
        ? null
        : payload.scope === 'conversation'
          ? { scope: 'conversation', conversationId: payload.conversationId }
          : { scope: 'customers', filter: payload.filter },
  };
}

/**
 * Read one message row as a transcript line.
 *
 * **Who spoke is only ever 顾客 or 客服.** The platform records a message's
 * *direction* and never which agent sent it — `messages` has no author column —
 * so naming the conversation's current assignee here would credit an agent's
 * words to whoever holds the conversation now, which after a transfer is a
 * different person.
 *
 * @param row - The message row.
 * @returns The line.
 */
function toTranscriptMessage(row: QueryResultRow): TranscriptMessage {
  return {
    occurredAt: toIso(row['created_at']),
    speaker: toText(row['direction']) === 'inbound' ? '顾客' : '客服',
    content: toText(row['content']),
  };
}
