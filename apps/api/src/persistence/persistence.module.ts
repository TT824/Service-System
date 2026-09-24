import { Module } from '@nestjs/common';
import { TransactionManager } from './transaction-manager';

/**
 * Durable persistence module.
 *
 * Exposes the transactional boundary ({@link TransactionManager}) that is
 * backed by the API-owned PostgreSQL pool. `DatabaseModule` is global, so the
 * transaction manager resolves its pool without this module re-importing it.
 *
 * It is imported by `PlatformModule`, which builds the durable platform
 * repository on top of it, and by `AuthModule`, whose durable adapter writes a
 * trial workspace's four rows as one unit of work. Feature services reach the
 * transaction boundary only through a repository, never directly.
 */
@Module({
  providers: [TransactionManager],
  exports: [TransactionManager],
})
export class PersistenceModule {}
