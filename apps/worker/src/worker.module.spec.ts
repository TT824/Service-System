/**
 * The Worker's composition root: what it binds, and what it leaves unstarted.
 *
 * This is the only way "the wiring is right" can be settled without booting a
 * process, and it is a different claim from "the pieces work": a module that
 * forgot a provider, or bound the sweep to the outbox's repository, still
 * typechecks — Nest resolves its graph at runtime, so a broken graph is a
 * production startup failure and nothing earlier. The case therefore builds the
 * same application context `main.ts` builds and resolves every loop out of it.
 *
 * Two facts go with it, and both are decisions rather than incidental shape:
 * no loop is started by composition (a Nest context created by a test must not
 * poll a real database), and the embedding provider resolves to `undefined`
 * — the value the sweep's gate is written against. A stub bound here instead
 * would spend an attempt on every pending slice and park the table, which is the
 * opposite outcome from the same "no model is configured".
 *
 * No database is reached: `WorkerDatabase` opens its pool lazily and the context
 * is closed before the case ends.
 */

import 'reflect-metadata';
import { type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { parseAppConfig, type AppConfig } from '@kefu/core';
import { ExportProcessor } from './exports/export-processor';
import { ChunkIndexProcessor } from './knowledge/chunk-index-processor';
import type { EmbeddingProvider } from '@kefu/core';
import { OutboxProcessor } from './outbox/outbox-processor';
import { EMBEDDING_PROVIDER, EXPORT_JOB_REPOSITORY, WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('resolves every loop, and starts none of them', async () => {
    const app = await buildWorker();
    try {
      expect(app.get(OutboxProcessor).running).toBe(false);
      expect(app.get(ChunkIndexProcessor).running).toBe(false);
      expect(app.get(ExportProcessor).running).toBe(false);

      app.get(OutboxProcessor).start();
      // Starting is the entry point's decision, and it is not delegated to the
      // module: a context built by a test would otherwise poll a real database
      // for the life of the suite. The export loop is the one that would also
      // *render files* while doing it.
      expect(app.get(ChunkIndexProcessor).running).toBe(false);
      expect(app.get(ExportProcessor).running).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('binds the export loop to a real repository, not to the outbox’s', async () => {
    // 四张队列表都在同一个库里，接错也只是「领不到东西」——那和「队列是空的」在
    // 运行时长出来一模一样。
    const app = await buildWorker();
    try {
      const repository = app.get(EXPORT_JOB_REPOSITORY) as { claimDue?: unknown };
      expect(typeof repository.claimDue).toBe('function');
      expect(repository.constructor.name).toBe('PostgresExportJobRepository');
    } finally {
      await app.close();
    }
  });

  it('binds the sweep to no embedding provider, so it is gated rather than stubbed', async () => {
    const app = await buildWorker();
    try {
      expect(app.get(ChunkIndexProcessor).providerConfigured).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('binds a real provider once the configuration names a model', async () => {
    // The other half of the gate: "no provider" has to be a reading of the
    // configuration rather than a constant, or the day a model is configured the
    // sweep would still claim nothing — the same green, one deployment later.
    const app = await buildWorker({
      EMBEDDING_BASE_URL: 'http://127.0.0.1:11434',
      EMBEDDING_MODEL: 'qwen3-embedding:0.6b',
    });
    try {
      expect(app.get(ChunkIndexProcessor).providerConfigured).toBe(true);
      expect(app.get<EmbeddingProvider>(EMBEDDING_PROVIDER)?.model).toBe('qwen3-embedding:0.6b');
    } finally {
      // No request is made by construction or by closing the context.
      await app.close();
    }
  });

  it.each([
    ['a base URL with no model', { EMBEDDING_BASE_URL: 'http://127.0.0.1:11434' }],
    ['a model with no base URL', { EMBEDDING_MODEL: 'qwen3-embedding:0.6b' }],
  ])('refuses to bind a half-configured provider (%s)', async (_label, env) => {
    // Not a boot failure outside production — but not a provider either: one
    // would send nothing, the other would address every vector row by an empty
    // name.
    const app = await buildWorker(env);
    try {
      expect(app.get<EmbeddingProvider | undefined>(EMBEDDING_PROVIDER)).toBeUndefined();
      expect(app.get(ChunkIndexProcessor).providerConfigured).toBe(false);
    } finally {
      await app.close();
    }
  });
});

/** The worker application context, exactly as the entry point builds it. */
function buildWorker(env: Record<string, string> = {}): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(WorkerModule.forRoot(configOf(env)), {
    logger: false,
  });
}

/** A parseable configuration, failing loudly when the fixture is wrong. */
function configOf(env: Record<string, string> = {}): AppConfig {
  // No `.env` and no database: `test` is the environment whose required variables
  // have documented defaults, which is what makes this case hermetic. The
  // embedding pair is one of those defaults — empty — which is the configuration
  // the gate is asserted against.
  const parsed = parseAppConfig({ APP_ENV: 'test', ...env });
  if (parsed._tag !== 'ok') {
    throw new Error(`fixture configuration is invalid: ${parsed.error.message}`);
  }
  return parsed.config;
}
