'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Fill `knowledge_chunk_terms` for the slices that predate it.
 *
 * `0014` gives the keyword leg terms to score with BM25, and the Worker now
 * writes them for every slice whose text it writes. That covers everything
 * indexed from here on and **nothing that is already there**: a sweep only
 * rewrites a slice whose text moved, and a slice whose text has not moved has no
 * reason to move, so the 18,147 slices this database already holds would keep
 * returning no terms for ever — and the keyword leg would answer every question
 * from an empty index without saying so.
 *
 * **Why this is a script and not part of the migration.** The tokenizer is one
 * function, `tokenizeKnowledgeText` in `@kefu/core`, called by the Worker on the
 * way in and by the API on the way out. SQL cannot call it, so a migration that
 * filled this table could only do it by holding a *second*, SQL-spelled
 * implementation of the same rule — the duplicate this repository spends the
 * most effort making unrepresentable, and the one that would drift first, since
 * nothing would run both and compare them. The migration therefore creates the
 * table empty and this script fills it, from the same built `dist` the gates
 * read.
 *
 * **It reads the artefact, not the source.** `require('@kefu/core')` resolves to
 * `packages/core/dist`, so a change to the tokenizer that has not been rebuilt
 * is a change this script will not see. Rebuild before running it:
 * `npm run build:packages`.
 *
 * **It is a dry run unless `--apply` is passed**, and the preview is the whole
 * point of that: it prints how many slices it would rewrite, how many terms they
 * produce and the shape of a few of them, so that "the terms are wrong" is
 * something an operator can see before it is in the table rather than after.
 *
 * **It is idempotent.** Every slice it rewrites has its existing terms deleted in
 * the same batch, so a second run produces the same table as the first — and a
 * run over slices that are already correct rewrites them to the same values.
 * There is nothing to detect and skip, and nothing that can accumulate.
 *
 * Usage (from the repository root, after `npm run build:packages`):
 *
 *   node database/scripts/backfill-chunk-terms.cjs                      # preview
 *   node database/scripts/backfill-chunk-terms.cjs --apply              # fill
 *   node database/scripts/backfill-chunk-terms.cjs --tenant=tenant-acme --apply
 *
 * Invoked through `node` rather than an npm alias on purpose: npm claims dashed
 * arguments for itself, so `npm run db:backfill-terms -- --apply` is a coin flip
 * on whether `--apply` ever reaches this file.
 */

const fs = require('node:fs');
const path = require('node:path');

const { Client } = require('pg');

const dotenv = require('dotenv');

const { tokenizeKnowledgeText } = require('@kefu/core');

const ROOT_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ROOT_ENV_PATH)) {
  dotenv.config({ path: ROOT_ENV_PATH });
}

/** How many slices one batch of triples covers. */
const BATCH_SIZE = 500;

/** How many example slices the preview prints. */
const PREVIEW_SLICES = 5;

/** How many slices to read at most, if `--limit` is not given. */
const DEFAULT_LIMIT = 1_000_000;

const SELECT_SLICES_SQL = `
  SELECT id, tenant_id, content
    FROM knowledge_chunks
   WHERE ($1::text IS NULL OR tenant_id = $1)
   ORDER BY id
   LIMIT $2::int`;

const DELETE_TERMS_SQL =
  'DELETE FROM knowledge_chunk_terms WHERE chunk_id = ANY($1::text[])';

const INSERT_TERMS_SQL = `
  INSERT INTO knowledge_chunk_terms (tenant_id, chunk_id, term, tf)
  SELECT t.tenant_id, t.chunk_id, t.term, t.tf
    FROM unnest($1::text[], $2::text[], $3::text[], $4::int[])
      AS t(tenant_id, chunk_id, term, tf)`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * The command line, as the three things this script does differently by.
 *
 * Unknown arguments are refused rather than ignored: a run that silently took
 * `--aply` for "preview" would report a table it had not touched, which is the
 * one failure a dry run must not have.
 */
function parseArgs(argv) {
  const args = { apply: false, tenantId: null, limit: DEFAULT_LIMIT };
  for (const arg of argv) {
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg.startsWith('--tenant=')) {
      args.tenantId = arg.slice('--tenant='.length);
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number.parseInt(arg.slice('--limit='.length), 10);
      if (!Number.isFinite(args.limit) || args.limit <= 0) {
        throw new Error(`--limit must be a positive integer, got ${arg}`);
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

/**
 * One slice's terms, as the three parallel arrays the insert unnests.
 *
 * Counting is what the table is for — `tf` is the frequency BM25 saturates on —
 * so a term the text says three times is one row holding three.
 */
function countTerms(content) {
  const counted = new Map();
  for (const token of tokenizeKnowledgeText(content)) {
    counted.set(token, (counted.get(token) ?? 0) + 1);
  }
  return counted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(SELECT_SLICES_SQL, [args.tenantId, args.limit]);
    log(`${args.apply ? 'backfilling' : 'would backfill'} ${rows.length} slices`);
    if (rows.length === 0) {
      return;
    }

    let termRows = 0;
    let emptySlices = 0;
    let previewed = 0;
    for (let start = 0; start < rows.length; start += BATCH_SIZE) {
      const batch = rows.slice(start, start + BATCH_SIZE);
      const tenantIds = [];
      const chunkIds = [];
      const terms = [];
      const counts = [];
      for (const slice of batch) {
        const counted = countTerms(slice.content);
        if (counted.size === 0) {
          emptySlices += 1;
          if (previewed < PREVIEW_SLICES) {
            previewed += 1;
            log(`  no terms: ${JSON.stringify(slice.content)}`);
          }
        } else if (previewed < PREVIEW_SLICES) {
          previewed += 1;
          const shown = [...counted].map(([term, tf]) => `${term}x${tf}`).join(' ');
          log(`  ${slice.content}`);
          log(`    -> ${shown}`);
        }
        for (const [term, tf] of counted) {
          tenantIds.push(slice.tenant_id);
          chunkIds.push(slice.id);
          terms.push(term);
          counts.push(tf);
        }
      }
      termRows += chunkIds.length;

      if (args.apply) {
        await client.query('BEGIN');
        try {
          await client.query(DELETE_TERMS_SQL, [chunkIds]);
          if (chunkIds.length > 0) {
            await client.query(INSERT_TERMS_SQL, [tenantIds, chunkIds, terms, counts]);
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    }

    log(`terms: ${termRows} rows across ${rows.length - emptySlices} slices`);
    if (emptySlices > 0) {
      log(
        `slices that tokenize to nothing: ${emptySlices} — unreachable by the keyword leg, ` +
          'which is what a slice with no Chinese and no alphanumerics deserves',
      );
    }
    if (!args.apply) {
      log('this was a preview; pass --apply to write');
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
