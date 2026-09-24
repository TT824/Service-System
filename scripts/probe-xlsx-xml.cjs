/* eslint-disable @typescript-eslint/no-require-imports -- 一次性诊断脚本（CommonJS 入口）。 */

/**
 * 一次性探针（XML 直读版）：把一份大 xlsx 的**前几行**与**列布局**打出来。
 *
 * 为什么不用 exceljs：5.6 MB 的 xlsx 解出来 `sheet1.xml` 有 47 MB、23330 行 × 53 列，
 * exceljs 把整棵树读进内存再遍历，在这份文件上跑不出来。判断「这份表长什么样」只需要
 * 表头与前几行，所以直接流式读 XML 的前若干字节就够。
 *
 * 用法：node scripts/probe-xlsx-xml.cjs <解压后的目录> [行数]
 */
const fs = require('node:fs');
const path = require('node:path');

const HEAD_BYTES = 3 * 1024 * 1024;
const MAX_CELL = 60;

/** 读 `xl/sharedStrings.xml`，按出现顺序给出字符串表（xlsx 的 `t="s"` 指向它）。 */
function readSharedStrings(dir) {
  const file = path.join(dir, 'xl', 'sharedStrings.xml');
  if (!fs.existsSync(file)) return [];
  const xml = fs.readFileSync(file, 'utf8');
  const strings = [];
  for (const item of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [...item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => match[1]);
    strings.push(decode(texts.join('')));
  }
  return strings;
}

/** xlsx 的文本是 XML 转义过的，且换行/制表符是 `_x000D_` 这类占位。 */
function decode(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/_x000D_/g, ' ')
    .replace(/_x000A_/g, ' ');
}

/** `r="CF12"` → 列号 0 起的下标；`CF` = 84。 */
function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function main() {
  const dir = process.argv[2];
  const wanted = Number(process.argv[3] ?? 8);
  const sheetFile = path.join(dir, 'xl', 'worksheets', 'sheet1.xml');
  const shared = readSharedStrings(dir);
  console.log(`共享字符串表: ${shared.length} 条`);

  const bytes = fs.readFileSync(sheetFile).subarray(0, HEAD_BYTES).toString('utf8');
  const rows = [...bytes.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)];
  console.log(`读到前 ${rows.length} 行的 XML（共截取 ${HEAD_BYTES} 字节）\n`);

  const grid = [];
  for (const row of rows.slice(0, wanted)) {
    const cells = [];
    for (const cell of row[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cell[2];
      const body = /<v>([\s\S]*?)<\/v>/.exec(cell[3])?.[1] ?? '';
      const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[3])?.[1];
      let value = '';
      if (inline !== undefined) value = decode(inline);
      else if (attributes.includes('t="s"')) value = shared[Number(body)] ?? `#${body}`;
      else value = decode(body);
      cells[columnIndex(cell[1])] = value.slice(0, MAX_CELL);
    }
    grid.push({ rowNumber: Number(row[1]), cells });
  }

  const width = Math.max(...grid.map((row) => row.cells.length));
  const header = grid[0];
  console.log('=== 第 1 行按列 ===');
  for (let index = 0; index < width; index += 1) {
    const name = header?.cells[index] ?? '';
    if (name.length > 0) console.log(`  [${index}] ${name}`);
  }

  console.log('\n=== 前几行取值（按列号） ===');
  for (const row of grid.slice(0, wanted)) {
    console.log(`\n第 ${row.rowNumber} 行:`);
    for (let index = 0; index < width; index += 1) {
      const value = row.cells[index];
      if (value !== undefined && value.length > 0) console.log(`  [${index}] ${value}`);
    }
  }
}

main();
