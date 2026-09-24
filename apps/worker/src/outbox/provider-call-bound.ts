/**
 * How long the bounded provider call may take, measured against the claim lease.
 *
 * The Worker holds a lease on an outbox entry while it delivers it. The lease is
 * what stops a second Worker from taking over the same attempt, so the send must
 * be *structurally* unable to outlive it: a call that could still be running
 * after the lease expired would be two Workers delivering one message, which is
 * the duplicate the whole lease exists to prevent.
 *
 * The send is bounded by configuration, not by hope. Each WeCom HTTP request
 * carries the configured deadline (`HEALTH_TIMEOUT_MS`), and one send makes at
 * most `@kefu/wecom`'s own published worst case of
 * {@link WECOM_MAX_REQUESTS_PER_SEND} requests — a token fetch plus the send,
 * replayed once after an authentication failure. Their product is the worst-case
 * duration of one provider call, and that product must fit inside the lease with
 * {@link OUTBOX_PROVIDER_CALL_HEADROOM_MS} to spare, which is the room the
 * processor needs to write the outcome back before anyone else may claim.
 *
 * {@link assertProviderCallWithinLease} is enforced at the composition root, so a
 * Worker configured with a deadline that cannot fit the lease fails to start
 * instead of starting and duplicating messages under load. The check is
 * arithmetic over two published constants and one configured value; it needs no
 * network and no database.
 */

import { CHANNEL_OUTBOX_LEASE_MS } from '@kefu/core';
import { WECOM_MAX_REQUESTS_PER_SEND } from '@kefu/wecom';

/**
 * Time the lease must keep beyond the worst-case provider call.
 *
 * The headroom is not slack: after the provider answers, the Worker still has to
 * append the attempt, move the delivery and settle the entry, and every one of
 * those is a database round trip that may be slow exactly when the provider was
 * slow. It is deliberately a fixed number of seconds rather than a fraction of
 * the lease, so a deployment that lengthens the lease does not silently lengthen
 * the send it permits.
 */
export const OUTBOX_PROVIDER_CALL_HEADROOM_MS = 15_000;

/**
 * Worst-case duration of one provider call at a given per-request deadline.
 *
 * @param requestTimeoutMs - Deadline each WeCom request carries.
 * @returns Milliseconds the bounded call may take, `0` for a non-positive deadline.
 */
export function providerCallBoundMs(requestTimeoutMs: number): number {
  const bounded =
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? Math.trunc(requestTimeoutMs) : 0;
  return WECOM_MAX_REQUESTS_PER_SEND * bounded;
}

/**
 * Largest per-request deadline whose bounded send still fits the lease.
 *
 * @param leaseMs - Lease length to fit the call inside.
 * @returns The largest permitted deadline in milliseconds.
 */
export function maxProviderRequestTimeoutMs(leaseMs: number = CHANNEL_OUTBOX_LEASE_MS): number {
  return Math.floor((leaseMs - OUTBOX_PROVIDER_CALL_HEADROOM_MS) / WECOM_MAX_REQUESTS_PER_SEND);
}

/**
 * Refuse a configuration whose bounded send could outlive the claim lease.
 *
 * @param requestTimeoutMs - The configured per-request deadline.
 * @param leaseMs - Lease length the claim takes.
 * @throws When the worst-case send does not leave
 *   {@link OUTBOX_PROVIDER_CALL_HEADROOM_MS} of the lease unused.
 */
export function assertProviderCallWithinLease(
  requestTimeoutMs: number,
  leaseMs: number = CHANNEL_OUTBOX_LEASE_MS,
): void {
  const bound = providerCallBoundMs(requestTimeoutMs);
  if (bound + OUTBOX_PROVIDER_CALL_HEADROOM_MS <= leaseMs) {
    return;
  }
  throw new Error(
    `worker configuration: one WeCom send may take up to ${bound}ms ` +
      `(${WECOM_MAX_REQUESTS_PER_SEND} requests of ${requestTimeoutMs}ms each) but the outbox lease is ` +
      `${leaseMs}ms and must keep ${OUTBOX_PROVIDER_CALL_HEADROOM_MS}ms of headroom for the write-back; ` +
      `set HEALTH_TIMEOUT_MS to at most ${maxProviderRequestTimeoutMs(leaseMs)}ms`,
  );
}
