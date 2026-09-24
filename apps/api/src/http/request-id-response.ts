import { generateRequestId, isTrustedRequestId, REQUEST_ID_HEADER } from '@kefu/core';

/** Minimal shape needed to read the response request id header. */
type HeaderReader = {
  getHeader(name: string): unknown;
};

/**
 * Read the request id that the middleware stored on the response header.
 *
 * When the header is absent or malformed a fresh id is generated so the body
 * shape always carries a usable request id.
 *
 * @param response - The HTTP response whose headers are being written.
 * @returns The request id to include in the body.
 */
export function requestIdFromResponse(response: HeaderReader): string {
  const value = response.getHeader(REQUEST_ID_HEADER);
  if (typeof value === 'string' && isTrustedRequestId(value)) {
    return value;
  }
  return generateRequestId();
}
