/* eslint-disable @typescript-eslint/no-require-imports -- 商户数据整理工具（CommonJS 入口）。 */

/**
 * 把商户的原始商品表整理成「能直接上传」的分片。
 *
 * 只做**机械可判**的事，一件也不猜：
 *   1. 列映射 —— 说出「我们的字段 ← 文件里的哪一列」，产出可直接上传的分片；
 *   2. 拆批 —— 每片 ≤ 5000 数据行（`MAX_PRODUCT_IMPORT_DATA_ROWS`，恰好 5000 是允许的）；
 *   3. 剔占位行 —— 商品编码以下划线开头的（`_____YF____` 运费这类，ERP 每次导出都带）；
 *   4. 导出待补录清单 —— 没有款式编码的行**不猜**归属，单独成表交商户补。
 *
 * 为什么不替商户补款式编码（2026-09-18 在真文件上量过，见 B03 二期 §7.2）：
 * 「继承上一行」在 2538 行里有 2115 行的上下行是**不同款式**；「按 SKU 编码前缀匹配全表款式」
 * 只有 828 行能唯一命中，且这条规则在**已知答案**的行上准确率 94.2% —— 那 5.8% 会安静地
 * 把商品挂到错的款式上，回执里看不出来。少导一行商户会发现，挂错款式没人会发现。
 *
 * 产出（默认写到 <输入文件同级的 商品导入整理-<时间戳>/）：
 *   shard-01.csv …     每片 ≤5000 行，表头就是我们的字段名（`product_code`/`sku_code`/`title`），
 *                      别名表直接认，**上传时不需要再带 mapping**；
 *   待补录-缺款式编码.csv  只有「款式编码」一列是空的，商户补完可用 --fill 传回来；
 *   mapping.json       给「直接上传原始文件」那条路用的列映射；
 *   报告.txt           本次整理的口径与逐类计数。
 *
 * 用法：
 *   node scripts/tidy-product-import.cjs <原始表.xlsx|.csv> [选项]
 *   选项：
 *     --fill <补录表.csv>   可重复；按商品编码把补齐的款式编码贴回（幂等，重跑只更新）
 *     --out <目录>          输出目录
 *     --rows <每片行数>     默认 5000
 *     --map product_code=款式编码 --map title=商品名称    覆盖默认列映射
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 我们的字段 → 这份 ERP 导出里的列名。`--map` 可逐条覆盖。 */
const DEFAULT_MAPPING = {
  product_code: '款式编码',
  sku_code: '商品编码',
  title: '商品名称',
};

/** 写进分片的表头：都是别名表认得的名字，因此上传不需要 mapping。 */
const SHARD_HEADERS = ['product_code', 'sku_code', 'title'];

const MAX_ROWS_PER_SHARD = 5000;
/** 解压后的 sheet1.xml 可达 47 MB，默认 1 MB 的 maxBuffer 会在中途掐断。 */
const UNZIP_MAX_BUFFER = 256 * 1024 * 1024;

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/_x000D_/g, ' ')
    .replace(/_x000A_/g, ' ');
}

function columnIndex(reference) {
  let index = 0;
  for (const letter of /^([A-Z]+)/.exec(reference)[1])
    index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** 直接用系统的 `unzip`：xlsx 就是 zip，node 没有内置解压。 */
function readZipEntry(file, entry) {
  return execFileSync('unzip', ['-p', file, entry], {
    maxBuffer: UNZIP_MAX_BUFFER,
    encoding: 'utf8',
  });
}

/** 读 xlsx 的第一张表，返回二维数组（`t="s"` 指向 sharedStrings）。 */
function readXlsx(file) {
  const sharedStrings = [];
  for (const item of readZipEntry(file, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [...item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => match[1]);
    sharedStrings.push(decodeXml(texts.join('')));
  }
  const sheet = readZipEntry(file, 'xl/worksheets/sheet1.xml');
  const rows = [];
  for (const row of sheet.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of row[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const body = /<v>([\s\S]*?)<\/v>/.exec(cell[3])?.[1] ?? '';
      const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[3])?.[1];
      let value;
      if (inline !== undefined) value = decodeXml(inline);
      else if (cell[2].includes('t="s"')) value = sharedStrings[Number(body)] ?? '';
      else value = decodeXml(body);
      cells[columnIndex(cell[1])] = value;
    }
    rows.push({ rowNumber: Number(row[1]), cells });
  }
  return rows;
}

/** 最小 CSV 解析：够用即可（引号包裹、双引号转义、字段内逗号与换行）。 */
function readCsv(text) {
  const rows = [];
  let cells = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(field);
      field = '';
    } else if (char === '\n') {
      cells.push(field);
      rows.push({ rowNumber: rows.length + 1, cells });
      cells = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field.length > 0 || cells.length > 0) {
    cells.push(field);
    rows.push({ rowNumber: rows.length + 1, cells });
  }
  return rows;
}

function readTable(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.xlsx') return readXlsx(file);
  const raw = fs.readFileSync(file, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  // 中文 Windows 的 Excel「另存为 CSV」默认写 GBK，按 utf8 读会整片变成 U+FFFD。
  // 与其把乱码当数据整理，不如在这里停下并说清楚要存成哪一种 CSV。
  if (text.includes('�')) {
    throw new Error(
      `${file} 不是 UTF-8。请用「CSV UTF-8（逗号分隔）」另存一次再跑（中文 Windows 的 Excel 默认存 GBK）。`,
    );
  }
  return readCsv(text);
}

function parseArgs(argv) {
  const options = { inputs: [], fills: [], mapping: { ...DEFAULT_MAPPING } };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fill') options.fills.push(argv[(index += 1)]);
    else if (arg === '--out') options.out = argv[(index += 1)];
    else if (arg === '--rows') options.rows = Number(argv[(index += 1)]);
    else if (arg === '--map') {
      const [field, column] = String(argv[(index += 1)]).split('=');
      options.mapping[field] = column;
    } else options.inputs.push(arg);
  }
  return options;
}

function csvCell(value) {
  const text = value ?? '';
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header, rows) {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

/** 按表头名找列号；找不到就抛（列名写错会静默丢一整列，值得直接停）。 */
function indexOfColumn(header, name, label) {
  const index = header.indexOf(name);
  if (index === -1) {
    throw new Error(`${label}：这份文件里没有「${name}」这一列。现有表头：${header.join(' / ')}`);
  }
  return index;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.inputs.length === 0) {
    console.error(
      '用法：node scripts/tidy-product-import.cjs <原始表.xlsx|.csv> [--fill 补录表.csv] [--out 目录] [--rows 5000] [--map product_code=款式编码]',
    );
    process.exit(2);
  }
  const rowsPerShard = options.rows ?? MAX_ROWS_PER_SHARD;

  const collected = [];
  for (const [order, file] of [...options.inputs, ...options.fills].entries()) {
    const isFill = order >= options.inputs.length;
    const table = readTable(file);
    const header = (table[0]?.cells ?? []).map((cell) => (cell ?? '').trim());
    const codeIndex = indexOfColumn(header, options.mapping.sku_code, file);
    // 补录表只需要「商品编码 + 款式编码」两列，别的列缺了不算错。
    const styleIndex = header.indexOf(options.mapping.product_code);
    if (styleIndex === -1 && !isFill) {
      indexOfColumn(header, options.mapping.product_code, file);
    }
    const titleIndex = header.indexOf(options.mapping.title ?? '');
    const colorIndex = header.indexOf('颜色');
    for (const row of table.slice(1)) {
      const code = (row.cells[codeIndex] ?? '').trim();
      if (code === '') continue;
      collected.push({
        file,
        rowNumber: row.rowNumber,
        code,
        style: styleIndex === -1 ? '' : (row.cells[styleIndex] ?? '').trim(),
        title: titleIndex === -1 ? '' : (row.cells[titleIndex] ?? '').trim(),
        color: colorIndex === -1 ? '' : (row.cells[colorIndex] ?? '').trim(),
      });
    }
  }

  // 先按商品编码收集款式编码（补录表补的就是这一列），再逐行分类 ——
  // 这样「原表 + 补录表」一起传时，补上的值会贴回原表的那些行。
  const styleByCode = new Map();
  for (const row of collected) {
    if (row.style !== '' && !styleByCode.has(row.code)) styleByCode.set(row.code, row.style);
  }

  const seen = new Set();
  const importable = [];
  const placeholders = [];
  const missingStyle = [];
  for (const row of collected) {
    if (seen.has(row.code)) continue;
    seen.add(row.code);
    const style = styleByCode.get(row.code) ?? '';
    // 占位行：ERP 每份导出都带 `_____YF____`（运费）、`__check__`（发货码）这类编码。
    if (/^_+/.test(row.code)) {
      placeholders.push(row);
      continue;
    }
    if (style === '') missingStyle.push(row);
    else importable.push({ ...row, style });
  }

  const outDir =
    options.out ?? path.join(path.dirname(options.inputs[0]), `商品导入整理-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  const shards = [];
  for (let start = 0; start < importable.length; start += rowsPerShard) {
    const slice = importable.slice(start, start + rowsPerShard);
    const name = `shard-${String(shards.length + 1).padStart(2, '0')}.csv`;
    fs.writeFileSync(
      path.join(outDir, name),
      toCsv(
        SHARD_HEADERS,
        slice.map((row) => [row.style, row.code, row.title]),
      ),
    );
    shards.push({ name, rows: slice.length });
  }

  const missingFile = '待补录-缺款式编码.csv';
  fs.writeFileSync(
    path.join(outDir, missingFile),
    toCsv(
      ['款式编码', '商品编码', '商品名称', '颜色'],
      missingStyle.map((row) => ['', row.code, row.title, row.color]),
    ),
  );
  fs.writeFileSync(
    path.join(outDir, 'mapping.json'),
    `${JSON.stringify(options.mapping, null, 2)}\n`,
  );

  const products = new Set(importable.map((row) => row.style)).size;
  const lines = [
    `输入：${[...options.inputs, ...options.fills].join('、')}`,
    `列映射：${Object.entries(options.mapping)
      .map(([field, column]) => `${field}←${column}`)
      .join('  ')}`,
    '',
    `可导入      ${importable.length} 行（${products} 个商品，每片 ≤${rowsPerShard} 行）`,
    `  占位行    ${placeholders.length} 行 —— ${placeholders.map((row) => row.code).join('、')}`,
    `  缺款式编码 ${missingStyle.length} 行 —— 见 ${missingFile}，补完用 --fill 传回来`,
    '',
    `分片（上传时不需要 mapping，表头就是我们的字段名）：`,
    ...shards.map((shard) => `  ${shard.name}  ${shard.rows} 行`),
    `输出目录：${outDir}`,
  ];
  const report = `${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(outDir, '报告.txt'), report);
  process.stdout.write(report);
}

main();
