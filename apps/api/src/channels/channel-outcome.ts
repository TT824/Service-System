/**
 * Outcome values for the channel application boundary.
 *
 * A provider refusal, a malformed callback and a scope violation are *expected*
 * results of a channel operation, not defects. The adapter already returns them
 * as values ({@link ChannelResult}); the application service keeps them as
 * values too, so no expected failure is ever signalled by throwing through the
 * domain layer. Only the HTTP edge ({@link unwrapChannel}) turns an outcome into
 * the platform's stable error envelope.
 */

import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorCode, ChannelFailureCode } from '@kefu/core';

/** A successful channel operation. */
export type ChannelSuccess<T> = {
  readonly ok: true;
  readonly value: T;
};

/**
 * A refused channel operation carrying the HTTP status the edge must answer
 * with. Every code is one of the platform's stable error codes, so the response
 * envelope stays identical to the rest of the API.
 */
export type ChannelFailure = {
  readonly ok: false;
  readonly status: HttpStatus;
  readonly code: ApiErrorCode;
  readonly message: string;
};

/** Result of a channel application operation. */
export type ChannelOutcome<T> = ChannelSuccess<T> | ChannelFailure;

/**
 * Build a refused channel outcome.
 *
 * The refusal is not generic: a {@link ChannelFailure} is a member of
 * `ChannelOutcome<T>` for every `T`, so one value type-checks at every call site
 * and a helper that reports "no value" never has to name the value it did not
 * produce.
 *
 * @param status - HTTP status the edge should answer with.
 * @param code - Stable API error code for the envelope.
 * @param message - Human-readable, safe to expose.
 * @returns The refusal as a value.
 */
export function channelFailure(
  status: HttpStatus,
  code: ApiErrorCode,
  message: string,
): ChannelFailure {
  return { ok: false, status, code, message };
}

/**
 * Translate an outcome into the HTTP edge, throwing the platform exception.
 *
 * Expected refusals share one of the platform's stable API error codes, and the
 * global exception filter maps that code onto the documented
 * `{ request_id, code, message, details }` body.
 *
 * @param outcome - Outcome to unwrap.
 * @returns The success value.
 * @throws {HttpException} When the outcome is a refusal.
 */
export function unwrapChannel<T>(outcome: ChannelOutcome<T>): T {
  if (outcome.ok) {
    return outcome.value;
  }
  throw new HttpException({ code: outcome.code, message: outcome.message }, outcome.status);
}

/**
 * Translate a provider-facing failure code into the HTTP edge.
 *
 * An adapter reports why it refused with one of the platform's stable
 * {@link ChannelFailureCode} values; the HTTP boundary needs a status and one of
 * the platform's stable API codes. Keeping the mapping in one table is what
 * stops the same adapter failure from being answered with a different status on
 * a different route, which is how a provider outage ends up looking like a
 * caller mistake.
 *
 * @param failure - The adapter failure, as a value.
 * @returns The equivalent application outcome.
 */
export function channelFailureFromAdapter(failure: {
  readonly code: ChannelFailureCode;
  readonly message?: string | undefined;
}): ChannelFailure {
  const message = failure.message ?? 'the channel provider refused the operation';
  switch (failure.code) {
    case 'channel_disabled':
      return channelFailure(HttpStatus.SERVICE_UNAVAILABLE, 'channel_disabled', message);
    case 'channel_not_configured':
      // A channel the deployment never configured is not a transient outage, so
      // the stable `channel_not_configured` code is preserved end to end
      // instead of being flattened into `service_unavailable`.
      return channelFailure(HttpStatus.SERVICE_UNAVAILABLE, 'channel_not_configured', message);
    case 'channel_invalid_request':
      return channelFailure(HttpStatus.BAD_REQUEST, 'bad_request', message);
    case 'channel_provider_error':
    case 'channel_delivery_unknown':
      return channelFailure(HttpStatus.BAD_GATEWAY, 'bad_gateway', message);
  }
}

/**
 * Translate a *callback verification* failure into the HTTP edge.
 *
 * Two routes authenticate a callback with the provider's own signature rather
 * than a platform session — the `GET` callback URL handshake and the `POST`
 * webhook digest — and the same adapter refusal has to be answered the same way
 * on both, otherwise a client would have to guess which route it called from the
 * status alone. That single projection is:
 *
 * - **`401 unauthorized`** when the verifier refused the caller's request: a
 *   missing, forged or incomplete signature, or bytes it cannot read. The caller
 *   failed to authenticate, and no configuration change would have helped it.
 * - **`503 channel_not_configured`** when the channel itself is not configured:
 *   a missing credential, or an account no binding resolves. The caller did
 *   nothing wrong, and retrying changes nothing either.
 * - **the gateway mapping** ({@link channelFailureFromAdapter}) for a provider
 *   failure, so an outage still reads as an upstream problem rather than as the
 *   caller's mistake.
 *
 * @param failure - The adapter's verification refusal, as a value.
 * @returns The equivalent application outcome.
 */
export function channelFailureFromCallbackVerification(failure: {
  readonly code: ChannelFailureCode;
  readonly message?: string | undefined;
}): ChannelFailure {
  if (failure.code === 'channel_invalid_request') {
    return channelFailure(
      HttpStatus.UNAUTHORIZED,
      'unauthorized',
      failure.message ?? 'the channel callback signature was rejected',
    );
  }
  return channelFailureFromAdapter(failure);
}
