'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * 把商家 ERP 导出的商品工作簿整理成「可直接导入」的 CSV 分片（离线，不连库）。
 *
 *   node scripts/prepare-real-catalog.cjs <出参目录> <工作簿.xlsx> [更多工作簿...]
 *
 * 出的东西：
 *   shards/shard-01.csv …   表头是我们的字段名 ⇒ 上传时用 `--no-map`
 *   categories.json         去重后的叶子类目（要在导入**之前**建好，见 plan 的 category_not_found）
 *   报告.txt                行数账：读了多少、丢了什么、为什么丢
 *
 * 三处取舍写在代码里、不藏在报告里：
 * 1. 只取用得上的列（商品名称/图片/两级编码/颜色/规格/售价/分类/修改时间），
 *    **成本价、库存、体积重量、供应商这些一律不取**。
 * 2. 形状：SPU=款式编码，SKU=商品编码，主图取该款式第一张有图的行；`variant_json`
 *    里放 `颜色/规格/售价`（SKU 表没有独立的图片列，逐 SKU 图的取舍见报告）。
 *    属性写成 **JSON** 而不是 `key=value;key=value`：这份数据里「规格」单元格自己就带
 *    分号（`L (95-120斤);XL (120-140斤)`），用分号当分隔符会被解析器判成非法属性片段
 *    （实测：5000 行里有 20 行因此被丢），JSON 没有这个歧义。
 * 3. 丢掉 ERP 的占位行（编码以 `_` 开头，如 `_____FSLW____` 邮费行），
 *    并按 SKU 编码全局去重 —— 解析器对重复 SKU 编码是**整组丢**，不是留一条。
 */

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

/** 每个分片的数据行上限，与 `MAX_PRODUCT_IMPORT_DATA_ROWS` 一致。 */
const SHARD_ROWS = 5000;

const COLUMNS = {
  image: '图片',
  style: '款式编码',
  item: '商品编码',
  title: '商品名称',
  color: '颜色',
  spec: '规格',
  price: '基本售价',
  category: '分类',
  updatedAt: '修改时间',
};

/** 单元格取文本：富文本/公式/超链接都还原成字符串。 */
function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map((part) => part.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    return '';
  }
  return String(value);
}

/** Excel 对 `+ = _` 的转义（`_x002B_` → `+`）：URL 与颜色值里都有。 */
function unescapeExcel(raw) {
  return raw.replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** 清洗一个单元格。 */
function clean(value) {
  return unescapeExcel(text(value)).trim();
}

function csvCell(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function categoryLeaf(raw) {
  const parts = raw
    .split(/[-/＞>]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

function isoDate(raw) {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(raw.trim());
  if (match === null) return '';
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

async function readSheets(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  const header = sheet.getRow(1);
  const index = {};
  header.eachCell({ includeEmpty: true }, (cell, column) => {
    index[text(cell.value).trim()] = column;
  });
  for (const [key, name] of Object.entries(COLUMNS)) {
    if (index[name] === undefined) throw new Error(`${path.basename(file)} 缺少列「${name}」`);
    index[key] = index[name];
  }
  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const value = (key) => clean(row.getCell(index[key]).value);
    const style = value('style');
    const item = value('item');
    const title = value('title');
    if (style === '' && item === '' && title === '') continue;
    rows.push({
      style,
      item,
      title,
      image: value('image'),
      color: value('color'),
      spec: value('spec'),
      price: value('price'),
      category: value('category'),
      updatedAt: value('updatedAt'),
    });
  }
  return rows;
}

async function main() {
  const [outDir, ...files] = process.argv.slice(2);
  if (outDir === undefined || files.length === 0) {
    throw new Error('用法: node scripts/prepare-real-catalog.cjs <出参目录> <工作簿.xlsx> ...');
  }

  const report = [];
  const seenSku = new Set();
  const spus = new Map();
  const categories = new Map();
  let read = 0;
  let droppedJunk = 0;
  let droppedDuplicate = 0;
  let droppedNoTitle = 0;

  for (const file of files) {
    const rows = await readSheets(file);
    read += rows.length;
    let kept = 0;
    for (const row of rows) {
      // ERP 占位行（邮费/测试）：编码以 `_` 开头，不是商品。
      if (row.style.startsWith('_') || row.item.startsWith('_')) {
        droppedJunk += 1;
        continue;
      }
      if (row.item === '' || row.title === '') {
        droppedNoTitle += 1;
        continue;
      }
      if (seenSku.has(row.item)) {
        droppedDuplicate += 1;
        continue;
      }
      seenSku.add(row.item);
      kept += 1;

      const leaf = categoryLeaf(row.category);
      if (leaf !== '') categories.set(leaf, (categories.get(leaf) ?? 0) + 1);

      let spu = spus.get(row.style);
      if (spu === undefined) {
        spu = { title: row.title, image: '', category: leaf, rows: [], images: new Set() };
        spus.set(row.style, spu);
      }
      if (spu.image === '' && row.image !== '') spu.image = row.image;
      if (row.image !== '') spu.images.add(row.image);
      if (spu.title === '') spu.title = row.title;
      const attributes = {};
      if (row.color !== '') attributes['颜色'] = row.color;
      if (row.spec !== '') attributes['规格'] = row.spec;
      // 售价是顾客最常问的一条，留着；成本价/库存/体积重量一律不取。
      if (row.price !== '' && row.price !== '0') attributes['售价'] = row.price;
      spu.rows.push({
        product_code: row.style,
        sku_code: row.item,
        title: spu.title,
        main_image_url: spu.image,
        category_code: spu.category,
        sku_attributes: Object.keys(attributes).length === 0 ? '' : JSON.stringify(attributes),
        source_updated_at: isoDate(row.updatedAt),
      });
    }
    report.push(`  ${path.basename(file)}: 读 ${rows.length} 行，留下 ${kept} 行`);
  }

  // 主图是 SPU 级字段，第二轮回填（第一行可能没有图）。
  const records = [];
  let spuWithoutImage = 0;
  let spuWithSeveralImages = 0;
  for (const spu of spus.values()) {
    if (spu.image === '') spuWithoutImage += 1;
    if (spu.images.size > 1) spuWithSeveralImages += 1;
    for (const record of spu.rows) {
      record.main_image_url = spu.image;
      records.push(record);
    }
  }

  const shardDir = path.join(outDir, 'shards');
  fs.mkdirSync(shardDir, { recursive: true });
  const header =
    'product_code,sku_code,title,main_image_url,category_code,sku_attributes,source_updated_at\n';
  let shardCount = 0;
  for (let start = 0; start < records.length; start += SHARD_ROWS) {
    const slice = records.slice(start, start + SHARD_ROWS);
    const body = slice
      .map((record) =>
        [
          record.product_code,
          record.sku_code,
          record.title,
          record.main_image_url,
          record.category_code,
          record.sku_attributes,
          record.source_updated_at,
        ]
          .map(csvCell)
          .join(','),
      )
      .join('\n');
    shardCount += 1;
    const name = `shard-${String(shardCount).padStart(2, '0')}.csv`;
    fs.writeFileSync(path.join(shardDir, name), header + body + '\n', 'utf8');
  }

  const categoryList = [...categories.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({ code, name: code, count }));
  fs.writeFileSync(
    path.join(outDir, 'categories.json'),
    JSON.stringify(categoryList, null, 2),
    'utf8',
  );

  const lines = [
    `工作簿: ${files.map((file) => path.basename(file)).join(', ')}`,
    ...report,
    `读入合计: ${read}`,
    `丢掉 · ERP 占位行: ${droppedJunk}`,
    `丢掉 · 缺标题/编码: ${droppedNoTitle}`,
    `丢掉 · 跨文件重复 SKU 编码: ${droppedDuplicate}`,
    `SPU（款式）: ${spus.size}   SKU（商品）: ${records.length}`,
    `主图覆盖: SPU 有图 ${spus.size - spuWithoutImage} / 无图 ${spuWithoutImage}`,
    `同一款式多图（只取第一张当主图）: ${spuWithSeveralImages}`,
    `叶子类目: ${categoryList.length}`,
    `分片: ${shardCount} 个，每个 ≤ ${SHARD_ROWS} 行 → ${shardDir}`,
  ];
  fs.writeFileSync(path.join(outDir, '报告.txt'), lines.join('\n') + '\n', 'utf8');
  console.log(lines.join('\n'));
  console.log(
    `\n类目前 10: ${categoryList
      .slice(0, 10)
      .map((c) => `${c.code}(${c.count})`)
      .join(' ')}`,
  );
}

main().catch((error) => {
  console.error(`prepare-real-catalog: ${error.message}`);
  process.exitCode = 1;
});
