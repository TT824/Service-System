'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Put the slices the platform parked by mistake back in the queue.
 *
 * `knowledge_chunks.index_status = 'skipped'` is a **terminal** state: the claim's
 * `WHERE` names it alongside `indexed`, so nothing in the Worker will ever look at
 * such a row again, whatever the slice says. That is the right meaning for a slice
 * whose embedding the provider refused five times — but on 2026-09-20 the source
 * sweep was spending those attempts itself, one per pass, without calling any
 * provider at all. The sweep re-reads every source every 60 seconds, so five
 * attempts was a few minutes of running; 8,489 of one tenant's 18,270 slices (46%)
 * were parked, most of them with `index_error` NULL — the table could not even say
 * why.
 *
 * The sweep no longer writes index state (see `knowledge-index-state`), so that
 * cannot happen again. What it cannot do is undo it: rows already parked stay
 * parked, because a parked slice is only revived by its *text* moving, and a
 * slice that is merely unembedded has no reason to move. This script is the way
 * back, and it is deliberately the only one.
 *
 * **It touches `skipped` rows and nothing else**, because `skipped` is the only
 * stuck state. A `failed` row is *not* stuck: it has attempts left and a schedule,
 * and the sweep will reach it on its own — requeueing those would only race the
 * backoff. A `pending` row at the ceiling belongs to the worker's
 * `parkExhausted`, which is the only thing that can tell a dead worker's leavings
 * from an attempt running right now.
 *
 * **It is idempotent and shrinking.** Every row it writes leaves `skipped`, and
 * the rows it does not write are left exactly as they are, so a second run finds
 * a strictly smaller set — and a run over a healthy database finds nothing and
 * writes nothing. The two bounds it exposes are for a large drain, not for
 * correctness: `--tenant` (one company) and `--limit` (a batch).
 *
 * **It is a dry run unless `--apply` is passed**, and the preview prints what the
 * parked rows have to say about themselves before anything is queued: a wall of
 * NULL reasons is the fingerprint of the incident above, while a reason naming a
 * provider is an operator's own problem to fix first.
 *
 * Usage (from the repository root, with the Worker **stopped or already running
 * this version** — a Worker from before the fix would park the rows again):
 *
 *   node database/scripts/requeue-parked.cjs                  # preview
 *   node database/scripts/requeue-parked.cjs --apply          # queue them
 *   node database/scripts/requeue-parked.cjs --tenant=tenant-acme --limit=500 --apply
 *
 * Invoked through `node` rather than an npm alias on purpose: npm claims dashed
 * arguments for itself, so `npm run db:requeue-parked -- --apply` is a coin flip
 * on whether `--apply` ever reaches this file.
 */

const fs = require('node:fs');
const path = require('node:path');

const { Client } = require('pg');

const dotenv = require('dotenv');

const ROOT_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ROOT_ENV_PATH)) {
  dotenv.config({ path: ROOT_ENV_PATH });
}

/** How many slices the sweep claims per tick, and how often it ticks. */
const SWEEP_BATCH_SIZE = 10;
const SWEEP_POLL_INTERVAL_MS = 5_000;

function log(message) {
  console.log(`requeue: ${message}`);
}

/**
 * Read one `--name=value` argument.
 *
 * @param {string} name - Argument name without the dashes.
 * @returns {string | null} The value, or `null` when the argument is absent.
 */
function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

/**
 * The rows this run would requeue, and what they currently say.
 *
 * @param {Client} client - Connected client.
 * @param {string | null} tenantId - One tenant, or `null` for every tenant.
 * @returns {Promise<{parked: number, reasons: Array<{reason: string, total: number}>, statuses: Array<{index_status: string, total: number}>}>} The preview.
 */
async function preview(client, tenantId) {
  const scoped = '($1::text IS NULL OR tenant_id = $1)';
  const parked = await client.query(
    `SELECT count(*)::int AS total FROM knowledge_chunks
      WHERE index_status = 'skipped' AND ${scoped}`,
    [tenantId],
  );
  const reasons = await client.query(
    `SELECT COALESCE(index_error, '(no reason recorded)') AS reason, count(*)::int AS total
       FROM knowledge_chunks
      WHERE index_status = 'skipped' AND ${scoped}
      GROUP BY 1 ORDER BY 2 DESC, 1`,
    [tenantId],
  );
  const statuses = await client.query(
    `SELECT index_status, count(*)::int AS total FROM knowledge_chunks
      WHERE ${scoped}
      GROUP BY 1 ORDER BY 1`,
    [tenantId],
  );
  return {
    parked: Number(parked.rows[0]?.total ?? 0),
    reasons: reasons.rows.map((row) => ({ reason: String(row.reason), total: Number(row.total) })),
    statuses: statuses.rows.map((row) => ({
      index_status: String(row.index_status),
      total: Number(row.total),
    })),
  };
}

/**
 * Queue the parked slices, newest-named first, and report how many moved.
 *
 * `index_attempts` goes to **zero** rather than to the ceiling minus one: the
 * attempts recorded against these rows were never attempts, so the row starts
 * over exactly as a slice whose text moved does — see `planChunkWrite`, whose
 * `reindex` branch writes the same four values. `index_error` is cleared for the
 * same reason: it describes a failure that had no provider behind it, and leaving
 * it would hand the next operator that text as though it were evidence.
 * `indexed_at` is cleared because a row waiting to be embedded must not carry the
 * instant of an embedding; the vector it may still hold is for text the row no
 * longer agrees with, and the outcome write is guarded by `content_hash`, so the
 * next successful attempt replaces it.
 *
 * `updated_at` is stamped now, which makes the batch due immediately: attempt
 * zero's delay is zero (`knowledgeIndexRetryDelayMs`), so the anchor does not
 * hold them back — and it is the row's own anchor for the retries that follow.
 *
 * @param {Client} client - Connected client.
 * @param {string} now - The instant to stamp.
 * @param {{tenantId: string | null, limit: number | null}} scope - The bounds.
 * @returns {Promise<number>} How many rows were requeued.
 */
async function requeue(client, now, scope) {
  const { rows } = await client.query(
    `WITH parked AS (
       SELECT id FROM knowledge_chunks
        WHERE index_status = 'skipped'
          AND ($1::text IS NULL OR tenant_id = $1)
        ORDER BY id
        LIMIT COALESCE($2::int, 2147483647)
     )
     UPDATE knowledge_chunks
        SET index_status = 'pending',
            index_attempts = 0,
            index_error = NULL,
            indexed_at = NULL,
            updated_at = $3
      WHERE id IN (SELECT id FROM parked)
      RETURNING id`,
    [scope.tenantId, scope.limit, now],
  );
  return rows.length;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const tenantId = argValue('tenant');
  const limitText = argValue('limit');
  const limit = limitText === null ? null : Number(limitText);
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive whole number, got ${limitText}`);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const before = await preview(client, tenantId);
    log(
      `scope: ${tenantId === null ? 'every tenant' : tenantId}${limit === null ? '' : ` · at most ${limit} slices`}`,
    );
    log(
      `slices by state: ${before.statuses.map((row) => `${row.index_status} ${row.total}`).join(', ') || '(none)'}`,
    );
    for (const entry of before.reasons) {
      log(`  parked — ${entry.total} × ${entry.reason}`);
    }
    log(
      `to requeue: ${limit === null ? before.parked : Math.min(limit, before.parked)} of ${before.parked} parked`,
    );

    if (!apply) {
      log('dry run — nothing queued. Re-run with `--apply` to queue them.');
      return;
    }
    if (before.parked === 0) {
      log('nothing parked in this scope — nothing to do.');
      return;
    }

    const now = new Date().toISOString();
    await client.query('BEGIN');
    const queued = await requeue(client, now, { tenantId, limit });
    await client.query('COMMIT');

    // The pace below is the sweep's own: it claims a batch per tick, so this is
    // how long the queue takes to drain, not how long the script took.
    const seconds = Math.round((queued * SWEEP_POLL_INTERVAL_MS) / SWEEP_BATCH_SIZE / 1000);
    log(`requeued ${queued} slices at ${now}`);
    log(
      `the sweep claims ${SWEEP_BATCH_SIZE} slices every ${SWEEP_POLL_INTERVAL_MS / 1000}s, so a full drain is about ${Math.round(seconds / 60)} minutes`,
    );

    const after = await preview(client, tenantId);
    log(
      `slices by state: ${after.statuses.map((row) => `${row.index_status} ${row.total}`).join(', ') || '(none)'}`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`requeue: ${error.message}`);
  process.exitCode = 1;
});
