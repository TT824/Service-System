/**
 * The index sweep with a real embedding model, against real PostgreSQL.
 *
 * Everything else about the sweep is settled without either: the tick's gate and
 * counter in `chunk-index-processor.spec.ts`, the claim and the write-back in
 * `chunk-index-postgres.integration.spec.ts`, the provider's request and its
 * classification of a model server's answers in
 * `ollama-embedding-provider.spec.ts`. What none of those can settle is the one
 * claim SDD-014 rests on: that a slice's text **really becomes a vector in the
 * table** — of the model's own width, under the model's own name, describing the
 * text it was computed from.
 *
 * Every assertion here is read back from the database or from the model server.
 * Nothing is inferred from a return value: a tick's counters would agree with a
 * bug that wrote nothing, which is exactly the shape of failure this suite is
 * here to catch.
 *
 * **The model server is a precondition, not a skip condition.** The suite skips
 * when no database is reachable, because a machine without PostgreSQL is an
 * expected development machine and every other durable suite behaves that way.
 * The embedding model is different: it is *this suite's subject*, and a run that
 * skipped because no model was up would be a green line that means nothing —
 * which is the failure mode this project has already been bitten by once (a suite
 * that skips cleanly when its dependency is absent reads exactly like a suite
 * that passed). So the model's absence is a **failing case** with the two
 * commands that fix it in the message.
 *
 * The second model in the "beside, not over" case is a double, and that is a fact
 * about this machine rather than a shortcut: it has exactly one embedding model
 * installed, and asking a generative model for embeddings is refused
 * (`qwen3:8b` answers HTTP 501). The vector that matters — the one the criteria
 * name — is real; the second one exists to prove the *address* keeps two models
 * apart, which is a property of the write path and not of the second model.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashChunkContent, parseAppConfig } from '@kefu/core';
import { WorkerDatabase } from '../database/worker-database';
import { ChunkIndexProcessor } from './chunk-index-processor';
import { FetchEmbeddingHttpClient } from '@kefu/core';
import type { EmbeddingProvider } from '@kefu/core';
import { OllamaEmbeddingProvider } from '@kefu/core';
import { PostgresChunkIndexRepository } from './postgres-chunk-index-repository';

const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** The model server the run embeds with, and the model it must report. */
const OLLAMA_URL = 'http://127.0.0.1:11434';
const MODEL = 'qwen3-embedding:0.6b';

/** The width the criteria name, from the model itself; see the probe below. */
const MODEL_DIMENSIONS = 1024;

/** Unique suffix isolating this run's rows from every other run's. */
const RUN = randomUUID().slice(0, 8);

/** The tick instant; the schedule is not what this suite is about. */
const NOW_MS = Date.parse('2026-09-17T06:00:00.000Z');
const NOW = new Date(NOW_MS).toISOString();

const ollama = probeOllama();

describe.skipIf(!reachable)('Index sweep with a real embedding model (PostgreSQL)', () => {
  let database: WorkerDatabase;
  let repository: PostgresChunkIndexRepository;
  /** Tenants this run created, removed in `afterAll` in foreign-key order. */
  const tenants: string[] = [];

  beforeAll(async () => {
    runDatabaseCommand('migrate', databaseUrl);
    database = new WorkerDatabase(databaseUrl);
    repository = new PostgresChunkIndexRepository(database);
  });

  afterAll(async () => {
    if (database !== undefined) {
      await cleanup();
      await database.close();
    }
  });

  it('runs against a reachable model server that has the configured model', () => {
    // The failure of this case is the whole suite's precondition, so it says what
    // to do rather than just going red: `ollama serve` and `ollama pull`.
    expect(
      ollama.reachable ? ollama.models : `the model server is not answering at ${OLLAMA_URL}`,
    ).toContain(MODEL);
  });

  it('embeds a slice into a real vector of the model width, under the model name', async () => {
    const tenantId = await createTenant('real');
    const content = '这款羽绒服是黑色的，填充物为90%白鸭绒，适合零下十度穿着。';
    // The row is seeded with the hash of its own text, computed by the kernel —
    // so "the vector's hash describes the text" is a comparison between two
    // things that were derived independently, not a constant agreeing with
    // itself.
    const chunkId = await seedChunk(tenantId, 'real', content);

    // No assertion about the tick's counters: the claim is platform-wide by
    // design, so `claimed` counts the whole table and not this case. Everything
    // below is read back from the rows this case owns.
    await processorWith(realProvider()).runOnce();

    const rows = await listEmbeddings(chunkId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.['embedding_model']).toBe(MODEL);
    // The width as pgvector itself reports it, not only as the column we wrote
    // alongside it says — the two are written together and could be wrong
    // together.
    expect(row?.['vector_dims']).toBe(MODEL_DIMENSIONS);
    expect(row?.['embedding_dimensions']).toBe(MODEL_DIMENSIONS);
    expect(row?.['content_hash']).toBe(hashChunkContent(content));

    const chunk = await readChunk(chunkId);
    expect(chunk['index_status']).toBe('indexed');
    expect(chunk['index_attempts']).toBe(1);
    expect(chunk['indexed_at']).not.toBeNull();
    expect(chunk['content_hash']).toBe(hashChunkContent(content));

    // A zero vector would satisfy every assertion above: it is 1024 wide, it
    // carries the right name, and it says nothing about the text. The model's
    // vectors are unit length, so the norm is what separates a vector from a
    // placeholder — and the spread rules out a constant repeated 1024 times.
    const vector = parseVector(row?.['embedding']);
    expect(vector).toHaveLength(MODEL_DIMENSIONS);
    expect(norm(vector)).toBeCloseTo(1, 5);
    expect(new Set(vector).size).toBeGreaterThan(100);
  });

  it('returns vectors that are about the text, not just vectors', async () => {
    // The premise of SDD-014 in one assertion: a paraphrase has to land nearer
    // than an unrelated sentence, or "semantic recall" is a table of random
    // numbers with a cosine operator on top.
    const provider = realProvider();
    const original = await provider.embed('这件羽绒服是黑色的');
    const paraphrase = await provider.embed('这件羽绒服的颜色为黑色');
    const unrelated = await provider.embed('这款手机支持六十六瓦快充');

    expect([original.ok, paraphrase.ok, unrelated.ok]).toEqual([true, true, true]);
    if (!original.ok || !paraphrase.ok || !unrelated.ok) {
      return;
    }

    expect(cosine(original.vector, paraphrase.vector)).toBeGreaterThan(
      cosine(original.vector, unrelated.vector),
    );
  });

  it('writes a second model beside the first and leaves the first byte for byte', async () => {
    const tenantId = await createTenant('second-model');
    const chunkId = await seedChunk(tenantId, 'second-model', '同一个切片，两个模型。');

    await processorWith(realProvider()).runOnce();
    const first = await listEmbeddings(chunkId);
    expect(first).toHaveLength(1);

    // Back to the state a re-index leaves a row in: pending, with its budget
    // whole. This is what `planChunkWrite`'s reindex branch writes when the text
    // moved, and it is the only way to ask for the same slice a second time —
    // `indexed` is terminal by design.
    await database.query(
      `UPDATE knowledge_chunks SET index_status = 'pending', index_attempts = 0,
         updated_at = $2 WHERE id = $1`,
      [chunkId, NOW],
    );

    // A double: see the suite note. What it proves is the address, and the width
    // it writes is deliberately different from the real model's, so a row that
    // carried the wrong dimensions could not pass as the other one.
    await processorWith(doubleProvider('embedding-double-v1', [0.25, -0.5])).runOnce();

    const rows = await listEmbeddings(chunkId);
    expect(rows.map((row) => row['embedding_model'])).toEqual(['embedding-double-v1', MODEL]);
    const [double, real] = rows;
    expect(real?.['embedding_dimensions']).toBe(MODEL_DIMENSIONS);
    expect(double?.['embedding_dimensions']).toBe(2);
    // The same text, so the same hash: two models describe one slice, and the
    // second did not overwrite the first's row.
    expect(real?.['content_hash']).toBe(double?.['content_hash']);
    expect(readText(real?.['embedding'])).toBe(readText(first[0]?.['embedding']));
  });

  it('records an unreachable model server against the slice instead of throwing', async () => {
    const tenantId = await createTenant('unreachable');
    const chunkId = await seedChunk(tenantId, 'unreachable', '模型服务没起。');

    // A real port that nothing is listening on, through the real outbound
    // client: the failure is a refused connection, and the deadline is what
    // bounds it if the platform answers with a drop instead.
    const provider = new OllamaEmbeddingProvider(new FetchEmbeddingHttpClient(), {
      baseUrl: 'http://127.0.0.1:1',
      model: MODEL,
      timeoutMs: 2_000,
    });
    const result = await processorWith(provider).runOnce();

    // Narrow, for the same reason as above: the counter counts the platform.
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const chunk = await readChunk(chunkId);
    expect(chunk['index_status']).toBe('failed');
    // The attempt was spent and is recorded: that is what makes the retry
    // schedule, rather than this suite, responsible for trying again.
    expect(chunk['index_attempts']).toBe(1);
    expect(String(chunk['index_error'])).toContain('could not be reached');
    expect(await listEmbeddings(chunkId)).toHaveLength(0);
  });

  /** One tick over the real repository, with the given provider. */
  function processorWith(provider: EmbeddingProvider): ChunkIndexProcessor {
    return new ChunkIndexProcessor(repository, provider, {
      batchSize: 10,
      pollIntervalMs: 60_000,
      now: () => NOW_MS,
    });
  }

  /** The real provider: the local model server, the real outbound client. */
  function realProvider(): OllamaEmbeddingProvider {
    return new OllamaEmbeddingProvider(new FetchEmbeddingHttpClient(), {
      baseUrl: OLLAMA_URL,
      model: MODEL,
      timeoutMs: 30_000,
    });
  }

  /** One tenant, unique to this run. */
  async function createTenant(label: string): Promise<string> {
    const tenantId = `tenant-ollama-${RUN}-${label}`;
    await database.query(
      'INSERT INTO tenants (id, code, name, enabled, created_at) VALUES ($1, $2, $3, TRUE, $4)',
      [tenantId, `ollama-${RUN}-${label}`, '真模型向量化测试租户', NOW],
    );
    tenants.push(tenantId);
    return tenantId;
  }

  /**
   * One pending slice, in the shape `PostgresChunkWriter` writes.
   *
   * Every column that writer sets is set here, including `content_hash`, which
   * is the kernel's own hash of the text — the row this suite indexes is the row
   * a real pass of `indexSourceInto` would have produced.
   */
  async function seedChunk(tenantId: string, label: string, content: string): Promise<string> {
    const chunkId = `kchunk-${tenantId}-${label}`;
    await database.query(
      `INSERT INTO knowledge_chunks (
         id, tenant_id, store_id, scope_type, source_kind, source_id, source_field, chunk_type,
         chunk_index, content, context_before, context_after, char_count, enabled, content_hash,
         index_status, index_attempts, index_error, indexed_at, created_at, updated_at)
       VALUES ($1, $2, NULL, 'tenant', 'faq', $3, 'answer', 'answer',
               0, $4, NULL, NULL, $5, TRUE, $6,
               'pending', 0, NULL, NULL, $7, $7)`,
      [
        chunkId,
        tenantId,
        `faq-ollama-${RUN}-${label}`,
        content,
        content.length,
        hashChunkContent(content),
        NOW,
      ],
    );
    return chunkId;
  }

  /** One slice's index columns, read back from the table. */
  async function readChunk(chunkId: string): Promise<Record<string, unknown>> {
    const rows = await database.rows(
      `SELECT id, content, content_hash, index_status, index_attempts, index_error, indexed_at
         FROM knowledge_chunks WHERE id = $1`,
      [chunkId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`the seeded slice ${chunkId} is not in the table`);
    }
    return row;
  }

  /** Every vector row under one slice, in model order. */
  async function listEmbeddings(chunkId: string): Promise<ReadonlyArray<Record<string, unknown>>> {
    const rows = await database.rows(
      `SELECT id, embedding_model, embedding_dimensions, vector_dims(embedding) AS vector_dims,
              embedding::text AS embedding, content_hash
         FROM knowledge_chunk_embeddings WHERE chunk_id = $1 ORDER BY embedding_model`,
      [chunkId],
    );
    return rows.map((row) => ({
      ...row,
      embedding_dimensions: Number(row['embedding_dimensions']),
      vector_dims: Number(row['vector_dims']),
    }));
  }

  /** Remove every row this run wrote, in foreign-key order. */
  async function cleanup(): Promise<void> {
    for (const tenantId of tenants) {
      await database.query('DELETE FROM knowledge_chunk_embeddings WHERE tenant_id = $1', [
        tenantId,
      ]);
      await database.query('DELETE FROM knowledge_chunk_keywords WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM knowledge_chunks WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
  }
});

/** A provider that is not a model server: a fixed name and a fixed vector. */
function doubleProvider(model: string, vector: ReadonlyArray<number>): EmbeddingProvider {
  return { model, embed: () => Promise.resolve({ ok: true, vector }) };
}

/** The vector out of the `embedding::text` form pgvector returns, e.g. `[1,2]`. */
function parseVector(value: unknown): ReadonlyArray<number> {
  if (typeof value !== 'string') {
    throw new Error(`the embedding column came back as ${typeof value}, not text`);
  }
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((part) => Number(part.trim()));
}

/** The `embedding::text` form of a stored vector, for a byte-for-byte comparison. */
function readText(value: unknown): string {
  return String(value);
}

/** Euclidean length of a vector. */
function norm(vector: ReadonlyArray<number>): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

/** Cosine similarity of two vectors; both are unit length here, so no division by zero. */
function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const dot = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
  return dot / (norm(a) * norm(b));
}

/** What the model server says about itself, probed once at collection time. */
type OllamaProbe =
  | { readonly reachable: true; readonly models: ReadonlyArray<string> }
  | { readonly reachable: false; readonly models: ReadonlyArray<string> };

/**
 * Ask the model server which models it has.
 *
 * Synchronous, and in a child process, for the same reason the database probe is:
 * the answer is needed while Vitest is collecting the file, so no hook has run
 * and nothing may be awaited. A bounded failure is the answer "not reachable" —
 * never a hang.
 *
 * @returns The model names, or an empty list when the server did not answer.
 */
function probeOllama(): OllamaProbe {
  try {
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        [
          `fetch('${OLLAMA_URL}/api/tags', { signal: AbortSignal.timeout(3000) })`,
          '  .then((response) => response.json())',
          '  .then((body) => { console.log(JSON.stringify((body.models || []).map((m) => m.name))); })',
          '  .catch(() => process.exit(1));',
        ].join('\n'),
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );
    return { reachable: true, models: JSON.parse(output) as string[] };
  } catch {
    return { reachable: false, models: [] };
  }
}

/** The database URL the suite runs against, resolved as the app resolves it. */
function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = parseAppConfig({ ...env, APP_ENV: 'test' });
  if (parsed._tag !== 'ok') {
    throw new Error(`test database configuration is invalid: ${parsed.error.message}`);
  }
  return parsed.config.databaseUrl.unwrap();
}

/** Drive one `database/scripts` entrypoint, exactly as a developer would. */
function runDatabaseCommand(command: 'migrate', url: string): void {
  execFileSync(
    process.execPath,
    [path.resolve(process.cwd(), 'database/scripts/migrate.cjs'), command],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    },
  );
}

/**
 * Probe the database with a bounded round trip.
 *
 * Synchronous on purpose: the suite has to decide `describe.skipIf(...)` while
 * Vitest collects it, before any hook has run.
 */
function isDatabaseReachable(url: string): boolean {
  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        [
          "const { Client } = require('pg');",
          'const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });',
          'client',
          '  .connect()',
          "  .then(() => client.query('SELECT 1'))",
          '  .then(() => client.end())',
          '  .then(() => process.exit(0))',
          '  .catch(() => process.exit(1));',
        ].join('\n'),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'ignore',
        timeout: 5_000,
      },
    );
    return true;
  } catch {
    return false;
  }
}
