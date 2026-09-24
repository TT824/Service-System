import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CUSTOMER_PAGE_LIMIT,
  EXPORT_ARTIFACT_FORMATS,
  EXPORT_JOB_KIND,
  conversationExportLabel,
  customerExportLabel,
  customerNickname,
  exportJobPayload,
  likeContainsPattern,
  readExportJobPayload,
  toCustomerSummary,
  type CustomerFilter,
  type CustomerRow,
  type CustomerSummary,
  type ExportArtifactFormat,
  type ExportJobRecord,
  type ExportJobStatus,
  type ExportRequest,
} from '@kefu/core';
import { DatabaseService } from '../database/database.service';

/**
 * The customer list and the export job queue, read straight from PostgreSQL.
 *
 * **This module is PostgreSQL-only, and that is a decision rather than an
 * omission.** Every other read in the API can fall back to the in-process store
 * (`MemoryPlatformRepository`, the deterministic fixture the e2e suite runs
 * against) because what it returns is a handful of rows that exist in that
 * fixture. Here the answer *is* an aggregate over the whole tenant — "how many
 * conversations has this customer had, when was the last one" — and the jobs
 * themselves are durable work handed to a different process. A memory
 * implementation would have to re-implement the aggregation in JavaScript and
 * would then be a second definition of the same number, drifting from the SQL
 * that production actually runs. So there is one implementation, it speaks SQL,
 * and the suites that cover it are the ones that run against a real database.
 *
 * **Each process owns its own SQL.** The worker has its own reader for the same
 * tables (it renders the files); the two share the `@kefu/core` contracts —
 * {@link CustomerSummary}, {@link ExportJobRecord} — and nothing else. That is
 * deliberate: the API's customer query is shaped by what a *page* needs (a
 * bounded, ordered, filtered list), while the worker's is shaped by what an
 * *export* needs (every row, unbounded, with its messages). Forcing those into
 * one shared query would mean one caller carrying the other's limits.
 *
 * **What this service does not decide:** the payload's shape and the labels are
 * `@kefu/core`'s (`parseExportRequest`, `conversationExportLabel`), and the
 * files are the worker's. Here: does this conversation exist, what is this
 * customer called, and what rows go on the two lists.
 */
@Injectable()
export class ExportsService {
  /**
   * @param db - The API-owned pool. Injected globally by `DatabaseModule`.
   */
  constructor(private readonly db: DatabaseService) {}

  /**
   * One row per customer who has ever had a conversation with this tenant.
   *
   * The aggregation is `DISTINCT ON` plus a window count rather than `GROUP BY`
   * for one reason: the page needs the *latest* conversation's id (that is what
   * "export this customer's conversation" exports) and its title (that is the
   * name the row shows), and both are values of one specific row rather than
   * aggregate results. `DISTINCT ON` picks that row; `count(*) OVER` then has the
   * whole partition in hand before the duplicate is dropped, so the count is the
   * partition's size and not one.
   *
   * **Every number is scoped to the filter window.** A customer matched because
   * they wrote last week counts the conversations inside the window, and their
   * "last message" is the window's last message. Counting the tenant's entire
   * history while showing a filtered row would put a number next to a date that
   * does not add up.
   *
   * @param tenantId - The effective tenant scope.
   * @param filter - Parsed keyword and time range.
   * @returns The page's rows, most recently active first.
   */
  async listCustomers(
    tenantId: string,
    filter: CustomerFilter,
  ): Promise<ReadonlyArray<CustomerSummary>> {
    const result = await this.db.pool.query<CustomerRow>(
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
        CUSTOMER_PAGE_LIMIT,
      ],
    );
    return result.rows.map(toCustomerSummary);
  }

  /**
   * Queue an export.
   *
   * The row is written `pending` and nothing is rendered here: rendering is the
   * worker's, and an export that took a second to answer would make the console
   * wait on it. What this method does own is the fact the worker cannot recover
   * on its own — whether the conversation exists *for this tenant*. A job row
   * naming a conversation the tenant cannot read would fail in the worker as a
   * missing row, which the operator would see as a task that fails forever; the
   * refusal belongs at the request that asked for it.
   *
   * @param tenantId - The effective tenant scope.
   * @param request - Parsed export request (a conversation, or a customer filter).
   * @returns The queued job, as the console displays it.
   * @throws {NotFoundException} When the conversation is not in this tenant.
   */
  async createJob(tenantId: string, request: ExportRequest): Promise<ExportJobRecord> {
    const label =
      request.scope === 'conversation'
        ? conversationExportLabel(await this.requireConversationName(tenantId, request.conversationId))
        : customerExportLabel(request.filter);

    const id = `export-${randomUUID()}`;
    const now = new Date().toISOString();
    // The payload's shape belongs to `@kefu/core`, which both writes it here and
    // reads it in the worker: a job is queued by one process and rendered by
    // another, so the two may not each have their own idea of what it looks like.
    const payload = exportJobPayload(request, label);

    await this.db.pool.query(
      `
      INSERT INTO jobs (id, tenant_id, kind, status, payload, result, error, created_at, updated_at)
      VALUES ($1, $2, $3, 'pending', $4::jsonb, NULL, NULL, $5::timestamptz, $5::timestamptz)
      `,
      [id, tenantId, EXPORT_JOB_KIND, JSON.stringify(payload), now],
    );

    return {
      id,
      tenantId,
      scope: request.scope,
      label,
      status: 'pending',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      rowCount: null,
      error: null,
      artifacts: [],
    };
  }

  /**
   * This tenant's export jobs, newest first.
   *
   * Only `kind = 'export'`: `jobs` is the platform's general work table, and a
   * console page titled "export tasks" that listed other kinds of work would be
   * answering a different question.
   *
   * @param tenantId - The effective tenant scope.
   * @param limit - How many rows to return at most.
   * @returns The jobs, as the console displays them.
   */
  async listJobs(tenantId: string, limit: number): Promise<ReadonlyArray<ExportJobRecord>> {
    const result = await this.db.pool.query<JobRow>(
      `
      SELECT j.id,
             j.tenant_id,
             j.status,
             j.payload,
             j.result,
             j.error,
             j.created_at,
             j.started_at,
             j.finished_at,
             COALESCE(
               array_agg(a.format ORDER BY a.format) FILTER (WHERE a.format IS NOT NULL),
               ARRAY[]::text[]
             ) AS artifacts
      FROM jobs j
      LEFT JOIN job_artifacts a ON a.job_id = j.id
      WHERE j.tenant_id = $1 AND j.kind = $2
      GROUP BY j.id
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT $3
      `,
      [tenantId, EXPORT_JOB_KIND, limit],
    );
    return result.rows.map(toJobRecord);
  }

  /**
   * The bytes of one artifact, or `null` if this tenant has no such file.
   *
   * The tenant is joined through `jobs` rather than trusted from the URL: the
   * download link is guessable (job id plus a two-value format), so the lookup
   * has to be scoped by the caller's tenant or one tenant could read another's
   * transcript by knowing an id.
   *
   * @param tenantId - The effective tenant scope.
   * @param jobId - The job the artifact belongs to.
   * @param format - Which of the job's two artifacts.
   * @returns The file, or `null`.
   */
  async readArtifact(
    tenantId: string,
    jobId: string,
    format: ExportArtifactFormat,
  ): Promise<ArtifactBytes | null> {
    const result = await this.db.pool.query<ArtifactRow>(
      `
      SELECT a.bytes, a.file_name, a.content_type, a.byte_count
      FROM job_artifacts a
      JOIN jobs j ON j.id = a.job_id
      WHERE j.tenant_id = $1 AND j.id = $2 AND a.format = $3
      `,
      [tenantId, jobId, format],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      bytes: Buffer.from(row.bytes),
      fileName: row.file_name,
      contentType: row.content_type,
      byteCount: row.byte_count,
    };
  }

  /**
   * How this tenant's conversation is called.
   *
   * @param tenantId - The effective tenant scope.
   * @param conversationId - The conversation to name.
   * @returns The display name (the title, or the external customer id).
   * @throws {NotFoundException} When the conversation is not in this tenant.
   */
  private async requireConversationName(
    tenantId: string,
    conversationId: string,
  ): Promise<string> {
    const result = await this.db.pool.query<{ title: string | null; external_customer_id: string }>(
      `
      SELECT title, external_customer_id
      FROM conversations
      WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, conversationId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new NotFoundException('conversation not found');
    }
    return customerNickname(row.title, row.external_customer_id);
  }
}

/** A stored file, ready to be written to a response. */
export type ArtifactBytes = {
  readonly bytes: Buffer;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteCount: number;
};

/** A row of the job list, with its artifacts already aggregated. */
export type JobRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly status: string;
  readonly payload: unknown;
  readonly result: unknown;
  readonly error: string | null;
  readonly created_at: Date | string;
  readonly started_at: Date | string | null;
  readonly finished_at: Date | string | null;
  readonly artifacts: ReadonlyArray<string>;
};

/** A row of `job_artifacts`. */
export type ArtifactRow = {
  readonly bytes: Buffer;
  readonly file_name: string;
  readonly content_type: string;
  readonly byte_count: number;
};

/**
 * Read one job row as an {@link ExportJobRecord}.
 *
 * Both halves of the row are JSONB and both are read defensively: `payload` is
 * written by this service, but the table is the platform's general work table
 * and a row whose payload does not have the shape this page expects should show
 * up as a task with an unhelpful label rather than take the whole list down.
 *
 * @param row - The job row.
 * @returns The job, as the console displays it.
 */
export function toJobRecord(row: JobRow): ExportJobRecord {
  const payload = readExportJobPayload(row.payload);
  const result = asRecord(row.result);
  const rowCount = result['rowCount'];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    // A row whose payload cannot be read still belongs in the list: it is a task
    // that exists, and hiding it would leave the operator with an export that
    // never appears. `conversation` is the fallback because the two scopes differ
    // only in how the file is named and how the label reads.
    scope: payload?.scope ?? 'conversation',
    label: payload?.label ?? row.id,
    status: (row.status as ExportJobStatus) ?? 'pending',
    createdAt: instant(row.created_at),
    startedAt: row.started_at === null ? null : instant(row.started_at),
    finishedAt: row.finished_at === null ? null : instant(row.finished_at),
    rowCount: typeof rowCount === 'number' ? rowCount : null,
    error: row.error,
    // Ordered by the menu rather than by the aggregation, so the two download
    // entries come back in the order the console offers them.
    artifacts: EXPORT_ARTIFACT_FORMATS.filter((format) => row.artifacts.includes(format)),
  };
}

/**
 * Read a JSONB column as an object.
 *
 * @param value - The column's value, already parsed by `pg`, or anything else.
 * @returns The object, or an empty one.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Read a timestamp column as an ISO string.
 *
 * Against a real database the driver hands back a `Date`; the shape is accepted
 * either way so a spec that feeds a row straight from a fixture still exercises
 * the mapping rather than a crash.
 *
 * @param value - A timestamp column.
 * @returns ISO 8601.
 */
function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Whether a value is one of the two artifact formats. */
export function isArtifactFormat(value: string): value is ExportArtifactFormat {
  return (EXPORT_ARTIFACT_FORMATS as ReadonlyArray<string>).includes(value);
}

/** How many jobs one page of the export-task list holds. */
export const EXPORT_JOB_PAGE_LIMIT = 100;

/**
 * Refuse a request the core layer did not accept.
 *
 * The details go out as the thrown value's `message` array, which is the one
 * shape the global exception filter turns into a non-empty `details` (see
 * `AllExceptionsFilter#toErrorBody`) — so the console can show the operator every
 * problem at once instead of one per attempt.
 *
 * @param details - One line per problem.
 */
export function refuseWithDetails(details: ReadonlyArray<string>): never {
  throw new BadRequestException([...details]);
}
