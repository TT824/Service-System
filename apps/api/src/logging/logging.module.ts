import { Global, Module } from '@nestjs/common';
import type { AppConfig } from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { JsonLogger } from './json-logger';

/**
 * Global logging module.
 *
 * Provides the structured {@link JsonLogger} configured with the parsed log
 * level. The active request id reader is attached at bootstrap after the
 * application is initialised.
 */
@Global()
@Module({
  providers: [
    {
      provide: JsonLogger,
      useFactory: (config: AppConfig) => new JsonLogger(config.logLevel),
      inject: [APP_CONFIG],
    },
  ],
  exports: [JsonLogger],
})
export class LoggingModule {}
