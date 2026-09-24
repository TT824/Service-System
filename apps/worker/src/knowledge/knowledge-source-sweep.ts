/**
 * One pass of the source sweep: every tenant's knowledge sources, re-indexed.
 *
 * This is the loop that was missing. Until it existed, the whole index was
 * write-only in principle and empty in fact: the kernel, the state machine and
 * the writer were all built and tested, and no running process called them, so
 * `knowledge_chunks` stayed empty and retrieval had nothing to recall. The
 * embedding sweep (`chunk-index-processor`) is the *second* half of the same
 * pipeline — it embeds slices that this half produced — and the two are
 * deliberately separate: this one needs no model, so it runs whether or not one
 * is configured, which is why a tenant without an embedding provider still has a
 * complete, keyword-searchable index.
 *
 * Four decisions, and each of them is a decision not to do something clever:
 *
 * - **A pass reads everything, every time.** The port says why (see
 *   `index-source-reader`): the write path decides what to delete by comparing
 *   the slices a source produces now against the slices stored under it, so a
 *   read narrowed to "what changed" reports every unchanged slice as stale and
 *   deletes it. The cost is paid at the *write* end instead — a source whose text
 *   did not move is planned as `skip`/`attempt` and writes no content — and it is
 *   why the interval below is a whole minute rather than the delivery loop's
 *   second. A catalogue of a few thousand rows is a few thousand short reads, and
 *   making that interval smaller would not make an edit appear sooner; it would
 *   only make the sweep's own load the thing an operator notices.
 * - **No gate on configuration.** The embedding sweep claims nothing without a
 *   provider, because claiming spends an attempt it cannot pay for. This half
 *   spends nothing: a slice is written `pending` and waits, so there is no
 *   equivalent of that gate and no reason to copy it here.
 * - **One source at a time.** Each source's write is its own transaction
 *   (`writeSourceChunks`), and issuing thousands of them at once is how a
 *   background sweep becomes an outage for the API sharing the database. Serial
 *   is also what makes the counters below mean what they say.
 * - **A failure is counted, not thrown.** One tenant's read failing, or one
 *   source's write, must not abandon the other tenants: a single row that
 *   violates a constraint would otherwise stop the sweep at the same place on
 *   every pass and the tenant would never be indexed again. Failures are counted
 *   and reported with the *first* one's address — a database that is down fails
 *   every source, and a line per source is a log nobody can read — while a
 *   failure of the tenant *list* itself does propagate, because a pass that could
 *   not enumerate tenants has not failed at one source, it has failed to run.
 *
 * The loop around the pass is the shape the other two loops use, and on purpose:
 * `start` polls, `stop` waits for the pass in flight, a pass is never entered
 * while one is running, and a pass that throws is logged and retried. The
 * generation counter is not decoration — see {@link KnowledgeSourceSweep.stop}.
 */

import type { IndexSourceInput } from '@kefu/core';
import { indexSourceInto } from './chunk-writer';
import type { KnowledgeChunkWriter } from './chunk-writer';
import type { IndexSourceReader } from './index-source-reader';

/** The structured logger shape the sweep writes through. */
export type KnowledgeSweepLogger = {
  logStructured(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string,
    fields: Readonly<Record<string, unknown>>,
    context?: string,
  ): void;
};

/** Options for {@link KnowledgeSourceSweep}. */
export type KnowledgeSourceSweepOptions = {
  /** How long to wait between passes. */
  readonly pollIntervalMs: number;
  readonly logger?: KnowledgeSweepLogger;
};

/**
 * What one pass did.
 *
 * `written` counts slices the plan marked `insert` or `reindex` — that is, slices
 * whose *text moved* — and deliberately not the ones marked `attempt` or `park`,
 * which are slices whose content is unchanged and whose index state is the
 * embedding sweep's business. `stale` counts the rows the write deleted. The two
 * are the pass's evidence: a second pass over an unchanged tenant reports zero of
 * both, and a pass that reports zero forever is a sweep that is not seeing the
 * merchant's edits.
 */
export type KnowledgeSweepResult = {
  /** Tenants enumerated by this pass. */
  readonly tenants: number;
  /** Source rows handed to the writer. */
  readonly sources: number;
  /** Slices whose text was new or had moved. */
  readonly written: number;
  /** Stored slices deleted because their source no longer produces them. */
  readonly stale: number;
  /** Reads or writes that threw, over every tenant. */
  readonly failed: number;
};

/**
 * Re-indexes every tenant's knowledge sources on a timer.
 *
 * The class holds a reader and a writer and nothing else — no pool, no
 * transaction manager — so neither of them can be reached from a place that is
 * already holding a connection.
 */
export class KnowledgeSourceSweep {
  readonly #logger: KnowledgeSweepLogger;
  #running = false;
  #passing = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wake: (() => void) | null = null;
  #inFlight: Promise<void> | null = null;
  /** Which loop is the current one; see {@link KnowledgeSourceSweep.stop}. */
  #generation = 0;

  /**
   * @param reader - Reads one tenant's sources, and the tenant list.
   * @param writer - The durable slice store.
   * @param options - Poll bound and logger.
   */
  constructor(
    private readonly reader: IndexSourceReader,
    private readonly writer: KnowledgeChunkWriter,
    private readonly options: KnowledgeSourceSweepOptions,
  ) {
    this.#logger = options.logger ?? { logStructured: () => undefined };
  }

  /** Whether the loop is currently scheduled to keep polling. */
  get running(): boolean {
    return this.#running;
  }

  /**
   * Start polling.
   *
   * Idempotent, and the first pass starts immediately: a Worker that has just
   * booted is exactly the case where the index is behind — the API may have been
   * up for hours — so waiting one interval to begin would delay the only pass
   * anybody is waiting for.
   */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#inFlight = this.#loop((this.#generation += 1));
  }

  /**
   * Stop polling and wait for the pass in flight.
   *
   * Never aborts a pass half-way: a source's write is one transaction, so there
   * is nothing here to cut short, but a pass abandoned mid-way leaves the
   * remaining sources unindexed and the counters unprinted. Waiting is bounded —
   * the loop checks the generation it was started with — so a shutdown is never
   * held open by a `start()` that arrived underneath it.
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
   * Run exactly one pass.
   *
   * Refuses to run concurrently with itself, so a test or an operator's one-shot
   * tool can never overlap the loop — which would double every count in the
   * result and read as a bug in the sweep rather than in its caller.
   *
   * @returns What the pass did, or the empty result when one is already running.
   */
  async runOnce(): Promise<KnowledgeSweepResult> {
    if (this.#passing) {
      return emptyPass();
    }
    this.#passing = true;
    try {
      return await this.#pass();
    } finally {
      this.#passing = false;
    }
  }

  /** Poll until stopped, never overlapping two passes. */
  async #loop(generation: number): Promise<void> {
    while (this.#isLive(generation)) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        // The tenant list is the one read whose failure lands here; see the
        // module note. Nothing is stranded — no source has been touched — so the
        // next pass retries the whole thing.
        this.#logger.logStructured(
          'error',
          'knowledge source sweep failed before reaching its sources; retrying after the poll interval',
          { error: errorName(error) },
          'KnowledgeSourceSweep',
        );
      }
      if (!this.#isLive(generation)) {
        break;
      }
      await this.#sleep(this.options.pollIntervalMs);
    }
  }

  /** Whether the loop of this generation is still the one that should poll. */
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

  /** One pass: every tenant, every source, one write at a time. */
  async #pass(): Promise<KnowledgeSweepResult> {
    const result: PassCounters = emptyPass();
    let firstFailure: { readonly input: IndexSourceInput; readonly error: string } | null = null;

    const tenantIds = await this.reader.listTenantIds();
    for (const tenantId of tenantIds) {
      result.tenants += 1;
      let inputs: ReadonlyArray<IndexSourceInput>;
      try {
        inputs = await this.reader.listIndexSources(tenantId);
      } catch (error: unknown) {
        result.failed += 1;
        this.#logger.logStructured(
          'error',
          'could not read a tenant’s knowledge sources; the rest of the sweep continues',
          { tenantId, error: errorName(error) },
          'KnowledgeSourceSweep',
        );
        continue;
      }

      for (const input of inputs) {
        try {
          const plan = await indexSourceInto(this.writer, input);
          result.sources += 1;
          for (const write of plan.plans) {
            if (write.action === 'insert' || write.action === 'reindex') {
              result.written += 1;
            }
          }
          result.stale += plan.stale.length;
        } catch (error: unknown) {
          result.failed += 1;
          firstFailure ??= { input, error: errorName(error) };
        }
      }
    }

    if (firstFailure !== null) {
      this.#logger.logStructured(
        'warn',
        'some knowledge sources could not be indexed; the first failure is named and the rest are counted',
        {
          sourceKind: firstFailure.input.sourceKind,
          sourceId: firstFailure.input.sourceId,
          tenantId: firstFailure.input.tenantId,
          error: firstFailure.error,
          failed: result.failed,
        },
        'KnowledgeSourceSweep',
      );
    }

    // A pass that changed nothing is the steady state, not an event: a line per
    // interval per Worker is how a log trains its reader to skip it.
    this.#logger.logStructured(
      result.written > 0 || result.stale > 0 || result.failed > 0 ? 'info' : 'debug',
      'knowledge source sweep finished',
      { ...result },
      'KnowledgeSourceSweep',
    );
    return result;
  }
}

/**
 * The pass's counters while it works: {@link KnowledgeSweepResult}, writable.
 *
 * The public shape is read-only because it is a report; this is the same thing
 * seen from inside, where it is being written.
 */
type PassCounters = { -readonly [K in keyof KnowledgeSweepResult]: number };

/** A pass that did nothing, and the counter block a pass fills in. */
function emptyPass(): PassCounters {
  return { tenants: 0, sources: 0, written: 0, stale: 0, failed: 0 };
}

/**
 * The name of a thrown value, for a log field.
 *
 * Only the name: a database error can carry the statement and the row, and this
 * string is written to a log an operator reads.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
