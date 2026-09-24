import { describe, expect, it } from 'vitest';
import { generateRequestId, isTrustedRequestId, REQUEST_ID_MAX_LENGTH } from '@kefu/core';

/**
 * Cross-package example test.
 *
 * Exercises a shared primitive from `@kefu/core` exactly as an application
 * would import it. The assertions are deterministic: they never depend on the
 * environment, wall-clock time or external services, so this test passes on a
 * fresh clone before any infrastructure is started.
 */
describe('shared request id primitive (cross-package example)', () => {
  it('accepts only ids that match the documented validation rule', () => {
    expect(isTrustedRequestId('client-trace-1')).toBe(true);
    expect(isTrustedRequestId('')).toBe(false);
    expect(isTrustedRequestId('-leading-dash')).toBe(false);
    expect(isTrustedRequestId('bad\nvalue')).toBe(false);
    expect(isTrustedRequestId('a'.repeat(REQUEST_ID_MAX_LENGTH + 1))).toBe(false);
  });

  it('generates ids with a fixed length that always validate', () => {
    for (let index = 0; index < 25; index += 1) {
      const id = generateRequestId();
      expect(id.length).toBe(36);
      expect(isTrustedRequestId(id)).toBe(true);
    }
  });
});
