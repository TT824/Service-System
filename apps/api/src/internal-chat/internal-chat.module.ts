import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { InternalAttachmentService } from './internal-attachment.service';
import { InternalChatController } from './internal-chat.controller';
import { InternalChatService } from './internal-chat.service';
import { InternalMediaController } from './internal-media.controller';

/**
 * Internal collaboration module.
 *
 * Imports {@link RealtimeModule} so a committed message is announced to the
 * other participant's open stream, and {@link MediaModule} because an attachment
 * is bytes in the same object store a customer's picture lives in and a link
 * signed by the same service. The directory and the threads still come from the
 * global platform repository, and the tenant scope from the global
 * {@link AccessService}.
 *
 * {@link AuthModule} is imported for `AUTH_REPOSITORY` alone: a colleague's
 * picture belongs to an account, not to the member the platform directory knows,
 * so the join between the two is only reachable from the authentication side.
 */
@Module({
  imports: [AuthModule, RealtimeModule, MediaModule],
  controllers: [InternalChatController, InternalMediaController],
  providers: [InternalChatService, InternalAttachmentService],
})
export class InternalChatModule {}
