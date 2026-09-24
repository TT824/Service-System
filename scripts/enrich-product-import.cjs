'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- 商户数据整理工具（CommonJS 入口）。 */

/**
 * 把商户的商品表整理成**带属性**的可上传文件。
 *
 * 商户的表只有编码和名称可映射，其余列（分类、品牌、颜色、售价、库存）进不了库，
 * 于是大模型只能看见商品标题 —— 顾客问「多少钱」「有红色的吗」就答不出来。
 * 这个脚本把那几列转成属性列（JSON），产出一份**表头就是我们的字段名**的 CSV，
 * 直接上传即可，不需要再带 mapping。
 *
 * 白名单，不是黑名单 —— 只有下面列出的列会被读出：
 *   通用属性(SPU)  品牌、分类
 *   规格属性(SKU)  颜色、规格
 *   检索属性(SKU)  品牌、分类、颜色、规格、颜色规格、售价、吊牌价、库存
 * **成本价、批发供货价、店加价格、商品标签一律不读**，因此它们不可能出现在知识库里，
 * 也就不会被答给顾客。这是安全属性，不是省事：黑名单漏一个列名就漏一次底价。
 * （`材质`/`单位` 也不读 —— 实测这两列被商户填成了「直播价30元2只」「400/箱」这类别的东西，
 * 与其猜，不如不收。）
 *
 * 占位行（编码以下划线开头的 `_____YF____`、`__check__` 这类）会剔掉：它们不是商品。
 *
 * 用法：node scripts/enrich-product-import.cjs <商品表.xlsx> [--out <目录>]
 */

const fs = require('node:fs');
const path = require('node:path');

const ExcelJS = require('exceljs');

/** 表头 → 我们读它的用途。列名改了要在这里改。 */
const COLUMNS = {
  product_code: '款式编码',
  sku_code: '商品编码',
  title: '商品名称',
  brand: '品牌',
  category: '分类',
  color: '颜色',
  variant: '规格',
  color_spec: '颜色及规格',
  price: '基本售价',
  tag_price: '市场|吊牌价',
  stock: '实际库存数',
};

/** 表头行里我们认识的列，按这个顺序找。 */
const HEADER_LOOKUP = Object.entries(COLUMNS);

/** 单元格取值：公式取结果、富文本拼文本、日期转 ISO 日期，其余原样。 */
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.richText)
      return value.richText
        .map((part) => part.text)
        .join('')
        .trim();
    if (value.text !== undefined) return String(value.text).trim();
    if (value.result !== undefined) return String(value.result).trim();
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).trim();
  }
  return String(value).trim();
}

/** 数字去掉没意义的尾零（33.40 → 33.4），非数字原样返回。 */
function numberText(text) {
  if (text === '') return '';
  const value = Number(text);
  return Number.isFinite(value) ? String(value) : text;
}

/**
 * 组一个属性对象，丢掉空值。
 *
 * @param {Record<string, string>} entries - 属性名 → 值。
 * @returns {string} JSON 字符串，全空时返回空串（该列留空，不写 `{}`）。
 */
function attributes(entries) {
  const kept = Object.entries(entries).filter(([, value]) => value !== '');
  return kept.length === 0 ? '' : JSON.stringify(Object.fromEntries(kept));
}

/** CSV 单元格：含逗号、引号、换行时用引号包裹，内部引号翻倍。 */
function csvCell(value) {
  const text = value ?? '';
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((token) => !token.startsWith('--'));
  if (file === undefined) {
    throw new Error('用法: node scripts/enrich-product-import.cjs <商品表.xlsx> [--out <目录>]');
  }
  if (!fs.existsSync(file)) throw new Error(`找不到文件: ${file}`);
  const outIndex = argv.indexOf('--out');
  const outDir = outIndex >= 0 ? argv[outIndex + 1] : path.dirname(file);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  if (sheet === undefined) throw new Error('工作簿里没有工作表');

  // 表头 → 列号。找不到的列记下来，最后一起说，不静默少读一列。
  const columnOf = {};
  const missing = [];
  const header = sheet.getRow(1);
  for (const [key, label] of HEADER_LOOKUP) {
    let found = 0;
    header.eachCell((cell, index) => {
      if (cellText(cell.value) === label) found = index;
    });
    if (found === 0) missing.push(label);
    else columnOf[key] = found;
  }

  const rows = [];
  const stats = {
    total: 0,
    placeholder: 0,
    noCode: 0,
    withBrand: 0,
    withColor: 0,
    withPrice: 0,
    withStock: 0,
  };

  sheet.eachRow((row, line) => {
    if (line === 1) return;
    const pick = (key) =>
      columnOf[key] === undefined ? '' : cellText(row.getCell(columnOf[key]).value);
    const productCode = pick('product_code');
    const skuCode = pick('sku_code');
    stats.total += 1;

    // 占位行不是商品：ERP 每次导出都带着它们。
    if (productCode.startsWith('_') || skuCode.startsWith('_')) {
      stats.placeholder += 1;
      return;
    }
    if (productCode === '' || skuCode === '') {
      stats.noCode += 1;
      return;
    }

    const brand = pick('brand');
    const category = pick('category');
    const color = pick('color');
    const variant = pick('variant');
    const colorSpec = pick('color_spec');
    const price = numberText(pick('price'));
    const tagPrice = numberText(pick('tag_price'));
    const stock = numberText(pick('stock'));

    if (brand !== '') stats.withBrand += 1;
    if (color !== '' || colorSpec !== '') stats.withColor += 1;
    if (price !== '') stats.withPrice += 1;
    if (stock !== '') stats.withStock += 1;

    rows.push({
      product_code: productCode,
      sku_code: skuCode,
      title: pick('title'),
      common_attributes: attributes({ 品牌: brand, 分类: category }),
      sku_attributes: attributes({ 颜色: color, 规格: variant }),
      search_attributes: attributes({
        品牌: brand,
        分类: category,
        颜色: color,
        规格: variant,
        颜色规格: colorSpec,
        售价: price,
        吊牌价: tagPrice,
        库存: stock,
      }),
    });
  });

  const headers = [
    'product_code',
    'sku_code',
    'title',
    'common_attributes',
    'sku_attributes',
    'search_attributes',
  ];
  const csv = `${[headers, ...rows.map((row) => headers.map((key) => row[key]))]
    .map((line) => line.map(csvCell).join(','))
    .join('\n')}\n`;

  const outFile = path.join(outDir, `${path.basename(file, path.extname(file))}-带属性.csv`);
  fs.writeFileSync(outFile, csv, 'utf8');

  console.log(`输入: ${path.basename(file)}  （${stats.total} 数据行）`);
  if (missing.length > 0) console.log(`⚠ 表里没有这些列，已跳过: ${missing.join('、')}`);
  console.log(`剔占位行: ${stats.placeholder}   缺编码: ${stats.noCode}   可导入: ${rows.length}`);
  console.log(
    `带属性: 品牌 ${stats.withBrand} · 颜色/规格 ${stats.withColor} · 售价 ${stats.withPrice} · 库存 ${stats.withStock}`,
  );
  console.log(`不读取: 成本价、批发供货价、店加价格、商品标签、材质、单位（白名单外）`);
  console.log(`产出: ${outFile}`);
}

main().catch((error) => {
  console.error(`enrich-product-import: ${error.message}`);
  process.exitCode = 1;
});
