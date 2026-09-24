import { describe, expect, it, vi } from 'vitest';
import { parseAppConfig, type AppConfig } from '@kefu/core';
import { DatabaseService } from '../database/database.service';
import { TransactionManager, type TransactionClient } from './transaction-manager';

/** Closed local port: the pool stays lazy and never opens a real connection. */
const TEST_DATABASE_URL = 'postgres://kefu:kefu@127.0.0.1:1/kefu';

function offlineConfig(): AppConfig {
  const parsed = parseAppConfig({ APP_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL });
  if (parsed._tag !== 'ok') {
    throw new Error(`test config could not be parsed: ${parsed.error.message}`);
  }
  return parsed.config;
}

type RecordedClient = {
  readonly client: TransactionClient;
  readonly statements: string[];
  readonly releases: Array<Error | undefined>;
};

/** Stub connection that records every statement and can fail on demand. */
function recordingClient(onStatement?: (sql: string) => void): RecordedClient {
  const statements: string[] = [];
  const releases: Array<Error | undefined> = [];
  const client: TransactionClient = {
    query: async (sql: string) => {
      statements.push(sql);
      onStatement?.(sql);
      return { rows: [], rowCount: 0 };
    },
    release: (error?: Error) => {
      releases.push(error);
    },
  };
  return { client, statements, releases };
}

/**
 * Attach a recording connection to a real (but never connected) pool and run
 * `body` with a transaction manager bound to it.
 */
async function withManager(
  recorded: RecordedClient,
  body: (manager: TransactionManager) => Promise<void>,
): Promise<void> {
  const service = new DatabaseService(offlineConfig());
  const connect = vi.spyOn(service.pool, 'connect').mockResolvedValue(recorded.client as never);

  try {
    await body(new TransactionManager(service));
  } finally {
    connect.mockRestore();
    await service.onModuleDestroy();
  }
}

describe('TransactionManager', () => {
  it('commits the unit of work on the single connection it borrowed', async () => {
    const recorded = recordingClient();

    await withManager(recorded, async (manager) => {
      const result = await manager.run(async (client) => {
        await client.query('INSERT INTO user_accounts (id) VALUES ($1)', ['u-1']);
        return 'created';
      });
      expect(result).toBe('created');
    });

    expect(recorded.statements).toEqual([
      'BEGIN',
      'INSERT INTO user_accounts (id) VALUES ($1)',
      'COMMIT',
    ]);
    // Released exactly once, without an error: the connection is reusable.
    expect(recorded.releases).toEqual([undefined]);
  });

  it('rolls back the transaction and rethrows when the work fails', async () => {
    const recorded = recordingClient();
    const failure = new Error('unique violation');

    await withManager(recorded, async (manager) => {
      await expect(
        manager.run(async (client) => {
          await client.query('INSERT INTO user_accounts (id) VALUES ($1)', ['u-1']);
          throw failure;
        }),
      ).rejects.toBe(failure);
    });

    expect(recorded.statements).toEqual([
      'BEGIN',
      'INSERT INTO user_accounts (id) VALUES ($1)',
      'ROLLBACK',
    ]);
    expect(recorded.releases).toEqual([undefined]);
  });

  it('rolls back when the commit itself fails', async () => {
    const recorded = recordingClient((sql) => {
      if (sql === 'COMMIT') {
        throw new Error('commit failed');
      }
    });

    await withManager(recorded, async (manager) => {
      await expect(manager.run(async () => 'unused')).rejects.toThrow('commit failed');
    });

    expect(recorded.statements).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(recorded.releases).toEqual([undefined]);
  });

  it('rethrows the original failure when the rollback also fails', async () => {
    const recorded = recordingClient((sql) => {
      if (sql === 'ROLLBACK') {
        throw new Error('connection terminated');
      }
    });
    const failure = new Error('constraint violation');

    await withManager(recorded, async (manager) => {
      await expect(
        manager.run(async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    });

    expect(recorded.statements).toEqual(['BEGIN', 'ROLLBACK']);
    // The connection still returns to the pool on the failure path.
    expect(recorded.releases).toEqual([undefined]);
  });
});
