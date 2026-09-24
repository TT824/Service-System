import { describe, expect, it, vi } from 'vitest';
import { JsonLogger } from '../logging/json-logger';
import { AssignmentScheduler } from './assignment-scheduler';
import type { AssignmentService, AssignmentSweepResult } from './assignment.service';

/** A sweep result that did nothing. */
const NOTHING: AssignmentSweepResult = {
  assigned: [],
  fellBack: [],
  waiting: [],
  lost: [],
  failed: [],
};

/**
 * Build a scheduler over a stub service.
 *
 * @param runOnce - The sweep the stub should perform.
 * @param logger - The logger to record into, defaulting to a silent one.
 * @returns The scheduler and the stub so a test can count its calls.
 */
function build(
  runOnce: () => Promise<AssignmentSweepResult> = async () => NOTHING,
  logger: JsonLogger = new JsonLogger('error'),
): { scheduler: AssignmentScheduler; sweep: ReturnType<typeof vi.fn> } {
  const sweep = vi.fn(runOnce);
  const service = { runOnce: sweep } as unknown as AssignmentService;
  return { scheduler: new AssignmentScheduler(service, logger), sweep };
}

describe('AssignmentScheduler', () => {
  it('starts out not running and sweeps nothing on its own', async () => {
    const { scheduler, sweep } = build();
    expect(scheduler.running).toBe(false);
    expect(sweep).not.toHaveBeenCalled();
    // `stop()` on a loop that never started must resolve rather than hang.
    await scheduler.stop();
  });

  it('runs a sweep on demand and reports what it did', async () => {
    const { scheduler, sweep } = build(async () => ({ ...NOTHING, assigned: ['c-1'] }));
    const result = await scheduler.runOnce('2026-09-14T10:00:00.000Z');
    expect(result.assigned).toEqual(['c-1']);
    expect(sweep).toHaveBeenCalledWith('2026-09-14T10:00:00.000Z', 20);
  });

  it('stops sweeping when the application shuts down', async () => {
    const { scheduler } = build();
    scheduler.start();
    expect(scheduler.running).toBe(true);
    await scheduler.onApplicationShutdown();
    expect(scheduler.running).toBe(false);
  });

  it('does not overlap two sweeps, and skips a manual one that arrives mid-sweep', async () => {
    const gate: { release: () => void } = { release: () => undefined };
    const blocking = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const { scheduler, sweep } = build(async () => {
      await blocking;
      return NOTHING;
    });
    const first = scheduler.runOnce();
    const skipped = await scheduler.runOnce();
    expect(skipped).toEqual(NOTHING);
    expect(sweep).toHaveBeenCalledTimes(1);
    gate.release();
    await first;
  });

  it('is idempotent: starting twice schedules one loop', async () => {
    const { scheduler, sweep } = build();
    scheduler.start();
    scheduler.start();
    await scheduler.stop();
    // One immediate sweep for the one loop that ran, not two.
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('logs an assigned batch, a fallback and a failed send at their own levels', async () => {
    const events: Array<{ level: string; event: string }> = [];
    const logger = {
      logStructured: (level: string, event: string) => {
        events.push({ level, event });
      },
    } as unknown as JsonLogger;
    const { scheduler } = build(
      async () => ({
        assigned: ['c-1'],
        fellBack: ['c-2'],
        waiting: [],
        lost: [],
        failed: ['c-3'],
      }),
      logger,
    );
    await scheduler.runOnce();
    expect(events).toEqual([
      { level: 'info', event: 'assigned pooled conversations' },
      { level: 'warn', event: 'no agent was available; sent the offline reply' },
      { level: 'error', event: 'could not hand an offline reply to the channel' },
    ]);
  });

  it('logs nothing for a sweep that only found parked conversations', async () => {
    const events: unknown[] = [];
    const logger = {
      logStructured: (...args: unknown[]) => {
        events.push(args);
      },
    } as unknown as JsonLogger;
    const { scheduler } = build(async () => ({ ...NOTHING, waiting: ['c-1', 'c-2'] }), logger);
    await scheduler.runOnce();
    expect(events).toEqual([]);
  });

  it('surfaces a failed manual sweep to its caller rather than swallowing it', async () => {
    const { scheduler } = build(async () => {
      throw new Error('database is unreachable');
    });
    await expect(scheduler.runOnce()).rejects.toThrow('database is unreachable');
  });

  it('keeps looping after a failed sweep, logging the failure by name only', async () => {
    const events: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
    const logger = {
      logStructured: (level: string, event: string, fields: Record<string, unknown>) => {
        events.push({ level, event, fields });
      },
    } as unknown as JsonLogger;
    let calls = 0;
    const { scheduler } = build(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('connect failed for postgres://user:secret@host/db');
      }
      return NOTHING;
    }, logger);

    scheduler.start();
    // Let the immediate first sweep fail and the loop reach its wait.
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    // `stop()` resolves promptly because it wakes the pending wait instead of
    // sleeping out the whole interval, which is also what makes this assertion
    // cheap.
    await scheduler.stop();

    expect(scheduler.running).toBe(false);
    expect(events[0]?.level).toBe('error');
    // The message a driver throws can carry a connection string, so only the
    // error's name is logged — never its text.
    expect(events[0]?.fields).toEqual({ error: 'Error' });
  });
});
