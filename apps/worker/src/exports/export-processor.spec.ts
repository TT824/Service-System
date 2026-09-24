/**
 * The export loop, against a repository that answers by hand.
 *
 * What is worth pinning down here is not the rendering (that is
 * `export-artifacts.spec.ts`) but the *bookkeeping*: that a failing job is written
 * down as failed with a reason rather than left `running`, that one bad job does
 * not take the tick's other jobs with it, and that the abandoned are returned to
 * the queue before anything is claimed — three things whose failures are silent.
 * A job left `running` looks, on the console, exactly like a job that is still
 * working.
 */

import { describe, expect, it, vi } from 'vitest';
import { EXPORT_MESSAGE_LIMIT, type CustomerSummary } from '@kefu/core';
import { ExportProcessor } from './export-processor';
import type {
  ArtifactWrite,
  ClaimedExportJob,
  ExportJobRepository,
  ExportSource,
} from './export-job-repository';

const NOW = Date.parse('2026-09-22T02:30:00.000Z');

/** One claimed conversation job. */
function jobOf(overrides: Partial<ClaimedExportJob> = {}): ClaimedExportJob {
  return {
    id: 'export-9f3a1c02-aaaa',
    tenantId: 'tenant-acme',
    scope: 'conversation',
    label: '顾客「网页顾客-2LIX」的对话',
    createdAt: '2026-09-22T02:00:00.000Z',
    request: { scope: 'conversation', conversationId: 'conversation-1' },
    ...overrides,
  };
}

/** One conversation's source. */
function conversationSource(): ExportSource {
  return {
    scope: 'conversation',
    sections: [
      {
        heading: '网页顾客-2LIX · 企业微信',
        messages: [{ occurredAt: '2026-09-22T01:00:00.000Z', speaker: '顾客', content: '你好' }],
      },
    ],
  };
}

/** One customer row. */
function customerOf(): CustomerSummary {
  return {
    customerKey: 'wecom:wm-1',
    channel: 'wecom',
    externalCustomerId: 'wm-1',
    nickname: '网页顾客-2LIX',
    phone: null,
    wechat: 'wm-1',
    conversationCount: 1,
    lastMessageAt: '2026-09-22T01:00:00.000Z',
    lastConversationId: 'conversation-1',
  };
}

/** A repository that answers by hand and records what it was asked. */
class FakeRepository implements ExportJobRepository {
  readonly claims: Array<{ now: string; limit: number }> = [];
  readonly reclaims: Array<{ now: string; leaseMs: number }> = [];
  readonly successes: Array<{
    jobId: string;
    artifacts: ReadonlyArray<ArtifactWrite>;
    rowCount: number;
    now: string;
  }> = [];
  readonly failures: Array<{ jobId: string; error: string; now: string }> = [];
  /** Keyed by job id; a missing entry reads as "the conversation is gone". */
  sources = new Map<string, ExportSource>();

  constructor(
    private readonly jobs: ReadonlyArray<ClaimedExportJob>,
    private readonly reclaimed = 0,
  ) {}

  claimDue(now: string, limit: number): Promise<ReadonlyArray<ClaimedExportJob>> {
    this.claims.push({ now, limit });
    return Promise.resolve(this.jobs);
  }

  reclaimStale(now: string, leaseMs: number): Promise<number> {
    this.reclaims.push({ now, leaseMs });
    return Promise.resolve(this.reclaimed);
  }

  readSource(job: ClaimedExportJob): Promise<ExportSource | null> {
    const source = this.sources.get(job.id);
    return Promise.resolve(source === undefined ? null : source);
  }

  recordSuccess(
    jobId: string,
    artifacts: ReadonlyArray<ArtifactWrite>,
    rowCount: number,
    now: string,
  ): Promise<void> {
    this.successes.push({ jobId, artifacts, rowCount, now });
    return Promise.resolve();
  }

  recordFailure(jobId: string, error: string, now: string): Promise<void> {
    this.failures.push({ jobId, error, now });
    return Promise.resolve();
  }
}

/** A processor over a fake repository, with a frozen clock. */
function processorOver(repository: ExportJobRepository): ExportProcessor {
  return new ExportProcessor(repository, {
    batchSize: 5,
    pollIntervalMs: 1_000,
    leaseMs: 600_000,
    now: () => NOW,
  });
}

describe('a healthy tick', () => {
  it('claims, renders both files and records the row count', async () => {
    const repository = new FakeRepository([jobOf()]);
    repository.sources.set('export-9f3a1c02-aaaa', conversationSource());

    const tick = await processorOver(repository).runOnce();

    expect(tick).toEqual({ claimed: 1, succeeded: 1, failed: 0, reclaimed: 0 });
    expect(repository.successes).toHaveLength(1);
    const [success] = repository.successes;
    expect(success?.jobId).toBe('export-9f3a1c02-aaaa');
    expect(success?.rowCount).toBe(1);
    expect(success?.artifacts.map((artifact) => artifact.format)).toEqual(['xlsx', 'transcript']);
    expect(success?.now).toBe('2026-09-22T02:30:00.000Z');
    expect(repository.failures).toEqual([]);
  });

  it('returns the abandoned to the queue before it claims anything', async () => {
    // 顺序有意义：先回收再领，上一条命令归还的任务这一次就能被领走，而不是再等一轮。
    const repository = new FakeRepository([], 2);

    const tick = await processorOver(repository).runOnce();

    expect(tick.reclaimed).toBe(2);
    expect(repository.reclaims).toEqual([{ now: '2026-09-22T02:30:00.000Z', leaseMs: 600_000 }]);
    expect(repository.claims).toEqual([{ now: '2026-09-22T02:30:00.000Z', limit: 5 }]);
  });
});

describe('a job that fails', () => {
  it('writes the reason down instead of leaving it running', async () => {
    // 「进行中」和「永远不会有人再做」在控制台上长得一模一样，所以必须写成失败。
    const repository = new FakeRepository([jobOf()]);

    const tick = await processorOver(repository).runOnce();

    expect(tick).toEqual({ claimed: 1, succeeded: 0, failed: 1, reclaimed: 0 });
    expect(repository.failures).toEqual([
      { jobId: 'export-9f3a1c02-aaaa', error: '这条会话已经不存在了', now: '2026-09-22T02:30:00.000Z' },
    ]);
  });

  it('fails a job whose stored payload cannot be read', async () => {
    const repository = new FakeRepository([jobOf({ request: null })]);
    repository.sources.set('export-9f3a1c02-aaaa', conversationSource());

    await processorOver(repository).runOnce();

    expect(repository.failures[0]?.error).toContain('无法读取');
  });

  it('fails an over-cap export with the reason the cap names', async () => {
    const repository = new FakeRepository([jobOf()]);
    repository.sources.set('export-9f3a1c02-aaaa', {
      scope: 'conversation',
      sections: [
        {
          heading: 'x',
          messages: Array.from({ length: EXPORT_MESSAGE_LIMIT + 1 }, () => ({
            occurredAt: '2026-09-22T01:00:00.000Z',
            speaker: '顾客',
            content: 'x',
          })),
        },
      ],
    });

    await processorOver(repository).runOnce();

    expect(repository.successes).toEqual([]);
    expect(repository.failures[0]?.error).toContain(String(EXPORT_MESSAGE_LIMIT));
  });

  it('does not take the tick’s other jobs down with it', async () => {
    const repository = new FakeRepository([
      jobOf({ id: 'export-broken-0001' }),
      jobOf({ id: 'export-fine-0002' }),
    ]);
    repository.sources.set('export-fine-0002', { scope: 'customers', customers: [customerOf()] });

    const tick = await processorOver(repository).runOnce();

    expect(tick).toEqual({ claimed: 2, succeeded: 1, failed: 1, reclaimed: 0 });
    expect(repository.failures.map((failure) => failure.jobId)).toEqual(['export-broken-0001']);
    expect(repository.successes.map((success) => success.jobId)).toEqual(['export-fine-0002']);
  });

  it('records a customer export’s row count, not its file count', async () => {
    const repository = new FakeRepository([jobOf({ scope: 'customers' })]);
    repository.sources.set('export-9f3a1c02-aaaa', {
      scope: 'customers',
      customers: [customerOf(), customerOf()],
    });

    await processorOver(repository).runOnce();

    expect(repository.successes[0]?.rowCount).toBe(2);
  });
});

describe('the loop', () => {
  it('keeps polling after a tick fails', async () => {
    // 一次失败的 tick 什么都没领到，也就什么都没搁浅；停下来的话，一个暂时的数据库
    // 故障就会让这个进程再也不做导出。
    const repository = new FakeRepository([]);
    const failing = vi
      .spyOn(repository, 'reclaimStale')
      .mockRejectedValueOnce(new Error('the database is gone'));
    const logger = { logStructured: vi.fn() };
    const processor = new ExportProcessor(repository, {
      batchSize: 5,
      pollIntervalMs: 1,
      leaseMs: 600_000,
      now: () => NOW,
      logger,
    });

    processor.start();
    await vi.waitFor(() => {
      expect(repository.reclaims.length).toBeGreaterThan(1);
    });
    await processor.stop();

    expect(failing).toHaveBeenCalled();
    expect(logger.logStructured).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('tick failed'),
      expect.anything(),
      'ExportProcessor',
    );
  });

  it('stops without leaving a timer behind', async () => {
    const repository = new FakeRepository([]);
    const processor = processorOver(repository);

    processor.start();
    expect(processor.running).toBe(true);
    await processor.stop();
    expect(processor.running).toBe(false);
  });
});
