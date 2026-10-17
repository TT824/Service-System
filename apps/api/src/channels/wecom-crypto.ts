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
 * The platform normally only *reads* this envelope: a real WeCom server signs
 * and encrypts, and the handshake answers with a plaintext it was given. The
 * one place that writes it is the callback self-check, which has to put a
 * question to a deployment's own public URL in exactly the shape WeCom's
 * registration would. It is the same format read backwards, which is the reason
 * it lives beside the reader rather than in the checker.
 *
 * Everything here is a pure function over bytes and strings, with one honest
 * exception: {@link encryptWecomPayload} draws the frame's random prefix from
 * the CSPRNG, so it is not a function *of* its inputs alone. What that costs is
 * the ability to compare two ciphertexts as strings — nothing else — and the
 * randomness is not optional, since it is what the format demands. There is no
 * network access, no credential storage and no logging: a failure is a value
 * carrying a reason, never a thrown error and never a printed payload, because
 * a failed decrypt is exactly the case where the input must not reach a log.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

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

/** Result of encrypting one WeCom payload. */
export type WecomEncryptResult =
  | {
      readonly ok: true;
      /** Base64 ciphertext, exactly as WeCom spells the `echostr`/`Encrypt` value. */
      readonly ciphertext: string;
    }
  | WecomCryptoFailure;

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
 * Encrypt one WeCom payload.
 *
 * The exact inverse of {@link decryptWecomPayload}, for the one caller that has
 * to *ask* a question in WeCom's format rather than answer one: the callback
 * self-check mints an `echostr` and asks a deployment's public URL to hand it
 * back, which is only meaningful if the bytes on the wire are the ones WeCom
 * would have sent. Both halves therefore live here, so a change to the frame is
 * a change to one file.
 *
 * @param encodingAesKey - The 43-character `EncodingAESKey`.
 * @param message - Plaintext to frame. Must be non-empty — see below.
 * @param receiveId - Id appended to the plaintext. A callback appends the corp
 * id, and a reader that checks the receiver id will refuse a frame that omitted
 * it, so a caller aiming at the handshake passes the same corp id WeCom would.
 * @returns The Base64 ciphertext, or a failure carrying a safe reason.
 */
export function encryptWecomPayload(
  encodingAesKey: string,
  message: string,
  receiveId: string,
): WecomEncryptResult {
  if (encodingAesKey.length !== ENCODING_AES_KEY_LENGTH) {
    return { ok: false, reason: `EncodingAESKey must be ${ENCODING_AES_KEY_LENGTH} characters` };
  }
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  if (key.length !== AES_KEY_LENGTH) {
    return { ok: false, reason: `EncodingAESKey must decode to ${AES_KEY_LENGTH} bytes` };
  }
  const body = Buffer.from(message, 'utf8');
  // Refused rather than padded: the frame's length field would read back as `0`,
  // which {@link decryptWecomPayload} treats as out of range. Encrypting an empty
  // message would therefore mint a payload this same module cannot open, and a
  // caller that never noticed would be looking for the fault on the far side of
  // the network.
  if (body.length === 0) {
    return { ok: false, reason: 'the message to encrypt is empty' };
  }
  const length = Buffer.alloc(LENGTH_FIELD_LENGTH);
  length.writeUInt32BE(body.length, 0);
  const framed = Buffer.concat([
    randomBytes(RANDOM_PREFIX_LENGTH),
    length,
    body,
    Buffer.from(receiveId, 'utf8'),
  ]);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, AES_BLOCK_SIZE));
  // Node applies the PKCS#7 padding the format requires; `final()` is what
  // appends it, so the update half alone is never the ciphertext.
  const ciphertext = Buffer.concat([cipher.update(framed), cipher.final()]);
  return { ok: true, ciphertext: ciphertext.toString('base64') };
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
