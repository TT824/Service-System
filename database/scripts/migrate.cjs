'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Minimal file-based SQL migration runner for the kefu-saas monorepo.
 *
 * Each migration lives in `database/migrations/<version>_<name>.up.sql` and,
 * optionally, `<version>_<name>.down.sql`. Versions are applied in ascending
 * lexicographic order and recorded in a `schema_migrations` table. Rollback
 * reverts the most recently applied migration using its down file.
 *
 * Usage (from the repository root):
 *   npm run db:migrate    # apply pending migrations
 *   npm run db:rollback   # revert the most recently applied migration
 *   npm run db:status     # show applied and pending migrations
 *
 * The runner reads DATABASE_URL from the repository `.env` when present, or
 * from the process environment. The URL itself is never written to logs.
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
const SCHEMA_TABLE = 'schema_migrations';
const UP_SUFFIX = '.up.sql';
const DOWN_SUFFIX = '.down.sql';

/** @typedef {{ id: string, version: string, name: string, up: string, down: string | null }} Migration */

function log(message) {
  console.log(`db: ${message}`);
}

function fail(message) {
  console.error(`db: ${message}`);
  process.exitCode = 1;
}

/** @returns {Migration[]} */
function listMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'));
  /** @type {Map<string, Migration>} */
  const migrations = new Map();

  for (const file of files.sort()) {
    let id;
    let kind;
    if (file.endsWith(UP_SUFFIX)) {
      id = file.slice(0, -UP_SUFFIX.length);
      kind = 'up';
    } else if (file.endsWith(DOWN_SUFFIX)) {
      id = file.slice(0, -DOWN_SUFFIX.length);
      kind = 'down';
    } else {
      continue;
    }

    const existing = migrations.get(id) ?? { id, version: id, name: id, up: null, down: null };
    existing[kind] = path.join(MIGRATIONS_DIR, file);
    migrations.set(id, existing);
  }

  const result = Array.from(migrations.values()).sort((a, b) => {
    if (a.version === b.version) {
      return a.name < b.name ? -1 : 1;
    }
    return a.version < b.version ? -1 : 1;
  });

  for (const migration of result) {
    if (migration.up === null) {
      throw new Error(`migration "${migration.id}" has a down file but no up file`);
    }
  }
  return result;
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

/**
 * @param {Client} client
 * @param {(tx: Client) => Promise<void>} work
 */
async function withTransaction(client, work) {
  await client.query('BEGIN');
  try {
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** @param {Client} client */
async function ensureTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (
       version    text PRIMARY KEY,
       name       text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/** @param {Client} client @returns {Promise<Set<string>>} */
async function appliedVersions(client) {
  const result = await client.query(`SELECT version FROM ${SCHEMA_TABLE}`);
  return new Set(result.rows.map((row) => String(row.version)));
}

/** @param {Migration} migration @returns {Promise<void>} */
async function applyOne(client, migration) {
  if (migration.up === null) {
    throw new Error(`migration "${migration.id}" has no up file`);
  }
  const sql = fs.readFileSync(migration.up, 'utf8');
  await withTransaction(client, async (tx) => {
    await tx.query(sql);
    await tx.query(`INSERT INTO ${SCHEMA_TABLE} (version, name) VALUES ($1, $2)`, [
      migration.version,
      migration.id,
    ]);
  });
  log(`applied ${migration.id}`);
}

/** @param {Migration} migration @returns {Promise<void>} */
async function revertOne(client, migration) {
  if (migration.down === null) {
    throw new Error(
      `migration "${migration.id}" has no down file; revert it manually before rolling back`,
    );
  }
  const sql = fs.readFileSync(migration.down, 'utf8');
  await withTransaction(client, async (tx) => {
    await tx.query(sql);
    await tx.query(`DELETE FROM ${SCHEMA_TABLE} WHERE version = $1`, [migration.version]);
  });
  log(`reverted ${migration.id}`);
}

/** @param {Client} client */
async function runStatus(client) {
  await ensureTable(client);
  const applied = await appliedVersions(client);
  const all = listMigrations();

  for (const migration of all) {
    const state = applied.has(migration.version) ? 'applied ' : 'pending ';
    log(`${state} ${migration.id}`);
  }
  const pendingCount = all.filter((migration) => !applied.has(migration.version)).length;
  log(`${pendingCount} pending, ${all.length - pendingCount} applied`);
}

/** @param {Client} client */
async function runMigrate(client) {
  await ensureTable(client);
  const applied = await appliedVersions(client);
  const pending = listMigrations().filter((migration) => !applied.has(migration.version));
  if (pending.length === 0) {
    log('no pending migrations');
    return;
  }
  for (const migration of pending) {
    await applyOne(client, migration);
  }
}

/** @param {Client} client */
async function runRollback(client) {
  await ensureTable(client);
  const result = await client.query(
    `SELECT version, name FROM ${SCHEMA_TABLE} ORDER BY applied_at DESC, version DESC LIMIT 1`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    log('nothing to roll back');
    return;
  }
  const migration = listMigrations().find((item) => item.version === String(row.version));
  if (migration === undefined) {
    throw new Error(`applied migration "${String(row.version)}" is missing from migrations/`);
  }
  await revertOne(client, migration);
}

function printHelp() {
  console.log(
    [
      'kefu database migrations runner',
      '',
      'usage: node scripts/migrate.cjs <command>',
      '',
      'commands:',
      '  migrate    apply pending migrations',
      '  rollback   revert the most recently applied migration',
      '  status     list applied and pending migrations',
      '',
    ].join('\n'),
  );
}

async function main() {
  const command = process.argv[2] ?? 'migrate';

  if (command === '--help' || command === 'help') {
    printHelp();
    return;
  }
  if (command !== 'migrate' && command !== 'rollback' && command !== 'status') {
    fail(`unknown command "${command}" (expected migrate | rollback | status)`);
    return;
  }

  let client;
  try {
    client = await connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`cannot reach database: ${message}`);
    return;
  }

  try {
    if (command === 'migrate') {
      await runMigrate(client);
    } else if (command === 'rollback') {
      await runRollback(client);
    } else {
      await runStatus(client);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`migration command failed: ${message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(`unexpected error: ${message}`);
});
