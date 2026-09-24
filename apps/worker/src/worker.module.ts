/**
 * Root worker module.
 *
 * It wires the four capabilities this process runs on its own clock: delivering
 * the durable channel outbox, reading the tenants' knowledge into slices,
 * embedding the slices that do not have a vector yet, and rendering the exports
 * the console has queued.
 *
 * The last two are halves of one pipeline and are two loops on purpose. The
 * **source sweep** reads `faqs` / `shortcuts` / `product_spus` / `product_skus`
 * and writes `knowledge_chunks` as `pending`; it needs no model, so a tenant with
 * no embedding provider still has a complete, keyword-searchable index. The
 * **embedding sweep** claims those `pending` rows, calls the provider and writes
 * the outcome back. Nothing sits between them — the row a merchant edited is the
 * only thing that has to happen for the first to see it, and the row the first
 * wrote is what the second claims — so there is no queue, no cursor and no
 * second code path to keep in step.
 *
 * The delivery loop is a different arrangement and shares only the shape: the API
 * records a delivery and enqueues an entry, and this process claims that entry
 * later and hands it to the provider — claim, work, write back, come back later.
 *
 * All four are consumers of the same loop shape, composed here and started by
 * the entry point rather than by this module.
 *
 * The delivery loop and the export loop are the two that are *queues* rather than
 * sweeps: the API writes a row and this process claims it later. They differ in
 * what a failure means. A delivery that fails is retried for hours, because a
 * customer is waiting for an answer and the platform owns the retry. An export
 * that fails is written down as failed with its reason on the first attempt,
 * because a file that never arrives is more usefully reported than quietly
 * retried — the operator who asked for it is the only one who can decide what to
 * change.
 *
 * Five decisions are visible here and nowhere else:
 *
 * - **There is no in-process mode.** The API replaces its reliability store with
 *   an in-memory double under `APP_ENV=test`, because a test boot must be
 *   deterministic and need no database. The Worker cannot do the same: the queue
 *   it serves *is* the durable one written by a different process, and a
 *   per-process outbox would deliver nothing anybody queued. The store is
 *   therefore always PostgreSQL, and a worker test drives the repository
 *   directly.
 * - **The transport is the shared one.** Real mode binds `@kefu/wecom`'s
 *   `WecomOutboundSender`; Mock mode binds that package's `MockWecomAdapter`.
 *   Both are the same objects the API binds for the same setting, so an entry the
 *   API queued in Mock mode is delivered by the transport the API would have
 *   used, and a real entry by the one implementation of `kf/send_msg` in the
 *   repository. Nothing under `apps/api` is imported: the API's own transport is
 *   a *consumer* of the package, not its owner.
 * - **The lease owner is per process.** It is compared by value on every
 *   write-back, so it is minted once here from the pid and a random suffix: two
 *   Workers must never share an identity, or the compare-by-owner guard that
 *   stops a stale Worker from writing back would silently pass.
 * - **The deadline fits the lease.** `HEALTH_TIMEOUT_MS` bounds each provider
 *   request, and one send makes a bounded number of them; the product must leave
 *   the claim lease with headroom, or the Worker refuses to start.
 * - **The embedding provider is configuration-driven, and its absence is a
 *   binding rather than a missing one.** `EMBEDDING_BASE_URL` and
 *   `EMBEDDING_MODEL` name the service and the model; when either is empty the
 *   token resolves to `undefined`, which is the value the sweep's gate is written
 *   against. The consequence belongs to the tick and is stated there: it claims
 *   nothing, every slice stays `pending`, and the day a model is configured the
 *   same loop picks the backlog up. Binding a provider that fails every call
 *   instead would park the whole table, which is the opposite outcome from the
 *   same "nothing is configured" — so a *half*-configured pair (a URL with no
 *   model, or the reverse) is also `undefined`: a provider with no model name
 *   would file every vector under an empty address, and one with no URL has
 *   nowhere to send anything. Production does not get to make that choice at all
 *   — the two variables are required there, so a deployment that would silently
 *   index nothing fails to start.
 *
 *   The embedding provider is also the one place a Worker makes an outbound call
 *   that is not a message delivery, and it reaches the network through its own
 *   port (`EMBEDDING_HTTP_CLIENT`), bounded by
 *   `EMBEDDING_TIMEOUT_MS` per request. No lease has to be checked against that
 *   deadline: the index sweep claims by spending an attempt, not by holding
 *   anything, so a slow provider lengthens a tick rather than endangering a
 *   delivery somebody else is waiting for.
 *
 * A fourth decision is enforced rather than described: a real transport is only
 * constructed when the bounded provider call fits inside the outbox lease (see
 * `outbox/provider-call-bound.ts`). The deadline and the lease are set in
 * different places, so the composition root is the only place that can refuse the
 * combination before the Worker starts sending.
 *
 * The export loop reaches no network at all — its two inputs are the database and
 * `@kefu/core`'s renderers — so it is the one loop here with nothing to configure:
 * no provider to be absent, no transport to be chosen, no deadline to fit inside a
 * lease.
 *
 * Every loop is bound but not started. Starting them is the entry point's
 * decision, which keeps a Nest application context created by a test from polling
 * a real database.
 */

import { randomUUID } from 'node:crypto';
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  EMBEDDING_HTTP_CLIENT,
  FetchEmbeddingHttpClient,
  createOllamaEmbeddingProvider,
  type AppConfig,
  type EmbeddingHttpClient,
  type EmbeddingProvider,
} from '@kefu/core';
import {
  FetchWecomHttpClient,
  MemoryWecomTokenCache,
  MockWecomAdapter,
  RedisWecomTokenCache,
  WECOM_HTTP_CLIENT,
  WECOM_TOKEN_CACHE,
  WecomOutboundSender,
  WecomTokenProvider,
  type WecomCredentialReader,
  type WecomHttpClient,
  type WecomTokenCache,
  type WecomOutboundTransport,
} from '@kefu/wecom';
import {
  WECOM_CREDENTIAL_READER,
  wecomCredentialReaderOf,
} from './outbox/wecom-credential-source';
import { WorkerDatabase } from './database/worker-database';
import type { ExportJobRepository } from './exports/export-job-repository';
import { ExportProcessor } from './exports/export-processor';
import { PostgresExportJobRepository } from './exports/postgres-export-job-repository';
import { ChunkIndexProcessor } from './knowledge/chunk-index-processor';
import type { ChunkIndexRepository } from './knowledge/chunk-index-repository';
import type { KnowledgeChunkWriter } from './knowledge/chunk-writer';
import type { IndexSourceReader } from './knowledge/index-source-reader';
import { KnowledgeSourceSweep } from './knowledge/knowledge-source-sweep';
import { PostgresChunkIndexRepository } from './knowledge/postgres-chunk-index-repository';
import { PostgresChunkWriter } from './knowledge/postgres-chunk-writer';
import { PostgresIndexSourceReader } from './knowledge/postgres-index-source-reader';
import { OUTBOX_REPOSITORY, OUTBOX_TRANSPORT, OutboxProcessor } from './outbox/outbox-processor';
import { assertProviderCallWithinLease } from './outbox/provider-call-bound';
import type { OutboxRepository } from './outbox/outbox-repository';
import { PostgresOutboxRepository } from './outbox/postgres-outbox.repository';

/** Injection token carrying the parsed worker configuration. */
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

/** Injection token carrying the bound {@link ExportJobRepository}. */
export const EXPORT_JOB_REPOSITORY = Symbol('EXPORT_JOB_REPOSITORY');

/** Injection token carrying the bound {@link ChunkIndexRepository}. */
export const CHUNK_INDEX_REPOSITORY = Symbol('CHUNK_INDEX_REPOSITORY');

/** Injection token carrying the bound {@link IndexSourceReader}. */
export const INDEX_SOURCE_READER = Symbol('INDEX_SOURCE_READER');

/** Injection token carrying the bound {@link KnowledgeChunkWriter}. */
export const CHUNK_WRITER = Symbol('CHUNK_WRITER');

/**
 * Injection token carrying the bound {@link EmbeddingProvider}, or `undefined`.
 *
 * `undefined` is a value here, not an absence: see the module note on why the
 * sweep's gate is the thing that reads it.
 */
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

/** How often the loop polls once the queue is empty. */
const OUTBOX_POLL_INTERVAL_MS = 1_000;

/** How many due entries one poll claims. Bounded so one Worker cannot monopolise the queue. */
const OUTBOX_BATCH_SIZE = 10;

/**
 * How often the index sweep polls.
 *
 * Slower than the delivery loop, and the reason is the work behind it: a delivery
 * is a customer waiting for an answer, while a slice's next attempt is scheduled
 * by a backoff measured in minutes (`knowledgeIndexRetryDelayMs`). Polling every
 * second would not index anything sooner; it would only make the interval between
 * a slice becoming due and being claimed imperceptible at the cost of a tick per
 * second against a table the claim scans platform-wide.
 */
const CHUNK_INDEX_POLL_INTERVAL_MS = 5_000;

/** How many due slices one sweep claims. Bounded like the delivery batch, and for the same reason. */
const CHUNK_INDEX_BATCH_SIZE = 10;

/**
 * How often the export queue is polled.
 *
 * Faster than the index sweep and slower than the outbox, because of who is
 * waiting: an operator who opened 导出任务 is watching a list that shows the job's
 * status, while a delivery is a customer waiting for an answer. Two seconds is
 * under the threshold where an empty list starts to look broken.
 */
const EXPORT_POLL_INTERVAL_MS = 2_000;

/**
 * How many exports one tick renders.
 *
 * Smaller than the other batches on purpose: rendering is CPU inside this process
 * — an xlsx of twenty thousand messages is real work — so a batch here delays the
 * next tick rather than spending a shared budget.
 */
const EXPORT_BATCH_SIZE = 3;

/**
 * How long a claimed export may stay `running` before it is presumed abandoned.
 *
 * Generous, because the two errors are not symmetric: a job reclaimed too early is
 * rendered twice (harmless — both renders write the same bytes to the same key),
 * while a job reclaimed too late is a task the console shows as running with
 * nobody running it.
 */
const EXPORT_LEASE_MS = 10 * 60 * 1_000;

/**
 * How often the source sweep makes a pass over every tenant.
 *
 * Far slower than the other two, and the reason is the shape of the work rather
 * than how urgent it is: a pass re-reads *every* source of *every* tenant —
 * the reader cannot be narrowed to what changed without deleting slices whose
 * text never moved (see `index-source-reader`) — so this interval is what keeps
 * the sweep from being the busiest thing on the database. A merchant's edit is
 * visible within a minute; nothing about answering a customer in that minute
 * depends on the index being newer than that, because the answer a customer is
 * already waiting for was generated from knowledge that was indexed before.
 *
 * `knowledge-index-lifecycle.integration.spec.ts` drives the pass directly
 * (`runOnce`), so nothing in the test suite waits on this number.
 */
const KNOWLEDGE_SOURCE_POLL_INTERVAL_MS = 60_000;

/**
 * The module's providers, built from the parsed configuration.
 *
 * @param config - Parsed application configuration, the same shape the API uses.
 * @returns An importable dynamic module exporting the started-on-demand processor.
 */
function providersFor(config: AppConfig): ReadonlyArray<Provider> {
  const databaseProvider: Provider = {
    provide: WorkerDatabase,
    useFactory: (): WorkerDatabase => new WorkerDatabase(config.databaseUrl.unwrap()),
  };

  const outboxRepositoryProvider: Provider = {
    provide: OUTBOX_REPOSITORY,
    inject: [WorkerDatabase],
    useFactory: (database: WorkerDatabase) => new PostgresOutboxRepository(database),
  };

  /** Outbound HTTP port: the one component that touches the network. */
  const httpClientProvider: Provider = {
    provide: WECOM_HTTP_CLIENT,
    useFactory: (): WecomHttpClient => new FetchWecomHttpClient(),
  };

  /**
   * Token cache, shared with the API through Redis.
   *
   * A `test` boot gets the in-process double, so a worker test never needs Redis;
   * a `local`/`production` boot gets the Redis-backed cache, whose client is
   * created lazily. Because both processes cache under the same key, a token the
   * API has already fetched is reused here instead of spending the provider's
   * daily `gettoken` quota a second time.
   */
  const tokenCacheProvider: Provider = {
    provide: WECOM_TOKEN_CACHE,
    useFactory: (): WecomTokenCache =>
      config.appEnv === 'test'
        ? new MemoryWecomTokenCache()
        : new RedisWecomTokenCache(config.redisUrl.unwrap()),
  };

  /**
   * What a real send authenticates with, read on every send.
   *
   * Composed over this Worker's own pool, because the two workspaces share
   * `@kefu/wecom` and `@kefu/core` rather than each other's files — the API has
   * a reader of its own over its own repository. Both decide which of the two
   * sources wins through the same Core function, so the API and the Worker
   * cannot disagree about which company they are sending as.
   */
  const credentialReaderProvider: Provider = {
    provide: WECOM_CREDENTIAL_READER,
    inject: [WorkerDatabase],
    useFactory: (database: WorkerDatabase): WecomCredentialReader =>
      wecomCredentialReaderOf({ database, environment: config.wecom }),
  };

  /**
   * Access-token provider.
   *
   * No `onConnectionProven`: the API turns a fetched token into its "the real
   * transport is connected" claim, and a Worker has no channel surface to make
   * that claim on. Leaving it out is what keeps the package free of any
   * application state.
   */
  const tokenProviderProvider: Provider = {
    provide: WecomTokenProvider,
    inject: [WECOM_HTTP_CLIENT, WECOM_TOKEN_CACHE, WECOM_CREDENTIAL_READER],
    useFactory: (
      http: WecomHttpClient,
      cache: WecomTokenCache,
      credentials: WecomCredentialReader,
    ): WecomTokenProvider =>
      new WecomTokenProvider(http, cache, {
        // Asked once per token operation, so a set stored from the console takes
        // effect without restarting this process.
        credentials,
        timeoutMs: config.healthTimeoutMs,
      }),
  };

  /**
   * The bound outbound transport, chosen exactly as the API chooses it.
   *
   * A real-mode send resolves its credential *inside* the transport rather than
   * here: an incomplete one — whether it is the environment's or a half-typed
   * set stored from the console — refuses the send with the same
   * `channel_not_configured` failure the API reports, so the Worker does not
   * fail to boot and does not invent a transport. Which of the two sources that
   * set came from is Core's decision; this module does not make it.
   */
  const transportProvider: Provider = {
    provide: OUTBOX_TRANSPORT,
    inject: [WECOM_HTTP_CLIENT, WecomTokenProvider, WECOM_CREDENTIAL_READER],
    useFactory: (
      http: WecomHttpClient,
      tokens: WecomTokenProvider,
      credentials: WecomCredentialReader,
    ): WecomOutboundTransport => {
      if (config.wecom.transport !== 'real') {
        // The Mock performs no request at all, so there is no call to bound.
        return new MockWecomAdapter();
      }
      // A real send is bounded by the per-request deadline times the shared
      // transport's maximum replay path, and that product must fit inside the
      // claim's lease with headroom for the write-back. Enforced here, where the
      // deadline is chosen, so a Worker that could outlive its own lease fails to
      // start rather than starting and delivering duplicates under load.
      assertProviderCallWithinLease(config.healthTimeoutMs);
      return new WecomOutboundSender(http, tokens, {
        credentials,
        timeoutMs: config.healthTimeoutMs,
      });
    },
  };

  const outboxProcessorProvider: Provider = {
    provide: OutboxProcessor,
    inject: [OUTBOX_REPOSITORY, OUTBOX_TRANSPORT],
    useFactory: (
      repository: OutboxRepository,
      transport: WecomOutboundTransport,
    ): OutboxProcessor =>
      new OutboxProcessor(repository, transport, {
        owner: `worker-${process.pid}-${randomUUID()}`,
        pollIntervalMs: OUTBOX_POLL_INTERVAL_MS,
        batchSize: OUTBOX_BATCH_SIZE,
      }),
  };

  const configProvider: Provider = { provide: WORKER_CONFIG, useValue: config };

  const chunkIndexRepositoryProvider: Provider = {
    provide: CHUNK_INDEX_REPOSITORY,
    inject: [WorkerDatabase],
    useFactory: (database: WorkerDatabase) => new PostgresChunkIndexRepository(database),
  };

  /** Outbound HTTP port of the embedding provider; the second thing here that touches the network. */
  const embeddingHttpClientProvider: Provider = {
    provide: EMBEDDING_HTTP_CLIENT,
    useFactory: (): EmbeddingHttpClient => new FetchEmbeddingHttpClient(),
  };

  /**
   * The embedding provider, as far as the configuration names one.
   *
   * A factory rather than `useValue`, because "which model embeds the slices" is
   * a question the configuration answers — and `undefined` is a value it is
   * allowed to give; see the module note on why a half-configured pair is one of
   * those answers rather than a boot failure. The rule itself lives in `@kefu/core`
   * beside the only implementation, so the API's recall leg reads the configuration
   * the same way this Worker does.
   */
  const embeddingProviderProvider: Provider = {
    provide: EMBEDDING_PROVIDER,
    inject: [EMBEDDING_HTTP_CLIENT],
    useFactory: (http: EmbeddingHttpClient): EmbeddingProvider | undefined =>
      createOllamaEmbeddingProvider(config.embedding, http),
  };

  const chunkIndexProcessorProvider: Provider = {
    provide: ChunkIndexProcessor,
    inject: [CHUNK_INDEX_REPOSITORY, EMBEDDING_PROVIDER],
    useFactory: (repository: ChunkIndexRepository, provider: EmbeddingProvider | undefined) =>
      new ChunkIndexProcessor(repository, provider, {
        pollIntervalMs: CHUNK_INDEX_POLL_INTERVAL_MS,
        batchSize: CHUNK_INDEX_BATCH_SIZE,
      }),
  };

  const indexSourceReaderProvider: Provider = {
    provide: INDEX_SOURCE_READER,
    inject: [WorkerDatabase],
    useFactory: (database: WorkerDatabase): IndexSourceReader =>
      new PostgresIndexSourceReader(database),
  };

  const chunkWriterProvider: Provider = {
    provide: CHUNK_WRITER,
    inject: [WorkerDatabase],
    useFactory: (database: WorkerDatabase): KnowledgeChunkWriter =>
      new PostgresChunkWriter(database),
  };

  /**
   * The source sweep, bound but not started — like the other two.
   *
   * It is the only loop here that needs no configuration at all: the reader and
   * the writer are both PostgreSQL, and there is no provider to be absent. So
   * there is nothing to decide in this factory beyond the interval.
   */
  const knowledgeSourceSweepProvider: Provider = {
    provide: KnowledgeSourceSweep,
    inject: [INDEX_SOURCE_READER, CHUNK_WRITER],
    useFactory: (reader: IndexSourceReader, writer: KnowledgeChunkWriter): KnowledgeSourceSweep =>
      new KnowledgeSourceSweep(reader, writer, {
        pollIntervalMs: KNOWLEDGE_SOURCE_POLL_INTERVAL_MS,
      }),
  };

  const exportRepositoryProvider: Provider = {
    provide: EXPORT_JOB_REPOSITORY,
    inject: [WorkerDatabase],
    useFactory: (database: WorkerDatabase): ExportJobRepository =>
      new PostgresExportJobRepository(database),
  };

  /**
   * The export loop, bound but not started — like every other loop here.
   *
   * It needs no configuration: the repository is PostgreSQL and the rendering is
   * `@kefu/core`'s, so there is no provider that could be absent and nothing to
   * decide beyond the three numbers.
   */
  const exportProcessorProvider: Provider = {
    provide: ExportProcessor,
    inject: [EXPORT_JOB_REPOSITORY],
    useFactory: (repository: ExportJobRepository): ExportProcessor =>
      new ExportProcessor(repository, {
        pollIntervalMs: EXPORT_POLL_INTERVAL_MS,
        batchSize: EXPORT_BATCH_SIZE,
        leaseMs: EXPORT_LEASE_MS,
      }),
  };

  return [
    configProvider,
    databaseProvider,
    outboxRepositoryProvider,
    httpClientProvider,
    tokenCacheProvider,
    credentialReaderProvider,
    tokenProviderProvider,
    transportProvider,
    outboxProcessorProvider,
    chunkIndexRepositoryProvider,
    embeddingHttpClientProvider,
    embeddingProviderProvider,
    chunkIndexProcessorProvider,
    indexSourceReaderProvider,
    chunkWriterProvider,
    knowledgeSourceSweepProvider,
    exportRepositoryProvider,
    exportProcessorProvider,
  ];
}

/**
 * Root worker module.
 *
 * `forRoot` is required rather than optional: the Worker cannot be composed
 * without parsed configuration, and a module that silently fell back to
 * documented defaults would start a Worker against the wrong database and the
 * wrong channel.
 */
@Module({})
export class WorkerModule {
  /**
   * Build the worker module for one parsed configuration.
   *
   * @param config - Parsed application configuration.
   * @returns The root module, with all four loops bound and none started.
   */
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: WorkerModule,
      providers: [...providersFor(config)],
      exports: [OutboxProcessor, ChunkIndexProcessor, KnowledgeSourceSweep, ExportProcessor],
    };
  }
}
