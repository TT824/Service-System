/**
 * 商品导入 Parser 的验收测试。
 *
 * 覆盖三类风险：文件层（CSV/XLSX 的读取差异、BOM、空行、空工作表、公式、损坏文件、
 * 大小与行数上限），列层（中英文别名、重复表头、未知列、缺必填列），以及取值层
 * （卖点、属性、状态、日期与重复 SKU）。断言的是 issue 的稳定 code 与预览行字段，
 * 因此上传层可以只依赖这两者，而不依赖错误消息文案。**唯一例外**是「非空表全被隐藏」
 * 那一条：它还要挡住「消息把事实说反」这一类缺陷 —— 既不得声称「工作簿里没有非空工作表」，
 * 又必须点出真正的原因（可见性）。只钉一半挡不住：实测把消息换成另一句同样不实的话
 * （「工作簿里没有工作表」，而文件里明明有一张）时，只钉一半的版本仍是绿的。
 */

import { Workbook } from 'exceljs';
import { describe, expect, it } from 'vitest';

import {
  MAX_PRODUCT_IMPORT_CSV_RECORDS,
  MAX_PRODUCT_IMPORT_DATA_ROWS,
  MAX_PRODUCT_IMPORT_FILE_BYTES,
  PRODUCT_IMPORT_COLUMN_ALIASES,
  PRODUCT_IMPORT_FIELDS,
  REQUIRED_PRODUCT_IMPORT_FIELDS,
  parseProductImportFile,
  resolveProductImportColumn,
  type ProductImportColumnMapping,
  type ProductImportIssue,
  type ProductImportIssueCode,
  type ProductImportParseResult,
} from './product-import-parser';

/** 解析 CSV 文本并返回结果，省去每处重复的 format 参数。 */
function parseCsv(content: string): Promise<ProductImportParseResult> {
  return parseProductImportFile({ format: 'csv', content });
}

/** 带显式列映射解析一份 CSV。 */
function parseCsvWithMapping(
  content: string,
  columnMapping: ProductImportColumnMapping,
): Promise<ProductImportParseResult> {
  return parseProductImportFile({ format: 'csv', content, columnMapping });
}

/** 一个单元格的 CSV 写法：只在必要时加引号，避免测试自己制造非法 CSV。 */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * 按表头拼一份 CSV。
 *
 * 行用表头文本作键，列数因此永远与表头一致，测试不必手数逗号（手数过一次，结果是
 * 把 JSON 属性写进了错误的列）。
 */
function buildCsv(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<Readonly<Record<string, string>>>,
): string {
  const lines = rows.map((row) => headers.map((header) => csvCell(row[header] ?? '')).join(','));
  return `${[headers.join(','), ...lines].join('\n')}\n`;
}

/** 覆盖三个必填列与常用可选列的中文表头。 */
const CN_HEADERS = [
  '商品编码',
  '商品标题',
  'SKU 编码',
  '类目编码',
  '卖点',
  '通用属性',
  'SKU 属性',
  '检索属性',
  '上下架状态',
  'SKU 状态',
] as const;

/** 中文表头下的两行 SKU，同属一个商品编码。 */
const TWO_SKU_ROWS = buildCsv(CN_HEADERS, [
  {
    商品编码: 'P1',
    商品标题: '秋季风衣',
    'SKU 编码': 'SKU1',
    类目编码: 'CAT-1',
    卖点: '保暖|防风;百搭',
    通用属性: '{"材质":"棉"}',
    'SKU 属性': '颜色=黑;尺码=M',
    检索属性: '颜色=黑',
    上下架状态: '上架',
    'SKU 状态': '启用',
  },
  {
    商品编码: 'P1',
    商品标题: '秋季风衣',
    'SKU 编码': 'SKU2',
    类目编码: 'CAT-1',
    'SKU 属性': '颜色=白;尺码=L',
    检索属性: '颜色=白',
    上下架状态: '上架',
    'SKU 状态': '启用',
  },
]);

/** 取出所有指定 code 的 issue。 */
function issuesOfCode(
  result: ProductImportParseResult,
  code: ProductImportIssueCode,
): ReadonlyArray<ProductImportIssue> {
  return result.issues.filter((issue) => issue.code === code);
}

/** 断言结果里恰好有若干条指定 code 的 issue。 */
function expectIssue(
  result: ProductImportParseResult,
  code: ProductImportIssueCode,
  count = 1,
): void {
  expect(issuesOfCode(result, code)).toHaveLength(count);
}

/** 一个 XLSX 工作表的描述：名称、行数据、是否隐藏。 */
type SheetSpec = {
  readonly name: string;
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly hidden?: boolean;
};

/**
 * 把 exceljs 的 `writeBuffer()` 结果变成 Node 的 `Buffer`。
 *
 * exceljs 在自己的类型声明里声明了一个模块内的 `Buffer` 接口，它不等同于 Node 的
 * `Buffer`，所以两者的返回值不能直接互相赋值。运行时它就是 Node Buffer，这里按
 * `Uint8Array` 复制一份：既绕开声明差异，也保证测试拿到的是独立副本。
 */
async function toNodeBuffer(pending: Promise<unknown>): Promise<Buffer> {
  return Buffer.from((await pending) as Uint8Array);
}

/** 用 exceljs 拼出一个真实的 XLSX 二进制，让 Parser 面对真实文件而非桩数据。 */
async function buildXlsx(sheets: ReadonlyArray<SheetSpec>): Promise<Buffer> {
  const workbook = new Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) {
      worksheet.addRow([...row]);
    }
    if (sheet.hidden === true) {
      worksheet.state = 'hidden';
    }
  }
  return toNodeBuffer(workbook.xlsx.writeBuffer());
}

describe('parseProductImportFile — CSV 读取', () => {
  it('parses two SKU rows of one 商品编码 into two preview rows and one SPU', async () => {
    const result = await parseCsv(TWO_SKU_ROWS);

    expect(result.summary.ok).toBe(true);
    expect(result.summary.fatal).toBe(false);
    expect(result.previewRows).toHaveLength(2);
    expect(result.summary.totalRows).toBe(2);
    expect(result.summary.previewRowCount).toBe(2);
    expect(result.summary.spuCount).toBe(1);
    expect(result.previewRows[0]?.spu.productCode).toBe('P1');
    expect(result.previewRows[1]?.spu.productCode).toBe('P1');
    expect(result.previewRows[0]?.sku.skuCode).toBe('SKU1');
    expect(result.previewRows[1]?.sku.skuCode).toBe('SKU2');
    // 同一 SPU 的两行共用标题等 SPU 字段，SKU 字段各自独立。
    expect(result.previewRows[1]?.spu.title).toBe('秋季风衣');
    expect(result.previewRows[1]?.sku.variant).toEqual({ 颜色: '白', 尺码: 'L' });
  });

  it('maps a 中文 header into upsert-ready fields without the uploader reinterpreting them', async () => {
    const result = await parseCsv(TWO_SKU_ROWS);
    const row = result.previewRows[0];

    expect(row?.spu.categoryCode).toBe('CAT-1');
    expect(row?.spu.sellingPoints).toEqual(['保暖', '防风', '百搭']);
    expect(row?.spu.commonAttributes).toEqual({ 材质: '棉' });
    expect(row?.spu.shelfStatus).toBe('on_shelf');
    expect(row?.sku.variant).toEqual({ 颜色: '黑', 尺码: 'M' });
    expect(row?.sku.searchAttributes).toEqual({ 颜色: '黑' });
    expect(row?.sku.status).toBe('active');
  });

  it('accepts an English header for the three required columns', async () => {
    const content = buildCsv(
      ['product_code', 'title', 'sku_code'],
      [{ product_code: 'P9', title: '英文表头商品', sku_code: 'SKU9' }],
    );

    const result = await parseCsv(content);

    expect(result.summary.ok).toBe(true);
    expect(result.previewRows[0]?.spu.productCode).toBe('P9');
    expect(result.previewRows[0]?.spu.title).toBe('英文表头商品');
    expect(result.previewRows[0]?.sku.skuCode).toBe('SKU9');
  });

  it('strips a UTF-8 BOM so the first header is still 商品编码', async () => {
    const result = await parseCsv(`\uFEFF${TWO_SKU_ROWS}`);

    expect(result.summary.ok).toBe(true);
    expect(result.summary.fatal).toBe(false);
    expect(result.previewRows[0]?.spu.productCode).toBe('P1');
  });

  it('ignores blank lines and separator-only lines without numbering them', async () => {
    const [header, firstRow, secondRow] = TWO_SKU_ROWS.split('\n');
    const content = `\n${header}\n\n${firstRow}\n,,,,,,,,,\n${secondRow}\n`;

    const result = await parseCsv(content);

    expect(result.summary.ok).toBe(true);
    expect(result.summary.totalRows).toBe(2);
    // 行号与行数不受空行影响：这才是本用例真正要守的行为 —— 表头前的空行没有把表头
    // 挤偏，中间的空白行没有占掉行号。
    expect(result.previewRows.map((row) => row.rowNumber)).toEqual([1, 2]);
    // 两行同属 P1，靠 SKU 编码区分：说明丢空行没有把数据行错位。
    expect(result.previewRows.map((row) => row.spu.productCode)).toEqual(['P1', 'P1']);
    expect(result.previewRows.map((row) => row.sku.skuCode)).toEqual(['SKU1', 'SKU2']);

    // 只有分隔符的那一行仍被计数。
    expect(result.summary.blankRows).toBe(1);
    // 而**真正空行**（整行零字符）由 `csv-parse` 直接丢弃、不进 `blankRows` —— 见
    // `readCsvTable` 里 `skip_empty_lines` 的注释：这是换取 1560 倍解析速度的代价，
    // 否则一个 1 MiB 的空行文件会让进程停摆 33 秒。先把「这份输入里确实有两条真空白行」
    // 钉住，否则上面那条 blankRows 断言可能因为 fixture 根本没有真空白行而失去意义。
    // `slice(0, -1)` 去掉结尾换行产生的伪空元素，它不是一行 CSV。
    const physicalLines = content.split('\n').slice(0, -1);
    expect(physicalLines.filter((line) => line.length === 0)).toHaveLength(2);
  });

  it('parses a blank-line-heavy csv without stalling the event loop', async () => {
    // 回归守卫：`skip_empty_lines: false` 下这条会耗时约 16 秒，远超下面显式设置的
    // 3 秒上限 —— 改回旧选项即红。它不是计时基准，只用来捕捉数量级退化。
    const content = `商品编码,商品标题,SKU 编码\n${'\n'.repeat(512 * 1024)}`;

    const result = await parseCsv(content);

    // 整份文件只有表头，没有数据行。
    expect(result.summary.fatal).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'no_data_rows')).toBe(true);
  }, 3000);

  it('reports the record budget, not the data-row limit, for a file past both', async () => {
    // 有意为之的取舍，锁定在这里以免日后被当成 bug「修」掉：一份 20 001 行、
    // 行行都是数据的文件，两者都超限，而预算在第 20 001 条就中断了 ——
    // 那一刻不可能知道整份文件到底有多少**数据行**。所以它报 `too_many_records`
    // （消息只声称「行数」，两种情形下都成立），而不是 `too_many_rows`。
    // 常见情形（数据行略超 5000、总行数远不到预算）仍然拿到精确的 `too_many_rows`。
    const content = 'P1,标题,SKU1\n'.repeat(MAX_PRODUCT_IMPORT_CSV_RECORDS + 1);

    const result = await parseCsv(content);

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'too_many_records');
    expect(result.previewRows).toHaveLength(0);
  });

  it('aborts a separator-only csv at the record budget instead of tokenising all of it', async () => {
    // 回归守卫，两道：
    //   1. 记录预算被摘掉 → 1 MiB 全 `,,,` 约 8 秒，撞破下面 3 秒上限；
    //   2. 预算还在、但喂给解析器的是一整块（`write(整份文件)`）→ 早停失效，
    //      同样是约 8 秒 —— 这正是本次修复前实测到的失败模式（10 MiB 85 秒）。
    // 它不是计时基准，只用来捕捉数量级退化。
    //
    // 夹具必须让**表头列数 ≠ 记录列数**，否则走的是快路径（实测：整份 4 列一致的
    // 100 KB 文件只要几毫秒，守卫就成了摆设）。约 30 µs/条 的退化代价出现在
    // 「有分隔符、无内容、且列数与表头不符」的记录上 —— 也就是别人随手导出的
    // 那份带尾随逗号的文件。
    const content = `商品编码,商品标题,SKU 编码\n${',,,\n'.repeat(256 * 1024)}`;

    // 同时数定时器 tick。这一条和上面两条是独立的两件事：记录预算只把
    // 「停摆 78 秒」压成「停摆 0.9 秒」，解析期间 API 仍然一条请求都不应答
    // （实测：只有预算、没有消费侧让出时，整个解析过程 tick 数为 0）。
    // 让出那一行被删掉，这里就会变成 0。
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    let result: ProductImportParseResult;
    try {
      result = await parseCsv(content);
    } finally {
      clearInterval(timer);
    }

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'too_many_records');
    expect(result.previewRows).toHaveLength(0);
    expect(result.summary.totalRows).toBe(0);
    expect(ticks).toBeGreaterThan(0);
  }, 3000);

  it('keeps quoted commas and embedded newlines inside one field', async () => {
    const content = '商品编码,商品标题,SKU 编码,副标题\nP2,"风衣,加厚款","SKU\n多行",副标题\n';

    const result = await parseCsv(content);

    expect(result.summary.fatal).toBe(false);
    expect(result.previewRows).toHaveLength(1);
    expect(result.previewRows[0]?.spu.title).toBe('风衣,加厚款');
    expect(result.previewRows[0]?.sku.skuCode).toBe('SKU\n多行');
  });

  it('reports the first non-empty record as the header even after leading blank lines', async () => {
    const result = await parseCsv(`\n\n${TWO_SKU_ROWS}`);

    expect(result.summary.ok).toBe(true);
    expect(result.previewRows).toHaveLength(2);
  });
});

describe('parseProductImportFile — 表头契约', () => {
  it('rejects the batch when a required column is missing', async () => {
    // 必填只剩商品编码与标题：规格列在 2026-09-18 之后由「必填」降为「可选」（见下文
    // 「规格列可选」那一组），所以这条用例改指 title —— 它仍是真的必填。
    const content = buildCsv(['商品编码', 'SKU 编码'], [{ 商品编码: 'P1', 'SKU 编码': 'SKU1' }]);

    const result = await parseCsv(content);

    expect(result.summary.fatal).toBe(true);
    expect(result.previewRows).toHaveLength(0);
    expectIssue(result, 'missing_required_column');
    expect(issuesOfCode(result, 'missing_required_column')[0]?.field).toBe('title');
  });

  it('treats a duplicated header as a stable error', async () => {
    const content = '商品编码,商品标题,SKU 编码,商品编码\nP1,标题,SKU1,P2\n';

    const result = await parseCsv(content);

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'duplicate_header');
    expect(issuesOfCode(result, 'duplicate_header')[0]?.column).toBe('商品编码');
  });

  it('treats two different headers that map to one field as a stable error', async () => {
    const content = '商品编码,商品标题,SKU 编码,title\nP1,标题,SKU1,另一个标题\n';

    const result = await parseCsv(content);

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'duplicate_header');
    expect(issuesOfCode(result, 'duplicate_header')[0]?.field).toBe('title');
  });

  it('warns about an unknown column and keeps the row importable', async () => {
    const content = buildCsv(
      [...CN_HEADERS, '备注'],
      [{ 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': 'SKU1', 备注: '随便写' }],
    );

    const result = await parseCsv(content);

    expect(result.summary.ok).toBe(true);
    expect(result.summary.warningCount).toBe(1);
    expectIssue(result, 'unknown_column');
    expect(issuesOfCode(result, 'unknown_column')[0]?.severity).toBe('warning');
    expect(result.previewRows).toHaveLength(1);
  });

  it('returns an empty preview when the file has a header but no data rows', async () => {
    const result = await parseCsv(`${CN_HEADERS.join(',')}\n`);

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'no_data_rows');
    expect(result.previewRows).toHaveLength(0);
  });

  it('reports an empty file instead of an empty header', async () => {
    const result = await parseCsv('');

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'empty_file');
  });

  it('reports an unsupported format instead of guessing', async () => {
    const result = await parseProductImportFile({
      format: 'pdf' as never,
      content: 'x',
    });

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'unsupported_file_format');
  });
});

describe('parseProductImportFile — 显式列映射', () => {
  /** ERP 导出形状的表头：款式编码是商品级、商品编码是规格级 —— 别名表猜不到这一层。 */
  const ERP_HEADERS = ['款式编码', '商品编码', '商品标题', '颜色'] as const;

  const ERP_ROWS = buildCsv(ERP_HEADERS, [
    { 款式编码: 'YSSO4056B', 商品编码: 'YSSO4056B-01', 商品标题: '重磅卫衣', 颜色: '黑' },
    { 款式编码: 'YSSO4056B', 商品编码: 'YSSO4056B-02', 商品标题: '重磅卫衣', 颜色: '白' },
    { 款式编码: 'YSSO4100', 商品编码: 'YSSO4100-01', 商品标题: '工装裤', 颜色: '卡其' },
  ]);

  /** 把两层编码说清楚：款式编码=商品级，商品编码=规格级。 */
  const ERP_MAPPING: ProductImportColumnMapping = {
    product_code: '款式编码',
    sku_code: '商品编码',
  };

  it('takes the columns the mapping names and leaves the rest to the alias table', async () => {
    const result = await parseCsvWithMapping(ERP_ROWS, ERP_MAPPING);

    expect(result.summary.ok).toBe(true);
    // 款式编码 3 行 2 个值 → 2 个商品；商品编码 3 行 3 个值 → 3 个规格。
    expect(result.previewRows.map((row) => row.spu.productCode)).toEqual([
      'YSSO4056B',
      'YSSO4056B',
      'YSSO4100',
    ]);
    expect(result.previewRows.map((row) => row.sku.skuCode)).toEqual([
      'YSSO4056B-01',
      'YSSO4056B-02',
      'YSSO4100-01',
    ]);
    // 映射没提到的字段仍走别名表：商品标题照旧认出来。
    expect(result.previewRows[0]?.spu.title).toBe('重磅卫衣');
    // 被显式认领的两列不再算未知列；只剩「颜色」没人认领。
    expect(issuesOfCode(result, 'unknown_column').map((issue) => issue.column)).toEqual(['颜色']);
    // 规格列在，不该有合成告警。
    expectIssue(result, 'sku_code_synthesized', 0);
  });

  it('would read the same file as three separate products without the mapping', async () => {
    // 这条是上面那条的**反证**：同一份字节、只有映射在变。少了它，「映射生效」与
    // 「映射被静默忽略」在断言上长得一模一样（两种读法都能给出 3 行预览）。
    const result = await parseCsv(ERP_ROWS);

    expect(result.previewRows.map((row) => row.spu.productCode)).toEqual([
      'YSSO4056B-01',
      'YSSO4056B-02',
      'YSSO4100-01',
    ]);
    expect(result.previewRows.map((row) => row.sku.skuCode)).toEqual([
      'YSSO4056B-01',
      'YSSO4056B-02',
      'YSSO4100-01',
    ]);
    expect(issuesOfCode(result, 'unknown_column').map((issue) => issue.column)).toEqual([
      '款式编码',
      '颜色',
    ]);
  });

  it('reports a mapped column that the file does not have', async () => {
    const result = await parseCsvWithMapping(ERP_ROWS, { product_code: '款号' });

    expect(result.summary.fatal).toBe(true);
    expect(result.previewRows).toHaveLength(0);
    const issues = issuesOfCode(result, 'mapping_column_not_found');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('product_code');
    expect(issues[0]?.value).toBe('款号');
  });

  it('refuses an empty column name instead of claiming a nameless column', async () => {
    // 空表头列的 token 也是空串。不显式排除的话，`{product_code: ''}` 会认领到它上面：
    // 结果是「映射成功」加一条 duplicate_header，而调用方以为自己只是写漏了。
    const content = '商品编码,,商品标题,SKU 编码\nP1,x,标题,SKU1\n';

    const result = await parseCsvWithMapping(content, { product_code: '' });

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'mapping_column_not_found');
    expectIssue(result, 'duplicate_header', 0);
  });

  it('reports two fields mapped to the same column', async () => {
    const result = await parseCsvWithMapping(ERP_ROWS, {
      product_code: '款式编码',
      sku_code: '款式编码',
    });

    expect(result.summary.fatal).toBe(true);
    const issues = issuesOfCode(result, 'mapping_column_conflict');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.column).toBe('款式编码');
    expect(issues[0]?.message).toContain('product_code');
  });

  it('reports a field name that is not part of the contract', async () => {
    const result = await parseCsvWithMapping(ERP_ROWS, {
      product_code: '款式编码',
      colour: '颜色',
    } as never);

    expect(result.summary.fatal).toBe(true);
    const issues = issuesOfCode(result, 'mapping_unknown_field');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.value).toBe('colour');
  });
});

describe('parseProductImportFile — 规格列可选', () => {
  it('synthesizes one default SKU per product when the file has no SKU column', async () => {
    const content = buildCsv(
      ['商品编码', '商品标题'],
      [
        { 商品编码: 'P1', 商品标题: '无规格商品' },
        { 商品编码: 'P2', 商品标题: '另一个' },
      ],
    );

    const result = await parseCsv(content);

    expect(result.summary.fatal).toBe(false);
    expect(result.summary.ok).toBe(true);
    expect(result.previewRows.map((row) => row.sku.skuCode)).toEqual(['P1', 'P2']);
    // 文件级一条，不是每行一条：这是「这批数据被合成过」的结论，不是逐行的判断。
    expect(result.summary.warningCount).toBe(1);
    const warnings = issuesOfCode(result, 'sku_code_synthesized');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe('warning');
    expect(warnings[0]?.rowNumber).toBeNull();
  });

  it('does not synthesize for a row whose SKU column is merely empty', async () => {
    // 文件说了有规格列，就得说清楚；替某一行猜一个编码等于替商家改主意 ——
    // 而合成出来的编码是 upsert 的键，猜错一次，第二次导入就成了新建商品。
    const content = buildCsv(
      ['商品编码', '商品标题', 'SKU 编码'],
      [
        { 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': '' },
        { 商品编码: 'P2', 商品标题: '标题', 'SKU 编码': 'SKU2' },
      ],
    );

    const result = await parseCsv(content);

    expect(result.summary.ok).toBe(false);
    const missing = issuesOfCode(result, 'missing_required_value');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.field).toBe('sku_code');
    expect(missing[0]?.rowNumber).toBe(1);
    expectIssue(result, 'sku_code_synthesized', 0);
    expect(result.previewRows.map((row) => row.sku.skuCode)).toEqual(['SKU2']);
  });
});

describe('parseProductImportFile — 字段取值', () => {
  it('rejects the row that has an empty required value but keeps the valid row', async () => {
    const content = buildCsv(CN_HEADERS, [
      { 商品编码: 'P1', 商品标题: '', 'SKU 编码': 'SKU1' },
      { 商品编码: 'P2', 商品标题: '标题2', 'SKU 编码': 'SKU2' },
    ]);

    const result = await parseCsv(content);

    expect(result.summary.fatal).toBe(false);
    expect(result.summary.ok).toBe(false);
    const missing = issuesOfCode(result, 'missing_required_value');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.rowNumber).toBe(1);
    expect(missing[0]?.field).toBe('title');
    expect(result.previewRows.map((row) => row.spu.productCode)).toEqual(['P2']);
  });

  it('splits 卖点 on both the pipe and the semicolon forms', async () => {
    const content = buildCsv(
      ['商品编码', '商品标题', 'SKU 编码', '卖点'],
      [{ 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': 'SKU1', 卖点: 'A|B；C ; | D' }],
    );

    const result = await parseCsv(content);

    expect(result.previewRows[0]?.spu.sellingPoints).toEqual(['A', 'B', 'C', 'D']);
  });

  it('parses 属性 written as a JSON object or as key=value pairs', async () => {
    const json = buildCsv(
      ['商品编码', '商品标题', 'SKU 编码', '通用属性'],
      [
        {
          商品编码: 'P1',
          商品标题: '标题',
          'SKU 编码': 'SKU1',
          通用属性: '{"材质":"棉","厚度":2,"加绒":true}',
        },
      ],
    );
    const pairs = buildCsv(
      ['商品编码', '商品标题', 'SKU 编码', 'SKU 属性'],
      [{ 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': 'SKU1', 'SKU 属性': '颜色=黑;尺码=M' }],
    );

    const jsonResult = await parseCsv(json);
    const pairsResult = await parseCsv(pairs);

    expect(jsonResult.summary.ok).toBe(true);
    expect(jsonResult.previewRows[0]?.spu.commonAttributes).toEqual({
      材质: '棉',
      厚度: 2,
      加绒: true,
    });
    expect(pairsResult.summary.ok).toBe(true);
    expect(pairsResult.previewRows[0]?.sku.variant).toEqual({ 颜色: '黑', 尺码: 'M' });
  });

  it('reports invalid JSON as a stable error', async () => {
    const content = buildCsv(
      ['商品编码', '商品标题', 'SKU 编码', '通用属性'],
      [{ 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': 'SKU1', 通用属性: '{"材质":"棉"' }],
    );

    const result = await parseCsv(content);

    expect(result.summary.ok).toBe(false);
    expectIssue(result, 'invalid_json');
    expect(issuesOfCode(result, 'invalid_json')[0]?.field).toBe('common_attributes');
    expect(result.previewRows).toHaveLength(0);
  });

  it('reports an attribute pair without "=" as a stable error', async () => {
    const content = buildCsv(
      ['商品编码', '商品标题', 'SKU 编码', '通用属性'],
      [{ 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': 'SKU1', 通用属性: '只有键没有值' }],
    );

    const result = await parseCsv(content);

    expect(result.summary.ok).toBe(false);
    expectIssue(result, 'invalid_attributes');
  });

  it('normalizes 状态 aliases and rejects values outside the vocabulary', async () => {
    const ok = buildCsv(
      ['商品编码', '商品标题', 'SKU 编码', '上下架状态', 'SKU 状态'],
      [
        {
          商品编码: 'P1',
          商品标题: '标题',
          'SKU 编码': 'SKU1',
          上下架状态: '下架',
          'SKU 状态': '停用',
        },
      ],
    );
    const bad = buildCsv(
      ['商品编码', '商品标题', 'SKU 编码', '上下架状态'],
      [{ 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': 'SKU1', 上下架状态: '热卖中' }],
    );

    const okResult = await parseCsv(ok);
    const badResult = await parseCsv(bad);

    expect(okResult.previewRows[0]?.spu.shelfStatus).toBe('off_shelf');
    expect(okResult.previewRows[0]?.sku.status).toBe('inactive');
    expect(badResult.summary.ok).toBe(false);
    expectIssue(badResult, 'invalid_status');
    expect(issuesOfCode(badResult, 'invalid_status')[0]?.field).toBe('shelf_status');
  });

  it('defaults missing 状态 columns to unknown shelf and active SKU', async () => {
    const content = buildCsv(
      ['product_code', 'title', 'sku_code'],
      [{ product_code: 'P1', title: '标题', sku_code: 'SKU1' }],
    );

    const result = await parseCsv(content);

    expect(result.previewRows[0]?.spu.shelfStatus).toBe('unknown');
    expect(result.previewRows[0]?.sku.status).toBe('active');
  });

  it('carries every optional column into the preview row', async () => {
    const headers = [...PRODUCT_IMPORT_FIELDS];
    const content = buildCsv(headers, [
      {
        product_code: 'P1',
        title: '秋季风衣',
        sku_code: 'SKU1',
        category_code: 'CAT-1',
        external_product_id: 'EXT-1',
        subtitle: '加厚款',
        product_url: 'https://shop.example.com/p/1',
        main_image_url: 'https://cdn.example.com/1.png',
        selling_points: '保暖|防风',
        common_attributes: '{"材质":"棉"}',
        sku_attributes: '颜色=黑',
        search_attributes: '颜色=黑',
        shelf_status: 'on_shelf',
        sku_status: 'inactive',
        source_updated_at: '2026-09-01',
      },
    ]);

    const result = await parseCsv(content);

    expect(result.summary.ok).toBe(true);
    expect(result.previewRows[0]).toEqual({
      rowNumber: 1,
      spu: {
        productCode: 'P1',
        title: '秋季风衣',
        categoryCode: 'CAT-1',
        externalProductId: 'EXT-1',
        subtitle: '加厚款',
        productUrl: 'https://shop.example.com/p/1',
        mainImageUrl: 'https://cdn.example.com/1.png',
        sellingPoints: ['保暖', '防风'],
        commonAttributes: { 材质: '棉' },
        shelfStatus: 'on_shelf',
        sourceUpdatedAt: '2026-09-01T00:00:00.000Z',
      },
      sku: {
        skuCode: 'SKU1',
        variant: { 颜色: '黑' },
        searchAttributes: { 颜色: '黑' },
        status: 'inactive',
      },
    });
  });

  it('normalizes 源更新时间 text to ISO 8601 UTC', async () => {
    const content = buildCsv(
      [...CN_HEADERS, '源更新时间'],
      [{ 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': 'SKU1', 源更新时间: '2026/9/1 10:30:00' }],
    );

    const result = await parseCsv(content);

    expect(result.previewRows[0]?.spu.sourceUpdatedAt).toBe('2026-09-01T10:30:00.000Z');
  });

  it('reads the fractional second as a fraction of a second, not as raw milliseconds', async () => {
    const content = buildCsv(
      [...CN_HEADERS, '源更新时间'],
      [
        {
          商品编码: 'P1',
          商品标题: '标题',
          'SKU 编码': 'SKU1',
          源更新时间: '2026-09-01T10:30:00.5',
        },
        {
          商品编码: 'P2',
          商品标题: '标题2',
          'SKU 编码': 'SKU2',
          源更新时间: '2026-09-01T10:30:00.005',
        },
      ],
    );

    const result = await parseCsv(content);

    // `.5` 是 500 毫秒，`.005` 才是 5 毫秒：两者不能折叠成同一个时刻。
    expect(result.previewRows[0]?.spu.sourceUpdatedAt).toBe('2026-09-01T10:30:00.500Z');
    expect(result.previewRows[1]?.spu.sourceUpdatedAt).toBe('2026-09-01T10:30:00.005Z');
  });

  it('reports an unparsable 源更新时间 as a stable error', async () => {
    const content = buildCsv(
      [...CN_HEADERS, '源更新时间'],
      [{ 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': 'SKU1', 源更新时间: '2026-13-45' }],
    );

    const result = await parseCsv(content);

    expect(result.summary.ok).toBe(false);
    expectIssue(result, 'invalid_date');
  });

  it('drops every row of a duplicated SKU 编码 instead of guessing which one wins', async () => {
    const content = buildCsv(CN_HEADERS, [
      { 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': 'SKU-DUP' },
      { 商品编码: 'P2', 商品标题: '标题2', 'SKU 编码': 'SKU-DUP' },
      { 商品编码: 'P3', 商品标题: '标题3', 'SKU 编码': 'SKU-OK' },
    ]);

    const result = await parseCsv(content);

    expect(result.summary.ok).toBe(false);
    // 文件没说清 SKU-DUP 属于 P1 还是 P2，Parser 不替商家挑一行：两行都报错、都不进预览。
    expectIssue(result, 'duplicate_sku_code', 2);
    expect(issuesOfCode(result, 'duplicate_sku_code').map((issue) => issue.rowNumber)).toEqual([
      1, 2,
    ]);
    expect(issuesOfCode(result, 'duplicate_sku_code').map((issue) => issue.field)).toEqual([
      'sku_code',
      'sku_code',
    ]);
    // 重复只波及涉及的行，同一批里无关的行照常入库。
    expect(result.previewRows.map((row) => row.spu.productCode)).toEqual(['P3']);
    expect(result.summary.spuCount).toBe(1);
    expect(result.summary.failedRowCount).toBe(2);
  });

  it('counts every occurrence when one SKU 编码 repeats across three rows', async () => {
    const content = buildCsv(CN_HEADERS, [
      { 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': 'SKU-TRIPLE' },
      { 商品编码: 'P2', 商品标题: '标题2', 'SKU 编码': 'SKU-TRIPLE' },
      { 商品编码: 'P3', 商品标题: '标题3', 'SKU 编码': 'SKU-TRIPLE' },
    ]);

    const result = await parseCsv(content);

    expectIssue(result, 'duplicate_sku_code', 3);
    expect(result.previewRows).toHaveLength(0);
    expect(result.summary.spuCount).toBe(0);
  });

  it('truncates the raw value echoed in an issue', async () => {
    const long = 'x'.repeat(400);
    const content = buildCsv(
      ['商品编码', '商品标题', 'SKU 编码', '上下架状态'],
      [{ 商品编码: 'P1', 商品标题: '标题', 'SKU 编码': 'SKU1', 上下架状态: long }],
    );

    const result = await parseCsv(content);

    expect(issuesOfCode(result, 'invalid_status')[0]?.value).toHaveLength(121);
  });
});

describe('parseProductImportFile — XLSX 读取', () => {
  const HEADER = ['商品编码', '商品标题', 'SKU 编码', '上下架状态'];

  it('reads the first non-empty worksheet of a workbook', async () => {
    const content = await buildXlsx([
      { name: '商品', rows: [HEADER, ['P1', '标题', 'SKU1', 'on_shelf']] },
      { name: '忽略', rows: [['x']] },
    ]);

    const result = await parseProductImportFile({ format: 'xlsx', content });

    expect(result.summary.sheetName).toBe('商品');
    expect(result.summary.ok).toBe(true);
    expect(result.previewRows[0]?.spu.productCode).toBe('P1');
  });

  it('skips an empty first worksheet and reads the next non-empty one', async () => {
    const content = await buildXlsx([
      { name: '空表', rows: [] },
      { name: '数据', rows: [HEADER, ['P2', '标题2', 'SKU2', '下架']] },
    ]);

    const result = await parseProductImportFile({ format: 'xlsx', content });

    expect(result.summary.sheetName).toBe('数据');
    expect(result.previewRows[0]?.spu.productCode).toBe('P2');
    expect(result.previewRows[0]?.spu.shelfStatus).toBe('off_shelf');
  });

  it('reports an empty workbook when no worksheet carries a header', async () => {
    // 「没有一行是表头」在文件里有两种长相，这条用例两种都取：
    //   ① 整张表零行；② 有行，但每一行都是空白行 —— 表头无从谈起。
    // ② 是原先缺的那一半：只造 ① 时，一个「把空白行当成表头」的实现照样能过
    // （实测：让空白行不再被跳过后，只造 ① 的版本仍是绿的，加上 ② 才红）。
    const noRows = await buildXlsx([{ name: '空表', rows: [] }]);
    const onlyBlankRows = await buildXlsx([
      {
        name: '空表',
        rows: [
          ['', '', '', ''],
          ['', '', '', ''],
        ],
      },
    ]);

    for (const content of [noRows, onlyBlankRows]) {
      const result = await parseProductImportFile({ format: 'xlsx', content });

      expect(result.summary.fatal).toBe(true);
      expectIssue(result, 'empty_workbook');
    }
  });

  it('normalizes a real date cell to ISO 8601 UTC', async () => {
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet('数据');
    worksheet.addRow([...HEADER, '源更新时间']);
    const row = worksheet.addRow([
      'P3',
      '标题3',
      'SKU3',
      'unknown',
      new Date(Date.UTC(2026, 8, 1)),
    ]);
    row.getCell(5).numFmt = 'yyyy-mm-dd';
    const content = await toNodeBuffer(workbook.xlsx.writeBuffer());

    const result = await parseProductImportFile({ format: 'xlsx', content });

    expect(result.summary.ok).toBe(true);
    expect(result.previewRows[0]?.spu.sourceUpdatedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('refuses a formula cell in a mapped column without using its cached result', async () => {
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet('数据');
    worksheet.addRow([...HEADER, '副标题']);
    const row = worksheet.addRow(['P4', '标题4', 'SKU4', 'unknown', '缓存值']);
    row.getCell(1).value = { formula: '"P"&"4"', result: 'P4' };
    const content = await toNodeBuffer(workbook.xlsx.writeBuffer());

    const result = await parseProductImportFile({ format: 'xlsx', content });

    expect(result.summary.ok).toBe(false);
    expectIssue(result, 'formula_not_allowed');
    expect(issuesOfCode(result, 'formula_not_allowed')[0]?.field).toBe('product_code');
    expect(result.previewRows).toHaveLength(0);
  });

  it('ignores a formula cell that is not in a mapped column', async () => {
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet('数据');
    worksheet.addRow([...HEADER, '备注']);
    const row = worksheet.addRow(['P7', '标题7', 'SKU7', 'unknown', '']);
    row.getCell(5).value = { formula: '1+1', result: 2 };
    const content = await toNodeBuffer(workbook.xlsx.writeBuffer());

    const result = await parseProductImportFile({ format: 'xlsx', content });

    // 公式落在未知列上：公式本身不报错，这一列照旧按未知列告警，行仍可入库。
    expectIssue(result, 'formula_not_allowed', 0);
    expectIssue(result, 'unknown_column');
    expect(result.summary.ok).toBe(true);
    expect(result.previewRows[0]?.spu.productCode).toBe('P7');
  });

  it('reports a row whose only content is a formula instead of dropping it as blank', async () => {
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet('数据');
    worksheet.addRow(HEADER);
    const row = worksheet.addRow(['', '', '', '']);
    row.getCell(1).value = { formula: '"P"&"8"', result: 'P8' };
    const content = await toNodeBuffer(workbook.xlsx.writeBuffer());

    const result = await parseProductImportFile({ format: 'xlsx', content });

    // 只有公式的一行没有字面文本，但它依然「说了话」：必须报公式错误，不能当作空行静默丢弃。
    expect(result.summary.blankRows).toBe(0);
    expect(result.summary.totalRows).toBe(1);
    expectIssue(result, 'formula_not_allowed');
    expect(result.previewRows).toHaveLength(0);
  });

  it('skips a hidden worksheet even when it is the first non-empty sheet', async () => {
    // 夹具**故意**让隐藏的表排在第一位、且它有表头也有数据行：条件满足了，仍然要跳过。
    // 这是对 AC 字面的有意偏离（AC 只说「第一个非空工作表」），见 U-3.1 的拍板依据 ——
    // 照字面取会把模板的说明页当成商品数据。证伪：去掉 readXlsxTable 的 hidden 跳过，
    // 本用例立刻红（实测 `expected '说明' to be '数据'`），所以它钉的确实是「跳过」这个行为。
    const content = await buildXlsx([
      { name: '说明', rows: [HEADER, ['P5', '标题5', 'SKU5', '上架']], hidden: true },
      { name: '数据', rows: [HEADER, ['P6', '标题6', 'SKU6', '上架']] },
    ]);

    const result = await parseProductImportFile({ format: 'xlsx', content });

    expect(result.summary.sheetName).toBe('数据');
    expect(result.previewRows[0]?.spu.productCode).toBe('P6');
  });

  it('does not tell the operator the workbook is empty when its sheets are merely hidden', async () => {
    const rows = [HEADER, ['P7', '标题7', 'SKU7', '上架']];

    // 先按可见表读同一份内容：它能正常入库，证明这份工作簿确实「非空」。
    // 少了这一步，「隐藏」就不是唯一变量，下面的断言什么都证明不了。
    const visible = await parseProductImportFile({
      format: 'xlsx',
      content: await buildXlsx([{ name: '数据', rows }]),
    });
    expect(visible.summary.ok).toBe(true);

    const result = await parseProductImportFile({
      format: 'xlsx',
      content: await buildXlsx([{ name: '数据', rows, hidden: true }]),
    });

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'empty_workbook');
    // 「工作簿里没有非空工作表」在这份文件上是**假的** —— 上一段已经证明它有。
    // 两半都要钉，只钉一半挡不住这个缺陷：实测过，把消息换一句**同样不实**的话
    // （「工作簿里没有工作表」，文件里明明有一张）仍旧是绿的。
    // 所以既要求它不再重复旧的不实说法，也要求它点出真正的原因 —— 可见性。
    const message = issuesOfCode(result, 'empty_workbook')[0]?.message ?? '';
    expect(message).not.toContain('没有非空工作表');
    expect(message).toContain('可见');
  });

  it('reports a corrupted xlsx file as a stable error', async () => {
    const result = await parseProductImportFile({
      format: 'xlsx',
      content: Buffer.from('这不是一个 xlsx 文件'),
    });

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'unreadable_file');
    expect(result.previewRows).toHaveLength(0);
  });
});

describe('parseProductImportFile — 上限', () => {
  /** 生成指定数据行数的 CSV。 */
  function csvWithRows(count: number): string {
    const rows = Array.from({ length: count }, (_unused, index) => ({
      商品编码: `P${index}`,
      商品标题: `标题${index}`,
      'SKU 编码': `SKU${index}`,
    }));
    return buildCsv(['商品编码', '商品标题', 'SKU 编码'], rows);
  }

  it('accepts exactly 5000 data rows', async () => {
    const result = await parseCsv(csvWithRows(MAX_PRODUCT_IMPORT_DATA_ROWS));

    expect(result.summary.ok).toBe(true);
    expect(result.summary.totalRows).toBe(MAX_PRODUCT_IMPORT_DATA_ROWS);
    expect(result.summary.previewRowCount).toBe(MAX_PRODUCT_IMPORT_DATA_ROWS);
  });

  it('rejects 5001 data rows with a stable error', async () => {
    const result = await parseCsv(csvWithRows(MAX_PRODUCT_IMPORT_DATA_ROWS + 1));

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'too_many_rows');
    expect(result.previewRows).toHaveLength(0);
  });

  it('rejects a file larger than 10 MiB before parsing it', async () => {
    const oversized = `${CN_HEADERS.join(',')}\n${'x'.repeat(MAX_PRODUCT_IMPORT_FILE_BYTES)}`;

    const result = await parseCsv(oversized);

    expect(result.summary.fatal).toBe(true);
    expectIssue(result, 'file_too_large');
    expect(result.previewRows).toHaveLength(0);
  });
});

describe('resolveProductImportColumn', () => {
  it('maps every declared alias to its own field without collisions', () => {
    for (const field of PRODUCT_IMPORT_FIELDS) {
      for (const alias of PRODUCT_IMPORT_COLUMN_ALIASES[field]) {
        expect(resolveProductImportColumn(alias), alias).toBe(field);
      }
    }
  });

  it('covers every declared field with its own English name', () => {
    for (const field of PRODUCT_IMPORT_FIELDS) {
      expect(resolveProductImportColumn(field)).toBe(field);
    }
  });

  it('covers the required fields and their variants', () => {
    for (const field of REQUIRED_PRODUCT_IMPORT_FIELDS) {
      expect(resolveProductImportColumn(field)).toBe(field);
    }
    expect(resolveProductImportColumn('商品编码')).toBe('product_code');
    expect(resolveProductImportColumn('商品标题')).toBe('title');
    expect(resolveProductImportColumn('SKU 编码')).toBe('sku_code');
    expect(resolveProductImportColumn('sku-code')).toBe('sku_code');
    expect(resolveProductImportColumn('External Product ID')).toBe('external_product_id');
  });

  it('returns null for a column it does not know', () => {
    expect(resolveProductImportColumn('备注')).toBeNull();
  });
});
