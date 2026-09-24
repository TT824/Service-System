import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';

/**
 * Identity and directory module.
 *
 * Exposes the account status (`GET /access/status`) and the tenant directory
 * (`GET /directory/tenants`, `GET /directory/tenants/:tenantId`) used by the
 * account center and configuration views.
 *
 * {@link ChannelsModule} is imported for its credential reader alone: the
 * account status carries the same channel description the channel page renders,
 * and that description has to name the origin of the credentials it is about —
 * so this module reads the same configured set, once, rather than describing an
 * environment the deployment may no longer be connecting with.
 */
@Module({
  imports: [ChannelsModule],
  controllers: [IdentityController],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
