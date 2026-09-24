import { Module } from '@nestjs/common';
import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';

/**
 * The realtime surface.
 *
 * Exported rather than global: a module that publishes frames imports this one,
 * so the dependency is visible in its own `imports` array instead of being
 * ambient. `RealtimeService` itself depends on nothing, so importing it cannot
 * create a cycle no matter which feature module needs it.
 */
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
