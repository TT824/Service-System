'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Upload a merchant product workbook into the catalog, through the real API.
 *
 * Same endpoint the import panel calls, so what this proves is what the panel
 * would do — nothing is written to the database directly.
 *
 *   node scripts/import-products.cjs "C:/path/商品资料_3.xlsx" --preview
 *   node scripts/import-products.cjs "C:/path/商品资料_3.xlsx"
 *
 * Options: --store --tenant --member --api, --map <field>=<列名> (repeatable), and
 * --no-map for a file already shaped by `enrich-product-import.cjs` or
 * `tidy-product-import.cjs` — those carry our own field names as headers, and
 * passing the merchant mapping at them would rename the wrong columns.
 *
 * **The mapping is not optional in practice.** The parser's alias table maps
 * 商品编码 to `product_code`, and this merchant's workbooks carry two coding
 * levels — 款式编码 (the style) and 商品编码 (the item). Uploaded with no
 * mapping, every 商品编码 becomes its own product code and 款式编码 is ignored:
 * the import succeeds and is silently wrong. So the merchant's mapping is the
 * default here, and the run prints it before uploading.
 *
 * The request is built in Node rather than with curl because the filename and
 * the mapping are full of Chinese: curl on a Windows console re-encodes them
 * with the console code page.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  store: 'store-acme-flagship',
  tenant: 'tenant-acme',
  // Importing is a configurator action: the member must be merchant_admin or
  // platform_admin. The platform administrator also needs x-tenant-id, since
  // nothing about that member says which tenant it is acting in.
  member: 'u-platform-admin',
  api: 'http://127.0.0.1:3000',
};

/** 款式编码 is the style (SPU), 商品编码 the item (SKU), 商品名称 the title. */
const DEFAULT_MAPPING = {
  product_code: '款式编码',
  sku_code: '商品编码',
  title: '商品名称',
};

/**
 * Read the command line.
 *
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{file: string|null, options: Record<string, string>, mapping: Record<string, string>, preview: boolean}} Parsed invocation.
 */
function parseArgs(argv) {
  const options = {};
  const mapping = {};
  let file = null;
  let preview = false;
  let noMap = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--preview') {
      preview = true;
    } else if (token === '--no-map') {
      noMap = true;
    } else if (token === '--map') {
      const pair = argv[index + 1] ?? '';
      const [field, column] = pair.split('=');
      if (!field || !column) throw new Error('--map 需要 field=列名');
      mapping[field] = column;
      index += 1;
    } else if (token.startsWith('--')) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`option ${token} needs a value`);
      }
      options[token.slice(2)] = value;
      index += 1;
    } else {
      file = token;
    }
  }
  return { file, options, mapping, preview, noMap };
}

async function main() {
  const { file, options, mapping, preview, noMap } = parseArgs(process.argv.slice(2));
  if (file === null) {
    throw new Error(
      '用法: node scripts/import-products.cjs <文件.xlsx|.csv> [--preview] [--map field=列名]',
    );
  }
  if (!fs.existsSync(file)) throw new Error(`找不到文件: ${file}`);

  const store = options.store ?? DEFAULTS.store;
  const tenant = options.tenant ?? DEFAULTS.tenant;
  const member = options.member ?? DEFAULTS.member;
  const api = (options.api ?? DEFAULTS.api).replace(/\/$/, '');
  const columnMapping = noMap ? {} : Object.keys(mapping).length > 0 ? mapping : DEFAULT_MAPPING;
  const buffer = fs.readFileSync(file);
  const name = path.basename(file);

  console.log(`文件: ${name}（${(buffer.byteLength / 1024).toFixed(0)} KiB）`);
  console.log(`门店: ${store}  租户: ${tenant}  身份: ${member}`);
  console.log(
    `列映射: ${Object.keys(columnMapping).length === 0 ? '（无 —— 表头已是我们的字段名）' : JSON.stringify(columnMapping)}`,
  );
  console.log(`动作: ${preview ? '预览（不写库）' : '导入（写库）'}`);

  const form = new FormData();
  form.append('storeId', store);
  if (Object.keys(columnMapping).length > 0) {
    form.append('mapping', JSON.stringify(columnMapping));
  }
  form.append('file', new Blob([buffer]), name);

  const response = await fetch(
    `${api}/api/v1/knowledge/import-batches/${preview ? 'preview' : 'apply'}`,
    {
      method: 'POST',
      headers: { 'x-member-id': member, 'x-tenant-id': tenant },
      body: form,
    },
  );

  const body = await response.text();
  if (!response.ok) {
    console.error(`HTTP ${response.status}`);
    console.error(body.slice(0, 1500));
    process.exitCode = 1;
    return;
  }

  const envelope = JSON.parse(body);
  const data = envelope.data ?? envelope;
  if (preview) {
    console.log(`可读行: ${data.summary?.totalRows}  预览行: ${data.previewRows?.length}`);
    console.log(`summary: ${JSON.stringify(data.summary)}`);
    const issues = data.issues ?? [];
    console.log(`issues: ${issues.length}`);
    for (const issue of issues.slice(0, 10)) {
      console.log(
        `  · [${issue.code}] 第 ${issue.line ?? '?'} 行 ${issue.field ?? ''} ${issue.message ?? ''}`,
      );
    }
    return;
  }

  console.log(`批次: ${data.batch?.id}  状态: ${data.batch?.status}`);
  console.log(`summary: ${JSON.stringify(data.summary)}`);
  const errors = data.errors ?? [];
  console.log(`错误行: ${errors.length}`);
  for (const error of errors.slice(0, 5)) {
    console.log(`  · 第 ${error.line ?? '?'} 行 ${error.field ?? ''} ${error.message ?? ''}`);
  }
}

main().catch((error) => {
  console.error(`import-products: ${error.message}`);
  process.exitCode = 1;
});
