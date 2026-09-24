/**
 * The export loop: claim queued exports, render their files, write the outcome.
 *
 * Shaped like the other two loops in this process (claim, work, write back, come
 * back later) because the queue is durable and more than one Worker may be running
 * it. What is different is the failure model: a delivery may be retried by the
 * platform for hours, while an export is a person waiting for a file. So a job
 * that fails is written down as failed *with its reason*, and it is not retried —
 * the operator sees "会话已被删除" or "超过上限" in the task list and can act on it,
 * which is more useful than a task that quietly keeps trying.
 *
 * The loop itself is deliberately bare: a repository, a clock and a logger. It
 * holds no database handle and no pool, so nothing here can open a transaction —
 * rendering happens entirely in memory, and only the finished bytes are handed to
 * the store. That keeps the two slow things (reading a large export and writing
 * its files) from ever running inside a lock.
 *
 * **A failure of one job never becomes a failure of the tick.** Every job's
 * rendering is isolated, and a tick's own failure — the database is unreachable,
 * the claim statement failed — is logged and retried on the next poll, because a
 * failed claim claimed nothing and therefore stranded nothing.
 */

import type { ClaimedExportJob, ExportJobRepository } from './export-job-repository';
import { ExportTooLargeError, buildExportArtifacts } from './export-artifacts';

/** The structured logger shape the loop writes through. */
export type ExportLogger = {
  logStructured(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string,
    fields: Readonly<Record<string, unknown>>,
    context?: string,
  ): void;
};

/** Options for {@link ExportProcessor}. */
export type ExportProcessorOptions = {
  /** How many jobs one tick may claim. */
  readonly batchSize: number;
  /** How long to wait between polls when the queue is empty. */
  readonly pollIntervalMs: number;
  /**
   * How long a claimed job may stay `running` before a Worker presumes its
   * claimant is gone and puts it back in the queue.
   */
  readonly leaseMs: number;
  /** Injectable clock, so a test controls the lease arithmetic. */
  readonly now?: () => number;
  readonly logger?: ExportLogger;
};

/**
 * What one tick did.
 *
 * `claimed` is what the queue handed over; the other three count what was
 * *written*. A job whose failure could not be written down (the database went
 * away mid-tick) is counted nowhere: it stays `running` until the lease returns it
 * to the queue, and reporting it as `failed` here would be a claim about a row
 * this tick did not manage to change.
 */
export type ExportTickResult = {
  /** Jobs the claim handed to this Worker. */
  readonly claimed: number;
  /** Jobs whose files were stored and which are now `succeeded`. */
  readonly succeeded: number;
  /** Jobs written down as `failed`, with a reason. */
  readonly failed: number;
  /** Jobs a dead Worker had left `running`, returned to the queue by this tick. */
  readonly reclaimed: number;
};

/** The tick's answer when one is already running. */
function emptyTick(): ExportTickResult {
  return { claimed: 0, succeeded: 0, failed: 0, reclaimed: 0 };
}

/**
 * The longest reason stored on a failed job.
 *
 * The column is displayed in a task list, and a driver error can run to
 * paragraphs. Truncation is visible (`…`) so nobody reads a cut-off sentence as a
 * complete one.
 */
const MAX_ERROR_LENGTH = 300;

/** Claims due exports, renders them, and records what happened. */
export class ExportProcessor {
  readonly #now: () => number;
  readonly #logger: ExportLogger;
  #running = false;
  #ticking = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wake: (() => void) | null = null;
  #inFlight: Promise<void> | null = null;
  /**
   * Which loop is the current one.
   *
   * `#running` alone cannot tell a loop that a `start()` has already replaced
   * from the one that should keep polling; without the counter, a Worker stopped
   * and started again could end up with two loops claiming from one queue, and the
   * `stop()` would be waiting on a loop that will never return.
   */
  #generation = 0;

  /**
   * @param repository - The durable queue and its sources.
   * @param options - Batch bound, poll interval, lease, clock and logger.
   */
  constructor(
    private readonly repository: ExportJobRepository,
    private readonly options: ExportProcessorOptions,
  ) {
    this.#now = options.now ?? (() => Date.now());
    this.#logger = options.logger ?? { logStructured: () => undefined };
  }

  /** Whether the loop is currently scheduled to keep polling. */
  get running(): boolean {
    return this.#running;
  }

  /**
   * Start polling.
   *
   * Idempotent, and the first tick starts immediately: a job queued while the
   * Worker was down should be picked up at boot rather than after a poll interval.
   */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#inFlight = this.#loop((this.#generation += 1));
  }

  /**
   * Stop polling and wait for the tick in flight to finish.
   *
   * A tick is never cut in half: the claim has already moved jobs to `running`, and
   * stopping between the claim and the write-back would leave work that only the
   * lease could recover. Idempotent.
   */
  async stop(): Promise<void> {
    const inFlight = this.#inFlight;
    this.#running = false;
    this.#generation += 1;
    this.#endWait();
    await inFlight;
    if (this.#inFlight === inFlight) {
      this.#inFlight = null;
    }
  }

  /**
   * Run exactly one bounded tick.
   *
   * Refuses to run concurrently with itself, so a manual call — a test, an
   * operator's one-shot tool — cannot overlap the loop.
   *
   * @returns What the tick did, or the empty tick when one is already running.
   */
  async runOnce(): Promise<ExportTickResult> {
    if (this.#ticking) {
      return emptyTick();
    }
    this.#ticking = true;
    try {
      return await this.#tick();
    } finally {
      this.#ticking = false;
    }
  }

  /** Poll until stopped, never overlapping two ticks. */
  async #loop(generation: number): Promise<void> {
    while (this.#isLive(generation)) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        this.#logger.logStructured(
          'error',
          'export tick failed; retrying after the poll interval',
          { error: errorName(error) },
          'ExportProcessor',
        );
      }
      if (!this.#isLive(generation)) {
        break;
      }
      await this.#sleep(this.options.pollIntervalMs);
    }
  }

  /**
   * One tick: return the abandoned, claim a bounded batch, render each job.
   *
   * Recovery runs before the claim so that a job returned to the queue in this
   * tick can be claimed in the same tick rather than waiting for the next one.
   */
  async #tick(): Promise<ExportTickResult> {
    const claimedAt = this.#instant();
    const reclaimed = await this.repository.reclaimStale(claimedAt, this.options.leaseMs);
    const jobs = await this.repository.claimDue(claimedAt, this.options.batchSize);

    let succeeded = 0;
    let failed = 0;
    for (const job of jobs) {
      if (await this.#render(job)) {
        succeeded += 1;
      } else {
        failed += 1;
      }
    }
    return { claimed: jobs.length, succeeded, failed, reclaimed };
  }

  /**
   * Render one job and write down what happened.
   *
   * @param job - The claimed job.
   * @returns Whether the job ended `succeeded`.
   */
  async #render(job: ClaimedExportJob): Promise<boolean> {
    if (job.request === null) {
      // The claim already moved this row to `running`, so leaving it alone would
      // show the operator a task that never finishes.
      return this.#fail(job, '任务内容无法读取，请重新发起导出');
    }

    try {
      const source = await this.repository.readSource(job);
      if (source === null) {
        return this.#fail(job, '这条会话已经不存在了');
      }
      const finishedAt = this.#instant();
      const built = await buildExportArtifacts(job, source, finishedAt);
      await this.repository.recordSuccess(job.id, built.artifacts, built.rowCount, finishedAt);
      this.#logger.logStructured(
        'info',
        'export job rendered',
        { job: job.id, scope: job.scope, rows: built.rowCount },
        'ExportProcessor',
      );
      return true;
    } catch (error: unknown) {
      return this.#fail(job, reasonFor(error));
    }
  }

  /**
   * Write a job down as failed.
   *
   * A failure to record the failure is rethrown: this is the one write that must
   * not disappear, and the tick's own handler is where "the database is gone" is
   * already logged and retried.
   *
   * @param job - The job.
   * @param reason - The reason, as the operator will read it.
   * @returns Always `false`, so callers can `return this.#fail(...)`.
   */
  async #fail(job: ClaimedExportJob, reason: string): Promise<false> {
    const failedAt = this.#instant();
    this.#logger.logStructured(
      'warn',
      'export job failed',
      { job: job.id, scope: job.scope, reason },
      'ExportProcessor',
    );
    await this.repository.recordFailure(job.id, reason, failedAt);
    return false;
  }

  /**
   * The current instant, ISO 8601.
   *
   * @returns The clock's reading.
   */
  #instant(): string {
    return new Date(this.#now()).toISOString();
  }

  /**
   * Whether the loop of this generation is still the one that should poll.
   *
   * @param generation - The loop's generation.
   * @returns Whether it is live.
   */
  #isLive(generation: number): boolean {
    return this.#running && generation === this.#generation;
  }

  /** Wait for the poll interval, or wake up early when the loop is stopped. */
  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#wake = resolve;
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#wake = null;
        resolve();
      }, ms);
      // A pending timer must not keep the process alive on its own: shutdown is
      // driven by the signal handler, which ends the wait explicitly.
      this.#timer.unref();
    });
  }

  /** End a pending poll wait immediately. */
  #endWait(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

/**
 * What a failed job's reason reads as in the task list.
 *
 * A cap refusal says exactly what it is — it is a sentence written for the
 * operator, and it names what to do next. Anything else is prefixed, because a
 * bare driver message ("relation does not exist") reads as the *operator's*
 * mistake, and truncated, because the column is one line in a table.
 *
 * @param error - The thrown value.
 * @returns The reason.
 */
export function reasonFor(error: unknown): string {
  if (error instanceof ExportTooLargeError) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  const reason = `导出失败：${message}`;
  return reason.length <= MAX_ERROR_LENGTH ? reason : `${reason.slice(0, MAX_ERROR_LENGTH)}…`;
}

/**
 * An error's name, for a log field.
 *
 * The name rather than the message: a driver error's message can hold the query
 * and its parameters, and the log is not the place for a tenant's data.
 *
 * @param error - The thrown value.
 * @returns The error's name.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
