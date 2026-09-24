/* eslint-disable @typescript-eslint/no-require-imports -- 一次性诊断脚本（CommonJS 入口）。 */

/**
 * 一次性探针：L2 到底会改多少条切片文本，改成什么样。
 *
 *   node scripts/probe-l2-colour-split.cjs
 *
 * 为什么要先量一遍：L2 要重建 1.8 万条切片的索引（约 30 分钟）**并且重嵌**，
 * 一旦某一类值被改坏，代价不是一条断言而是整轮评测的读数。所以先拿真库里的
 * `variant_json` 跑一遍**已构建的 core**（`packages/core/dist`），把「改了几条、
 * 每类改成什么」摆在眼前，再动手建索引。
 *
 * 只读，不写库。
 */

const path = require('node:path');
require('reflect-metadata');
const { config: loadDotenv } = require('dotenv');
const { Client } = require('pg');

loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

const { separateColourAndSize, labelledEntries, CUSTOMER_VISIBLE_SKU_ATTRIBUTES } = require(
  path.resolve(__dirname, '..', 'packages/core/dist/index.js'),
);

/** 一类改动最多打印几条样例，免得把终端刷满。 */
const SAMPLES = 4;

function entriesOf(attributes) {
  return labelledEntries(separateColourAndSize(attributes), CUSTOMER_VISIBLE_SKU_ATTRIBUTES);
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    "SELECT variant_json, coalesce(nullif(btrim(variant_json->>'规格'), ''), nullif(btrim(variant_json->>'尺码'), '')) AS own_size FROM product_skus",
  );
  await client.end();

  let total = 0;
  let moved = 0;
  let withColour = 0;
  let untouchedTail = 0;
  const kinds = new Map();

  for (const row of rows) {
    total += 1;
    const attributes = row.variant_json ?? {};
    const colour = attributes['颜色'];
    const before = entriesOf(attributes).join('\n');
    if (typeof colour === 'string' && colour.length > 0) {
      withColour += 1;
    }
    if (before !== labelledEntries(attributes, CUSTOMER_VISIBLE_SKU_ATTRIBUTES).join('\n')) {
      moved += 1;
      const after = entriesOf(attributes).join('\n');
      const key = `${colour}  →  ${after.replace(/\n/g, ' | ')}`;
      const entry = kinds.get(key) ?? { count: 0 };
      entry.count += 1;
      kinds.set(key, entry);
    }
    if (typeof colour === 'string' && colour.length > 0) {
      const stripped = entriesOf({ 颜色: colour });
      if (stripped.length === 1 && stripped[0] === `颜色：${colour}` && row.own_size === null) {
        untouchedTail += 1;
      }
    }
  }

  const sorted = [...kinds.entries()].sort((left, right) => right[1].count - left[1].count);
  console.log(`SKU 行数           ${total}`);
  console.log(`有颜色列           ${withColour}`);
  console.log(`切片文本被改写     ${moved}`);
  console.log(`颜色列保持原样     ${withColour - moved}（含 ${untouchedTail} 条有尾缀但没搬动）`);
  console.log('');
  console.log('改动种类（按条数）:');
  for (const [key, entry] of sorted.slice(0, 25)) {
    console.log(`  ${String(entry.count).padStart(5)}  ${key}`);
  }
  let printed = 0;
  const seen = new Set();
  console.log('');
  console.log(`样例（每类最多 ${SAMPLES} 条）:`);
  for (const [key] of sorted) {
    const kind = key.split('  →  ')[1].split(' | ')[1] ?? key;
    if (seen.has(kind)) {
      continue;
    }
    seen.add(kind);
    console.log(`  ${key.replace(/\n/g, ' ')}`);
    printed += 1;
    if (printed >= 12) {
      break;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
