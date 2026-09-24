/* eslint-disable @typescript-eslint/no-require-imports -- 一次性诊断脚本（CommonJS 入口）。 */

/**
 * 一次性探针：把一份 xlsx 的**结构**打出来（表头、几行样例、每列填充率与取值样本）。
 *
 * 不整份打印：一份商品表可能有几千行，全量进上下文毫无必要 —— 判断「这份表长什么样」
 * 只需要表头 + 少量样例 + 每列的取值分布。
 *
 * 用法：node scripts/probe-xlsx.cjs <文件路径>
 */
const path = require('node:path');
const ExcelJS = require('exceljs');

const SAMPLE_ROWS = 5;
const SAMPLE_VALUES = 6;
const MAX_CELL = 48;

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map((part) => part.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return JSON.stringify(value).slice(0, MAX_CELL);
  }
  return String(value);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('用法: node scripts/probe-xlsx.cjs <文件路径>');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);

  console.log(`文件: ${path.basename(file)}`);
  console.log(`工作表数: ${workbook.worksheets.length}`);

  for (const sheet of workbook.worksheets) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`工作表「${sheet.name}」 行=${sheet.rowCount} 列=${sheet.columnCount}`);
    console.log('='.repeat(72));

    const rows = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const values = [];
      for (let index = 1; index <= sheet.columnCount; index += 1) {
        values.push(cell(row.getCell(index).value));
      }
      rows.push(values);
    });

    // 表头：第一行里有非空格子
    const headerIndex = rows.findIndex((values) => values.some((value) => value.length > 0));
    if (headerIndex === -1) {
      console.log('（整张表是空的）');
      continue;
    }
    const header = rows[headerIndex];
    console.log(`\n表头（第 ${headerIndex + 1} 行）:`);
    header.forEach((name, index) => {
      console.log(`  [${index}] ${name.length > 0 ? name : '（空表头）'}`);
    });

    const dataRows = rows.slice(headerIndex + 1);
    console.log(`\n数据行: ${dataRows.length}（含完全空行）`);

    console.log(`\n前 ${SAMPLE_ROWS} 行:`);
    dataRows.slice(0, SAMPLE_ROWS).forEach((values, index) => {
      const shown = values
        .map((value, at) => `${header[at] || at}=${value.slice(0, MAX_CELL)}`)
        .join(' | ');
      console.log(`  ${index + 1}. ${shown}`);
    });

    console.log('\n每列填充与取值分布:');
    header.forEach((name, index) => {
      const values = dataRows.map((row) => row[index] ?? '').filter((value) => value.length > 0);
      const distinct = [...new Set(values)];
      const samples = distinct.slice(0, SAMPLE_VALUES).map((value) => value.slice(0, MAX_CELL));
      console.log(
        `  [${index}] ${name || '（空表头）'}: 非空 ${values.length}/${dataRows.length}` +
          `，去重 ${distinct.length}` +
          (samples.length > 0 ? `，样例 ${JSON.stringify(samples)}` : ''),
      );
    });
  }
}

main().catch((error) => {
  console.error(`探针失败: ${error.message}`);
  process.exit(1);
});
