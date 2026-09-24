import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { AppConfig } from '@kefu/core';
import { withTimeout } from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { DatabaseService } from '../database/database.service';

/** Result of one readiness dependency probe. */
export type DependencyStatus = 'ok' | 'unavailable';

/** Aggregate readiness of the API and the dependencies it reports on. */
export type ReadinessResult = {
  readonly ready: boolean;
  readonly postgres: DependencyStatus;
  readonly redis: DependencyStatus;
  readonly objectStorage: DependencyStatus;
  readonly worker: DependencyStatus;
};

/**
 * Readiness probes for the dependencies the platform needs to serve traffic.
 *
 * SDD-002 readiness covers PostgreSQL, Redis, object storage (MinIO) and the
 * worker process. Every probe runs under {@link AppConfig.healthTimeoutMs} and
 * never reports `ok` when the dependency is unreachable, so a failed probe can
 * not be mistaken for ready.
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {}

  /** Run every dependency probe and aggregate the result. */
  async readiness(): Promise<ReadinessResult> {
    const allUnavailable = ['unavailable', 'unavailable', 'unavailable', 'unavailable'] as const;
    const [postgres, redis, objectStorage, worker] = await withTimeout(
      Promise.all([
        this.checkPostgres(),
        this.checkRedis(),
        this.checkObjectStorage(),
        this.checkWorker(),
      ]),
      this.config.healthTimeoutMs,
      'readiness checks',
    ).catch(() => allUnavailable);

    return {
      ready: postgres === 'ok' && redis === 'ok' && objectStorage === 'ok' && worker === 'ok',
      postgres,
      redis,
      objectStorage,
      worker,
    };
  }

  private async checkPostgres(): Promise<DependencyStatus> {
    try {
      // The shared database boundary owns the pool; readiness only runs the
      // round trip. `ok` is reported only when PostgreSQL really answered the
      // parameter-free query, never from cached state.
      await withTimeout(this.database.ping(), this.config.healthTimeoutMs, 'PostgreSQL readiness');
      return 'ok';
    } catch {
      return 'unavailable';
    }
  }

  private async checkRedis(): Promise<DependencyStatus> {
    const redis = new Redis(this.config.redisUrl.unwrap(), {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: this.config.healthTimeoutMs,
      commandTimeout: this.config.healthTimeoutMs,
      maxRetriesPerRequest: 0,
    });
    // Connection failures are surfaced through the connect()/ping() promises;
    // this listener keeps ioredis from printing an "Unhandled error event" line.
    redis.on('error', () => undefined);
    try {
      await withTimeout(redis.connect(), this.config.healthTimeoutMs, 'Redis connect');
      await withTimeout(redis.ping(), this.config.healthTimeoutMs, 'Redis readiness ping');
      return 'ok';
    } catch {
      return 'unavailable';
    } finally {
      redis.disconnect();
    }
  }

  private async checkObjectStorage(): Promise<DependencyStatus> {
    const { endpoint, port, useSsl } = this.config.objectStorage;
    const scheme = useSsl ? 'https' : 'http';
    const url = `${scheme}://${endpoint}:${port}/minio/health/live`;
    return this.probeHttpGet(url, 'object storage readiness');
  }

  private async checkWorker(): Promise<DependencyStatus> {
    const host = loopbackIfWildcard(this.config.workerHealthHost);
    const url = `http://${host}:${this.config.workerHealthPort}/health/ready`;
    return this.probeHttpGet(url, 'worker readiness');
  }

  private async probeHttpGet(url: string, label: string): Promise<DependencyStatus> {
    try {
      const status = await withTimeout(
        httpGetStatus(url, this.config.healthTimeoutMs),
        this.config.healthTimeoutMs,
        label,
      );
      return status >= 200 && status < 300 ? 'ok' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }
}

/**
 * Resolve a bind-style host to a client destination.
 *
 * A server that binds `0.0.0.0` or `::` listens on every interface; those are
 * not valid connection targets, so the probe falls back to loopback (which is
 * where the local worker actually answers).
 */
function loopbackIfWildcard(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') {
    return '127.0.0.1';
  }
  return host;
}

/**
 * Perform a GET and resolve with the HTTP status code.
 *
 * The connection is never pooled (`agent: false`) so a short-lived probe cannot
 * keep an idle socket open in the process, and the request is aborted at the
 * deadline so the probe cannot hang indefinitely.
 */
function httpGetStatus(url: string, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const onResponse = (response: IncomingMessage): void => {
      // Drain the body so the socket is released back to the OS.
      response.resume();
      const { statusCode } = response;
      finish(() => {
        if (statusCode === undefined) {
          reject(new Error('HTTP probe returned no status code'));
        } else {
          resolve(statusCode);
        }
      });
    };

    const request = url.startsWith('https:')
      ? httpsGet(url, { agent: false }, onResponse)
      : httpGet(url, { agent: false }, onResponse);

    // Arm the deadline only once the request exists. If httpGet/httpsGet throws
    // synchronously (for example on a malformed URL that the config parser still
    // accepts), the executor rejects the probe and there is no timeout left to
    // fire later against an uninitialized request.
    const timer = setTimeout(() => {
      request.destroy(new Error(`HTTP probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    request.once('error', (error: Error) => {
      finish(() => reject(error));
    });
  });
}
