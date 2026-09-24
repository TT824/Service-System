import { describe, expect, it, vi } from 'vitest';
import { JsonLogger } from './logger';

describe('Worker JsonLogger', () => {
  it('writes a JSON-safe recursive redaction projection', () => {
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    try {
      new JsonLogger('trace').logStructured('info', 'worker event', {
        connectionString: 'redis://user:secret@redis.internal:6379',
        nested: [{ token: 'secret-token' }],
      });
    } finally {
      write.mockRestore();
    }

    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record['connectionString']).toBe('[Redacted]');
    expect(record['nested']).toEqual([{ token: '[Redacted]' }]);
    expect(output).not.toContain('secret');
  });
});
