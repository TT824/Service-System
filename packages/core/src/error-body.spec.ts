import { describe, expect, it } from 'vitest';
import { buildApiErrorBody, errorCodeForHttpStatus } from './error-body';

describe('error-body', () => {
  it('builds the documented stable error shape', () => {
    const body = buildApiErrorBody({
      requestId: 'req-1',
      code: 'bad_request',
      message: 'invalid input',
      details: [{ field: 'name', reason: 'required' }],
    });
    expect(body).toEqual({
      request_id: 'req-1',
      code: 'bad_request',
      message: 'invalid input',
      details: [{ field: 'name', reason: 'required' }],
    });
  });

  it('defaults details to an empty array', () => {
    const body = buildApiErrorBody({ requestId: 'req-1', code: 'not_found', message: 'gone' });
    expect(body.details).toEqual([]);
  });

  it('maps HTTP status codes to stable error codes', () => {
    expect(errorCodeForHttpStatus(400)).toBe('bad_request');
    expect(errorCodeForHttpStatus(401)).toBe('unauthorized');
    expect(errorCodeForHttpStatus(403)).toBe('forbidden');
    expect(errorCodeForHttpStatus(404)).toBe('not_found');
    expect(errorCodeForHttpStatus(409)).toBe('conflict');
    expect(errorCodeForHttpStatus(422)).toBe('unprocessable_entity');
    expect(errorCodeForHttpStatus(429)).toBe('too_many_requests');
    expect(errorCodeForHttpStatus(503)).toBe('service_unavailable');
  });

  it('keeps channel_not_configured a constructible code beside service_unavailable', () => {
    // "This channel was never configured here" and "the dependency is
    // momentarily down" are different answers, so the channel code stays its own
    // stable value: 503 keeps mapping to `service_unavailable` by status alone,
    // and only an explicit channel refusal may carry `channel_not_configured`.
    expect(errorCodeForHttpStatus(503)).toBe('service_unavailable');
    expect(
      buildApiErrorBody({
        requestId: 'req-1',
        code: 'channel_not_configured',
        message: 'the WeCom transport is not configured',
      }).code,
    ).toBe('channel_not_configured');
  });

  it('falls back to internal_error for unmapped statuses', () => {
    expect(errorCodeForHttpStatus(500)).toBe('internal_error');
    expect(errorCodeForHttpStatus(599)).toBe('internal_error');
  });
});
