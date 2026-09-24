import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

/**
 * Global database module.
 *
 * Provides the single API-owned PostgreSQL connection pool
 * ({@link DatabaseService}) to every module that needs the database boundary.
 * Registering the module once in the root application also ties the pool's
 * lifecycle to the Nest application: {@link DatabaseService.onModuleDestroy}
 * closes the pool during graceful shutdown.
 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
