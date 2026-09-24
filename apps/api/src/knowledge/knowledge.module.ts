import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

/**
 * Knowledge base module.
 *
 * Products, FAQs and shortcuts are managed as tenant-owned knowledge used by
 * retrieval/suggestion generation. The platform repository and the
 * `AccessService` come from the global platform module.
 */
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
})
export class KnowledgeModule {}
