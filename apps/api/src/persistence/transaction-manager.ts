import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * A connection-bound SQL handle.
 *
 * Only what the transaction boundary needs is part of this port, so a test can
 * supply a recording stub instead of a real PostgreSQL connection.
 */
export interface TransactionClient {
  /** Execute one statement on the connection bound to the transaction. */
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
  /** Return the connection to the pool. */
  release(error?: Error): void;
}

/**
 * Runs a unit of work on one pooled connection inside a single transaction.
 *
 * Durable writes touch several tables that must agree (an account, its identity
 * and its member link, or a conversation's state change and its audit entry).
 * This service is the seam those writes go through: it borrows exactly one
 * connection, wraps the work in `BEGIN`/`COMMIT`, and rolls back on any failure
 * so a partially applied write can never be observed.
 *
 * The connection is released in a `finally` block on every path, so a failed
 * rollback cannot leak a pooled connection. Driver and constraint errors are
 * re-thrown unchanged; callers map them to their own error contract.
 *
 * @remarks
 * Authentication writes and the durable platform repository both build on this
 * boundary. Feature services never receive it directly: they depend on
 * `PlatformRepository`, which decides what has to be atomic.
 */
@Injectable()
export class TransactionManager {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Run `work` inside one transaction and return its result.
   *
   * @param work - Statements to execute on the transaction's connection.
   * @returns The value `work` resolved with, after the transaction committed.
   * @throws Whatever `work` threw, after the transaction was rolled back.
   */
  async run<T>(work: (client: TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Undo the open transaction without masking the failure that caused it.
   *
   * A rollback that itself fails (a connection already dropped by PostgreSQL)
   * must not replace the original error, so its rejection is absorbed here and
   * the connection still returns to the pool where it is discarded.
   */
  private async rollback(client: TransactionClient): Promise<void> {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}
