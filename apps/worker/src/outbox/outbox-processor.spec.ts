import { describe, expect, it } from 'vitest';
import {
  CHANNEL_OUTBOX_MAX_ATTEMPTS,
  advancesDeliveryStatus,
  channelOutboxClaimRefusal,
  claimChannelOutbox,
  isChannelOutboxLeaseActive,
  markChannelOutboxDispatched,
  outboxRetryDelayMs,
  releaseChannelOutboxAttempt,
  type ChannelOutboxLeaseRecord,
  type ChannelResult,
  type DeliveryAttempt,
  type DeliveryFailureCode,
  type MessageDelivery,
  type SendMessageInput,
  type SendMessageResult,
} from '@kefu/core';
import type { WecomOutboundTransport } from '@kefu/wecom';
import { OutboxProcessor } from './outbox-processor';
import type {
  OutboxFailure,
  OutboxMessage,
  OutboxRepository,
  ProviderAttemptInput,
  ProviderAttemptRecord,
  QuotaReservation,
  QuotaWindowKey,
} from './outbox-repository';

/**
 * Unit tests for the channel outbox delivery loop.
 *
 * The loop's whole job is a sequence of classification decisions, so what these
 * tests pin is that each provider outcome maps to the one durable state the
 * platform promises — and that the loop cannot be talked into a second delivery,
 * an unbounded retry or a stuck queue.
 *
 * The repository double is built from `@kefu/core`'s own claim, release and
 * dispatch functions rather than from a hand-written imitation: the double is
 * then incapable of disagreeing with the policy the durable adapter also
 * implements, so a failure here is a failure of the *loop*, never of the double.
 * The SQL that reproduces the same policy is proved separately, against a real
 * PostgreSQL, in `outbox-postgres.integration.spec.ts`.
 */

const NOW = Date.parse('2026-05-01T10:00:00.000Z');
const TENANT = 'tenant-outbox';
const STORE = 'store-outbox';
const CHANNEL = 'wecom';
const CUSTOMER = 'customer-outbox';

/** A repository double that applies the `@kefu/core` rules to plain maps. */
class FakeOutboxRepository implements OutboxRepository {
  readonly entries = new Map<string, ChannelOutboxLeaseRecord>();
  readonly deliveries = new Map<string, MessageDelivery>();
  readonly messages = new Map<string, OutboxMessage>();
  readonly windows = new Map<
    string,
    { windowEndsAt: string; reservedCount: number; limit: number }
  >();
  readonly attempts: ProviderAttemptInput[] = [];
  readonly degradations: Array<{ failureCode: DeliveryFailureCode; failureReason: string }> = [];
  /** Every claim the loop made, so a test can prove no second claim happened. */
  claimCount = 0;
  /**
   * Every claim *statement* the loop issued, whether or not it handed anything
   * over. A loop polling an empty queue leaves `claimCount` flat, so this is the
   * counter that can show it is still alive.
   */
  claimCalls = 0;
  releaseCount = 0;
  /** Every slot this fake was asked to give back, counted per reply window. */
  releaseQuotaCalls = 0;
  /** Every ownership re-validation the loop performed before sending. */
  renewCount = 0;
  /** Expiry the last renewal wrote, so a test can prove the lease was extended. */
  renewedExpiresAt: string | null = null;
  swept = 0;
  /** Fail the send for these delivery ids, to test per-item isolation. */
  readonly throwingDeliveries = new Set<string>();
  /** Fail the attempt write for these delivery ids, after the provider answered. */
  readonly failingAttempts = new Set<string>();
  /**
   * Take the claim away from the Worker at the moment it re-validates ownership,
   * which is the race the renewal exists to catch: the entry is re-leased to
   * another worker and the renewal must refuse.
   */
  loseLeaseOnRenew = false;

  seedOutbox(overrides: Partial<ChannelOutboxLeaseRecord> = {}): ChannelOutboxLeaseRecord {
    const record: ChannelOutboxLeaseRecord = {
      id: 'outbox-1',
      tenantId: TENANT,
      storeId: STORE,
      deliveryId: 'delivery-1',
      messageId: 'message-1',
      status: 'pending',
      attemptCount: 0,
      availableAt: new Date(NOW).toISOString(),
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastFailureCode: null,
      lastFailureReason: null,
      ...overrides,
    };
    this.entries.set(record.id, record);
    this.seedDelivery({ id: record.deliveryId, messageId: record.messageId });
    this.messages.set(record.messageId, {
      id: record.messageId,
      tenantId: record.tenantId,
      messageType: 'text',
      content: '请稍等，我帮您查一下',
    });
    return record;
  }

  seedDelivery(overrides: Partial<MessageDelivery> = {}): MessageDelivery {
    const delivery: MessageDelivery = {
      id: 'delivery-1',
      tenantId: TENANT,
      storeId: STORE,
      conversationId: 'conversation-1',
      messageId: 'message-1',
      channel: CHANNEL,
      externalCustomerId: CUSTOMER,
      externalConversationId: `wkOUTBOX01:${CUSTOMER}`,
      status: 'pending',
      externalMessageId: null,
      attemptCount: 0,
      failureCode: null,
      failureReason: null,
      retryable: false,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      ...overrides,
    };
    this.deliveries.set(delivery.id, delivery);
    return delivery;
  }

  /** Open a reply window that allows `limit - reserved` more messages. */
  openWindow(options: { readonly limit?: number; readonly reserved?: number } = {}): void {
    this.windows.set(this.windowKey(), {
      windowEndsAt: new Date(NOW + 48 * 60 * 60 * 1000).toISOString(),
      reservedCount: options.reserved ?? 0,
      limit: options.limit ?? 5,
    });
  }

  windowKey(): string {
    return `${TENANT}:${STORE}:${CHANNEL}:${CUSTOMER}`;
  }

  async claimDue(
    owner: string,
    now: string,
    limit: number,
  ): Promise<ReadonlyArray<ChannelOutboxLeaseRecord>> {
    this.claimCalls += 1;
    const claimed: ChannelOutboxLeaseRecord[] = [];
    const candidates = [...this.entries.values()]
      .filter((record) => channelOutboxClaimRefusal(record, now) === null)
      .sort((left, right) =>
        left.availableAt === right.availableAt
          ? left.id.localeCompare(right.id)
          : left.availableAt.localeCompare(right.availableAt),
      )
      .slice(0, limit);
    for (const candidate of candidates) {
      const claim = claimChannelOutbox(candidate, owner, now);
      if (claim.claimed) {
        this.entries.set(candidate.id, claim.record);
        claimed.push(claim.record);
        this.claimCount += 1;
      }
    }
    return claimed;
  }

  async sweepExhausted(now: string): Promise<number> {
    let abandoned = 0;
    for (const [id, record] of this.entries) {
      if (
        record.status === 'pending' &&
        record.attemptCount >= CHANNEL_OUTBOX_MAX_ATTEMPTS &&
        !isChannelOutboxLeaseActive(record, now)
      ) {
        this.entries.set(id, { ...record, status: 'abandoned' });
        abandoned += 1;
      }
    }
    this.swept += abandoned;
    return abandoned;
  }

  async renewOutboxLease(
    record: ChannelOutboxLeaseRecord,
    owner: string,
    now: string,
  ): Promise<ChannelOutboxLeaseRecord | undefined> {
    this.renewCount += 1;
    const current = this.entries.get(record.id);
    if (current === undefined || current.status !== 'pending' || current.leaseOwner !== owner) {
      return undefined;
    }
    if (this.loseLeaseOnRenew) {
      // Another worker took the claim over: the renewal must refuse, and the
      // entry now belongs to that worker.
      this.entries.set(record.id, { ...current, leaseOwner: 'worker-other', updatedAt: now });
      return undefined;
    }
    const renewed: ChannelOutboxLeaseRecord = {
      ...current,
      leaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
      updatedAt: now,
    };
    this.renewedExpiresAt = renewed.leaseExpiresAt;
    this.entries.set(record.id, renewed);
    return renewed;
  }

  async completeOutbox(
    record: ChannelOutboxLeaseRecord,
    owner: string,
    now: string,
  ): Promise<boolean> {
    const current = this.entries.get(record.id);
    if (current === undefined) {
      return false;
    }
    const dispatched = markChannelOutboxDispatched(current, owner, now);
    if (dispatched === undefined) {
      return false;
    }
    this.entries.set(record.id, dispatched);
    return true;
  }

  async releaseOutbox(
    record: ChannelOutboxLeaseRecord,
    owner: string,
    failure: OutboxFailure,
    now: string,
  ): Promise<ChannelOutboxLeaseRecord | undefined> {
    const current = this.entries.get(record.id);
    if (current === undefined) {
      return undefined;
    }
    const released = releaseChannelOutboxAttempt(current, owner, failure, now);
    if (released === undefined) {
      return undefined;
    }
    this.entries.set(record.id, released);
    this.releaseCount += 1;
    return released;
  }

  async abandonOutbox(
    record: ChannelOutboxLeaseRecord,
    owner: string,
    failure: OutboxFailure,
    now: string,
  ): Promise<boolean> {
    const current = this.entries.get(record.id);
    if (current === undefined || current.status !== 'pending' || current.leaseOwner !== owner) {
      return false;
    }
    this.entries.set(record.id, {
      ...current,
      status: 'abandoned',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastFailureCode: failure.code,
      lastFailureReason: failure.reason,
      updatedAt: now,
    });
    return true;
  }

  async getDelivery(tenantId: string, deliveryId: string): Promise<MessageDelivery | undefined> {
    const delivery = this.deliveries.get(deliveryId);
    return delivery !== undefined && delivery.tenantId === tenantId ? delivery : undefined;
  }

  async getMessage(tenantId: string, messageId: string): Promise<OutboxMessage | undefined> {
    const message = this.messages.get(messageId);
    return message !== undefined && message.tenantId === tenantId ? message : undefined;
  }

  async getQuotaWindow(key: QuotaWindowKey) {
    const window = this.windows.get(
      `${key.tenantId}:${key.storeId}:${key.channel}:${key.externalCustomerId}`,
    );
    if (window === undefined) {
      return undefined;
    }
    return {
      id: 'window-1',
      tenantId: key.tenantId,
      storeId: key.storeId,
      channel: key.channel,
      externalCustomerId: key.externalCustomerId,
      windowStartedAt: new Date(NOW).toISOString(),
      windowEndsAt: window.windowEndsAt,
      messageLimit: window.limit,
      reservedCount: window.reservedCount,
      updatedAt: new Date(NOW).toISOString(),
    };
  }

  async reserveQuotaSlot(key: QuotaWindowKey, now: string): Promise<QuotaReservation> {
    const window = this.windows.get(
      `${key.tenantId}:${key.storeId}:${key.channel}:${key.externalCustomerId}`,
    );
    if (window === undefined) {
      return {
        ok: false,
        code: 'window_missing',
        reason: 'no inbound customer message has opened a reply window for this customer',
      };
    }
    if (Date.parse(now) >= Date.parse(window.windowEndsAt)) {
      return { ok: false, code: 'window_expired', reason: 'the 48-hour reply window closed' };
    }
    if (window.reservedCount >= window.limit) {
      return { ok: false, code: 'quota_exceeded', reason: 'the reply budget is exhausted' };
    }
    window.reservedCount += 1;
    const reserved = await this.getQuotaWindow(key);
    if (reserved === undefined) {
      throw new Error('fake invariant: the reserved window disappeared');
    }
    return { ok: true, window: reserved };
  }

  async releaseQuotaSlot(key: QuotaWindowKey, _now: string): Promise<void> {
    this.releaseQuotaCalls += 1;
    const window = this.windows.get(
      `${key.tenantId}:${key.storeId}:${key.channel}:${key.externalCustomerId}`,
    );
    if (window !== undefined) {
      window.reservedCount = Math.max(window.reservedCount - 1, 0);
    }
  }

  async appendProviderAttempt(input: ProviderAttemptInput): Promise<ProviderAttemptRecord> {
    const delivery = this.deliveries.get(input.deliveryId);
    if (delivery === undefined) {
      throw new Error('fake invariant: delivery not found');
    }
    if (this.failingAttempts.has(input.deliveryId)) {
      // The write a database outage would refuse: the provider has already
      // answered, so the caller must not treat this as an ordinary failure.
      throw new Error('simulated database outage while recording the attempt');
    }
    const attemptNumber = delivery.attemptCount + 1;
    const attempt: DeliveryAttempt = {
      id: `attempt-${input.deliveryId}-${attemptNumber}`,
      tenantId: input.tenantId,
      deliveryId: input.deliveryId,
      attemptNumber,
      status: input.status,
      externalMessageId: input.externalMessageId,
      failureCode: input.failureCode,
      failureReason: input.failureReason,
      retryable: input.retryable,
      attemptedAt: input.now,
    };
    const next: MessageDelivery = {
      ...delivery,
      status: advancesDeliveryStatus(delivery.status, input.status)
        ? input.status
        : delivery.status,
      externalMessageId: input.externalMessageId ?? delivery.externalMessageId,
      attemptCount: attemptNumber,
      failureCode: input.failureCode,
      failureReason: input.failureReason,
      retryable: input.retryable,
      updatedAt: input.now,
    };
    this.deliveries.set(input.deliveryId, next);
    this.attempts.push(input);
    return { attempt, delivery: next };
  }

  async recordDegradation(input: {
    readonly tenantId: string;
    readonly deliveryId: string;
    readonly failureCode: DeliveryFailureCode;
    readonly failureReason: string;
    readonly retryable: boolean;
    readonly now: string;
  }): Promise<MessageDelivery | undefined> {
    const delivery = this.deliveries.get(input.deliveryId);
    if (delivery === undefined || delivery.status === 'sent') {
      return undefined;
    }
    this.degradations.push({
      failureCode: input.failureCode,
      failureReason: input.failureReason,
    });
    const next: MessageDelivery = {
      ...delivery,
      status: 'pending',
      failureCode: input.failureCode,
      failureReason: input.failureReason,
      retryable: input.retryable,
      updatedAt: input.now,
    };
    this.deliveries.set(input.deliveryId, next);
    return next;
  }
}

/** A transport that answers with a scripted result and records every request. */
class ScriptedTransport implements WecomOutboundTransport {
  readonly calls: SendMessageInput[] = [];
  #answer: () => ChannelResult<SendMessageResult>;

  constructor(answer: () => ChannelResult<SendMessageResult>) {
    this.#answer = answer;
  }

  answerWith(answer: () => ChannelResult<SendMessageResult>): void {
    this.#answer = answer;
  }

  async sendMessage(input: SendMessageInput): Promise<ChannelResult<SendMessageResult>> {
    this.calls.push(input);
    return this.#answer();
  }
}

/**
 * A transport that holds its answer until the case releases it.
 *
 * The gate exists for the stop/restart case, which needs a delivery that is *in
 * flight* while `stop()` runs. {@link ScriptedTransport} answers in a microtask,
 * so a tick built on it is over before a case could interleave anything with it.
 */
class GatedTransport implements WecomOutboundTransport {
  readonly calls: SendMessageInput[] = [];
  readonly entered: Promise<void>;
  #markEntered: () => void = () => undefined;
  #gate: Promise<void>;
  #openGate: () => void = () => undefined;

  constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.#markEntered = resolve;
    });
    this.#gate = new Promise<void>((resolve) => {
      this.#openGate = resolve;
    });
  }

  release(): void {
    this.#openGate();
  }

  async sendMessage(input: SendMessageInput): Promise<ChannelResult<SendMessageResult>> {
    this.calls.push(input);
    this.#markEntered();
    await this.#gate;
    return sendOk();
  }
}

/** A successful provider answer. */
function sendOk(externalMessageId = 'wecom-msg-1'): ChannelResult<SendMessageResult> {
  return { ok: true, value: { externalMessageId } };
}

/** A definite provider rejection, or an outcome the provider never confirmed. */
function sendFailure(
  options: { readonly retryable?: boolean; readonly deliveryUnknown?: boolean } = {},
): ChannelResult<SendMessageResult> {
  if (options.deliveryUnknown === true) {
    return {
      ok: false,
      code: 'channel_delivery_unknown',
      message: 'the provider response was lost',
      retryable: options.retryable ?? true,
      deliveryUnknown: true,
    };
  }
  return {
    ok: false,
    code: 'channel_provider_error',
    message: 'the provider rejected the message',
    retryable: options.retryable ?? true,
  };
}

/**
 * Build a processor over the double and a transport, with a fixed clock.
 *
 * The transport is the port's type rather than {@link ScriptedTransport}: the
 * processor takes any `WecomOutboundTransport`, and a case that needs the send
 * to be *held* ({@link GatedTransport}) is a case about the loop, not about the
 * scripted double.
 */
function buildProcessor(
  repository: FakeOutboxRepository,
  transport: WecomOutboundTransport,
  options: { readonly batchSize?: number; readonly pollIntervalMs?: number } = {},
) {
  return new OutboxProcessor(repository, transport, {
    owner: 'worker-test',
    pollIntervalMs: options.pollIntervalMs ?? 5,
    batchSize: options.batchSize ?? 10,
    now: () => NOW,
  });
}

describe('OutboxProcessor delivery outcomes', () => {
  it('sends a claimed entry once and closes it as dispatched', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    const transport = new ScriptedTransport(() => sendOk('wecom-msg-1'));
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ claimed: 1, sent: 1, retried: 0, terminal: 0 });
    expect(transport.calls).toHaveLength(1);
    // The request is the *existing* logical message, addressed to the existing
    // delivery — no second message, no second delivery.
    expect(transport.calls[0]).toMatchObject({
      tenantId: TENANT,
      storeId: STORE,
      externalCustomerId: CUSTOMER,
      externalConversationId: `wkOUTBOX01:${CUSTOMER}`,
      messageType: 'text',
      content: '请稍等，我帮您查一下',
      correlationId: 'delivery-1',
    });
    expect(repository.attempts).toHaveLength(1);
    expect(repository.attempts[0]).toMatchObject({
      status: 'sent',
      externalMessageId: 'wecom-msg-1',
      failureCode: null,
      retryable: false,
    });
    expect(repository.deliveries.get('delivery-1')).toMatchObject({
      status: 'sent',
      externalMessageId: 'wecom-msg-1',
      attemptCount: 1,
      retryable: false,
    });
    expect(repository.entries.get('outbox-1')).toMatchObject({
      status: 'dispatched',
      attemptCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastFailureCode: null,
    });
  });

  it('reschedules a definite retryable failure and gives the reserved slot back', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    const transport = new ScriptedTransport(() => sendFailure({ retryable: true }));
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ claimed: 1, sent: 0, retried: 1, terminal: 0 });
    expect(repository.deliveries.get('delivery-1')).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      retryable: true,
    });
    const entry = repository.entries.get('outbox-1');
    expect(entry).toMatchObject({ status: 'pending', attemptCount: 1, leaseOwner: null });
    // The schedule is the shared exponential backoff, measured from now.
    expect(entry?.availableAt).toBe(new Date(NOW + outboxRetryDelayMs(1)).toISOString());
    // The message definitely did not reach the customer, so the slot is free again.
    expect(repository.windows.get(repository.windowKey())?.reservedCount).toBe(0);
  });

  it('abandons a definite non-retryable failure without spending the rest of the budget', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    const transport = new ScriptedTransport(() => sendFailure({ retryable: false }));
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ claimed: 1, retried: 0, terminal: 1 });
    expect(repository.deliveries.get('delivery-1')).toMatchObject({
      status: 'failed',
      retryable: false,
      attemptCount: 1,
    });
    expect(repository.entries.get('outbox-1')).toMatchObject({
      status: 'abandoned',
      attemptCount: 1,
      leaseOwner: null,
    });

    // Terminal means terminal: another tick claims nothing.
    const second = await processor.runOnce();
    expect(second).toMatchObject({ claimed: 0, swept: 0 });
    expect(transport.calls).toHaveLength(1);
  });

  it('never auto-retries an unknown outcome and keeps the reserved slot', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    const transport = new ScriptedTransport(() => sendFailure({ deliveryUnknown: true }));
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ claimed: 1, terminal: 1 });
    expect(repository.attempts[0]).toMatchObject({ status: 'unknown', retryable: true });
    expect(repository.deliveries.get('delivery-1')).toMatchObject({ status: 'unknown' });
    expect(repository.entries.get('outbox-1')).toMatchObject({ status: 'abandoned' });
    // The provider may have accepted the message, so the budget stays spent.
    expect(repository.windows.get(repository.windowKey())?.reservedCount).toBe(1);

    const second = await processor.runOnce();
    expect(second.claimed).toBe(0);
    expect(transport.calls).toHaveLength(1);
  });

  it('treats a throwing transport as possibly delivered, not as a failure', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    const transport = new ScriptedTransport(() => {
      throw new Error('socket hang up');
    });
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ terminal: 1 });
    expect(repository.deliveries.get('delivery-1')).toMatchObject({ status: 'unknown' });
    expect(repository.entries.get('outbox-1')).toMatchObject({ status: 'abandoned' });
    expect(repository.windows.get(repository.windowKey())?.reservedCount).toBe(1);
  });

  it('refuses to send when the reply window has not opened, without calling the provider', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ claimed: 1, retried: 1 });
    expect(transport.calls).toHaveLength(0);
    expect(repository.attempts).toHaveLength(0);
    expect(repository.degradations).toHaveLength(1);
    expect(repository.degradations[0]?.failureCode).toBe('window_missing');
    expect(repository.entries.get('outbox-1')).toMatchObject({ status: 'pending' });
  });

  it('refuses to send when the reply budget is exhausted, without calling the provider', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow({ reserved: 5 });
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    await processor.runOnce();

    expect(transport.calls).toHaveLength(0);
    expect(repository.degradations[0]?.failureCode).toBe('quota_exceeded');
  });

  it('closes a stale entry whose delivery was already sent instead of sending twice', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    repository.seedDelivery({ id: 'delivery-1', status: 'sent', externalMessageId: 'wecom-msg-0' });
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ sent: 1 });
    expect(transport.calls).toHaveLength(0);
    expect(repository.entries.get('outbox-1')).toMatchObject({ status: 'dispatched' });
  });

  it('abandons an entry that keeps failing once its attempt budget is spent', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    const transport = new ScriptedTransport(() => sendFailure({ retryable: true }));
    const processor = buildProcessor(repository, transport);

    for (let tick = 1; tick <= CHANNEL_OUTBOX_MAX_ATTEMPTS; tick += 1) {
      // The entry is rescheduled into the future, so rewind it between ticks —
      // the double's clock is fixed, and this is the "time passed" step.
      const entry = repository.entries.get('outbox-1');
      if (entry !== undefined && entry.status === 'pending') {
        repository.entries.set('outbox-1', { ...entry, availableAt: new Date(NOW).toISOString() });
      }
      const result = await processor.runOnce();
      if (tick < CHANNEL_OUTBOX_MAX_ATTEMPTS) {
        expect(result).toMatchObject({ retried: 1, terminal: 0 });
      } else {
        // The claim spends the last attempt, so the release abandons in the same step.
        expect(result).toMatchObject({ retried: 0, terminal: 1 });
      }
    }

    expect(repository.attempts).toHaveLength(CHANNEL_OUTBOX_MAX_ATTEMPTS);
    expect(repository.entries.get('outbox-1')).toMatchObject({ status: 'abandoned' });
    expect(transport.calls).toHaveLength(CHANNEL_OUTBOX_MAX_ATTEMPTS);

    const after = await processor.runOnce();
    expect(after.claimed).toBe(0);
  });
});

describe('OutboxProcessor reconciles an already-resolved delivery before sending', () => {
  it('abandons an entry whose delivery the API already recorded as unknown', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    // The API's own attempt lost its provider response: the message may already
    // be with the customer, so the queued entry must not send it again.
    repository.seedDelivery({
      id: 'delivery-1',
      status: 'unknown',
      failureCode: 'channel_delivery_unknown',
      retryable: true,
      attemptCount: 1,
    });
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ claimed: 1, sent: 0, retried: 0, terminal: 1 });
    expect(transport.calls).toHaveLength(0);
    expect(repository.attempts).toHaveLength(0);
    // Nothing was reserved either: the send was refused before the window check.
    expect(repository.releaseQuotaCalls).toBe(0);
    expect(repository.windows.get(repository.windowKey())?.reservedCount).toBe(0);
    expect(repository.entries.get('outbox-1')).toMatchObject({
      status: 'abandoned',
      leaseOwner: null,
      lastFailureCode: 'channel_delivery_unknown',
    });

    // Terminal means terminal: a later tick still sends nothing.
    const second = await processor.runOnce();
    expect(second.claimed).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it('abandons an entry whose delivery already failed definitively', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    repository.seedDelivery({
      id: 'delivery-1',
      status: 'failed',
      failureCode: 'channel_provider_error',
      retryable: false,
      attemptCount: 2,
    });
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ terminal: 1 });
    expect(transport.calls).toHaveLength(0);
    expect(repository.windows.get(repository.windowKey())?.reservedCount).toBe(0);
    expect(repository.entries.get('outbox-1')).toMatchObject({
      status: 'abandoned',
      lastFailureCode: 'channel_provider_error',
    });
  });

  it('still sends a delivery that failed retryably', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    repository.seedDelivery({
      id: 'delivery-1',
      status: 'failed',
      failureCode: 'channel_provider_error',
      retryable: true,
      attemptCount: 1,
    });
    const transport = new ScriptedTransport(() => sendOk('wecom-msg-2'));
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ sent: 1 });
    expect(transport.calls).toHaveLength(1);
    // The retry appends to the *existing* delivery: one message, one delivery.
    expect(repository.attempts).toHaveLength(1);
    expect(repository.attempts[0]).toMatchObject({
      status: 'sent',
      externalMessageId: 'wecom-msg-2',
    });
    expect(repository.deliveries.get('delivery-1')).toMatchObject({
      attemptCount: 2,
      status: 'sent',
    });
    expect(repository.entries.get('outbox-1')).toMatchObject({ status: 'dispatched' });
  });
});

describe('OutboxProcessor ownership refresh and post-provider persistence', () => {
  it('re-validates and extends its claim immediately before the provider call', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    await processor.runOnce();

    expect(repository.renewCount).toBe(1);
    // The renewal hands the send a whole lease to run inside.
    expect(repository.renewedExpiresAt).toBe(new Date(NOW + 60_000).toISOString());
    expect(transport.calls).toHaveLength(1);
  });

  it('refuses to send when the claim was taken over while it prepared', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    repository.loseLeaseOnRenew = true;
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ sent: 0, retried: 0, terminal: 0 });
    // The provider was never called — that is the whole point of the check.
    expect(transport.calls).toHaveLength(0);
    expect(repository.attempts).toHaveLength(0);
    // The slot this Worker had reserved for itself goes back, because the send
    // it reserved it for never happened.
    expect(repository.releaseQuotaCalls).toBe(1);
    expect(repository.windows.get(repository.windowKey())?.reservedCount).toBe(0);
    // The entry now belongs to the worker that took it over, and this Worker did
    // not write to it.
    expect(repository.entries.get('outbox-1')).toMatchObject({
      status: 'pending',
      leaseOwner: 'worker-other',
    });
  });

  it('closes an entry the provider accepted when only the write-back failed', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    repository.failingAttempts.add('delivery-1');
    const transport = new ScriptedTransport(() => sendOk('wecom-msg-1'));
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    // The provider accepted the message, so the entry is closed rather than left
    // for review — and it is never rescheduled.
    expect(result).toMatchObject({ sent: 1, retried: 0, terminal: 0 });
    expect(transport.calls).toHaveLength(1);
    expect(repository.releaseCount).toBe(0);
    expect(repository.entries.get('outbox-1')).toMatchObject({ status: 'dispatched' });
    // The message was delivered, so the budget stays spent.
    expect(repository.releaseQuotaCalls).toBe(0);
    expect(repository.windows.get(repository.windowKey())?.reservedCount).toBe(1);
  });

  it('never reschedules or releases quota when a retryable answer cannot be recorded', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    repository.failingAttempts.add('delivery-1');
    const transport = new ScriptedTransport(() => sendFailure({ retryable: true }));
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ sent: 0, retried: 0, terminal: 1 });
    expect(transport.calls).toHaveLength(1);
    // The retry release path is never taken after the provider was called...
    expect(repository.releaseCount).toBe(0);
    // ...and nothing is given back, because the message may have been delivered.
    expect(repository.releaseQuotaCalls).toBe(0);
    expect(repository.windows.get(repository.windowKey())?.reservedCount).toBe(1);
    expect(repository.entries.get('outbox-1')).toMatchObject({
      status: 'abandoned',
      leaseOwner: null,
      lastFailureCode: 'channel_provider_error',
    });

    // Nothing claims it again, however many ticks run.
    const second = await processor.runOnce();
    expect(second.claimed).toBe(0);
    expect(transport.calls).toHaveLength(1);
  });

  it('never reschedules a definite failure whose outcome could not be recorded', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    repository.failingAttempts.add('delivery-1');
    const transport = new ScriptedTransport(() => sendFailure({ retryable: false }));
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ terminal: 1 });
    expect(repository.releaseCount).toBe(0);
    expect(repository.releaseQuotaCalls).toBe(0);
    expect(repository.entries.get('outbox-1')).toMatchObject({ status: 'abandoned' });
  });

  it('never reschedules when a thrown provider call cannot be recorded', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    repository.failingAttempts.add('delivery-1');
    const transport = new ScriptedTransport(() => {
      throw new Error('socket hang up');
    });
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ terminal: 1 });
    expect(repository.releaseCount).toBe(0);
    expect(repository.releaseQuotaCalls).toBe(0);
    expect(repository.entries.get('outbox-1')).toMatchObject({ status: 'abandoned' });
  });
});

describe('OutboxProcessor bounding, isolation and shutdown', () => {
  it('claims at most one batch and processes entries independently', async () => {
    const repository = new FakeOutboxRepository();
    for (let index = 0; index < 3; index += 1) {
      repository.seedOutbox({
        id: `outbox-${index}`,
        deliveryId: `delivery-${index}`,
        messageId: `message-${index}`,
      });
    }
    repository.openWindow();
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport, { batchSize: 2 });

    const result = await processor.runOnce();

    expect(result.claimed).toBe(2);
    expect(transport.calls).toHaveLength(2);
  });

  it('keeps going when one entry throws, and still writes its claim back', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox({ id: 'outbox-1', deliveryId: 'delivery-1', messageId: 'message-1' });
    repository.seedOutbox({ id: 'outbox-2', deliveryId: 'delivery-2', messageId: 'message-2' });
    repository.openWindow();
    // The first entry's delivery lookup blows up; the loop must still deliver
    // the second and must not leave the first one leased.
    const original = repository.getDelivery.bind(repository);
    repository.getDelivery = async (tenantId: string, deliveryId: string) => {
      if (deliveryId === 'delivery-1') {
        throw new Error('transient database failure');
      }
      return original(tenantId, deliveryId);
    };
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result.claimed).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.retried).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(repository.entries.get('outbox-1')).toMatchObject({
      status: 'pending',
      leaseOwner: null,
    });
    expect(repository.entries.get('outbox-2')).toMatchObject({ status: 'dispatched' });
  });

  it('recovers an entry left pending at the attempt bound by a dead worker', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox({ attemptCount: CHANNEL_OUTBOX_MAX_ATTEMPTS });
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result).toMatchObject({ claimed: 0, swept: 1 });
    expect(repository.entries.get('outbox-1')).toMatchObject({ status: 'abandoned' });
    expect(transport.calls).toHaveLength(0);
  });

  it('leaves an entry with a live lease to its owner', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox({
      leaseOwner: 'worker-other',
      leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
    });
    repository.openWindow();
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result.claimed).toBe(0);
    expect(transport.calls).toHaveLength(0);
    expect(repository.claimCount).toBe(0);
  });

  it('recovers an entry whose lease expired', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox({
      leaseOwner: 'worker-dead',
      leaseExpiresAt: new Date(NOW - 1_000).toISOString(),
      attemptCount: 1,
    });
    repository.openWindow();
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    const result = await processor.runOnce();

    expect(result.claimed).toBe(1);
    expect(repository.entries.get('outbox-1')).toMatchObject({
      status: 'dispatched',
      attemptCount: 2,
      leaseOwner: null,
    });
  });

  it('starts, polls and stops without leaving work in flight', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport, { pollIntervalMs: 1 });

    expect(processor.running).toBe(false);
    processor.start();
    expect(processor.running).toBe(true);

    // Let the loop deliver, then stop. `stop()` resolves only once the tick in
    // flight has written its claim back, so a shutdown never abandons an entry.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await processor.stop();

    expect(processor.running).toBe(false);
    expect(repository.entries.get('outbox-1')).toMatchObject({ status: 'dispatched' });
    expect(transport.calls).toHaveLength(1);
  });

  it('stops a loop that is idle between polls', async () => {
    const repository = new FakeOutboxRepository();
    const transport = new ScriptedTransport(() => sendOk());
    // A long poll interval: stopping must wake the wait rather than block on it.
    const processor = buildProcessor(repository, transport, { pollIntervalMs: 60_000 });

    processor.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await processor.stop();

    expect(processor.running).toBe(false);
  });

  it('stops the loop it found when a restart lands during the stop', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    // The delivery is held inside the transport, which is the window a
    // `start()` can land in: `stop()` has made `#running` false and is waiting
    // on the loop.
    const transport = new GatedTransport();
    const processor = buildProcessor(repository, transport, { pollIntervalMs: 1 });

    processor.start();
    await transport.entered;

    const stopping = processor.stop();
    processor.start();
    transport.release();

    // The stop returns for the loop it found. A loop that only ever asked
    // `#running` reads the restart as "keep going", stays alive beside its
    // replacement, and leaves this await — and the shutdown behind it — waiting
    // for ever. The race makes that a failed assertion rather than a case that
    // hangs: a red here names the interleaving, not the timeout.
    const settled = await Promise.race([
      stopping.then(() => 'stopped' as const),
      new Promise<'still-waiting'>((resolve) => {
        setTimeout(() => resolve('still-waiting'), 1_000);
      }),
    ]);
    expect(settled).toBe('stopped');

    // The restart was served, not ignored: the loop it started is polling, and
    // the handle `stop()` left behind still points at it. The delivery has been
    // sent by now, so the queue is empty and the claim hands nothing over — the
    // count that moves is the one of claim *statements*, not of claims made.
    expect(processor.running).toBe(true);
    const claimsBefore = repository.claimCalls;
    let polledAgain = false;
    for (let i = 0; i < 200 && !polledAgain; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      polledAgain = repository.claimCalls > claimsBefore;
    }
    expect(polledAgain).toBe(true);

    await processor.stop();
    expect(processor.running).toBe(false);
  });

  it('does not run two ticks at once', async () => {
    const repository = new FakeOutboxRepository();
    repository.seedOutbox();
    repository.openWindow();
    const transport = new ScriptedTransport(() => sendOk());
    const processor = buildProcessor(repository, transport);

    const [first, second] = await Promise.all([processor.runOnce(), processor.runOnce()]);

    expect(first.claimed + second.claimed).toBe(1);
    expect(transport.calls).toHaveLength(1);
  });
});
