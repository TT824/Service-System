/**
 * Stable API error contract.
 *
 * All HTTP error responses share one JSON shape:
 * `{ request_id, code, message, details }`. This module owns the shape and the
 * mapping from HTTP status codes to stable machine-readable codes.
 */

/** Stable machine-readable error codes exposed by the API. */
export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'request_timeout'
  | 'conflict'
  | 'unprocessable_entity'
  | 'too_many_requests'
  | 'internal_error'
  | 'bad_gateway'
  | 'service_unavailable'
  | 'gateway_timeout'
  | 'config_error'
  | 'channel_disabled'
  /**
   * The channel exists but is not configured for this deployment.
   *
   * Distinct from `service_unavailable`: the platform is running, the caller
   * did nothing wrong, and no other request would have succeeded either — a
   * provider account is unbound, or a credential is missing. Keeping it its own
   * code is what lets an operator tell "we never configured this" from "the
   * dependency is momentarily down".
   */
  | 'channel_not_configured';

/** Stable JSON shape for every API error response. */
export type ApiErrorBody = {
  readonly request_id: string;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details: ReadonlyArray<unknown>;
};

/** Input needed to build an API error body. */
export type ApiErrorBodyInput = {
  readonly requestId: string;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: ReadonlyArray<unknown>;
};

/**
 * Map an HTTP status code to the stable API error code.
 *
 * @param status - The HTTP status code.
 * @returns The corresponding stable error code.
 */
export function errorCodeForHttpStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 405:
      return 'method_not_allowed';
    case 408:
      return 'request_timeout';
    case 409:
      return 'conflict';
    case 422:
      return 'unprocessable_entity';
    case 429:
      return 'too_many_requests';
    case 502:
      return 'bad_gateway';
    case 503:
      return 'service_unavailable';
    case 504:
      return 'gateway_timeout';
    default:
      return 'internal_error';
  }
}

/**
 * Build a stable API error body.
 *
 * @param input - Request id, stable code, human-readable message and optional
 * details. Details are capped to a fixed size so clients cannot force an
 * unbounded response through framework validation output.
 * @returns A frozen error body.
 */
export function buildApiErrorBody(input: ApiErrorBodyInput): ApiErrorBody {
  const details = input.details ?? [];
  const cappedDetails = details.slice(0, MAX_DETAILS_ITEMS);
  return Object.freeze({
    request_id: input.requestId,
    code: input.code,
    message: input.message,
    details: Object.freeze(cappedDetails) as ReadonlyArray<unknown>,
  });
}

const MAX_DETAILS_ITEMS = 20;
