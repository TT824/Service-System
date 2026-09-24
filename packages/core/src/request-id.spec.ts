import { describe, expect, it } from 'vitest';
import {
  REQUEST_ID_HEADER,
  generateRequestId,
  isTrustedRequestId,
  parseTrustedRequestId,
  resolveRequestId,
} from './request-id';

describe('request-id', () => {
  it('accepts the documented trusted request id format', () => {
    expect(parseTrustedRequestId('abc-123')).toBe('abc-123');
    expect(parseTrustedRequestId('0A1')).toBe('0A1');
    expect(isTrustedRequestId('a')).toBe(true);
  });

  it('rejects request ids that could inject log or header data', () => {
    for (const invalid of [
      '-lead-hyphen',
      'has space',
      'has\nnewline',
      'has\rreturn',
      'has;quote',
      'contains_underscore',
      'a'.repeat(65),
    ]) {
      expect(parseTrustedRequestId(invalid), `input=${JSON.stringify(invalid)}`).toBeNull();
    }
  });

  it('generates request ids that always satisfy the rule', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(isTrustedRequestId(generateRequestId())).toBe(true);
    }
  });

  it('preserves a valid incoming request id', () => {
    expect(resolveRequestId('client-42')).toBe('client-42');
  });

  it('replaces an invalid incoming request id with a generated one', () => {
    const resolved = resolveRequestId('bad\nvalue');
    expect(resolved).not.toBe('bad\nvalue');
    expect(isTrustedRequestId(resolved)).toBe(true);
  });

  it('generates when no incoming request id is present', () => {
    const resolved = resolveRequestId(undefined);
    expect(isTrustedRequestId(resolved)).toBe(true);
  });

  it('exposes the documented header name', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });
});
