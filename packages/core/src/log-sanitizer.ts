const SENSITIVE_KEY =
  /(password|passwd|secret|token|api.?key|authorization|connection.?string|database.?url|redis.?url|private.?key|credential)/i;
const CONNECTION_STRING =
  /\b(?:postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?|amqp):\/\/[^\s"'`]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_ASSIGNMENT =
  /\b(password|passwd|secret|token|api.?key|authorization|connection.?string|database.?url|redis.?url|private.?key|credential)\b\s*[:=]\s*(?:Bearer\s+[A-Za-z0-9._~+/=-]+|[^\s,;]+)/gi;
const MAX_DEPTH = 8;

/** Return a bounded, recursive, JSON-safe log projection. */
export function sanitizeLogValue(value: unknown): unknown {
  return sanitize(value, new WeakSet<object>(), 0);
}

function sanitize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeText(value);
  }
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  if (typeof value === 'undefined') {
    return '[undefined]';
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return `[${typeof value}]`;
  }
  if (depth >= MAX_DEPTH) {
    return '[MaxDepth]';
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeText(value.message),
      stack: '[Redacted]',
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key.toLowerCase() === 'stack' || SENSITIVE_KEY.test(key)) {
      output[key] = '[Redacted]';
      continue;
    }
    try {
      output[key] = sanitize(Reflect.get(value, key), seen, depth + 1);
    } catch {
      output[key] = '[Unserializable]';
    }
  }
  return output;
}

function sanitizeText(value: string): string {
  return value
    .replace(CONNECTION_STRING, '[Redacted connection string]')
    .replace(SENSITIVE_ASSIGNMENT, '$1=[Redacted]')
    .replace(BEARER_TOKEN, 'Bearer [Redacted]');
}
