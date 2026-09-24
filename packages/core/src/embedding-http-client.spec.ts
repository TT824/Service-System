/**
 * The embedding HTTP port's one implementation, over a real socket.
 *
 * This is the only place in the repository that proves the outbound client
 * itself, and it does so against a loopback server rather than a stubbed
 * `fetch`: the three facts that matter here — that the body goes out as JSON,
 * that a non-JSON answer becomes `null` instead of an exception, and that the
 * deadline actually fires — are all facts about `fetch`'s behaviour under a
 * signal, and a stubbed `fetch` would be asserting the stub.
 *
 * The deadline case is the one worth having. `AbortController` plus
 * `clearTimeout` is a pattern that reads correctly and fails silently in both
 * directions: a missing `abort` leaves the request hanging for ever, and a
 * missing `clearTimeout` leaves a timer behind on every call. The server below
 * accepts the connection and never answers, which is the only way to tell a
 * deadline that works from one that was never reached.
 *
 * No database, no model server: this suite is a unit test and runs everywhere.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchEmbeddingHttpClient } from './embedding-http-client';

describe('FetchEmbeddingHttpClient', () => {
  const client = new FetchEmbeddingHttpClient();
  /** What the last request looked like, from the server's side of the socket. */
  let received: { method: string; contentType: string | undefined; body: string } | null = null;
  let baseUrl = '';
  let server: Server;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (part: string) => {
        body += part;
      });
      request.on('end', () => {
        received = {
          method: request.method ?? '',
          contentType: request.headers['content-type'],
          body,
        };
        if (request.url === '/stall') {
          // Deliberately never answered: the deadline case needs a server that
          // has accepted the request and then said nothing at all.
          return;
        }
        if (request.url === '/not-json') {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('the model server is warming up');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ embeddings: [[0.25, -0.5]] }));
      });
    });
    baseUrl = await listen(server);
  });

  afterAll(async () => {
    // A stalled request is still an open socket; without this the server would
    // wait for a connection that is only closed by the abort we are testing.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('posts a JSON body and returns the parsed answer with its status', async () => {
    const response = await client.post({
      url: `${baseUrl}/api/embed`,
      body: { model: 'm', input: '文案' },
      timeoutMs: 2_000,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ embeddings: [[0.25, -0.5]] });
    // The wire form is this client's business, so it is asserted here rather
    // than in every provider test: a method and a content type are what make a
    // model server read the body as JSON at all.
    expect(received?.method).toBe('POST');
    expect(received?.contentType).toBe('application/json');
    expect(JSON.parse(received?.body ?? '')).toEqual({ model: 'm', input: '文案' });
  });

  it('answers a body that is not JSON with null rather than an exception', async () => {
    const response = await client.post({
      url: `${baseUrl}/not-json`,
      body: {},
      timeoutMs: 2_000,
    });

    // `null` is a *value* here: the caller decides whether an unparseable answer
    // is a failure, and it can only do that if it is handed one.
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it('gives up at the deadline when the server never answers', async () => {
    const started = Date.now();
    await expect(
      client.post({ url: `${baseUrl}/stall`, body: {}, timeoutMs: 150 }),
    ).rejects.toThrow();
    const elapsed = Date.now() - started;

    // Both sides matter: too early would mean the port is refusing requests it
    // should make, and "it finished eventually" is exactly what a missing
    // `abort` looks like once the server is a real one.
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(2_000);
  });
});

/**
 * Start the server on an ephemeral loopback port.
 *
 * @param server - The server to listen with.
 * @returns The base URL it was bound to, without a trailing slash.
 */
function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('the test server did not bind a TCP port');
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
