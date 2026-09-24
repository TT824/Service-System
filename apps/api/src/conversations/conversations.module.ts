import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { ContentSafetyModule } from '../content-safety/content-safety.module';
import { IdentityModule } from '../identity/identity.module';
import { MediaModule } from '../media/media.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

/**
 * Conversation workspace module.
 *
 * Provides the agent conversation list and lifecycle endpoints backed by the
 * global platform repository. The module imports {@link IdentityModule} so
 * member lookups (transfer targets) resolve through the identity service,
 * {@link ChannelsModule} so an outbound send is recorded and handed to the
 * channel delivery service in one step instead of the message being written and
 * its delivery silently skipped, and {@link RealtimeModule} so a committed
 * transition or message is announced to the seats watching it, and
 * {@link ContentSafetyModule} so an outbound message is checked against the
 * banned-phrase library before it is written (§4.5, UC-17).
 */
@Module({
  imports: [IdentityModule, ChannelsModule, MediaModule, RealtimeModule, ContentSafetyModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
