import { describe, expect, it } from 'vitest';
import { withTimeout } from './timeout';

describe('withTimeout', () => {
  it('rejects a hanging operation at the configured deadline', async () => {
    await expect(withTimeout(new Promise<never>(() => {}), 10, 'readiness')).rejects.toThrow(
      'readiness timed out after 10ms',
    );
  });

  it('rejects invalid deadlines', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 0, 'operation')).rejects.toThrow(
      'operation timeout must be positive',
    );
  });
});
