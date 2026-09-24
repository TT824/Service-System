/**
 * The Worker's outbox delivery loop.
 *
 * It is the process that makes "the API recorded a delivery" and "the customer
 * received a message" independent: the API enqueues a durable outbox entry and
 * answers its caller, and this loop claims that entry later, sends it through the
 * same WeCom transport the API uses, and writes the outcome back. A crash
 * anywhere in that sequence is recoverable, because every step is a committed
 * fact about the entry rather than a fact held in memory.
 *
 * The sequence for one entry, and why each step is where it is:
 *
 * 1. **Claim** — one atomic statement that spends a dispatch attempt and takes a
 *    bounded lease. Nothing is held open afterwards, so the provider call that
 *    follows cannot be inside a transaction or a row lock.
 * 2. **Load** — the delivery and the logical message the entry points at. The
 *    entry already names them, so the platform message is *reused*, never
 *    re-created: a retry appends an attempt to the same delivery.
 * 3. **Gate** — the reply window and the 5-message budget are evaluated before the
 *    provider is called, so a message that is not allowed to be sent can never
 *    reach a real customer.
 * 4. **Send** — through `@kefu/wecom`'s shared outbound transport, so a Worker
 *    attempt is byte-for-byte the request an API attempt would have made.
 * 5. **Record** — the attempt, the delivery projection and the outbox state.
 *
 * The three terminal rules the platform promises, expressed here:
 *
 * - a **definite retryable failure** returns the entry to `pending` with the next
 *   attempt scheduled by `outboxRetryDelayMs`, and releases the reserved quota
 *   slot — the message definitely did not reach the customer, so the budget was
 *   not spent;
 * - a **definite non-retryable failure** abandons the entry immediately, without
 *   spending the rest of the budget on attempts that would be refused
 *   identically, and releases the slot;
 * - an **`unknown` outcome** abandons the entry too, but *keeps* the slot. The
 *   provider may have accepted the message, so retrying could deliver it twice
 *   and returning the slot would let the platform spend a budget it already used.
 *   It is left for a human to resolve, which is the only honest option.
 *
 * A `sent` delivery is never sent again: the loop closes its entry as dispatched
 * instead. That check is what keeps a stale queue entry — one that raced a status
 * callback — from delivering a second copy of a message the customer already has.
 *
 * That check is the first of a small set. Before an entry is prepared at all, the
 * delivery it points at is *reconciled* against what the API has since recorded
 * (see `delivery-send-gate.ts`): `sent` closes the entry, while `unknown` and a
 * definitively `failed` delivery abandon it — all three with no quota reserved
 * and no provider call. A delivery the platform has already resolved must never
 * cost a provider call, and must never be handed to the provider a second time.
 *
 * Once the provider *has* been called, the loop's obligations change. Its outcome
 * may already have reached the customer even if it cannot be written down, so a
 * persistence failure after that point is not an ordinary retryable failure: the
 * entry is settled best-effort as terminal, and the retry release path is never
 * called deliberately — rescheduling there would re-send a message the provider
 * may already have delivered. A definitive failure outcome still gives its
 * reserved slot back, but only *after* the attempt has been recorded, so a
 * database that fails mid-write-back cannot also release budget for a message
 * that may have been delivered.
 *
 * Ownership is re-validated immediately before the send
 * ({@link OutboxRepository.renewOutboxLease}), which is also where the claim gets
 * a full lease to run inside. The configured per-request deadline and the shared
 * transport's maximum replay path are bounded below that lease with explicit
 * headroom (`provider-call-bound.ts`), enforced where the Worker is composed — so
 * a send cannot be configured to outlive the claim that authorises it.
 *
 * The loop is bounded, non-overlapping and interruptible: it claims at most
 * {@link OutboxProcessorOptions.batchSize} entries per tick, never starts a tick
 * while one is running, isolates every entry in its own `try`, and stops on
 * request after finishing the tick in flight. A per-entry failure is logged and
 * the loop continues, which is what makes one poisoned row unable to stall the
 * queue — and it cannot loop forever on that row either, because the claim spent
 * an attempt and the budget is bounded.
 */

import {
  evaluateDeliveryWindow,
  type ChannelResult,
  type ChannelOutboxLeaseRecord,
  type DeliveryFailureCode,
  type MessageDelivery,
  type SendMessageInput,
  type SendMessageResult,
} from '@kefu/core';
import type { WecomOutboundTransport } from '@kefu/wecom';
import { deliverySendRefusal } from './delivery-send-gate';
import type {
  OutboxFailure,
  OutboxMessage,
  OutboxRepository,
  QuotaWindowKey,
} from './outbox-repository';

/** Maximum length of a platform-authored reason kept on a delivery or entry. */
const MAX_REASON_LENGTH = 200;

/** Injection token carrying the bound {@link OutboxRepository}. */
export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');

/** Injection token carrying the bound {@link WecomOutboundTransport}. */
export const OUTBOX_TRANSPORT = Symbol('OUTBOX_TRANSPORT');

/** The structured logger shape the loop writes through. */
export type OutboxLogger = {
  logStructured(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string,
    fields: Readonly<Record<string, unknown>>,
    context?: string,
  ): void;
};

/** Options for {@link OutboxProcessor}. */
export type OutboxProcessorOptions = {
  /**
   * This Worker's opaque lease identity.
   *
   * Compared by value on every write-back, so it must be stable for the life of
   * the process and unique across processes: two Workers sharing one identity
   * would defeat the compare-by-owner guard.
   */
  readonly owner: string;
  /** How long to wait between polls when there is nothing to do. */
  readonly pollIntervalMs: number;
  /** How many entries one tick may claim. */
  readonly batchSize: number;
  /** Injectable clock, so a test controls lease, backoff and window arithmetic. */
  readonly now?: () => number;
  readonly logger?: OutboxLogger;
};

/** What one tick did. */
export type OutboxTickResult = {
  /** Entries the claim handed to this Worker in this tick. */
  readonly claimed: number;
  /** Entries abandoned because their attempt budget was spent. */
  readonly swept: number;
  readonly sent: number;
  /** Entries returned to `pending` with a later attempt scheduled. */
  readonly retried: number;
  /** Entries that became terminal in this tick: abandoned. */
  readonly terminal: number;
};

/** How one claimed entry ended. */
type ItemOutcome = 'sent' | 'retried' | 'terminal' | 'skipped';

/**
 * What the loop knows about one entry's progress through the provider boundary.
 *
 * It exists so a failure can be classified by *when* it happened. Before the
 * provider call an unexpected failure is an ordinary retryable one; after it
 * began, the message may already have reached the customer and the entry must be
 * settled terminally instead. Held in a mutable object rather than a boolean
 * because it is set inside {@link OutboxProcessor} and read by the `catch` around
 * it, which cannot see a local of the method that threw.
 */
type ProviderProgress = { providerStarted: boolean };

/**
 * Claims and delivers due channel outbox entries.
 *
 * The loop holds exactly two collaborators — a repository and a transport — and
 * deliberately no third. There is no database handle, no pool and no
 * transaction manager in scope here, which is a *structural* guarantee that the
 * provider call cannot happen inside a database transaction: the provider call
 * is made in {@link OutboxProcessor.sendToProvider}, and the only things
 * reachable from there are the transport and Core's pure functions.
 */
export class OutboxProcessor {
  readonly #now: () => number;
  readonly #logger: OutboxLogger;
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
   * `#running` would read that as "carry on" — leaving two loops claiming from
   * one outbox and the `stop()` waiting on a loop that is never going to return.
   * The counter is what retires the older loop: it stops at its next check, and
   * the `stop()` that found it returns.
   */
  #generation = 0;

  /**
   * @param repository - The durable outbox store.
   * @param transport - The shared WeCom outbound transport.
   * @param options - Owner identity, poll bound, batch bound, clock and logger.
   */
  constructor(
    private readonly repository: OutboxRepository,
    private readonly transport: WecomOutboundTransport,
    private readonly options: OutboxProcessorOptions,
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
   * Idempotent: a second call while the loop runs does nothing. The first tick
   * starts immediately, so a queue that already has work does not wait a full
   * interval for it.
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
   * Never aborts a tick half-way: an entry that has been claimed is either
   * completed or released before this resolves, so shutting down cannot leave a
   * claim the process will never write back. Any remaining in-flight work is
   * recovered by the lease expiring, which is what the lease is for.
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
   * Exposed so a test — and an operator's one-shot tool — can drive the loop
   * deterministically instead of waiting on a timer. It refuses to run
   * concurrently with itself, so a manual call can never overlap the loop.
   *
   * @returns What the tick did.
   */
  async runOnce(): Promise<OutboxTickResult> {
    if (this.#ticking) {
      return { claimed: 0, swept: 0, sent: 0, retried: 0, terminal: 0 };
    }
    this.#ticking = true;
    try {
      return await this.#tick();
    } finally {
      this.#ticking = false;
    }
  }

  /** One tick: recover exhausted entries, then claim and deliver a bounded batch. */
  async #tick(): Promise<OutboxTickResult> {
    const now = this.#isoNow();
    // Recovery runs first, so an entry left pending at its attempt bound by a
    // Worker that died is closed before this Worker tries to claim.
    const swept = await this.repository.sweepExhausted(now);
    if (swept > 0) {
      this.#logger.logStructured(
        'warn',
        'abandoned outbox entries whose attempt budget was spent',
        { count: swept },
        'OutboxProcessor',
      );
    }

    const claimed = await this.repository.claimDue(this.options.owner, now, this.options.batchSize);
    const result = { claimed: claimed.length, swept, sent: 0, retried: 0, terminal: 0 };
    for (const record of claimed) {
      const outcome = await this.#processOne(record);
      if (outcome === 'sent') {
        result.sent += 1;
      } else if (outcome === 'retried') {
        result.retried += 1;
      } else if (outcome === 'terminal') {
        result.terminal += 1;
      }
    }
    return result;
  }

  /** Poll until stopped, never overlapping two ticks. */
  async #loop(generation: number): Promise<void> {
    while (this.#isLive(generation)) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        // A failure of the *tick* — the database is unreachable, the claim
        // statement failed — must not kill the loop: the next tick retries, and
        // nothing was claimed, so nothing is stranded. Only a safe field is
        // logged; a driver error can carry a connection string.
        this.#logger.logStructured(
          'error',
          'outbox tick failed; retrying after the poll interval',
          { error: errorName(error) },
          'OutboxProcessor',
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
   * and started again would end up with two loops claiming from one outbox. The
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
   * Without this, `stop()` would await an in-flight loop that is sleeping for a
   * whole poll interval — so a shutdown would be delayed by up to that interval,
   * and with a long one it would look like a hang. Clearing the timer and
   * resolving the promise lets the loop observe `#running === false` and return.
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

  /**
   * Deliver one claimed entry.
   *
   * Every path out of this method writes the entry back — completed, released or
   * abandoned — so a claimed entry is never left in limbo by a decision. The
   * whole body is wrapped so that an unexpected throw is reported as a *retryable*
   * release rather than escaping the loop: the entry keeps its spent attempt (the
   * claim already counted it) and is retried on the backoff schedule until the
   * budget abandons it, so an unforeseen bug degrades into a bounded retry
   * instead of a stuck row or a stalled queue.
   */
  async #processOne(record: ChannelOutboxLeaseRecord): Promise<ItemOutcome> {
    const progress: ProviderProgress = { providerStarted: false };
    try {
      return await this.#deliver(record, progress);
    } catch (error: unknown) {
      this.#logger.logStructured(
        'error',
        progress.providerStarted
          ? 'outbox entry failed after the provider call; treating it as possibly delivered'
          : 'outbox entry failed unexpectedly',
        { outboxId: record.id, tenantId: record.tenantId, error: errorName(error) },
        'OutboxProcessor',
      );
      if (progress.providerStarted) {
        // The provider was already called, so the message may be with the
        // customer. The entry is settled terminally — never rescheduled, never
        // released — because a retry here is exactly the duplicate the platform
        // must not risk.
        return await this.#settleAfterProviderFailure(record, {
          kind: 'failed',
          code: 'channel_delivery_unknown',
          reason:
            'the dispatch attempt ended after the provider was called, without a recorded outcome',
          retryable: true,
        });
      }
      await this.#releaseSafely(record, {
        code: 'channel_provider_error',
        reason: 'the worker could not complete the dispatch attempt',
      });
      return 'retried';
    }
  }

  /** The delivery sequence for one claimed entry. */
  async #deliver(
    record: ChannelOutboxLeaseRecord,
    progress: ProviderProgress,
  ): Promise<ItemOutcome> {
    const now = this.#isoNow();
    const delivery = await this.repository.getDelivery(record.tenantId, record.deliveryId);
    if (delivery === undefined) {
      // The schema makes this unreachable (the entry references the delivery),
      // but a claim that cannot resolve its delivery must still be written back
      // rather than silently dropped.
      await this.#releaseSafely(record, {
        code: 'channel_not_configured',
        reason: 'the outbox entry no longer resolves to a delivery',
      });
      return 'retried';
    }

    // Reconcile the delivery before anything is reserved or sent: the API may
    // have resolved it since the entry was queued, and none of those resolutions
    // may cost a provider call.
    const refusal = deliverySendRefusal(delivery);
    if (refusal?.kind === 'already_sent') {
      // Already delivered. The entry is stale — a retry raced a status callback —
      // and sending again would put a second copy in front of the customer, so
      // the queue is closed instead.
      await this.repository.completeOutbox(record, this.options.owner, now);
      this.#log('info', 'closed an outbox entry whose delivery was already sent', record, {
        deliveryId: delivery.id,
      });
      return 'sent';
    }
    if (refusal?.kind === 'terminal_failure') {
      // The delivery already reached a state the platform never retries
      // automatically — an `unknown` outcome, or a definitive failure. No slot is
      // reserved and no provider call is made; the entry is simply stopped.
      await this.repository.abandonOutbox(
        record,
        this.options.owner,
        { code: refusal.code, reason: refusal.reason },
        now,
      );
      this.#log('warn', 'closed an outbox entry whose delivery had already ended', record, {
        deliveryId: delivery.id,
        deliveryStatus: delivery.status,
        failureCode: refusal.code,
      });
      return 'terminal';
    }

    const message = await this.repository.getMessage(record.tenantId, record.messageId);
    if (message === undefined) {
      await this.#releaseSafely(record, {
        code: 'channel_not_configured',
        reason: 'the outbox entry no longer resolves to a platform message',
      });
      return 'retried';
    }

    const key = this.#windowKey(delivery);
    const decision = evaluateDeliveryWindow(await this.repository.getQuotaWindow(key), now);
    if (!decision.allowed) {
      return this.#blocked(record, delivery, decision.code, decision.reason);
    }
    const reservation = await this.repository.reserveQuotaSlot(key, now);
    if (!reservation.ok) {
      return this.#blocked(record, delivery, reservation.code, reservation.reason);
    }

    // Ownership is re-validated — and the lease extended — as the last thing
    // before the provider is called. A Worker whose claim was taken over while it
    // prepared has lost the right to send, and learns so here rather than by
    // delivering a second copy of the message.
    const renewed = await this.repository.renewOutboxLease(
      record,
      this.options.owner,
      this.#isoNow(),
    );
    if (renewed === undefined) {
      // No provider call and no delivery happened, so the slot this Worker
      // reserved for itself goes straight back; whoever owns the entry now will
      // reserve its own.
      await this.#releaseQuotaSafely(record, key);
      this.#log('warn', 'another worker took the claim over, so this send was abandoned', record, {
        deliveryId: delivery.id,
      });
      return 'skipped';
    }

    // Everything above is database work and is done. From here on the provider
    // may be reached, so a failure is no longer an ordinary retryable one.
    progress.providerStarted = true;
    let outcome: SendOutcome;
    try {
      outcome = await this.sendToProvider(delivery, message);
    } catch (error: unknown) {
      // `sendToProvider` classifies a thrown transport failure itself; this
      // guards the call itself, and an entry whose send threw before answering
      // is in exactly the "possibly delivered" position.
      this.#logger.logStructured(
        'error',
        'the provider call threw before reporting an outcome',
        { outboxId: record.id, tenantId: record.tenantId, error: errorName(error) },
        'OutboxProcessor',
      );
      return await this.#settleAfterProviderFailure(record, {
        kind: 'failed',
        code: 'channel_delivery_unknown',
        reason: 'the provider call threw before reporting an outcome',
        retryable: true,
      });
    }

    try {
      return await this.#persistOutcome(record, delivery, key, outcome);
    } catch (error: unknown) {
      this.#logger.logStructured(
        'error',
        'the dispatch outcome could not be recorded; treating the entry as terminal',
        { outboxId: record.id, tenantId: record.tenantId, error: errorName(error) },
        'OutboxProcessor',
      );
      return await this.#settleAfterProviderFailure(record, outcome);
    }
  }

  /**
   * Write back the outcome of a completed provider call.
   *
   * Every statement here runs *after* the provider has answered, so a failure is
   * caught by {@link #deliver} and settled terminally rather than retried. The
   * ordering inside is deliberate: the attempt is recorded before any quota is
   * released, so a database that fails between the two cannot leave the platform
   * having given back budget for a message the provider may have accepted.
   *
   * @param record - The claimed entry.
   * @param delivery - The delivery the attempt belongs to.
   * @param key - The reply-window key the attempt's slot was reserved on.
   * @param outcome - The classified provider outcome.
   * @returns How the entry ended.
   */
  async #persistOutcome(
    record: ChannelOutboxLeaseRecord,
    delivery: MessageDelivery,
    key: QuotaWindowKey,
    outcome: SendOutcome,
  ): Promise<ItemOutcome> {
    await this.repository.appendProviderAttempt({
      tenantId: delivery.tenantId,
      deliveryId: delivery.id,
      status: outcome.kind === 'ok' ? 'sent' : outcome.kind === 'unknown' ? 'unknown' : 'failed',
      externalMessageId: outcome.kind === 'ok' ? outcome.externalMessageId : null,
      failureCode: outcome.kind === 'ok' ? null : outcome.code,
      failureReason: outcome.kind === 'ok' ? null : outcome.reason,
      retryable: outcome.kind !== 'ok' && outcome.retryable,
      now: this.#isoNow(),
    });

    if (outcome.kind === 'ok') {
      await this.repository.completeOutbox(record, this.options.owner, this.#isoNow());
      this.#log('info', 'outbox entry dispatched', record, {
        deliveryId: delivery.id,
        externalMessageId: outcome.externalMessageId,
      });
      return 'sent';
    }

    if (outcome.kind === 'unknown') {
      // Possibly delivered. The entry is abandoned so nothing retries it
      // automatically, and the reserved slot is kept because the provider may
      // have spent it.
      await this.repository.abandonOutbox(
        record,
        this.options.owner,
        { code: outcome.code, reason: outcome.reason },
        this.#isoNow(),
      );
      this.#log('warn', 'outbox entry left for manual review after an unknown outcome', record, {
        deliveryId: delivery.id,
        failureCode: outcome.code,
      });
      return 'terminal';
    }

    if (!outcome.retryable) {
      // A definite rejection means the customer did not receive the message, so
      // the reserved slot goes back — now that the attempt recording it is
      // durable.
      await this.repository.releaseQuotaSlot(key, this.#isoNow());
      await this.repository.abandonOutbox(
        record,
        this.options.owner,
        { code: outcome.code, reason: outcome.reason },
        this.#isoNow(),
      );
      this.#log('warn', 'outbox entry abandoned after a non-retryable failure', record, {
        deliveryId: delivery.id,
        failureCode: outcome.code,
      });
      return 'terminal';
    }

    await this.repository.releaseQuotaSlot(key, this.#isoNow());
    const released = await this.repository.releaseOutbox(
      record,
      this.options.owner,
      { code: outcome.code, reason: outcome.reason },
      this.#isoNow(),
    );
    this.#log('info', 'outbox entry rescheduled after a retryable failure', record, {
      deliveryId: delivery.id,
      failureCode: outcome.code,
      outcome: released?.status === 'abandoned' ? 'abandoned' : 'retried',
    });
    return released?.status === 'abandoned' ? 'terminal' : 'retried';
  }

  /**
   * Settle a claimed entry after the provider was called but the outcome could
   * not be written down.
   *
   * The message may already be with the customer, so the guidance the loop
   * follows for an `unknown` outcome applies here too: stop, leave it for a
   * human, and release nothing. The retry release path — the one that reschedules
   * an entry for another attempt — is *never* called from here, because
   * rescheduling is precisely what would deliver a second copy.
   *
   * A provider-accepted outcome is closed as dispatched when that write succeeds,
   * since there is nothing to review; anything else is abandoned with the
   * platform's own reason. Both writes are best-effort: if the database is the
   * thing that failed, they fail too, and the entry is recovered by its lease
   * expiring — the next claim then reconciles it against the delivery state.
   *
   * @param record - The claimed entry.
   * @param outcome - The outcome that could not be recorded.
   * @returns `'sent'` when the entry was closed, otherwise `'terminal'`.
   */
  async #settleAfterProviderFailure(
    record: ChannelOutboxLeaseRecord,
    outcome: SendOutcome,
  ): Promise<ItemOutcome> {
    if (outcome.kind === 'ok' && (await this.#completeSafely(record))) {
      this.#log(
        'info',
        'closed an outbox entry the provider accepted after a failed write-back',
        record,
        {
          deliveryId: record.deliveryId,
        },
      );
      return 'sent';
    }
    await this.#abandonSafely(record, {
      code: outcome.kind === 'ok' ? 'channel_delivery_unknown' : outcome.code,
      reason:
        outcome.kind === 'ok'
          ? 'the provider accepted the message but the outcome could not be recorded; left for manual review'
          : 'the provider was called but the outcome could not be recorded, so the message may have been delivered; left for manual review',
    });
    return 'terminal';
  }

  /** Close a claimed entry as dispatched, absorbing a write failure. */
  async #completeSafely(record: ChannelOutboxLeaseRecord): Promise<boolean> {
    try {
      return await this.repository.completeOutbox(record, this.options.owner, this.#isoNow());
    } catch (error: unknown) {
      this.#logger.logStructured(
        'error',
        'could not close an outbox entry the provider accepted; its lease will be recovered on expiry',
        { outboxId: record.id, error: errorName(error) },
        'OutboxProcessor',
      );
      return false;
    }
  }

  /**
   * Abandon a claimed entry, absorbing a write failure.
   *
   * Used only after the provider was called: the entry must not be rescheduled,
   * so if even the abandon cannot be written the lease is left to expire, and the
   * next claim reconciles the entry against the delivery state.
   */
  async #abandonSafely(record: ChannelOutboxLeaseRecord, failure: OutboxFailure): Promise<void> {
    try {
      await this.repository.abandonOutbox(record, this.options.owner, failure, this.#isoNow());
    } catch (error: unknown) {
      this.#logger.logStructured(
        'error',
        'could not abandon a dispatched outbox entry; its lease will be recovered on expiry',
        { outboxId: record.id, error: errorName(error) },
        'OutboxProcessor',
      );
    }
  }

  /**
   * Give back a reserved slot on a path where the provider was never called.
   *
   * The reservation was made by this Worker moments ago and the message was not
   * sent, so the slot is exactly the one this call returns — and a failure to
   * return it is logged, not thrown, because the entry is no longer this Worker's
   * to settle.
   */
  async #releaseQuotaSafely(record: ChannelOutboxLeaseRecord, key: QuotaWindowKey): Promise<void> {
    try {
      await this.repository.releaseQuotaSlot(key, this.#isoNow());
    } catch (error: unknown) {
      this.#logger.logStructured(
        'error',
        'could not release a reserved reply slot; the window keeps it reserved',
        { outboxId: record.id, tenantId: record.tenantId, error: errorName(error) },
        'OutboxProcessor',
      );
    }
  }

  /**
   * Record one reply-window or budget refusal.
   *
   * No attempt row is written: the message never reached the provider, so there
   * is nothing to report about it there. The delivery records the degradation,
   * and the entry is released on the retry schedule — a window reopens when the
   * customer writes again, and the budget resets with it.
   */
  async #blocked(
    record: ChannelOutboxLeaseRecord,
    delivery: MessageDelivery,
    code: DeliveryFailureCode,
    reason: string,
  ): Promise<ItemOutcome> {
    const now = this.#isoNow();
    await this.repository.recordDegradation({
      tenantId: delivery.tenantId,
      deliveryId: delivery.id,
      failureCode: code,
      failureReason: reason,
      retryable: true,
      now,
    });
    const released = await this.repository.releaseOutbox(
      record,
      this.options.owner,
      { code, reason },
      now,
    );
    this.#log('info', 'outbox entry deferred by the reply window', record, {
      deliveryId: delivery.id,
      failureCode: code,
    });
    return released?.status === 'abandoned' ? 'terminal' : 'retried';
  }

  /**
   * Hand one delivery to the shared WeCom transport and classify the answer.
   *
   * The transport is the same one the API sends through, so the request this
   * builds and the request an API attempt would have built are produced by the
   * same code. The adapter's own single retry after an authentication failure
   * happens inside it; nothing here retries, because the retry *schedule* belongs
   * to the outbox entry.
   *
   * A throwing transport is read as "possibly delivered" — the same conservative
   * reading the API's loop uses — because it cannot say whether the provider
   * accepted the message.
   *
   * @param delivery - The delivery being attempted.
   * @param message - The logical platform message it points at.
   * @returns The classified outcome.
   */
  async sendToProvider(delivery: MessageDelivery, message: OutboxMessage): Promise<SendOutcome> {
    const input: SendMessageInput = {
      tenantId: delivery.tenantId,
      storeId: delivery.storeId,
      externalCustomerId: delivery.externalCustomerId,
      externalConversationId: delivery.externalConversationId,
      messageType: message.messageType,
      content: message.content,
      media: null,
      // The delivery is the correlation id, exactly as on the API path: one
      // logical message, one provider-facing identity, however many attempts.
      correlationId: delivery.id,
    };
    let result: ChannelResult<SendMessageResult>;
    try {
      result = await this.transport.sendMessage(input);
    } catch {
      return {
        kind: 'unknown',
        code: 'channel_delivery_unknown',
        reason: 'the provider transport threw before reporting an outcome',
        retryable: true,
      };
    }
    if (result.ok) {
      return { kind: 'ok', externalMessageId: result.value.externalMessageId };
    }
    const retryable = result.retryable ?? true;
    if (result.deliveryUnknown === true) {
      return {
        kind: 'unknown',
        code: result.code,
        reason: bounded(result.message, 'the provider response was lost'),
        retryable,
      };
    }
    return {
      kind: 'failed',
      code: result.code,
      reason: bounded(result.message, 'the provider rejected the message'),
      retryable,
    };
  }

  /**
   * Release a claimed entry, absorbing a secondary failure.
   *
   * Used on the paths where the entry could not even be prepared. If releasing
   * fails too — the database went away between the two statements — the lease is
   * simply left to expire, which recovers the entry without any further action.
   */
  async #releaseSafely(record: ChannelOutboxLeaseRecord, failure: OutboxFailure): Promise<void> {
    try {
      await this.repository.releaseOutbox(record, this.options.owner, failure, this.#isoNow());
    } catch (error: unknown) {
      this.#logger.logStructured(
        'error',
        'could not release a claimed outbox entry; its lease will be recovered on expiry',
        { outboxId: record.id, error: errorName(error) },
        'OutboxProcessor',
      );
    }
  }

  /** Build the reply-window key one delivery is gated by. */
  #windowKey(delivery: MessageDelivery): QuotaWindowKey {
    return {
      tenantId: delivery.tenantId,
      storeId: delivery.storeId,
      channel: delivery.channel,
      externalCustomerId: delivery.externalCustomerId,
    };
  }

  /** Current instant, from the injected clock. */
  #isoNow(): string {
    return new Date(this.#now()).toISOString();
  }

  /** Write one structured line about a claimed entry, without provider text. */
  #log(
    level: 'info' | 'warn',
    message: string,
    record: ChannelOutboxLeaseRecord,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    this.#logger.logStructured(
      level,
      message,
      {
        outboxId: record.id,
        tenantId: record.tenantId,
        storeId: record.storeId,
        attemptCount: record.attemptCount,
        ...fields,
      },
      'OutboxProcessor',
    );
  }
}

/** Internal classification of one provider send result. */
type SendOutcome =
  | { readonly kind: 'ok'; readonly externalMessageId: string }
  | {
      readonly kind: 'failed' | 'unknown';
      readonly code: DeliveryFailureCode;
      readonly reason: string;
      readonly retryable: boolean;
    };

/** Bound platform-authored text before it is persisted. */
function bounded(text: string | null | undefined, fallback: string): string {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  return trimmed.length <= MAX_REASON_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_REASON_LENGTH)}...`;
}

/**
 * A safe name for a thrown value.
 *
 * A driver error's `message` can carry the connection string it failed to use,
 * so only the error *class* is logged. That is enough to tell a timeout from a
 * constraint violation, and it cannot leak a credential.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
