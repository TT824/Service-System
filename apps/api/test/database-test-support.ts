import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import { parseAppConfig, tokenizeKnowledgeText } from '@kefu/core';

/**
 * Shared plumbing for database integration tests.
 *
 * Integration tests exercise the real PostgreSQL instance the platform targets:
 * the migration ledger, the tables the migrations declare and the constraints
 * that make tenant/member/store facts structural. They must never depend on a
 * hand-prepared database, so this module drives the same `database/scripts`
 * entrypoints a developer runs (`npm run db:migrate`, `npm run db:seed`, ...)
 * and lets a suite skip cleanly when no database is reachable.
 *
 * It also holds the one fixture that several suites would otherwise each spell
 * for themselves and get subtly wrong — {@link insertKnowledgeTerms}, the index
 * side of a seeded knowledge slice.
 *
 * Every path here is resolved from the repository root, which is the working
 * directory the root vitest configuration runs from.
 */

/** A `database/scripts` entrypoint an integration test may drive. */
export type DatabaseCommand = 'migrate' | 'rollback' | 'status' | 'seed' | 'check';

const COMMANDS: Record<
  DatabaseCommand,
  { readonly script: string; readonly args: readonly string[] }
> = {
  migrate: { script: 'database/scripts/migrate.cjs', args: ['migrate'] },
  rollback: { script: 'database/scripts/migrate.cjs', args: ['rollback'] },
  status: { script: 'database/scripts/migrate.cjs', args: ['status'] },
  seed: { script: 'database/scripts/seed.cjs', args: [] },
  check: { script: 'database/scripts/check.cjs', args: [] },
};

const MIGRATIONS_DIR = 'database/migrations';

/**
 * Resolve the database the tests should talk to.
 *
 * Uses the same parser the API composition root uses, so a test follows
 * `DATABASE_URL` when it is set and otherwise the documented local default.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @returns The connection string. Never printed by callers.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = parseAppConfig({ ...env, APP_ENV: 'test' });
  if (parsed._tag !== 'ok') {
    throw new Error(`test database configuration is invalid: ${parsed.error.message}`);
  }
  return parsed.config.databaseUrl.unwrap();
}

/**
 * Run one `database/scripts` command against `databaseUrl`.
 *
 * The URL is passed through the child environment, mirroring how a developer
 * runs the command; it is never part of the argument list or of any log line.
 *
 * @param command - Entry point to run.
 * @param databaseUrl - Database the command should use.
 * @returns The command's stdout.
 */
export function runDatabaseCommand(command: DatabaseCommand, databaseUrl: string): string {
  const entry = COMMANDS[command];
  const scriptPath = path.resolve(process.cwd(), entry.script);
  return execFileSync(process.execPath, [scriptPath, ...entry.args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
}

/** Read one migration file by name (`.up.sql` / `.down.sql`). */
export function readMigration(fileName: string): string {
  return readFileSync(path.resolve(process.cwd(), MIGRATIONS_DIR, fileName), 'utf8');
}

/** Child-process program that answers "is the database up?" with its exit code. */
const REACHABILITY_PROBE = [
  "const { Client } = require('pg');",
  'const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });',
  'client',
  '  .connect()',
  "  .then(() => client.query('SELECT 1'))",
  '  .then(() => client.end())',
  '  .then(() => process.exit(0))',
  '  .catch(() => process.exit(1));',
].join('\n');

/**
 * Probe the database with a bounded round trip.
 *
 * Synchronous on purpose: a suite must decide `describe.skipIf(...)` while
 * Vitest collects it, before any hook has run, so the round trip happens in a
 * short-lived child process. The connection string travels through the child
 * environment, never through its command line.
 *
 * @param databaseUrl - Database to probe.
 * @returns `true` when a connection was established and answered `SELECT 1`.
 */
export function isDatabaseReachable(databaseUrl: string): boolean {
  try {
    execFileSync(process.execPath, ['-e', REACHABILITY_PROBE], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Open a client for an integration test. Callers must close it. */
export async function openDatabaseClient(databaseUrl: string): Promise<Client> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 4_000,
    statement_timeout: 30_000,
  });
  await client.connect();
  return client;
}

/**
 * The one method the fixtures below need, so a `Pool` and a `Client` both fit —
 * a suite that seeds through its own pool and a suite that seeds through a
 * single client pass the same thing.
 */
export type QueryRunner = {
  query(sql: string, params: ReadonlyArray<unknown>): Promise<unknown>;
};

/**
 * Write the `0014` terms one seeded slice's text produces.
 *
 * A slice fixture is not complete without these, and the failure is quiet: the
 * keyword recall leg joins `knowledge_chunk_terms` and reads the term *columns*,
 * never `content`, so a slice seeded without terms is one that leg cannot answer
 * with — which looks exactly like a slice that was never written, and turns a
 * passing assertion into an empty answer rather than into an error. Every slice
 * fixture in this folder calls this function, so the index side of the leg is
 * spelled once instead of once per suite.
 *
 * The terms are derived with `@kefu/core`'s `tokenizeKnowledgeText` — the same
 * function the index writer runs over a slice's text on the way in — so a
 * fixture states what a slice's text is and the terms follow, as they do in
 * production. A fixture that spelled its own terms could pass against a
 * tokenizer no caller runs.
 *
 * @param runner - A `Pool` or a `Client` this run already holds.
 * @param tenantId - The slice's tenant, which the table is keyed by.
 * @param chunkId - The slice the terms belong to.
 * @param content - The slice's text, exactly as it was stored.
 */
export async function insertKnowledgeTerms(
  runner: QueryRunner,
  tenantId: string,
  chunkId: string,
  content: string,
): Promise<void> {
  // Counted rather than de-duplicated: `tf` is the frequency BM25 saturates on,
  // so a text that says a term three times is one row holding three.
  const counted = new Map<string, number>();
  for (const token of tokenizeKnowledgeText(content)) {
    counted.set(token, (counted.get(token) ?? 0) + 1);
  }
  if (counted.size === 0) {
    // A slice with no Chinese and no alphanumerics has no terms, and that is
    // what it deserves: the leg cannot recall it, and asking the database to
    // insert nothing is asking it to run a statement for no rows.
    return;
  }
  await runner.query(
    `INSERT INTO knowledge_chunk_terms (tenant_id, chunk_id, term, tf)
     SELECT $1, $2, t.term, t.tf
       FROM unnest($3::text[], $4::int[]) AS t(term, tf)`,
    [tenantId, chunkId, [...counted.keys()], [...counted.values()]],
  );
}
