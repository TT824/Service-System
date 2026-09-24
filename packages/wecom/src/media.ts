/**
 * The inbound half of WeCom media: fetching what a customer sent.
 *
 * This is {@link WecomMediaUploader}'s mirror and it is deliberately its twin:
 * the same token provider (so the cache, the expiry margin and the refresh
 * policy stay in one place), the same single replay after an authentication
 * failure, the same refusal to let the provider's `errmsg` or the bytes touch
 * anything but the caller, and the same stable failure vocabulary. An upload
 * turns bytes into a `media_id`; a download turns a `media_id` back into bytes,
 * and the two are only correct if they agree about which credential they used
 * and what a rejection means.
 *
 * What is *not* shared is the endpoint's answer shape. `media/get` replies with
 * either raw bytes and a content type, or — when the media id is not one this
 * account may read — the same JSON error document every other WeCom endpoint
 * uses. That is why this file reads `WecomHttpClient.download` rather than
 * `send`, and why a JSON answer here is a failure with an `errcode` rather than
 * a corrupt picture with a `200`.
 */

import type { ChannelResult, FetchMediaResult } from '@kefu/core';
import type { WecomDownloadResponse, WecomHttpClient } from './http-client';
import { WECOM_AUTH_REPLAY_ATTEMPTS } from './outbound';
import { useWecomCredentials, type WecomCredentialReader } from './credentials';
import { asRecord, numberOf } from './readers';
import { isWecomAuthenticationError, type WecomTokenProvider } from './token-provider';

/** WeCom's temporary-media download endpoint. */
const DOWNLOAD_URL = 'https://qyapi.weixin.qq.com/cgi-bin/media/get';

/**
 * The largest body this transport will read back.
 *
 * A bound on the process, not a product rule: the ingest path decides what is
 * worth keeping (and degrades a picture it will not store), but that decision
 * happens after the bytes are in hand, so something has to refuse a body of
 * unexpected size *while* reading it. Well above any image a WeCom
 * customer-service session can carry, and low enough that a wrong URL cannot
 * exhaust the heap.
 */
export const WECOM_MEDIA_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;

/** The most HTTP requests one download attempt can make: fetch a token, then download. */
const REQUESTS_PER_DOWNLOAD_ATTEMPT = 2;

/**
 * The most HTTP requests one {@link WecomMediaDownloader.fetchMedia} call can make.
 *
 * The same bound as an upload, for the same reason: each attempt may fetch a
 * token and then download, and an authentication failure permits
 * {@link WECOM_AUTH_REPLAY_ATTEMPTS} more attempts.
 */
export const WECOM_MAX_REQUESTS_PER_DOWNLOAD =
  REQUESTS_PER_DOWNLOAD_ATTEMPT * (1 + WECOM_AUTH_REPLAY_ATTEMPTS);

/**
 * The media seam every inbound image goes through.
 *
 * Publishing the download as its own port is what lets the adapter that owns
 * the customer-service account also own the fetch, without the ingest path
 * having to know the endpoint, the credential or how a rejected media id is
 * classified.
 */
export interface WecomMediaDownloadTransport {
  /**
   * Download one media file the provider holds for this account.
   *
   * @param input - The provider `media_id` a message arrived with.
   * @returns The bytes and their content type, or a stable channel failure.
   */
  fetchMedia(input: { readonly mediaId: string }): Promise<ChannelResult<FetchMediaResult>>;
}

/** Everything the media downloader needs that is not a port. */
export type WecomMediaDownloaderOptions = {
  /** Deadline applied to each provider request. */
  readonly timeoutMs: number;
  /** Reads the account this download should be made as, as for a send. */
  readonly credentials: WecomCredentialReader;
};

/** Result of one `media/get` attempt, keeping the `errcode` for the retry decision. */
type DownloadAttempt = {
  readonly errcode: number | null;
  readonly result: ChannelResult<FetchMediaResult>;
};

/**
 * Downloads one media file through `media/get`.
 *
 * The order of operations is the send path's: refuse before making any request
 * when a credential is missing, then download, and only retry when the provider
 * said the *credential* was the problem. A media id the provider will not serve
 * is final — asking a second time with the same token cannot make a deleted
 * file exist.
 */
export class WecomMediaDownloader implements WecomMediaDownloadTransport {
  /**
   * @param http - Outbound HTTP port.
   * @param tokens - Access-token provider, which owns the cache and refresh.
   * @param options - Deadline and configuration state.
   */
  constructor(
    private readonly http: WecomHttpClient,
    private readonly tokens: WecomTokenProvider,
    private readonly options: WecomMediaDownloaderOptions,
  ) {}

  /** @inheritdoc */
  async fetchMedia(input: { readonly mediaId: string }): Promise<ChannelResult<FetchMediaResult>> {
    const account = await useWecomCredentials(this.options.credentials);
    if (account._tag === 'refused') {
      return account.refusal;
    }
    if (input.mediaId.trim().length === 0) {
      // Nothing on the wire can be fetched for an empty id, and asking would
      // spend a token round trip to be told so.
      return {
        ok: false,
        code: 'channel_invalid_request',
        message: 'a WeCom media download needs a media id',
        retryable: false,
      };
    }

    const first = await this.#downloadOnce(input.mediaId);
    if (first.result.ok || !isWecomAuthenticationError(first.errcode)) {
      return first.result;
    }
    // The token was rejected. Drop it so the replay asks WeCom for a new one,
    // and replay exactly once — a second authentication failure is final.
    await this.tokens.invalidate();
    const second = await this.#downloadOnce(input.mediaId);
    return second.result;
  }

  /** Perform one `media/get` call, reporting the provider's `errcode` too. */
  async #downloadOnce(mediaId: string): Promise<DownloadAttempt> {
    const token = await this.tokens.get();
    if (!token.ok) {
      return { errcode: null, result: token };
    }
    let response: WecomDownloadResponse;
    try {
      response = await this.http.download({
        url: `${DOWNLOAD_URL}?access_token=${encodeURIComponent(token.value)}&media_id=${encodeURIComponent(mediaId)}`,
        timeoutMs: this.options.timeoutMs,
        maxBytes: WECOM_MEDIA_DOWNLOAD_MAX_BYTES,
      });
    } catch {
      return {
        errcode: null,
        result: {
          ok: false,
          code: 'channel_provider_error',
          message: 'the WeCom media download endpoint could not be reached',
          retryable: true,
        },
      };
    }

    if (response.kind === 'media') {
      return {
        errcode: 0,
        result: {
          ok: true,
          value: {
            // A provider that served bytes without naming their type is not
            // asked twice: the ingest path can store an unlabelled image, and
            // inventing a type would be a claim about bytes nothing checked.
            mimeType: response.contentType ?? 'application/octet-stream',
            bytes: response.bytes,
          },
        },
      };
    }
    if (response.kind === 'too_large') {
      // This client's own refusal, not the provider's: the bytes past the bound
      // were never read, so there is no `errcode` to classify and no reason to
      // believe a second attempt would be smaller.
      return {
        errcode: null,
        result: {
          ok: false,
          code: 'channel_provider_error',
          message: `the WeCom media download exceeded the ${response.limitBytes}-byte read limit`,
          retryable: false,
        },
      };
    }

    const errcode = numberOf(asRecord(response.body)?.['errcode']);
    if (errcode === null) {
      // Something answered that is neither media nor a WeCom error document, so
      // the HTTP status is the only evidence available.
      return {
        errcode: null,
        result: {
          ok: false,
          code: 'channel_provider_error',
          message: `the WeCom media download endpoint answered ${response.status} with something that is not media`,
          retryable: response.status >= 500,
        },
      };
    }
    return { errcode, result: mapWecomDownloadFailure(errcode) };
  }
}

/**
 * Map a rejected `media/get` answer onto a stable channel failure.
 *
 * The provider's `errmsg` is deliberately not carried, exactly as for an
 * upload: it is unbounded text under the provider's control, and the only
 * things this failure may ever reach are platform-authored diagnostics.
 *
 * @param errcode - The provider's `errcode`.
 * @returns The stable channel failure.
 */
export function mapWecomDownloadFailure(errcode: number): ChannelResult<FetchMediaResult> {
  if (isWecomAuthenticationError(errcode)) {
    return {
      ok: false,
      code: 'channel_not_configured',
      message: `WeCom rejected the customer-service credential (errcode ${errcode})`,
      retryable: false,
    };
  }
  // Every remaining `media/get` rejection is about the id: unknown, expired,
  // deleted, or belonging to another account (40007 and its neighbours). None
  // of them becomes truer on a second attempt.
  return {
    ok: false,
    code: 'channel_invalid_request',
    message: `the WeCom media download endpoint rejected the media id (errcode ${errcode})`,
    retryable: false,
  };
}
