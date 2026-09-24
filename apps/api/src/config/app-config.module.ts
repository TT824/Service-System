import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from '@kefu/core';

/** Injection token that carries the parsed application configuration. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Global configuration module.
 *
 * The parsed {@link AppConfig} is produced by the composition root and passed
 * into {@link AppConfigModule.register}, so configuration parsing happens once
 * at bootstrap and every provider receives the same typed value.
 */
@Global()
@Module({})
export class AppConfigModule {
  /**
   * Register the module with an already-parsed configuration value.
   *
   * @param config - Parsed application configuration.
   * @returns A global dynamic module exposing `APP_CONFIG`.
   */
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
