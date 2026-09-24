import { describe, expect, it } from 'vitest';
import { sanitizeLogValue } from './log-sanitizer';

describe('sanitizeLogValue', () => {
  it('recursively redacts sensitive keys, errors and sensitive text', () => {
    const error = new Error('token=top-secret');
    error.stack = 'Error: token=top-secret\n    at secret-file.ts:1:1';
    const value = {
      password: 'password-value',
      nested: [{ authorization: 'Bearer abc', error }],
      message: 'postgres://user:pass@db.internal/kefu',
    };

    expect(sanitizeLogValue(value)).toEqual({
      password: '[Redacted]',
      nested: [
        {
          authorization: '[Redacted]',
          error: {
            name: 'Error',
            message: 'token=[Redacted]',
            stack: '[Redacted]',
          },
        },
      ],
      message: '[Redacted connection string]',
    });
  });

  it('protects cyclic values, throwing getters and non-enumerable fields', () => {
    const cyclic: Record<string, unknown> = { safe: 'value' };
    cyclic['self'] = cyclic;
    Object.defineProperty(cyclic, 'throws', {
      enumerable: true,
      get() {
        throw new Error('getter failed');
      },
    });

    expect(sanitizeLogValue(cyclic)).toEqual({
      safe: 'value',
      self: '[Circular]',
      throws: '[Unserializable]',
    });
  });

  it('binds deeply nested objects to a maximum depth', () => {
    let nested: Record<string, unknown> = { at: 'bottom' };
    for (let depth = 0; depth < 12; depth += 1) {
      nested = { child: nested };
    }

    const serialized = JSON.stringify(sanitizeLogValue(nested));
    expect(serialized).toContain('[MaxDepth]');
    expect(serialized).not.toContain('bottom');
  });

  it('projects non-serializable primitives without throwing', () => {
    const value = {
      big: 123n,
      fn: () => 'noop',
      sym: Symbol('x'),
      missing: undefined,
    };

    expect(sanitizeLogValue(value)).toEqual({
      big: '123n',
      fn: '[function]',
      sym: '[symbol]',
      missing: '[undefined]',
    });
  });
});
