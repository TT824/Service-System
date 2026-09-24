/**
 * The delivery-state gate the Worker applies *before* it prepares a send.
 *
 * The API records the truth about a delivery — an adapter outcome, a provider
 * status notification, a reply-window refusal — and the Worker reads that truth
 * back when it claims an outbox entry. Between those two moments the API may have
 * already learned the answer: the customer received the message, or the message
 * ended in a state the platform must never retry automatically. A Worker that
 * sent anyway would deliver a second copy or spend budget on an attempt the
 * delivery already recorded as forbidden.
 *
 * So the delivery state is reconciled *first*, before the reply window is read,
 * before a slot is reserved and before anything reaches the provider. Two
 * end states refuse the send:
 *
 * - **`sent`** — the message is already with the customer. The queue entry is
 *   stale (a retry raced a status callback) and is closed as dispatched.
 * - **`unknown`** — an earlier attempt lost its provider response, so the message
 *   may already be with the customer. Retrying could deliver it twice, and the
 *   platform's rule is that an unknown outcome is never retried automatically; it
 *   is left for a human.
 * - **`failed` with `retryable === false`** — the provider refused the message in
 *   a way that a further attempt would be refused identically (the reply limit,
 *   an invalid request, a rejected credential). Retrying spends a provider call
 *   and a budget slot to learn nothing.
 *
 * A delivery that is `pending`, or `failed` but still retryable, stays eligible:
 * those are exactly the states a retry is for, and the attempt bound on the
 * outbox entry keeps the retrying finite.
 *
 * The rule lives here, as a pure function over the delivery, rather than inside
 * the loop, so it can be read and tested as one statement of policy — and so the
 * loop cannot grow a second, subtly different copy of it on another branch.
 */

import type { DeliveryFailureCode, MessageDelivery } from '@kefu/core';

/**
 * Why a loaded delivery must not be handed to the provider.
 *
 * `already_sent` is separated from the two terminal failures because its
 * consequence is different: the entry is *closed* as dispatched rather than
 * abandoned, since nothing went wrong — the platform simply finished early.
 */
export type DeliverySendRefusal =
  | { readonly kind: 'already_sent' }
  | {
      readonly kind: 'terminal_failure';
      readonly code: DeliveryFailureCode;
      /** Platform-authored, stored on the entry. Never provider payload text. */
      readonly reason: string;
    };

/** Fallback code when a terminal delivery carries no failure code of its own. */
const TERMINAL_FAILURE_FALLBACK_CODE: DeliveryFailureCode = 'channel_provider_error';

/**
 * Decide whether a delivery the Worker has just loaded may be sent at all.
 *
 * @param delivery - The delivery the claimed outbox entry points at.
 * @returns The refusal, or `null` when the delivery is still eligible to send.
 */
export function deliverySendRefusal(delivery: MessageDelivery): DeliverySendRefusal | null {
  if (delivery.status === 'sent') {
    return { kind: 'already_sent' };
  }
  if (delivery.status === 'unknown') {
    return {
      kind: 'terminal_failure',
      code: delivery.failureCode ?? 'channel_delivery_unknown',
      reason:
        'the delivery already ended in a possibly-delivered state and is never retried automatically; left for manual review',
    };
  }
  if (delivery.status === 'failed' && !delivery.retryable) {
    return {
      kind: 'terminal_failure',
      code: delivery.failureCode ?? TERMINAL_FAILURE_FALLBACK_CODE,
      reason:
        'the delivery already failed definitively, so a further attempt would be refused identically; left for manual review',
    };
  }
  return null;
}
