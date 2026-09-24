import { describe, expect, it } from 'vitest';
import { CHANNEL_OUTBOX_LEASE_MS } from '@kefu/core';
import { WECOM_MAX_REQUESTS_PER_SEND } from '@kefu/wecom';
import {
  OUTBOX_PROVIDER_CALL_HEADROOM_MS,
  assertProviderCallWithinLease,
  maxProviderRequestTimeoutMs,
  providerCallBoundMs,
} from './provider-call-bound';

/**
 * The bound that keeps a send inside the claim that authorises it.
 *
 * This is arithmetic over two published constants and one configured value, so
 * what is worth pinning is the *comparison*: that the configured deadline cannot
 * be combined with the transport's replay path into a call that outlives the
 * lease, and that the refusal names a deadline a deployment can act on.
 */
describe('provider call bound', () => {
  it('bounds one send by the transport replay path and the per-request deadline', () => {
    expect(WECOM_MAX_REQUESTS_PER_SEND).toBe(4);
    expect(providerCallBoundMs(1_000)).toBe(4_000);
    expect(providerCallBoundMs(0)).toBe(0);
    expect(providerCallBoundMs(Number.NaN)).toBe(0);
  });

  it('accepts the documented default deadline', () => {
    expect(() => assertProviderCallWithinLease(1_000)).not.toThrow();
    // The default leaves most of the lease free, which is what the headroom is
    // for: the write-back after a slow provider answer.
    expect(providerCallBoundMs(1_000) + OUTBOX_PROVIDER_CALL_HEADROOM_MS).toBeLessThan(
      CHANNEL_OUTBOX_LEASE_MS,
    );
  });

  it('accepts the largest deadline that still fits and refuses the next one', () => {
    const limit = maxProviderRequestTimeoutMs();

    expect(() => assertProviderCallWithinLease(limit)).not.toThrow();
    expect(() => assertProviderCallWithinLease(limit + 1)).toThrow(/must keep/);
  });

  it('refuses a deadline that would let the send outlive the lease', () => {
    // The configuration parser permits deadlines far above this; the Worker is
    // the place that must refuse the combination.
    expect(() => assertProviderCallWithinLease(60_000)).toThrow(/HEALTH_TIMEOUT_MS/);
    expect(() => assertProviderCallWithinLease(60_000)).toThrow(/lease/);
  });
});
