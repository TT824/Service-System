import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';

/**
 * Account center module.
 *
 * The domain services it needs are provided by the global authentication
 * module, so the module only has to declare its controller.
 */
@Module({
  controllers: [AccountController],
})
export class AccountModule {}
