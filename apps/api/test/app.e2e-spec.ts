import 'reflect-metadata';
import { Controller, Get, HttpException, HttpStatus, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isTrustedRequestId, parseAppConfig, REQUEST_ID_HEADER } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';

/** Test-only controller that forces an unexpected server error. */
@Controller('test-only')
class BoomController {
  /** @throws Always throws so the global filter can be observed. */
  @Get('boom')
  boom(): never {
    throw new Error('boom secret value that must never reach the client');
  }

  /** @throws An HTTP exception containing values that must be projected safely. */
  @Get('http-secret')
  httpSecret(): never {
    throw new HttpException(
      {
        code: 'bad_request',
        message: 'postgres://user:password@db.internal/kefu token=secret-token',
        details: { connectionString: 'redis://user:password@redis.internal:6379' },
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Interface tests for the SDD-002 API baseline.
 *
 * These tests boot the real Nest application in-process and drive it over HTTP
 * with `supertest`, so they exercise the versioned prefix, request id
 * middleware, global error filter and response envelope without external
 * infrastructure.
 */
describe('API baseline (interface)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
      controllers: [BoomController],
    }).compile();

    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);
  });

  afterAll(async () => {
    // Force idle sockets closed so the HTTP server shuts down deterministically
    // rather than waiting on a connection some earlier probe left idle.
    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  it('exposes liveness under the versioned prefix with a stable envelope', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('X-Request-ID', 'client-trace-1')
      .expect(200);

    expect(response.headers[REQUEST_ID_HEADER]).toBe('client-trace-1');
    expect(response.body).toEqual({
      request_id: 'client-trace-1',
      data: { status: 'ok', service: 'api' },
      meta: {},
    });
  });

  it('exposes readiness under the versioned prefix', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/ready');
    expect([200, 503]).toContain(response.status);
    expect(response.body.data.status).toMatch(/^(ok|unavailable)$/);
    expect(response.body.data.service).toBe('api');
    expect(response.body.request_id).toBe(response.headers[REQUEST_ID_HEADER]);
  });

  it('generates a request id when the client sends none and returns it in the body', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    const headerId = response.headers[REQUEST_ID_HEADER];
    if (typeof headerId !== 'string') {
      throw new Error('API did not return a request id header');
    }
    expect(response.body.request_id).toBe(headerId);
    expect(isTrustedRequestId(headerId)).toBe(true);
  });

  it('replaces an untrusted incoming request id instead of echoing it', async () => {
    // A 65-character id is printable (so the HTTP client can send it) but
    // exceeds the documented 64-character limit, so the middleware must
    // discard it and generate a fresh id.
    const tooLongId = 'a'.repeat(65);
    const response = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('X-Request-ID', tooLongId)
      .expect(200);

    const headerId = response.headers[REQUEST_ID_HEADER];
    if (typeof headerId !== 'string') {
      throw new Error('API did not return a request id header');
    }
    expect(headerId).not.toBe(tooLongId);
    expect(headerId.length).toBeLessThanOrEqual(64);
    expect(isTrustedRequestId(headerId)).toBe(true);
    expect(response.body.request_id).toBe(headerId);
  });

  it('correlates structured request logs with the request id', async () => {
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });

    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .set('X-Request-ID', 'log-trace-1')
        .expect(200);
      expect(response.headers[REQUEST_ID_HEADER]).toBe('log-trace-1');
    } finally {
      write.mockRestore();
    }

    const completedLogs = chunks
      .map((chunk) => {
        try {
          return JSON.parse(chunk) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((record): record is Record<string, unknown> => record !== null)
      .filter((record) => record['msg'] === 'request completed');

    expect(completedLogs.length).toBeGreaterThan(0);
    expect(completedLogs.some((record) => record['requestId'] === 'log-trace-1')).toBe(true);
  });

  it('returns the documented stable error body for unknown routes', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/does-not-exist')
      .set('X-Request-ID', 'error-trace-1')
      .expect(404);

    expect(response.headers[REQUEST_ID_HEADER]).toBe('error-trace-1');
    expect(Object.keys(response.body).sort()).toEqual(['code', 'details', 'message', 'request_id']);
    expect(response.body).toMatchObject({
      request_id: 'error-trace-1',
      code: 'not_found',
      details: [],
    });
    expect(JSON.stringify(response.body)).not.toContain('at ');
  });

  it('does not leak unexpected error messages or stack traces to the client', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test-only/boom')
      .set('X-Request-ID', 'error-trace-2')
      .expect(500);

    expect(response.body).toMatchObject({
      request_id: 'error-trace-2',
      code: 'internal_error',
      message: 'Internal Server Error',
      details: [],
    });
    expect(JSON.stringify(response.body)).not.toContain('boom secret');
    expect(JSON.stringify(response.body)).not.toContain('at ');
  });

  it('projects HttpException messages and details into the stable safe contract', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test-only/http-secret')
      .set('X-Request-ID', 'error-trace-3')
      .expect(400);

    expect(response.body).toEqual({
      request_id: 'error-trace-3',
      code: 'bad_request',
      message: 'Bad Request',
      details: [],
    });
    expect(JSON.stringify(response.body)).not.toContain('postgres://');
    expect(JSON.stringify(response.body)).not.toContain('secret-token');
  });
});
