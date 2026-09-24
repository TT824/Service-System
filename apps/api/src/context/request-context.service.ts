import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestId } from '@kefu/core';

/**
 * Carries the current request id through asynchronous execution.
 *
 * The middleware enters an {@link AsyncLocalStorage} scope per request so that
 * request-scoped code (controllers, filters, loggers) can read the active
 * request id without threading it through every call.
 */
@Injectable()
export class RequestContextService {
  readonly #storage = new AsyncLocalStorage<string>();

  /**
   * Run a callback inside a request id scope.
   *
   * @template T - The callback return type.
   * @param requestId - The request id for the scope.
   * @param callback - Work to run inside the scope.
   * @returns The callback result.
   */
  run<T>(requestId: RequestId, callback: () => T): T {
    return this.#storage.run(requestId, callback);
  }

  /**
   * Read the current request id, if a request scope is active.
   *
   * @returns The active request id, or `undefined` outside a request.
   */
  currentRequestId(): string | undefined {
    return this.#storage.getStore();
  }
}
