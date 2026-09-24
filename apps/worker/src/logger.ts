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
 * Minimal structured JSON logger for the worker process.
 *
 * Each line is one JSON object written to stdout:
 * `{ time, level, msg, context?, ...fields }`. It is intentionally small:
 * the worker has no HTTP request lifecycle in SDD-002, so request correlation
 * is not needed here. Secrets are never passed to the logger.
 */
export class JsonLogger {
  /**
   * @param configuredLevel - Minimum level that is written to stdout.
   */
  constructor(private readonly configuredLevel: LogLevel) {}

  /**
   * Write a structured log record.
   *
   * @param level - Severity level.
   * @param message - Short human-readable event description.
   * @param fields - Safe structured fields to attach.
   * @param context - Optional context label.
   */
  logStructured(
    level: LogLevel,
    message: string,
    fields: Readonly<Record<string, unknown>>,
    context?: string,
  ): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.configuredLevel]) {
      return;
    }
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      msg: message,
    };
    if (context !== undefined) {
      record['context'] = context;
    }
    for (const [key, value] of Object.entries(fields)) {
      record[key] = sanitizeLogValue(value);
    }
    process.stdout.write(`${safeStringify(record)}\n`);
  }
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(sanitizeLogValue(value));
    return serialized === undefined ? 'undefined' : serialized;
  } catch {
    return '{"msg":"[unserializable value]"}';
  }
}
