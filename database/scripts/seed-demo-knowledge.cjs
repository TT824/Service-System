'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Optional demo knowledge, so the assist panel has something to retrieve from.
 *
 * `db:seed` writes accounts and directory rows; `db:seed:demo` writes the demo
 * conversations. Neither writes a single row of 话术库 or 商品库 knowledge, so on a
 * fresh database the assist panel's retrieval legs have nothing to search: the
 * customer asks 「发货一般需要多久？」 and every leg honestly returns nothing.
 *
 * This command is the stand-in for that missing half. It writes a handful of
 * FAQs and one store phrase into the demo tenant and store — rows chosen so that
 * the demo conversations that already exist exercise **both** halves of the
 * rule this feature is built on:
 *
 * - 「发货一般需要多久？」 (周先生) and 「有适合送礼的包装吗？」 (刘女士) have a
 *   话术库 answer, so the retrieval-first rule returns the stored phrase and
 *   **never calls the generation model**.
 * - 「想问一下米白色有货吗？」 (吴先生) has no 话术库 answer, so the same request
 *   falls through to the 商品库 and (with a provider configured) is generated
 *   from the product rows' own information — the other half of the rule.
 *
 * Both halves are worth having in the same database: a demo that only ever hits
 * the 话术库 cannot show that the fallback exists, and one that only ever misses
 * cannot show that a hit suppresses the model call.
 *
 * **The catalogue rows are `product_spus` / `product_skus`, not `products`.** The
 * two tables are not interchangeable here, and picking the wrong one is how this
 * command can quietly fail to deliver its second bullet. `products` is the
 * compatibility read: it is answered *from* but never indexed, so a row in it
 * carries no recall evidence — and without evidence a candidate has to win the
 * engine's lexical count, which asks whether the *whole query string* appears in
 * the row's text (`tokenizeQuery` splits on punctuation only, so 想问一下米白色有货吗？
 * is one token). A customer's sentence almost never appears verbatim in a product
 * row, so a catalogue that lives only in `products` answers nothing. The colour is
 * what makes the demo's question reachable, and the colour of an indexed product
 * lives on its variant: `product_skus.variant_json` is where the whitelist reads
 * 颜色 from (`CUSTOMER_VISIBLE_SKU_ATTRIBUTES`), and the worker prefixes the
 * product's title to that line, which is what lets 米白 reach 云集轻暖羽绒服.
 *
 * Deliberately **not** part of `db:seed`, and deliberately not run by any test —
 * the same reason `seed-demo-conversations.cjs` gives: it writes business rows
 * into whichever database `DATABASE_URL` names, and the local `kefu` database is
 * the one the e2e suite runs against. Run it when a demo needs data.
 *
 * Usage (from the repository root):
 *   npm run db:seed:demo:knowledge                                # write the rows
 *   npm run seed:demo:knowledge --workspace @kefu/database -- --undo   # delete them
 *
 * Scope: `tenant-acme` / `store-acme-flagship` only, by fixed id. Both are
 * `db:seed` fixtures, so this command depends on `db:seed` having run.
 *
 * Idempotency: every row is `ON CONFLICT DO NOTHING` under a fixed id, so a
 * repeat run inserts nothing and changes nothing. Editing a row's text here and
 * re-running does **not** update it — the id, not the text, is what makes the row
 * the same row; use `--undo` and run again to pick up a change.
 *
 * The worker does the rest, and does it without an embedding provider: its
 * knowledge source sweep is not gated on configuration (`knowledge-source-sweep`
 * is explicit about this — the embedding sweep is the gated one), so it writes
 * the chunks and their BM25 terms on its next pass. That is what makes the
 * keyword half of retrieval demonstrable on a machine that has never configured
 * an embedding or rerank provider, and why the dense half is expected to report
 * itself unavailable until one is.
 *
 * **`--undo` removes the slices too, and it has to.** The worker's own rule is
 * the opposite one, and it is deliberate: a slice carries no foreign key to its
 * source, so a *deleted* source row is never revisited and its slices stay in the
 * index — `knowledge-index-lifecycle.integration.spec.ts` pins exactly that
 * ("leaves a deleted source alone"). A command whose promise is "remove what I
 * wrote" cannot rely on that: it would leave the index dirty, and two e2e suites
 * read the slice tables as a whole (`retrieval-overreach`, `knowledge-index-status`
 * assert they are empty between suites), so the leftover slices would fail them
 * permanently. The delete is therefore part of this command's transaction, keyed
 * by the same fixed ids the inserts used; the slices' keywords and terms follow
 * through `ON DELETE CASCADE`, so no child row is deleted by hand.
 */

const fs = require('node:fs');
const path = require('node:path');

const { Client } = require('pg');
const dotenv = require('dotenv');

// Same bootstrap as `scripts/check.cjs`: read the repository `.env` when it
// exists so the command works from a fresh shell, and fall back to whatever the
// environment already provides on a machine that sets DATABASE_URL itself.
const ROOT_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ROOT_ENV_PATH)) {
  dotenv.config({ path: ROOT_ENV_PATH });
}

/** Tenant and store the demo is scoped to. Both are `db:seed` fixtures. */
const TENANT_ID = 'tenant-acme';
const STORE_ID = 'store-acme-flagship';

/**
 * The 话术库 rows, in the two shapes the store actually keeps.
 *
 * `question` is the FAQ's own column and `title` the phrase's, so these are what
 * the index slices and what a customer's words are matched against — the answer
 * text is retrieved *with* a hit, not searched on. Keeping the questions close to
 * how the demo customers phrase things is therefore the whole of the trick here,
 * and is why these strings are quoted in this file's header.
 */
const DEMO_FAQS = [
  {
    id: 'demo-faq-shipping',
    question: '发货一般需要多久？',
    answer: '付款后 48 小时内发出，节假日顺延；发出后一般 2-3 天送达。',
    tags: ['发货', '物流'],
  },
  {
    id: 'demo-faq-gift',
    question: '有适合送礼的包装吗？',
    answer: '有礼盒装可选，下单时备注「需要礼盒」即可免费升级。',
    tags: ['包装', '送礼'],
  },
];

const DEMO_SHORTCUTS = [
  {
    id: 'demo-shortcut-heat',
    code: 'SC-DEMO-HEAT',
    title: '保温效果',
    content: '这款 500ml 保温杯是真空双层结构，热水 6 小时后仍能保持在 60℃ 以上。',
    sortOrder: 10,
  },
];

/**
 * The 商品库 rows: one product and its two colours.
 *
 * This is the 商品库 half of the second bullet in this file's header — what a
 * question with no 话术库 answer is answered from. The product is the one the
 * legacy demo rows already describe, so the two catalogues do not contradict each
 * other; what is new here is that it is *indexed*.
 *
 * `common_attributes_json` and `variant_json` are keyed by the labels the
 * whitelist names (`品牌`/`分类` for the product, `颜色`/`尺码` for the variant),
 * because the worker reads attributes by label rather than by position — a map
 * keyed some other way produces no lines and therefore no slices, silently.
 */
const DEMO_SPUS = [
  {
    id: 'demo-spu-down',
    productCode: 'DEMO-SPU-DOWN',
    title: '云集轻暖羽绒服 90白鸭绒 连帽中长款',
    subtitle: '秋冬热销',
    attributes: { 品牌: '云集', 分类: '羽绒服' },
  },
];

const DEMO_SKUS = [
  { id: 'demo-sku-down-mibai', skuCode: 'DEMO-SKU-DOWN-MIBAI', variant: { 颜色: '米白', 尺码: 'M' } },
  { id: 'demo-sku-down-black', skuCode: 'DEMO-SKU-DOWN-BLACK', variant: { 颜色: '黑色', 尺码: 'M' } },
];

/** The product every demo variant hangs off. */
const DEMO_SPU_ID = 'demo-spu-down';

/**
 * The demo sources as the index names them: a slice records `source_kind` and
 * `source_id`, not a table, so these are the pairs that find the slices.
 *
 * The kind vocabulary is the kernel's `IndexedSourceKind` (`faq` and `shortcut`
 * for the 话术库, `product` and `product_sku` for the catalogue) and not the table
 * names — `product_spus` writes slices stamped `product`.
 *
 * @returns One `[sourceKind, ids]` pair per table this command writes.
 */
function demoSources() {
  return [
    ['faq', DEMO_FAQS.map((faq) => faq.id)],
    ['shortcut', DEMO_SHORTCUTS.map((shortcut) => shortcut.id)],
    ['product', DEMO_SPUS.map((spu) => spu.id)],
    ['product_sku', DEMO_SKUS.map((sku) => sku.id)],
  ];
}

/** Tables this command writes; checked before anything is attempted. */
const REQUIRED_TABLES = [
  'faqs',
  'shortcuts',
  'product_spus',
  'product_skus',
  'stores',
];

async function connect() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function assertSchemaReady(client) {
  const present = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES],
  );
  const found = new Set(present.rows.map((row) => row.table_name));
  const missing = REQUIRED_TABLES.filter((table) => !found.has(table));
  if (missing.length > 0) {
    throw new Error(`missing tables: ${missing.join(', ')}; run "npm run db:migrate" first`);
  }
}

/**
 * Refuse to run when the demo tenant or store is not there.
 *
 * Both are `db:seed` fixtures rather than anything this file creates, and the
 * foreign keys would reject the inserts anyway. Failing here says which command
 * is missing instead of surfacing a constraint name.
 */
async function assertDemoScope(client) {
  const scope = await client.query(
    `SELECT (SELECT count(*)::int FROM stores
              WHERE id = $2 AND tenant_id = $1) AS stores_check`,
    [TENANT_ID, STORE_ID],
  );
  if (scope.rows[0].stores_check === 0) {
    throw new Error(
      `store "${STORE_ID}" not found under tenant "${TENANT_ID}"; run "npm run db:seed" first`,
    );
  }
}

async function applyDemo(client) {
  await client.query('BEGIN');
  try {
    await assertDemoScope(client);

    let insertedFaqs = 0;
    let insertedShortcuts = 0;
    let insertedSpus = 0;
    let insertedSkus = 0;

    for (const faq of DEMO_FAQS) {
      const result = await client.query(
        `INSERT INTO faqs (id, tenant_id, store_id, question, answer, tags, enabled, updated_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::text[], TRUE, now(), now())
         ON CONFLICT DO NOTHING`,
        [faq.id, TENANT_ID, STORE_ID, faq.question, faq.answer, faq.tags],
      );
      insertedFaqs += result.rowCount ?? 0;
    }

    for (const shortcut of DEMO_SHORTCUTS) {
      // `scope_type = 'store'` and a non-null `store_id` are held together by
      // `shortcuts_scope_check`, so the two travel as one pair and neither is
      // left to a default that could disagree with the other.
      const result = await client.query(
        `INSERT INTO shortcuts (
           id, tenant_id, store_id, code, title, content, enabled, updated_at, created_at,
           scope_type, intent_code, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, now(), now(),
                   'store', NULL, $7)
         ON CONFLICT DO NOTHING`,
        [shortcut.id, TENANT_ID, STORE_ID, shortcut.code, shortcut.title, shortcut.content, shortcut.sortOrder],
      );
      insertedShortcuts += result.rowCount ?? 0;
    }

    for (const spu of DEMO_SPUS) {
      // `shelf_status = 'on_shelf'` is what makes the row usable at all: the
      // worker's mapper reads usability from the shelf state alone, so a seeded
      // product left at the column default would index as "not for sale" and
      // produce slices the recall legs then discard.
      const result = await client.query(
        `INSERT INTO product_spus (
           id, tenant_id, store_id, product_code, title, subtitle,
           selling_points_json, common_attributes_json, shelf_status, source_type,
           updated_at, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7::jsonb, 'on_shelf', 'manual', now(), now())
         ON CONFLICT DO NOTHING`,
        [
          spu.id,
          TENANT_ID,
          STORE_ID,
          spu.productCode,
          spu.title,
          spu.subtitle,
          JSON.stringify(spu.attributes),
        ],
      );
      insertedSpus += result.rowCount ?? 0;
    }

    for (const sku of DEMO_SKUS) {
      // The product first, in this same transaction: `spu_id` is a foreign key,
      // and `ON CONFLICT DO NOTHING` does not turn a broken reference into a
      // quiet no-op — it raises.
      const result = await client.query(
        `INSERT INTO product_skus (
           id, tenant_id, store_id, spu_id, sku_code, variant_json, search_attributes_json,
           status, updated_at, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, 'active', now(), now())
         ON CONFLICT DO NOTHING`,
        [sku.id, TENANT_ID, STORE_ID, DEMO_SPU_ID, sku.skuCode, JSON.stringify(sku.variant)],
      );
      insertedSkus += result.rowCount ?? 0;
    }

    await client.query('COMMIT');
    return { faqs: insertedFaqs, shortcuts: insertedShortcuts, spus: insertedSpus, skus: insertedSkus };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * Delete the rows this file names, by fixed id and inside the demo tenant.
 *
 * The slices the worker wrote from them go in the same transaction — see this
 * file's header: the worker leaves a deleted source's slices behind on purpose,
 * and a command that is supposed to leave the database as it found it cannot
 * inherit that. Deleting the slices cascades to their keywords and their terms.
 *
 * @param {Client} client
 * @returns {Promise<{faqs: number, shortcuts: number, spus: number, skus: number, chunks: number}>}
 *   Rows deleted per table.
 */
async function undoDemo(client) {
  await client.query('BEGIN');
  try {
    const faqs = await client.query(
      'DELETE FROM faqs WHERE tenant_id = $1 AND id = ANY($2::text[])',
      [TENANT_ID, DEMO_FAQS.map((faq) => faq.id)],
    );
    const shortcuts = await client.query(
      'DELETE FROM shortcuts WHERE tenant_id = $1 AND id = ANY($2::text[])',
      [TENANT_ID, DEMO_SHORTCUTS.map((shortcut) => shortcut.id)],
    );
    // Variants before products: `product_skus.spu_id` is a foreign key, so the
    // other order would be refused rather than cascading.
    const skus = await client.query(
      'DELETE FROM product_skus WHERE tenant_id = $1 AND id = ANY($2::text[])',
      [TENANT_ID, DEMO_SKUS.map((sku) => sku.id)],
    );
    const spus = await client.query(
      'DELETE FROM product_spus WHERE tenant_id = $1 AND id = ANY($2::text[])',
      [TENANT_ID, DEMO_SPUS.map((spu) => spu.id)],
    );

    // Keyed by the source kind and id the inserts used, because that is the pair
    // a slice records — the slice does not reference the source row, so this is
    // the only way to find them once the rows are gone.
    let chunks = 0;
    for (const [sourceKind, ids] of demoSources()) {
      const deleted = await client.query(
        'DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND source_kind = $2 AND source_id = ANY($3::text[])',
        [TENANT_ID, sourceKind, ids],
      );
      chunks += deleted.rowCount ?? 0;
    }

    await client.query('COMMIT');
    return {
      faqs: faqs.rowCount ?? 0,
      shortcuts: shortcuts.rowCount ?? 0,
      spus: spus.rowCount ?? 0,
      skus: skus.rowCount ?? 0,
      chunks,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function main() {
  let client;
  try {
    client = await connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`cannot reach database: ${message}`);
    return;
  }

  try {
    await assertSchemaReady(client);
    if (process.argv.includes('--undo')) {
      const removed = await undoDemo(client);
      log(
        `undo complete: ${removed.faqs} faq(s), ${removed.shortcuts} shortcut(s), ` +
          `${removed.spus} product(s), ${removed.skus} variant(s) deleted, ` +
          `${removed.chunks} knowledge slice(s) removed with them`,
      );
      return;
    }
    const result = await applyDemo(client);
    log(`faqs: ${result.faqs} inserted, ${DEMO_FAQS.length - result.faqs} already present`);
    log(
      `shortcuts: ${result.shortcuts} inserted, ${DEMO_SHORTCUTS.length - result.shortcuts} already present`,
    );
    log(`products: ${result.spus} inserted, ${DEMO_SPUS.length - result.spus} already present`);
    log(`variants: ${result.skus} inserted, ${DEMO_SKUS.length - result.skus} already present`);
    log('the worker writes their knowledge chunks on its next sweep — no provider needed for that');
    log('delete them again with "npm run seed:demo:knowledge --workspace @kefu/database -- --undo"');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  } finally {
    await client.end().catch(() => undefined);
  }
}

void main();
