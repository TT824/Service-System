import { describe, expect, it, vi } from 'vitest';
import { parseAppConfig, type AppConfig } from '@kefu/core';
import {
  DatabaseService,
  DATABASE_POOL_CONNECTION_TIMEOUT_MS,
  DATABASE_POOL_IDLE_TIMEOUT_MS,
  DATABASE_POOL_MAX,
  DATABASE_STATEMENT_TIMEOUT_MS,
} from './database.service';

const TEST_DATABASE_URL = 'postgres://kefu:kefu@127.0.0.1:1/kefu';

/**
 * Build a configuration whose database points at a closed local port so pool
 * behaviour can be observed offline: the pool stays lazy until a query runs
 * and any connection attempt fails fast with ECONNREFUSED.
 */
function offlineConfig(databaseUrl: string = TEST_DATABASE_URL): AppConfig {
  const parsed = parseAppConfig({
    APP_ENV: 'test',
    DATABASE_URL: databaseUrl,
  });
  if (parsed._tag !== 'ok') {
    throw new Error(`test config could not be parsed: ${parsed.error.message}`);
  }
  return parsed.config;
}

describe('DatabaseService pool', () => {
  it('creates one bounded pool from the configured database url', async () => {
    const service = new DatabaseService(offlineConfig());

    try {
      expect(service.pool.options.connectionString).toBe(TEST_DATABASE_URL);
      expect(service.pool.options.max).toBe(DATABASE_POOL_MAX);
      expect(service.pool.options.connectionTimeoutMillis).toBe(
        DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      );
      expect(service.pool.options.statement_timeout).toBe(DATABASE_STATEMENT_TIMEOUT_MS);
      expect(service.pool.options.idleTimeoutMillis).toBe(DATABASE_POOL_IDLE_TIMEOUT_MS);
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('closes the pool through the Nest lifecycle shutdown hook', async () => {
    const service = new DatabaseService(offlineConfig());

    await service.onModuleDestroy();

    await expect(service.ping()).rejects.toThrow(/after calling end on the pool/);
  });

  it('probes connectivity with a parameter-free SELECT 1', async () => {
    const service = new DatabaseService(offlineConfig());
    const query = vi.spyOn(service.pool, 'query').mockResolvedValue({
      rows: [],
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: [],
    } as never);

    try {
      await service.ping();
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith('SELECT 1');
    } finally {
      query.mockRestore();
      await service.onModuleDestroy();
    }
  });

  it('swallows idle-client pool errors without logging driver detail', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const service = new DatabaseService(
      offlineConfig('postgres://kefu:secret-pool-password@127.0.0.1:1/kefu'),
    );

    try {
      // A dropped idle connection reaches the pool 'error' event with no
      // awaiting query. The service must absorb it (never crash the process)
      // and must not print the raw driver message or connection string.
      const driverError = new Error(
        'terminating connection: postgres://kefu:secret-pool-password@127.0.0.1:1/kefu',
      );
      expect(() => service.pool.emit('error', driverError)).not.toThrow();

      const written = write.mock.calls.map((call) => String(call[0])).join('');
      expect(written).not.toContain('secret-pool-password');
      expect(written).not.toContain('postgres://');
      expect(written).not.toContain('terminating connection');
    } finally {
      write.mockRestore();
      await service.onModuleDestroy();
    }
  });
});
