import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { shutdownWorker } from './shutdown';

describe('shutdownWorker', () => {
  it('closes the health server before the application context', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const events: string[] = [];
    const logger = {
      logStructured: (_level: string, message: string) => {
        events.push(message);
      },
    };
    const appContext = {
      close: async () => {
        events.push(`context:${server.listening ? 'open' : 'closed'}`);
      },
    };
    let exitCode: number | undefined;

    await shutdownWorker({
      healthServer: server,
      appContext,
      logger,
      signal: 'SIGTERM',
      exit: (code) => {
        exitCode = code;
      },
    });

    expect(events).toContain('context:closed');
    expect(exitCode).toBe(0);
  });

  it('records a health server close error and still closes the context', async () => {
    const events: string[] = [];
    const logger = {
      logStructured: (_level: string, message: string) => {
        events.push(message);
      },
    };
    let exitCode: number | undefined;

    await shutdownWorker({
      healthServer: createServer(),
      appContext: {
        close: async () => {
          events.push('context:closed');
        },
      },
      logger,
      signal: 'SIGINT',
      exit: (code) => {
        exitCode = code;
      },
    });

    expect(events).toContain('error while closing worker health server');
    expect(events).toContain('context:closed');
    expect(exitCode).toBe(1);
  });
});
