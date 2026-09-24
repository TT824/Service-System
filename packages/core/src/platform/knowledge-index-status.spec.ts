/**
 * What the status read model decides on its own.
 *
 * The SQL behind it decides *which rows* — that is the adapter's job and it is
 * tested against a real database. What is settled here is the shape the adapter
 * hands back, and every case below is a way that shape can lie:
 *
 * - **A state with no rows is a zero, not a missing key.** `GROUP BY` is silent
 *   about the states nothing is in, so a tenant with nothing parked would report
 *   `{…}` without `skipped` — and a consumer reading `summary.counts.skipped`
 *   gets `undefined`, which is not a number of slices and is not zero either.
 * - **`total` is the sum of the four, not a fifth query.** Two numbers that can
 *   disagree eventually do; here the invariant holds by construction, and the
 *   case below fails the day someone re-derives it.
 * - **A fifth state or a broken count is refused.** `0011` allows four states and
 *   a count column that cannot be negative; a row outside that is a migration and
 *   this code disagreeing, and folding it into a count would report a number
 *   nobody can act on.
 */

import { describe, expect, it } from 'vitest';
import { CHUNK_INDEX_STATUSES, isChunkIndexStatus } from './knowledge-index-state';
import { summarizeKnowledgeIndexCounts } from './knowledge-index-status';

describe('summarizeKnowledgeIndexCounts', () => {
  it('reports a zero for every state the aggregate was silent about', () => {
    const counts = summarizeKnowledgeIndexCounts([{ indexStatus: 'indexed', count: 4 }]);

    // The three absent states are the assertion: `GROUP BY` returned one row, and
    // the answer still has to be a complete picture of the tenant.
    expect(counts).toEqual({ pending: 0, indexed: 4, failed: 0, skipped: 0, total: 4 });
  });

  it('totals the four states rather than counting them separately', () => {
    const counts = summarizeKnowledgeIndexCounts([
      { indexStatus: 'pending', count: 3 },
      { indexStatus: 'indexed', count: 11 },
      { indexStatus: 'failed', count: 2 },
      { indexStatus: 'skipped', count: 1 },
    ]);

    expect(counts).toEqual({ pending: 3, indexed: 11, failed: 2, skipped: 1, total: 17 });
  });

  it('sums a state the aggregate reported twice', () => {
    // Not something `GROUP BY` produces — but the function is total, so a caller
    // assembling rows from two queries gets a sum instead of the last one.
    const counts = summarizeKnowledgeIndexCounts([
      { indexStatus: 'failed', count: 2 },
      { indexStatus: 'failed', count: 5 },
    ]);

    expect(counts.failed).toBe(7);
    expect(counts.total).toBe(7);
  });

  it('refuses a state the check constraint does not allow', () => {
    expect(() => summarizeKnowledgeIndexCounts([{ indexStatus: 'parked', count: 1 }])).toThrow(
      /parked is not one of the four 0011 allows/u,
    );
  });

  it('refuses a count that is not a non-negative integer', () => {
    for (const count of [-1, 2.5, Number.NaN]) {
      expect(() => summarizeKnowledgeIndexCounts([{ indexStatus: 'failed', count }])).toThrow(
        /reported a count of/u,
      );
    }
  });
});

describe('isChunkIndexStatus', () => {
  it('accepts the four states 0011 allows, and nothing else', () => {
    for (const status of CHUNK_INDEX_STATUSES) {
      expect(isChunkIndexStatus(status)).toBe(true);
    }
    // Case and near-misses matter: the value arrives from a query string, where
    // `Indexed` is a typo a caller makes and a lower-casing layer would hide.
    for (const value of ['parked', 'Indexed', 'PENDING', '']) {
      expect(isChunkIndexStatus(value)).toBe(false);
    }
  });
});
