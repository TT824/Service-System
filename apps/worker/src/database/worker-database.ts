/**
 * Worker-owned PostgreSQL connection boundary.
 *
 * The Worker is a second process writing the *same* reliability tables the API
 * writes, so it needs its own pool: a connection cannot be shared across
 * processes, and a Worker that reached into the API's pool would make the two
 * deployments one deployment. The pool is deliberately smaller than the API's —
 * a worker's concurrency is bounded by its own poll loop, not by request load —
 * so a Worker fleet cannot exhaust the database's connection budget.
 *
 * The pool is lazy (no socket is opened until the first query), bounded
 * (connection, statement and idle timeouts), and owns no schema: it performs no
 * DDL, so starting a Worker never changes the database shape. Migrations stay
 * the `database` workspace's job.
 *
 * Nothing here names a channel, a provider or a delivery: it is the process's
 * raw connection, and the repositories on top of it own the SQL.
 */

import type { OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/** Maximum number of connections one Worker process keeps open. */
export const WORKER_DATABASE_POOL_MAX = 4;

/** How long an idle pooled connection is retained before PostgreSQL closes it. */
export const WORKER_DATABASE_POOL_IDLE_TIMEOUT_MS = 30_000;

/** Bounded wait for a physical PostgreSQL connection to be established. */
export const WORKER_DATABASE_CONNECTION_TIMEOUT_MS = 5_000;

/** Bounded execution time for any statement issued through the pool. */
export const WORKER_DATABASE_STATEMENT_TIMEOUT_MS = 30_000;

/** The Worker's PostgreSQL pool, plus the two statement helpers its stores use. */
export class WorkerDatabase implements OnModuleDestroy {
  /** The single pool shared by every Worker database consumer. */
  readonly pool: Pool;

  /**
   * @param connectionString - Parsed, unwrapped database URL. Never logged.
   */
  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: WORKER_DATABASE_POOL_MAX,
      connectionTimeoutMillis: WORKER_DATABASE_CONNECTION_TIMEOUT_MS,
      statement_timeout: WORKER_DATABASE_STATEMENT_TIMEOUT_MS,
      idleTimeoutMillis: WORKER_DATABASE_POOL_IDLE_TIMEOUT_MS,
    });
    // An idle client dropped by a PostgreSQL restart has no awaiting query, so
    // there is nothing to reject; without a listener the event would be an
    // unhandled error and would take the process down.
    this.pool.on('error', () => undefined);
  }

  /** Run one parameterised statement and return its full result. */
  async query(
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Promise<QueryResult<QueryResultRow>> {
    // The pool is typed as `unknown` rows because the driver cannot know the
    // schema; the row mappers narrow every column they read.
    return (await this.pool.query(text, [...values])) as QueryResult<QueryResultRow>;
  }

  /** Run one parameterised statement and return its rows. */
  async rows(
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Promise<ReadonlyArray<QueryResultRow>> {
    return (await this.query(text, values)).rows;
  }

  /**
   * Run `work` inside one transaction on one connection.
   *
   * Used only for the two mutations that must not be interleaved — reserving a
   * reply-window slot, and appending a provider attempt to a delivery — where a
   * row lock has to be held across a read and the write that follows it. A
   * provider call never runs here: the delivery processor reaches the provider
   * through its own port, outside this method, which is what keeps a slow or
   * stalled network round trip from holding a row lock open.
   *
   * A failure rolls back and rethrows, so a caller never sees a half-applied
   * mutation.
   *
   * @param work - Statements to run on the transaction's connection.
   * @returns Whatever `work` returned.
   */
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already unusable; releasing it below discards it.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Prove the database answers with a parameter-free round trip. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /** Close every pooled connection. Idempotent. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Close the pool when the Nest application context is destroyed.
   *
   * The entry point stops the outbox loop *before* closing the context, so no
   * statement is in flight when this runs; ending an idle pool is safe and
   * idempotent for callers.
   */
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
