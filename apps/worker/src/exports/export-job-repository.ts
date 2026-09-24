/**
 * The export loop's durable side: which jobs are due, what a job reads, and what
 * its result becomes in the tables.
 *
 * Three methods rather than one `run()` because the things a spec has to vary —
 * an empty queue, a stale claim, a conversation that was deleted between queueing
 * and rendering — are exactly the seams between them, and a fake that implements
 * one method has to re-implement the loop to say anything interesting.
 *
 * **The claim is what makes two workers safe.** `claimDue` selects and updates in
 * one statement with `FOR UPDATE SKIP LOCKED`, so a second Worker running the same
 * tick gets a disjoint set rather than the same job rendered twice. That is the
 * same shape the outbox and the index sweep use, and the reason is the same: the
 * queue lives in a table that more than one process reads.
 *
 * **A claimed job that was never written back is reclaimed, not retried
 * forever.** The Worker holds no lock between the claim and the write-back — it
 * renders files in memory — so a process killed mid-render leaves a row saying
 * `running` with nobody running it. {@link reclaimStale} is what turns that back
 * into work; see its own note for why re-rendering is harmless.
 */

import type {
  CustomerSummary,
  ExportArtifactFormat,
  ExportRequest,
  ExportScope,
  TranscriptSection,
} from '@kefu/core';

/**
 * One job the claim handed to this Worker.
 *
 * `request` is `null` when the stored payload cannot be read. The processor fails
 * such a job with a stated reason rather than skipping it: the claim already
 * moved the row to `running`, and a row nobody writes back is a task the console
 * shows as unfinished forever.
 */
export type ClaimedExportJob = {
  readonly id: string;
  readonly tenantId: string;
  readonly scope: ExportScope;
  readonly label: string;
  readonly createdAt: string;
  readonly request: ExportRequest | null;
};

/**
 * What one job reads to render its files.
 *
 * Two shapes rather than one because the two scopes export different things: a
 * conversation exports its messages, a customer filter exports its people. A
 * single "rows" type would have to be interpreted by the renderer anyway, and the
 * interpretation is the part that can be wrong.
 */
export type ExportSource =
  | { readonly scope: 'conversation'; readonly sections: ReadonlyArray<TranscriptSection> }
  | { readonly scope: 'customers'; readonly customers: ReadonlyArray<CustomerSummary> };

/** One file, ready to be stored. */
export type ArtifactWrite = {
  readonly format: ExportArtifactFormat;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Buffer;
};

/** The durable side of the export queue. */
export interface ExportJobRepository {
  /**
   * Claim up to `limit` pending export jobs and stamp them `running`.
   *
   * One statement, and that is the point: the selection and the status change
   * happen together, so no window exists in which two Workers both see the same
   * row as claimable.
   *
   * @param now - The tick's instant, written to `started_at`.
   * @param limit - How many jobs one tick may claim.
   * @returns The claimed jobs, oldest first.
   */
  claimDue(now: string, limit: number): Promise<ReadonlyArray<ClaimedExportJob>>;

  /**
   * Return jobs to the queue when the Worker that claimed them is gone.
   *
   * A job is `running` for as long as its render takes — well under a second for
   * anything this platform exports — so a row that has said `running` for
   * `leaseMs` is a row whose process died. It goes back to `pending` and is
   * claimed again.
   *
   * Re-rendering is deliberately harmless: the artifacts are keyed by
   * `(job_id, format)` and written as an upsert, and both renders read the same
   * rows and produce the same bytes, so a job that is somehow reclaimed while it
   * is still running ends up with one copy of a correct file rather than a
   * damaged one.
   *
   * @param now - The tick's instant, used for `updated_at`.
   * @param leaseMs - How long a `running` row may be before it is presumed dead.
   * @returns How many jobs went back to `pending`.
   */
  reclaimStale(now: string, leaseMs: number): Promise<number>;

  /**
   * Read everything one job exports.
   *
   * @param job - The claimed job, with its parsed request.
   * @returns The source, or `null` when the conversation no longer exists — a
   *   conversation can be deleted between the request that queued the job and the
   *   tick that renders it.
   */
  readSource(job: ClaimedExportJob): Promise<ExportSource | null>;

  /**
   * Store a job's files and mark it succeeded, in one transaction.
   *
   * Both halves together, because a job marked `succeeded` with no artifacts is a
   * task whose menu has nothing to download, and artifacts under a job that never
   * finished are files no reader will offer.
   *
   * @param jobId - The job.
   * @param artifacts - The files, one per format.
   * @param rowCount - How many rows went into them, for the console's reading.
   * @param now - The instant the job finished.
   */
  recordSuccess(
    jobId: string,
    artifacts: ReadonlyArray<ArtifactWrite>,
    rowCount: number,
    now: string,
  ): Promise<void>;

  /**
   * Mark a job failed and say why.
   *
   * The reason is stored rather than only logged: the console's task list is
   * where an operator finds out that an export did not happen, and "失败" with no
   * reason is a support ticket.
   *
   * @param jobId - The job.
   * @param error - The reason, already made safe to display.
   * @param now - The instant the job failed.
   */
  recordFailure(jobId: string, error: string, now: string): Promise<void>;
}
