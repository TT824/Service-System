'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Repeatable schema smoke check for the kefu-saas database.
 *
 * Verifies that a reachable PostgreSQL database matches what the migrations in
 * `database/migrations` expect:
 *
 *   - the `vector` (pgvector) extension enabled by migration `0001`;
 *   - the `schema_migrations` ledger the migration runner maintains;
 *   - every table the `.up.sql` migrations create.
 *
 * The check is read-only and idempotent: it issues only `SELECT` statements and
 * is safe to run against an already-migrated database (it never creates or
 * alters schema). The connection string is never printed.
 *
 * Usage (from the repository root):
 *   npm run db:check
 *
 * The runner reads DATABASE_URL from the repository `.env` when present, or
 * from the process environment, exactly like `scripts/migrate.cjs`.
 */

const fs = require('node:fs');
const path = require('node:path');

const { Client } = require('pg');

const dotenv = require('dotenv');

const ROOT_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ROOT_ENV_PATH)) {
  dotenv.config({ path: ROOT_ENV_PATH });
}

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const SCHEMA_LEDGER_TABLE = 'schema_migrations';

function log(message) {
  console.log(`db: ${message}`);
}

function fail(message) {
  console.error(`db: ${message}`);
  process.exitCode = 1;
}

/**
 * Collect every table the up migrations declare with `CREATE TABLE`.
 *
 * @returns {string[]} Sorted, de-duplicated table names.
 */
function expectedTablesFromMigrations() {
  /** @type {Set<string>} */
  const tables = new Set();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.up.sql'));
  const pattern = /CREATE TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const file of files.sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    let match;
    while ((match = pattern.exec(sql)) !== null) {
      tables.add(match[1]);
    }
  }
  return Array.from(tables).sort();
}

/** @returns {Promise<Client>} */
async function connect() {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is not set (copy .env.example to .env and adjust if needed)');
  }
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 4000,
    statement_timeout: 30_000,
  });
  await client.connect();
  return client;
}

async function main() {
  const expectedTables = expectedTablesFromMigrations();

  let client;
  try {
    client = await connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`cannot reach database: ${message}`);
    return;
  }

  try {
    const missing = [];

    const extension = await client.query(`SELECT 1 FROM pg_extension WHERE extname = $1`, [
      'vector',
    ]);
    if (extension.rows.length === 0) {
      missing.push('extension "vector" (pgvector)');
      log('missing extension "vector" (pgvector)');
    } else {
      log('extension "vector" (pgvector) ok');
    }

    const ledger = await client.query(`SELECT to_regclass($1)::text AS name`, [
      SCHEMA_LEDGER_TABLE,
    ]);
    if (ledger.rows[0]?.name === null || ledger.rows[0] === undefined) {
      missing.push(`table "${SCHEMA_LEDGER_TABLE}"`);
      log(`missing table "${SCHEMA_LEDGER_TABLE}"`);
    } else {
      log(`table "${SCHEMA_LEDGER_TABLE}" ok`);
    }

    for (const table of expectedTables) {
      const result = await client.query(`SELECT to_regclass($1)::text AS name`, [table]);
      if (result.rows[0]?.name === null || result.rows[0] === undefined) {
        missing.push(`table "${table}"`);
        log(`missing table "${table}"`);
      } else {
        log(`table "${table}" ok`);
      }
    }

    if (missing.length > 0) {
      fail(`schema smoke check failed: missing ${missing.join(', ')}`);
      return;
    }
    log(
      `schema smoke check passed (extension vector, ${SCHEMA_LEDGER_TABLE}, ` +
        `${expectedTables.length} migration table(s))`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`schema smoke check failed: ${message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(`unexpected error: ${message}`);
});
