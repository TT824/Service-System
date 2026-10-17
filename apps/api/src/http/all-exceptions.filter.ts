import {
  Catch,
  Inject,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  buildApiErrorBody,
  errorCodeForHttpStatus,
  type ApiErrorBody,
  type ApiErrorCode,
} from '@kefu/core';
import { JsonLogger } from '../logging/json-logger';
import { requestIdFromResponse } from './request-id-response';

const MAX_DETAILS_ITEMS = 20;
const MAX_DETAIL_CHARS = 200;

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'request_timeout',
  'conflict',
  'unprocessable_entity',
  'too_many_requests',
  'internal_error',
  'bad_gateway',
  'service_unavailable',
  'gateway_timeout',
  'config_error',
  'account_locked',
  'channel_disabled',
  'channel_not_configured',
]);

/**
 * Messages that say more than the status code can.
 *
 * Almost every failure is described by its status, so the wording stays generic
 * and no credential detail can leak. A locked account is the exception the
 * caller has to act on: "Unauthorized" reads as "wrong password", and the one
 * thing that cannot work while locked is retrying with the right one.
 */
const MESSAGE_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  account_locked: 'Account Locked',
});

/**
 * Global exception filter that converts every error into the documented stable
 * error body `{ request_id, code, message, details }`.
 *
 * Unexpected errors are logged server-side with their stack trace but the
 * response never leaks secrets or stack traces.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  /**
   * @param logger - Structured logger used for unexpected errors.
   */
  constructor(@Inject(JsonLogger) private readonly logger: JsonLogger) {}

  /** @inheritdoc */
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = requestIdFromResponse(response);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = this.toErrorBody(exception, status, requestId);
      response.status(status).json(body);
      return;
    }

    const message =
      exception instanceof Error ? exception.message : 'Unhandled non-Error exception';
    const stack = exception instanceof Error ? exception.stack : undefined;
    this.logger.error(message, stack, 'AllExceptionsFilter');
    const body = buildApiErrorBody({
      requestId,
      code: 'internal_error',
      message: 'Internal Server Error',
    });
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }

  private toErrorBody(exception: HttpException, status: number, requestId: string): ApiErrorBody {
    const code = errorCodeForHttpStatus(status);
    const payload = exception.getResponse();
    let details: ReadonlyArray<unknown> = [];
    let effectiveCode = code;

    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      if (Array.isArray(record['message'])) {
        details = sanitizeDetails(record['message']);
      }
      if (typeof record['code'] === 'string' && KNOWN_ERROR_CODES.has(record['code'])) {
        effectiveCode = record['code'] as ApiErrorCode;
      }
    }

    return buildApiErrorBody({
      requestId,
      code: effectiveCode,
      message: MESSAGE_BY_CODE[effectiveCode] ?? publicMessageForStatus(status),
      details,
    });
  }
}

function sanitizeDetails(details: ReadonlyArray<unknown>): ReadonlyArray<unknown> {
  return details.slice(0, MAX_DETAILS_ITEMS).map((detail) => sanitizeDetail(detail));
}

function sanitizeDetail(detail: unknown): unknown {
  if (typeof detail === 'string') {
    return sanitizePublicText(detail);
  }
  if (typeof detail === 'number' || typeof detail === 'boolean' || detail === null) {
    return detail;
  }
  return sanitizePublicText(safeJson(detail));
}

function publicMessageForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 405:
      return 'Method Not Allowed';
    case 408:
      return 'Request Timeout';
    case 409:
      return 'Conflict';
    case 422:
      return 'Unprocessable Entity';
    case 429:
      return 'Too Many Requests';
    case 502:
      return 'Bad Gateway';
    case 503:
      return 'Service Unavailable';
    case 504:
      return 'Gateway Timeout';
    default:
      return 'Internal Server Error';
  }
}

function sanitizePublicText(value: string): string {
  return truncate(
    value
      .replace(/\b(?:postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/[^\s"'`]+/gi, '[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(
        /(password|passwd|token|secret|api.?key|authorization|connection.?string|database.?url|redis.?url)\s*[:=]\s*[^\s,;]+/gi,
        '$1=[redacted]',
      ),
    MAX_DETAIL_CHARS,
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 'undefined' : serialized;
  } catch {
    return '[unserializable detail]';
  }
}
