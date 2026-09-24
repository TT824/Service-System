import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { DependencyStatus } from './health.service';
import { HealthService } from './health.service';

/**
 * Stable liveness/readiness payload returned by the health endpoints.
 *
 * Success responses are wrapped by the global envelope interceptor, so the
 * HTTP body is `{ request_id, data: <HealthPayload>, meta: {} }`.
 */
export type HealthPayload = {
  readonly status: 'ok' | 'unavailable';
  readonly service: 'api';
};

/** Per-dependency readiness reported by the readiness endpoint. */
export type DependenciesPayload = Readonly<Record<string, DependencyStatus>>;

/** Shared payload for the liveness endpoint. */
const HEALTHY: HealthPayload = Object.freeze({ status: 'ok', service: 'api' });

/**
 * Liveness and readiness endpoints.
 *
 * Responses keep one stable shape so orchestrators and local scripts can rely
 * on the status code and JSON body without coupling to business modules.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}
  /**
   * Liveness probe. Returns 200 once the process can answer HTTP requests.
   *
   * @returns The stable health payload.
   */
  @Get('live')
  live(): HealthPayload {
    return HEALTHY;
  }

  /**
   * Readiness probe. Returns 200 while PostgreSQL, Redis, object storage and
   * the worker are all reachable, 503 otherwise.
   *
   * @returns The stable health payload plus per-dependency statuses.
   */
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async ready(@Res({ passthrough: true }) response: Response): Promise<
    HealthPayload & {
      readonly dependencies: DependenciesPayload;
    }
  > {
    const result = await this.healthService.readiness();
    if (!result.ready) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      status: result.ready ? 'ok' : 'unavailable',
      service: 'api',
      dependencies: {
        postgres: result.postgres,
        redis: result.redis,
        object_storage: result.objectStorage,
        worker: result.worker,
      },
    };
  }
}
