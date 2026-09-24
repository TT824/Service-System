import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Health check module.
 *
 * Exposes the stable liveness and readiness endpoints under the versioned
 * `/api/v1` prefix:
 *
 * - `GET /api/v1/health/live`  - process is up and accepting requests.
 * - `GET /api/v1/health/ready` - PostgreSQL, Redis, object storage and the
 *   worker are reachable; 503 with the per-dependency status otherwise.
 *
 * Every probe runs under the configured `HEALTH_TIMEOUT_MS` deadline and a
 * failed dependency can never be reported as ready.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
