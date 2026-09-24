/**
 * Channel module.
 *
 * Binds the channel slice: the transport behind the provider-neutral
 * `ChannelAdapter` token, the environment-selected
 * {@link ChannelReliabilityRepository}, and the {@link ChannelDeliveryService}
 * that owns the message loop. The delivery service is exported because the
 * conversation workspace routes its outbound sends through it, so a sent message
 * and its delivery record cannot drift apart.
 *
 * Two transports can be bound and the environment picks one:
 *
 * - `WECOM_TRANSPORT=real` (the default) binds {@link RealWecomAdapter}, which speaks the
 *   WeChat Customer Service interface through an injected HTTP client.
 * - `WECOM_TRANSPORT=mock` binds {@link MockWecomAdapter}, the deterministic
 *   in-process transport reserved for automated tests and deliberate local diagnostics.
 *
 * Swapping them is a change to the {@link CHANNEL_ADAPTER} provider alone;
 * nothing else in the application names a provider. The real transport is
 * additionally published under {@link WECOM_REAL_TRANSPORT} — `null` when a
 * diagnostic transport is bound — so only the code that genuinely needs WeCom's
 * URL handshake or a connectivity probe has to know which one it got.
 *
 * The real transport's tenant binding comes from {@link WECOM_SCOPE_RESOLVER},
 * which is also a provider: it resolves the account through
 * {@link WECOM_BINDING_REPOSITORY}, so a direct message callback and a
 * `kf_msg_or_event` pull name the same tenant for the same account. A deployment
 * that binds accounts elsewhere replaces that one value without editing the
 * adapter, the delivery loop or this module.
 *
 * What the real transport *authenticates* with comes from
 * {@link WECOM_CREDENTIAL_READER}, which is a function rather than a value: the
 * adapter, the token provider and the media downloader each ask it once per
 * operation, so a set an operator types into the console takes effect without
 * restarting this process or the Worker. The environment is still read, as the
 * fallback a deployment that has never stored anything uses; which of the two a
 * given operation used is `@kefu/core`'s decision, not this module's.
 *
 * A `kf_msg_or_event` notification is the one callback that carries no message:
 * it names an `open_kfid` and hands over a short-lived pull token, and the
 * platform has to fetch the backlog itself. {@link WecomSyncService} owns that
 * pull, and the *persistent* half of the binding it resolves comes from
 * {@link WECOM_BINDING_REPOSITORY} — the `wecom_channel_bindings` and
 * `wecom_sync_cursors` tables migration `0007` declares. Its environment
 * boundary is the same as every other channel store: `memory` for `test`,
 * `postgres` otherwise.
 */

import { Module, type Provider } from '@nestjs/common';
import type { AppConfig } from '@kefu/core';
import {
  FetchWecomHttpClient,
  MemoryWecomTokenCache,
  MockWecomAdapter,
  RedisWecomTokenCache,
  WECOM_HTTP_CLIENT,
  WECOM_TOKEN_CACHE,
  WecomTokenProvider,
  type WecomCredentialReader,
  type WecomHttpClient,
  type WecomTokenCache,
} from '@kefu/wecom';
import { AuthModule } from '../auth/auth.module';
import { APP_CONFIG } from '../config/app-config.module';
import { DatabaseService } from '../database/database.service';
import { MediaModule } from '../media/media.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { TransactionManager } from '../persistence/transaction-manager';
import { RealtimeModule } from '../realtime/realtime.module';
import { CHANNEL_ADAPTER } from './channel-adapter.port';
import { ChannelDeliveryService } from './channel-delivery.service';
import {
  CHANNEL_RELIABILITY_REPOSITORY,
  resolveChannelStorageMode,
  type ChannelReliabilityRepository,
} from './channel-reliability.repository';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { MemoryChannelReliabilityRepository } from './memory-channel-reliability.repository';
import { MemoryWecomBindingRepository } from './memory-wecom-binding.repository';
import { MemoryWecomCredentialRepository } from './memory-wecom-credential.repository';
import { PostgresChannelReliabilityRepository } from './postgres-channel-reliability.repository';
import { PostgresWecomBindingRepository } from './postgres-wecom-binding.repository';
import { PostgresWecomCredentialRepository } from './postgres-wecom-credential.repository';
import {
  RealWecomAdapter,
  WECOM_REAL_TRANSPORT,
  WECOM_SCOPE_RESOLVER,
  isWecomRealTransport,
  type WecomRealTransport,
  type WecomScopeResolver,
} from './real-wecom.adapter';
import { wecomScopeResolverFromBindings } from './wecom-scope.resolver';
import {
  WECOM_BINDING_REPOSITORY,
  resolveWecomBindingMode,
  type WecomBindingRepository,
} from './wecom-binding.repository';
import {
  WECOM_CREDENTIAL_REPOSITORY,
  resolveWecomCredentialMode,
  type WecomCredentialRepository,
} from './wecom-credential.repository';
import { WECOM_CREDENTIAL_READER, wecomCredentialReaderOf } from './wecom-credential.source';
import { WecomSyncService } from './wecom-sync.service';
import { markWecomConnected } from './wecom-transport';

/**
 * Pick the channel reliability store the environment asks for.
 *
 * `APP_ENV` alone decides, exactly like the platform repository boundary: a
 * `test` boot is deterministic and in-process, and a `local`/`production` boot
 * writes the durable tables migration `0006` declares. There is deliberately no
 * override, so a production replica can never answer from a per-process store
 * that its siblings would disagree with.
 */
const channelReliabilityRepositoryProvider: Provider = {
  provide: CHANNEL_RELIABILITY_REPOSITORY,
  inject: [APP_CONFIG, DatabaseService, TransactionManager],
  useFactory: (
    config: AppConfig,
    database: DatabaseService,
    transactions: TransactionManager,
  ): ChannelReliabilityRepository =>
    resolveChannelStorageMode(config.appEnv) === 'postgres'
      ? new PostgresChannelReliabilityRepository(database, transactions)
      : new MemoryChannelReliabilityRepository(),
};

/** Outbound HTTP port: the one component that touches the network. */
const wecomHttpClientProvider: Provider = {
  provide: WECOM_HTTP_CLIENT,
  useFactory: (): WecomHttpClient => new FetchWecomHttpClient(),
};

/**
 * Token cache.
 *
 * A `test` boot gets the in-process double, exactly like the reliability store,
 * so no unit or interface test needs Redis. A `local`/`production` boot gets the
 * Redis-backed cache, whose client is created lazily: binding it neither opens a
 * socket at boot nor makes readiness depend on Redis.
 */
const wecomTokenCacheProvider: Provider = {
  provide: WECOM_TOKEN_CACHE,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): WecomTokenCache =>
    config.appEnv === 'test'
      ? new MemoryWecomTokenCache()
      : new RedisWecomTokenCache(config.redisUrl.unwrap()),
};

/** Access-token provider, shared by the adapter and the connectivity probe. */
const wecomTokenProviderProvider: Provider = {
  provide: WecomTokenProvider,
  inject: [APP_CONFIG, WECOM_HTTP_CLIENT, WECOM_TOKEN_CACHE, WECOM_CREDENTIAL_READER],
  useFactory: (
    config: AppConfig,
    http: WecomHttpClient,
    cache: WecomTokenCache,
    credentials: WecomCredentialReader,
  ): WecomTokenProvider =>
    new WecomTokenProvider(http, cache, {
      // Not a snapshot: the provider asks for the credential on every operation,
      // so a set typed into the console takes effect without restarting this
      // process. See {@link WecomTokenProvider}.
      credentials,
      timeoutMs: config.healthTimeoutMs,
      // The shared provider reports what a token operation proved; the API is
      // what decides that a fetched token means "the real transport is
      // connected". The Worker acquires the same token and reports nothing.
      onConnectionProven: markWecomConnected,
    }),
};

/**
 * Platform binding of one customer-service account.
 *
 * Which tenant and store an `open_kfid` belongs to is a product decision, and it
 * is answered from the durable `wecom_channel_bindings` table through the very
 * store the `kf/sync_msg` pull resolves its account through. Composing it here —
 * rather than inlining a resolver into the adapter — keeps the choice in one
 * place while making both callback shapes read the same binding: an account a
 * notification can pull for is an account a direct callback can be ingested
 * from.
 *
 * A deployment that binds accounts somewhere else still replaces this one
 * value; nothing else in the application names a scope.
 */
const wecomScopeResolverProvider: Provider = {
  provide: WECOM_SCOPE_RESOLVER,
  inject: [WECOM_BINDING_REPOSITORY],
  useFactory: (bindings: WecomBindingRepository): WecomScopeResolver =>
    wecomScopeResolverFromBindings(bindings),
};

/**
 * The bound transport.
 *
 * Real mode binds the customer-service adapter even when its credentials are
 * incomplete: the adapter then refuses every operation with a stable
 * `channel_not_configured` failure, which is what lets the channel surfaces
 * report "disabled because not configured" instead of failing to boot.
 */
const channelAdapterProvider: Provider = {
  provide: CHANNEL_ADAPTER,
  inject: [
    APP_CONFIG,
    WECOM_HTTP_CLIENT,
    WecomTokenProvider,
    WECOM_SCOPE_RESOLVER,
    WECOM_CREDENTIAL_READER,
  ],
  useFactory: (
    config: AppConfig,
    http: WecomHttpClient,
    tokens: WecomTokenProvider,
    scope: WecomScopeResolver,
    credentials: WecomCredentialReader,
  ): MockWecomAdapter | RealWecomAdapter =>
    config.wecom.transport === 'real'
      ? new RealWecomAdapter(credentials, {
          http,
          tokens,
          scope,
          timeoutMs: config.healthTimeoutMs,
        })
      : new MockWecomAdapter(),
};

/**
 * Publish the real transport, or `null` when the Mock is bound.
 *
 * The guard is structural rather than an `instanceof` on the concrete class, so
 * the application depends on the capability it needs — the URL handshake and the
 * connectivity probe — and not on which class happened to provide it.
 */
const realTransportProvider: Provider = {
  provide: WECOM_REAL_TRANSPORT,
  inject: [CHANNEL_ADAPTER],
  useFactory: (adapter: MockWecomAdapter | RealWecomAdapter): WecomRealTransport | null =>
    isWecomRealTransport(adapter) ? adapter : null,
};

/**
 * Persistent account bindings and sync cursors.
 *
 * `APP_ENV` alone decides, exactly like the reliability store above: a `test`
 * boot gets the in-process adapter, which starts empty like a fresh deployment
 * and holds whatever the binding route writes, and a `local`/`production` boot
 * reads the durable tables migration `0007` declares.
 */
const wecomBindingRepositoryProvider: Provider = {
  provide: WECOM_BINDING_REPOSITORY,
  inject: [APP_CONFIG, DatabaseService],
  useFactory: (config: AppConfig, database: DatabaseService): WecomBindingRepository =>
    resolveWecomBindingMode(config.appEnv) === 'postgres'
      ? new PostgresWecomBindingRepository(database)
      : new MemoryWecomBindingRepository(),
};

/**
 * The stored credentials a real connection runs on.
 *
 * `APP_ENV` decides, exactly like the binding store directly above: a `test`
 * boot holds them in process and starts empty, a `local`/`production` boot reads
 * the table migration `0017` declares. It is built over {@link WECOM_BINDING_REPOSITORY}
 * rather than the database alone because two of its three rules are decided
 * *against the binding* and must be asked of the same store the rest of the
 * module resolves accounts with — see {@link MemoryWecomCredentialRepository}.
 */
const wecomCredentialRepositoryProvider: Provider = {
  provide: WECOM_CREDENTIAL_REPOSITORY,
  inject: [APP_CONFIG, DatabaseService, WECOM_BINDING_REPOSITORY],
  useFactory: (
    config: AppConfig,
    database: DatabaseService,
    bindings: WecomBindingRepository,
  ): WecomCredentialRepository =>
    resolveWecomCredentialMode(config.appEnv) === 'postgres'
      ? new PostgresWecomCredentialRepository(database)
      : new MemoryWecomCredentialRepository(bindings),
};

/**
 * What the transport authenticates with, asked once per operation.
 *
 * The whole reason the credentials moved out of the environment: this is a
 * function, not a value, so every operation reads the set that is configured
 * *now* and a stored one takes effect without restarting either process. It is
 * the API's copy of the rule; the Worker composes the same one over its own
 * pool, because the two workspaces share `@kefu/wecom` and `@kefu/core` and not
 * each other's files.
 */
const wecomCredentialReaderProvider: Provider = {
  provide: WECOM_CREDENTIAL_READER,
  inject: [WECOM_CREDENTIAL_REPOSITORY, APP_CONFIG],
  useFactory: (
    repository: WecomCredentialRepository,
    config: AppConfig,
  ): WecomCredentialReader => wecomCredentialReaderOf({ repository, config }),
};

/**
 * Channel configuration, transport and delivery loop.
 *
 * {@link AuthModule} is imported for `AUTH_REPOSITORY` alone: connecting an
 * account resolves the store the connection writes into, which is the same
 * directory the platform authorizes every other write against.
 */
@Module({
  imports: [AuthModule, PersistenceModule, RealtimeModule, MediaModule],
  controllers: [ChannelsController],
  providers: [
    ChannelsService,
    wecomHttpClientProvider,
    wecomTokenCacheProvider,
    wecomTokenProviderProvider,
    wecomScopeResolverProvider,
    channelAdapterProvider,
    realTransportProvider,
    channelReliabilityRepositoryProvider,
    wecomBindingRepositoryProvider,
    wecomCredentialRepositoryProvider,
    wecomCredentialReaderProvider,
    ChannelDeliveryService,
    WecomSyncService,
  ],
  exports: [ChannelDeliveryService, WECOM_CREDENTIAL_READER],
})
export class ChannelsModule {}
