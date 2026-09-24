import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER, resolveRequestId, type LogLevel } from '@kefu/core';
import { JsonLogger } from '../logging/json-logger';
import { RequestContextService } from './request-context.service';

/**
 * Assigns a request id to every request and propagates it through responses,
 * logs and error bodies.
 *
 * A trusted incoming `X-Request-ID` is preserved only when it matches the
 * documented validation rule in `@kefu/core`; invalid or missing values are
 * replaced by a generated id so logs and headers never echo attacker-controlled
 * characters.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  /**
   * @param requestContext - Scopes the request id for the async request chain.
   * @param logger - Structured logger used for the completion log line.
   */
  constructor(
    private readonly requestContext: RequestContextService,
    @Inject(JsonLogger)
    private readonly logger: JsonLogger,
  ) {}

  /** @inheritdoc */
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = resolveRequestId(req.header(REQUEST_ID_HEADER));
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const startedAt = process.hrtime.bigint();

    this.requestContext.run(requestId, () => {
      res.once('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const statusCode = res.statusCode;
        const level: LogLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
        this.logger.logStructured(
          level,
          'request completed',
          {
            method: req.method,
            path: req.path,
            statusCode,
            durationMs: roundTo(durationMs, 2),
          },
          'Http',
        );
      });
      next();
    });
  }
}

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
