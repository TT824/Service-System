import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import { parseAppConfig, resolveRepositoryEnvPath } from '@kefu/core';
import { AppModule } from './app.module';
import { AssignmentScheduler } from './assignment/assignment-scheduler';
import { applyHttpDefaults, attachJsonLogger } from './configure-app';
import { JsonLogger } from './logging/json-logger';

/**
 * Shared repository `.env`, resolved from this compiled `apps/api/dist`
 * entrypoint. There is no `apps/.env`; getting this wrong silently starts the
 * API on documented defaults instead of the configured environment.
 */
const ROOT_ENV_PATH = resolveRepositoryEnvPath(__dirname);

/**
 * Application entry point.
 *
 * 1. Loads the repository `.env` when present.
 * 2. Parses configuration once at the composition root. Invalid or missing
 *    required configuration aborts startup with a safe message (raw secrets
 *    are never printed).
 * 3. Boots the Nest application with the versioned prefix, CORS, structured
 *    logging and graceful shutdown hooks.
 */
async function bootstrap(): Promise<void> {
  if (existsSync(ROOT_ENV_PATH)) {
    loadDotenv({ path: ROOT_ENV_PATH });
  }

  const parsed = parseAppConfig(process.env);
  if (parsed._tag === 'err') {
    console.error(`startup aborted: ${parsed.error.message}`);
    for (const name of parsed.error.missingRequired) {
      console.error(`missing required environment variable: ${name}`);
    }
    process.exitCode = 1;
    return;
  }

  const config = parsed.config;
  const bootstrapLogger = new JsonLogger(config.logLevel);

  const app = await NestFactory.create(AppModule.register(config), {
    logger: bootstrapLogger,
  });
  app.enableShutdownHooks();
  applyHttpDefaults(app, config);
  await app.init();
  attachJsonLogger(app);

  await app.listen(config.apiPort, config.apiHost);

  // Started here rather than by the module, so a Nest context built in a test
  // binds the scheduler without a background sweep loop starting underneath it.
  // `enableShutdownHooks` above already runs `onApplicationShutdown`, which the
  // scheduler implements to stop its loop.
  app.get(AssignmentScheduler).start();

  const logger = app.get(JsonLogger);
  logger.logStructured(
    'info',
    'api listening',
    { host: config.apiHost, port: config.apiPort },
    'Bootstrap',
  );
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`api failed to start: ${message}`);
  process.exitCode = 1;
});
