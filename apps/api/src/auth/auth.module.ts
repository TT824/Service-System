import { Global, Module, type Provider } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  AuthAdminService,
  AuthService,
  InMemoryAuthRepository,
  KefuStore,
  resolveAuthStorageMode,
  resolveOidcProvider,
  resolveOtpProvider,
  type AppConfig,
  type AuthRepository,
  type OidcProvider,
  type OtpProvider,
} from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { DatabaseService } from '../database/database.service';
import { PersistenceModule } from '../persistence/persistence.module';
import { TransactionManager } from '../persistence/transaction-manager';
import { PlatformModule } from '../platform/platform.module';
import { resolvePlatformStorageMode } from '../platform/platform-repository';
import { AuthController } from './auth.controller';
import { AuthErrorInterceptor } from './auth-error.interceptor';
import { IdentitySourceGuard } from './identity-source.guard';
import { PostgresAuthRepository } from './postgres-auth.repository';
import { SessionAccessService } from './session-access.service';
import { AUTH_OIDC_PROVIDER, AUTH_OTP_PROVIDER, AUTH_REPOSITORY } from './auth.tokens';

/**
 * Build the storage adapter the environment asks for.
 *
 * `auto` follows the environment boundary: `test` is deterministic and
 * in-memory so the whole workflow is exercisable with no database, while `local`
 * and `production` persist. An explicit `AUTH_STORAGE` always wins, which is
 * what lets the durable adapter be exercised against a real PostgreSQL.
 *
 * The durable adapter takes the transaction boundary because provisioning a
 * trial workspace writes a tenant, a store, a member and a link that must agree;
 * the in-memory adapter enforces the same atomicity on its own.
 *
 * The in-memory adapter also takes the platform kernel's {@link KefuStore} as a
 * mirror, but only when that store is what the platform repository actually
 * reads. In `test` the two adapters would otherwise be two independent
 * directories: registration would provision a tenant into the authentication
 * directory and the account's own business endpoints — which validate the tenant
 * against the platform repository — would not find it. Mirroring the directory
 * writes into that same store closes the gap. Outside `test` the platform
 * repository is PostgreSQL and no mirror is attached, so a `local`/`production`
 * boot never gains a second, in-process source of truth; the two adapters there
 * read and write the same tables.
 */
const authRepositoryProvider: Provider = {
  provide: AUTH_REPOSITORY,
  inject: [APP_CONFIG, KefuStore, DatabaseService, TransactionManager],
  useFactory: (
    config: AppConfig,
    store: KefuStore,
    database: DatabaseService,
    transactions: TransactionManager,
  ): AuthRepository => {
    if (resolveAuthStorageMode(config.appEnv, config.auth.storage) === 'postgres') {
      return new PostgresAuthRepository(database, transactions);
    }
    const mirrored = resolvePlatformStorageMode(config.appEnv) === 'memory' ? store : undefined;
    return new InMemoryAuthRepository(true, mirrored);
  },
};

/**
 * Pick the one-time code provider.
 *
 * Outside production this is the deterministic local provider. In production it
 * is whatever `AUTH_OTP_PROVIDER` names, and an unconfigured deployment gets a
 * provider that fails closed rather than one that pretends to deliver codes.
 */
const otpProviderProvider: Provider = {
  provide: AUTH_OTP_PROVIDER,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): OtpProvider =>
    resolveOtpProvider({ appEnv: config.appEnv, configured: config.auth.otpProvider }),
};

/** Pick the OIDC provider, under the same fail-closed production rule. */
const oidcProviderProvider: Provider = {
  provide: AUTH_OIDC_PROVIDER,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): OidcProvider =>
    resolveOidcProvider({ appEnv: config.appEnv, configured: config.auth.oidcProvider }),
};

/** Assemble the sign-in, account and session domain service. */
const authServiceProvider: Provider = {
  provide: AuthService,
  inject: [AUTH_REPOSITORY, AUTH_OTP_PROVIDER, AUTH_OIDC_PROVIDER],
  useFactory: (
    repository: AuthRepository,
    otpProvider: OtpProvider,
    oidcProvider: OidcProvider,
  ): AuthService => new AuthService({ repository, otpProvider, oidcProvider }),
};

/** Assemble the platform-administration domain service over the same storage. */
const authAdminServiceProvider: Provider = {
  provide: AuthAdminService,
  inject: [AUTH_REPOSITORY],
  useFactory: (repository: AuthRepository): AuthAdminService =>
    new AuthAdminService({ repository }),
};

/**
 * Authentication, account and access-control module.
 *
 * Global, because every surface needs to know *who* is calling: the guard
 * decides whether a request may have an identity at all, and
 * {@link SessionAccessService} resolves that identity into the tenant and store
 * scope a feature service enforces. Both are registered here so no feature
 * module has to remember to opt in.
 */
@Global()
@Module({
  // `PlatformModule` is global too, so the mirror could be resolved without this
  // import; naming it makes the one provider the adapter depends on explicit
  // rather than an accident of what the composition root happens to register.
  imports: [PersistenceModule, PlatformModule],
  controllers: [AuthController],
  providers: [
    authRepositoryProvider,
    otpProviderProvider,
    oidcProviderProvider,
    authServiceProvider,
    authAdminServiceProvider,
    SessionAccessService,
    // Anonymous requests are refused before a handler runs; the endpoints that
    // *establish* an identity opt out with `@Public()`.
    { provide: APP_GUARD, useClass: IdentitySourceGuard },
    // Turns a domain `AuthError` thrown by a handler into the platform's
    // stable HTTP error contract.
    { provide: APP_INTERCEPTOR, useClass: AuthErrorInterceptor },
  ],
  exports: [AUTH_REPOSITORY, AuthService, AuthAdminService, SessionAccessService],
})
export class AuthModule {}
