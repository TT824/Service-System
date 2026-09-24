import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, throwError, type Observable } from 'rxjs';
import { isAuthError } from '@kefu/core';

/**
 * Project a domain {@link AuthError} onto the platform's HTTP error contract.
 *
 * The domain services are plain classes shared with `@kefu/core`, so they
 * report failures as `AuthError` carrying a stable domain code and its HTTP
 * status. The global filter only understands `HttpException`, and it deliberately
 * replaces the message with the generic reason for the status, so the
 * projection is exactly: keep the status, collapse the domain code onto the
 * platform's coarse `ApiErrorCode`, and let the filter own the wording.
 *
 * Exported separately from the interceptor because guards run *before*
 * interceptors and must therefore project their own failures.
 *
 * @param error - The value thrown by a handler.
 * @returns An `HttpException` for an auth failure, otherwise the value unchanged.
 */
export function toHttpException(error: unknown): unknown {
  if (!isAuthError(error)) {
    return error;
  }
  return new HttpException({ code: error.apiCode }, error.status);
}

/**
 * Applies {@link toHttpException} to everything a route handler throws.
 *
 * Registered globally so a service that resolves access, rotates a session or
 * refuses a store outside its scope needs no knowledge of HTTP.
 */
@Injectable()
export class AuthErrorInterceptor implements NestInterceptor {
  /** @inheritdoc */
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(catchError((error: unknown) => throwError(() => toHttpException(error))));
  }
}
