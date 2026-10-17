import {
  Catch,
  HttpStatus,
  PayloadTooLargeException,
  type ArgumentsHost,
  type ExceptionFilter,
  type Type,
} from '@nestjs/common';
import type { Response } from 'express';
import { buildApiErrorBody } from '@kefu/core';
import { requestIdFromResponse } from './request-id-response';

/**
 * Turn multer's own 413 into the documented 400.
 *
 * multer's `limits.fileSize` fires *before* the route body runs and throws
 * `PayloadTooLargeException` (413). `errorCodeForHttpStatus` has no entry for
 * 413, so left to the global filter it falls through to the `default` branch
 * and answers with `code: "internal_error"` — an error body the contract does
 * not contain, for a caller's own input. A file that is too large is a bad
 * request, and this is where that is said.
 *
 * The message names the gate's own limit, because two of them guard each
 * upload: multer's backstop (memory protection, deliberately above the business
 * cap) and the service's own judgement. They must stay distinguishable, or a
 * test — and an operator reading a log — cannot tell which one refused.
 *
 * A factory rather than one class, so each upload route keeps its own words
 * while sharing the behaviour: written once, because two copies of a status
 * mapping drift the first time one of them is fixed.
 *
 * @param detail - The line naming which limit was exceeded.
 * @returns The filter class for `@UseFilters`.
 */
export function uploadTooLargeFilter(detail: string): Type<ExceptionFilter> {
  @Catch(PayloadTooLargeException)
  class UploadTooLargeFilter implements ExceptionFilter {
    /** @inheritdoc */
    catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
      const response = host.switchToHttp().getResponse<Response>();
      response.status(HttpStatus.BAD_REQUEST).json(
        buildApiErrorBody({
          requestId: requestIdFromResponse(response),
          code: 'bad_request',
          message: 'Bad Request',
          details: [detail],
        }),
      );
    }
  }
  return UploadTooLargeFilter;
}
