import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { AppConfig } from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';

/** Maximum number of connections the API-owned pool keeps open. */
export const DATABASE_POOL_MAX = 10;
/** How long an idle pooled connection is retained before PostgreSQL closes it. */
export const DATABASE_POOL_IDLE_TIMEOUT_MS = 30_000;
/** Bounded wait for a physical PostgreSQL connection to be established. */
export const DATABASE_POOL_CONNECTION_TIMEOUT_MS = 5_000;
/** Bounded execution time for any statement issued through the pool. */
export const DATABASE_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * API-owned PostgreSQL connection boundary.
 *
 * The service owns exactly one {@link Pool} created from the parsed
 * {@link AppConfig.databaseUrl}. The pool is lazy: no connection is opened
 * until a query runs, so an unreachable database at startup is surfaced by
 * readiness rather than by a bootstrap failure. Connection and statement
 * timeouts are bounded so no caller can wait on the database forever.
 *
 * The pool is created at the narrow boundary that needs the raw connection
 * string (`Redacted.unwrap()`) and is never logged. Driver-level failures
 * are delivered to the waiting query as rejections; failures with no waiting
 * caller (an idle client dropped by a PostgreSQL restart) are routed to a
 * silent pool `error` sink so a routine backend restart cannot crash the API.
 *
 * @remarks
 * Lifecycle is owned by Nest: {@link onModuleDestroy} closes every pooled
 * connection during application shutdown. The pool performs no DDL, so no
 * tables are created implicitly by starting the API.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  /** The single PostgreSQL pool shared by API database consumers. */
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl.unwrap(),
      max: DATABASE_POOL_MAX,
      connectionTimeoutMillis: DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      statement_timeout: DATABASE_STATEMENT_TIMEOUT_MS,
      idleTimeoutMillis: DATABASE_POOL_IDLE_TIMEOUT_MS,
    });
    // Idle-client errors carry no awaiting query, so the only safe response is
    // to absorb them. Caller-bound failures still reject their query promise.
    this.pool.on('error', () => undefined);
  }

  /**
   * Close every pooled connection.
   *
   * Called by Nest during graceful shutdown (`enableShutdownHooks` in
   * `main.ts`). Ending an idle pool is safe and idempotent for callers.
   */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Prove the database answers with a parameter-free round trip.
   *
   * Resolves only after PostgreSQL actually executed the query, so callers
   * (readiness) can treat resolution as a real connectivity proof.
   */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
