/**
 * The cryptographic and XML boundary of an enterprise WeChat callback.
 *
 * Both the callback URL handshake and every message callback share one envelope
 * format, and the platform has to speak it byte for byte:
 *
 * - the digest is `sha1` over the four lexicographically sorted values
 *   `Token`, `timestamp`, `nonce` and the ciphertext (`echostr` on the
 *   handshake, the `Encrypt` element of the callback body otherwise);
 * - the payload is `AES-256-CBC` with `PKCS#7` padding, keyed by
 *   `Base64_Decode(EncodingAESKey + "=")` (32 bytes) with the first 16 bytes of
 *   that key as the IV;
 * - the plaintext is `random(16) || msg_len(4, big endian) || msg || $CorpID`.
 *
 * Everything here is a pure function over bytes and strings. There is no
 * network access, no credential storage and no logging: a failure is a value
 * carrying a reason, never a thrown error and never a printed payload, because
 * a failed decrypt is exactly the case where the input must not reach a log.
 */

import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

/** Length of the `EncodingAESKey` string before its Base64 `=` padding. */
const ENCODING_AES_KEY_LENGTH = 43;

/** Length of the AES key an `EncodingAESKey` decodes to. */
const AES_KEY_LENGTH = 32;

/** AES block size, which is also the IV length. */
const AES_BLOCK_SIZE = 16;

/** Length of the random prefix every WeCom plaintext starts with. */
const RANDOM_PREFIX_LENGTH = 16;

/** Length of the big-endian message length field that follows the prefix. */
const LENGTH_FIELD_LENGTH = 4;

/** Minimum decryptable plaintext: the prefix plus the length field. */
const MIN_PLAINTEXT_LENGTH = RANDOM_PREFIX_LENGTH + LENGTH_FIELD_LENGTH;

/** A successful decrypt: the message body and the trailing receiver id. */
export type WecomPlaintext = {
  readonly ok: true;
  /** The message body, with the random prefix, length and receiver id removed. */
  readonly message: string;
  /**
   * The id WeCom appended to the plaintext. A callback carries the corp id
   * here, and it is what proves the ciphertext was minted for this corp.
   */
  readonly receiveId: string;
};

/** A decrypt that could not produce a plaintext. */
export type WecomCryptoFailure = {
  readonly ok: false;
  /** Safe, non-secret explanation. Never contains a key, token or payload. */
  readonly reason: string;
};

/** Result of decrypting one WeCom payload. */
export type WecomDecryptResult = WecomPlaintext | WecomCryptoFailure;

/**
 * Compute the WeCom callback digest.
 *
 * The four values are sorted lexicographically as strings and concatenated
 * without separators; sorting is what makes the digest independent of the order
 * the provider happened to send them in.
 *
 * @param token - The callback `Token` shared with WeCom.
 * @param timestamp - The `timestamp` query parameter.
 * @param nonce - The `nonce` query parameter.
 * @param ciphertext - `echostr` on the handshake, `Encrypt` otherwise.
 * @returns The lowercase hexadecimal `sha1` digest.
 */
export function wecomSignature(
  token: string,
  timestamp: string,
  nonce: string,
  ciphertext: string,
): string {
  const digest = [token, timestamp, nonce, ciphertext].sort().join('');
  return createHash('sha1').update(digest, 'utf8').digest('hex');
}

/**
 * Compare two hexadecimal digests without leaking a prefix match through timing.
 *
 * @param expected - The digest the platform computed.
 * @param actual - The digest the caller supplied, or `null` when absent.
 * @returns `true` only when both are present and identical.
 */
export function signatureMatches(expected: string, actual: string | null): boolean {
  if (actual === null) {
    return false;
  }
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual.trim().toLowerCase(), 'utf8');
  if (expectedBytes.length !== actualBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, actualBytes);
}

/**
 * Decrypt one WeCom payload.
 *
 * @param encodingAesKey - The 43-character `EncodingAESKey`.
 * @param encrypted - Base64 ciphertext, as sent by WeCom.
 * @param expectedReceiveId - Whose plaintext this must be. Pass an empty
 * string to skip the check, which only the handshake may do — a message
 * callback must always prove it was minted for this corp.
 * @returns The plaintext, or a failure carrying a safe reason.
 */
export function decryptWecomPayload(
  encodingAesKey: string,
  encrypted: string,
  expectedReceiveId: string,
): WecomDecryptResult {
  if (encodingAesKey.length !== ENCODING_AES_KEY_LENGTH) {
    return { ok: false, reason: `EncodingAESKey must be ${ENCODING_AES_KEY_LENGTH} characters` };
  }
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  if (key.length !== AES_KEY_LENGTH) {
    return { ok: false, reason: `EncodingAESKey must decode to ${AES_KEY_LENGTH} bytes` };
  }

  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, AES_BLOCK_SIZE));
    // Node strips the PKCS#7 padding, which is what leaves the framed payload.
    plain = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  } catch {
    return { ok: false, reason: 'the payload is not a valid AES-256-CBC ciphertext' };
  }

  if (plain.length < MIN_PLAINTEXT_LENGTH) {
    return { ok: false, reason: 'the decrypted payload is shorter than its frame' };
  }
  const messageLength = plain.readUInt32BE(RANDOM_PREFIX_LENGTH);
  const messageStart = RANDOM_PREFIX_LENGTH + LENGTH_FIELD_LENGTH;
  const messageEnd = messageStart + messageLength;
  if (messageLength === 0 || messageEnd > plain.length) {
    return { ok: false, reason: 'the decrypted payload declares an out-of-range length' };
  }

  const receiveId = plain.subarray(messageEnd).toString('utf8');
  if (expectedReceiveId.length > 0 && receiveId !== expectedReceiveId) {
    return { ok: false, reason: 'the payload was encrypted for a different receiver id' };
  }
  return {
    ok: true,
    message: plain.subarray(messageStart, messageEnd).toString('utf8'),
    receiveId,
  };
}

/**
 * Read one top-level element out of a WeCom XML document.
 *
 * The callbacks use a flat, attribute-free document whose values are usually
 * CDATA-wrapped, so a full XML parser would be a dependency bought for nothing.
 * This reads exactly that shape and returns `null` for anything it cannot
 * confidently resolve, which keeps a malformed callback a value rather than an
 * exception.
 *
 * @param xml - The XML document.
 * @param tag - Element name to read, case sensitive as WeCom spells it.
 * @returns The element text, or `null` when the element is absent or empty.
 */
export function readXmlField(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const match = pattern.exec(xml);
  const raw = match?.[1];
  if (raw === undefined) {
    return null;
  }
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const value = (cdata?.[1] ?? raw).trim();
  return value.length > 0 ? value : null;
}
