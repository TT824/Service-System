import { describe, expect, it, vi } from 'vitest';
import { JsonLogger } from './json-logger';

describe('API JsonLogger', () => {
  it('writes recursively sanitized fields and never writes an Error stack', () => {
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const error = new Error('authorization=Bearer secret-token');
    error.stack = 'Error: secret stack';

    try {
      new JsonLogger('trace').logStructured(
        'error',
        'request failed token=secret-token',
        {
          nested: { password: 'pw' },
          items: [error],
        },
        'Test',
      );
    } finally {
      write.mockRestore();
    }

    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record['msg']).toBe('request failed token=[Redacted]');
    expect(record['nested']).toEqual({ password: '[Redacted]' });
    expect(record['items']).toEqual([
      {
        name: 'Error',
        message: 'authorization=[Redacted]',
        stack: '[Redacted]',
      },
    ]);
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('secret stack');
  });
});
