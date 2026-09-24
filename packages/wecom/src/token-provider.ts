/**
 * The WeChat Customer Service access-token provider.
 *
 * Every customer-service call needs an `access_token` that WeCom mints from the
 * corp id and the customer-service secret and expires after two hours. The
 * provider owns the whole lifecycle so no caller has to:
 *
 * - **read-through cache**: a token is reused until shortly before it expires,
 *   which keeps the `gettoken` call count far below the provider's daily quota;
 * - **expiry refresh**: the cached value is stored with the provider's own
 *   `expires_in` minus a safety margin, so an expired token is never handed out;
 * - **single retry after an authentication failure**: {@link
 *   WecomTokenProvider.invalidate} drops the cached token so the caller can
 *   re-acquire and replay exactly once — never in a loop;
 * - **stable error mapping**: a provider answer becomes a
 *   {@link ChannelResult} with one of the platform's channel codes, so an
 *   application caller never inspects a WeCom `errcode`.
 *
 * The cache is a port ({@link WecomTokenCache}) because the durable
 * implementation is Redis, which a unit test must not need.
 *
 * The provider is app-neutral: it holds no reference to any application module.
 * What a *deployment* wants to record about a token operation — the API process
 * turns a fetched token into its "the real transport is connected" claim — is
 * reported through the {@link WecomTokenProviderOptions.onConnectionProven}
 * observer, which each process wires to its own state. A Worker that only sends
 * passes nothing and is unaffected.
 */

import Redis from 'ioredis';
import type { ChannelResult, WecomCredentialValues } from '@kefu/core';
import type { WecomHttpClient } from './http-client';
import { asRecord, numberOf, textOf } from './readers';
import { useWecomCredentials, type WecomCredentialReader } from './credentials';

/** WeCom's access-token endpoint. */
const TOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';

/** `expires_in` WeCom documents, used when the answer omits it. */
const DEFAULT_EXPIRES_IN_SECONDS = 7200;

/** How long before real expiry a cached token stops being served. */
const DEFAULT_REFRESH_MARGIN_SECONDS = 120;

/** How long a successful connection probe is trusted before checking again. */
const DEFAULT_PROBE_CACHE_MS = 60_000;

/**
 * WeCom error codes that mean the credential itself was rejected.
 *
 * They are the codes a caller must react to by dropping the cached token and
 * fetching a new one, so they are the only ones the provider treats as
 * re-authenticatable.
 */
const AUTHENTICATION_ERROR_CODES: ReadonlySet<number> = new Set([
  40001, // invalid credential (secret)
  40013, // invalid corp id
  40014, // invalid access token
  41001, // missing access token
  42001, // access token expired
]);

/** Whether a WeCom `errcode` means "re-acquire the token and try once more". */
export function isWecomAuthenticationError(errcode: number | null): boolean {
  return errcode !== null && AUTHENTICATION_ERROR_CODES.has(errcode);
}

/**
 * A token cache.
 *
 * Both mutations are best-effort by contract: a cache outage must degrade to
 * "fetch a token again", never to "the channel is down", so an implementation
 * swallows its own transport failures.
 */
export interface WecomTokenCache {
  /** Read a cached token, or `null` when absent or expired. */
  get(key: string): Promise<string | null>;
  /** Store a token for `ttlSeconds`. */
  set(key: string, token: string, ttlSeconds: number): Promise<void>;
  /** Drop a token, used after the provider rejects it. */
  delete(key: string): Promise<void>;
}

/** Injection token carrying the bound {@link WecomTokenCache}. */
export const WECOM_TOKEN_CACHE = Symbol('WECOM_TOKEN_CACHE');

/** In-process token cache: the deterministic test double, and a safe default. */
export class MemoryWecomTokenCache implements WecomTokenCache {
  readonly #entries = new Map<string, { readonly token: string; readonly expiresAtMs: number }>();

  /** @inheritdoc */
  async get(key: string): Promise<string | null> {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAtMs <= Date.now()) {
      this.#entries.delete(key);
      return null;
    }
    return entry.token;
  }

  /** @inheritdoc */
  async set(key: string, token: string, ttlSeconds: number): Promise<void> {
    this.#entries.set(key, { token, expiresAtMs: Date.now() + ttlSeconds * 1000 });
  }

  /** @inheritdoc */
  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }
}

/**
 * Redis-backed token cache.
 *
 * The client is created lazily and with `lazyConnect`, so binding this cache
 * neither opens a socket at boot nor makes a process's readiness depend on
 * Redis; the first token operation is what connects. Every operation is wrapped,
 * so a cache that is unreachable reads as a miss and the provider simply asks
 * WeCom for a token again.
 *
 * Two processes sharing one Redis therefore share one cached token, which is
 * what keeps the `gettoken` count low when the API and the Worker both send.
 */
export class RedisWecomTokenCache implements WecomTokenCache {
  #client: Redis | null = null;

  /**
   * @param url - Redis connection string from configuration.
   */
  constructor(private readonly url: string) {}

  /** @inheritdoc */
  async get(key: string): Promise<string | null> {
    try {
      return await this.client().get(key);
    } catch {
      // An unreachable cache is a miss, not a channel failure.
      return null;
    }
  }

  /** @inheritdoc */
  async set(key: string, token: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client().set(key, token, 'EX', ttlSeconds);
    } catch {
      // Losing the cache only costs extra gettoken calls.
    }
  }

  /** @inheritdoc */
  async delete(key: string): Promise<void> {
    try {
      await this.client().del(key);
    } catch {
      // A stale entry still expires on its own; the caller re-fetches anyway.
    }
  }

  /** Release the connection, used on shutdown and by tests. */
  close(): void {
    this.#client?.disconnect();
    this.#client = null;
  }

  private client(): Redis {
    if (this.#client === null) {
      const client = new Redis(this.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      // ioredis reports connection trouble as an event; without a listener it
      // prints an unhandled error line. The operations above already turn that
      // trouble into a cache miss.
      client.on('error', () => undefined);
      this.#client = client;
    }
    return this.#client;
  }
}

/** Options for {@link WecomTokenProvider}. */
export type WecomTokenProviderOptions = {
  /**
   * Reads the account a token should be minted for, at the moment one is needed.
   *
   * Consulted on every operation rather than held, so a credential the console
   * replaced mid-flight is what the next request authenticates with. Two
   * operations of one message — a send and the token it needs — read it once
   * each, which is deliberate: a token that answers a *different* account than
   * the send would be a message nobody can explain.
   */
  readonly credentials: WecomCredentialReader;
  /** Deadline applied to each `gettoken` request. */
  readonly timeoutMs: number;
  /** Injectable clock, so expiry and probe caching are deterministic in tests. */
  readonly now?: () => number;
  readonly refreshMarginSeconds?: number;
  readonly probeCacheMs?: number;
  /**
   * What a token operation proved about reaching WeCom, reported to the process
   * that owns a connection claim. `true` only after WeCom answered with a token;
   * `false` when the credential was rejected or the endpoint was unreachable.
   *
   * A process with nothing to claim (the Worker) simply omits it. It carries one
   * boolean and never a token, a secret or a provider message.
   */
  readonly onConnectionProven?: (connected: boolean) => void;
};

/**
 * Acquires, caches and refreshes the customer-service access token.
 *
 * The secret is held privately and only ever placed in the `gettoken` URL; it
 * is never returned, logged or attached to a failure message.
 */
export class WecomTokenProvider {
  readonly #now: () => number;
  readonly #refreshMarginSeconds: number;
  readonly #probeCacheMs: number;
  readonly #onConnectionProven: (connected: boolean) => void;
  #lastProbeOkAtMs: number | null = null;

  /**
   * @param http - Outbound HTTP port.
   * @param cache - Token cache port.
   * @param options - Credentials, deadline, clock and connection observer.
   */
  constructor(
    private readonly http: WecomHttpClient,
    private readonly cache: WecomTokenCache,
    private readonly options: WecomTokenProviderOptions,
  ) {
    this.#now = options.now ?? (() => Date.now());
    this.#refreshMarginSeconds = options.refreshMarginSeconds ?? DEFAULT_REFRESH_MARGIN_SECONDS;
    this.#probeCacheMs = options.probeCacheMs ?? DEFAULT_PROBE_CACHE_MS;
    this.#onConnectionProven = options.onConnectionProven ?? (() => undefined);
  }

  /**
   * Return a usable access token, from the cache when one is still valid.
   *
   * @returns The token, or a stable channel failure.
   */
  async get(): Promise<ChannelResult<string>> {
    const account = await useWecomCredentials(this.options.credentials);
    if (account._tag === 'refused') {
      return account.refusal;
    }
    const cached = await this.cache.get(cacheKeyOf(account.values.corpId));
    if (cached !== null) {
      return { ok: true, value: cached };
    }
    return this.#fetchFresh(account.values);
  }

  /**
   * Drop the cached token after the provider rejected it — or after the
   * credential it was minted for was replaced.
   *
   * The next {@link get} then fetches a new one. This is what makes the
   * caller's single retry meaningful instead of a repeat of the same stale
   * token, and the second use is why a write from the console calls it before
   * probing: {@link probe} trusts a recent success, and that success was about
   * different values.
   *
   * The account is read first, because the cache is keyed by it. A replacement
   * that changes the corp id leaves the old entry behind — it belongs to an
   * account nothing is configured with any more, so nothing will ask for it
   * again and it expires on its own.
   */
  async invalidate(): Promise<void> {
    const resolution = await this.options.credentials();
    if (resolution._tag === 'ready') {
      await this.cache.delete(cacheKeyOf(resolution.values.corpId));
    }
    this.#lastProbeOkAtMs = null;
  }

  /**
   * Check whether the credentials and the network actually reach WeCom.
   *
   * A cached token proves nothing about connectivity, so the probe always asks
   * WeCom for a fresh token. Successful probes are remembered for a short
   * window, which keeps an operator refreshing the channel page from spending
   * the provider's daily `gettoken` quota; {@link invalidate} is what forgets
   * one, and a credential replaced through the console is always invalidated
   * before it is probed.
   *
   * An account the resolution refuses is not probed at all: it cannot
   * authenticate, so there is nothing to ask WeCom and nothing to learn from
   * asking. That reads as "not connected", which is what it is.
   *
   * @returns `true` only when WeCom answered with a token.
   */
  async probe(): Promise<boolean> {
    const account = await useWecomCredentials(this.options.credentials);
    if (account._tag === 'refused') {
      return false;
    }
    const now = this.#now();
    if (this.#lastProbeOkAtMs !== null && now - this.#lastProbeOkAtMs < this.#probeCacheMs) {
      return true;
    }
    const result = await this.#fetchFresh(account.values);
    this.#lastProbeOkAtMs = result.ok ? now : null;
    return result.ok;
  }

  /** Ask WeCom for a token and cache it, recording what the attempt proved. */
  async #fetchFresh(credentials: WecomCredentialValues): Promise<ChannelResult<string>> {
    let status: number;
    let body: unknown;
    try {
      const response = await this.http.send({
        method: 'GET',
        url: `${TOKEN_URL}?corpid=${encodeURIComponent(credentials.corpId)}&corpsecret=${encodeURIComponent(credentials.kfSecret)}`,
        timeoutMs: this.options.timeoutMs,
      });
      status = response.status;
      body = response.body;
    } catch {
      // Nothing was proven about the credential, only that WeCom was not
      // reachable, so the connection claim is withdrawn rather than kept.
      this.#onConnectionProven(false);
      return {
        ok: false,
        code: 'channel_provider_error',
        message: 'the WeCom token endpoint could not be reached',
        retryable: true,
      };
    }

    const record = asRecord(body);
    const errcode = numberOf(record?.['errcode']);
    const token = textOf(record?.['access_token']);
    if (errcode === 0 && token !== null) {
      const expiresIn = numberOf(record?.['expires_in']) ?? DEFAULT_EXPIRES_IN_SECONDS;
      const ttlSeconds = Math.max(1, expiresIn - this.#refreshMarginSeconds);
      await this.cache.set(cacheKeyOf(credentials.corpId), token, ttlSeconds);
      // A fresh token is the platform's proof that the credentials and the
      // network really work, which is the only thing that may claim a
      // connection.
      this.#onConnectionProven(true);
      return { ok: true, value: token };
    }

    this.#onConnectionProven(false);
    return mapTokenFailure(errcode, status);
  }

}

/**
 * Cache key for one corp's customer-service token.
 *
 * Keyed by the corp id alone, because that is what the token is *for*: two
 * accounts of the same corp share one customer-service token, and a secret
 * replaced under the same corp id is dropped explicitly by
 * {@link WecomTokenProvider.invalidate} rather than by changing the key.
 *
 * @param corpId - Corp the token is minted for.
 * @returns The cache key.
 */
function cacheKeyOf(corpId: string): string {
  return `wecom:kf-access-token:${corpId}`;
}

/**
 * Turn a rejected `gettoken` answer into a stable channel failure.
 *
 * The provider's `errmsg` is deliberately not carried. It is unbounded text the
 * provider controls, and a channel failure reaches API results, delivery
 * diagnostics and log lines that are documented as platform-authored; the
 * numeric `errcode` stays because it is a protocol value a caller may classify
 * on.
 *
 * @param errcode - The provider's `errcode`, or `null` when none was readable.
 * @param status - HTTP status the endpoint answered with.
 * @returns The stable channel failure.
 */
function mapTokenFailure(errcode: number | null, status: number): ChannelResult<string> {
  if (isWecomAuthenticationError(errcode)) {
    return {
      ok: false,
      code: 'channel_not_configured',
      message: `WeCom rejected the customer-service credential (errcode ${errcode ?? 'unknown'})`,
      retryable: false,
    };
  }
  return {
    ok: false,
    code: 'channel_provider_error',
    message:
      errcode === null
        ? `the WeCom token endpoint answered with HTTP ${status}`
        : `the WeCom token endpoint rejected the request (errcode ${errcode})`,
    retryable: status >= 500 || status === 0,
  };
}
