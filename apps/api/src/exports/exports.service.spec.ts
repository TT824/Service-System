/**
 * The job row this module reads out of PostgreSQL, and the two download formats
 * it accepts.
 *
 * The job row is the one shape here that belongs to this process alone: the
 * console's five columns and "which files exist yet" are only ever read by the
 * API. The *customer* row is shared with the worker, so it lives in `@kefu/core`
 * beside `CustomerSummary` and is pinned down in `customer-directory.spec.ts` —
 * one copy, because two would drift without any test going red.
 *
 * A job whose JSONB payload is read without a fallback is the silent failure
 * worth testing for: `jobs` is the platform's general work table, and one row of
 * another shape must not take the whole task list down.
 *
 * The SQL itself is *not* here — it needs a live database and is covered by
 * `test/exports.e2e-spec.ts`, which drives it through HTTP.
 */

import { describe, expect, it } from 'vitest';
import { isArtifactFormat, toJobRecord, type JobRow } from './exports.service';

/** One job row, as the list query returns it. */
function jobRowOf(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'export-0f3a9c21',
    tenant_id: 'tenant-acme',
    status: 'succeeded',
    payload: {
      scope: 'conversation',
      label: '顾客「网页顾客-2LIX」的对话',
      conversationId: 'conversation-1',
    },
    result: { rowCount: 12 },
    error: null,
    created_at: new Date('2026-09-22T02:30:00.000Z'),
    started_at: new Date('2026-09-22T02:30:01.000Z'),
    finished_at: new Date('2026-09-22T02:30:02.000Z'),
    artifacts: ['transcript', 'xlsx'],
    ...overrides,
  };
}

describe('toJobRecord', () => {
  it('reads a job row, carrying the label that was stored with it', () => {
    const job = toJobRecord(jobRowOf());
    expect(job.id).toBe('export-0f3a9c21');
    expect(job.label).toBe('顾客「网页顾客-2LIX」的对话');
    expect(job.scope).toBe('conversation');
    expect(job.status).toBe('succeeded');
    expect(job.createdAt).toBe('2026-09-22T02:30:00.000Z');
    expect(job.startedAt).toBe('2026-09-22T02:30:01.000Z');
    expect(job.finishedAt).toBe('2026-09-22T02:30:02.000Z');
    expect(job.rowCount).toBe(12);
    expect(job.error).toBeNull();
  });

  it('orders the artifacts the way the menu offers them, whatever the aggregation said', () => {
    expect(toJobRecord(jobRowOf({ artifacts: ['transcript', 'xlsx'] })).artifacts).toEqual([
      'xlsx',
      'transcript',
    ]);
  });

  it('reports a job with no files yet as having none', () => {
    expect(toJobRecord(jobRowOf({ artifacts: [] })).artifacts).toEqual([]);
  });

  it('reports the two clocks as absent while a job has not been picked up', () => {
    const job = toJobRecord(jobRowOf({ status: 'pending', started_at: null, finished_at: null }));
    expect(job.startedAt).toBeNull();
    expect(job.finishedAt).toBeNull();
  });

  it('survives a payload it does not understand', () => {
    // `jobs` is the platform's general work table. A row of another shape shows
    // up as an unhelpful task rather than taking the page down.
    const job = toJobRecord(jobRowOf({ payload: null, result: 'nonsense' }));
    expect(job.label).toBe('export-0f3a9c21');
    expect(job.scope).toBe('conversation');
    expect(job.rowCount).toBeNull();
  });

  it('reads a failed job’s reason', () => {
    const job = toJobRecord(
      jobRowOf({ status: 'failed', result: null, error: '导出内容超过上限' }),
    );
    expect(job.status).toBe('failed');
    expect(job.error).toBe('导出内容超过上限');
    expect(job.rowCount).toBeNull();
  });
});

describe('isArtifactFormat', () => {
  it('accepts the two formats and nothing else', () => {
    expect(isArtifactFormat('xlsx')).toBe(true);
    expect(isArtifactFormat('transcript')).toBe(true);
    expect(isArtifactFormat('csv')).toBe(false);
    expect(isArtifactFormat('')).toBe(false);
  });
});
