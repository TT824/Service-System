/**
 * 商品导入文件 Parser：把商家上传的 CSV / XLSX 变成统一的 SPU/SKU 导入预览。
 *
 * Parser 只做一件可独立验收的事：把表格文件读成后续 upsert 直接可用的结构化数据。
 * 它不写 PostgreSQL、不碰 MinIO、不发网络请求；它也不解释业务规则 —— 类目编码如何
 * 解析成 categoryId、商品编码如何合并成 SPU，都是上传层与 catalog 模块的事。这里输出
 * 的是「文件说了什么」：批次摘要、标准化预览行，以及逐字段 issues。
 *
 * 列的识别、取值与校验规则全部集中在本文件。错误码是稳定性契约的一部分：上传层按
 * `code` 决定整批拒绝还是逐行跳过，并按 `field` 定位到具体列，因此 `code` 只增不改，
 * 新增判定必须复用已有 code 或明确新增。
 *
 * 解析表格的分隔符、引号与换行规则交给成熟库（`csv-parse` 与 `exceljs`）；本文件
 * 只负责把它们读出的单元格映射成字段，因此不重复实现任何一种文件格式。
 */

import { Readable } from 'node:stream';

import { parse as parseCsvStream } from 'csv-parse';
import { ValueType, Workbook } from 'exceljs';
import type { Cell } from 'exceljs';

import type {
  CatalogAttributeValue,
  CatalogAttributes,
  SkuStatus,
  SpuShelfStatus,
  VariantAttributes,
} from './catalog';
import {
  XlsxInflateBudgetExceededError,
  assertXlsxWithinInflateBudget,
} from './xlsx-inflate-budget';

/** Parser 支持的文件格式，是 `ImportSourceType` 中能由文件承载的子集。 */
export const PRODUCT_IMPORT_FILE_FORMATS = ['csv', 'xlsx'] as const;
/** 一种受支持的导入文件格式。 */
export type ProductImportFileFormat = (typeof PRODUCT_IMPORT_FILE_FORMATS)[number];

/** 单文件字节上限：10 MiB。超过即整批拒绝。 */
export const MAX_PRODUCT_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

/** 单文件数据行上限：5000 行（表头与空行不计）。超过即整批拒绝。 */
export const MAX_PRODUCT_IMPORT_DATA_ROWS = 5000;

/**
 * CSV 单文件记录数上限：数据行上限的 4 倍（20 000 条）。
 *
 * 与 `MAX_PRODUCT_IMPORT_DATA_ROWS` 是两回事：那个管「有多少行能入库」，这个管
 * 「解析器最多被要求切分多少条记录」。空行不计入数据行，所以一份 5000 数据行的文件
 * 可以夹带任意多条空行 —— 而那正是拖垮解析的东西。
 *
 * 为什么需要它（实测，见 `readCsvTable` 的注释）：`csv-parse` 切分一条**退化记录**
 * （`,,,,` 这种有分隔符、无内容的行）约需 30 µs，且**没有任何选项能改善** ——
 * `skip_records_with_empty_values` 能把记录数从 262 140 降到 1 条，耗时却几乎不变，
 * 说明代价在逐行切分阶段而非记录构造阶段。10 MiB 上限内可塞约 260 万条这样的记录，
 * 即约 78 秒**同步**切分，期间整个 API 进程不响应任何请求。
 *
 * 4 倍取值：合法文件记录数下限是「5000 数据行 + 1 表头」= 5001，余下约 15 000 条
 * 全是空行的额度。一份需要超过 20 000 条记录、却只有几千数据行的文件，
 * 其内容压倒性地是空行，拒绝它比让它阻塞进程更合理。
 *
 * 它会先于 `MAX_PRODUCT_IMPORT_DATA_ROWS` 触发的情形：一份 2 万行以上、行行都是
 * 数据的文件，本体报 `too_many_records`（行数超限）而不是 `too_many_rows`
 * （数据行超限 5000）。两种裁决都是致命的、都要求拆分文件，只是措辞粗细不同 ——
 * 这是有意的取舍：要在第 20 001 条就中断，就不可能同时知道整份文件到底有多少
 * **数据行**。消息因此只声称「行数」，不声称「数据行数」，两种情形下都成立。
 */
export const MAX_PRODUCT_IMPORT_CSV_RECORDS = MAX_PRODUCT_IMPORT_DATA_ROWS * 4;

/**
 * 喂给流式 CSV 解析器的分块大小：4 KiB。
 *
 * **这两个数字不是调优，是正确性的一部分。** 一次性 `write(整份文件)` 会让
 * `csv-parse` 在单次 `_transform` 里把整块切完，早停彻底失效 —— 实测 10 MiB
 * 全退化记录仍是 85 秒，与不设预算无异。
 *
 * 但**光切块还不够**：流的内部推进走 `process.nextTick`，只要管道里一直有数据，
 * 事件循环的 timer / I/O 阶段就永远轮不到 —— 实测切块喂 1 MiB 退化文件，解析
 * 全程 917 ms 内定时器一次都没触发。所以还要在消费侧显式让出，见
 * {@link CSV_YIELD_EVERY_RECORDS}。
 *
 * 块大小决定单次 `_transform` 的连续占用：4 KiB ≈ 1 024 条退化记录 ≈ 31 ms。
 */
const CSV_READ_CHUNK_BYTES = 4 * 1024;

/**
 * 每消费这么多条记录，就让出一次事件循环。
 *
 * `setImmediate` 会把控制权交回事件循环，让 timer 与 I/O 有机会执行 —— 这是
 * 「解析期间 API 还能应答」的唯一保障。256 条退化记录 ≈ 8 ms，是单次让出的
 * 最长连续占用；对正常数据（约 0.9 µs/条）则是约 0.2 ms，可以忽略。
 */
const CSV_YIELD_EVERY_RECORDS = 256;

/**
 * CSV 记录数超出预算。
 *
 * 单独成类而不是复用 `Error`：调用方要把它映射成文件级的 `too_many_records`，
 * 而不是与「文件读不了」混在一起的 `unreadable_file`。
 */
export class CsvRecordBudgetExceededError extends Error {
  /** 实际已切分到的记录数（≥ 预算）。 */
  readonly records: number;
  /** 允许的记录数上限。 */
  readonly budget: number;

  constructor(records: number, budget: number) {
    super(`csv 记录数 ${records} 超过预算 ${budget}`);
    this.name = 'CsvRecordBudgetExceededError';
    this.records = records;
    this.budget = budget;
  }
}

/** issue 回显原始值时的截断长度，避免整份表格倒灌进错误报告。 */
export const MAX_PRODUCT_IMPORT_ISSUE_VALUE_LENGTH = 120;

/**
 * 可映射的字段集合，与后续 SPU/SKU upsert 的字段一一对应。
 *
 * `sku_attributes` 落到 `ProductSku.variant`，`search_attributes` 落到
 * `ProductSku.searchAttributes`：两者都是 `VariantAttributes`，但用途不同，因此分开。
 */
export const PRODUCT_IMPORT_FIELDS = [
  'product_code',
  'title',
  'sku_code',
  'category_code',
  'external_product_id',
  'subtitle',
  'product_url',
  'main_image_url',
  'selling_points',
  'common_attributes',
  'sku_attributes',
  'search_attributes',
  'shelf_status',
  'sku_status',
  'source_updated_at',
] as const;
/** 一个列映射字段。 */
export type ProductImportField = (typeof PRODUCT_IMPORT_FIELDS)[number];

/**
 * 缺少任何一列都无法 upsert，因此这两列缺失即整批拒绝。
 *
 * **规格列（`sku_code`）不在其中**（2026-09-18 起的规则）：商户的表里常常只有商品没有规格，
 * 逼他们凭空加一列「SKU 编码」才是真正的伤害 —— 更糟的是，商户为了让文件过闸，往往把
 * 自己表里的**规格编码列**改名交上来，而那个列名在我们的别名表里指向的是**商品**级键，
 * 于是几百个商品会被拆成几万个（`商品资料.xlsx` 实测：5,509 个款式 / 23,328 个商品编码）。
 * 没有规格列时按商品编码合成一条默认规格，并在回执里以 `sku_code_synthesized` 说出来。
 */
export const REQUIRED_PRODUCT_IMPORT_FIELDS = ['product_code', 'title'] as const;

/**
 * 表头别名表：字段 → 可接受的列名。
 *
 * 中英文别名等价，比较时统一归一化（见 `normalizeToken`），所以 `SKU 编码`、
 * `sku_code` 与 `sku-code` 命中同一个字段。上传层若要支持新的表头写法，改这里即可，
 * 不必碰取值逻辑。
 */
export const PRODUCT_IMPORT_COLUMN_ALIASES: Readonly<
  Record<ProductImportField, ReadonlyArray<string>>
> = {
  product_code: ['商品编码', 'product_code', '商品编号', 'SPU 编码', 'spu_code'],
  title: ['商品标题', 'title', '商品名称', 'product_title'],
  sku_code: ['SKU 编码', 'sku_code', 'SKU编号', '规格编码'],
  category_code: ['类目编码', 'category_code', '类目代码', '类目'],
  external_product_id: ['外部商品 ID', 'external_product_id', '外部商品编号'],
  subtitle: ['副标题', 'subtitle', '商品副标题'],
  product_url: ['商品链接', 'product_url', '商品地址'],
  main_image_url: ['主图链接', 'main_image_url', '主图 URL', '主图'],
  selling_points: ['卖点', 'selling_points', '商品卖点'],
  common_attributes: ['通用属性', 'common_attributes', 'SPU 属性'],
  sku_attributes: ['SKU 属性', 'sku_attributes', '规格属性'],
  search_attributes: ['检索属性', 'search_attributes', '搜索属性'],
  shelf_status: ['上下架状态', 'shelf_status', '上下架'],
  sku_status: ['SKU 状态', 'sku_status', '规格状态'],
  source_updated_at: ['源更新时间', 'source_updated_at', '更新时间', '更新日期'],
};

/** 稳定的 issue 错误码。上传层按它决策，因此只增不改。 */
export const PRODUCT_IMPORT_ISSUE_CODES = [
  // 文件级：出现任意一条即整批拒绝（fatal）。
  'unsupported_file_format',
  'file_too_large',
  'unreadable_file',
  'empty_file',
  'empty_workbook',
  'missing_required_column',
  'duplicate_header',
  'too_many_rows',
  'too_many_records',
  'no_data_rows',
  // 行级与字段级。
  'unknown_column',
  'missing_required_value',
  'invalid_json',
  'invalid_attributes',
  'invalid_status',
  'invalid_date',
  'invalid_cell_value',
  'formula_not_allowed',
  'duplicate_sku_code',
  // 显式列映射（B03 二期）。三条都是 error：映射写错时，丢掉的是一整列数据。
  /** 映射里写的列名，这份文件里没有。 */
  'mapping_column_not_found',
  /** 两个字段映射到了同一列。 */
  'mapping_column_conflict',
  /** 映射里出现了不认识的字段名。 */
  'mapping_unknown_field',
  // 文件没有规格列，已按商品编码为每个商品合成一条默认规格。
  //
  // 是 warning 而不是静默：库里因此会出现一条**商家没写过**的规格，这件事必须在回执里说出来。
  'sku_code_synthesized',
] as const;
/** 一个稳定的 issue 错误码。 */
export type ProductImportIssueCode = (typeof PRODUCT_IMPORT_ISSUE_CODES)[number];

/** `error` 使该行不可入库；`warning` 只提示，不影响该行。 */
export type ProductImportIssueSeverity = 'error' | 'warning';

/** 一条逐字段 issue。文件级 issue 的 `rowNumber` 与 `column` 为 null。 */
export type ProductImportIssue = {
  readonly severity: ProductImportIssueSeverity;
  readonly code: ProductImportIssueCode;
  /** 数据行序号，从 1 开始；表头与空行不计。文件级 issue 为 null。 */
  readonly rowNumber: number | null;
  /** 命中的原始表头文本；文件级或未知列 issue 为 null。 */
  readonly column: string | null;
  /** 命中的映射字段；未知列与文件级 issue 为 null。 */
  readonly field: ProductImportField | null;
  /** 面向操作员的中文说明。 */
  readonly message: string;
  /** 触发 issue 的原始值，已截断；无原始值时为 null。 */
  readonly value: string | null;
};

/** 一个 SPU 的标准化预览字段，直接对应后续 upsert，不需要上传层再解释。 */
export type ProductImportPreviewSpu = {
  readonly productCode: string;
  readonly title: string;
  /** 文件里写的是类目编码，不是 categoryId：解析成 ID 属于 catalog 模块。 */
  readonly categoryCode: string | null;
  readonly externalProductId: string | null;
  readonly subtitle: string | null;
  readonly productUrl: string | null;
  readonly mainImageUrl: string | null;
  readonly sellingPoints: ReadonlyArray<string>;
  readonly commonAttributes: CatalogAttributes;
  readonly shelfStatus: SpuShelfStatus;
  /** ISO 8601 UTC；文件未给出时为 null。 */
  readonly sourceUpdatedAt: string | null;
};

/** 一个 SKU 的标准化预览字段，直接对应后续 upsert。 */
export type ProductImportPreviewSku = {
  readonly skuCode: string;
  readonly variant: VariantAttributes;
  readonly searchAttributes: VariantAttributes;
  readonly status: SkuStatus;
};

/**
 * 一行商品数据：一个 SPU 字段集 + 一个 SKU 字段集。
 *
 * 同一个 `productCode` 出现在多行是正常情况（一个 SPU 多个 SKU），合并成一条
 * SPU 记录的时机在 upsert，不由 Parser 预先折叠。
 */
export type ProductImportPreviewRow = {
  /** 数据行序号，从 1 开始；表头与空行不计。 */
  readonly rowNumber: number;
  readonly spu: ProductImportPreviewSpu;
  readonly sku: ProductImportPreviewSku;
};

/**
 * 调用方给出的显式列映射：**我们的字段 → 文件里的列名**。
 *
 * 值取的是**表头文本**而不是列序号：表头是商户看得懂、也说得出口的东西，列序号不是 ——
 * 一个「第 3 列」在商户那边没有任何意义，而「商品编码」他一看就懂。
 *
 * 没在这里出现的字段，仍然按 {@link PRODUCT_IMPORT_COLUMN_ALIASES} 的别名表认列（现状不变）；
 * 显式映射只是**优先**，不是**唯一**。
 */
export type ProductImportColumnMapping = Readonly<Partial<Record<ProductImportField, string>>>;

/** Parser 输入：文件格式、文件内容，以及可选的显式列映射。 */
export type ProductImportParseInput = {
  readonly format: ProductImportFileFormat;
  /** CSV 可传文本；XLSX 必须传二进制。两者都按 UTF-8 解释 CSV。 */
  readonly content: Buffer | Uint8Array | string;
  /** 显式列映射；缺省时完全按别名表认列（与加这个参数之前的行为逐位相同）。 */
  readonly columnMapping?: ProductImportColumnMapping | undefined;
};

/** 批次摘要：上传层用它决定整批状态与进度。 */
export type ProductImportSummary = {
  readonly format: ProductImportFileFormat;
  /** XLSX 命中的工作表名；CSV 为 null。 */
  readonly sheetName: string | null;
  /** 解析到的数据行数（表头与空行不计）；因超出上限被拒绝时为已读到的行数。 */
  readonly totalRows: number;
  /** 被忽略的空行数；因超出上限被拒绝时只统计到发现超限为止。 */
  readonly blankRows: number;
  /** 可入库的预览行数。 */
  readonly previewRowCount: number;
  /** 含 error 的数据行数；整批拒绝时等于 `totalRows`。 */
  readonly failedRowCount: number;
  /** 预览行覆盖的不同商品编码数，即 SPU 数。 */
  readonly spuCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  /** 整批被拒绝：此时 `previewRows` 必为空。 */
  readonly fatal: boolean;
  /** 没有任何 error 级 issue。 */
  readonly ok: boolean;
};

/** Parser 输出。 */
export type ProductImportParseResult = {
  readonly summary: ProductImportSummary;
  /** 只包含没有 error 的数据行；整批拒绝时为空。 */
  readonly previewRows: ReadonlyArray<ProductImportPreviewRow>;
  /** 按发现顺序排列：文件级 issue 在前，随后按数据行号。 */
  readonly issues: ReadonlyArray<ProductImportIssue>;
};

/** 单元格读取结果：只保留字面文本与「不可用」标记。 */
type RawCell = {
  readonly text: string;
  readonly formula: boolean;
  readonly error: boolean;
};

const EMPTY_RAW_CELL: RawCell = { text: '', formula: false, error: false };
const FORMULA_RAW_CELL: RawCell = { text: '', formula: true, error: false };
const ERROR_RAW_CELL: RawCell = { text: '', formula: false, error: true };

/** 一行原始单元格，长度即该行读到的列数。 */
type RawRow = ReadonlyArray<RawCell>;

/** 从文件中读出的原始表格：表头 + 非空数据行。 */
type RawTable = {
  readonly format: ProductImportFileFormat;
  readonly sheetName: string | null;
  readonly header: RawRow | null;
  readonly dataRows: ReadonlyArray<RawRow>;
  readonly blankRows: number;
  /** 非空数据行是否已超过上限；超过时只保留到发现超限为止。 */
  readonly overflow: boolean;
};

/** 表头解析结果。`issues` 里出现 error 即整批拒绝。 */
type HeaderAnalysis = {
  readonly mapping: ReadonlyMap<ProductImportField, number>;
  readonly headers: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<ProductImportIssue>;
};

/**
 * 归一化表头与枚举值：小写化后去掉空白（含全角空格）、下划线、连字符与括号。
 *
 * 中英文别名共用同一套归一化，因此 `SKU 编码`、`sku-code`、`sku_code` 等价，
 * `External Product ID` 与 `external_product_id` 也等价。
 */
function normalizeToken(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      // JavaScript 的 `\s` 覆盖全角空格（U+3000）与 BOM（U+FEFF），不需要额外列字符。
      .replace(/\s+/g, '')
      .replace(/[_\-.()（）[\]【】]/g, '')
  );
}

/** 别名查找表：归一化别名 → 字段。模块加载时构建一次。 */
const FIELD_BY_ALIAS: ReadonlyMap<string, ProductImportField> = (() => {
  const map = new Map<string, ProductImportField>();
  for (const field of PRODUCT_IMPORT_FIELDS) {
    for (const alias of PRODUCT_IMPORT_COLUMN_ALIASES[field]) {
      map.set(normalizeToken(alias), field);
    }
  }
  return map;
})();

/**
 * 把一列表头文本解析成映射字段。
 *
 * 上传层可用它单独校验一列表头，而不必解析整份文件。
 *
 * @param header - 原始表头文本。
 * @returns 命中时返回字段名，未命中返回 null。
 */
export function resolveProductImportColumn(header: string): ProductImportField | null {
  return FIELD_BY_ALIAS.get(normalizeToken(header)) ?? null;
}

/** 上下架状态别名：归一化写法 → `SpuShelfStatus`。 */
const SHELF_STATUS_BY_TOKEN: ReadonlyMap<string, SpuShelfStatus> = new Map([
  ['onshelf', 'on_shelf'],
  ['上架', 'on_shelf'],
  ['已上架', 'on_shelf'],
  ['在售', 'on_shelf'],
  ['offshelf', 'off_shelf'],
  ['下架', 'off_shelf'],
  ['已下架', 'off_shelf'],
  ['停售', 'off_shelf'],
  ['unknown', 'unknown'],
  ['未知', 'unknown'],
  ['不确定', 'unknown'],
]);

/** SKU 状态别名：归一化写法 → `SkuStatus`。 */
const SKU_STATUS_BY_TOKEN: ReadonlyMap<string, SkuStatus> = new Map([
  ['active', 'active'],
  ['启用', 'active'],
  ['有效', 'active'],
  ['正常', 'active'],
  ['inactive', 'inactive'],
  ['停用', 'inactive'],
  ['无效', 'inactive'],
  ['失效', 'inactive'],
]);

/** 上下架状态缺省为 `unknown`：文件没说，就不能当成在售。 */
const DEFAULT_SHELF_STATUS: SpuShelfStatus = 'unknown';
/** SKU 状态缺省为 `active`，与 `NewProductSku` 的缺省一致。 */
const DEFAULT_SKU_STATUS: SkuStatus = 'active';

/** 卖点分隔符：竖线、半角/全角分号与换行。 */
const SELLING_POINT_SEPARATOR = /[|;；\r\n]+/;
/** `key=value` 属性对的分隔符。 */
const ATTRIBUTE_PAIR_SEPARATOR = /[;；\r\n]+/;

/** 把原始值截断到 issue 允许的长度。 */
function truncateValue(raw: string): string {
  return raw.length > MAX_PRODUCT_IMPORT_ISSUE_VALUE_LENGTH
    ? `${raw.slice(0, MAX_PRODUCT_IMPORT_ISSUE_VALUE_LENGTH)}…`
    : raw;
}

/** 构造一条 issue；只在这里收口，保证字段组合一致。 */
function makeIssue(
  severity: ProductImportIssueSeverity,
  code: ProductImportIssueCode,
  message: string,
  location: {
    readonly rowNumber?: number | null;
    readonly column?: string | null;
    readonly field?: ProductImportField | null;
    readonly value?: string | null;
  } = {},
): ProductImportIssue {
  return {
    severity,
    code,
    rowNumber: location.rowNumber ?? null,
    column: location.column ?? null,
    field: location.field ?? null,
    message,
    value:
      location.value === undefined || location.value === null
        ? null
        : truncateValue(location.value),
  };
}

/** 卖点拆分：按 `|`、分号或换行拆开，去掉空白与空段。 */
function splitSellingPoints(raw: string): ReadonlyArray<string> {
  return raw
    .split(SELLING_POINT_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 属性解析结果：失败时给出稳定错误码与中文说明。 */
type AttributeParseResult =
  | { readonly ok: true; readonly attributes: CatalogAttributes }
  | {
      readonly ok: false;
      readonly code: 'invalid_json' | 'invalid_attributes';
      readonly message: string;
    };

/**
 * 解析属性列：支持 JSON object 与 `key=value;key=value` 两种写法。
 *
 * 空值表示「没有属性」，不是错误。JSON 只接受 object，且值必须是字符串、数字或布尔
 * 值：数组与嵌套对象无法落到 `common_attributes_json` 的标量契约上。
 */
function parseAttributes(raw: string): AttributeParseResult {
  const text = raw.trim();
  if (text.length === 0) {
    return { ok: true, attributes: {} };
  }

  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, code: 'invalid_json', message: '属性不是合法 JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, code: 'invalid_json', message: '属性 JSON 必须是 object' };
    }
    const attributes: Record<string, CatalogAttributeValue> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const name = key.trim();
      if (name.length === 0) {
        return { ok: false, code: 'invalid_attributes', message: '属性名不能为空' };
      }
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return {
          ok: false,
          code: 'invalid_attributes',
          message: `属性 ${name} 的值必须是字符串、数字或布尔值`,
        };
      }
      attributes[name] = value;
    }
    return { ok: true, attributes };
  }

  const attributes: Record<string, CatalogAttributeValue> = {};
  for (const segment of text.split(ATTRIBUTE_PAIR_SEPARATOR)) {
    const pair = segment.trim();
    if (pair.length === 0) {
      continue;
    }
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      return {
        ok: false,
        code: 'invalid_attributes',
        message: `属性片段 ${pair} 不是 key=value 形式`,
      };
    }
    const name = pair.slice(0, separator).trim();
    if (name.length === 0) {
      return { ok: false, code: 'invalid_attributes', message: '属性名不能为空' };
    }
    attributes[name] = pair.slice(separator + 1).trim();
  }
  return { ok: true, attributes };
}

/** 把标量属性转成 `VariantAttributes`：SKU 维度与检索维度只接受字符串值。 */
function toStringAttributes(attributes: CatalogAttributes): VariantAttributes {
  const converted: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    converted[key] = String(value);
  }
  return converted;
}

/** 无时区的日期文本：`YYYY-MM-DD` / `YYYY/M/D`，可选 `HH:mm(:ss)`。 */
const NAIVE_DATE_PATTERN =
  /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?)?$/;

/** 带时区的 ISO 8601 文本；只有这种形式才交给 `Date.parse` 兜底。 */
const ZONED_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * 把日期文本标准化成 ISO 8601 UTC 字符串。
 *
 * 不带时区的文本一律按 UTC 解释，因此同一个文件在任何时区的机器上都得到同一结果；
 * 带时区的 ISO 文本按它自己声明的偏移换算。其余写法（含 `Date.parse` 的区域相关格式）
 * 一律视为非法，避免同一份文件在不同环境解析出不同日期。
 *
 * @param raw - 单元格文本。
 * @returns 标准化结果，或无法识别时的 null。
 */
function normalizeDateText(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) {
    return null;
  }

  const naive = NAIVE_DATE_PATTERN.exec(text);
  if (naive !== null) {
    const year = Number(naive[1]);
    const month = Number(naive[2]);
    const day = Number(naive[3]);
    const hour = naive[4] === undefined ? 0 : Number(naive[4]);
    const minute = naive[5] === undefined ? 0 : Number(naive[5]);
    const second = naive[6] === undefined ? 0 : Number(naive[6]);
    // ISO 8601 的小数秒是「秒的小数部分」：`.5` 表示 500 毫秒而不是 5 毫秒，
    // 因此小数位要右补零到三位再取整，否则 `.5` 与 `.005` 会被当成同一个时刻。
    const millisecond = naive[7] === undefined ? 0 : Number(naive[7].padEnd(3, '0'));
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day) ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    ) {
      return null;
    }
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
    // 溢出（例如 2026-02-30）会被 Date 顺延，这里回读确认日期没有被改写。
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date.toISOString();
  }

  if (ZONED_ISO_PATTERN.test(text)) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

/** 读取一个 XLSX 单元格的字面值；公式不执行、缓存结果不读取。 */
function readXlsxCell(cell: Cell): RawCell {
  switch (cell.type) {
    case ValueType.Formula:
      return FORMULA_RAW_CELL;
    case ValueType.Error:
      return ERROR_RAW_CELL;
    case ValueType.Null:
      return EMPTY_RAW_CELL;
    default:
      break;
  }
  const value: unknown = cell.value;
  if (value === null || value === undefined) {
    return EMPTY_RAW_CELL;
  }
  if (value instanceof Date) {
    return { text: value.toISOString(), formula: false, error: false };
  }
  if (typeof value === 'object') {
    // 合并区域的从属单元格由 exceljs 返回主单元格的值，直接当作字面值使用。
    if ('richText' in value) {
      const richText = (value as { richText: ReadonlyArray<{ text: string }> }).richText;
      return { text: richText.map((run) => run.text).join(''), formula: false, error: false };
    }
    if ('text' in value) {
      const hyperlink = value as { text: unknown };
      return { text: String(hyperlink.text), formula: false, error: false };
    }
    if ('error' in value) {
      return ERROR_RAW_CELL;
    }
    return EMPTY_RAW_CELL;
  }
  return { text: String(value), formula: false, error: false };
}

/** 读取一个 XLSX 数据行的所有单元格；比表头短的行按空单元格补齐。 */
function readXlsxRow(row: { readonly cellCount: number; getCell(index: number): Cell }): RawRow {
  const cells: RawCell[] = [];
  for (let index = 1; index <= row.cellCount; index += 1) {
    cells.push(readXlsxCell(row.getCell(index)));
  }
  return cells;
}

/**
 * 行内是否没有任何可报告的内容。整行为空的行按「空行」忽略。
 *
 * 公式与错误值虽然读不到字面文本，但它们是「这一行说了什么」的一部分：只有公式的一行
 * 必须留给 `parseDataRow` 去报 `formula_not_allowed`，而不是被当成空行悄悄丢掉。
 */
function isBlankRow(row: RawRow): boolean {
  return row.every((cell) => !cell.formula && !cell.error && cell.text.trim().length === 0);
}

/** 把 CSV 文本解析成原始表格。 */
async function readCsvTable(content: Buffer | Uint8Array | string): Promise<RawTable> {
  // `bom` 剥离 UTF-8 BOM，`relax_column_count` 容忍列数不一致：两者都由库负责。
  //
  // `skip_empty_lines: true` 是**性能闸门，不是风格选择**，实测（1 MiB 全空行文件）：
  //   skip_empty_lines: false → 31 226 ms      skip_empty_lines: true → 20 ms
  // 差 1560 倍，且 `csv-parse/sync` 是同步的 —— 那个耗时全部发生在事件循环上，
  // 期间整个 API 进程不响应任何请求。块 4 把 Parser 接到 HTTP 之后，一个 1 MiB 的
  // 空行文件就能让服务器停摆 33 秒（10 MiB 约数分钟），而 1 MiB 远在 10 MiB 上限之内。
  //
  // 口径影响（有意为之，非疏漏）：**真正空行**（整行零字符）由本库丢弃，不再计入
  // `blankRows`；只有分隔符的行（`,,,,`）、纯空白行仍会到达 `isBlankRow` 并被计数，
  // 因此 CSV 与 XLSX 的「空行」判定标准本身没有分叉 —— 变的只是「真空白行提前出局」。
  // 没有任何调用方消费 `blankRows`，且对「整份都是空行」的文件来说，
  // 立即得到 `no_data_rows` 远好过挂起数分钟。
  const parser = parseCsvStream({
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  // **必须分块喂**：整块 `write(整份文件)` 会让库在一次 `_transform` 里就把整份切完，
  // 早停彻底失效（实测：一次 write 10 MiB 仍是 85 秒，与不设预算无异）。
  // 切成小块后，`pipe` 的背压保证我们读到一条就计数、超预算立刻中断，
  // 最多多做一块的功。
  const source = Readable.from(slicesOf(content, CSV_READ_CHUNK_BYTES));
  source.pipe(parser);

  const rows: RawRow[] = [];
  let overBudget = false;
  for await (const record of parser) {
    rows.push((record as ReadonlyArray<string>).map(toRawCell));
    // 让出事件循环：没有这一句，下面那条预算只是把「停摆 78 秒」换成
    // 「停摆 0.9 秒」，解析期间 API 仍然一条请求都不应答。
    if (rows.length % CSV_YIELD_EVERY_RECORDS === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    if (rows.length > MAX_PRODUCT_IMPORT_CSV_RECORDS) {
      overBudget = true;
      break;
    }
  }

  if (overBudget) {
    source.destroy();
    parser.destroy();
    throw new CsvRecordBudgetExceededError(
      MAX_PRODUCT_IMPORT_CSV_RECORDS + 1,
      MAX_PRODUCT_IMPORT_CSV_RECORDS,
    );
  }

  return collectRawTable('csv', null, rows);
}

/**
 * 把输入切成固定大小的块。
 *
 * 只做切片，不解释任何分隔符、引号或换行 —— 那些仍然是 `csv-parse` 的事。
 */
function* slicesOf(content: Buffer | Uint8Array | string, size: number): Generator<Buffer> {
  const buffer =
    typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, Math.min(offset + size, buffer.length));
  }
}

/** CSV 单元格：库已经完成了引号与换行处理，这里只需要去掉首尾空白。 */
function toRawCell(text: string): RawCell {
  return { text, formula: false, error: false };
}

/**
 * 拆出表头与非空数据行。
 *
 * 表头取第一条非空行，因此 BOM、前导空行和只有分隔符的空行都不会把表头挤偏。
 */
function collectRawTable(
  format: ProductImportFileFormat,
  sheetName: string | null,
  rows: ReadonlyArray<RawRow>,
): RawTable {
  let header: RawRow | null = null;
  const dataRows: RawRow[] = [];
  let blankRows = 0;
  let overflow = false;

  for (const row of rows) {
    if (isBlankRow(row)) {
      blankRows += 1;
      continue;
    }
    if (header === null) {
      header = row;
      continue;
    }
    if (dataRows.length > MAX_PRODUCT_IMPORT_DATA_ROWS) {
      // 已经确定超限，再收集行只会浪费内存；摘要只需要知道「超过上限」。
      overflow = true;
      break;
    }
    dataRows.push(row);
  }

  return { format, sheetName, header, dataRows, blankRows, overflow };
}

/** 把 XLSX 二进制读成原始表格，取第一个非空且可见的工作表。 */
async function readXlsxTable(content: Buffer): Promise<RawTable> {
  const workbook = new Workbook();
  await workbook.xlsx.load(content);

  for (const worksheet of workbook.worksheets) {
    // 隐藏工作表通常是模板的说明页，不该被当成商品数据。
    if (worksheet.state === 'hidden' || worksheet.state === 'veryHidden') {
      continue;
    }
    const rows: RawRow[] = [];
    for (let index = 1; index <= worksheet.rowCount; index += 1) {
      rows.push(readXlsxRow(worksheet.getRow(index)));
    }
    const table = collectRawTable('xlsx', worksheet.name, rows);
    if (table.header !== null) {
      return table;
    }
  }

  return {
    format: 'xlsx',
    sheetName: null,
    header: null,
    dataRows: [],
    blankRows: 0,
    overflow: false,
  };
}

/**
 * 让调用方的显式映射先认领列，返回「列序号 → 字段」。
 *
 * 三种认领失败都记成 **error** 而不是忽略：映射写错时丢掉的是**一整列**数据，
 * 而调用方以为自己已经说清楚了 —— 静默忽略等于让他在一无所知的情况下导入半份文件。
 */
function claimExplicitColumns(
  headers: ReadonlyArray<string>,
  columnMapping: ProductImportColumnMapping | undefined,
  issues: ProductImportIssue[],
): Map<number, ProductImportField> {
  const claimed = new Map<number, ProductImportField>();
  if (columnMapping === undefined) {
    return claimed;
  }

  for (const [name, column] of Object.entries(columnMapping)) {
    const field = PRODUCT_IMPORT_FIELDS.find((candidate) => candidate === name);
    if (field === undefined) {
      issues.push(
        makeIssue('error', 'mapping_unknown_field', `列映射里出现了不存在的字段名 ${name}`, {
          value: name,
        }),
      );
      continue;
    }
    const text = typeof column === 'string' ? column : '';
    const token = normalizeToken(text);
    // 空串与纯空白表头都不能认领：`normalizeToken('')` 会和 Excel 尾部那些空表头列
    // 撞上，那等于把字段映射到一个没有任何名字的列上。
    const index =
      token.length === 0 ? -1 : headers.findIndex((header) => normalizeToken(header) === token);
    if (index === -1) {
      issues.push(
        makeIssue(
          'error',
          'mapping_column_not_found',
          `列映射说字段 ${name} 对应列「${text}」，但这份文件里没有这一列`,
          { field, value: text },
        ),
      );
      continue;
    }
    const owner = claimed.get(index);
    if (owner !== undefined) {
      issues.push(
        makeIssue(
          'error',
          'mapping_column_conflict',
          `列「${headers[index] ?? ''}」被映射给了两个字段：${owner} 与 ${field}`,
          { column: headers[index] ?? null, field, value: headers[index] ?? null },
        ),
      );
      continue;
    }
    claimed.set(index, field);
  }

  return claimed;
}

/** 解析表头：先按显式映射认列，再让别名表认剩下的；报缺列与未知列。 */
function analyseHeader(header: RawRow, columnMapping?: ProductImportColumnMapping): HeaderAnalysis {
  const headers = header.map((cell) => cell.text.trim());
  const mapping = new Map<ProductImportField, number>();
  const seenTokens = new Set<string>();
  const issues: ProductImportIssue[] = [];

  // 显式映射优先于别名表。别名表是**猜**（按列名文本猜语义），而商户的行业用法它猜不对 ——
  // 同一个「商品编码」，在这份 ERP 导出里是规格级、在我们的模型里是商品级（见 §1.1）。
  // 猜错又必须能被纠正，这就是这个口子的全部意义。
  const claimedColumns = claimExplicitColumns(headers, columnMapping, issues);
  for (const [index, field] of claimedColumns) {
    mapping.set(field, index);
  }

  headers.forEach((name, index) => {
    // 已被显式映射认领的列：不再按别名认一次，也不该被报成「未知列」。
    if (claimedColumns.has(index)) {
      return;
    }
    const token = normalizeToken(name);
    if (token.length === 0) {
      // 完全空白的表头列无法映射，也不值得告警：Excel 常留下尾部的空格。
      return;
    }
    if (seenTokens.has(token)) {
      issues.push(
        makeIssue('error', 'duplicate_header', `表头 ${name} 重复出现`, {
          column: name,
          field: resolveProductImportColumn(name),
          value: name,
        }),
      );
      return;
    }
    seenTokens.add(token);

    const field = resolveProductImportColumn(name);
    if (field === null) {
      issues.push(
        makeIssue('warning', 'unknown_column', `未知列 ${name} 被忽略`, {
          column: name,
          value: name,
        }),
      );
      return;
    }
    if (mapping.has(field)) {
      issues.push(
        makeIssue('error', 'duplicate_header', `表头 ${name} 与前面的列映射到同一字段 ${field}`, {
          column: name,
          field,
          value: name,
        }),
      );
      return;
    }
    mapping.set(field, index);
  });

  for (const field of REQUIRED_PRODUCT_IMPORT_FIELDS) {
    if (!mapping.has(field)) {
      const aliases = PRODUCT_IMPORT_COLUMN_ALIASES[field].join(' / ');
      issues.push(
        makeIssue(
          'error',
          'missing_required_column',
          `缺少必填列 ${field}（可用表头：${aliases}）`,
          {
            field,
          },
        ),
      );
    }
  }

  return { mapping, headers, issues };
}

/** 构造「整批拒绝」的结果：没有预览行，errors 全部为文件级。 */
function rejectedResult(
  format: ProductImportFileFormat,
  sheetName: string | null,
  totalRows: number,
  blankRows: number,
  issues: ReadonlyArray<ProductImportIssue>,
): ProductImportParseResult {
  return {
    summary: {
      format,
      sheetName,
      totalRows,
      blankRows,
      previewRowCount: 0,
      failedRowCount: totalRows,
      spuCount: 0,
      errorCount: issues.filter((issue) => issue.severity === 'error').length,
      warningCount: issues.filter((issue) => issue.severity === 'warning').length,
      fatal: true,
      ok: false,
    },
    previewRows: [],
    issues,
  };
}

/** 单行解析结果。`row` 为 null 表示该行含 error，不可入库。 */
type RowParseResult = {
  readonly row: ProductImportPreviewRow | null;
  readonly issues: ReadonlyArray<ProductImportIssue>;
};

/** 解析一行数据：把单元格映射成 SPU/SKU 字段，并逐字段记录 issue。 */
function parseDataRow(cells: RawRow, analysis: HeaderAnalysis, rowNumber: number): RowParseResult {
  const issues: ProductImportIssue[] = [];
  const { mapping, headers } = analysis;

  const columnOf = (field: ProductImportField): string | null => {
    const index = mapping.get(field);
    return index === undefined ? null : (headers[index] ?? null);
  };

  /**
   * 读取一个映射字段的字面文本。
   *
   * @returns 空字符串表示该列为空；null 表示单元格不可用，此时已经记录了 issue。
   */
  const readFieldText = (field: ProductImportField): string | null => {
    const index = mapping.get(field);
    const cell = index === undefined ? EMPTY_RAW_CELL : (cells[index] ?? EMPTY_RAW_CELL);
    if (cell.formula) {
      issues.push(
        makeIssue('error', 'formula_not_allowed', '公式单元格不会被执行，请改为字面值', {
          rowNumber,
          column: columnOf(field),
          field,
        }),
      );
      return null;
    }
    if (cell.error) {
      issues.push(
        makeIssue('error', 'invalid_cell_value', 'Excel 错误值不能作为导入数据', {
          rowNumber,
          column: columnOf(field),
          field,
        }),
      );
      return null;
    }
    return cell.text.trim();
  };

  /** 读必填字段：空值记录 `missing_required_value`。 */
  const readRequiredText = (field: ProductImportField): string => {
    const text = readFieldText(field);
    if (text === null) {
      // 单元格不可用，已经记录了更具体的 issue，不重复报缺值。
      return '';
    }
    if (text.length === 0) {
      issues.push(
        makeIssue('error', 'missing_required_value', `必填字段 ${field} 为空`, {
          rowNumber,
          column: columnOf(field),
          field,
        }),
      );
    }
    return text;
  };

  /** 读可选文本：空值与不可用单元格都返回 null。 */
  const readOptionalText = (field: ProductImportField): string | null => {
    const text = readFieldText(field);
    return text === null || text.length === 0 ? null : text;
  };

  const productCode = readRequiredText('product_code');
  const title = readRequiredText('title');
  // 规格列**不存在**时，按商品编码合成一条默认规格：一个商品至少得有一个规格才卖得出去，
  // 而商户的表里根本没有「规格」这个概念（实测：23,330 行里 5,509 个商品、没有规格列）。
  //
  // 与「这一列某个格子为空」区分开：那种情况下面仍走 missing_required_value，**不合成**。
  // 文件说了有这一列，就得说清楚；猜哪一行该合成等于替商家改主意 —— 合成出来的编码
  // 会成为 upsert 的键，猜错一次，第二次导入就是新建一个商品。
  const skuCode = mapping.has('sku_code') ? readRequiredText('sku_code') : productCode;
  const categoryCode = readOptionalText('category_code');
  const externalProductId = readOptionalText('external_product_id');
  const subtitle = readOptionalText('subtitle');
  const productUrl = readOptionalText('product_url');
  const mainImageUrl = readOptionalText('main_image_url');
  const sourceUpdatedAtText = readOptionalText('source_updated_at');

  const sellingPointsText = readOptionalText('selling_points');
  const sellingPoints = sellingPointsText === null ? [] : splitSellingPoints(sellingPointsText);

  /** 解析一个属性列；失败时记录 issue 并返回空属性。 */
  const readAttributes = (field: ProductImportField): CatalogAttributes => {
    const text = readOptionalText(field);
    if (text === null) {
      return {};
    }
    const parsed = parseAttributes(text);
    if (!parsed.ok) {
      issues.push(
        makeIssue('error', parsed.code, parsed.message, {
          rowNumber,
          column: columnOf(field),
          field,
          value: text,
        }),
      );
      return {};
    }
    return parsed.attributes;
  };

  const commonAttributes = readAttributes('common_attributes');
  const skuAttributes = readAttributes('sku_attributes');
  const searchAttributes = readAttributes('search_attributes');

  /** 解析一个状态列；非法写法记录 `invalid_status` 并回退到缺省值。 */
  const readStatus = <T extends string>(
    field: ProductImportField,
    table: ReadonlyMap<string, T>,
    fallback: T,
  ): T => {
    const text = readOptionalText(field);
    if (text === null) {
      return fallback;
    }
    const status = table.get(normalizeToken(text));
    if (status === undefined) {
      issues.push(
        makeIssue('error', 'invalid_status', `状态值 ${text} 不在允许的取值范围内`, {
          rowNumber,
          column: columnOf(field),
          field,
          value: text,
        }),
      );
      return fallback;
    }
    return status;
  };

  const shelfStatus = readStatus('shelf_status', SHELF_STATUS_BY_TOKEN, DEFAULT_SHELF_STATUS);
  const skuStatus = readStatus('sku_status', SKU_STATUS_BY_TOKEN, DEFAULT_SKU_STATUS);

  let sourceUpdatedAt: string | null = null;
  if (sourceUpdatedAtText !== null) {
    sourceUpdatedAt = normalizeDateText(sourceUpdatedAtText);
    if (sourceUpdatedAt === null) {
      issues.push(
        makeIssue('error', 'invalid_date', `日期 ${sourceUpdatedAtText} 无法标准化`, {
          rowNumber,
          column: columnOf('source_updated_at'),
          field: 'source_updated_at',
          value: sourceUpdatedAtText,
        }),
      );
    }
  }

  const failed = issues.some((issue) => issue.severity === 'error');
  if (failed) {
    return { row: null, issues };
  }

  return {
    row: {
      rowNumber,
      spu: {
        productCode,
        title,
        categoryCode,
        externalProductId,
        subtitle,
        productUrl,
        mainImageUrl,
        sellingPoints,
        commonAttributes,
        shelfStatus,
        sourceUpdatedAt,
      },
      sku: {
        skuCode,
        variant: toStringAttributes(skuAttributes),
        searchAttributes: toStringAttributes(searchAttributes),
        status: skuStatus,
      },
    },
    issues,
  };
}

/** 汇总批次摘要。 */
function summarize(
  table: RawTable,
  previewRows: ReadonlyArray<ProductImportPreviewRow>,
  issues: ReadonlyArray<ProductImportIssue>,
  totalRows: number,
): ProductImportSummary {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  const failedRows = new Set<number>();
  for (const issue of issues) {
    if (issue.severity === 'error' && issue.rowNumber !== null) {
      failedRows.add(issue.rowNumber);
    }
  }
  return {
    format: table.format,
    sheetName: table.sheetName,
    totalRows,
    blankRows: table.blankRows,
    previewRowCount: previewRows.length,
    failedRowCount: failedRows.size,
    spuCount: new Set(previewRows.map((row) => row.spu.productCode)).size,
    errorCount,
    warningCount,
    fatal: false,
    ok: errorCount === 0,
  };
}

/**
 * 解析一份商品导入文件。
 *
 * 全过程不写数据库、不访问对象存储、不发网络请求：只把文件读成摘要、预览行与 issues。
 * 任何一条文件级 error（超限、损坏、缺必填列等）都会让整批被拒绝，`previewRows` 为空，
 * 上传层因此不会拿到「半个批次」。
 *
 * @param input - 文件格式与内容。
 * @returns 批次摘要、标准化预览行与逐字段 issues。
 */
export async function parseProductImportFile(
  input: ProductImportParseInput,
): Promise<ProductImportParseResult> {
  const { format, content, columnMapping } = input;

  if (!(PRODUCT_IMPORT_FILE_FORMATS as ReadonlyArray<string>).includes(format)) {
    return rejectedResult(format, null, 0, 0, [
      makeIssue('error', 'unsupported_file_format', `不支持的文件格式 ${String(format)}`),
    ]);
  }

  const buffer = Buffer.isBuffer(content)
    ? content
    : typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.from(content);

  if (buffer.byteLength > MAX_PRODUCT_IMPORT_FILE_BYTES) {
    return rejectedResult(format, null, 0, 0, [
      makeIssue(
        'error',
        'file_too_large',
        `文件大小 ${buffer.byteLength} 字节超过上限 ${MAX_PRODUCT_IMPORT_FILE_BYTES} 字节`,
      ),
    ]);
  }

  if (buffer.byteLength === 0) {
    return rejectedResult(format, null, 0, 0, [makeIssue('error', 'empty_file', '文件内容为空')]);
  }

  if (format === 'xlsx') {
    // 压缩体积过关不代表解压后过关：ZIP 能把 305 KiB 放大成 300 MiB，
    // 而 exceljs 会一次解压完所有条目 —— 那一步会直接把进程打死。详见
    // `xlsx-inflate-budget.ts` 的文件头注释。
    try {
      await assertXlsxWithinInflateBudget(buffer);
    } catch (error) {
      if (error instanceof XlsxInflateBudgetExceededError) {
        return rejectedResult(format, null, 0, 0, [
          makeIssue(
            'error',
            'file_too_large',
            `文件解压后至少 ${error.inflatedBytes} 字节，超过解压上限 ${error.budgetBytes} 字节`,
          ),
        ]);
      }
      // 不是合法 ZIP（或 jszip 读不了）：不在这里定性，落到下面既有的
      // `unreadable_file` 路径。否则会把「exceljs 能读、jszip 读不了」的文件
      // 从「读不了」变成一个新错误，白白引入回归。
    }
  }

  let table: RawTable;
  try {
    // CSV 用解码后的文本，XLSX 用原始二进制：exceljs 需要自己解压与解析 XML。
    table = format === 'csv' ? await readCsvTable(buffer) : await readXlsxTable(buffer);
  } catch (error) {
    // 记录数超预算是**内容裁决**，不是「读不了」：单独报，否则调用方会把它当成
    // 文件损坏去重传同一份文件。
    if (error instanceof CsvRecordBudgetExceededError) {
      return rejectedResult(format, null, 0, 0, [
        makeIssue(
          'error',
          'too_many_records',
          `文件行数超过上限 ${error.budget} 行，请拆分文件后重试`,
        ),
      ]);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return rejectedResult(format, null, 0, 0, [
      makeIssue('error', 'unreadable_file', `文件无法解析：${detail}`),
    ]);
  }

  if (format === 'xlsx' && table.header === null) {
    // 消息不能说「工作簿里没有非空工作表」：非空表**全被隐藏**时也走到这里，
    // 而那时这句是假的（隐藏的工作表会被跳过，见 readXlsxTable）。这里只声称
    // 可观测到的事实 —— 没有可见的工作表带表头行 —— 两种情况都成立。
    return rejectedResult(format, table.sheetName, 0, table.blankRows, [
      makeIssue(
        'error',
        'empty_workbook',
        '工作簿里没有可用的工作表：没有可见的工作表带表头行（被隐藏的工作表会被跳过）',
      ),
    ]);
  }

  if (table.header === null) {
    return rejectedResult(format, table.sheetName, 0, table.blankRows, [
      makeIssue('error', 'empty_file', '文件里没有表头行'),
    ]);
  }

  const analysis = analyseHeader(table.header, columnMapping);
  const headerErrors = analysis.issues.filter((issue) => issue.severity === 'error');
  if (headerErrors.length > 0) {
    // 表头不可信时继续按列取值只会产生成百上千条误导性的行级 issue。
    return rejectedResult(
      format,
      table.sheetName,
      table.dataRows.length,
      table.blankRows,
      analysis.issues,
    );
  }

  if (table.overflow || table.dataRows.length > MAX_PRODUCT_IMPORT_DATA_ROWS) {
    return rejectedResult(format, table.sheetName, table.dataRows.length, table.blankRows, [
      ...analysis.issues,
      makeIssue(
        'error',
        'too_many_rows',
        `数据行数超过上限 ${MAX_PRODUCT_IMPORT_DATA_ROWS} 行，请拆分文件后重试`,
      ),
    ]);
  }

  if (table.dataRows.length === 0) {
    return rejectedResult(format, table.sheetName, 0, table.blankRows, [
      ...analysis.issues,
      makeIssue('error', 'no_data_rows', '文件只有表头，没有数据行'),
    ]);
  }

  const issues: ProductImportIssue[] = [...analysis.issues];

  // 库里因此会出现一条**商家没写过**的规格。合成是必要的（没规格就卖不出去），
  // 但它必须出现在回执里 —— 商户下次拿库里的数据和自己的表对账时，得能解释多出来的那一行。
  if (!analysis.mapping.has('sku_code')) {
    issues.push(
      makeIssue(
        'warning',
        'sku_code_synthesized',
        '这份文件没有规格列，已按商品编码为每个商品合成一条默认规格',
      ),
    );
  }

  const previewRows: ProductImportPreviewRow[] = [];
  const skuCodeIndex = analysis.mapping.get('sku_code');
  const skuCodeColumn =
    skuCodeIndex === undefined ? null : (analysis.headers[skuCodeIndex] ?? null);

  // 先把整批解析完，再判定重复。一个 SKU 编码出现两次时，文件对「它属于哪个 SPU」
  // 是自相矛盾的：留下第一行等于替商家挑了一个可能错的归属。因此重复编码涉及的
  // 每一行都不进入预览，而不是留一行、丢后面的。
  const parsedRows = table.dataRows.map((cells, index) => parseDataRow(cells, analysis, index + 1));

  /** 每个 SKU 编码在可解析行里出现几次；只统计能解析的行，解析失败的行已经另有 issue。 */
  const skuCodeCounts = new Map<string, number>();
  for (const parsed of parsedRows) {
    if (parsed.row === null) {
      continue;
    }
    const { skuCode } = parsed.row.sku;
    skuCodeCounts.set(skuCode, (skuCodeCounts.get(skuCode) ?? 0) + 1);
  }

  parsedRows.forEach((parsed, index) => {
    // 逐行的 issue 按行号顺序落进 issues，重复判定的 issue 紧随其后，顺序保持稳定。
    issues.push(...parsed.issues);
    if (parsed.row === null) {
      return;
    }
    const { skuCode } = parsed.row.sku;
    if ((skuCodeCounts.get(skuCode) ?? 0) > 1) {
      issues.push(
        makeIssue(
          'error',
          'duplicate_sku_code',
          `SKU 编码 ${skuCode} 在本次导入中重复，涉及的行都无法确定归属`,
          {
            rowNumber: index + 1,
            column: skuCodeColumn,
            field: 'sku_code',
            value: skuCode,
          },
        ),
      );
      return;
    }
    previewRows.push(parsed.row);
  });

  return {
    summary: summarize(table, previewRows, issues, table.dataRows.length),
    previewRows,
    issues,
  };
}
