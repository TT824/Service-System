import { describe, expect, it } from 'vitest';
import { WECOM_AES_KEY_LENGTH } from '@kefu/core';
import type {
  WecomDownloadRequest,
  WecomDownloadResponse,
  WecomHttpClient,
  WecomHttpRequest,
  WecomHttpResponse,
} from './http-client';
import {
  WECOM_MAX_REQUESTS_PER_DOWNLOAD,
  WECOM_MEDIA_DOWNLOAD_MAX_BYTES,
  WecomMediaDownloader,
  mapWecomDownloadFailure,
} from './media';
import { MemoryWecomTokenCache, WecomTokenProvider } from './token-provider';
import type { WecomCredentialReader } from './credentials';

/** A reader answering with one fixed, usable set. */
function readerOf(): WecomCredentialReader {
  return async () => ({
    _tag: 'ready',
    origin: 'console',
    values: {
      corpId: 'ww-corp',
      kfSecret: 'kf-secret',
      callbackToken: 'callback-token',
      aesKey: 'k'.repeat(WECOM_AES_KEY_LENGTH),
      openKfId: 'wkCONFIGURED',
    },
  });
}

/** A reader answering the way a deployment with a field missing does. */
function unconfiguredReader(variable: string): WecomCredentialReader {
  // `environment`, because a transport that could not be configured is the
  // state a deployment that never stored anything is in; the console's half has
  // its own tests where the rule lives.
  return async () => ({
    _tag: 'unconfigured',
    origin: 'environment',
    problems: [{ variable, code: 'missing' }],
  });
}

/**
 * Tests for the inbound WeCom media fetch.
 *
 * This is the mirror of the upload suite in `outbox.spec.ts`, and it is pinned
 * for the same reason: the API's ingest path reaches this endpoint through a
 * port, so what has to be true is the *contract* — the request the provider
 * actually receives, the single replay after an authentication failure, the
 * bound that stops a body being buffered, and the stable failure every answer
 * maps onto. A test that only proved "bytes come back" would pass for an
 * implementation that read them as text and corrupted every one.
 */

/** The clock every test in this suite is pinned to. */
const NOW = Date.parse('2026-05-01T10:00:00.000Z');

/** A scripted {@link WecomHttpClient} for the download path. */
class FakeWecomHttp implements WecomHttpClient {
  readonly downloads: WecomDownloadRequest[] = [];
  readonly tokenRequests: WecomHttpRequest[] = [];
  #downloadHandler: (request: WecomDownloadRequest) => WecomDownloadResponse = () => mediaOk();
  #tokenHandler: () => WecomHttpResponse = () => tokenOk();
  #tokenCalls = 0;

  /** Replace the `media/get` answer. */
  scriptDownload(handler: (request: WecomDownloadRequest) => WecomDownloadResponse): void {
    this.#downloadHandler = handler;
  }

  /** Answer each `gettoken` with a different token, so a replay is visible. */
  scriptRotatingTokens(): void {
    this.#tokenHandler = () => tokenOk(`token-${String(++this.#tokenCalls)}`);
  }

  /** Fail every `gettoken` the way a missing credential does. */
  scriptTokenFailure(): void {
    this.#tokenHandler = () => ({ status: 200, body: { errcode: 40001, errmsg: 'provider text' } });
  }

  /**
   * Never called: nothing in this suite sends a message.
   *
   * @throws {Error} Always, so a download that somehow sent would fail loudly.
   */
  send(request: WecomHttpRequest): Promise<WecomHttpResponse> {
    if (request.url.includes('/gettoken')) {
      this.tokenRequests.push(request);
      return Promise.resolve(this.#tokenHandler());
    }
    throw new Error(`this suite does not send: ${request.url}`);
  }

  download(request: WecomDownloadRequest): Promise<WecomDownloadResponse> {
    this.downloads.push(request);
    return Promise.resolve(this.#downloadHandler(request));
  }
}

/** A `gettoken` answer carrying a long-lived token. */
function tokenOk(token = 'token-1'): WecomHttpResponse {
  return { status: 200, body: { errcode: 0, access_token: token, expires_in: 7200 } };
}

/** A `media/get` answer carrying bytes. */
function mediaOk(
  bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  contentType: string | null = 'image/png',
): WecomDownloadResponse {
  return { kind: 'media', status: 200, contentType, bytes };
}

/** A `media/get` answer carrying the provider's JSON error document. */
function mediaErrcode(errcode: number): WecomDownloadResponse {
  return {
    kind: 'json',
    status: 200,
    body: { errcode, errmsg: 'provider text that must not be surfaced' },
  };
}

/** Build a downloader over a fake port, with its own memory token cache. */
function buildDownloader(
  http: WecomHttpClient,
  options: { readonly credentials?: WecomCredentialReader } = {},
): WecomMediaDownloader {
  const tokens = new WecomTokenProvider(http, new MemoryWecomTokenCache(), {
    credentials: readerOf(),
    timeoutMs: 1_000,
    now: () => NOW,
  });
  return new WecomMediaDownloader(http, tokens, {
    timeoutMs: 1_000,
    credentials: options.credentials ?? readerOf(),
  });
}

describe('WecomMediaDownloader request construction', () => {
  it('downloads the media id the message arrived with, and returns its bytes', async () => {
    const http = new FakeWecomHttp();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    http.scriptDownload(() => mediaOk(bytes));
    const downloader = buildDownloader(http);

    const result = await downloader.fetchMedia({ mediaId: 'MEDIA-IMAGE-1' });

    expect(result).toEqual({ ok: true, value: { mimeType: 'image/png', bytes } });
    expect(http.downloads).toHaveLength(1);
    expect(http.downloads[0]).toMatchObject({
      timeoutMs: 1_000,
      maxBytes: WECOM_MEDIA_DOWNLOAD_MAX_BYTES,
      url: 'https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=token-1&media_id=MEDIA-IMAGE-1',
    });
  });

  it('encodes a media id rather than pasting it into the query', async () => {
    // The id is provider-supplied text: an unescaped `&` or `#` in it would
    // turn the rest of the id into a second query parameter.
    const http = new FakeWecomHttp();
    const downloader = buildDownloader(http);

    await downloader.fetchMedia({ mediaId: 'a&b=c d' });

    expect(http.downloads[0]?.url).toContain('media_id=a%26b%3Dc%20d');
  });

  it('refuses before making any request when the transport is not configured', async () => {
    const http = new FakeWecomHttp();
    const downloader = buildDownloader(http, { credentials: unconfiguredReader('WECOM_CORP_ID') });

    const result = await downloader.fetchMedia({ mediaId: 'MEDIA-1' });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.code).toBe('channel_not_configured');
    expect(http.downloads).toHaveLength(0);
    expect(http.tokenRequests).toHaveLength(0);
  });

  it('refuses an empty media id without spending a token round trip on it', async () => {
    const http = new FakeWecomHttp();
    const downloader = buildDownloader(http);

    const result = await downloader.fetchMedia({ mediaId: '   ' });

    expect(result.ok ? '' : result.code).toBe('channel_invalid_request');
    expect(http.downloads).toHaveLength(0);
    expect(http.tokenRequests).toHaveLength(0);
  });

  it('reports a credential the provider refuses, without attempting a download', async () => {
    const http = new FakeWecomHttp();
    http.scriptTokenFailure();
    const downloader = buildDownloader(http);

    const result = await downloader.fetchMedia({ mediaId: 'MEDIA-1' });

    expect(result.ok ? '' : result.code).toBe('channel_not_configured');
    expect(http.downloads).toHaveLength(0);
  });
});

describe('WecomMediaDownloader failure handling', () => {
  it('maps a rejected media id onto a stable failure, without the provider’s text', async () => {
    const http = new FakeWecomHttp();
    http.scriptDownload(() => mediaErrcode(40007));
    const downloader = buildDownloader(http);

    const result = await downloader.fetchMedia({ mediaId: 'MEDIA-GONE' });

    expect(result).toMatchObject({
      ok: false,
      code: 'channel_invalid_request',
      retryable: false,
    });
    expect(result.ok ? '' : (result.message ?? '')).toContain('40007');
    expect(result.ok ? '' : (result.message ?? '')).not.toContain('provider text');
  });

  it('replays exactly once after an authentication failure, with a fresh token', async () => {
    const http = new FakeWecomHttp();
    http.scriptRotatingTokens();
    let calls = 0;
    http.scriptDownload(() => (++calls === 1 ? mediaErrcode(42001) : mediaOk()));
    const downloader = buildDownloader(http);

    const result = await downloader.fetchMedia({ mediaId: 'MEDIA-1' });

    expect(result.ok).toBe(true);
    expect(http.downloads.map((request) => request.url)).toEqual([
      expect.stringContaining('access_token=token-1'),
      expect.stringContaining('access_token=token-2'),
    ]);
  });

  it('stops after the second authentication failure', async () => {
    // A credential the provider has rejected twice will not become valid on a
    // third try; anything else would be a loop.
    const http = new FakeWecomHttp();
    http.scriptRotatingTokens();
    http.scriptDownload(() => mediaErrcode(40014));
    const downloader = buildDownloader(http);

    const result = await downloader.fetchMedia({ mediaId: 'MEDIA-1' });

    expect(result.ok ? '' : result.code).toBe('channel_not_configured');
    expect(http.downloads).toHaveLength(1 + 1);
    expect(WECOM_MAX_REQUESTS_PER_DOWNLOAD).toBe(4);
  });

  it('reports a size the transport refused to read, and does not call it retryable', async () => {
    const http = new FakeWecomHttp();
    http.scriptDownload(() => ({ kind: 'too_large', status: 200, limitBytes: 8_388_608 }));
    const downloader = buildDownloader(http);

    const result = await downloader.fetchMedia({ mediaId: 'MEDIA-BIG' });

    expect(result).toMatchObject({ ok: false, code: 'channel_provider_error', retryable: false });
    expect(result.ok ? '' : (result.message ?? '')).toContain('8388608');
  });

  it('reports an unreachable endpoint as worth another attempt', async () => {
    const http = new FakeWecomHttp();
    const failing: WecomHttpClient = {
      send: (request) => http.send(request),
      download: () => Promise.reject(new Error('socket hang up')),
    };

    const result = await new WecomMediaDownloader(
      failing,
      new WecomTokenProvider(http, new MemoryWecomTokenCache(), {
        credentials: readerOf(),
        timeoutMs: 1_000,
        now: () => NOW,
      }),
      { timeoutMs: 1_000, credentials: readerOf() },
    ).fetchMedia({ mediaId: 'MEDIA-1' });

    expect(result).toMatchObject({ ok: false, code: 'channel_provider_error', retryable: true });
  });

  it('does not label bytes the provider left unlabelled', async () => {
    // A content type the provider did not send is a fact nothing checked, and
    // the ingest path can store an unlabelled image — it cannot un-invent one.
    const http = new FakeWecomHttp();
    http.scriptDownload(() => mediaOk(new Uint8Array([1]), null));
    const downloader = buildDownloader(http);

    const result = await downloader.fetchMedia({ mediaId: 'MEDIA-1' });

    expect(result.ok ? result.value.mimeType : '').toBe('application/octet-stream');
  });

  it('reports a failure that carried no errcode from its HTTP status', async () => {
    const http = new FakeWecomHttp();
    http.scriptDownload(() => ({ kind: 'json', status: 502, body: null }));
    const downloader = buildDownloader(http);

    const result = await downloader.fetchMedia({ mediaId: 'MEDIA-1' });

    expect(result).toMatchObject({ ok: false, code: 'channel_provider_error', retryable: true });
    expect(result.ok ? '' : (result.message ?? '')).toContain('502');
  });
});

describe('mapWecomDownloadFailure', () => {
  it('classifies an authentication errcode as a credential problem, not a media one', () => {
    for (const errcode of [40001, 40013, 40014, 41001, 42001]) {
      expect(mapWecomDownloadFailure(errcode)).toMatchObject({ code: 'channel_not_configured' });
    }
  });

  it('classifies every other errcode as the media id being unusable', () => {
    for (const errcode of [40007, 45009, 0]) {
      expect(mapWecomDownloadFailure(errcode)).toMatchObject({
        code: 'channel_invalid_request',
        retryable: false,
      });
    }
  });
});
