/* eslint-disable @typescript-eslint/no-require-imports -- 一次性诊断脚本（CommonJS 入口）。 */

/**
 * 一次性探针：回答「哪些行不是商品、能不能用脚本机械地挑出来」。
 *
 * 不看代码推断，直接数**整份**真文件（23330 行）里各类异常行的数量与长相：
 * 空 `款式编码` 的行到底是占位行、稀疏填充，还是另一种东西 —— 三者的处置完全不同，
 * 数量级差一个就能决定「规则」还是「猜」。
 *
 * 用法：unzip -o -q <xlsx> -d <目录> && node scripts/probe-tidy.cjs <目录>
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_CELL = 40;

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

function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function main() {
  const dir = process.argv[2];
  const shared = readSharedStrings(dir);
  const xml = fs.readFileSync(path.join(dir, 'xl', 'worksheets', 'sheet1.xml'), 'utf8');

  const rows = [];
  for (const row of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of row[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cell[2];
      const body = /<v>([\s\S]*?)<\/v>/.exec(cell[3])?.[1] ?? '';
      const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[3])?.[1];
      let value;
      if (inline !== undefined) value = decode(inline);
      else if (attributes.includes('t="s"')) value = shared[Number(body)] ?? `#${body}`;
      else value = decode(body);
      cells[columnIndex(cell[1])] = value.slice(0, MAX_CELL);
    }
    rows.push({ rowNumber: Number(row[1]), cells });
  }

  const header = rows[0].cells;
  const indexOf = (name) => header.findIndex((cell) => cell === name);
  const STYLE = indexOf('款式编码');
  const SKU = indexOf('商品编码');
  // 真文件的表头是「商品名称」，「商品标题」只在测试夹具里有。两个都认 ——
  // 只认一个的话，读空列会打印成一整片空标题，看起来像「这批行没有标题」，其实是探针找错了列。
  const TITLE = indexOf('商品名称') === -1 ? indexOf('商品标题') : indexOf('商品名称');
  const COLOR = indexOf('颜色');
  console.log(`总行数 ${rows.length}（含表头）  表头列数 ${header.filter(Boolean).length}`);
  console.log(
    `款式编码=列${STYLE}  商品编码=列${SKU}  商品名称/标题=列${TITLE}  颜色=列${COLOR}\n`,
  );

  const data = rows.slice(1);
  const styleEmpty = data.filter((row) => (row.cells[STYLE] ?? '').length === 0);
  const skuEmpty = data.filter((row) => (row.cells[SKU] ?? '').length === 0);
  console.log(`数据行 ${data.length}`);
  console.log(`  款式编码为空: ${styleEmpty.length}`);
  console.log(`  商品编码为空: ${skuEmpty.length}\n`);

  // 1) 空款式编码的行号分布：连续成块=稀疏填充/分组标题，零散=真异常
  const numbers = styleEmpty.map((row) => row.rowNumber);
  const gaps = numbers.slice(1).map((value, index) => value - numbers[index]);
  const runs = gaps.filter((gap) => gap === 1).length + 1;
  console.log(`空款式编码行号: 前 30 个 ${numbers.slice(0, 30).join(',')}`);
  console.log(`  连续段数 ${runs}（${styleEmpty.length} 行 / ${runs} 段，越接近行数说明越零散）`);
  const gapHistogram = new Map();
  for (const gap of gaps) gapHistogram.set(gap, (gapHistogram.get(gap) ?? 0) + 1);
  const topGaps = [...gapHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`  相邻行号差 top: ${topGaps.map(([gap, n]) => `${gap}×${n}`).join('  ')}\n`);

  // 2) 这些行长什么样
  console.log('=== 空款式编码的行（前 15 条）===');
  for (const row of styleEmpty.slice(0, 15)) {
    console.log(
      `  行${row.rowNumber}  商品编码=[${row.cells[SKU] ?? ''}]  标题=[${row.cells[TITLE] ?? ''}]  颜色=[${row.cells[COLOR] ?? ''}]`,
    );
  }

  // 3) 商品编码的形态分类：占位/下划线开头/纯符号/正常
  const classes = new Map();
  for (const row of styleEmpty) {
    const code = row.cells[SKU] ?? '';
    const kind =
      code.length === 0
        ? '空'
        : /^_+/.test(code)
          ? '下划线开头'
          : /^[^A-Za-z0-9]+$/.test(code)
            ? '纯符号'
            : '看起来正常';
    classes.set(kind, (classes.get(kind) ?? 0) + 1);
  }
  console.log('\n=== 空款式编码行的商品编码形态 ===');
  for (const [kind, count] of [...classes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind}: ${count}`);
  }

  // 4) 标题分布：同一句话反复出现 = 商户自己的分组/合计行
  const titles = new Map();
  for (const row of styleEmpty) {
    const title = row.cells[TITLE] ?? '';
    titles.set(title, (titles.get(title) ?? 0) + 1);
  }
  console.log('\n=== 空款式编码行的标题 top 10 ===');
  for (const [title, count] of [...titles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${count}×  [${title}]`);
  }

  // 5) 全表键的唯一性：商品编码有没有重复（重复行=导出叠了版本）
  const skuCount = new Map();
  for (const row of data) {
    const code = row.cells[SKU] ?? '';
    if (code.length > 0) skuCount.set(code, (skuCount.get(code) ?? 0) + 1);
  }
  const duplicated = [...skuCount.values()].filter((count) => count > 1).length;
  console.log(`\n全表: 非空商品编码 ${skuCount.size} 个，其中重复出现的 ${duplicated} 个`);
  console.log(
    `全表: 非空款式编码 ${new Set(data.map((row) => row.cells[STYLE]).filter(Boolean)).size} 个`,
  );

  // 6) `_x002B_` 转义残留
  let escaped = 0;
  for (const row of data) {
    for (const cell of row.cells) if (cell && cell.includes('_x002B_')) escaped += 1;
  }
  console.log(`全表: 含 _x002B_ 的单元格 ${escaped} 个`);
}

main();
