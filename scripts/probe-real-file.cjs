/* eslint-disable @typescript-eslint/no-require-imports -- 一次性诊断脚本（CommonJS 入口）。 */

/**
 * 一次性探针：拿**真实的商户文件**过一遍线上那条解析路径，看它到底怎么回话。
 *
 * 与「读代码推断」的区别：这里调的就是端点调的那个 `parseProductImportFile`，
 * 所以打印出来的是商户上传后真正会拿到的结论。
 *
 * 用法：node scripts/probe-real-file.cjs <文件路径>
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseProductImportFile } = require('@kefu/core');

async function main() {
  const file = process.argv[2];
  const content = fs.readFileSync(file);
  console.log(`文件: ${path.basename(file)}  ${content.byteLength} 字节`);
  console.log(
    `压缩后 / 10 MiB 上限 = ${((content.byteLength / (10 * 1024 * 1024)) * 100).toFixed(1)}%\n`,
  );

  const started = Date.now();
  const result = await parseProductImportFile({ format: 'xlsx', content });
  const elapsed = Date.now() - started;

  console.log(`耗时: ${elapsed} ms`);
  console.log(`summary: ${JSON.stringify(result.summary, null, 2)}`);
  console.log(`previewRows: ${result.previewRows.length} 行`);
  console.log(`issues: ${result.issues.length} 条`);
  const byCode = new Map();
  for (const issue of result.issues) {
    byCode.set(issue.code, (byCode.get(issue.code) ?? 0) + 1);
  }
  console.log('\n按错误码统计:');
  for (const [code, count] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code}: ${count}`);
  }
  console.log('\n前 8 条 issue:');
  for (const issue of result.issues.slice(0, 8)) {
    console.log(
      `  [${issue.severity}] ${issue.code} 行=${issue.rowNumber ?? '-'} 列=${issue.column ?? '-'} ` +
        `字段=${issue.field ?? '-'} :: ${issue.message}`,
    );
  }
}

main().catch((error) => {
  console.error(`探针失败: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
