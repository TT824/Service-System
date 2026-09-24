'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * 把 `prepare-real-catalog.cjs` 整理出来的分片导进真实目录（走真 API，不直连库）。
 *
 *   node scripts/import-real-catalog.cjs <出参目录> --preview   只预览第一个分片
 *   node scripts/import-real-catalog.cjs <出参目录> --apply     建类目 + 逐片导入
 *
 * 顺序是有意的：**先建类目**。导入计划对认不出的 `category_code` 是**整组拒绝**
 * （`category_not_found`），所以类目必须在商品之前就在库里。
 *
 * 分片的表头已经是我们的字段名，因此**不带 mapping** —— 带上反而会把列改错名。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  store: 'store-acme-flagship',
  tenant: 'tenant-acme',
  member: 'u-platform-admin',
  api: 'http://127.0.0.1:3000',
};

function parseArgs(argv) {
  const options = {};
  let outDir = null;
  let mode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--preview' || token === '--apply') {
      mode = token.slice(2);
    } else if (token.startsWith('--')) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} 需要值`);
      options[token.slice(2)] = value;
      index += 1;
    } else {
      outDir = token;
    }
  }
  if (outDir === null || mode === null) {
    throw new Error('用法: node scripts/import-real-catalog.cjs <出参目录> [--preview|--apply]');
  }
  return { outDir, mode, options };
}

async function postJson(api, pathname, body, headers) {
  const response = await fetch(`${api}/api/v1${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return { status: response.status, body: parsed };
}

async function upload(api, pathname, file, store, headers) {
  const form = new FormData();
  form.append('storeId', store);
  form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  const response = await fetch(`${api}/api/v1${pathname}`, { method: 'POST', headers, body: form });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
}

async function main() {
  const { outDir, mode, options } = parseArgs(process.argv.slice(2));
  const store = options.store ?? DEFAULTS.store;
  const tenant = options.tenant ?? DEFAULTS.tenant;
  const member = options.member ?? DEFAULTS.member;
  const api = (options.api ?? DEFAULTS.api).replace(/\/$/, '');
  const headers = { 'x-member-id': member, 'x-tenant-id': tenant };

  const shardDir = path.join(outDir, 'shards');
  const shards = fs
    .readdirSync(shardDir)
    .filter((name) => name.endsWith('.csv'))
    .sort()
    .map((name) => path.join(shardDir, name));

  if (mode === 'preview') {
    for (const shard of shards) {
      const { status, body } = await upload(
        api,
        '/knowledge/import-batches/preview',
        shard,
        store,
        headers,
      );
      const data = body.data ?? {};
      console.log(`${path.basename(shard)} HTTP=${status}`);
      console.log(`  summary: ${JSON.stringify(data.summary)}`);
      const issues = data.issues ?? [];
      console.log(`  issues: ${issues.length}`);
      for (const issue of issues.slice(0, 8)) {
        console.log(`    · [${issue.code}] 第 ${issue.rowNumber ?? '?'} 行 ${issue.message}`);
      }
    }
    return;
  }

  const categories = JSON.parse(fs.readFileSync(path.join(outDir, 'categories.json'), 'utf8'));
  let created = 0;
  let existed = 0;
  for (const category of categories) {
    const { status } = await postJson(
      api,
      '/knowledge/categories',
      { storeId: store, code: category.code, name: category.name },
      headers,
    );
    if (status === 201) created += 1;
    else if (status === 409) existed += 1;
    else throw new Error(`建类目 ${category.code} 失败: HTTP ${status}`);
  }
  console.log(`类目: 新建 ${created}，已存在 ${existed}，合计 ${categories.length}`);

  const totals = {
    rows: 0,
    createdSpu: 0,
    updatedSpu: 0,
    createdSku: 0,
    updatedSku: 0,
    rejected: 0,
    unreadable: 0,
    errors: 0,
  };
  for (const shard of shards) {
    const { status, body } = await upload(
      api,
      '/knowledge/import-batches/apply',
      shard,
      store,
      headers,
    );
    const data = body.data ?? {};
    const summary = data.summary ?? {};
    console.log(
      `${path.basename(shard)} HTTP=${status} 批次=${data.batch?.id} 状态=${data.batch?.status}`,
    );
    console.log(`  ${JSON.stringify(summary)}`);
    totals.rows += summary.totalRows ?? 0;
    totals.createdSpu += summary.createdSpuCount ?? 0;
    totals.updatedSpu += summary.updatedSpuCount ?? 0;
    totals.createdSku += summary.createdSkuCount ?? 0;
    totals.updatedSku += summary.updatedSkuCount ?? 0;
    totals.rejected += summary.rejectedRowCount ?? 0;
    totals.unreadable += summary.unreadableRowCount ?? 0;
    totals.errors += (data.errors ?? []).length;
    for (const error of (data.errors ?? []).slice(0, 5)) {
      console.log(`    · 第 ${error.rowNumber ?? '?'} 行 ${error.fieldName} ${error.errorMessage}`);
    }
  }
  console.log(`\n合计: ${JSON.stringify(totals)}`);
}

main().catch((error) => {
  console.error(`import-real-catalog: ${error.message}`);
  process.exitCode = 1;
});
