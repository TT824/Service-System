import 'reflect-metadata';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import { parseAppConfig, resolveRepositoryEnvPath } from '@kefu/core';
import { createHealthServer } from './health-server';
import { ExportProcessor } from './exports/export-processor';
import { ChunkIndexProcessor } from './knowledge/chunk-index-processor';
import { KnowledgeSourceSweep } from './knowledge/knowledge-source-sweep';
import { JsonLogger } from './logger';
import { shutdownWorker } from './shutdown';
import { WorkerModule } from './worker.module';
import { OutboxProcessor } from './outbox/outbox-processor';

/**
 * Shared repository `.env`, resolved from this compiled `apps/worker/dist`
 * entrypoint. There is no `apps/.env`; getting this wrong silently starts the
 * worker on documented defaults instead of the configured environment.
 */
const ROOT_ENV_PATH = resolveRepositoryEnvPath(__dirname);

/**
 * Worker entry point.
 *
 * 1. Loads the repository `.env` when present.
 * 2. Parses configuration once; invalid or missing required configuration
 *    aborts startup with a safe message.
 * 3. Boots the Nest application context that composes the process's four loops:
 *    the channel-outbox delivery loop, the knowledge source sweep, the knowledge
 *    index (embedding) sweep, and the export queue.
 * 4. Starts all four loops, then the health/readiness HTTP server, and waits for
 *    termination signals so the process can shut down gracefully.
 *
 * The order of steps 4 and 5 is what makes readiness mean something: the health
 * server is only listening once the loops that give the process its purpose are
 * actually running, so a Worker that failed to boot never answers "ready".
 */
async function bootstrap(): Promise<void> {
  if (existsSync(ROOT_ENV_PATH)) {
    loadDotenv({ path: ROOT_ENV_PATH });
  }

  const parsed = parseAppConfig(process.env);
  if (parsed._tag === 'err') {
    console.error(`worker aborted: ${parsed.error.message}`);
    for (const name of parsed.error.missingRequired) {
      console.error(`missing required environment variable: ${name}`);
    }
    process.exitCode = 1;
    return;
  }

  const config = parsed.config;
  const logger = new JsonLogger(config.logLevel);

  const appContext = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    logger: false,
  });
  logger.logStructured('info', 'worker application context started', {}, 'Bootstrap');

  const outbox = appContext.get(OutboxProcessor);
  outbox.start();
  logger.logStructured('info', 'channel outbox processor started', {}, 'Bootstrap');

  // The source sweep starts before the embedding sweep so that the first pass of
  // each is in order: this one writes the `pending` slices the other claims. They
  // are independent loops and either would catch up on its own, but a boot that
  // happens to be the very first one should not spend an interval embedding
  // nothing.
  const sourceSweep = appContext.get(KnowledgeSourceSweep);
  sourceSweep.start();
  logger.logStructured('info', 'knowledge source sweep started', {}, 'Bootstrap');

  const indexSweep = appContext.get(ChunkIndexProcessor);
  indexSweep.start();
  // Logged with the fact that decides what it will do: a sweep with no provider
  // claims nothing, and an operator reading this line should not have to guess
  // whether "started" means "indexing".
  logger.logStructured(
    'info',
    'knowledge index sweep started',
    { providerConfigured: indexSweep.providerConfigured },
    'Bootstrap',
  );

  // The export loop is started last because it is the only one whose work was
  // requested by a person: everything above it is the platform catching up with
  // itself, and a boot that has an export waiting should finish coming up first.
  const exports = appContext.get(ExportProcessor);
  exports.start();
  logger.logStructured('info', 'export processor started', {}, 'Bootstrap');

  const healthServer = createHealthServer(isReady);
  await listen(healthServer, config.workerHealthHost, config.workerHealthPort);
  logger.logStructured(
    'info',
    'worker health server listening',
    { host: config.workerHealthHost, port: config.workerHealthPort },
    'Bootstrap',
  );

  let shuttingDown = false;

  function isReady(): boolean {
    // Readiness is "this process is doing its job": every loop it runs is
    // running, and no shutdown has begun. A Worker whose loop stopped while the
    // process stayed up is not ready, and a load balancer or an operator should
    // see that. All three loops are named here rather than one being assumed to
    // outlive the others: they have no dependency between them, so any one can
    // stop alone — and a Worker whose source sweep died is a Worker whose index
    // silently stops following the merchants' edits, which is exactly the state
    // readiness exists to make visible. The export loop is named for the same
    // reason: a queue nobody is draining looks, from the console, like a queue
    // that is still being worked.
    return (
      outbox.running && sourceSweep.running && indexSweep.running && exports.running && !shuttingDown
    );
  }

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void shutdownWorker({
      healthServer,
      appContext,
      logger,
      signal,
      // Every loop is stopped, in parallel and before anything is closed: each
      // waits for the work it has in flight, so a shutdown never cuts a claim
      // short — an outbox entry would stay leased, a slice would keep an attempt
      // nobody wrote back, and an export would sit `running` until its lease
      // expired — and a source sweep never stops between a source's chunks and its
      // keywords, which is one transaction.
      stopBackgroundWork: async () => {
        await Promise.all([
          outbox.stop(),
          sourceSweep.stop(),
          indexSweep.stop(),
          exports.stop(),
        ]);
      },
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`worker failed to start: ${message}`);
  process.exit(1);
});
