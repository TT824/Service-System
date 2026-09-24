import type { Request } from 'express';

/**
 * Read the bearer token from an `Authorization` header.
 *
 * Only the `Bearer` scheme is accepted, the token must be a single
 * non-whitespace run, and the scheme is matched case-insensitively because
 * HTTP authentication schemes are case-insensitive.
 *
 * @param request - The incoming HTTP request.
 * @returns The presented token, or `undefined` when the request carries none.
 */
export function bearerTokenOf(request: Request): string | undefined {
  const header = request.header('authorization');
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1];
}
