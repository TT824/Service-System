/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */
/*
 * 商品资料工作簿侦察（只读）。
 *
 * 回答三个问题：每个文件有哪些 sheet、表头长什么样、每列有多少非空值。
 * 只为「列映射」服务，不写任何东西到库。
 *
 * 用法：node scripts/catalog-recon.cjs "C:/Users/Administrator/Desktop/商品资料_1.xlsx" ...
 */
const path = require('node:path');
// Hoisted to the workspace root by npm workspaces.
const ExcelJS = require('exceljs');

const CELL_LIMIT = 60;

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map((part) => part.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (value.hyperlink !== undefined) return String(value.hyperlink);
    return JSON.stringify(value);
  }
  return String(value);
}

async function recon(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  console.log(`\n===== ${path.basename(file)} =====`);
  for (const sheet of workbook.worksheets) {
    const headers = [];
    const first = sheet.getRow(sheet.headerRowCount > 0 ? sheet.headerRowCount : 1);
    first.eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = text(cell.value).trim();
    });
    const dataStart = (sheet.headerRowCount > 0 ? sheet.headerRowCount : 1) + 1;
    const rows = sheet.rowCount;
    console.log(
      `\n--- sheet="${sheet.name}" 行数=${rows} 列数=${sheet.columnCount} 表头行=${dataStart - 1}`,
    );
    const filled = new Array(headers.length + 1).fill(0);
    const samples = new Array(headers.length + 1).fill(null);
    for (let r = dataStart; r <= rows; r += 1) {
      const row = sheet.getRow(r);
      for (let c = 1; c <= headers.length; c += 1) {
        const value = text(row.getCell(c).value).trim();
        if (value.length > 0) {
          filled[c] += 1;
          if (samples[c] === null) samples[c] = value;
        }
      }
    }
    for (let c = 1; c <= headers.length; c += 1) {
      const sample = samples[c] === null ? '(全空)' : samples[c].slice(0, CELL_LIMIT);
      console.log(
        `${String(c).padStart(3)} | ${(headers[c] || '(空表头)').slice(0, 24).padEnd(24)} | 非空 ${String(filled[c]).padStart(6)} | ${sample}`,
      );
    }
  }
}

async function main() {
  for (const file of process.argv.slice(2)) {
    await recon(file);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
