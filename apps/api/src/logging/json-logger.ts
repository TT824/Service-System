import type { LoggerService } from '@nestjs/common';
import { sanitizeLogValue, type LogLevel } from '@kefu/core';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/**
 * Structured JSON logger that implements the Nest {@link LoggerService}.
 *
 * Every line is one JSON object written to stdout:
 * `{ time, level, msg, context?, stack?, requestId? }`. The request id is read
 * from the active {@link RequestContextService} scope when present. Sensitive
 * values are never passed to the logger; use the `Redacted` wrapper from
 * `@kefu/core` at boundaries instead.
 */
export class JsonLogger implements LoggerService {
  #requestIdReader: (() => string | undefined) | undefined;

  /**
   * @param configuredLevel - Minimum level that is written to stdout.
   */
  constructor(private readonly configuredLevel: LogLevel) {}

  /**
   * Provide a reader for the active request id.
   *
   * @param reader - Returns the current request id, if any.
   */
  setRequestIdReader(reader: () => string | undefined): void {
    this.#requestIdReader = reader;
  }

  /**
   * Log a structured record.
   *
   * @param level - Severity level.
   * @param event - Short human-readable event description.
   * @param fields - Safe structured fields to attach.
   * @param context - Optional Nest-style context label.
   */
  logStructured(
    level: LogLevel,
    event: string,
    fields: Readonly<Record<string, unknown>>,
    context?: string,
  ): void {
    this.#emit(level, event, fields, context);
  }

  /** @inheritdoc */
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.#write('info', message, optionalParams);
  }

  /** @inheritdoc */
  error(message: unknown, ...optionalParams: unknown[]): void {
    this.#write('error', message, optionalParams);
  }

  /** @inheritdoc */
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.#write('warn', message, optionalParams);
  }

  /** @inheritdoc */
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.#write('debug', message, optionalParams);
  }

  /** @inheritdoc */
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.#write('trace', message, optionalParams);
  }

  /** @inheritdoc */
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.#write('fatal', message, optionalParams);
  }

  #write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    if (!this.#enabled(level)) {
      return;
    }
    const { context, stack } = extractNestParams(optionalParams);
    const fields: Record<string, unknown> = {};
    if (context !== undefined) {
      fields['context'] = context;
    }
    if (stack !== undefined) {
      fields['stack'] = stack;
    }
    this.#emit(level, describeMessage(message), fields);
  }

  #emit(
    level: LogLevel,
    message: string,
    fields: Readonly<Record<string, unknown>>,
    context?: string,
  ): void {
    if (!this.#enabled(level)) {
      return;
    }
    const requestId = this.#requestIdReader?.();
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      msg: message,
    };
    if (context !== undefined) {
      record['context'] = context;
    }
    if (requestId !== undefined) {
      record['requestId'] = requestId;
    }
    for (const [key, value] of Object.entries(fields)) {
      record[key] = sanitizeLogValue(value);
    }
    process.stdout.write(`${safeStringify(record)}\n`);
  }

  #enabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.configuredLevel];
  }
}

function extractNestParams(params: ReadonlyArray<unknown>): {
  readonly context?: string;
  readonly stack?: string;
} {
  let context: string | undefined;
  let stack: string | undefined;
  for (const param of params) {
    if (typeof param !== 'string') {
      continue;
    }
    if (param.includes('\n')) {
      stack = stack === undefined ? param : `${stack}\n${param}`;
    } else {
      context = param;
    }
  }
  return {
    ...(context !== undefined ? { context } : {}),
    ...(stack !== undefined ? { stack } : {}),
  };
}

function describeMessage(message: unknown): string {
  if (typeof message === 'string') {
    return String(sanitizeLogValue(message));
  }
  if (message instanceof Error) {
    return String(sanitizeLogValue(message.message));
  }
  return safeStringify(message);
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(sanitizeLogValue(value));
    return serialized === undefined ? 'undefined' : serialized;
  } catch {
    return '{"msg":"[unserializable value]"}';
  }
}
