import type { Server } from 'node:http';
import type { JsonLogger } from './logger';

type CloseableContext = {
  close(): Promise<void>;
};

type ShutdownOptions = {
  readonly healthServer: Server;
  readonly appContext: CloseableContext;
  readonly logger: Pick<JsonLogger, 'logStructured'>;
  readonly signal: string;
  readonly exit?: (code: number) => void;
  /**
   * Stop the worker's background work and wait for it to finish.
   *
   * Runs before anything is closed, because the outbox loop holds the only
   * resources that must not be pulled out from under it: a database pool and a
   * claim it has already taken. Stopping first lets the tick in flight write its
   * claim back, so a deploy does not leave an entry leased until its lease
   * expires. Optional, so a worker with no background work is unaffected.
   */
  readonly stopBackgroundWork?: () => Promise<void>;
};

/**
 * Stop background work, then close the health server, then the application
 * context.
 *
 * @param options - Worker resources and shutdown dependencies.
 */
export async function shutdownWorker(options: ShutdownOptions): Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let exitCode = 0;

  options.logger.logStructured(
    'info',
    `received ${options.signal}; shutting down`,
    {},
    'Bootstrap',
  );

  if (options.stopBackgroundWork !== undefined) {
    try {
      await options.stopBackgroundWork();
    } catch (error: unknown) {
      // Reported, not fatal: the process must still close its server and
      // context. A tick that could not be stopped leaves its claim to expire,
      // which is exactly what the lease is for.
      exitCode = 1;
      options.logger.logStructured(
        'error',
        'error while stopping worker background work',
        { error },
        'Bootstrap',
      );
    }
  }

  try {
    await closeServer(options.healthServer);
  } catch (error: unknown) {
    exitCode = 1;
    options.logger.logStructured(
      'error',
      'error while closing worker health server',
      { error },
      'Bootstrap',
    );
  }

  try {
    await options.appContext.close();
  } catch (error: unknown) {
    exitCode = 1;
    options.logger.logStructured(
      'error',
      'error while closing worker context',
      { error },
      'Bootstrap',
    );
  }

  options.logger.logStructured('info', 'worker stopped', {}, 'Bootstrap');
  exit(exitCode);
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
