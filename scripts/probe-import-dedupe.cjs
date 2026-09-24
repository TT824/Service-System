'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * 真数据探针：把**被清掉的那 99 行重复**重新喂给导入计划，看它是不是恰好拦下它们。
 *
 *   node scripts/probe-import-dedupe.cjs [还原文件路径]
 *
 * 为什么要有这个东西：`product-import-plan.spec.ts` 用的是手写的行，`dedupe-product-skus.cjs`
 * 用的是 SQL 分组 —— 两边都对，也都可能一起错在一个没人想到的地方（比如「同一个商品」在
 * 计划里是按 `product_code` 认的，在 SQL 里是按 `spu_id` 认的）。这里走的是**真路**：
 *
 *   还原文件里的真实行（= 已经被判为重复的那些）
 *     + 当前库里真实的商品与规格（= 基准行还在）
 *     → 真的 `planProductImport`
 *
 * 预期（**两个方向都要看**，只看一边的量具会漏掉一半的错）：
 *
 * 1. **正面**：那 99 行 → **99 条 `duplicate_variant`、0 条写指令**。少了说明规则漏，
 *    那些行会被灌回来。
 * 2. **反面**：库里剩下的**全部**真实规格（14,897 行，其中含 134 组同规格不同货）
 *    当成一个**全新门店**整表导入（`existing` 全空，于是每一行都走新建、都要过孪生检查）
 *    → **0 条拒绝**。有拒绝说明规则太宽，那 134 组会被误杀（见 `sku-duplicate.ts`）。
 *
 * 只读：不写库、不建文件。判据读的是 `@kefu/core` 的**构建产物**，改完 core 先
 * `npm run build:packages`。
 */

const fs = require('node:fs');
const path = require('node:path');

const { Client } = require('pg');
const dotenv = require('dotenv');

const { planProductImport } = require('@kefu/core');

const ROOT_ENV_PATH = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ROOT_ENV_PATH)) {
  dotenv.config({ path: ROOT_ENV_PATH });
}

const DEFAULT_UNDO = path.resolve(
  __dirname,
  '..',
  '..',
  'product-skus-去重备份-2026-09-20.json',
);

/** 一张 `product_spus` 行 → 计划要的商品字段（只取计划真的读的那几个）。 */
function toSpu(row) {
  return { id: row.id, productCode: row.product_code };
}

/** 一张 `product_skus` 行 → 计划要的规格字段。 */
function toSku(row) {
  return {
    id: row.id,
    spuId: row.spu_id,
    skuCode: row.sku_code,
    variant: row.variant_json ?? {},
  };
}

/** 一张被删的 `product_skus` 行 → 一行「文件里读到的」预览行。 */
function toPreviewRow(row, productCode, rowNumber) {
  return {
    rowNumber,
    spu: {
      productCode,
      title: productCode,
      categoryCode: null,
      externalProductId: null,
      subtitle: null,
      productUrl: null,
      mainImageUrl: null,
      sellingPoints: [],
      commonAttributes: {},
      shelfStatus: 'unknown',
      sourceUpdatedAt: null,
    },
    sku: {
      skuCode: row.sku_code,
      variant: row.variant_json ?? {},
      searchAttributes: row.search_attributes_json ?? {},
      status: row.status,
    },
  };
}

async function main() {
  const undoPath = process.argv[2] ?? DEFAULT_UNDO;
  const undo = JSON.parse(fs.readFileSync(undoPath, 'utf8'));
  const deleted = undo.productSkus ?? [];
  const tenantId = deleted[0]?.tenant_id;
  const storeId = deleted[0]?.store_id;
  if (tenantId === undefined) {
    throw new Error(`${undoPath} 里没有可用的行`);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const spus = await client.query(
      `SELECT id, product_code FROM product_spus WHERE tenant_id = $1 AND store_id = $2`,
      [tenantId, storeId],
    );
    const skus = await client.query(
      `SELECT id, spu_id, sku_code, variant_json FROM product_skus
        WHERE tenant_id = $1 AND store_id = $2`,
      [tenantId, storeId],
    );
    const codeById = new Map(spus.rows.map((row) => [row.id, row.product_code]));

    const missing = deleted.filter((row) => !codeById.has(row.spu_id));
    const rows = deleted
      .filter((row) => codeById.has(row.spu_id))
      .map((row, index) => toPreviewRow(row, codeById.get(row.spu_id), index + 1));

    const plan = planProductImport({
      rows,
      categories: [],
      existingSpus: spus.rows.map(toSpu),
      existingSkus: skus.rows.map(toSku),
    });

    const byCode = new Map();
    for (const rejection of plan.rejections) {
      byCode.set(rejection.errorCode, (byCode.get(rejection.errorCode) ?? 0) + 1);
    }
    console.log(`探针：喂入被删的 ${deleted.length} 行（其中 ${missing.length} 行找不到所属商品，已跳过）`);
    console.log(`  计划：商品写 ${plan.spuWrites.length}、规格写 ${plan.skuWrites.length}、拒绝 ${plan.rejections.length}`);
    console.log(`  拒因：${[...byCode].map(([code, n]) => `${code}=${n}`).join('、') || '（无）'}`);
    console.log(`  库里：${spus.rows.length} 个商品、${skus.rows.length} 条规格`);
    const okBlocked =
      plan.skuWrites.length === 0 && byCode.get('duplicate_variant') === rows.length;
    console.log(
      okBlocked
        ? '  ✅ 全部被拦下，且没有别的拒因'
        : '  ❌ 与预期不符（应当是全部 duplicate_variant、0 条写入）',
    );

    // 反面：同样的行、但是一个**全新门店**整表导入 —— 每一行都要过孪生检查，预期一条都不拦。
    const freshRows = skus.rows
      .filter((row) => codeById.has(row.spu_id))
      .map((row, index) => toPreviewRow(row, codeById.get(row.spu_id), index + 1));
    const freshPlan = planProductImport({
      rows: freshRows,
      categories: [],
      existingSpus: [],
      existingSkus: [],
    });
    const freshByCode = new Map();
    for (const rejection of freshPlan.rejections) {
      freshByCode.set(rejection.errorCode, (freshByCode.get(rejection.errorCode) ?? 0) + 1);
    }
    console.log(
      `反面：把库里 ${freshRows.length} 条真实规格当全新门店整表导入 → 新建 ${freshPlan.skuWrites.length}、拒绝 ${freshPlan.rejections.length}`,
    );
    console.log(
      `  拒因：${[...freshByCode].map(([code, n]) => `${code}=${n}`).join('、') || '（无）'}`,
    );
    const okClean = freshPlan.rejections.length === 0 && freshPlan.skuWrites.length === freshRows.length;
    console.log(okClean ? '  ✅ 一条都没误杀' : '  ❌ 误杀了真商品（那 134 组同色不同货就在里面）');

    process.exitCode = okBlocked && okClean ? 0 : 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`probe-import-dedupe: ${error.message}`);
  process.exitCode = 1;
});
