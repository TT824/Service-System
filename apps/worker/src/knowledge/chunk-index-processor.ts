/**
 * One bounded pass of the index sweep: close what a dead Worker left, claim what
 * is due, embed each claim, write each outcome down.
 *
 * A tick is four steps and they are in this order for a reason:
 *
 *   1. **Recover.** A slice at the attempt ceiling is never claimable again, so
 *      the row a Worker claimed and died on has to be closed by something that
 *      does not go through the claim — that is `parkExhausted`, and running it
 *      first means this tick does not claim into a table it has just left dirty.
 *   2. **Claim.** One statement takes the due slices and spends their attempt.
 *      Everything about which rows those are lives there, in SQL, because that is
 *      the only place a concurrent Worker can be excluded from the decision.
 *   3. **Embed, one slice at a time.** The provider is called outside any
 *      transaction — the tick holds a repository and a provider, and nothing that
 *      could open a connection lives in scope here. A provider call inside the
 *      claim's transaction would hold a row lock for the length of a network
 *      round trip.
 *   4. **Write the outcome.** `recordChunkIndexOutcome` decides what the attempt
 *      produced; the store writes it, guarded by the hash that was embedded.
 *
 * The two halves that are *not* re-decided here are the attempt's meaning (the
 * kernel) and the schedule (the state machine's `isChunkIndexDue`, reproduced by
 * the claim's `WHERE`). The one decision this module does make is the gate below,
 * and it is the reason the module is not just a `for` loop.
 *
 * **With no embedding provider, the tick claims nothing.** Claiming *spends an
 * attempt* — that is the kernel's rule, and it is the right rule — so a claim the
 * Worker cannot finish is not a no-op: five ticks without a provider would drive
 * every pending slice in the table to the ceiling and park it, with no embedding
 * ever having failed and nothing in `index_error` to say why. So the gate is not
 * "skip the embedding step", it is "do not claim", and its consequence is the
 * state the rest of the platform is built on: the slices stay `pending`, and the
 * day a model is configured they are picked up by the next tick and indexed,
 * which is the backfill — no migration, no replay, no second code path.
 *
 * The gate is also why a Worker with no provider logs nothing per tick. Absence
 * of a provider is a steady state, not an event, and a line per poll interval is
 * a line that trains its reader to ignore the log. The honest place to see it is
 * the status query, which reports `providerConfigured` as part of what it says
 * about a tenant's index.
 *
 * **The loop around the tick is the outbox loop's shape, and deliberately not a
 * second mechanism.** `start` polls, `stop` waits for the tick in flight, a tick
 * is never entered while one is running (`#ticking`), and a tick that fails is
 * logged and retried rather than allowed to end the loop. What differs is the
 * cadence and the reason for it: a delivery is a customer waiting for an answer,
 * while an index attempt is scheduled by a backoff measured in minutes, so this
 * loop polls on a slower interval — the waiting is the design, not a delay.
 *
 * **The loop runs even with no provider.** The gate above is a decision about
 * *claiming* — "spend nothing you cannot pay for" — and it is made inside the
 * tick. Starting or stopping the loop on the same condition would fold two
 * separate facts into one: the loop is running, and the index is gated. The
 * status query reports the second; the health server reports the first.
 *
 * {@link ChunkIndexProcessor.runOnce} is still exposed, so a test — and an
 * operator's one-shot tool — can drive one tick without a timer, and `now` is
 * injectable for the same reason.
 */

import { deriveEmbeddingId, recordChunkIndexOutcome, type ChunkIndexState } from '@kefu/core';
import type { ChunkIndexRepository, ClaimedChunk, EmbeddingWrite } from './chunk-index-repository';
import type { EmbeddingProvider, EmbeddingResult } from '@kefu/core';

/** The structured logger shape the sweep writes through. */
export type ChunkIndexLogger = {
  logStructured(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string,
    fields: Readonly<Record<string, unknown>>,
    context?: string,
  ): void;
};

/** Options for {@link ChunkIndexProcessor}. */
export type ChunkIndexProcessorOptions = {
  /** How many slices one tick may claim. */
  readonly batchSize: number;
  /** How long to wait between polls when there is nothing to do. */
  readonly pollIntervalMs: number;
  /** Injectable clock, so a test controls the backoff arithmetic. */
  readonly now?: () => number;
  readonly logger?: ChunkIndexLogger;
};

/**
 * What one tick did.
 *
 * `claimed` counts what the claim handed over; the four outcome counters count
 * what was *written*. They need not add up: an outcome the store refused because
 * the text had moved is `superseded`, and a write that failed outright is counted
 * nowhere — the slice keeps the attempt it spent and is claimed again after its
 * backoff. Keeping the two kinds of number apart is what makes a tick's summary
 * readable as evidence rather than as a claim about itself.
 */
export type ChunkIndexTickResult = {
  /** Slices the claim handed to this Worker. */
  readonly claimed: number;
  /** Slices that became `indexed`, with a vector stored beside them. */
  readonly indexed: number;
  /** Slices that became `failed`, with a later attempt scheduled. */
  readonly failed: number;
  /** Slices that became `skipped`: their attempt budget is spent. */
  readonly parked: number;
  /** Rows a dead Worker left at the ceiling, closed by this tick's recovery. */
  readonly recovered: number;
  /** Outcomes discarded because the slice's text moved under the attempt. */
  readonly superseded: number;
};

/**
 * Claims due slices, embeds them, and records what happened.
 *
 * The class holds exactly two collaborators — a repository and a provider, the
 * latter possibly absent — and deliberately no third. There is no database
 * handle, no pool and no transaction manager in scope, which is a *structural*
 * guarantee that no provider call can happen inside a database transaction: the
 * provider is reachable only from the private `#embed`, and the only things
 * reachable from there are the provider and Core's pure functions.
 */
export class ChunkIndexProcessor {
  readonly #now: () => number;
  readonly #logger: ChunkIndexLogger;
  #running = false;
  #ticking = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wake: (() => void) | null = null;
  #inFlight: Promise<void> | null = null;
  /**
   * Which loop is the current one.
   *
   * `#running` alone cannot say it. A `start()` landing while a `stop()` is
   * waiting on its loop raises the flag again, and a loop that only ever asked
   * `#running` would read that as "carry on" — leaving two loops polling one
   * table and the `stop()` waiting on a loop that is never going to return. The
   * counter is what retires the older loop: it stops at its next check, and the
   * `stop()` that found it returns.
   */
  #generation = 0;

  /**
   * @param repository - The durable index store.
   * @param provider - The embedding provider, or `undefined` when none is
   *   configured; see the module note on what that changes.
   * @param options - Batch bound, poll bound, clock and logger.
   */
  constructor(
    private readonly repository: ChunkIndexRepository,
    private readonly provider: EmbeddingProvider | undefined,
    private readonly options: ChunkIndexProcessorOptions,
  ) {
    this.#now = options.now ?? (() => Date.now());
    this.#logger = options.logger ?? { logStructured: () => undefined };
  }

  /**
   * Whether this Worker can index at all.
   *
   * Exposed so the status surface can report the real reason a tenant's index is
   * not moving, instead of leaving an operator to infer it from a table that
   * never changes.
   */
  get providerConfigured(): boolean {
    return this.provider !== undefined;
  }

  /** Whether the loop is currently scheduled to keep polling. */
  get running(): boolean {
    return this.#running;
  }

  /**
   * Start polling.
   *
   * Idempotent: a second call while the loop runs does nothing. The first tick
   * starts immediately, so a slice that is already due does not wait a whole
   * interval to be picked up.
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
   * Never aborts a tick half-way. The claim spends an attempt before the provider
   * is called, so a tick cut off in the middle would leave rows carrying an
   * attempt nobody wrote back — recoverable, since the claim's own backoff
   * releases them, but a shutdown that produces them for free is a shutdown that
   * makes the table's counters harder to read than they need to be.
   *
   * Idempotent: a second call awaits the same in-flight tick.
   */
  async stop(): Promise<void> {
    // Captured before the flag moves: this call stops the loop it found, and the
    // handle it clears at the end is that one. A `start()` arriving while this
    // is awaited has its own loop, and nothing here may take its handle away.
    const inFlight = this.#inFlight;
    this.#running = false;
    // Retiring the generation is what makes the wait finite even if the flag is
    // raised again underneath it: the loop being waited for sees itself
    // superseded and returns instead of reading the new `#running` as permission
    // to keep polling. A restart landing here is served by its own loop.
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
   * Refuses to run concurrently with itself: a manual call — a test, an
   * operator's one-shot tool — can never overlap the loop, and two ticks cannot
   * claim the same slice twice over.
   *
   * @returns What the tick did, or the empty tick when one is already running.
   */
  async runOnce(): Promise<ChunkIndexTickResult> {
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
        // A failure of the *tick* itself — the database is unreachable, the
        // recovery or the claim statement failed — must not end the loop: the
        // next tick retries, and a failed claim claimed nothing, so nothing is
        // stranded. The per-slice failures never reach here; the tick isolates
        // them where they happen.
        this.#logger.logStructured(
          'error',
          'index sweep tick failed; retrying after the poll interval',
          { error: errorName(error) },
          'ChunkIndexProcessor',
        );
      }
      if (!this.#isLive(generation)) {
        break;
      }
      await this.#sleep(this.options.pollIntervalMs);
    }
  }

  /**
   * Whether the loop of this generation is still the one that should poll.
   *
   * Both halves are needed. `#running` is the loop's own instruction to stop;
   * the generation is what tells a loop that a `start()` has already replaced —
   * and the older one is the one that has to leave, or a Worker that was stopped
   * and started again would end up with two loops claiming from one table. The
   * check sits before the wait as well as in the loop's condition, so a retired
   * loop leaves without arming a timer the live one would then share.
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

  /**
   * End a pending poll wait immediately.
   *
   * Without this, `stop()` would await a loop that is sleeping for a whole poll
   * interval, so a shutdown would be delayed by up to that interval — and with a
   * long one it would look like a hang.
   */
  #endWait(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /** One tick: recover, claim a bounded batch, and record each slice's outcome. */
  async #tick(): Promise<ChunkIndexTickResult> {
    const result: TickCounters = emptyTick();
    const provider = this.provider;
    if (provider === undefined) {
      // See the module note: claiming would spend attempts this Worker cannot
      // pay for, and park the table. Nothing is claimed, so nothing is counted.
      return result;
    }

    const now = this.#isoNow();
    result.recovered = await this.repository.parkExhausted(now);

    const claimed = await this.repository.claimDue(now, this.options.batchSize);
    result.claimed = claimed.length;

    for (const chunk of claimed) {
      let recorded: AttemptOutcome;
      try {
        recorded = await this.#attempt(provider, chunk, now);
      } catch (error: unknown) {
        // A slice whose attempt cannot even be *prepared* must not take the rest
        // of the batch down with it: the claim already spent every slice's
        // attempt, so abandoning the loop would spend the remaining ones for
        // nothing. The slice is left to its backoff — the same place an unwritable
        // outcome leaves it — and the failure is named rather than swallowed.
        this.#logger.logStructured(
          'error',
          'could not prepare an index attempt; the slice keeps the attempt it spent',
          { chunkId: chunk.id, tenantId: chunk.tenantId, error: errorName(error) },
          'ChunkIndexProcessor',
        );
        continue;
      }
      if (recorded === 'indexed') {
        result.indexed += 1;
      } else if (recorded === 'failed') {
        result.failed += 1;
      } else if (recorded === 'parked') {
        result.parked += 1;
      } else if (recorded === 'superseded') {
        result.superseded += 1;
      }
    }

    return result;
  }

  /**
   * Embed one claimed slice and write its outcome back.
   *
   * The two steps are one method because they are one attempt: the call that
   * spends the provider's time and the write that records what it produced are
   * never useful apart, and the caller's per-slice guard covers both.
   */
  async #attempt(
    provider: EmbeddingProvider,
    chunk: ClaimedChunk,
    now: string,
  ): Promise<AttemptOutcome> {
    const attempt = await this.#embed(provider, chunk);
    // An `EmbeddingResult` is an `IndexAttemptOutcome` that also kept its vector:
    // the kernel reads `ok`, `code` and `reason`, and the three agree by
    // construction because one provider call produced both.
    const state = recordChunkIndexOutcome(chunk.indexAttempts, attempt, now);
    const embedding = attempt.ok ? embeddingWrite(chunk, provider.model, attempt.vector) : null;
    return this.#record({ chunk, state, embedding, now });
  }

  /**
   * Write one outcome, and classify what a failure to write it means.
   *
   * A store failure is not a provider failure and is not counted as one: the
   * attempt was spent, nothing was written, and the slice will be claimed again
   * after its backoff — which is the correct outcome for a statement that timed
   * out or a row that vanished mid-write. It is logged rather than thrown because
   * one unwritable slice is not a reason to abandon the rest of the batch; a
   * failure of the *claim* or of the recovery, which strands nothing and stops
   * everything, still propagates to the caller that runs the loop.
   */
  async #record(write: {
    readonly chunk: ClaimedChunk;
    readonly state: ChunkIndexState;
    readonly embedding: EmbeddingWrite | null;
    readonly now: string;
  }): Promise<AttemptOutcome> {
    try {
      const outcome = await this.repository.recordOutcome(write);
      if (outcome === 'superseded') {
        this.#logger.logStructured(
          'warn',
          'discarded an index outcome whose slice text moved under the attempt',
          { chunkId: write.chunk.id, tenantId: write.chunk.tenantId },
          'ChunkIndexProcessor',
        );
        return 'superseded';
      }
    } catch (error: unknown) {
      this.#logger.logStructured(
        'error',
        'could not write an index outcome; the slice keeps the attempt it spent',
        { chunkId: write.chunk.id, error: errorName(error) },
        'ChunkIndexProcessor',
      );
      return 'unwritten';
    }

    if (write.state.indexStatus === 'indexed') {
      return 'indexed';
    }
    return write.state.indexStatus === 'skipped' ? 'parked' : 'failed';
  }

  /**
   * One provider call, classified.
   *
   * A provider reports its own failures precisely, and that report is what lands
   * in `index_error` — the kernel states that the provider layer is responsible
   * for keeping payloads out of it, so nothing is trimmed or rewritten here.
   *
   * Two failure kinds are this method's rather than the provider's. A **throw**
   * becomes an ordinary retryable failure: unlike the outbox's transport, nothing
   * here has a customer-visible consequence, so an unexpected exception is a
   * failed attempt and not a reason to settle anything terminally. An **empty
   * vector** becomes one too — `0011` checks `embedding_dimensions > 0` and
   * pgvector refuses a dimension-less value, so recording it as a failed attempt
   * keeps the slice retryable instead of surfacing a constraint violation from
   * inside the write, where the claim has already been spent.
   */
  async #embed(provider: EmbeddingProvider, chunk: ClaimedChunk): Promise<EmbeddingResult> {
    try {
      // `chunk.content` goes to the model as the merchant wrote it, and the
      // absence of a `maskPii` call here is a decision rather than an omission.
      // The query leg does mask (see `postgres-knowledge-semantic-recall.ts`),
      // because the query is the customer's text; a slice is the store's own
      // product copy or FAQ, which carries no customer PII to redact. Masking it
      // anyway would not be free: every vector already in `knowledge_embeddings`
      // was computed from this exact text and is joined back on `content_hash`,
      // so a redaction here is a full re-embedding of the catalogue, not a
      // safety improvement. Do not "complete" this by masking both sides.
      const result = await provider.embed(chunk.content);
      if (result.ok && result.vector.length === 0) {
        return {
          ok: false,
          code: 'embedding_empty_vector',
          reason: 'the embedding provider returned a vector with no dimensions',
        };
      }
      return result;
    } catch (error: unknown) {
      return {
        ok: false,
        code: 'embedding_provider_error',
        reason: `the embedding provider threw ${errorName(error)}`,
      };
    }
  }

  /** The tick's instant, from the injectable clock. */
  #isoNow(): string {
    return new Date(this.#now()).toISOString();
  }
}

/**
 * The vector row one successful attempt produces.
 *
 * The id is derived from the same three columns the table's unique constraint
 * names, so the row this write replaces is addressed by the model as well as the
 * slice: a rebuild under a new model adds rows rather than overwriting the old
 * ones, and `contentHash` is copied from the claim because it must describe the
 * text that was embedded, which is the claim's `content` and not whatever the row
 * holds by the time this is written.
 */
function embeddingWrite(
  chunk: ClaimedChunk,
  model: string,
  vector: ReadonlyArray<number>,
): EmbeddingWrite {
  return {
    id: deriveEmbeddingId(chunk.tenantId, chunk.id, model),
    model,
    vector,
    contentHash: chunk.contentHash,
  };
}

/**
 * What became of one claimed slice's attempt.
 *
 * `unwritten` is not an outcome the store reports — it is what this class says
 * when the write-back threw, and it is counted nowhere: the slice keeps the
 * attempt it spent and is claimed again after its backoff.
 */
type AttemptOutcome = 'indexed' | 'failed' | 'parked' | 'superseded' | 'unwritten';

/**
 * The tick's counters while it works: {@link ChunkIndexTickResult}, writable.
 *
 * The public shape is read-only because it is a *report*; inside the tick the
 * same fields are what the counting writes into. Rather than loosen the report
 * for the tick's sake, the tick's own view is spelled out here.
 */
type TickCounters = { -readonly [K in keyof ChunkIndexTickResult]: number };

/**
 * A tick that did nothing, and the counter block a tick fills in as it works.
 *
 * Returned fresh rather than shared: the tick mutates what this hands back, so a
 * frozen singleton would break every tick, and a shared mutable one would leak
 * one tick's counters into the next.
 */
function emptyTick(): TickCounters {
  return { claimed: 0, indexed: 0, failed: 0, parked: 0, recovered: 0, superseded: 0 };
}

/**
 * The name of a thrown value, for a log field and for `index_error`.
 *
 * Only the name: a provider client's exception can carry a request body, an API
 * key in a URL, or the prompt itself, and this string is written to a database
 * column that an operator reads.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
