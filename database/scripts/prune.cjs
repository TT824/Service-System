'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Prune the local database down to one company's own set.
 *
 * The deployment is no longer a SaaS: it keeps exactly one tenant, one
 * administrator and one seat. Everything else — the trial tenants
 * self-registration left behind, the second seeded tenant, the demo members and
 * their accounts — is deleted, and takes its own history with it: the foreign
 * keys are `ON DELETE CASCADE`, so a tenant carries its stores, conversations,
 * messages and products out, and a member carries its presence rows, store
 * scopes and links.
 *
 * It is a statement about a running database, not about the fixture file:
 * `seed.cjs` still writes `tenant-beta` and its people, because the interface
 * suite's cross-tenant assertions are written against them. Pruning is
 * therefore *not* the way to keep the two files consistent — re-running
 * `db:seed` restores what it deleted, and a pruned database is a database the
 * interface gate cannot pass on.
 *
 * Two safety properties are deliberate:
 *
 *   - it is a **dry run unless `--apply` is passed**, so the list below can be
 *     read before anything is destroyed;
 *   - the kept rows must already exist, or it refuses to run — a typo in the
 *     keep list would otherwise delete the very thing it was meant to spare.
 *
 * All deletes run in one transaction: a statement the schema refuses rolls the
 * whole thing back rather than leaving a half-pruned database.
 *
 * Usage (from the repository root):
 *   npm run db:prune                                    # preview
 *   npm run prune --workspace @kefu/database -- --apply  # delete
 *
 * (`--apply` rather than `--yes`: npm claims `--yes` for itself, so it would
 * never reach this script.)
 */

const fs = require('node:fs');
const path = require('node:path');

const { Client } = require('pg');

const dotenv = require('dotenv');

const ROOT_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ROOT_ENV_PATH)) {
  dotenv.config({ path: ROOT_ENV_PATH });
}

/** The one tenant that stays, with its stores, products and conversations. */
const KEEP_TENANTS = ['tenant-acme'];

/** The platform administrator, and the seat that works conversations. */
const KEEP_MEMBERS = ['u-platform-admin', 'u-t1-agent-2'];

/** The accounts those two members sign in with. */
const KEEP_ACCOUNTS = ['admin', 'agent01'];

function log(message) {
  console.log(`db: ${message}`);
}

/**
 * Count the rows this run would delete, by kind.
 *
 * @param {Client} client - Connected client.
 * @returns {Promise<Record<string, number>>} Kind → number of doomed rows.
 */
async function doomedCounts(client) {
  const { rows } = await client.query(
    `SELECT 'accounts' AS kind, count(*)::int AS total
       FROM user_accounts WHERE username <> ALL($3::text[])
     UNION ALL SELECT 'members', count(*)::int
       FROM members WHERE id <> ALL($2::text[])
     UNION ALL SELECT 'tenants', count(*)::int
       FROM tenants WHERE id <> ALL($1::text[])
     UNION ALL SELECT 'stores', count(*)::int
       FROM stores WHERE tenant_id <> ALL($1::text[])
     UNION ALL SELECT 'conversations', count(*)::int
       FROM conversations WHERE tenant_id <> ALL($1::text[])
     UNION ALL SELECT 'messages', count(*)::int
       FROM messages WHERE tenant_id <> ALL($1::text[])
     UNION ALL SELECT 'products', count(*)::int
       FROM products WHERE tenant_id <> ALL($1::text[])`,
    [KEEP_TENANTS, KEEP_MEMBERS, KEEP_ACCOUNTS],
  );
  return Object.fromEntries(rows.map((row) => [row.kind, Number(row.total)]));
}

/**
 * Everything the run would delete, named, so the preview is reviewable.
 *
 * @param {Client} client - Connected client.
 * @returns {Promise<{accounts: string[], members: string[], tenants: string[]}>} Doomed rows.
 */
async function doomedRows(client) {
  const accounts = await client.query(
    'SELECT username FROM user_accounts WHERE username <> ALL($1::text[]) ORDER BY username',
    [KEEP_ACCOUNTS],
  );
  const members = await client.query(
    `SELECT id, role, display_name FROM members WHERE id <> ALL($1::text[])
     ORDER BY role, id`,
    [KEEP_MEMBERS],
  );
  const tenants = await client.query(
    'SELECT id, name FROM tenants WHERE id <> ALL($1::text[]) ORDER BY id',
    [KEEP_TENANTS],
  );
  return {
    accounts: accounts.rows.map((row) => row.username),
    members: members.rows.map((row) => `${row.id} (${row.role}, ${row.display_name})`),
    tenants: tenants.rows.map((row) => `${row.id} (${row.name})`),
  };
}

/**
 * Refuse to run when the keep list names rows the database does not have.
 *
 * @param {Client} client - Connected client.
 * @returns {Promise<void>} Resolves when every kept row exists.
 */
async function assertKeepListExists(client) {
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM tenants WHERE id = ANY($1::text[]))::int AS tenants,
            (SELECT count(*) FROM members WHERE id = ANY($2::text[]))::int AS members,
            (SELECT count(*) FROM user_accounts WHERE username = ANY($3::text[]))::int AS accounts`,
    [KEEP_TENANTS, KEEP_MEMBERS, KEEP_ACCOUNTS],
  );
  const found = rows[0];
  const expected = {
    tenants: KEEP_TENANTS.length,
    members: KEEP_MEMBERS.length,
    accounts: KEEP_ACCOUNTS.length,
  };
  for (const kind of ['tenants', 'members', 'accounts']) {
    if (found[kind] !== expected[kind]) {
      throw new Error(
        `keep list does not match the database: ${kind} ${found[kind]}/${expected[kind]} — refusing to delete anything`,
      );
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await assertKeepListExists(client);

    const before = await doomedCounts(client);
    const rows = await doomedRows(client);
    log(
      `keeping: ${KEEP_TENANTS.join(', ')} · ${KEEP_MEMBERS.join(', ')} · ${KEEP_ACCOUNTS.join(', ')}`,
    );
    log(`to delete — accounts: ${rows.accounts.join(', ') || '(none)'}`);
    log(`to delete — members:  ${rows.members.join(', ') || '(none)'}`);
    log(`to delete — tenants:  ${rows.tenants.join(', ') || '(none)'}`);
    log(
      `carried out with them — stores ${before.stores}, conversations ${before.conversations}, ` +
        `messages ${before.messages}, products ${before.products}`,
    );

    if (!apply) {
      log('dry run — nothing deleted. Re-run with `--apply` to delete for real.');
      return;
    }

    await client.query('BEGIN');
    // Accounts first: their links cascade away, and the members they point at
    // are about to go too. Then the members, then the tenants, whose own
    // history cascades out with them.
    const accounts = await client.query(
      'DELETE FROM user_accounts WHERE username <> ALL($1::text[]) RETURNING username',
      [KEEP_ACCOUNTS],
    );
    const members = await client.query(
      'DELETE FROM members WHERE id <> ALL($1::text[]) RETURNING id',
      [KEEP_MEMBERS],
    );
    const tenants = await client.query(
      'DELETE FROM tenants WHERE id <> ALL($1::text[]) RETURNING id',
      [KEEP_TENANTS],
    );
    await client.query('COMMIT');

    log(
      `deleted ${accounts.rowCount} accounts, ${members.rowCount} members, ${tenants.rowCount} tenants`,
    );
    const after = await doomedCounts(client);
    log(`remaining beyond the kept set: ${JSON.stringify(after)}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`db: ${error.message}`);
  process.exitCode = 1;
});
