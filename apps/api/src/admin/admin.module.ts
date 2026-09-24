import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AssignmentModule } from '../assignment/assignment.module';

/**
 * Platform administration module.
 *
 * Provides the tenant, store, member, role, store-scope and account
 * administration surface. The domain services are provided by the global
 * authentication module.
 *
 * `AssignmentModule` is imported for one route: the tenant's seat presence, which
 * the 客服账号 roster reads to draw each row's 在线/离线 lamp. Nothing else on this
 * controller goes through it.
 */
@Module({
  controllers: [AdminController],
  imports: [AssignmentModule],
})
export class AdminModule {}
