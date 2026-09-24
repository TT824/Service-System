import { describe, expect, it } from 'vitest';
import type { KnowledgeChunkRow } from './knowledge-indexer';
import {
  KNOWLEDGE_INDEX_MAX_ATTEMPTS,
  KNOWLEDGE_INDEX_RETRY_BASE_MS,
  KNOWLEDGE_INDEX_RETRY_MAX_MS,
  isChunkIndexDue,
  knowledgeIndexRetryDelayMs,
  planChunkWrite,
  planSourceChunkWrites,
  recordChunkIndexOutcome,
  resetsIndexState,
  type ChunkTextPlan,
  type StoredChunkState,
} from './knowledge-index-state';

/** One derived slice; only `id` and `contentHash` are read by the decision. */
function incomingChunk(id: string, contentHash: string): KnowledgeChunkRow {
  return {
    id,
    tenantId: 'tenant-acme',
    storeId: 'store-acme-flagship',
    scopeType: 'store',
    sourceKind: 'faq',
    sourceId: 'faq-1',
    sourceField: 'answer',
    chunkType: 'answer',
    chunkIndex: 0,
    content: '七天无理由退货',
    contextBefore: null,
    contextAfter: null,
    charCount: 7,
    enabled: true,
    contentHash,
    indexStatus: 'pending',
  };
}

/** One stored row; the status and the counter are the interesting parts. */
function storedChunk(overrides: Partial<StoredChunkState> = {}): StoredChunkState {
  return {
    id: 'kchunk-1',
    contentHash: 'hash-a',
    indexStatus: 'failed',
    indexAttempts: 1,
    updatedAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * The one shape a plan has when the text moved, whatever the stored row was:
 * `pending` with a zero budget. Named once because a plan whose values varied by
 * which branch produced it would be a plan two adapters could read differently.
 */
function resetPlan(): ChunkTextPlan {
  return {
    action: 'reindex',
    id: 'kchunk-1',
    indexStatus: 'pending',
    indexAttempts: 0,
    indexError: null,
    reason: 'the slice text moved since the last index, so its embedding is stale',
  };
}

describe('planChunkWrite', () => {
  it('inserts a slice the index has never seen with a budget nothing has spent', () => {
    const plan = planChunkWrite(incomingChunk('kchunk-1', 'hash-a'), null);
    expect(plan).toEqual({
      action: 'insert',
      id: 'kchunk-1',
      indexStatus: 'pending',
      indexAttempts: 0,
      indexError: null,
      reason: 'the slice is new to the index',
    });
  });

  it('rebuilds a slice whose text moved even though its id did not', () => {
    const plan = planChunkWrite(
      incomingChunk('kchunk-1', 'hash-b'),
      storedChunk({ indexStatus: 'indexed', indexAttempts: 1 }),
    );
    expect(plan).toEqual(resetPlan());
  });

  it('resets the attempt budget when the text moves, rather than carrying failures forward', () => {
    const plan = planChunkWrite(
      incomingChunk('kchunk-1', 'hash-b'),
      storedChunk({ indexStatus: 'failed', indexAttempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS }),
    );
    expect(plan).toEqual(resetPlan());
  });

  it('revives a parked slice whose text moved instead of leaving it parked', () => {
    // The branch order under test: comparing the status before the hash would
    // return `park` here, and a parked slice that was edited would stay parked
    // for ever — readable, searchable, and wrong.
    const plan = planChunkWrite(
      incomingChunk('kchunk-1', 'hash-b'),
      storedChunk({ indexStatus: 'skipped', indexAttempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS }),
    );
    expect(plan).toEqual(resetPlan());
  });

  it('leaves an indexed slice whose text did not move to itself, index columns included', () => {
    const plan = planChunkWrite(
      incomingChunk('kchunk-1', 'hash-a'),
      storedChunk({ indexStatus: 'indexed', indexAttempts: 2 }),
    );
    // Exact shape, not a few fields: this plan must not be able to carry an
    // index column at all. See the next test for why that is the assertion.
    expect(plan).toEqual({
      action: 'skip',
      id: 'kchunk-1',
      reason: 'the slice is already indexed and its text did not move',
    });
  });

  it('does not spend the budget of a slice no claim has taken', () => {
    // The failure this pins down, and the reason it is asserted as an absence:
    // the plan's only caller is the *source sweep*, which runs every few minutes
    // over every slice. When a plan carried a counter, each pass spent an attempt
    // no provider was asked about — a tenant imported in bulk hit the ceiling in
    // about twenty minutes, and every row in the table had `index_error` NULL.
    const plan = planChunkWrite(
      incomingChunk('kchunk-1', 'hash-a'),
      storedChunk({ indexStatus: 'failed', indexAttempts: 2 }),
    );
    expect(plan.action).toBe('queue');
    expect('indexAttempts' in plan).toBe(false);
    expect('indexStatus' in plan).toBe(false);
    expect('indexError' in plan).toBe(false);
    expect(plan.reason).toBe(
      'the slice is unindexed and still has attempts left, so a claim may take it',
    );
  });

  it('leaves a slice whose worker died after claiming it to the recovery, not to a bump', () => {
    // `pending` at the ceiling is either a dead worker's leavings or an attempt
    // running right now; only the claim can tell them apart (it is why
    // `parkExhausted` waits out the ceiling's delay), so the sweep reports the
    // row and writes nothing.
    const plan = planChunkWrite(
      incomingChunk('kchunk-1', 'hash-a'),
      storedChunk({ indexStatus: 'pending', indexAttempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS }),
    );
    expect(plan).toEqual({
      action: 'park',
      id: 'kchunk-1',
      reason: `the slice spent its ${KNOWLEDGE_INDEX_MAX_ATTEMPTS} index attempts`,
    });
  });

  it('parks a failed slice that spent its whole budget', () => {
    const plan = planChunkWrite(
      incomingChunk('kchunk-1', 'hash-a'),
      storedChunk({ indexStatus: 'failed', indexAttempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS }),
    );
    expect(plan.action).toBe('park');
    expect('indexAttempts' in plan).toBe(false);
    expect(plan.reason).toBe(`the slice spent its ${KNOWLEDGE_INDEX_MAX_ATTEMPTS} index attempts`);
  });

  it('re-parks a parked slice as a no-op rather than reporting it as merely indexed', () => {
    const plan = planChunkWrite(
      incomingChunk('kchunk-1', 'hash-a'),
      storedChunk({ indexStatus: 'skipped', indexAttempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS }),
    );
    expect(plan.action).toBe('park');
    expect(plan.reason).not.toBe('the slice is already indexed and its text did not move');
  });

  it('names exactly the two actions that write index state', () => {
    for (const action of ['queue', 'skip', 'park'] as const) {
      expect(resetsIndexState({ action, id: 'kchunk-1', reason: 'x' })).toBe(false);
    }
    for (const action of ['insert', 'reindex'] as const) {
      expect(
        resetsIndexState({
          action,
          id: 'kchunk-1',
          indexStatus: 'pending',
          indexAttempts: 0,
          indexError: null,
          reason: 'x',
        }),
      ).toBe(true);
    }
  });
});

describe('planSourceChunkWrites', () => {
  it('plans every incoming slice and orphans the stored rows it no longer produces', () => {
    const result = planSourceChunkWrites(
      [incomingChunk('kchunk-1', 'hash-a'), incomingChunk('kchunk-2', 'hash-a')],
      [storedChunk({ id: 'kchunk-1' }), storedChunk({ id: 'kchunk-9' })],
    );
    expect(result.plans.map((plan) => plan.id)).toEqual(['kchunk-1', 'kchunk-2']);
    expect(result.plans[1]?.action).toBe('insert');
    expect(result.stale).toEqual(['kchunk-9']);
  });

  it('reports staleness by id, so a field that both grew and shrank is two changes', () => {
    // A count comparison sees 2 in and 2 out and reports nothing to do; the
    // field actually lost `kchunk-2` and gained `kchunk-3`.
    const result = planSourceChunkWrites(
      [incomingChunk('kchunk-1', 'hash-a'), incomingChunk('kchunk-3', 'hash-a')],
      [
        storedChunk({ id: 'kchunk-1', indexStatus: 'indexed' }),
        storedChunk({ id: 'kchunk-2', indexStatus: 'indexed' }),
      ],
    );
    expect(result.stale).toEqual(['kchunk-2']);
    expect(result.plans.map((plan) => plan.action)).toEqual(['skip', 'insert']);
  });

  it('orphans every stored row when the source is emptied', () => {
    const result = planSourceChunkWrites([], [storedChunk({ id: 'kchunk-1' })]);
    expect(result.plans).toEqual([]);
    expect(result.stale).toEqual(['kchunk-1']);
  });
});

describe('knowledgeIndexRetryDelayMs', () => {
  it('waits for nothing before the first attempt', () => {
    expect(knowledgeIndexRetryDelayMs(0)).toBe(0);
    expect(knowledgeIndexRetryDelayMs(-3)).toBe(0);
  });

  it('backs off exponentially and stops at the ceiling', () => {
    expect(knowledgeIndexRetryDelayMs(1)).toBe(KNOWLEDGE_INDEX_RETRY_BASE_MS);
    expect(knowledgeIndexRetryDelayMs(2)).toBe(KNOWLEDGE_INDEX_RETRY_BASE_MS * 2);
    expect(knowledgeIndexRetryDelayMs(3)).toBe(KNOWLEDGE_INDEX_RETRY_BASE_MS * 4);
    expect(knowledgeIndexRetryDelayMs(999)).toBe(KNOWLEDGE_INDEX_RETRY_MAX_MS);
  });
});

describe('isChunkIndexDue', () => {
  const now = '2026-09-16T10:00:00.000Z';

  it('leaves a freshly failed slice alone until its backoff elapses, then allows it', () => {
    const state = storedChunk({ indexStatus: 'failed', indexAttempts: 1, updatedAt: now });
    expect(isChunkIndexDue(state, '2026-09-16T10:00:59.999Z')).toBe(false);
    expect(isChunkIndexDue(state, '2026-09-16T10:01:00.000Z')).toBe(true);
  });

  it('treats indexed and parked slices as terminal whatever the clock says', () => {
    const later = '2027-09-16T10:00:00.000Z';
    expect(isChunkIndexDue(storedChunk({ indexStatus: 'indexed' }), later)).toBe(false);
    expect(isChunkIndexDue(storedChunk({ indexStatus: 'skipped' }), later)).toBe(false);
  });

  it('never retries a slice that spent its budget, even mid-backoff', () => {
    expect(
      isChunkIndexDue(
        storedChunk({ indexStatus: 'failed', indexAttempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS }),
        '2027-09-16T10:00:00.000Z',
      ),
    ).toBe(false);
  });

  it('makes a never-attempted slice due immediately', () => {
    expect(
      isChunkIndexDue(
        storedChunk({ indexStatus: 'pending', indexAttempts: 0, updatedAt: now }),
        now,
      ),
    ).toBe(true);
  });
});

describe('recordChunkIndexOutcome', () => {
  const now = '2026-09-16T10:05:00.000Z';

  it('marks a claimed slice indexed and stamps the completion instant', () => {
    expect(recordChunkIndexOutcome(2, { ok: true }, now)).toEqual({
      indexStatus: 'indexed',
      indexAttempts: 2,
      indexError: null,
      indexedAt: now,
    });
  });

  it('records a failure without spending a second attempt for it', () => {
    // The claim already spent attempt 2; counting it here would park a slice
    // after three failures instead of five.
    expect(
      recordChunkIndexOutcome(2, { ok: false, code: 'provider_down', reason: 'provider 502' }, now),
    ).toEqual({
      indexStatus: 'failed',
      indexAttempts: 2,
      indexError: 'provider 502',
      indexedAt: null,
    });
  });

  it('parks the slice when the attempt that failed was the last of its budget', () => {
    const state = recordChunkIndexOutcome(
      KNOWLEDGE_INDEX_MAX_ATTEMPTS,
      { ok: false, code: 'provider_down', reason: 'provider 502' },
      now,
    );
    expect(state.indexStatus).toBe('skipped');
    expect(state.indexAttempts).toBe(KNOWLEDGE_INDEX_MAX_ATTEMPTS);
  });

  it('clears the previous error on a later success', () => {
    const state = recordChunkIndexOutcome(3, { ok: true }, now);
    expect(state.indexError).toBeNull();
  });
});

describe('the decision is a pure function of its arguments', () => {
  it('returns deeply equal plans for equal inputs', () => {
    const first = planChunkWrite(incomingChunk('kchunk-1', 'hash-a'), storedChunk());
    const second = planChunkWrite(incomingChunk('kchunk-1', 'hash-a'), storedChunk());
    expect(first).toEqual(second);
  });

  it('reads no clock of its own: only the stamped field follows `now`', () => {
    const early = recordChunkIndexOutcome(1, { ok: true }, '2026-01-01T00:00:00.000Z');
    const late = recordChunkIndexOutcome(1, { ok: true }, '2030-01-01T00:00:00.000Z');
    expect({ ...early, indexedAt: null }).toEqual({ ...late, indexedAt: null });
    expect(early.indexedAt).not.toBe(late.indexedAt);
  });
});
