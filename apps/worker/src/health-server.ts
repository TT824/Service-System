import { createServer, type Server, type ServerResponse } from 'node:http';

/** The health payload returned by every worker health endpoint. */
export type WorkerHealthPayload = {
  readonly status: 'ok' | 'unavailable';
  readonly service: 'worker';
};

/**
 * Create the worker health/readiness HTTP server.
 *
 * This is the worker's observable startup contract:
 *
 * - `GET /health/live`  - 200 while the process can answer HTTP requests.
 * - `GET /health/ready` - 200 once the worker is ready, 503 during shutdown.
 *
 * @param isReady - Returns `false` once graceful shutdown has started.
 * @returns The configured HTTP server.
 */
export function createHealthServer(isReady: () => boolean): Server {
  return createServer((req, res) => {
    const url = req.url ?? '/';

    if (req.method !== 'GET') {
      respondJson(res, 405, { error: 'method_not_allowed', path: url });
      return;
    }

    if (url === '/health/live') {
      respondJson(res, 200, { status: 'ok', service: 'worker' });
      return;
    }

    if (url === '/health/ready') {
      const ready = isReady();
      const payload: WorkerHealthPayload = {
        status: ready ? 'ok' : 'unavailable',
        service: 'worker',
      };
      respondJson(res, ready ? 200 : 503, payload);
      return;
    }

    respondJson(res, 404, { error: 'not_found', path: url });
  });
}

function respondJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
