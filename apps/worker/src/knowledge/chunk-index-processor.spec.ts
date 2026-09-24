/**
 * What one tick of the index sweep does — with no database anywhere near it.
 *
 * The suite is built around the claims `chunk-index-processor` makes, because
 * every one of them is a decision a *shape* assertion cannot see and a green
 * end-to-end run cannot distinguish from its opposite:
 *
 * - **Without a provider, the tick does not claim.** The tempting failure is to
 *   read the gate as "skip the embedding step" and let the claim run: claiming
 *   spends an attempt, so five provider-less ticks park every pending slice in
 *   the table and write nothing to `index_error` to say why. Pinned here by
 *   asserting the repository was not touched at all — a claim that was made and
 *   discarded would still be a claim.
 * - **The claim's count is the one the write-back uses.** The kernel counts the
 *   attempt at the claim; incrementing again at the write-back parks a slice
 *   after three recorded failures instead of five, and nothing about the row
 *   looks wrong until someone counts. Pinned by asserting the exact counter
 *   handed to `recordChunkIndexOutcome` and to the store.
 * - **A vector is written exactly when the outcome is `indexed`.** The pair
 *   disagreeing is the quiet catastrophe of this layer: an `indexed` row with no
 *   vector under it is what retrieval searches for and never finds. Pinned for
 *   both directions (success carries one, every kind of failure carries none).
 * - **A provider that throws is a failed attempt, not a crashed tick.** The
 *   provider libraries this port will be implemented over throw; a tick that let
 *   the exception out would abandon the rest of the claimed batch, and the rows
 *   it had claimed would sit at the attempt count they were given.
 *
 * The write-back *guard* — that an outcome whose slice text moved is discarded
 * rather than applied — is asserted here only at the seam (a store that answers
 * `superseded` is reported and not counted as indexed). The guard itself is a
 * `WHERE` clause, and a `WHERE` clause is not evidence until a real database has
 * evaluated it; `chunk-index-postgres.integration.spec.ts` is where that happens.
 */

import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_INDEX_MAX_ATTEMPTS, deriveEmbeddingId } from '@kefu/core';
import type {
  ChunkIndexRepository,
  ChunkOutcomeRecord,
  ChunkOutcomeWrite,
  ClaimedChunk,
} from './chunk-index-repository';
import { ChunkIndexProcessor, type ChunkIndexLogger } from './chunk-index-processor';
import type { EmbeddingProvider, EmbeddingResult } from '@kefu/core';

/** The instant every case below runs at, unless it says otherwise. */
const NOW_MS = Date.parse('2026-09-17T02:30:00.000Z');
const NOW = new Date(NOW_MS).toISOString();

const TENANT = 'tenant-sweep';
const MODEL = 'test-embedding-v1';

describe('ChunkIndexProcessor without a provider', () => {
  it('claims nothing at all, so no attempt is spent', async () => {
    const store = fakeStore({ chunks: [chunk()] });

    const result = await build(store.repository, undefined).runOnce();

    // The gate is the whole point: not "the embedding step was skipped" but
    // "the repository was never asked". A claim that was made and thrown away
    // would have spent the attempt just the same.
    expect(store.calls).toEqual([]);
    expect(result).toEqual({
      claimed: 0,
      indexed: 0,
      failed: 0,
      parked: 0,
      recovered: 0,
      superseded: 0,
    });
  });

  it('reports whether it can index at all', () => {
    const store = fakeStore({ chunks: [] });
    expect(build(store.repository, undefined).providerConfigured).toBe(false);
    expect(build(store.repository, provider([0.5])).providerConfigured).toBe(true);
  });
});

describe('ChunkIndexProcessor with a provider', () => {
  it('recovers before it claims, both at the tick instant', async () => {
    const store = fakeStore({ chunks: [] });

    await build(store.repository, provider([0.5])).runOnce();

    expect(store.calls).toEqual([
      { kind: 'park', now: NOW },
      { kind: 'claim', now: NOW, limit: 7 },
    ]);
  });

  it('writes the claim’s post-claim count and a vector for a successful attempt', async () => {
    const claimed = chunk({ indexAttempts: 3, contentHash: 'hash-of-the-text' });
    const store = fakeStore({ chunks: [claimed] });

    const result = await build(store.repository, provider([0.5, -1.25])).runOnce();

    // The counter is the claim's, not the claim's plus one: 3 in, 3 written.
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.state).toEqual({
      indexStatus: 'indexed',
      indexAttempts: 3,
      indexError: null,
      indexedAt: NOW,
    });
    // The vector row is addressed by the model as well as the slice, and it
    // records the hash of the text that was embedded — not of whatever the row
    // holds by the time it lands.
    expect(store.writes[0]?.embedding).toEqual({
      id: deriveEmbeddingId(TENANT, claimed.id, MODEL),
      model: MODEL,
      vector: [0.5, -1.25],
      contentHash: 'hash-of-the-text',
    });
    expect(result.indexed).toBe(1);
    expect(result.claimed).toBe(1);
  });

  it('records a failed attempt with its reason and no vector, while the budget lasts', async () => {
    const store = fakeStore({ chunks: [chunk({ indexAttempts: 2 })] });

    const result = await build(
      store.repository,
      refusing({ ok: false, code: 'rate_limited', reason: 'the provider asked us to slow down' }),
    ).runOnce();

    expect(store.writes[0]?.state).toEqual({
      indexStatus: 'failed',
      indexAttempts: 2,
      indexError: 'the provider asked us to slow down',
      indexedAt: null,
    });
    expect(store.writes[0]?.embedding).toBeNull();
    expect(result.failed).toBe(1);
    expect(result.indexed).toBe(0);
  });

  it('parks the slice whose last attempt fails, and still writes no vector', async () => {
    const store = fakeStore({ chunks: [chunk({ indexAttempts: KNOWLEDGE_INDEX_MAX_ATTEMPTS })] });

    const result = await build(
      store.repository,
      refusing({ ok: false, code: 'timeout', reason: 'the provider timed out' }),
    ).runOnce();

    expect(store.writes[0]?.state.indexStatus).toBe('skipped');
    expect(store.writes[0]?.embedding).toBeNull();
    expect(result.parked).toBe(1);
  });

  it('treats a provider that throws as a failed attempt, naming the error but not its text', async () => {
    const store = fakeStore({ chunks: [chunk({ indexAttempts: 1 })] });
    const throwing: EmbeddingProvider = {
      model: MODEL,
      embed: () => Promise.reject(new Error('401 from https://api.example.com?key=sk-secret')),
    };

    const result = await build(store.repository, throwing).runOnce();

    expect(result.failed).toBe(1);
    const state = store.writes[0]?.state;
    expect(state?.indexStatus).toBe('failed');
    expect(state?.indexError).toContain('Error');
    // `index_error` is a column an operator reads: the provider's message can
    // carry a key, a prompt or a request body, and the name is all that is kept.
    expect(state?.indexError ?? '').not.toContain('sk-secret');
    expect(state?.indexError ?? '').not.toContain('api.example.com');
  });

  it('refuses an empty vector at the attempt, not at the constraint', async () => {
    const store = fakeStore({ chunks: [chunk({ indexAttempts: 1 })] });

    const result = await build(store.repository, provider([])).runOnce();

    // pgvector rejects a dimension-less value and `0011` checks
    // `embedding_dimensions > 0`; recording it as a failed attempt keeps the
    // slice retryable instead of failing the write the claim has already paid for.
    expect(result.failed).toBe(1);
    expect(store.writes[0]?.state.indexError).toBe(
      'the embedding provider returned a vector with no dimensions',
    );
    expect(store.writes[0]?.embedding).toBeNull();
  });

  it('reports an outcome the store refused as superseded, not as indexed', async () => {
    const store = fakeStore({ chunks: [chunk()], record: () => 'superseded' });

    const result = await build(store.repository, provider([0.5])).runOnce();

    expect(result.superseded).toBe(1);
    expect(result.indexed).toBe(0);
    expect(store.calls.some((call) => call.kind === 'record')).toBe(true);
  });

  it('keeps going when one write-back fails, because the claim was already spent either way', async () => {
    const store = fakeStore({
      chunks: [chunk({ id: 'kchunk-1' }), chunk({ id: 'kchunk-2' })],
      record: (write) => {
        if (write.chunk.id === 'kchunk-1') {
          throw new Error('the statement timed out');
        }
        return 'recorded';
      },
    });

    const result = await build(store.repository, provider([0.5])).runOnce();

    // One unwritable slice must not abandon the rest of the batch: the second
    // slice's attempt was spent too, and losing it would spend it for nothing.
    expect(store.writes.map((write) => write.chunk.id)).toEqual(['kchunk-1', 'kchunk-2']);
    expect(result.claimed).toBe(2);
    expect(result.indexed).toBe(1);
    // The failed write is counted nowhere: it produced no outcome, and the slice
    // is claimed again after its backoff.
    expect(result.failed).toBe(0);
  });

  it('keeps going when one slice’s attempt cannot be prepared at all', async () => {
    const store = fakeStore({
      chunks: [chunk({ id: 'kchunk-1' }), chunk({ id: 'kchunk-2' })],
      drain: true,
    });
    // A provider whose *identity* cannot be read: `model` addresses the vector row
    // and is read once per slice, outside the provider call the tick already
    // guards. The first read is the failure and the second succeeds, so the two
    // slices differ in exactly the way this case is about.
    let reads = 0;
    const flakyIdentity: EmbeddingProvider = {
      get model(): string {
        reads += 1;
        if (reads === 1) {
          throw new Error('the model name could not be resolved');
        }
        return MODEL;
      },
      embed: () => Promise.resolve({ ok: true, vector: [0.5] }),
    };
    const logged: string[] = [];

    const result = await build(store.repository, flakyIdentity, {
      logger: { logStructured: (_level, message) => void logged.push(message) },
    }).runOnce();

    // The claim spent *both* slices' attempts, so dropping the batch on the first
    // failure would spend the second one for nothing. It is attempted, indexed,
    // and its vector row is addressed by the model as usual.
    expect(store.writes.map((write) => write.chunk.id)).toEqual(['kchunk-2']);
    expect(store.writes[0]?.embedding).toMatchObject({ model: MODEL, vector: [0.5] });
    expect(result).toMatchObject({ claimed: 2, indexed: 1 });
    // The slice that could not be prepared is counted nowhere and is not silent.
    expect(result.failed + result.parked + result.superseded).toBe(0);
    expect(logged).toContain(
      'could not prepare an index attempt; the slice keeps the attempt it spent',
    );
  });
});

/**
 * The loop around the tick — what the Worker process actually runs.
 *
 * Each case here is a way the *process* fails that no assertion about a single
 * tick can see, and none of them is visible in a green end-to-end run either:
 * two ticks in flight spend two attempts on one slice and call the provider twice
 * for the same text; a loop that ends on a transient statement failure stops
 * indexing until someone restarts the process; a `stop` that waits out a whole
 * poll interval reads as a hung deploy.
 */
describe('ChunkIndexProcessor loop', () => {
  it('does not run two ticks at once', async () => {
    const store = fakeStore({ chunks: [chunk()], drain: true });
    const processor = build(store.repository, provider([0.5]));

    const [first, second] = await Promise.all([processor.runOnce(), processor.runOnce()]);

    // The second call answers with the empty tick rather than entering the claim.
    // A claim entered twice is an attempt spent twice, and the provider called
    // twice for one slice's text.
    expect(store.calls.filter((call) => call.kind === 'claim')).toHaveLength(1);
    expect(store.writes).toHaveLength(1);
    expect(first.claimed).toBe(1);
    expect(second).toEqual({
      claimed: 0,
      indexed: 0,
      failed: 0,
      parked: 0,
      recovered: 0,
      superseded: 0,
    });
  });

  it('polls until it is stopped, and stops without leaving a tick in flight', async () => {
    const store = fakeStore({ chunks: [chunk({ id: 'kchunk-loop' })], drain: true });
    const processor = build(store.repository, provider([0.5]), { pollIntervalMs: 1 });

    expect(processor.running).toBe(false);
    processor.start();
    expect(processor.running).toBe(true);

    await waitUntil(() => store.writes.length > 0);
    await processor.stop();

    expect(processor.running).toBe(false);
    expect(store.writes[0]?.state.indexStatus).toBe('indexed');
    // The loop came back after the first tick: a claim that ran once and stopped
    // is the "the Worker indexed one slice and exited" failure, and from the
    // outside it looks exactly like a healthy first tick.
    expect(store.calls.filter((call) => call.kind === 'park').length).toBeGreaterThan(1);
  });

  it('stops a loop that is idle between polls', async () => {
    const store = fakeStore({ chunks: [] });
    // A long poll interval: stopping must end the wait rather than block on it,
    // or every shutdown takes a whole interval and a deploy looks stuck.
    const processor = build(store.repository, provider([0.5]), { pollIntervalMs: 60_000 });

    processor.start();
    await waitUntil(() => store.calls.some((call) => call.kind === 'claim'));
    // Let the first tick finish, so the loop is certainly inside its inter-poll
    // wait. A `stop` that lands during a tick returns as soon as that tick ends,
    // which is the ordinary path and would prove nothing about the wait.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stoppedAt = Date.now();
    await processor.stop();

    expect(processor.running).toBe(false);
    // The wait was ended, not awaited. With a 60-second interval, a `stop` that
    // did not wake the loop would still be sitting here when the case's own
    // timeout fired — and it would be a shutdown that hangs for an interval.
    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
  });

  it('stops the loop it found when a restart lands during the stop', async () => {
    // The tick is held inside the provider, which is the window a `start()` can
    // land in: `stop()` has made `#running` false and is waiting on the loop.
    const gated = gatedProvider([0.5]);
    const store = fakeStore({ chunks: [chunk({ id: 'kchunk-restart' })], drain: true });
    const processor = build(store.repository, gated.provider, { pollIntervalMs: 1 });

    processor.start();
    await gated.entered;

    const stopping = processor.stop();
    processor.start();
    gated.release();

    // The stop returns for the loop it found. A loop that only ever asked
    // `#running` reads the restart as "keep going", stays alive beside its
    // replacement, and leaves this await — and the shutdown behind it — waiting
    // for ever. The race is what makes that a failed assertion rather than a
    // case that hangs: a red here names the interleaving, not the timeout.
    const settled = await Promise.race([
      stopping.then(() => 'stopped' as const),
      new Promise<'still-waiting'>((resolve) => {
        setTimeout(() => resolve('still-waiting'), 1_000);
      }),
    ]);
    expect(settled).toBe('stopped');

    // The restart was served, not ignored: the loop it started is polling, and
    // the handle `stop()` left behind still points at it.
    expect(processor.running).toBe(true);
    const claims = (): number => store.calls.filter((call) => call.kind === 'claim').length;
    const afterStop = claims();
    await waitUntil(() => claims() > afterStop);

    await processor.stop();
    expect(processor.running).toBe(false);
  });

  it('keeps polling after a tick fails, and reports it', async () => {
    const store = fakeStore({ chunks: [chunk()], drain: true });
    let claims = 0;
    const flaky: ChunkIndexRepository = {
      ...store.repository,
      claimDue: (now, limit) => {
        claims += 1;
        return claims === 1
          ? Promise.reject(new Error('the claim statement failed'))
          : store.repository.claimDue(now, limit);
      },
    };
    const logged: string[] = [];
    const processor = build(flaky, provider([0.5]), {
      pollIntervalMs: 1,
      logger: { logStructured: (_level, message) => void logged.push(message) },
    });

    processor.start();
    await waitUntil(() => store.writes.length > 0);
    await processor.stop();

    // One failed statement is not the end of the sweep, and it is not silence
    // either: a loop that swallowed it would be a Worker that looks healthy while
    // indexing nothing.
    expect(claims).toBeGreaterThan(1);
    expect(store.writes).toHaveLength(1);
    expect(logged).toContain('index sweep tick failed; retrying after the poll interval');
  });

  it('runs without claiming anything while no provider is configured', async () => {
    const store = fakeStore({ chunks: [chunk()] });
    const processor = build(store.repository, undefined, { pollIntervalMs: 1 });

    processor.start();
    // The loop is given time to poll more than once: the claim is that it keeps
    // *running* while claiming nothing, not that it is never entered.
    //
    // What this case cannot see is whether a tick was really entered — the gate
    // returns before the first statement, so a loop that never ran leaves the
    // same trace in the store. `running` is the only evidence here, and the three
    // cases above carry the claim that the loop actually ticks.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await processor.stop();

    expect(processor.running).toBe(false);
    expect(store.calls).toEqual([]);
  });
});

/** Wait until a condition holds, or fail the case rather than hang the suite. */
async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the condition this case asserts');
}

/** The processor under test, with a controlled clock and no logging. */
function build(
  repository: ChunkIndexRepository,
  embeddingProvider: EmbeddingProvider | undefined,
  options: { readonly pollIntervalMs?: number; readonly logger?: ChunkIndexLogger } = {},
): ChunkIndexProcessor {
  return new ChunkIndexProcessor(repository, embeddingProvider, {
    batchSize: 7,
    // A case that never starts the loop does not care, and the ones that do say
    // what they need; the default is short so a poll is not a test's timeout.
    pollIntervalMs: options.pollIntervalMs ?? 1,
    now: () => NOW_MS,
    // Spread rather than assigned: `exactOptionalPropertyTypes` distinguishes
    // "no logger" from "a logger that is undefined", and this fixture means the
    // former.
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

/** One claimed slice, with an id and fields a case can override. */
function chunk(overrides: Partial<ClaimedChunk> = {}): ClaimedChunk {
  return {
    id: 'kchunk-claimed',
    tenantId: TENANT,
    content: '加绒卫衣建议手洗。',
    contentHash: 'hash-of-the-text',
    indexAttempts: 1,
    ...overrides,
  };
}

/** A provider that returns one fixed vector for every call. */
function provider(vector: ReadonlyArray<number>): EmbeddingProvider {
  return { model: MODEL, embed: () => Promise.resolve({ ok: true, vector }) };
}

/**
 * A provider that holds its answer until the case releases it.
 *
 * The gate exists for the stop/restart case, which needs a tick that is *in
 * flight* while `stop()` runs. {@link provider} answers in a microtask, so a
 * tick built on it is over before a case could interleave anything with it.
 */
function gatedProvider(vector: ReadonlyArray<number>): {
  readonly provider: EmbeddingProvider;
  readonly entered: Promise<void>;
  readonly release: () => void;
} {
  let markEntered = (): void => undefined;
  let openGate = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return {
    provider: {
      model: MODEL,
      embed: async () => {
        markEntered();
        await gate;
        return { ok: true, vector };
      },
    },
    entered,
    release: openGate,
  };
}

/** A provider that refuses every call with one fixed failure. */
function refusing(result: EmbeddingResult): EmbeddingProvider {
  return { model: MODEL, embed: () => Promise.resolve(result) };
}

/** What the sweep asked the store to do, in order. */
type StoreCall =
  | { readonly kind: 'park'; readonly now: string }
  | { readonly kind: 'claim'; readonly now: string; readonly limit: number }
  | { readonly kind: 'record'; readonly chunkId: string };

/** A recording stand-in for {@link ChunkIndexRepository}. */
function fakeStore(options: {
  readonly chunks: ReadonlyArray<ClaimedChunk>;
  readonly record?: (write: ChunkOutcomeWrite) => ChunkOutcomeRecord;
  /**
   * Hand each slice out once, instead of on every claim.
   *
   * A loop ticks more than once by definition, and a store that answers every
   * claim with the same slice would have a two-tick loop index it twice — a fact
   * about the stand-in, not about the loop. Cases that run the loop drain.
   */
  readonly drain?: boolean;
}): {
  readonly repository: ChunkIndexRepository;
  readonly calls: StoreCall[];
  readonly writes: ChunkOutcomeWrite[];
} {
  const calls: StoreCall[] = [];
  const writes: ChunkOutcomeWrite[] = [];
  const pending = [...options.chunks];
  return {
    calls,
    writes,
    repository: {
      claimDue: (now, limit) => {
        calls.push({ kind: 'claim', now, limit });
        if (options.drain === true) {
          return Promise.resolve(pending.splice(0, limit));
        }
        return Promise.resolve(options.chunks);
      },
      parkExhausted: (now) => {
        calls.push({ kind: 'park', now });
        return Promise.resolve(0);
      },
      recordOutcome: (write) => {
        calls.push({ kind: 'record', chunkId: write.chunk.id });
        writes.push(write);
        return Promise.resolve(options.record?.(write) ?? 'recorded');
      },
    },
  };
}
