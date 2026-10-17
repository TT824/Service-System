import { Module } from '@nestjs/common';
import { PersonalPhrasesController } from './personal-phrases.controller';
import { PersonalPhrasesService } from './personal-phrases.service';

/**
 * Personal quick phrases module.
 *
 * Canned replies belonging to one member rather than to the tenant, so nothing
 * here is shared with the knowledge surfaces: the platform repository and the
 * `AccessService` both come from the global platform module, and this module
 * declares only the route and the rule that owns it.
 */
@Module({
  controllers: [PersonalPhrasesController],
  providers: [PersonalPhrasesService],
})
export class PersonalPhrasesModule {}
