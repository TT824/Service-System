import { Global, Module, type Provider } from '@nestjs/common';
import { KefuStore, type AppConfig } from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { DatabaseService } from '../database/database.service';
import { PersistenceModule } from '../persistence/persistence.module';
import { TransactionManager } from '../persistence/transaction-manager';
import { AccessService } from './access.service';
import { MemoryPlatformRepository } from './memory-platform.repository';
import { PostgresPlatformRepository } from './postgres-platform.repository';
import {
  PLATFORM_REPOSITORY,
  resolvePlatformStorageMode,
  type PlatformRepository,
} from './platform-repository';

/**
 * Pick the platform business fact source the environment asks for.
 *
 * `APP_ENV` alone decides, mirroring the authentication storage boundary: a
 * `test` boot is deterministic and in-process, and a `local`/`production` boot
 * reads and writes PostgreSQL. There is deliberately no override, so a
 * deployment cannot end up serving business data out of a per-process store
 * that every other replica would disagree with.
 *
 * The in-process {@link KefuStore} stays constructible — and stays the injection
 * source of truth for `test` — because the core/domain unit tests seed and
 * assert against it directly.
 */
const platformRepositoryProvider: Provider = {
  provide: PLATFORM_REPOSITORY,
  inject: [APP_CONFIG, KefuStore, DatabaseService, TransactionManager],
  useFactory: (
    config: AppConfig,
    store: KefuStore,
    database: DatabaseService,
    transactions: TransactionManager,
  ): PlatformRepository =>
    resolvePlatformStorageMode(config.appEnv) === 'postgres'
      ? new PostgresPlatformRepository(database, transactions)
      : new MemoryPlatformRepository(store),
};

/**
 * Global platform kernel module.
 *
 * Provides the deterministic in-process {@link KefuStore} (still the injection
 * source of truth for `APP_ENV=test` and for core/domain unit tests), the
 * environment-selected {@link PlatformRepository} every platform feature service
 * reads and writes through, and the request {@link AccessService} that resolves
 * and enforces the caller's tenant and store scope.
 */
@Global()
@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: KefuStore,
      useFactory: () => new KefuStore(),
    },
    platformRepositoryProvider,
    AccessService,
  ],
  exports: [KefuStore, PLATFORM_REPOSITORY, AccessService],
})
export class PlatformModule {}
