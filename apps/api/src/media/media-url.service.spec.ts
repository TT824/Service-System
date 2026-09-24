import { describe, expect, it } from 'vitest';
import { parseAppConfig, type AppConfig } from '@kefu/core';
import {
  MEDIA_URL_EXPIRY_PARAM,
  MEDIA_URL_PATH,
  MEDIA_URL_SIGNATURE_PARAM,
  MEDIA_URL_TENANT_PARAM,
  MEDIA_URL_TTL_SECONDS,
  MediaUrlService,
} from './media-url.service';

/** The instant every test mints and verifies at, so expiry is arithmetic. */
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

/**
 * A configuration with a secret this test chose.
 *
 * Passed in rather than defaulted so that a test can mint with one secret and
 * verify with another — which is the only way to show that the secret is what
 * the signature actually depends on.
 */
function configWith(secret: string = 'test-media-url-secret'): AppConfig {
  const parsed = parseAppConfig({ APP_ENV: 'test', MEDIA_URL_SECRET: secret });
  if (parsed._tag !== 'ok') {
    throw new Error(`test config could not be parsed: ${parsed.error.message}`);
  }
  return parsed.config;
}

/** The query parameters of a minted URL, as the route would receive them. */
function paramsOf(url: string): Record<string, string | null> {
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  return {
    [MEDIA_URL_TENANT_PARAM]: query.get(MEDIA_URL_TENANT_PARAM),
    [MEDIA_URL_EXPIRY_PARAM]: query.get(MEDIA_URL_EXPIRY_PARAM),
    [MEDIA_URL_SIGNATURE_PARAM]: query.get(MEDIA_URL_SIGNATURE_PARAM),
  };
}

/** The message id a minted URL addresses. */
function messageIdOf(url: string): string {
  return decodeURIComponent(url.slice(MEDIA_URL_PATH.length + 1, url.indexOf('?')));
}

describe('MediaUrlService minting', () => {
  it('signs the tenant, the message and the expiry into the URL itself', () => {
    const urls = new MediaUrlService(configWith());

    const url = urls.url({ tenantId: 'tenant-acme', messageId: 'message-1', now: NOW });
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));

    // The path is the route the controller answers on, and the expiry is the
    // configured life measured from the clock this call was given.
    expect(url.startsWith(`${MEDIA_URL_PATH}/message-1?`)).toBe(true);
    expect(Number(query.get(MEDIA_URL_EXPIRY_PARAM))).toBe(
      Math.floor(NOW / 1000) + MEDIA_URL_TTL_SECONDS,
    );
    // The signature is a digest, not a copy of anything: seeing it must not
    // reveal the secret or the subject it covers.
    expect(query.get(MEDIA_URL_SIGNATURE_PARAM)).toMatch(/^[0-9a-f]{64}$/);
    expect(url).not.toContain('test-media-url-secret');
  });

  it('mints a different URL every time, even for the same message', () => {
    const urls = new MediaUrlService(configWith());

    const first = urls.url({ tenantId: 'tenant-acme', messageId: 'message-1', now: NOW });
    const later = urls.url({
      tenantId: 'tenant-acme',
      messageId: 'message-1',
      now: NOW + MEDIA_URL_TTL_SECONDS * 1000,
    });

    // The expiry is part of the signed bytes, so a re-mint after the window
    // moved is a different link rather than a reused one.
    expect(later).not.toBe(first);
  });
});

describe('MediaUrlService verification', () => {
  it('accepts the URL it just minted and returns what it covered', () => {
    const urls = new MediaUrlService(configWith());
    const url = urls.url({ tenantId: 'tenant-acme', messageId: 'message-1', now: NOW });

    const verdict = urls.verify({
      messageId: messageIdOf(url),
      tenantId: paramsOf(url)[MEDIA_URL_TENANT_PARAM] ?? null,
      expiry: paramsOf(url)[MEDIA_URL_EXPIRY_PARAM] ?? null,
      signature: paramsOf(url)[MEDIA_URL_SIGNATURE_PARAM] ?? null,
      now: NOW,
    });

    expect(verdict).toEqual({ ok: true, tenantId: 'tenant-acme', messageId: 'message-1' });
  });

  it('refuses a URL whose tenant was swapped for another', () => {
    const urls = new MediaUrlService(configWith());
    const url = urls.url({ tenantId: 'tenant-acme', messageId: 'message-1', now: NOW });
    const original = paramsOf(url);

    const verdict = urls.verify({
      messageId: messageIdOf(url),
      tenantId: 'tenant-other',
      expiry: original[MEDIA_URL_EXPIRY_PARAM] ?? null,
      signature: original[MEDIA_URL_SIGNATURE_PARAM] ?? null,
      now: NOW,
    });

    // The tenant is inside the signature, so renaming it is not a way to read
    // someone else's picture — this is the assertion that the route's scope
    // cannot be chosen by the caller.
    expect(verdict).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('refuses a URL whose message id was swapped for another', () => {
    const urls = new MediaUrlService(configWith());
    const url = urls.url({ tenantId: 'tenant-acme', messageId: 'message-1', now: NOW });
    const original = paramsOf(url);

    const verdict = urls.verify({
      messageId: 'message-2',
      tenantId: original[MEDIA_URL_TENANT_PARAM] ?? null,
      expiry: original[MEDIA_URL_EXPIRY_PARAM] ?? null,
      signature: original[MEDIA_URL_SIGNATURE_PARAM] ?? null,
      now: NOW,
    });

    expect(verdict).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('refuses a signature minted under a different secret', () => {
    const minted = new MediaUrlService(configWith('secret-a'));
    const checked = new MediaUrlService(configWith('secret-b'));
    const url = minted.url({ tenantId: 'tenant-acme', messageId: 'message-1', now: NOW });
    const original = paramsOf(url);

    const verdict = checked.verify({
      messageId: messageIdOf(url),
      tenantId: original[MEDIA_URL_TENANT_PARAM] ?? null,
      expiry: original[MEDIA_URL_EXPIRY_PARAM] ?? null,
      signature: original[MEDIA_URL_SIGNATURE_PARAM] ?? null,
      now: NOW,
    });

    // The secret is the capability, so a deployment that rotated it must stop
    // honouring links minted under the old one.
    expect(verdict).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('refuses a correct signature once its expiry has passed', () => {
    const urls = new MediaUrlService(configWith());
    const url = urls.url({ tenantId: 'tenant-acme', messageId: 'message-1', now: NOW });
    const original = paramsOf(url);

    const verdict = urls.verify({
      messageId: messageIdOf(url),
      tenantId: original[MEDIA_URL_TENANT_PARAM] ?? null,
      expiry: original[MEDIA_URL_EXPIRY_PARAM] ?? null,
      signature: original[MEDIA_URL_SIGNATURE_PARAM] ?? null,
      now: NOW + MEDIA_URL_TTL_SECONDS * 1000,
    });

    // Distinguished from a forgery: this link was real and has simply aged out.
    expect(verdict).toEqual({ ok: false, reason: 'expired' });
  });

  it('names a missing parameter a bad signature rather than a missing field', () => {
    const urls = new MediaUrlService(configWith());

    for (const absent of [
      { tenantId: null, expiry: '1', signature: 'a' },
      { tenantId: 'tenant-acme', expiry: null, signature: 'a' },
      { tenantId: 'tenant-acme', expiry: '1', signature: null },
      { tenantId: 'tenant-acme', expiry: 'not-a-number', signature: 'a' },
    ]) {
      expect(urls.verify({ messageId: 'message-1', ...absent, now: NOW })).toEqual({
        ok: false,
        reason: 'signature_mismatch',
      });
    }
  });

  it('refuses a signature that is the right shape but the wrong length', () => {
    const urls = new MediaUrlService(configWith());
    const url = urls.url({ tenantId: 'tenant-acme', messageId: 'message-1', now: NOW });
    const original = paramsOf(url);
    const truncated = (original[MEDIA_URL_SIGNATURE_PARAM] ?? '').slice(0, 32);

    // The constant-time comparison throws on unequal lengths, so this is the
    // case that would crash a route if the length check were dropped.
    expect(
      urls.verify({
        messageId: messageIdOf(url),
        tenantId: original[MEDIA_URL_TENANT_PARAM] ?? null,
        expiry: original[MEDIA_URL_EXPIRY_PARAM] ?? null,
        signature: truncated,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
});
