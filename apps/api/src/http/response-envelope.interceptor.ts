import 'reflect-metadata';
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable, map } from 'rxjs';
import { requestIdFromResponse } from './request-id-response';

/**
 * NestJS stores SSE metadata on the handler under this key (`@nestjs/common`
 * defines `SSE_METADATA = '__sse__'`). It is spelled out here to avoid
 * importing from a non-public package path.
 */
const SSE_METADATA = '__sse__' as const;

/**
 * Wraps every successful JSON response into the documented envelope
 * `{ request_id, data, meta }`.
 *
 * The request id is read from the response header that the
 * request-id middleware set, keeping the body id and the header id identical.
 *
 * Server-Sent Event routes are exempt: an SSE stream is a sequence of raw
 * `MessageEvent` frames (not a JSON envelope), so wrapping each frame would
 * corrupt the wire contract.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  /** @inheritdoc */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (Reflect.getMetadata(SSE_METADATA, context.getHandler()) === true) {
      return next.handle();
    }
    const response = context.switchToHttp().getResponse<Response>();
    const requestId = requestIdFromResponse(response);
    return next.handle().pipe(
      map((data: unknown) => ({
        request_id: requestId,
        data,
        meta: {},
      })),
    );
  }
}
