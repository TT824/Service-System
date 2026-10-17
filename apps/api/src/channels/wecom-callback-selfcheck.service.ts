/**
 * The callback self-check: ask our own public URL the question WeCom will ask.
 *
 * Registering a 「接收事件服务器」 is a one-shot, all-or-nothing act from the
 * operator's side: WeCom requests the URL the moment 保存 is pressed, and a URL
 * that does not answer the handshake correctly is refused with a message that
 * names none of the three things that can be wrong — a URL that does not route
 * here, a credential set that was never saved, or a deployment that cannot
 * answer at all. The check in this file exists so that all three are answered
 * *before* the console is touched.
 *
 * What it does is what WeCom does, in the same order: mint an `echostr`, frame
 * and encrypt it exactly as the provider would, sign the ciphertext with the
 * callback `Token` this deployment actually holds, `GET` the operator's own
 * public URL with those four parameters, and compare the body to the plaintext
 * it sent. Each way that can fail returns a named stage, so the console can say
 * which one it was.
 *
 * **The credential it checks with is the one the transport would use**, read
 * through the same {@link WECOM_CREDENTIAL_READER} the adapter reads through,
 * at the moment of the check. That is the whole point: a check against a copied
 * value in the environment would pass while the console-stored set — the one
 * that wins — is still wrong.
 *
 * ## Why this is allowed to make a request to an operator-supplied URL
 *
 * A server-side request to a URL a human typed is an SSRF primitive, so it is
 * narrowed rather than trusted:
 *
 * - **Platform super-administrators only.** The caller already holds the
 *   deployment-wide customer-service secret; the check adds no reach a
 *   credential write did not already carry.
 * - **`https` only, no embedded credentials, no fragment.** A `file:`, `gopher:`
 *   or userinfo-wearing URL has no meaning for this check, and refusing them
 *   costs a legitimate caller nothing.
 * - **Every resolved address must be a public one.** A host that resolves to
 *   loopback, a private range, a link-local address or the cloud metadata
 *   address is refused before any request is made. This is a narrowing and not
 *   a proof: the name is resolved once for the check and again by `fetch`, so a
 *   name that changes its answer in between is not caught here.
 * - **No redirects are followed and the body is bounded.** A public URL that
 *   answers `302` towards `169.254.169.254` fails at the redirect, and a URL
 *   that answers with a large document cannot buffer it into this process.
 *
 * ## What it cannot prove
 *
 * A check that passes proves *a* deployment answering at that address holds this
 * deployment's credentials and can answer the handshake in time. It does not
 * prove WeCom can reach the address — an internal-only host would fail the
 * public-address rule rather than be silently probed — and it does not prove
 * which deployment is behind the name if a proxy is in front of it. The verdict
 * therefore reports what it observed and never says 「已登记」.
 */

import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { wecomProblemVariables } from '@kefu/core';
import type { WecomCredentialReader } from '@kefu/wecom';
import { WECOM_REAL_TRANSPORT, type WecomRealTransport } from './real-wecom.adapter';
import { WECOM_CREDENTIAL_READER } from './wecom-credential.source';
import { encryptWecomPayload, wecomSignature } from './wecom-crypto';

/**
 * How long the probed URL may take to answer.
 *
 * WeCom abandons the registration handshake after one second and the platform
 * answers well inside that, so five seconds is the point past which a slower
 * answer is not a slow success — it is a URL that will not register. Bounded
 * above the provider's own deadline so a correct deployment is never failed by
 * this check for being merely slower than WeCom's patience.
 */
export const CALLBACK_SELFCHECK_TIMEOUT_MS = 5_000;

/** One outbound probe of a callback URL. */
export type WecomCallbackProbeRequest = {
  /** Fully built URL, query parameters included. */
  readonly url: string;
  /** Hard deadline for the whole request. */
  readonly timeoutMs: number;
};

/** What one probe observed. */
export type WecomCallbackProbeResponse = {
  readonly status: number;
  /** Body as text, bounded by the probe's own read limit. */
  readonly body: string;
};

/**
 * The outbound half of the self-check.
 *
 * A port rather than a direct `fetch`, so a test proves the protocol — the
 * parameters, the signature, the comparison — against a fake, and the one class
 * that opens a socket stays as small as it can be.
 */
export type WecomCallbackProbe = (
  request: WecomCallbackProbeRequest,
) => Promise<WecomCallbackProbeResponse>;

/** Injection token carrying the bound {@link WecomCallbackProbe}. */
export const WECOM_CALLBACK_PROBE = Symbol('WECOM_CALLBACK_PROBE');

/** Which step of the check produced the verdict. */
export type WecomCallbackSelfCheckStage =
  /** No real customer-service transport is bound in this build. */
  | 'transport'
  /** The URL is unusable before anything is sent. */
  | 'url'
  /** This deployment holds no credential set it can sign with. */
  | 'credentials'
  /** The request could not be completed at all. */
  | 'request'
  /** The URL answered, but not `200`. */
  | 'status'
  /** The URL answered `200`, but not with the plaintext that was sent. */
  | 'plaintext'
  /** The handshake round-tripped. */
  | 'ok';

/**
 * What the self-check found.
 *
 * `ok: false` is a normal answer, not an error: the check ran and the URL will
 * not register. Only a caller who may not run it at all — a non-administrator,
 * a malformed body — is refused with the platform's error envelope instead.
 */
export type WecomCallbackSelfCheckVerdict = {
  /** Whether the handshake round-tripped. */
  readonly ok: boolean;
  /** The step that produced this verdict. */
  readonly stage: WecomCallbackSelfCheckStage;
  /** Platform-authored explanation. Never carries a key, token or ciphertext. */
  readonly detail: string;
  /** Response status, or `null` when no response was read. */
  readonly http_status: number | null;
  /**
   * What was probed, as scheme, host and path.
   *
   * The probe's own query parameters are deliberately absent: they are a valid
   * signature over a known plaintext, and returning them would put a replayable
   * handshake into a response body and a browser history.
   */
  readonly probed_url: string | null;
  /** Which credential set signed the check, when one was usable. */
  readonly credential_source: 'console' | 'environment' | null;
  /** Instant the check finished. */
  readonly checked_at: string;
};

/** A URL this check will accept, or the reason it will not. */
type ProbeTarget =
  { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly reason: string };

/**
 * The callback self-check.
 *
 * The stages run in the order that costs the operator least to fix: a typo is
 * refused without reading a credential, and a missing credential is refused
 * without a network call. Only a URL that is usable *and* signable is probed.
 */
@Injectable()
export class WecomCallbackSelfCheckService {
  constructor(
    @Inject(WECOM_REAL_TRANSPORT) private readonly realTransport: WecomRealTransport | null,
    @Inject(WECOM_CREDENTIAL_READER) private readonly credentials: WecomCredentialReader,
    @Inject(WECOM_CALLBACK_PROBE) private readonly probe: WecomCallbackProbe,
  ) {}

  /**
   * Put the handshake to one URL and report exactly where it stands.
   *
   * @param target - The public callback URL to check, as the operator typed it.
   * @returns A verdict naming the stage that produced it.
   */
  async check(target: string): Promise<WecomCallbackSelfCheckVerdict> {
    if (this.realTransport === null) {
      return this.#verdict({
        ok: false,
        stage: 'transport',
        detail:
          'this build binds the local mock transport, so there is no real WeCom handshake to check; the deployment needs WECOM_TRANSPORT set to real before a callback URL can be registered',
      });
    }
    const parsed = validateProbeTarget(target);
    if (!parsed.ok) {
      return this.#verdict({ ok: false, stage: 'url', detail: parsed.reason });
    }
    const addressProblem = await publicAddressProblem(parsed.url.hostname);
    if (addressProblem !== null) {
      return this.#verdict({ ok: false, stage: 'url', detail: addressProblem });
    }
    const resolution = await this.credentials();
    if (resolution._tag !== 'ready') {
      const missing = wecomProblemVariables(resolution.problems);
      return this.#verdict({
        ok: false,
        stage: 'credentials',
        detail: `this deployment has no usable WeCom credential set: the ${resolution.origin} set is missing or unusable (${missing.join(', ')})`,
      });
    }
    const values = resolution.values;
    // The plaintext is this check's own random value, never a credential: what
    // travels is a ciphertext only this deployment's key can open, and the
    // signature is over bytes minus the token. Nothing secret leaves here.
    const echostr = `selfcheck-${randomBytes(16).toString('hex')}`;
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const nonce = randomBytes(8).toString('hex');
    const encrypted = encryptWecomPayload(values.aesKey, echostr, values.corpId);
    if (!encrypted.ok) {
      return this.#verdict({
        ok: false,
        stage: 'credentials',
        detail: `the stored EncodingAESKey cannot encrypt a handshake: ${encrypted.reason}`,
        credentialSource: resolution.origin,
      });
    }
    const probed = new URL(parsed.url.toString());
    // `set`, not a fresh query string: WeCom appends its parameters to whatever
    // the registered URL already carries, so refusing an operator's own query
    // here would be checking a URL that is not the one being registered.
    probed.searchParams.set(
      'msg_signature',
      wecomSignature(values.callbackToken, timestamp, nonce, encrypted.ciphertext),
    );
    probed.searchParams.set('timestamp', timestamp);
    probed.searchParams.set('nonce', nonce);
    probed.searchParams.set('echostr', encrypted.ciphertext);
    const safeUrl = `${probed.origin}${probed.pathname}`;

    let response: WecomCallbackProbeResponse;
    try {
      response = await this.probe({
        url: probed.toString(),
        timeoutMs: CALLBACK_SELFCHECK_TIMEOUT_MS,
      });
    } catch (error) {
      return this.#verdict({
        ok: false,
        stage: 'request',
        detail: `the request could not be completed: ${transportReason(error)}`,
        probedUrl: safeUrl,
        credentialSource: resolution.origin,
      });
    }
    if (response.status !== 200) {
      return this.#verdict({
        ok: false,
        stage: 'status',
        detail: `the URL answered ${response.status} instead of 200; WeCom reads only 200 as a successful handshake and retries anything else`,
        httpStatus: response.status,
        probedUrl: safeUrl,
        credentialSource: resolution.origin,
      });
    }
    const body = response.body.trim();
    if (body !== echostr) {
      return this.#verdict({
        ok: false,
        stage: 'plaintext',
        detail: refusedHandshakeDetail(body),
        httpStatus: response.status,
        probedUrl: safeUrl,
        credentialSource: resolution.origin,
      });
    }
    return this.#verdict({
      ok: true,
      stage: 'ok',
      detail: `the URL answered the handshake with the plaintext it was sent, using the ${resolution.origin} credential set`,
      httpStatus: response.status,
      probedUrl: safeUrl,
      credentialSource: resolution.origin,
    });
  }

  /**
   * Complete a verdict with the fields a stage does not speak to.
   *
   * @param input - The stage-specific half of the verdict.
   * @returns The verdict the controller returns as-is.
   */
  #verdict(input: {
    readonly ok: boolean;
    readonly stage: WecomCallbackSelfCheckStage;
    readonly detail: string;
    readonly httpStatus?: number;
    readonly probedUrl?: string;
    readonly credentialSource?: 'console' | 'environment';
  }): WecomCallbackSelfCheckVerdict {
    return {
      ok: input.ok,
      stage: input.stage,
      detail: input.detail,
      http_status: input.httpStatus ?? null,
      probed_url: input.probedUrl ?? null,
      credential_source: input.credentialSource ?? null,
      checked_at: new Date().toISOString(),
    };
  }
}

/**
 * Decide whether a URL is one this check may request.
 *
 * Pure and synchronous: it settles the parts of the decision that need no
 * network, so a malformed URL is answered without a DNS lookup or a database
 * read.
 *
 * @param raw - The URL as the operator typed it.
 * @returns The parsed URL, or the reason it is refused.
 */
export function validateProbeTarget(raw: string): ProbeTarget {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'no callback URL was given' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason:
        'that is not a URL: include the scheme, for example https://kefu.example.com/api/v1/channels/wecom/callback',
    };
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      reason: `only an https URL can be registered with WeCom, and ${url.protocol} cannot be checked here`,
    };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, reason: 'a callback URL carries no embedded credentials' };
  }
  if (url.hash.length > 0) {
    return {
      ok: false,
      reason: 'a fragment never reaches the server, so it cannot be part of a callback URL',
    };
  }
  if (url.hostname.length === 0) {
    return { ok: false, reason: 'the URL names no host' };
  }
  return { ok: true, url };
}

/**
 * Refuse a host that resolves anywhere but the public internet.
 *
 * Every answer a name resolves to is checked, and one private answer refuses the
 * whole check: a name that round-robins between a public address and a private
 * one would otherwise be probed on whichever half the second resolution picked,
 * which is exactly the reach this rule exists to deny.
 *
 * @param hostname - The URL's host, which may be a literal address.
 * @returns The reason to refuse, or `null` when every answer is public.
 */
async function publicAddressProblem(hostname: string): Promise<string | null> {
  const literal = isIP(hostname);
  if (literal !== 0) {
    return isPublicAddress(hostname)
      ? null
      : `the URL points at ${hostname}, which is not a public address; WeCom could not reach it either`;
  }
  let addresses: ReadonlyArray<{ readonly address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (error) {
    return `the host ${hostname} did not resolve: ${transportReason(error)}`;
  }
  if (addresses.length === 0) {
    return `the host ${hostname} resolved to no address`;
  }
  const privateAnswer = addresses.find((entry) => !isPublicAddress(entry.address));
  return privateAnswer === undefined
    ? null
    : `the host ${hostname} resolves to ${privateAnswer.address}, which is not a public address; WeCom could not reach it either`;
}

/**
 * Whether one literal address is a public one.
 *
 * Deliberately a refusal list rather than an allow list of "real" ranges: the
 * ranges named here are the ones a mistake lands in — loopback, the private
 * blocks, carrier-grade NAT, link-local (which is where the cloud metadata
 * services live) and the multicast/reserved tail.
 *
 * @param address - An IPv4 or IPv6 literal.
 * @returns `true` when the address is not one this check refuses.
 */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isPublicIpv4(address);
  }
  if (version === 6) {
    return isPublicIpv6(address.toLowerCase());
  }
  // Not an address at all: refused, because "unparseable" is not "public".
  return false;
}

/** Whether one dotted-quad literal is outside every range this check refuses. */
function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const first = parts[0] as number;
  const second = parts[1] as number;
  if (first === 0 || first === 10 || first === 127) {
    return false;
  }
  // 169.254.0.0/16 is link-local — and 169.254.169.254 is the metadata address
  // every cloud provider answers on, which is the classic SSRF target.
  if (first === 169 && second === 254) {
    return false;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return false;
  }
  if (first === 192 && second === 168) {
    return false;
  }
  // 100.64.0.0/10 (carrier-grade NAT) and 198.18.0.0/15 (benchmarking) are not
  // routable to a deployment, so a URL there is a mistake either way.
  if (first === 100 && second >= 64 && second <= 127) {
    return false;
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return false;
  }
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved and 255.255.255.255 broadcast.
  return first < 224;
}

/** Whether one IPv6 literal is outside every range this check refuses. */
function isPublicIpv6(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped !== null) {
    // An IPv4-mapped address reaches the IPv4 address it names, so it is
    // checked as one rather than as an opaque v6 literal.
    return isPublicIpv4(mapped[1] as string);
  }
  if (address === '::1' || address === '::') {
    return false;
  }
  if (address.startsWith('fc') || address.startsWith('fd')) {
    return false; // fc00::/7 unique local
  }
  if (/^fe[89ab]/.test(address)) {
    return false; // fe80::/10 link-local
  }
  if (address.startsWith('ff')) {
    return false; // ff00::/8 multicast
  }
  return true;
}

/**
 * Say what a `200` that is not the plaintext actually contained.
 *
 * The platform's own error envelope is worth naming, because it is the one
 * answer that means "the address is right and the credentials are not": the
 * deployment refused this check's signature, so registering the URL would fail
 * the same way. Anything else is described by shape and size only — the body
 * belongs to a server nobody has vetted, and echoing it into a console would be
 * handing that server a place in this deployment's UI.
 *
 * @param body - The response body, already trimmed.
 * @returns A safe explanation.
 */
function refusedHandshakeDetail(body: string): string {
  const envelope = asErrorEnvelope(body);
  if (envelope !== null) {
    return `the URL answered 200 but refused the handshake with ${envelope.code}: ${envelope.message}`;
  }
  return body.length === 0
    ? 'the URL answered 200 with an empty body instead of the plaintext it was sent'
    : `the URL answered 200 with ${body.length} characters that are not the plaintext it was sent; check that the callback Token and EncodingAESKey saved here are the ones WeCom holds`;
}

/**
 * Read the platform error envelope out of a body, if that is what it is.
 *
 * @param body - Response body as text.
 * @returns The code and message, or `null` for anything else.
 */
function asErrorEnvelope(body: string): { readonly code: string; readonly message: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return typeof record['code'] === 'string' && typeof record['message'] === 'string'
    ? { code: record['code'], message: record['message'] }
    : null;
}

/**
 * Describe a transport failure without inventing a cause.
 *
 * `fetch` reports every failure of its own as `TypeError: fetch failed` and
 * leaves the reason — a refused connection, a certificate, a refused redirect, a
 * timed-out signal — on `cause`. Reporting the outer message alone would make
 * every one of those read the same in the console, which is the opposite of what
 * this check is for, so the cause is appended when there is one.
 *
 * @param error - Whatever the probe threw or the resolver rejected with.
 * @returns The error's own message, its cause, or a last resort.
 */
function transportReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'an unknown error';
  }
  const code = (error as { readonly code?: unknown }).code;
  const outer = typeof code === 'string' ? `${code}: ${error.message}` : error.message;
  const cause = (error as { readonly cause?: unknown }).cause;
  return cause instanceof Error ? `${outer} (${cause.message})` : outer;
}
