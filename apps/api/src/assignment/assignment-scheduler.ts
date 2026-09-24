import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { JsonLogger } from '../logging/json-logger';
import { AssignmentService, type AssignmentSweepResult } from './assignment.service';

/** How often the dispatcher sweeps the pool. */
export const ASSIGNMENT_SWEEP_INTERVAL_MS = 5_000;

/**
 * Most conversations one sweep considers.
 *
 * A bound rather than a target: whatever is left over stays due, and the next
 * sweep picks it up, so the batch size trades sweep latency against how long one
 * transaction holds its rows.
 */
export const ASSIGNMENT_BATCH_SIZE = 20;

/**
 * Runs the automatic-assignment sweep on an interval.
 *
 * The loop mirrors the Worker's outbox processor: it owns one timer, never
 * overlaps two sweeps, and treats a failed sweep as something to log and retry
 * rather than something to die of — nothing is claimed for the duration of a
 * sweep, so a sweep that throws strands nothing.
 *
 * Started by `main.ts` rather than by its module, so a Nest context built in a
 * test binds the provider without a background loop starting underneath it.
 */
@Injectable()
export class AssignmentScheduler implements OnApplicationShutdown {
  #running = false;
  #sweeping = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wake: (() => void) | null = null;
  #inFlight: Promise<void> | null = null;

  /**
   * @param assignment - The assignment service whose sweep this drives.
   * @param logger - Structured logger for sweep outcomes and failures.
   */
  constructor(
    private readonly assignment: AssignmentService,
    private readonly logger: JsonLogger,
  ) {}

  /** Whether the loop is currently scheduled to keep sweeping. */
  get running(): boolean {
    return this.#running;
  }

  /**
   * Start sweeping.
   *
   * Idempotent, and the first sweep runs immediately so a pool that already has
   * a backlog does not wait a whole interval to be served.
   */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#inFlight = this.#loop();
  }

  /**
   * Stop sweeping and wait for the sweep in flight to finish.
   *
   * A sweep is never aborted half-way. It holds one transaction, so stopping
   * means letting that transaction reach its own commit or rollback; either
   * outcome leaves the pool consistent and the unfinished work due.
   *
   * Idempotent: a second call awaits the same in-flight sweep.
   */
  async stop(): Promise<void> {
    this.#running = false;
    this.#endWait();
    await this.#inFlight;
    this.#inFlight = null;
  }

  /**
   * Stop sweeping when the application shuts down.
   *
   * Reached through `enableShutdownHooks`, so the loop ends on the same signal
   * that stops the HTTP server instead of needing its own signal handler.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Run exactly one bounded sweep.
   *
   * Exposed so a test can drive the dispatcher deterministically instead of
   * waiting on a timer. Refuses to overlap the loop, so a manual call can never
   * run concurrently with a scheduled one.
   *
   * @param now - Instant to judge the sweep at (defaults to the wall clock).
   * @returns What the sweep did.
   */
  async runOnce(now: string = new Date().toISOString()): Promise<AssignmentSweepResult> {
    if (this.#sweeping) {
      return { assigned: [], fellBack: [], waiting: [], lost: [], failed: [] };
    }
    this.#sweeping = true;
    try {
      const result = await this.assignment.runOnce(now, ASSIGNMENT_BATCH_SIZE);
      this.#report(result);
      return result;
    } finally {
      this.#sweeping = false;
    }
  }

  /** Log a sweep, but only when it did something worth a line. */
  #report(result: AssignmentSweepResult): void {
    if (result.assigned.length > 0) {
      this.logger.logStructured(
        'info',
        'assigned pooled conversations',
        { count: result.assigned.length },
        'AssignmentScheduler',
      );
    }
    if (result.fellBack.length > 0) {
      this.logger.logStructured(
        'warn',
        'no agent was available; sent the offline reply',
        { count: result.fellBack.length },
        'AssignmentScheduler',
      );
    }
    // Only the count, never the ids: a delivery failure's cause can carry a
    // provider token, and a conversation id is customer-adjacent data.
    if (result.failed.length > 0) {
      this.logger.logStructured(
        'error',
        'could not hand an offline reply to the channel',
        { count: result.failed.length },
        'AssignmentScheduler',
      );
    }
  }

  /** Sweep until stopped, never overlapping two sweeps. */
  async #loop(): Promise<void> {
    while (this.#running) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        // Only the error's name: a driver failure can carry a connection string.
        this.logger.logStructured(
          'error',
          'assignment sweep failed; retrying after the sweep interval',
          { error: error instanceof Error ? error.name : typeof error },
          'AssignmentScheduler',
        );
      }
      if (!this.#running) {
        break;
      }
      await this.#sleep(ASSIGNMENT_SWEEP_INTERVAL_MS);
    }
  }

  /** Wait for the sweep interval, or wake up early when the loop is stopped. */
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

  /**
   * End a pending interval wait immediately.
   *
   * Without this, `stop()` would await a loop sleeping for a whole interval, so
   * shutdown would look like a hang for up to that long.
   */
  #endWait(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const wake = this.#wake;
    this.#wake = null;
    if (wake !== null) {
      wake();
    }
  }
}
