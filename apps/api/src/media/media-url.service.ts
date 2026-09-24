import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { API_PREFIX } from '../http/api-prefix';

/**
 * Minting and verifying the URLs a stored picture is served under.
 *
 * The console renders a customer's image with an `<img>` tag, and an `<img>`
 * cannot carry the identity header every other route in this API requires — so
 * the URL itself has to be the authorization. It is a signature over the three
 * facts the route needs to re-derive: which tenant, which message, and until
 * when. Nothing else is in it, so nothing else can be smuggled through it.
 *
 * Three properties this is deliberately built with:
 *
 * - **The tenant travels inside the signature, not beside it.** The route has no
 *   header to resolve a scope from, so if the caller could name the tenant the
 *   signature would be the only thing stopping them — and a verification that
 *   does not cover the value it verifies is not a verification. Every signed
 *   byte here is checked.
 * - **A short life.** The link is a bearer token: whoever holds it can read that
 *   one picture until it expires. Ten minutes is long enough for a transcript
 *   that mints a URL per read and short enough that a leaked one is stale.
 * - **Purpose separation.** The configured secret is run through HMAC before it
 *   becomes this key, so a media signature can never be replayed as some other
 *   signature the same secret might one day produce, and the secret itself is
 *   never the key of anything.
 */

/** How long a minted URL stays valid, in seconds. */
export const MEDIA_URL_TTL_SECONDS = 600;

/** The controller path the media route answers on. */
export const MEDIA_CONTROLLER_PATH = 'media';

/**
 * Where the media route is mounted.
 *
 * Composed from the route's own controller path and the global prefix rather
 * than written out: a minted URL that does not land on the route is a broken
 * picture with no compile error, so the two facts are kept as one.
 */
export const MEDIA_URL_PATH = `/${API_PREFIX}/${MEDIA_CONTROLLER_PATH}`;

/** Query parameter carrying the tenant the message belongs to. */
export const MEDIA_URL_TENANT_PARAM = 'tenant';
/** Query parameter carrying the URL's expiry, in epoch seconds. */
export const MEDIA_URL_EXPIRY_PARAM = 'exp';
/** Query parameter carrying the signature. */
export const MEDIA_URL_SIGNATURE_PARAM = 'sig';

/** Domain separator mixed into the configured secret. */
const KEY_PURPOSE = 'kefu:media-url:v1';

/** Why a URL was refused. Distinguished so the route can log the difference. */
export type MediaUrlRefusal =
  /** The signature does not match what these parameters should have produced. */
  | 'signature_mismatch'
  /** The signature is right, but the URL is past its expiry. */
  | 'expired';

/** The answer of one verification. */
export type MediaUrlVerdict =
  | { readonly ok: true; readonly tenantId: string; readonly messageId: string }
  | { readonly ok: false; readonly reason: MediaUrlRefusal };

/** Signs and verifies the URLs stored media is served under. */
@Injectable()
export class MediaUrlService {
  readonly #key: Buffer;

  /**
   * @param config - Application configuration, for the signing secret.
   */
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.#key = createHmac('sha256', config.mediaUrlSecret.unwrap()).update(KEY_PURPOSE).digest();
  }

  /**
   * Mint the URL one message's media can be read from.
   *
   * @param input - The message's tenant and id; the clock, for a test.
   * @returns The path and query, relative to the deployment's own origin.
   */
  url(input: {
    readonly tenantId: string;
    readonly messageId: string;
    readonly now?: number;
  }): string {
    const expiresAt = Math.floor((input.now ?? Date.now()) / 1000) + MEDIA_URL_TTL_SECONDS;
    const query = new URLSearchParams({
      [MEDIA_URL_TENANT_PARAM]: input.tenantId,
      [MEDIA_URL_EXPIRY_PARAM]: String(expiresAt),
      [MEDIA_URL_SIGNATURE_PARAM]: this.#sign(input.tenantId, input.messageId, expiresAt),
    });
    return `${MEDIA_URL_PATH}/${encodeURIComponent(input.messageId)}?${query.toString()}`;
  }

  /**
   * Check a request's parameters against the signature they carry.
   *
   * The signature is checked before the expiry, so a caller who never had a
   * valid link learns nothing from this route about which of the two was wrong.
   *
   * @param input - The query's parameters, as received.
   * @returns The signed subject, or why it was refused.
   */
  verify(input: {
    readonly messageId: string;
    readonly tenantId: string | null;
    readonly expiry: string | null;
    readonly signature: string | null;
    readonly now?: number;
  }): MediaUrlVerdict {
    const tenantId = input.tenantId ?? '';
    const expiresAt = Number(input.expiry ?? '');
    const offered = input.signature ?? '';
    if (tenantId.length === 0 || !Number.isInteger(expiresAt) || offered.length === 0) {
      // Not a signature failure but a URL that was never one: refused with the
      // same answer, because a caller with no valid link has no business
      // learning which part was missing.
      return { ok: false, reason: 'signature_mismatch' };
    }
    const expected = this.#sign(tenantId, input.messageId, expiresAt);
    if (!equalSignatures(expected, offered)) {
      return { ok: false, reason: 'signature_mismatch' };
    }
    if (expiresAt * 1000 <= (input.now ?? Date.now())) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, tenantId, messageId: input.messageId };
  }

  /** The signature over one subject, as lowercase hex. */
  #sign(tenantId: string, messageId: string, expiresAt: number): string {
    return createHmac('sha256', this.#key)
      .update(`${tenantId}\n${messageId}\n${String(expiresAt)}`)
      .digest('hex');
  }
}

/**
 * Compare two signatures without leaking where they differ.
 *
 * A byte-by-byte comparison that stopped at the first difference would tell an
 * attacker how much of a forged signature is already right; the length check
 * first is what makes the constant-time comparison below safe to call with
 * anything (it throws on unequal lengths).
 *
 * @param expected - The signature the parameters should have produced.
 * @param offered - The signature the request carried.
 * @returns `true` when they are the same.
 */
function equalSignatures(expected: string, offered: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const offeredBytes = Buffer.from(offered, 'utf8');
  return (
    expectedBytes.length === offeredBytes.length && timingSafeEqual(expectedBytes, offeredBytes)
  );
}
