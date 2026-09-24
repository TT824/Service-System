import { Module } from '@nestjs/common';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

/**
 * Review module.
 *
 * Manages the platform review policy (readable by all, writable only by the
 * platform administrator), the pending review queue and approvals that persist
 * approved phrases and audit entries.
 */
@Module({
  controllers: [ReviewController],
  providers: [ReviewService],
})
export class ReviewModule {}
