import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHealthServer, type WorkerHealthPayload } from './health-server';

type JsonResponse = {
  readonly status: number;
  readonly body: WorkerHealthPayload | { readonly error: string; readonly path: string };
};

const servers: Array<ReturnType<typeof createHealthServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function listen(server: ReturnType<typeof createHealthServer>): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function getJson(port: number, path: string, method = 'GET'): Promise<JsonResponse> {
  return new Promise<JsonResponse>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        agent: false,
        headers: { connection: 'close' },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body:
                raw.length > 0
                  ? (JSON.parse(raw) as JsonResponse['body'])
                  : { error: 'empty', path },
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('worker health server', () => {
  it('reports liveness regardless of readiness state', async () => {
    const server = createHealthServer(() => false);
    servers.push(server);
    const port = await listen(server);

    const response = await getJson(port, '/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'worker' });
  });

  it('reports ready only while the readiness callback returns true', async () => {
    let ready = true;
    const server = createHealthServer(() => ready);
    servers.push(server);
    const port = await listen(server);

    const readyResponse = await getJson(port, '/health/ready');
    expect(readyResponse.status).toBe(200);
    expect(readyResponse.body).toEqual({ status: 'ok', service: 'worker' });

    ready = false;
    const stoppingResponse = await getJson(port, '/health/ready');
    expect(stoppingResponse.status).toBe(503);
    expect(stoppingResponse.body).toEqual({ status: 'unavailable', service: 'worker' });
  });

  it('rejects unknown routes and non-GET methods', async () => {
    const server = createHealthServer(() => true);
    servers.push(server);
    const port = await listen(server);

    const unknown = await getJson(port, '/health/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: 'not_found' });

    const wrongMethod = await getJson(port, '/health/live', 'POST');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body).toMatchObject({ error: 'method_not_allowed' });
  });
});
