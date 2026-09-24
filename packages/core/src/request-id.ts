/**
 * Request identifier parsing and generation.
 *
 * Every HTTP request receives a request id that is propagated through logs,
 * responses and error bodies. A caller-supplied `X-Request-ID` is preserved
 * only when it satisfies the documented validation rule; otherwise a new id is
 * generated so that logs and headers can never contain attacker-controlled
 * characters such as newlines.
 */

declare const requestIdBrand: unique symbol;

/** A string that is known to satisfy the request id validation rule. */
export type RequestId = string & { readonly [requestIdBrand]: 'RequestId' };

/** The HTTP header used to carry the request id. */
export const REQUEST_ID_HEADER = 'x-request-id' as const;

/** Maximum length in characters of a trusted incoming request id. */
export const REQUEST_ID_MAX_LENGTH = 64 as const;

/** Characters allowed in a trusted incoming request id. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** Shape of the Web Crypto API subset this module relies on. */
type CryptoLike = {
  readonly randomUUID?: () => string;
  readonly getRandomValues?: (buffer: Uint8Array) => Uint8Array;
};

/**
 * Check whether a string is an acceptable trusted request id.
 *
 * @param value - The candidate string.
 * @returns `true` when the value is safe to echo back to clients and logs.
 */
export function isTrustedRequestId(value: string): value is RequestId {
  return value.length <= REQUEST_ID_MAX_LENGTH && REQUEST_ID_PATTERN.test(value);
}

/**
 * Parse an untrusted incoming request id.
 *
 * @param candidate - Raw header value from a client.
 * @returns The branded request id when the value is valid, otherwise `null`.
 */
export function parseTrustedRequestId(candidate: string): RequestId | null {
  if (!isTrustedRequestId(candidate)) {
    return null;
  }
  // SAFETY: isTrustedRequestId already matched REQUEST_ID_PATTERN and the
  // length cap. Callers cannot construct a RequestId except through this
  // parser, so the brand cannot be forged with invalid characters.
  return candidate as RequestId;
}

/**
 * Generate a fresh request id (a UUIDv4 string by default).
 *
 * @returns A branded request id that always satisfies the validation rule.
 */
export function generateRequestId(): RequestId {
  const value = uuidV4();
  // SAFETY: uuidV4 returns a 36-character string of lowercase hex digits and
  // hyphens, which always matches REQUEST_ID_PATTERN.
  return value as RequestId;
}

/**
 * Resolve the effective request id for a request.
 *
 * When the incoming header is present and valid it is preserved; otherwise a
 * new id is generated. Invalid input is never propagated.
 *
 * @param incoming - Optional raw `X-Request-ID` header value.
 * @returns The request id to use for this request.
 */
export function resolveRequestId(incoming: string | undefined): RequestId {
  if (incoming !== undefined) {
    const trusted = parseTrustedRequestId(incoming);
    if (trusted !== null) {
      return trusted;
    }
  }
  return generateRequestId();
}

function uuidV4(): string {
  const cryptoLike = globalThis as unknown as { readonly crypto?: CryptoLike };
  const webCrypto = cryptoLike.crypto;

  if (webCrypto?.randomUUID !== undefined) {
    return webCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (webCrypto?.getRandomValues !== undefined) {
    webCrypto.getRandomValues(bytes);
    return formatUuidV4(bytes);
  }

  // Last-resort fallback for exotic runtimes without Web Crypto. Request ids
  // are correlation tokens, not secrets, so this is not a security boundary.
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return formatUuidV4(bytes);
}

function formatUuidV4(bytes: Uint8Array): string {
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('request id buffer is too short');
  }
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const hexSegments = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ];
  return hexSegments.join('-');
}
