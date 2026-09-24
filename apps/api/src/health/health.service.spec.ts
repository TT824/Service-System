import { describe, expect, it, vi } from 'vitest';
import { parseAppConfig, type AppConfig } from '@kefu/core';
import { DatabaseService } from '../database/database.service';
import { HealthService } from './health.service';

/**
 * Build a configuration whose every dependency endpoint points at a closed
 * local port, so the probes fail deterministically without Docker or a running
 * service.
 */
function unreachableConfig(overrides: Record<string, string> = {}): AppConfig {
  const parsed = parseAppConfig({
    APP_ENV: 'test',
    HEALTH_TIMEOUT_MS: '300',
    DATABASE_URL: 'postgres://kefu:kefu@127.0.0.1:1/kefu',
    REDIS_URL: 'redis://127.0.0.1:1',
    OBJECT_STORAGE_ENDPOINT: '127.0.0.1',
    OBJECT_STORAGE_PORT: '1',
    WORKER_HEALTH_HOST: '127.0.0.1',
    WORKER_HEALTH_PORT: '1',
    ...overrides,
  });
  if (parsed._tag !== 'ok') {
    throw new Error(`test config could not be parsed: ${parsed.error.message}`);
  }
  return parsed.config;
}

/**
 * Open a {@link HealthService} on top of a real {@link DatabaseService}.
 *
 * The database pool is lazy and pointed at a closed port, so no external
 * service is required. Callers close the pool through the Nest lifecycle hook
 * (`onModuleDestroy`) when they are done.
 */
function openHealth(config: AppConfig): { health: HealthService; database: DatabaseService } {
  const database = new DatabaseService(config);
  return { health: new HealthService(config, database), database };
}

describe('HealthService readiness', () => {
  it('never reports ready when every dependency is unreachable', async () => {
    const { health, database } = openHealth(unreachableConfig());
    try {
      const result = await health.readiness();

      expect(result.ready).toBe(false);
      expect(result.postgres).toBe('unavailable');
      expect(result.redis).toBe('unavailable');
      expect(result.objectStorage).toBe('unavailable');
      expect(result.worker).toBe('unavailable');
    } finally {
      await database.onModuleDestroy();
    }
  });

  it('resolves within the configured overall deadline', async () => {
    const { health, database } = openHealth(unreachableConfig());
    try {
      const startedAt = Date.now();
      const result = await health.readiness();
      const elapsedMs = Date.now() - startedAt;

      expect(result.ready).toBe(false);
      // Each probe is bounded by HEALTH_TIMEOUT_MS (300ms); the aggregate must
      // stay well below the Vitest default timeout so a hang fails the test.
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      await database.onModuleDestroy();
    }
  });

  it('reports postgres ok only after the shared database probe succeeds', async () => {
    const config = unreachableConfig();
    const { health, database } = openHealth(config);
    // The pool itself points at a closed port; resolve the shared boundary
    // probe to prove readiness maps a successful round trip to `ok`.
    const ping = vi.spyOn(database, 'ping').mockResolvedValue(undefined);
    try {
      const result = await health.readiness();

      expect(ping).toHaveBeenCalledTimes(1);
      expect(result.postgres).toBe('ok');
      expect(result.ready).toBe(false);
    } finally {
      ping.mockRestore();
      await database.onModuleDestroy();
    }
  });

  it('keeps a failing postgres probe from leaking the connection string', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const config = unreachableConfig({
      DATABASE_URL: 'postgres://kefu:super-secret-password@127.0.0.1:1/kefu',
    });
    const { health, database } = openHealth(config);
    try {
      const result = await health.readiness();

      expect(result.postgres).toBe('unavailable');

      const written = write.mock.calls.map((call) => String(call[0])).join('');
      expect(written).not.toContain('super-secret-password');
      expect(written).not.toContain('postgres://');
    } finally {
      write.mockRestore();
      await database.onModuleDestroy();
    }
  });

  it('resolves unavailable without a delayed uncaught exception when a probe URL cannot be constructed', async () => {
    // `::1` is accepted by the config parser (a non-empty endpoint string) but
    // produces `http://::1:<port>/...`, which node:http/https rejects while
    // constructing the request (`ERR_INVALID_URL`), before any I/O starts.
    const config = unreachableConfig({ OBJECT_STORAGE_ENDPOINT: '::1' });
    const { health, database } = openHealth(config);

    const uncaught: unknown[] = [];
    const onUncaughtException = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaughtException);
    try {
      const result = await health.readiness();

      // The synchronous construction failure must resolve through the normal
      // unavailable contract that the controller maps to 503.
      expect(result.ready).toBe(false);
      expect(result.objectStorage).toBe('unavailable');

      // A pre-fix orphan timeout would fire after HEALTH_TIMEOUT_MS and raise
      // an uncaught ReferenceError against the uninitialized request. Wait past
      // that window so the test observes the process boundary, not just the
      // immediate promise rejection.
      const waitMs = config.healthTimeoutMs * 2 + 100;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitMs);
      });
      expect(uncaught).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaughtException);
      await database.onModuleDestroy();
    }
  });
});
