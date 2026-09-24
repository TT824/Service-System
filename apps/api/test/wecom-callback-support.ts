import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { parseAppConfig, type AppConfig } from '@kefu/core';
import { MemoryWecomBindingRepository } from '../src/channels/memory-wecom-binding.repository';
import type {
  AdvanceCursorInput,
  ClaimCursorInput,
  CursorLeaseInput,
  WecomActiveBinding,
} from '../src/channels/wecom-binding.repository';
import type {
  WecomDownloadRequest,
  WecomDownloadResponse,
  WecomHttpClient,
  WecomHttpRequest,
  WecomHttpResponse,
} from '@kefu/wecom';

/**
 * Shared, deliberately fake fixtures for the WeChat Customer Service boundary.
 *
 * The crypto and adapter unit tests both need a callback that WeCom *would*
 * have produced, and neither may read a real credential or touch the network.
 * This module therefore mints its own envelope from the documented format —
 * `random(16) || msg_len(4, big endian) || msg || $ReceiveId`, AES-256-CBC with
 * the first 16 key bytes as the IV — using values that are obviously test data.
 *
 * The encryption here is written independently of `wecom-crypto.ts` on purpose:
 * a test that re-used the production encryptor would agree with the production
 * decryptor even if both were wrong about the format.
 */

/** Corp id the fake callbacks are minted for. */
export const TEST_CORP_ID = 'ww-test-corp';

/** Callback `Token` shared with the fake provider. */
export const TEST_CALLBACK_TOKEN = 'test-callback-token';

/** `open_kfid` of the fake customer-service account. */
export const TEST_OPEN_KF_ID = 'wkTEST0001';

/**
 * A 43-character `EncodingAESKey`.
 *
 * Derived from a fixed, obviously synthetic byte pattern rather than a literal
 * so no real key can be mistaken for it, and so the `=` padding is stripped the
 * way WeCom's own console value is.
 */
export const TEST_ENCODING_AES_KEY = Buffer.alloc(32, 0x5a).toString('base64').replace(/=$/, '');

/** A customer-service secret that is unmistakably test data. */
export const TEST_KF_SECRET = 'test-kf-secret';

/**
 * Build a `real`-transport configuration from the documented variables.
 *
 * @param overrides - Environment variables to replace or add.
 * @returns The parsed configuration a real-mode boot would hold.
 */
export function realWecomConfig(overrides: Readonly<Record<string, string>> = {}): AppConfig {
  const result = parseAppConfig({
    APP_ENV: 'test',
    WECOM_TRANSPORT: 'real',
    WECOM_CORP_ID: TEST_CORP_ID,
    WECOM_KF_SECRET: TEST_KF_SECRET,
    WECOM_TOKEN: TEST_CALLBACK_TOKEN,
    WECOM_AES_KEY: TEST_ENCODING_AES_KEY,
    WECOM_OPEN_KFID: TEST_OPEN_KF_ID,
    ...overrides,
  });
  if (result._tag !== 'ok') {
    throw new Error(`the test configuration did not parse: ${result.error.message}`);
  }
  return result.config;
}

/**
 * Encrypt an already framed plaintext, exactly as WeCom's SDK does.
 *
 * Used for the boundary cases a well-formed message cannot express — for
 * example a declared length that runs past the end of the buffer.
 *
 * @param encodingAesKey - The 43-character `EncodingAESKey`.
 * @param plaintext - The framed plaintext bytes.
 * @returns Base64 ciphertext.
 */
export function encryptWecomPlaintext(encodingAesKey: string, plaintext: Buffer): string {
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
}

/**
 * Encrypt one message into a WeCom ciphertext.
 *
 * @param encodingAesKey - The 43-character `EncodingAESKey`.
 * @param message - The message document to frame.
 * @param receiveId - The id WeCom appends; the corp id in real callbacks.
 * @returns Base64 ciphertext.
 */
export function encryptWecomMessage(
  encodingAesKey: string,
  message: string,
  receiveId: string,
): string {
  const body = Buffer.from(message, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return encryptWecomPlaintext(
    encodingAesKey,
    Buffer.concat([randomBytes(16), length, body, Buffer.from(receiveId, 'utf8')]),
  );
}

/**
 * Compute the callback digest.
 *
 * Written from the format rather than by calling `wecomSignature`, so the test
 * would fail if the implementation stopped sorting the four values.
 *
 * @param token - Callback `Token`.
 * @param timestamp - `timestamp` query parameter.
 * @param nonce - `nonce` query parameter.
 * @param ciphertext - `echostr`, or the `Encrypt` element.
 * @returns Lowercase hexadecimal `sha1`.
 */
export function wecomCallbackSignature(
  token: string,
  timestamp: string,
  nonce: string,
  ciphertext: string,
): string {
  return createHash('sha1')
    .update([token, timestamp, nonce, ciphertext].sort().join(''), 'utf8')
    .digest('hex');
}

/**
 * Build one flat WeCom message document.
 *
 * @param fields - Element names to values; every value is CDATA-wrapped the way
 * WeCom wraps them.
 * @returns The XML document.
 */
export function wecomXml(fields: Readonly<Record<string, string>>): string {
  const body = Object.entries(fields)
    .map(([tag, value]) => `<${tag}><![CDATA[${value}]]></${tag}>`)
    .join('');
  return `<xml>${body}</xml>`;
}

/**
 * Build a callback envelope carrying an encrypted document.
 *
 * @param encrypted - Base64 ciphertext for the `<Encrypt>` element.
 * @returns The XML document WeCom would POST.
 */
export function wecomCallbackEnvelope(encrypted: string): string {
  return wecomXml({ ToUserName: 'gh_test', Encrypt: encrypted, AgentID: '1' });
}

/**
 * A persistent-binding store an interface test seeds with accounts.
 *
 * The cursor half is the shipped in-process adapter, so the claim, the takeover
 * and the compare-by-owner writes under test are the shipped behaviour rather
 * than a second interpretation of it. Only the account lookup is answered from
 * the seeded list — the same `findActiveBinding` read the durable table
 * performs, through the same provider token a deployment binds — so a test
 * states which `(corp_id, open_kfid)` pairs are bound without pretending a
 * platform has a binding surface this slice never wrote.
 *
 * It is deliberately a *test double for the store*, not a scope resolver: the
 * module wires its own resolver to whatever store is bound, so a boot that
 * overrides only this value exercises the production resolution path.
 */
export class SeededWecomBindings extends MemoryWecomBindingRepository {
  /** Every cursor claim the pull made, in order. */
  readonly claims: ClaimCursorInput[] = [];
  /** Every cursor advance the pull made, in order. */
  readonly advances: AdvanceCursorInput[] = [];
  /** Every cursor release the pull made, in order. */
  readonly releases: CursorLeaseInput[] = [];

  /** The active bindings, as a deployment's binding table would supply them. */
  bindings: ReadonlyArray<WecomActiveBinding> = [];

  /**
   * @param bindings - The active bindings this boot resolves.
   */
  constructor(bindings: ReadonlyArray<WecomActiveBinding> = []) {
    super();
    this.bindings = bindings;
  }

  /** @inheritdoc */
  override async findActiveBinding(
    corpId: string,
    openKfId: string,
  ): Promise<WecomActiveBinding | undefined> {
    // Same contract as the durable read: exactly one active binding, or none.
    const candidates = this.bindings.filter(
      (binding) => binding.corpId === corpId && binding.openKfId === openKfId,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** @inheritdoc */
  override async claimCursor(input: ClaimCursorInput) {
    this.claims.push(input);
    return super.claimCursor(input);
  }

  /** @inheritdoc */
  override async advanceCursor(input: AdvanceCursorInput): Promise<boolean> {
    this.advances.push(input);
    return super.advanceCursor(input);
  }

  /** @inheritdoc */
  override async releaseCursor(input: CursorLeaseInput): Promise<boolean> {
    this.releases.push(input);
    return super.releaseCursor(input);
  }

  /** The cursor the last advance persisted, or `null` when none was written. */
  cursor(): string | null {
    return this.advances.at(-1)?.cursor ?? null;
  }
}

/**
 * A recording {@link WecomHttpClient} that answers from a replaceable handler.
 *
 * Nothing here opens a socket: the handler is pure, so every test states the
 * provider's answer explicitly and can assert how many calls were made.
 */
export class FakeWecomHttp implements WecomHttpClient {
  /** Every request the adapter issued, in order. */
  readonly requests: WecomHttpRequest[] = [];

  #handler: (request: WecomHttpRequest) => WecomHttpResponse | Promise<WecomHttpResponse>;

  /**
   * @param handler - Answer to return for a request. Defaults to a bare
   * `errcode: 0` answer, which is only meaningful for a test that never
   * inspects the body.
   */
  constructor(
    handler: (
      request: WecomHttpRequest,
    ) => WecomHttpResponse | Promise<WecomHttpResponse> = () => ({
      status: 200,
      body: { errcode: 0, errmsg: 'ok' },
    }),
  ) {
    this.#handler = handler;
  }

  /** Replace the answer strategy after construction. */
  setHandler(
    handler: (request: WecomHttpRequest) => WecomHttpResponse | Promise<WecomHttpResponse>,
  ): void {
    this.#handler = handler;
  }

  /** Requests whose URL contains `fragment`, in order. */
  matching(fragment: string): ReadonlyArray<WecomHttpRequest> {
    return this.requests.filter((request) => request.url.includes(fragment));
  }

  /** @inheritdoc */
  async send(request: WecomHttpRequest): Promise<WecomHttpResponse> {
    this.requests.push(request);
    return this.#handler(request);
  }

  /**
   * Answers `media/get`, defaulting to the provider refusing the media id.
   *
   * The default is a refusal rather than invented bytes on purpose: a test that
   * did not say what the provider served must not end up with a stored image,
   * because that would be a passing assertion about bytes no one stated. A test
   * that wants the download to succeed says so with
   * {@link FakeWecomHttp.setDownloadHandler}.
   */
  #downloadHandler: (request: WecomDownloadRequest) => WecomDownloadResponse = () => ({
    kind: 'json',
    status: 200,
    body: { errcode: 40007, errmsg: 'media not found' },
  });

  /** Replace the `media/get` answer. */
  setDownloadHandler(
    handler: (request: WecomDownloadRequest) => WecomDownloadResponse,
  ): void {
    this.#downloadHandler = handler;
  }

  /** Every `media/get` request the transport issued, in order. */
  readonly downloads: WecomDownloadRequest[] = [];

  /** @inheritdoc */
  async download(request: WecomDownloadRequest): Promise<WecomDownloadResponse> {
    this.downloads.push(request);
    return this.#downloadHandler(request);
  }
}
