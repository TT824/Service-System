import type { INestApplication } from '@nestjs/common';
import type { AppConfig } from '@kefu/core';
import { RequestContextService } from './context/request-context.service';
import { API_PREFIX } from './http/api-prefix';
import { JsonLogger } from './logging/json-logger';
import { WECOM_CALLBACK_PATH, captureWecomRawBody } from './channels/wecom-raw-body';

/**
 * Apply HTTP-level defaults shared by the real bootstrap (`main.ts`) and the
 * interface tests so the two cannot drift apart.
 *
 * Call before the application is initialised: the global prefix and CORS
 * configuration are read while routes are registered, and the raw-body capture
 * has to be mounted ahead of Nest's body parsers, which run during `init`.
 *
 * @param app - The Nest application to configure.
 * @param config - Parsed application configuration.
 */
export function applyHttpDefaults(app: INestApplication, config: AppConfig): void {
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({ origin: [...config.corsOrigins], credentials: true });
  // A WeCom callback is authenticated with a digest over the exact request
  // bytes, so the channel callback routes keep their raw body. Registering it
  // here rather than in `main.ts` is what gives the interface tests the same
  // boundary the real bootstrap serves.
  app.use(WECOM_CALLBACK_PATH, captureWecomRawBody);
}

/**
 * Attach the structured JSON logger and its request id reader.
 *
 * Call after the application is initialised so `app.get` can resolve the
 * global providers. Every Nest internal log then uses the same JSON logger
 * instance that the request middleware, filters and interceptors use.
 *
 * @param app - The initialised Nest application.
 */
export function attachJsonLogger(app: INestApplication): void {
  const logger = app.get(JsonLogger);
  const requestContext = app.get(RequestContextService);
  logger.setRequestIdReader(() => requestContext.currentRequestId());
  app.useLogger(logger);
}
