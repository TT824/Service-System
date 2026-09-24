import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { AssignmentController } from './assignment.controller';
import { AssignmentScheduler } from './assignment-scheduler';
import { AssignmentService } from './assignment.service';

/**
 * Agent availability and automatic assignment.
 *
 * Imports {@link RealtimeModule} and nothing else: {@link PlatformModule} is
 * global and already exports the repository port and the request access service,
 * and the sweep still deliberately holds no *feature* service, so there is no
 * module cycle to avoid by hand. The publisher is not a feature service — it
 * depends on nothing at all — which is what lets the dispatcher announce a seat
 * change without gaining a route back into the conversation service.
 *
 * The scheduler is bound but not started here — `main.ts` starts it — so a Nest
 * context built in a test does not begin sweeping underneath the test.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [AssignmentController],
  providers: [AssignmentService, AssignmentScheduler],
  exports: [AssignmentService],
})
export class AssignmentModule {}
