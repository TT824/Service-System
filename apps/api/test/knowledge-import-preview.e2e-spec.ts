import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Workbook } from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_PRODUCT_IMPORT_DATA_ROWS,
  MAX_PRODUCT_IMPORT_FILE_BYTES,
  parseAppConfig,
} from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';

const T1 = 'tenant-acme';
const S1 = 'store-acme-flagship';
const ADMIN = 'u-t1-admin';
const PREVIEW = '/api/v1/knowledge/import-batches/preview';

type DataEnvelope = { request_id: string; data: unknown; meta: Record<string, never> };
type ErrorEnvelope = { request_id: string; code: string; message: string; details: unknown[] };

/** 每个写库外的成功响应都带这三个字段；错误响应必须恰好带另外四个。 */
const SUCCESS_ENVELOPE_KEYS = ['data', 'meta', 'request_id'];
const ERROR_ENVELOPE_KEYS = ['code', 'details', 'message', 'request_id'];

/** 一份中文表头、两 SKU 同商品的 CSV —— 与块 4 真机探针用的是同一份内容。 */
const TWO_SKU_CSV = [
  '商品编码,商品标题,SKU 编码,副标题,上下架状态',
  'P100,云集版彩色卡通T恤,P100-RED,夏季新品,上架',
  'P100,云集版彩色卡通T恤,P100-BLUE,,上架',
  'P200,蓝图数码无线耳机,P200-BLK,,下架',
  '',
].join('\n');

/**
 * `TWO_SKU_CSV` 过一遍真实 HTTP 之后，`previewRows` 的**完整**内容 —— 逐字节量出来的，
 * 不是照着类型抄的（2026-09-16，块 6 探针）。
 *
 * 这是端到端正例的正文：中文列名 → 线上字段的**映射**就在这里，而不是「`spuCount`
 * 等于几」。`expect(...).toMatchObject` 只看计数的话，映射全错也照样绿。
 *
 * 几处看着像噪音、其实都是断言的点：
 * - `variant` / `searchAttributes` / `commonAttributes` / `sellingPoints` 是**空**的 ——
 *   夹具里没有变体列与属性列，所以它们必须是空对象 / 空数组，不是缺键。
 * - 只给第 1 行写了副标题，所以第 2、3 行是 `null`，不是缺键也不是空串。
 * - `上架` / `下架` 落在 `shelfStatus` 上是 `'on_shelf'` / `'off_shelf'`；
 *   夹具没写 SKU 状态，所以三行都是默认的 `'active'`。
 * - `sourceUpdatedAt` / `categoryCode` / `外部商品 id` / 图片 / 链接 都是 `null`：
 *   文件里没有这些列。它们有值时的解析是 `product-import-parser.spec.ts` 的事。
 */
const EXPECTED_TWO_SKU_PREVIEW_ROWS = [
  {
    rowNumber: 1,
    spu: {
      productCode: 'P100',
      title: '云集版彩色卡通T恤',
      categoryCode: null,
      externalProductId: null,
      subtitle: '夏季新品',
      productUrl: null,
      mainImageUrl: null,
      sellingPoints: [],
      commonAttributes: {},
      shelfStatus: 'on_shelf',
      sourceUpdatedAt: null,
    },
    sku: { skuCode: 'P100-RED', variant: {}, searchAttributes: {}, status: 'active' },
  },
  {
    rowNumber: 2,
    spu: {
      productCode: 'P100',
      title: '云集版彩色卡通T恤',
      categoryCode: null,
      externalProductId: null,
      subtitle: null,
      productUrl: null,
      mainImageUrl: null,
      sellingPoints: [],
      commonAttributes: {},
      shelfStatus: 'on_shelf',
      sourceUpdatedAt: null,
    },
    sku: { skuCode: 'P100-BLUE', variant: {}, searchAttributes: {}, status: 'active' },
  },
  {
    rowNumber: 3,
    spu: {
      productCode: 'P200',
      title: '蓝图数码无线耳机',
      categoryCode: null,
      externalProductId: null,
      subtitle: null,
      productUrl: null,
      mainImageUrl: null,
      sellingPoints: [],
      commonAttributes: {},
      shelfStatus: 'off_shelf',
      sourceUpdatedAt: null,
    },
    sku: { skuCode: 'P200-BLK', variant: {}, searchAttributes: {}, status: 'active' },
  },
];

/** 一行缺必填值、其余两行合法 —— 批次本身成功，只是有一行不能入库。 */
const ONE_BAD_ROW_CSV = [
  '商品编码,商品标题,SKU 编码',
  'P1,正常商品,SKU1',
  ',缺了商品编码,SKU2',
  'P3,另一个商品,SKU3',
  '',
].join('\n');

/** 上传一个文件并断言状态码，省去每处重复的四行。 */
function upload(
  app: INestApplication,
  content: string | Buffer,
  filename: string,
  expectStatus: number,
): request.Test {
  return request(app.getHttpServer())
    .post(PREVIEW)
    .set('x-member-id', ADMIN)
    .field('storeId', S1)
    .attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), filename)
    .expect(expectStatus);
}

/**
 * 把一份 CSV 补到**恰好** `bytes` 字节，用来压体积闸的分界。
 *
 * 填充物是**真正空行**（只有 `\n`）：`readCsvTable` 开了 `skip_empty_lines: true`，
 * 库会在计数之前就把它丢掉（`product-import-parser.ts:655-665` 那段注释记的就是这件事），
 * 所以补多少都不会碰到 `MAX_PRODUCT_IMPORT_CSV_RECORDS`（20000 条记录）。
 *
 * **不能换成「纯空白行」**（行里带空格）：那类行会到达 `isBlankRow` 并计入记录预算，
 * 10 MiB 的空白行足以先报 `too_many_records` —— 那时这条用例测的是记录预算，
 * 而不是体积闸，名字却还叫「恰好 10 MiB」。
 */
function padCsvToExactly(bytes: number): Buffer {
  const head = Buffer.from(TWO_SKU_CSV, 'utf8');
  if (head.byteLength > bytes) {
    throw new Error(`夹具头已有 ${head.byteLength} 字节，补不到 ${bytes} 字节`);
  }
  return Buffer.concat([head, Buffer.alloc(bytes - head.byteLength, 0x0a)]);
}

/**
 * 用 exceljs 拼一份真实的 XLSX：与 {@link TWO_SKU_CSV} **同样的列与同样的行**，
 * 只换容器格式 —— 这样才能断言「换容器不改变解析结果」。
 *
 * `exceljs` 不在 `apps/api` 的 `package.json` 里：它是 `@kefu/core` 的依赖，
 * 由 workspaces 提升到根 `node_modules`，测试用它构夹具可以正常解析。
 * 这里不做「顺手加个依赖」—— 那要动 lockfile，超出本块范围。
 * 同样的 `writeBuffer` → `Buffer` 转换在 `product-import-parser.spec.ts` 里已有一份。
 */
async function buildTwoSkuXlsx(): Promise<Buffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('商品');
  for (const row of [
    ['商品编码', '商品标题', 'SKU 编码', '副标题', '上下架状态'],
    ['P100', '云集版彩色卡通T恤', 'P100-RED', '夏季新品', '上架'],
    ['P100', '云集版彩色卡通T恤', 'P100-BLUE', '', '上架'],
    ['P200', '蓝图数码无线耳机', 'P200-BLK', '', '下架'],
  ]) {
    sheet.addRow(row);
  }
  // exceljs 在自己的类型声明里声明了一个模块内的 `Buffer` 接口，它不等同于 Node 的
  // `Buffer`，两者不能直接互相赋值。运行时它就是 Node Buffer，按 `Uint8Array`
  // 复制一份：既绕开声明差异，也保证测试拿到独立副本。
  return Buffer.from((await workbook.xlsx.writeBuffer()) as Uint8Array);
}

/**
 * 断言一个 fatal 响应把原因真的传到了调用方 —— 块 4 的 F1 的形态。
 *
 * 两个条件缺一不可，且**必须一起**断言（原先只有两条用例做到了，其余只写
 * `toContain(...)`，形状坏了看不出来）：
 * - **非空**：`details: []` 正是 F1 那个哑 400，调用方只拿到一句 "Bad Request"；
 * - **每个元素都是字符串**：`details` 是给调用方读的**原因清单**，混进数字 /
 *   布尔 / `null` 就不再是清单了。`sanitizeDetail`（`all-exceptions.filter.ts:109`）
 *   对这三类是**原样放行**的，只有对象才被 JSON 化并截断到 200 字符 ——
 *   也就是说 `BadRequestException([file.size])` 这种写法能让 `details` 变成
 *   `[10485761]`，调用方拿到一个光秃秃的数字，没有任何解释。
 *
 * 为什么只写 `toContain(...)` 不够（**实测，不是推断**）：往消息数组里塞一个
 * `42`（`['storeId 必填…', 42]`）—— `join(' ')` 会把数字一并串起来，
 * 于是 `toContain('storeId')` 照样通过，只有这一条 `every(...)` 会红。
 *
 * @param body - 已解析的错误响应体。
 * @returns 原样的 `details`，供调用方继续断言具体文案。
 */
function expectErrorReasons(body: ErrorEnvelope): ReadonlyArray<unknown> {
  expect(body.code).toBe('bad_request');
  expect(body.details.length).toBeGreaterThan(0);
  expect(body.details.every((detail) => typeof detail === 'string')).toBe(true);
  return body.details;
}

/**
 * 商品导入预览端点的接口测试。
 *
 * 覆盖四件事：
 * 1. **成功是 200**（纯预览，没有资源被创建）—— 块 5；
 * 2. **整批不可读是 400 `bad_request` 且原因进 `details`** —— 块 5，
 *    原因必须能传到调用方，见块 4 的 F1（全局过滤器只把数组形式的 message
 *    收进 `details`，字符串会被有意隐去）；
 * 3. **预览行的完整内容**（中文列名→线上字段的映射、空列/缺列/枚举的落法）—— 块 6；
 * 4. **边界**（恰好 10 MiB 放行 / 超一字节走控制器业务闸 / 未知列只值一条 warning）
 *    —— 块 7。体积那条按 **400** 断言而不是 `summary.fatal`：体积闸在 Parser 之前
 *    就跑完了，`fatal` 是解析结论，按它断言会写出一个永远为假的用例。
 *
 * **除「门店越界」那一条外，每条 fatal 用例都经 {@link expectErrorReasons} 断言
 * `details` 非空且全为字符串。** 那一条是**例外且有原因**：它的拒绝来自
 * `assertStoreInTenant`，抛的是字符串 message，会被全局过滤器隐去，所以
 * `details` 是**空**的 —— 这是平台级问题（`access.service.ts` / `request-body.ts`
 * 都是这样），见计划文档 §8，不在本端点范围内。它断言 `toEqual([])` 正是把这个
 * 已知留白钉住：**哪天平台把字符串改成数组，这条会红，提醒改这里**。
 */
describe('Knowledge import preview (interface)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    }).compile();

    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);
  });

  afterAll(async () => {
    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  it('returns 200 with the preview for a readable csv', async () => {
    const response = await upload(app, TWO_SKU_CSV, 'products.csv', 200);
    const body = response.body as DataEnvelope;

    // 201 是 Nest 对 POST 的默认值，也是块 4 中间态的实际返回值：它声称创建了
    // 资源，而这里什么都不创建。上面那句 expect(200) 才是这条断言的正文，
    // 下面这行把它钉在文档上。
    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(SUCCESS_ENVELOPE_KEYS);

    const data = body.data as {
      summary: Record<string, unknown>;
      previewRows: ReadonlyArray<{ spu: Record<string, unknown>; sku: Record<string, unknown> }>;
      issues: ReadonlyArray<unknown>;
    };
    expect(data.summary).toMatchObject({
      format: 'csv',
      totalRows: 3,
      previewRowCount: 3,
      spuCount: 2,
      failedRowCount: 0,
      fatal: false,
      ok: true,
    });
    expect(data.previewRows.map((row) => row.sku['skuCode'])).toEqual([
      'P100-RED',
      'P100-BLUE',
      'P200-BLK',
    ]);
    // 同一商品的两行共用商品编码，预览里因此是 3 行而不是 3 个商品。
    expect(data.previewRows.map((row) => row.spu['productCode'])).toEqual(['P100', 'P100', 'P200']);
    // 上面两行管**顺序**，下面这一行管**内容**：中文列名到线上字段的映射、
    // 空列 / 缺列 / 枚举值各自的落法，全在这一条里。见常量上的注释。
    expect(data.previewRows).toEqual(EXPECTED_TWO_SKU_PREVIEW_ROWS);
    expect(data.issues).toEqual([]);
  });

  it('returns the same preview when the same rows arrive as xlsx', async () => {
    // 端点的两种格式里，在此之前 xlsx **只有失败路径**被覆盖过（`bogus.xlsx`）——
    // 「传一份真的 Excel 会怎样」在 HTTP 层从来没被证明过，而 Excel 恰恰是这份功能
    // 最可能的真实入口。夹具与 `TWO_SKU_CSV` 逐行相同，所以断言也应当逐字段相同：
    // **容器格式不该改变解析结果**，只有 `format` 与 `sheetName` 该变。
    const response = await upload(app, await buildTwoSkuXlsx(), 'products.xlsx', 200);
    const data = (response.body as DataEnvelope).data as {
      summary: Record<string, unknown>;
      previewRows: ReadonlyArray<unknown>;
      issues: ReadonlyArray<unknown>;
    };

    expect(data.summary).toMatchObject({
      format: 'xlsx',
      sheetName: '商品',
      totalRows: 3,
      previewRowCount: 3,
      spuCount: 2,
      failedRowCount: 0,
      fatal: false,
      ok: true,
    });
    // 同一个常量在 CSV 那条用例里也用了：两份夹具逐行相同，预览就必须逐字段相同。
    expect(data.previewRows).toEqual(EXPECTED_TWO_SKU_PREVIEW_ROWS);
    expect(data.issues).toEqual([]);
  });

  it('keeps a batch with one unusable row at 200 and reports the row in issues', async () => {
    const response = await upload(app, ONE_BAD_ROW_CSV, 'products.csv', 200);
    const data = (response.body as DataEnvelope).data as {
      summary: Record<string, unknown>;
      previewRows: ReadonlyArray<unknown>;
      issues: ReadonlyArray<{ code: string; severity: string; rowNumber: number | null }>;
    };

    // 行级 issue 不是文件级 issue：批次照常成功，坏行不进预览。把它也判成 4xx
    // 会让「三行里有一行要改」看起来像「整份文件不能用」。
    expect(data.summary).toMatchObject({
      fatal: false,
      ok: false,
      totalRows: 3,
      previewRowCount: 2,
    });
    expect(data.previewRows).toHaveLength(2);
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0]).toMatchObject({
      code: 'missing_required_value',
      severity: 'error',
      rowNumber: 2,
    });
  });

  it('keeps an unknown column as a warning and still imports the row', async () => {
    // 「未知列」是**列**上的问题，不是行上的：多一列不该让整批不可用，也不该把这一行
    // 吃掉，它只值一条 warning。
    //
    // 列层语义在 `product-import-parser.spec.ts` 里早有断言（`unknown_column` /
    // `severity: 'warning'`），但**线上从没证明过会怎样** —— e2e 此前一条正例都
    // 没有未知列，所以「200 加一条 warning」和「整批 400」在 HTTP 层长得一样可信。
    const csv = [
      '商品编码,商品标题,SKU 编码,自定义备注列',
      'P1,带一列未知字段的商品,SKU1,这列谁都不认识',
      '',
    ].join('\n');

    const response = await upload(app, csv, 'unknown-column.csv', 200);
    const data = (response.body as DataEnvelope).data as {
      summary: Record<string, unknown>;
      previewRows: ReadonlyArray<unknown>;
      issues: ReadonlyArray<{ code: string; severity: string }>;
    };

    expect(data.summary).toMatchObject({ fatal: false, totalRows: 1, previewRowCount: 1 });
    // 行**必须**还在预览里：未知列若把行吃掉，这条就成了「200，但什么都没导入」，
    // 而上面那句 `summary` 断言照样绿 —— 所以要单独钉住 `previewRows`。
    expect(data.previewRows).toHaveLength(1);
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0]).toMatchObject({ code: 'unknown_column', severity: 'warning' });
  });

  it('rejects a zero-byte file at 400 with a reason', async () => {
    // **名字原为「no header」，与它实际走的路径不符**（块 7 复核时逐条读代码发现的）：
    // 零字节文件在 `parseProductImportFile` 里先撞 `buffer.byteLength === 0`
    // （`product-import-parser.ts:1138`），报的是 `empty_file` —— **与表头无关**。
    // 真正「有行但没有表头」的文件走的是另一条路：首行被当表头，别名匹配不上，
    // 于是报 `missing_required_column`，那是下面缺必填列那条用例的事。
    const response = await upload(app, '', 'empty.csv', 400);
    const body = response.body as ErrorEnvelope;

    expect(Object.keys(body).sort()).toEqual(ERROR_ENVELOPE_KEYS);
    expect(body.message).toBe('Bad Request');
    // 钉到 `文件内容为空` 整句：只写 `为空` 是**分不开**的 —— `为空` 同时出现在
    // `empty_file`（文件内容为空）、`missing_required_value`（必填字段 X 为空）、
    // `invalid_attributes`（属性名不能为空）三条消息里。
    expect(expectErrorReasons(body).join(' ')).toContain('文件内容为空');
  });

  it('rejects a header-only file at 400 with a reason', async () => {
    const response = await upload(app, '商品编码,商品标题,SKU 编码\n', 'header-only.csv', 400);

    expect(expectErrorReasons(response.body as ErrorEnvelope).join(' ')).toContain('没有数据行');
  });

  it('rejects a file missing a required column at 400 with a reason', async () => {
    // 缺的是 `商品标题`。**不能拿 `SKU 编码` 来考这条**：2026-09-18 之后规格列是
    // 可选的（没有它就按商品编码合成一条默认规格），拿它当反例，这条用例会在
    // 「规格列可选」上线的那一刻变成 200 —— 一期就是在这里红的。
    const response = await upload(app, '商品编码\nP1\n', 'missing-column.csv', 400);

    const reasons = expectErrorReasons(response.body as ErrorEnvelope).join(' ');
    // 两条一起断言，缺一条这题就松了。`missing_required_column` 的消息是
    // 「缺少必填列 <内部字段名>（可用表头：<别名列表>）」——`商品标题` 只出现在
    // **别名列表**里，而 `缺少必填列` 才是这个判据本身。
    // 只写 `toContain('商品标题')` 的话，任何**仍然 400、别名串里带到商品标题**的
    // 其它 issue（换成重复表头、行数超限……）都会让它照绿，用例名却在说「缺必填列」。
    expect(reasons).toContain('缺少必填列');
    expect(reasons).toContain('商品标题');
  });

  it('rejects a file that is not really xlsx at 400 rather than crashing', async () => {
    // 声明成 xlsx 却不是 ZIP：exceljs 读不了。它必须是 400 加一句原因，
    // 而不是 500 —— 调用方要能分辨「我传错了文件」和「服务端坏了」。
    const response = await upload(app, Buffer.from('not a zip at all'), 'bogus.xlsx', 400);

    expect(expectErrorReasons(response.body as ErrorEnvelope).join(' ')).toContain('无法解析');
  });

  it('rejects a file above the data-row limit at 400 with a reason', async () => {
    const rows = Array.from(
      { length: MAX_PRODUCT_IMPORT_DATA_ROWS + 1 },
      (_unused, index) => `P${index},商品${index},SKU${index}`,
    );
    const response = await upload(
      app,
      `商品编码,商品标题,SKU 编码\n${rows.join('\n')}\n`,
      'too-many-rows.csv',
      400,
    );
    expect(expectErrorReasons(response.body as ErrorEnvelope).join(' ')).toContain(
      `${MAX_PRODUCT_IMPORT_DATA_ROWS}`,
    );
  });

  it('rejects a too-large upload at 400 through the multipart memory backstop', async () => {
    // 越过 multer 的内存保护线：拦截器在方法体之前就抛 413，由
    // `ImportUploadTooLargeFilter` 收敛回 400。这条断言的是收敛后的形状，
    // 不是体积判据本身（体积判据由上面那条数据行用例与 Parser 的用例覆盖）。
    const oversized = Buffer.alloc(12 * 1024 * 1024, 0x61);
    const response = await upload(app, oversized, 'huge.csv', 400);
    const body = response.body as ErrorEnvelope;

    expect(Object.keys(body).sort()).toEqual(ERROR_ENVELOPE_KEYS);
    // 钉到后备闸**专属**的措辞：它的消息是「文件超过 <上限> 字节上限」，**不带实际字节数**；
    // 控制器业务闸的消息是「文件 <实际字节数> 字节，超过 <上限> 字节上限」。
    // 只写 `toContain('超过')` 是分不开两道闸的（两条都含「超过」）——
    // 那样一来，若 multer 的 `fileSize` 被调大、12 MiB 改由业务闸拒，
    // 这条用例仍会全绿，而它的名字说的是 `through the multipart memory backstop`。
    expect(expectErrorReasons(body).join(' ')).toContain(
      `文件超过 ${MAX_PRODUCT_IMPORT_FILE_BYTES} 字节上限`,
    );
  });

  it('accepts a file of exactly the 10 MiB limit, the side both size gates compare with >', async () => {
    // D-3-1：两道体积闸用的都是 `>` —— multer 后备闸（10 MiB + 1 MiB）与控制器业务闸
    // （`knowledge.controller.ts:444` `file.size > MAX_PRODUCT_IMPORT_FILE_BYTES`）。
    // 所以「恰好 10 MiB」**必须放行**。原条目只写了「超过 10 MiB → …」，那测不到这条线：
    // 真正的边界在「等于」这一侧，而它此前一条用例都没有。
    const file = padCsvToExactly(MAX_PRODUCT_IMPORT_FILE_BYTES);

    // 先断言**仪器本身**。夹具少一字节，这条用例就压根没碰到边界；多一字节，它测的是
    // 下面那条用例 —— 而两种情况下「返回 200」这句断言都照样绿。所以长度要单独钉住。
    expect(MAX_PRODUCT_IMPORT_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(file.byteLength).toBe(10485760);

    const response = await upload(app, file, 'exactly-10mib.csv', 200);
    const data = (response.body as DataEnvelope).data as {
      summary: Record<string, unknown>;
      previewRows: ReadonlyArray<unknown>;
    };

    // 放行不只是「没报错」：用来补足体积的空行不该变成数据行，夹具那 3 行照常解析出来。
    expect(data.summary).toMatchObject({
      totalRows: 3,
      previewRowCount: 3,
      fatal: false,
      ok: true,
    });
    expect(data.previewRows).toHaveLength(3);
  });

  it('rejects one byte over the limit through the controller gate, not the multer one', async () => {
    // 与上一条只差一个字节，落到的却是**另一道闸**：10485761 < 11 MiB，所以 multer 放行，
    // 由控制器的业务闸拒。两条闸的消息不同 —— 后备闸说「文件超过 N 字节上限」，
    // 业务闸会把**实际字节数**一并带上，所以消息里出现 10485761 就说明拒的是业务闸。
    // （上一轮闸门只覆盖了 12 MiB 的那条 multer 路径，业务闸在 HTTP 层从未被走到过。）
    const file = padCsvToExactly(MAX_PRODUCT_IMPORT_FILE_BYTES + 1);
    expect(file.byteLength).toBe(10485761);

    const response = await upload(app, file, 'one-byte-over.csv', 400);
    const body = response.body as ErrorEnvelope;

    // 断言到**具体措辞**，因为「400 + 带上实际字节数 + 超过」不止一道闸能满足：
    // 业务闸说的是「文件 10485761 字节，超过 10485760 字节上限」，而 Parser 自己那条
    // 体积判据（`product-import-parser.ts:1128`）说的是「文件大小 10485761 字节超过上限
    // 10485760 字节」—— 同样带实际字节数。只 `toContain('10485761')` 是分不开两者的，
    // 所以这里钉住业务闸独有的「文件 <n> 字节」（`文件` 与数字之间**没有**「大小」）。
    const reasons = expectErrorReasons(body).join(' ');
    expect(reasons).toContain(`文件 ${MAX_PRODUCT_IMPORT_FILE_BYTES + 1} 字节`);
    expect(reasons).toContain('超过');
    // 体积是**入口校验**，发生在 Parser 之前 —— 所以它只能是 400，永远拿不到
    // `summary.fatal` 那个解析结论。这里刻意不断言 `fatal`：那会写出一个永远为假的用例。
  });

  it('names the missing file instead of returning a silent 400', async () => {
    // 块 4 的 F1：控制器自己抛的三条（缺件 / 缺 storeId / 格式不认）原先都是**字符串**
    // message，被全局过滤器隐去，调用方只拿到 `details: []` 的哑 400，无从知道少了什么。
    // 下面三条就是 F1 的守卫 —— 少一条断言，F1 就可能被悄悄改回去而全绿。
    const response = await request(app.getHttpServer())
      .post(PREVIEW)
      .set('x-member-id', ADMIN)
      .field('storeId', S1)
      .expect(400);

    expect(expectErrorReasons(response.body as ErrorEnvelope).join(' ')).toContain('file');
  });

  it('names the missing storeId instead of returning a silent 400', async () => {
    const response = await request(app.getHttpServer())
      .post(PREVIEW)
      .set('x-member-id', ADMIN)
      .attach('file', Buffer.from(TWO_SKU_CSV, 'utf8'), 'products.csv')
      .expect(400);

    expect(expectErrorReasons(response.body as ErrorEnvelope).join(' ')).toContain('storeId');
  });

  it('names the unusable declared format instead of returning a silent 400', async () => {
    const response = await request(app.getHttpServer())
      .post(PREVIEW)
      .set('x-member-id', ADMIN)
      .field('storeId', S1)
      .field('format', '123')
      .attach('file', Buffer.from(TWO_SKU_CSV, 'utf8'), 'products.csv')
      .expect(400);

    // 这条走的是 `resolveImportFormat` 的**声明分支**：显式传了 format 就不看扩展名。
    expect(expectErrorReasons(response.body as ErrorEnvelope).join(' ')).toContain('123');
  });

  it('refuses a file whose extension names no known format', async () => {
    const response = await upload(app, TWO_SKU_CSV, 'products.txt', 400);

    // 走的是**推断分支**：没传 format，从扩展名推不出来。两条分支各有各的消息，
    // 上面那条覆盖声明分支，这条覆盖推断分支。
    expect(expectErrorReasons(response.body as ErrorEnvelope).join(' ')).toContain('products.txt');
  });

  it('refuses a store outside the acting member tenant', async () => {
    // 先跑正对照：租户 2 的管理员传自己门店，必须 200。少了这一句，「租户 2 这条路
    // 整体是坏的」和「门店越界被拒」会给出完全相同的 400，下面那条断言就什么都证明不了。
    await request(app.getHttpServer())
      .post(PREVIEW)
      .set('x-member-id', 'u-t2-admin')
      .field('storeId', 'store-beta-official')
      .attach('file', Buffer.from(TWO_SKU_CSV, 'utf8'), 'products.csv')
      .expect(200);

    // 同一份文件、同一个门店，只换租户：文件本身没问题，拒绝只能来自门店归属。
    const response = await request(app.getHttpServer())
      .post(PREVIEW)
      .set('x-member-id', 'u-t2-admin')
      .field('storeId', S1)
      .attach('file', Buffer.from(TWO_SKU_CSV, 'utf8'), 'products.csv')
      .expect(400);

    const body = response.body as ErrorEnvelope;
    expect(body.code).toBe('bad_request');
    // **本套件里唯一不走 `expectErrorReasons` 的一条**（文件头注释已把它标成例外）。
    // 拒绝来自 `assertStoreInTenant`，它抛的是**字符串** message，全局过滤器会把它
    // 隐去（`all-exceptions.filter.ts:88`），所以这里 details 是空的 —— 与本端点
    // 自己抛的三条（数组形式、details 非空）不是一回事。平台级问题，见计划文档 §8。
    //
    // 这里**故意断言 `[]`**：把这个已知留白钉住。哪天 §8 那条待办被做掉
    // （`access.service.ts` 的字符串改成数组），这条会**红** —— 那是提醒
    // 「这里该改成 `expectErrorReasons` 了」，不是回归。红的时候顺手把它换过来即可。
    expect(body.details).toEqual([]);
  });

  it('leaves the tenant under test untouched by a preview', async () => {
    // 纯预览：跑完整份文件也不该落下任何东西。断言的是「什么都没变」，
    // 所以它必须排在写用例之后、且不依赖上面任何一条的写入。
    const products = await request(app.getHttpServer())
      .get('/api/v1/knowledge/products')
      .set('x-member-id', ADMIN)
      .expect(200);
    const list = (products.body as DataEnvelope).data as ReadonlyArray<Record<string, unknown>>;

    expect(list.every((item) => item['tenantId'] === T1)).toBe(true);
    // 两份夹具里的商品编码都不该出现在目录里。
    const codes = list.map((item) => item['productCode']);
    expect(codes).not.toContain('P100');
    expect(codes).not.toContain('P1');
  });
});
