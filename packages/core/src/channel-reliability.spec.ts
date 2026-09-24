import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  advanceWeComSyncCursor,
  advancesDeliveryStatus,
  canClaimWeComSyncCursor,
  CHANNEL_OUTBOX_LEASE_MS,
  CHANNEL_OUTBOX_MAX_ATTEMPTS,
  CHANNEL_OUTBOX_RETRY_BASE_MS,
  CHANNEL_OUTBOX_RETRY_MAX_MS,
  channelOutboxClaimRefusal,
  claimChannelOutbox,
  claimWeComSyncCursor,
  completeWeComSyncCursor,
  createWeComBinding,
  DELIVERY_WINDOW_HOURS,
  DELIVERY_WINDOW_MESSAGE_LIMIT,
  deliveryStatusForFailure,
  deliveryWindowEndsAt,
  evaluateDeliveryWindow,
  isChannelOutboxLeaseActive,
  isDeliveryRetryable,
  isWeComBindingActive,
  isWeComBindingStatus,
  isWeComSyncCursorPosition,
  isWeComSyncLeaseActive,
  markChannelOutboxDispatched,
  MESSAGE_DELIVERY_STATUSES,
  outboxRetryDelayMs,
  releaseChannelOutboxAttempt,
  releaseWeComSyncCursor,
  renewWeComSyncCursor,
  WECOM_BINDING_STATUSES,
  WECOM_SYNC_LEASE_MS,
  type ChannelOutboxLeaseRecord,
  type MessageDeliveryStatus,
  type SendQuotaWindow,
  type WeComBindingDraft,
  type WeComChannelBinding,
  type WeComSyncCursor,
} from './channel-reliability';

/** One open reply window for the tests below. */
function quotaWindow(overrides: Partial<SendQuotaWindow> = {}): SendQuotaWindow {
  const startedAt = '2026-09-10T00:00:00.000Z';
  return {
    id: 'window-1',
    tenantId: 'tenant-acme',
    storeId: 'store-acme-flagship',
    channel: 'wecom',
    externalCustomerId: 'customer-1',
    windowStartedAt: startedAt,
    windowEndsAt: deliveryWindowEndsAt(startedAt),
    messageLimit: DELIVERY_WINDOW_MESSAGE_LIMIT,
    reservedCount: 0,
    updatedAt: startedAt,
    ...overrides,
  };
}

describe('channel reliability model', () => {
  it('opens a 48-hour window from the latest inbound event', () => {
    expect(DELIVERY_WINDOW_HOURS).toBe(48);
    expect(deliveryWindowEndsAt('2026-09-10T00:00:00.000Z')).toBe('2026-09-12T00:00:00.000Z');
  });

  it('refuses a delivery when no inbound event opened a window', () => {
    expect(evaluateDeliveryWindow(undefined, '2026-09-10T01:00:00.000Z')).toEqual({
      allowed: false,
      code: 'window_missing',
      reason: expect.any(String),
    });
  });

  it('refuses a delivery once the window has closed', () => {
    const window = quotaWindow();
    expect(evaluateDeliveryWindow(window, '2026-09-12T00:00:00.000Z')).toMatchObject({
      allowed: false,
      code: 'window_expired',
    });
    expect(evaluateDeliveryWindow(window, '2026-09-11T23:59:59.000Z')).toMatchObject({
      allowed: true,
    });
  });

  it('treats the window as the end-exclusive interval [openedAt, openedAt + 48h)', () => {
    const window = quotaWindow();
    const endsAt = Date.parse(window.windowEndsAt);

    // The last millisecond inside the window is allowed and the first instant
    // outside it is not: the interval is half-open, and the boundary itself
    // belongs to the closed side.
    expect(evaluateDeliveryWindow(window, new Date(endsAt - 1).toISOString())).toMatchObject({
      allowed: true,
    });
    expect(evaluateDeliveryWindow(window, new Date(endsAt).toISOString())).toMatchObject({
      allowed: false,
      code: 'window_expired',
    });
    expect(evaluateDeliveryWindow(window, new Date(endsAt + 1).toISOString())).toMatchObject({
      allowed: false,
      code: 'window_expired',
    });

    // The open end of the interval is inside it: an event opened at `openedAt`
    // may be answered at that same instant.
    expect(evaluateDeliveryWindow(window, window.windowStartedAt)).toMatchObject({ allowed: true });

    // The window's own length is exactly 48 hours, whichever way it is measured.
    expect(endsAt - Date.parse(window.windowStartedAt)).toBe(
      DELIVERY_WINDOW_HOURS * 60 * 60 * 1000,
    );
  });

  it('refuses a delivery above the five-message budget', () => {
    const window = quotaWindow({ reservedCount: DELIVERY_WINDOW_MESSAGE_LIMIT });
    expect(evaluateDeliveryWindow(window, '2026-09-10T01:00:00.000Z')).toMatchObject({
      allowed: false,
      code: 'quota_exceeded',
    });
    expect(
      evaluateDeliveryWindow(
        quotaWindow({ reservedCount: DELIVERY_WINDOW_MESSAGE_LIMIT - 1 }),
        '2026-09-10T01:00:00.000Z',
      ),
    ).toMatchObject({ allowed: true });
  });

  it('distinguishes a definite failure from a lost provider response', () => {
    expect(deliveryStatusForFailure({ code: 'channel_provider_error' })).toBe('failed');
    expect(
      deliveryStatusForFailure({ code: 'channel_delivery_unknown', deliveryUnknown: true }),
    ).toBe('unknown');
  });

  it('only ever moves a delivery forward, with sent as the terminal state', () => {
    // Forward moves are allowed; a state never moves to itself or backwards.
    expect(advancesDeliveryStatus('pending', 'failed')).toBe(true);
    expect(advancesDeliveryStatus('pending', 'unknown')).toBe(true);
    expect(advancesDeliveryStatus('pending', 'sent')).toBe(true);
    expect(advancesDeliveryStatus('failed', 'unknown')).toBe(true);
    expect(advancesDeliveryStatus('failed', 'sent')).toBe(true);
    expect(advancesDeliveryStatus('unknown', 'sent')).toBe(true);

    // A late or stale notification is recorded but never applied: this is what
    // keeps a `sent` delivery from regressing when a failure arrives after the
    // provider already accepted the message.
    expect(advancesDeliveryStatus('sent', 'failed')).toBe(false);
    expect(advancesDeliveryStatus('sent', 'unknown')).toBe(false);
    expect(advancesDeliveryStatus('unknown', 'failed')).toBe(false);

    // Idempotent replay: an identical status is never an advance.
    for (const status of MESSAGE_DELIVERY_STATUSES) {
      expect(advancesDeliveryStatus(status, status)).toBe(false);
    }

    // Every state except `sent` is reachable from somewhere below it, so the
    // ordering above is total rather than accidentally strict.
    const reachable: ReadonlyArray<MessageDeliveryStatus> = MESSAGE_DELIVERY_STATUSES.filter(
      (target) => MESSAGE_DELIVERY_STATUSES.some((from) => advancesDeliveryStatus(from, target)),
    );
    expect(reachable).not.toContain('pending');
    expect(reachable).toHaveLength(MESSAGE_DELIVERY_STATUSES.length - 1);
  });

  it('shares one retry contract between the callback and the retry endpoint', () => {
    // `sent` is terminal and never retryable; a definite failure and a lost
    // response both are. The retry endpoint enforces exactly this predicate.
    expect(isDeliveryRetryable('pending')).toBe(true);
    expect(isDeliveryRetryable('failed')).toBe(true);
    expect(isDeliveryRetryable('unknown')).toBe(true);
    expect(isDeliveryRetryable('sent')).toBe(false);
  });
});

/** Shared instants: `NOW`, and the moment a lease taken at `NOW` has expired. */
const NOW = '2026-09-10T00:00:00.000Z';
const OWNER = 'worker-a';
const OTHER_OWNER = 'worker-b';
const AFTER_LEASE = new Date(Date.parse(NOW) + CHANNEL_OUTBOX_LEASE_MS).toISOString();

/** One durable account binding for the tests below. */
function binding(overrides: Partial<WeComChannelBinding> = {}): WeComChannelBinding {
  return {
    id: 'binding-1',
    tenantId: 'tenant-acme',
    storeId: 'store-acme-flagship',
    corpId: 'ww-acme',
    openKfId: 'wk-acme-service',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    disabledAt: null,
    ...overrides,
  };
}

/** One request to bind an account, as a caller makes it. */
function draftOf(overrides: Partial<WeComBindingDraft> = {}): WeComBindingDraft {
  return {
    tenantId: 'tenant-acme',
    storeId: 'store-acme-flagship',
    corpId: 'ww-acme',
    openKfId: 'wk-acme-service',
    enabled: true,
    ...overrides,
  };
}

/** One `kf/sync_msg` cursor row for the tests below. */
function syncCursor(overrides: Partial<WeComSyncCursor> = {}): WeComSyncCursor {
  return {
    id: 'cursor-1',
    tenantId: 'tenant-acme',
    bindingId: 'binding-1',
    cursor: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastSyncedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** One durable outbox entry, unclaimed, for the tests below. */
function outboxRecord(overrides: Partial<ChannelOutboxLeaseRecord> = {}): ChannelOutboxLeaseRecord {
  return {
    id: 'outbox-1',
    tenantId: 'tenant-acme',
    storeId: 'store-acme-flagship',
    deliveryId: 'delivery-1',
    messageId: 'message-1',
    status: 'pending',
    attemptCount: 0,
    availableAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastFailureCode: null,
    lastFailureReason: null,
    ...overrides,
  };
}

/** Claim for tests that need the claimed record; fails loudly on a refusal. */
function mustClaim(
  record: ChannelOutboxLeaseRecord,
  owner: string,
  now: string,
): ChannelOutboxLeaseRecord {
  const claim = claimChannelOutbox(record, owner, now);
  if (!claim.claimed) {
    throw new Error(`expected a claim, refused with ${claim.code}`);
  }
  return claim.record;
}

describe('wecom account binding', () => {
  it('keeps the binding states a boundary can read exact', () => {
    for (const status of WECOM_BINDING_STATUSES) {
      expect(isWeComBindingStatus(status)).toBe(true);
    }
    expect(isWeComBindingStatus('active')).toBe(true);
    expect(isWeComBindingStatus('disabled')).toBe(true);
    expect(isWeComBindingStatus('paused')).toBe(false);
    expect(isWeComBindingStatus('')).toBe(false);
  });

  it('distinguishes a disabled binding from the active one', () => {
    // A disabled binding is kept, not deleted, so the account stays rebindable
    // and the scope that held it stays auditable. Only the active row resolves a
    // callback, which is what the partial unique index in `0007` enforces.
    const active = binding();
    const disabled = binding({ status: 'disabled', disabledAt: AFTER_LEASE });

    expect(isWeComBindingActive(active)).toBe(true);
    expect(isWeComBindingActive(disabled)).toBe(false);
    expect(disabled.disabledAt).not.toBeNull();
    expect(disabled.tenantId).toBe(active.tenantId);
  });

  it('builds the row a request asks for, trimmed', () => {
    const built = createWeComBinding({
      id: 'binding-new',
      now: NOW,
      draft: {
        tenantId: '  tenant-acme  ',
        storeId: ' store-acme-flagship ',
        corpId: ' ww-acme ',
        openKfId: '\twk-acme-service\n',
        enabled: true,
      },
    });

    expect(built).toEqual({
      id: 'binding-new',
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      corpId: 'ww-acme',
      openKfId: 'wk-acme-service',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      disabledAt: null,
    });
    expect(built === undefined ? null : isWeComBindingActive(built)).toBe(true);
  });

  it('refuses a draft with a blank scope field instead of storing an unmatched row', () => {
    const complete: WeComBindingDraft = {
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      corpId: 'ww-acme',
      openKfId: 'wk-acme-service',
      enabled: true,
    };
    // Every field in turn, so a rule that only guarded the first one cannot pass.
    for (const field of ['tenantId', 'storeId', 'corpId', 'openKfId'] as const) {
      for (const blank of ['', '   ', '\t\n']) {
        const draft = { ...complete, [field]: blank };
        expect(createWeComBinding({ id: 'binding-new', draft, now: NOW })).toBeUndefined();
      }
    }
    expect(createWeComBinding({ id: 'binding-new', draft: complete, now: NOW })).toBeDefined();
  });

  it('builds one row from two requests that differ only in whitespace', () => {
    // This is the property the durable store's one-active-binding-per-account
    // index leans on: a near-duplicate has to collide with the stored row rather
    // than settle beside it as a second candidate for the same callback.
    const here = createWeComBinding({ id: 'binding-a', now: NOW, draft: draftOf() });
    const spaced = createWeComBinding({
      id: 'binding-b',
      now: NOW,
      draft: draftOf({ corpId: '  ww-acme  ', openKfId: ' wk-acme-service ' }),
    });

    expect(here === undefined ? null : here.corpId).toBe(spaced?.corpId);
    expect(here === undefined ? null : here.openKfId).toBe(spaced?.openKfId);
  });

  it('records a binding born switched off with the time it was made', () => {
    // `0007` holds `(status = 'disabled') = (disabled_at IS NOT NULL)`, so a
    // disabled row without a time is a state the table itself refuses.
    const built = createWeComBinding({
      id: 'binding-new',
      now: NOW,
      draft: draftOf({ enabled: false }),
    });

    expect(built?.status).toBe('disabled');
    expect(built?.disabledAt).toBe(NOW);
    expect(built === undefined ? null : isWeComBindingActive(built)).toBe(false);
  });
});

describe('wecom kf/sync_msg cursor ownership', () => {
  it('lets exactly one owner hold the cursor at a time', () => {
    const claimed = claimWeComSyncCursor(syncCursor(), OWNER, NOW);
    expect(claimed).toMatchObject({
      leaseOwner: OWNER,
      leaseExpiresAt: new Date(Date.parse(NOW) + WECOM_SYNC_LEASE_MS).toISOString(),
      cursor: null,
    });

    // A concurrent callback contends for the same cursor instead of pulling the
    // same window twice.
    expect(
      canClaimWeComSyncCursor(
        syncCursor({ leaseOwner: OWNER, leaseExpiresAt: AFTER_LEASE }),
        OTHER_OWNER,
        NOW,
      ),
    ).toBe(false);
    expect(
      claimWeComSyncCursor(
        syncCursor({ leaseOwner: OWNER, leaseExpiresAt: AFTER_LEASE }),
        OTHER_OWNER,
        NOW,
      ),
    ).toBeUndefined();

    // The owner may renew its own claim; the renewal pushes the expiry out.
    const renewed = claimWeComSyncCursor(
      syncCursor({ leaseOwner: OWNER, leaseExpiresAt: AFTER_LEASE }),
      OWNER,
      AFTER_LEASE,
    );
    expect(renewed?.leaseExpiresAt).toBe(
      new Date(Date.parse(AFTER_LEASE) + WECOM_SYNC_LEASE_MS).toISOString(),
    );
  });

  it('recovers the cursor of a pull that died', () => {
    const claimed = syncCursor({ leaseOwner: OWNER, leaseExpiresAt: AFTER_LEASE });
    // The lease is live until its expiry and dead from the expiry on, so the
    // failure of a worker is recoverable without a database transaction held
    // across the pull.
    expect(isWeComSyncLeaseActive(claimed, NOW)).toBe(true);
    expect(isWeComSyncLeaseActive(claimed, AFTER_LEASE)).toBe(false);
    expect(claimWeComSyncCursor(claimed, OTHER_OWNER, AFTER_LEASE)?.leaseOwner).toBe(OTHER_OWNER);
  });

  it('treats a lease without an expiry as unclaimed', () => {
    // The schema refuses this pair, so a row that carries it is read as
    // unclaimed rather than as a lock nobody can ever release.
    const halfWritten = syncCursor({ leaseOwner: OWNER, leaseExpiresAt: null });
    expect(isWeComSyncLeaseActive(halfWritten, NOW)).toBe(false);
    expect(canClaimWeComSyncCursor(halfWritten, OTHER_OWNER, NOW)).toBe(true);
  });

  it('advances the cursor only for the owner that still holds it', () => {
    const claimed = syncCursor({ leaseOwner: OWNER, leaseExpiresAt: AFTER_LEASE });

    expect(completeWeComSyncCursor(claimed, OTHER_OWNER, 'cursor-2', NOW)).toBeUndefined();
    expect(completeWeComSyncCursor(claimed, OWNER, 'cursor-2', NOW)).toEqual({
      ...claimed,
      cursor: 'cursor-2',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastSyncedAt: NOW,
      updatedAt: NOW,
    });
  });

  it('refuses a completion from a claim that was taken over', () => {
    // Owner A's lease lapsed while it was still working, owner B recovered the
    // cursor and claimed it. A's result is stale: applying it would rewind the
    // position B is pulling from, so compare-by-owner refuses it.
    const takenOver = syncCursor({
      leaseOwner: OTHER_OWNER,
      leaseExpiresAt: new Date(Date.parse(AFTER_LEASE) + WECOM_SYNC_LEASE_MS).toISOString(),
      cursor: 'cursor-from-b',
    });
    expect(completeWeComSyncCursor(takenOver, OWNER, 'stale-cursor', AFTER_LEASE)).toBeUndefined();
    expect(completeWeComSyncCursor(takenOver, OTHER_OWNER, 'cursor-3', AFTER_LEASE)?.cursor).toBe(
      'cursor-3',
    );
  });

  it('advances a page position while keeping the lease', () => {
    const claimed = syncCursor({
      leaseOwner: OWNER,
      leaseExpiresAt: AFTER_LEASE,
      cursor: 'cursor-1',
    });

    // A page that is durable moves the position and keeps the claim, so a pull
    // with more pages still owns the account.
    expect(advanceWeComSyncCursor(claimed, OTHER_OWNER, 'cursor-2', NOW)).toBeUndefined();
    expect(advanceWeComSyncCursor(claimed, OWNER, 'cursor-2', NOW)).toEqual({
      ...claimed,
      cursor: 'cursor-2',
      lastSyncedAt: NOW,
      updatedAt: NOW,
    });
    expect(advanceWeComSyncCursor(claimed, OWNER, 'cursor-2', NOW)?.leaseOwner).toBe(OWNER);

    // Nothing may advance the account to "no position": that would erase where
    // the binding has been pulled to and re-pull the backlog from the top.
    for (const blank of ['', '   ']) {
      expect(() => advanceWeComSyncCursor(claimed, OWNER, blank, NOW)).toThrow(/must not be blank/);
    }
    expect(isWeComSyncCursorPosition('cursor-2')).toBe(true);
    expect(isWeComSyncCursorPosition('')).toBe(false);
    expect(isWeComSyncCursorPosition('  ')).toBe(false);
    expect(isWeComSyncCursorPosition(null)).toBe(false);
    expect(isWeComSyncCursorPosition(7)).toBe(false);
  });

  it('renews only the lease of the owner that already holds it', () => {
    const claimed = syncCursor({ leaseOwner: OWNER, leaseExpiresAt: AFTER_LEASE });

    expect(renewWeComSyncCursor(claimed, OTHER_OWNER, NOW)).toBeUndefined();
    const renewed = renewWeComSyncCursor(claimed, OWNER, NOW);
    expect(renewed?.leaseExpiresAt).toBe(
      new Date(Date.parse(NOW) + WECOM_SYNC_LEASE_MS).toISOString(),
    );

    // An owner whose lease lapsed and was taken over cannot extend it back: the
    // renew is compare-by-owner, unlike the claim that recovers a dead lease.
    const takenOver = syncCursor({ leaseOwner: OTHER_OWNER, leaseExpiresAt: AFTER_LEASE });
    expect(renewWeComSyncCursor(takenOver, OWNER, NOW)).toBeUndefined();
    expect(() => renewWeComSyncCursor(claimed, ' ', NOW)).toThrow(/lease owner/);
  });

  it('releases an unsuccessful pull so the next caller resumes in place', () => {
    const claimed = syncCursor({
      leaseOwner: OWNER,
      leaseExpiresAt: AFTER_LEASE,
      cursor: 'cursor-1',
    });

    expect(releaseWeComSyncCursor(claimed, OTHER_OWNER, NOW)).toBeUndefined();
    expect(releaseWeComSyncCursor(claimed, OWNER, NOW)).toEqual({
      ...claimed,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: NOW,
    });
    // The position is untouched: the retry pulls the same window rather than
    // skipping it.
    expect(releaseWeComSyncCursor(claimed, OWNER, NOW)?.cursor).toBe('cursor-1');
  });

  it('refuses a lease owner that cannot be compared', () => {
    // An empty owner would make every compare-by-owner check succeed at once.
    expect(() => claimWeComSyncCursor(syncCursor(), '  ', NOW)).toThrow(/lease owner/);
    expect(() => completeWeComSyncCursor(syncCursor(), '', 'cursor-2', NOW)).toThrow(/lease owner/);
    expect(() => releaseWeComSyncCursor(syncCursor(), '', NOW)).toThrow(/lease owner/);
  });
});

describe('crash-safe outbox claiming', () => {
  it('claims a due entry and spends an attempt', () => {
    const claim = claimChannelOutbox(outboxRecord(), OWNER, NOW);
    expect(claim.claimed).toBe(true);
    expect(claim.claimed && claim.record).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      leaseOwner: OWNER,
      leaseExpiresAt: new Date(Date.parse(NOW) + CHANNEL_OUTBOX_LEASE_MS).toISOString(),
      availableAt: NOW,
      updatedAt: NOW,
    });
  });

  it('refuses a live claim another worker holds', () => {
    const held = outboxRecord({ leaseOwner: OWNER, leaseExpiresAt: AFTER_LEASE });
    expect(channelOutboxClaimRefusal(held, NOW)).toBe('lease_held');
    expect(claimChannelOutbox(held, OTHER_OWNER, NOW)).toEqual({
      claimed: false,
      code: 'lease_held',
      reason: expect.any(String),
    });
  });

  it('recovers an entry whose worker died', () => {
    const abandoned = outboxRecord({
      attemptCount: 1,
      leaseOwner: OWNER,
      leaseExpiresAt: AFTER_LEASE,
    });
    // The expired lease is not a refusal: it is the recovery path, so the entry
    // becomes claimable again without anyone holding a transaction open.
    expect(isChannelOutboxLeaseActive(abandoned, AFTER_LEASE)).toBe(false);
    expect(channelOutboxClaimRefusal(abandoned, AFTER_LEASE)).toBeNull();
    expect(mustClaim(abandoned, OTHER_OWNER, AFTER_LEASE).attemptCount).toBe(2);
  });

  it('refuses an entry that is not due, is terminal, or has no attempt left', () => {
    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    expect(channelOutboxClaimRefusal(outboxRecord({ availableAt: later }), NOW)).toBe('not_due');
    expect(channelOutboxClaimRefusal(outboxRecord({ status: 'dispatched' }), NOW)).toBe(
      'not_pending',
    );
    expect(channelOutboxClaimRefusal(outboxRecord({ status: 'abandoned' }), NOW)).toBe(
      'not_pending',
    );
    expect(
      channelOutboxClaimRefusal(outboxRecord({ attemptCount: CHANNEL_OUTBOX_MAX_ATTEMPTS }), NOW),
    ).toBe('attempts_exhausted');
    expect(
      channelOutboxClaimRefusal(
        outboxRecord({ attemptCount: CHANNEL_OUTBOX_MAX_ATTEMPTS - 1 }),
        NOW,
      ),
    ).toBeNull();
  });

  it('dispatches only for the owner that holds the claim', () => {
    const claimed = mustClaim(outboxRecord(), OWNER, NOW);

    expect(markChannelOutboxDispatched(claimed, OTHER_OWNER, NOW)).toBeUndefined();
    expect(markChannelOutboxDispatched(claimed, OWNER, NOW)).toMatchObject({
      status: 'dispatched',
      attemptCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it('reschedules a failed attempt while the budget has room', () => {
    const claimed = mustClaim(outboxRecord(), OWNER, NOW);

    // `availableAt` moves out by the backoff for one spent attempt, so the entry
    // cannot be claimed again immediately.
    const released = releaseChannelOutboxAttempt(
      claimed,
      OWNER,
      { code: 'channel_provider_error', reason: 'the provider refused the message' },
      NOW,
    );
    expect(released).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastFailureCode: 'channel_provider_error',
      lastFailureReason: 'the provider refused the message',
      availableAt: new Date(Date.parse(NOW) + CHANNEL_OUTBOX_RETRY_BASE_MS).toISOString(),
    });
    expect(channelOutboxClaimRefusal(released ?? outboxRecord(), NOW)).toBe('not_due');
  });

  it('abandons an entry once the attempt budget is spent', () => {
    const lastAttempt = mustClaim(
      outboxRecord({ attemptCount: CHANNEL_OUTBOX_MAX_ATTEMPTS - 1 }),
      OWNER,
      NOW,
    );
    expect(lastAttempt.attemptCount).toBe(CHANNEL_OUTBOX_MAX_ATTEMPTS);

    // The last attempt is spent by the claim, so the failure that follows leaves
    // nothing to retry with: the entry is abandoned in the same step instead of
    // sitting pending with no attempt left.
    const released = releaseChannelOutboxAttempt(
      lastAttempt,
      OWNER,
      { code: 'channel_provider_error', reason: 'the provider refused the message' },
      NOW,
    );
    expect(released).toMatchObject({
      status: 'abandoned',
      attemptCount: CHANNEL_OUTBOX_MAX_ATTEMPTS,
      leaseOwner: null,
      lastFailureCode: 'channel_provider_error',
    });
    expect(claimChannelOutbox(released ?? outboxRecord(), OWNER, NOW)).toMatchObject({
      claimed: false,
      code: 'not_pending',
    });
  });

  it('ignores a release from a worker that no longer owns the claim', () => {
    const reclaimed = outboxRecord({
      attemptCount: 2,
      leaseOwner: OTHER_OWNER,
      leaseExpiresAt: AFTER_LEASE,
    });
    expect(
      releaseChannelOutboxAttempt(
        reclaimed,
        OWNER,
        { code: 'channel_delivery_unknown', reason: 'the response was lost' },
        NOW,
      ),
    ).toBeUndefined();
    expect(
      releaseChannelOutboxAttempt(
        outboxRecord({ status: 'dispatched' }),
        OWNER,
        { code: 'channel_delivery_unknown', reason: 'the response was lost' },
        NOW,
      ),
    ).toBeUndefined();
  });

  it('bounds the retry delay and keeps it growing monotonically', () => {
    expect(outboxRetryDelayMs(0)).toBe(0);
    expect(outboxRetryDelayMs(1)).toBe(CHANNEL_OUTBOX_RETRY_BASE_MS);
    expect(outboxRetryDelayMs(2)).toBe(CHANNEL_OUTBOX_RETRY_BASE_MS * 2);

    let previous = 0;
    for (let attempts = 1; attempts <= 64; attempts += 1) {
      const delay = outboxRetryDelayMs(attempts);
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(CHANNEL_OUTBOX_RETRY_MAX_MS);
      previous = delay;
    }
    // A corrupted counter cannot overflow the cap.
    expect(outboxRetryDelayMs(Number.MAX_SAFE_INTEGER)).toBe(CHANNEL_OUTBOX_RETRY_MAX_MS);
  });

  it('refuses an empty claim owner', () => {
    expect(() => claimChannelOutbox(outboxRecord(), '', NOW)).toThrow(/lease owner/);
    expect(() => markChannelOutboxDispatched(outboxRecord(), ' ', NOW)).toThrow(/lease owner/);
    expect(() =>
      releaseChannelOutboxAttempt(
        outboxRecord(),
        '',
        { code: 'channel_disabled', reason: 'the channel is disabled' },
        NOW,
      ),
    ).toThrow(/lease owner/);
  });
});

/**
 * Migration expectations.
 *
 * The migration is SQL the platform has no schema model for, so the durable
 * shape `0007` promises is asserted against the files themselves, next to the
 * TypeScript that has to match it. Paths are resolved from the repository root,
 * which is the working directory the root vitest configuration runs from — the
 * same convention the database integration tests use.
 */
describe('migration 0007 schema expectations', () => {
  const MIGRATIONS_DIR = path.resolve(process.cwd(), 'database/migrations');
  const read = (fileName: string): string =>
    readFileSync(path.join(MIGRATIONS_DIR, fileName), 'utf8');
  const up = read('0007_wecom_binding_outbox_lease.up.sql');
  const down = read('0007_wecom_binding_outbox_lease.down.sql');

  it('declares one binding per provider account with a tenant/store scope', () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS wecom_channel_bindings/);
    expect(up).toMatch(/corp_id\s+TEXT NOT NULL/);
    expect(up).toMatch(/open_kfid\s+TEXT NOT NULL/);
    expect(up).toMatch(
      /status\s+TEXT NOT NULL DEFAULT 'active' CHECK \(status IN \('active', 'disabled'\)\)/,
    );
    expect(up).toMatch(/disabled_at TIMESTAMPTZ/);
    // "disabled" is auditable: it carries the moment it started applying.
    expect(up).toMatch(/CHECK \(\(status = 'disabled'\) = \(disabled_at IS NOT NULL\)\)/);
    // Tenant and store are separate foreign keys, exactly as `0006` declares
    // them: a composite reference would depend on a unique constraint `0003`
    // owns and has to stay free to drop, so reverting `0003` would suddenly
    // require reverting `0007` first.
    expect(up).toMatch(/tenant_id\s+TEXT NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE/);
    expect(up).toMatch(/store_id\s+TEXT NOT NULL REFERENCES stores\(id\) ON DELETE CASCADE/);
    expect(up).not.toMatch(/REFERENCES stores \(tenant_id, id\)/);
    // At most one *active* binding per account; disabled rows stay for audit.
    expect(up).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS wecom_channel_bindings_active_key\s+ON wecom_channel_bindings \(corp_id, open_kfid\)\s+WHERE status = 'active'/,
    );
  });

  it('declares one leased cursor per binding', () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS wecom_sync_cursors/);
    expect(up).toMatch(/binding_id\s+TEXT NOT NULL/);
    expect(up).toMatch(/CONSTRAINT wecom_sync_cursors_binding_id_key UNIQUE \(binding_id\)/);
    expect(up).toMatch(/lease_owner\s+TEXT/);
    expect(up).toMatch(/lease_expires_at TIMESTAMPTZ/);
    expect(up).toMatch(/CHECK \(lease_expires_at IS NULL OR lease_owner IS NOT NULL\)/);
    // A cursor belongs to a binding inside its own tenant and disappears with it.
    expect(up).toMatch(/REFERENCES wecom_channel_bindings \(tenant_id, id\) ON DELETE CASCADE/);
    // Due-lease scans stay tenant scoped, like every other access path here.
    expect(up).toMatch(
      /CREATE INDEX IF NOT EXISTS wecom_sync_cursors_tenant_lease_idx\s+ON wecom_sync_cursors \(tenant_id, lease_expires_at\)/,
    );
  });

  it('extends the outbox with nullable claim state and a due-work index', () => {
    // Additive and defaulted: every row `0006` wrote stays valid and unclaimed.
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS lease_owner\s+TEXT/);
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS lease_expires_at\s+TIMESTAMPTZ/);
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS last_failure_code\s+TEXT/);
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS last_failure_reason\s+TEXT/);
    expect(up).toMatch(
      /ADD CONSTRAINT channel_outbox_lease_pair_check\s+CHECK \(lease_expires_at IS NULL OR lease_owner IS NOT NULL\)/,
    );
    expect(up).toMatch(
      /CREATE INDEX IF NOT EXISTS channel_outbox_due_idx\s+ON channel_outbox \(available_at, lease_expires_at\)\s+WHERE status = 'pending'/,
    );
  });

  it('leaves 0006 and the outbox status set untouched', () => {
    // The status set is the contract the loop already runs on; `0007` adds state
    // beside it rather than replacing it.
    const channelReliability = read('0006_channel_reliability.up.sql');
    expect(channelReliability).toMatch(
      /status\s+TEXT NOT NULL CHECK \(status IN \('pending', 'dispatched', 'abandoned'\)\)/,
    );
    expect(channelReliability).toMatch(/CREATE TABLE IF NOT EXISTS channel_outbox/);
    expect(channelReliability).toMatch(/UNIQUE \(tenant_id, delivery_id\)/);

    // `0007` only adds to the outbox: nothing of `0006` is dropped or rewritten.
    expect(up).not.toMatch(
      /DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)[^;]*\b(inbound_events|message_deliveries|message_delivery_attempts|message_status_events|send_quota_windows|channel_outbox)\b/i,
    );
  });

  it('keeps the earlier migrations revertible', () => {
    // `0003`'s down file drops `stores_tenant_id_id_key`, and PostgreSQL refuses
    // to drop a constraint a foreign key depends on. Referencing the pair
    // `(tenant_id, id)` on a table this migration does not own would therefore
    // make reverting `0003` fail until `0007` was reverted first — a newer
    // migration must never hold an older one hostage.
    expect(up).not.toMatch(/stores_tenant_id_id_key/);
    expect(up).not.toMatch(/members_tenant_id_id_key/);
    // The only composite reference is the one inside this migration: the cursor
    // proves it belongs to its binding's tenant, and both objects are created and
    // dropped together.
    const compositeReferences = up.match(/FOREIGN KEY \(tenant_id, [a-z_]+\)/g) ?? [];
    expect(compositeReferences).toEqual(['FOREIGN KEY (tenant_id, binding_id)']);
  });

  it('is safe to re-run and reverts in dependency order', () => {
    // Re-run safety: every created object is guarded the way `0001`-`0006` are.
    expect(up).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(up).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(up).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
    expect(up).toMatch(
      /IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint WHERE conname = 'channel_outbox_lease_pair_check'/,
    );

    // The down file reverses exactly what the up file added...
    expect(down).toMatch(/DROP INDEX IF EXISTS channel_outbox_due_idx/);
    expect(down).toMatch(/DROP CONSTRAINT IF EXISTS channel_outbox_lease_pair_check/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS lease_owner/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS lease_expires_at/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS last_failure_code/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS last_failure_reason/);
    expect(down).toMatch(/DROP TABLE IF EXISTS wecom_sync_cursors/);
    expect(down).toMatch(/DROP TABLE IF EXISTS wecom_channel_bindings/);

    // ...in dependency order: the referencing table first, and never a `0006`
    // table, so a revert leaves the queued deliveries `0006` describes intact.
    expect(down.indexOf('DROP TABLE IF EXISTS wecom_sync_cursors')).toBeLessThan(
      down.indexOf('DROP TABLE IF EXISTS wecom_channel_bindings'),
    );
    expect(down).not.toMatch(
      /DROP TABLE IF EXISTS (inbound_events|message_deliveries|message_delivery_attempts|message_status_events|send_quota_windows|channel_outbox)/,
    );
  });
});
