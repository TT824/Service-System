import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RequestIdMiddleware } from './request-id.middleware';
import { RequestContextService } from './request-context.service';

/**
 * Global request context module.
 *
 * Provides the async-local request id carrier and registers the
 * {@link RequestIdMiddleware} for every route so each request enters a
 * request-id scope before any controller or filter runs.
 */
@Global()
@Module({
  providers: [RequestContextService, RequestIdMiddleware],
  exports: [RequestContextService],
})
export class RequestContextModule implements NestModule {
  /** @inheritdoc */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
