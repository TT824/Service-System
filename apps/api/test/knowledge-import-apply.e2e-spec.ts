import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Workbook } from 'exceljs';
import type { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig, type ProductImportApplyResult } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';
import {
  isDatabaseReachable,
  openDatabaseClient,
  resolveDatabaseUrl,
} from './database-test-support';

/**
 * `POST knowledge/import-batches/apply` 的接口测试：上传一份表格，**真的落库**。
 *
 * 方案的判定标准 1–4 全在这里，而且每一条都**从表里读回**，不是从回执里读回：
 * 回执说「落了 2 个商品」和表里真的有 2 行是两件事，中间隔着 `planProductImport`
 * 与 `applyProductImportBatch` 两层，只断言回执的话，两层都写错也照样绿。
 *
 * **四条承重断言**（每条都做了注入反证，见本块交付说明）：
 * 1. xlsx 的两商品三规格**逐行落进 `product_spus` / `product_skus`**，且 `类目编码`
 *    被换成了种子类目的 id（不是 `null`，也不是原样存编码）；
 * 2. 同一份文件导第二遍是 `update`：`created*Count` 为 0、表里的**行数不变、id 不变**
 *    （证明是 upsert，不是「删了重建」——后者会让商品丢掉自己原来的 id）；
 * 3. 坏行落进 `product_import_errors`，**行号指回文件的数据行**（判定标准 3 的
 *    「能对回行号」），且被拒商品**一行都没有进 `product_spus`**；
 * 4. 越界的 `storeId` 是 400，且**一行都没写**（判定标准 4）。写入是这条端点的
 *    全部副作用，只断言状态码等于没验。
 *
 * **夹具自带租户。** `knowledge-index-status.e2e-spec.ts` 在自己的 `beforeAll` 里
 * 断言 `tenant-acme` / `tenant-beta` 是干净的，所以往那两个租户写商品会让本套件
 * 的成败取决于文件执行顺序。这里另开租户，清理是一条 `tenant_id = ANY($1)`。
 *
 * **`product_spus.source_type` 与 `product_import_batches.source_type` 不是同一个值**，
 * 本套件把这个差异钉住：文件是 xlsx 时批次记 `xlsx`（`0010` 的 CHECK 收它），
 * 商品记 `csv`（`0009` 的 CHECK 只收 `manual/csv/internal_api/channel_api`）。
 * 方案 §5 曾把两张表的取值混为一谈，并据此在界面上写下一句假话；这条断言就是为了
 * 让下次再混的时候有东西会红。
 */
const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** 本次运行的唯一后缀：本套件写的每一行都带它，清理时按租户整体删。 */
const RUN = randomUUID().slice(0, 8);

/** 本套件自己的租户与门店 —— 判定标准 1–3 都发生在这里。 */
const TENANT = `tenant-ia-${RUN}`;
/**
 * 正例用 {@link STORE}，坏例用 {@link STORE_B}。
 *
 * **两个门店是刻意的**：两条用例都要断言「表里恰好有这几个编码」，共用一个门店时
 * 后跑的那条会把前一条留下的商品也数进来，于是「恰好」这个词就不再指向本用例
 * 写进去的东西 —— 那正是「断言必须能指名它说的那条路」的场合。
 */
const STORE = `store-ia-${RUN}`;
const STORE_B = `store-ia-b-${RUN}`;
/** 二期：列映射那组用例。 */
const STORE_C = `store-ia-c-${RUN}`;
/** 二期：没有规格列那组用例（合成默认规格）。 */
const STORE_D = `store-ia-d-${RUN}`;
/** 另一个租户的门店：只用来证明越界 `storeId` 被拒（判定标准 4）。 */
const FOREIGN_TENANT = `tenant-ix-${RUN}`;
const FOREIGN_STORE = `store-ix-${RUN}`;

/** 种子类目：`类目编码` 列写 `CAT-A` 时必须解析成这个 id。 */
const CATEGORY_CODE = 'CAT-A';
const CATEGORY_ID = `pcat-ia-${RUN}`;

/**
 * 请求借用的身份：平台管理员。
 *
 * 用平台管理员而不是本租户的商家管理员：`x-member-id` 走的是**演示目录**
 * （`access.service.ts` 的 `#requireDemoMember`），目录里没有本套件现造的租户成员；
 * 而平台管理员的租户范围来自 `x-tenant-id` 头，正好能指到本套件新开的租户。
 * 它的角色也满足 `requireConfigurator`（落库是写路径，坐席不给 —— 最后一条用例
 * 单独验这件事）。
 */
const PLATFORM_ADMIN = 'u-platform-admin';
/** 坐席，用来验「只读角色一个字节也写不进去」。 */
const AGENT = 'u-t1-agent-1';

const PREVIEW_URL = '/api/v1/knowledge/import-batches/preview';
const APPLY_URL = '/api/v1/knowledge/import-batches/apply';
const batchUrl = (batchId: string): string => `/api/v1/knowledge/import-batches/${batchId}`;

/** 成功响应被全局拦截器包成这三层；取正文走 `data`。 */
type ApplyEnvelope = {
  readonly request_id: string;
  readonly data: ProductImportApplyResult;
  readonly meta: Record<string, never>;
};

/** `GET import-batches/:id` 的正文：批次本身与它的失败行。 */
type BatchEnvelope = {
  readonly request_id: string;
  readonly data: {
    readonly batch: ProductImportApplyResult['batch'];
    readonly errors: ProductImportApplyResult['errors'];
  };
  readonly meta: Record<string, never>;
};

/** 上传用到的表头，中文列名 —— 与商家手里那份表一致。 */
const COLUMNS = ['商品编码', '商品标题', 'SKU 编码', '副标题', '类目编码'];

/**
 * 正例：两商品三规格，其中 P100 的两行是同一个商品的两个规格。
 *
 * `P200` 的类目留空：空类目是**合法**的（商品可以没有类目），所以它必须落库、
 * 且 `category_id` 为 `null` —— 与「类目编码写错」那一行（本文件下面那条用例）
 * 刚好是一对：同样是没类目，一个是没写，一个是写错，处置完全不同。
 */
const HAPPY_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ['P100', '云集版彩色卡通T恤', 'P100-RED', '夏季新品', CATEGORY_CODE],
  ['P100', '云集版彩色卡通T恤', 'P100-BLUE', '', CATEGORY_CODE],
  ['P200', '蓝图数码无线耳机', 'P200-BLK', '', ''],
];

/**
 * ERP 导出的列名原样：`款式编码` 是商品级、`商品编码` 是规格级。
 *
 * 这两层含义同一个中文表头在两套系统里指的不是同一件事：我们的别名表把 `商品编码`
 * 读成 `product_code`（商品级 upsert 键），而商户的 ERP 用它指**规格**。写死的别名表
 * 永远猜不对，所以商户**不必改表**，改的是我们对这份表的读法 —— `mapping` 就是那个口子。
 */
const ERP_COLUMNS = ['款式编码', '商品编码', '商品标题', '颜色'];

/**
 * 四行两商品四规格：真文件 23,330 行 / 5,509 商品的缩样，结构一一对应。
 *
 * `YSSO4056B` 一个款式挂两个商品编码。**同一份字节有两种读法**，这就是二期存在的理由：
 *
 * | 读法 | 结果 |
 * |---|---|
 * | 带 mapping | 2 个商品 × 2 个规格（对的） |
 * | 不带 mapping（别名表把 `商品编码` 当商品级键） | 4 个商品、每个一条合成规格，且**一条错误都不报** |
 */
const ERP_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ['YSSO4056B', 'YSSO4056B-01', '重磅卫衣', '黑'],
  ['YSSO4056B', 'YSSO4056B-02', '重磅卫衣', '白'],
  ['YSSO4100', 'YSSO4100-01', '工装裤', '卡其'],
  ['YSSO4100', 'YSSO4100-02', '工装裤', '军绿'],
];

/** 把两层编码说清楚：我们的字段 → 文件里的列名。列名是原文。 */
const ERP_MAPPING = {
  product_code: '款式编码',
  sku_code: '商品编码',
} as const;

/** 一份**没有规格列**的表：规格在商户眼里根本不存在（一号一商品）。 */
const NO_SKU_COLUMNS = ['商品编码', '商品标题'];
const NO_SKU_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ['S100', '无规格商品'],
  ['S200', '另一个无规格商品'],
];

/**
 * 坏例：6 个数据行里 4 行进不去，剩下 2 行必须照常落库。
 *
 * 四种毛病各占一行，**行号是这条用例的正文**：
 *
 * | 行 | 内容 | 谁拒的 | 码 |
 * |---|---|---|---|
 * | 2 | 标题为空 | Parser（必填缺值） | `missing_required_value` |
 * | 3 | `类目编码 = NOPE` | 计划层（本门店没这个类目） | `category_not_found` |
 * | 4 | `P600-1` 第一次出现 | 都不是 | —— |
 * | 5 | `P600-1` 第二次出现 | Parser（重复编码，**两行一起拒**） | `duplicate_sku_code` |
 *
 * 第 4、5 行是同一对重复编码：Parser 的判据是「这个编码出现了几次」，所以它把
 * **涉及的两行都拿出预览**，而不是留第一行丢第二行 —— 留下哪一行等于替商家挑了
 * 一个可能错的归属。于是行 4 也进不去，第 4 行的 `P600` 因此一个规格都不剩，
 * 商品本身也不落（库里不该有没规格的商品）。
 */
const BAD_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ['P300', '正常商品A', 'P300-1', '', CATEGORY_CODE],
  ['P400', '', 'P400-1', '', CATEGORY_CODE],
  ['P500', '类目不存在', 'P500-1', '', 'NOPE'],
  ['P600', '重复编码商品', 'P600-1', '', CATEGORY_CODE],
  ['P600', '重复编码商品', 'P600-1', '', CATEGORY_CODE],
  ['P700', '正常商品B', 'P700-1', '', ''],
];

/** 一份 CSV：表头 + 给定的数据行。行号因此恰好是「数据行序号」，从 1 开始。 */
function csvOf(rows: ReadonlyArray<ReadonlyArray<string>>): Buffer {
  return Buffer.from(
    [COLUMNS.join(','), ...rows.map((row) => row.join(','))].join('\n') + '\n',
    'utf8',
  );
}

/**
 * 用 exceljs 拼一份真实的 XLSX，内容与 {@link csvOf} 同构，只换容器。
 *
 * 判定标准 1 点名要 xlsx（商家手里就是 xlsx），而这与合法性无关：格式由**文件后缀**
 * 决定（`resolveImportFormat`），所以换容器必须不改变落库结果 —— 这正是本套件用
 * xlsx 跑正例、用 CSV 跑坏例的原因：两条容器路径都被真库验过。
 *
 * `exceljs` 不在 `apps/api` 的 `package.json` 里，它是 `@kefu/core` 的依赖，由
 * workspaces 提升到根 `node_modules`；预览那套 e2e 已经这么用了，这里不另加依赖。
 * `Buffer.from(... as Uint8Array)` 那层复制是为了绕开 exceljs 声明里的模块内
 * `Buffer` 接口 —— 运行时它本来就是 Node Buffer。
 */
async function xlsxOf(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columns: ReadonlyArray<string> = COLUMNS,
): Promise<Buffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('商品');
  sheet.addRow([...columns]);
  for (const row of rows) {
    sheet.addRow([...row]);
  }
  return Buffer.from((await workbook.xlsx.writeBuffer()) as Uint8Array);
}

/** 上传选项：门店、租户、身份，以及二期的列映射。 */
type UploadOptions = {
  readonly storeId?: string;
  readonly tenantId?: string;
  readonly memberId?: string;
  /**
   * 列映射的 JSON 文本，multipart 的一个普通文本字段。
   *
   * 用**文本**而不是对象：浏览器上的 `FormData` 只能塞字符串，接口形状要跟真实
   * 调用方一致；同时 `undefined` 与 `''` 是两件事（不传 vs 传了个空），所以这里
   * 不写字段就等于不发这个字段。
   */
  readonly mapping?: string;
};

/** 发一次导入/预览；状态码由调用方断言，省去每处重复的 header 与 attach。 */
function upload(
  app: INestApplication,
  url: string,
  content: Buffer,
  filename: string,
  options: UploadOptions,
): request.Test {
  const pending = request(app.getHttpServer())
    .post(url)
    .set('x-member-id', options.memberId ?? PLATFORM_ADMIN)
    .set('x-tenant-id', options.tenantId ?? TENANT)
    .field('storeId', options.storeId ?? STORE);
  if (options.mapping !== undefined) {
    pending.field('mapping', options.mapping);
  }
  return pending.attach('file', content, filename);
}

/** 发一次 apply。 */
function apply(
  app: INestApplication,
  content: Buffer,
  filename: string,
  options: UploadOptions = {},
): request.Test {
  return upload(app, APPLY_URL, content, filename, options);
}

/** 发一次 preview（同一套闸门、同一个解析器，只是不落库）。 */
function preview(
  app: INestApplication,
  content: Buffer,
  filename: string,
  options: UploadOptions = {},
): request.Test {
  return upload(app, PREVIEW_URL, content, filename, options);
}

/** 本租户本门店的商品行，按编码排序 —— 「落了几个」这句话的正文。 */
async function spusOf(
  client: Client,
  tenantId = TENANT,
  storeId = STORE,
): Promise<
  ReadonlyArray<{
    readonly id: string;
    readonly product_code: string;
    readonly title: string;
    readonly subtitle: string | null;
    readonly category_id: string | null;
    readonly source_type: string;
  }>
> {
  const result = await client.query(
    `SELECT id, product_code, title, subtitle, category_id, source_type
       FROM product_spus
      WHERE tenant_id = $1 AND store_id = $2
      ORDER BY product_code`,
    [tenantId, storeId],
  );
  return result.rows;
}

/** 本租户本门店的规格行，带上所属商品编码 —— 归属是这条端点最容易写错的地方。 */
async function skusOf(
  client: Client,
  tenantId = TENANT,
  storeId = STORE,
): Promise<
  ReadonlyArray<{
    readonly sku_code: string;
    readonly spu_id: string;
    readonly product_code: string;
    readonly status: string;
  }>
> {
  const result = await client.query(
    `SELECT sku.sku_code, sku.spu_id, spu.product_code, sku.status
       FROM product_skus AS sku
       JOIN product_spus AS spu ON spu.id = sku.spu_id
      WHERE sku.tenant_id = $1 AND sku.store_id = $2
      ORDER BY sku.sku_code`,
    [tenantId, storeId],
  );
  return result.rows;
}

/**
 * 一次请求前后要对比的行数：批次、失败行、商品、规格。
 *
 * 「越界的 storeId 被拒」这条用例的正文不是 400，而是这四个数**一个都没变** ——
 * 状态码只说明请求被拒了，不说明没写进去。
 */
async function counts(client: Client, tenantId = TENANT): Promise<Record<string, string>> {
  const result = await client.query<{
    batches: string;
    errors: string;
    spus: string;
    skus: string;
  }>(
    `SELECT (SELECT count(*) FROM product_import_batches WHERE tenant_id = $1) AS batches,
            (SELECT count(*) FROM product_import_errors WHERE tenant_id = $1) AS errors,
            (SELECT count(*) FROM product_spus WHERE tenant_id = $1) AS spus,
            (SELECT count(*) FROM product_skus WHERE tenant_id = $1) AS skus`,
    [tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('counts 查询没有返回行');
  }
  return row;
}

describe.skipIf(!reachable)('Knowledge import apply (interface)', () => {
  let app: INestApplication;
  let client: Client;

  beforeAll(async () => {
    // `local` 选中 PostgreSQL 平台仓库（`test` 会换成进程内存里那个，商品永远为空），
    // 演示身份头是 `x-member-id` 这条路的前提，生产形状的环境里默认拒绝。
    const parsed = parseAppConfig({
      ...process.env,
      APP_ENV: 'local',
      AUTH_DEMO_IDENTITY_HEADERS: 'true',
    });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }

    client = await openDatabaseClient(databaseUrl);
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO tenants (id, code, name, enabled, created_at)
       VALUES ($1, $2, $3, true, $4), ($5, $6, $7, true, $4)`,
      [TENANT, `ia-${RUN}`, '商品导入验证租户', now, FOREIGN_TENANT, `ix-${RUN}`, '商品导入邻租户'],
    );
    await client.query(
      `INSERT INTO stores (id, tenant_id, code, name, enabled, created_at)
       VALUES ($1, $2, $3, $4, true, $5), ($6, $2, $7, $8, true, $5),
              ($9, $10, $11, $12, true, $5), ($13, $2, $14, $15, true, $5),
              ($16, $2, $17, $18, true, $5)`,
      [
        STORE,
        TENANT,
        `ia-${RUN}`,
        '商品导入验证店',
        now,
        STORE_B,
        `ia-b-${RUN}`,
        '商品导入验证店（坏例）',
        FOREIGN_STORE,
        FOREIGN_TENANT,
        `ix-${RUN}`,
        '邻租户门店',
        STORE_C,
        `ia-c-${RUN}`,
        '商品导入验证店（列映射）',
        STORE_D,
        `ia-d-${RUN}`,
        '商品导入验证店（无规格列）',
      ],
    );
    // 类目必须预先存在：方案明确「不自动建类目」，把错别字变成真类目是另一种伤害。
    // 两个门店各建一份：坏例门店里 `CAT-A` 在位、`NOPE` 不在位，正是 `category_not_found`
    // 那条要区分的两件事。
    await client.query(
      `INSERT INTO product_categories (id, tenant_id, store_id, code, name, status, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'enabled', $6, $6), ($7, $2, $8, $4, $5, 'enabled', $6, $6)`,
      [CATEGORY_ID, TENANT, STORE, CATEGORY_CODE, '上衣', now, `pcat-ia-b-${RUN}`, STORE_B],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    }).compile();
    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);
  });

  afterAll(async () => {
    const tenants = [TENANT, FOREIGN_TENANT];
    // 按依赖顺序显式删，不靠级联：哪张表哪天加了 `RESTRICT`，清理就会变成一桩悬案。
    for (const statement of [
      'DELETE FROM product_import_errors WHERE tenant_id = ANY($1)',
      'DELETE FROM product_import_batches WHERE tenant_id = ANY($1)',
      'DELETE FROM product_skus WHERE tenant_id = ANY($1)',
      'DELETE FROM product_spus WHERE tenant_id = ANY($1)',
      'DELETE FROM product_categories WHERE tenant_id = ANY($1)',
      'DELETE FROM stores WHERE tenant_id = ANY($1)',
      'DELETE FROM tenants WHERE id = ANY($1)',
    ]) {
      await client.query(statement, [tenants]);
    }

    // 本套件自己的契约：跑完不留东西。五张表一起数 —— 漏在商品表里和漏在批次表里
    // 是两种不同的漏，只数其中一张会放过另一种。
    const leftovers = await client.query<{
      spus: string;
      skus: string;
      batches: string;
      errors: string;
      categories: string;
    }>(
      `SELECT (SELECT count(*) FROM product_spus WHERE tenant_id = ANY($1)) AS spus,
              (SELECT count(*) FROM product_skus WHERE tenant_id = ANY($1)) AS skus,
              (SELECT count(*) FROM product_import_batches WHERE tenant_id = ANY($1)) AS batches,
              (SELECT count(*) FROM product_import_errors WHERE tenant_id = ANY($1)) AS errors,
              (SELECT count(*) FROM product_categories WHERE tenant_id = ANY($1)) AS categories`,
      [tenants],
    );
    expect(leftovers.rows[0], `本套件（${RUN}）跑完留下的行`).toEqual({
      spus: '0',
      skus: '0',
      batches: '0',
      errors: '0',
      categories: '0',
    });
    await client.end();

    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  it('xlsx 的两商品三规格逐行落库，类目编码被换成类目 id', async () => {
    const response = await apply(app, await xlsxOf(HAPPY_ROWS), 'products.xlsx').expect(201);
    const { batch, errors, summary } = (response.body as ApplyEnvelope).data;

    // 回执先说一遍：这是操作员在控制台上看到的那份。
    expect(errors).toEqual([]);
    expect(summary).toEqual({
      totalRows: 3,
      successRows: 3,
      createdSpuCount: 2,
      updatedSpuCount: 0,
      createdSkuCount: 3,
      updatedSkuCount: 0,
      rejectedRowCount: 0,
      unreadableRowCount: 0,
    });
    expect(batch.status).toBe('completed');
    expect(batch.totalRows).toBe(3);
    expect(batch.successRows).toBe(3);
    expect(batch.failedRows).toBe(0);
    // 批次记的是文件格式本身（`0010` 的 CHECK 收 `xlsx`），商品记的是
    // `product_spus.source_type` 允许的值 —— 两张表的取值不同，见文件头。
    expect(batch.sourceType).toBe('xlsx');
    expect(batch.createdBy).toBe(PLATFORM_ADMIN);

    // 然后从表里读回。**逐行比编码**：「落了 2 个商品」这句话，回执说 2、表里有 2 行
    // 之外，还要是**这两个**编码 —— 归并写错时（每行一个商品）计数会说话，
    // 而映射写错时只有逐行比才看得出来。
    const spus = await spusOf(client);
    expect(spus.map((spu) => spu.product_code)).toEqual(['P100', 'P200']);
    expect(spus.map((spu) => spu.title)).toEqual(['云集版彩色卡通T恤', '蓝图数码无线耳机']);
    // 副标题只写在 P100 的第一行上，归并后属于整个 P100；P200 那两格是空的。
    expect(spus.map((spu) => spu.subtitle)).toEqual(['夏季新品', null]);
    // `类目编码` 是解析的依据，不是落库的值：写 `CAT-A` 的那一组存 id，没写的那一组存 null。
    // 这一条把「解析到 id 但存成了编码」和「解析不到就存 null」区分开 —— 后者看起来
    // 也很像正常（P200 就是 null），所以必须有一个 id 在。
    expect(spus.map((spu) => spu.category_id)).toEqual([CATEGORY_ID, null]);
    expect(spus.map((spu) => spu.source_type)).toEqual(['csv', 'csv']);

    const skus = await skusOf(client);
    expect(skus.map((sku) => sku.sku_code)).toEqual(['P100-BLUE', 'P100-RED', 'P200-BLK']);
    // 两个规格挂在同一个商品下：这一条是「一个商品多规格」的落库形态，
    // 也是计划层按 `product_code` 归并的最终证据。
    const spuIdByCode = new Map(spus.map((spu) => [spu.product_code, spu.id]));
    expect(skus.map((sku) => sku.product_code)).toEqual(['P100', 'P100', 'P200']);
    expect(skus.map((sku) => sku.spu_id)).toEqual([
      spuIdByCode.get('P100'),
      spuIdByCode.get('P100'),
      spuIdByCode.get('P200'),
    ]);
    // 文件没写上下架/规格状态列，Parser 给的缺省是新商品诚实的缺省，照写。
    expect(skus.map((sku) => sku.status)).toEqual(['active', 'active', 'active']);
  });

  it('同一份文件导第二遍：按编码更新，不新增、不炸、id 不变', async () => {
    // 第一遍是上一条用例写的，这里先把它留下的 id 记下来 —— 「id 不变」这句话
    // 只有在拿第二遍之后的 id 跟**第一遍的**比时才有内容。
    const spuIdsBefore = (await spusOf(client)).map((spu) => spu.id).sort();
    const skuIdsBefore = (await skusOf(client)).map((sku) => sku.spu_id).sort();
    const countsBefore = await counts(client);

    const response = await apply(app, await xlsxOf(HAPPY_ROWS), 'products.xlsx').expect(201);
    const { batch, summary } = (response.body as ApplyEnvelope).data;
    // 第二遍按编码全部命中：一个新建都没有，全是更新，且批次仍是完成态 ——
    // 「同一份文件再传一次不炸」指的就是这三件事。
    expect(summary.createdSpuCount).toBe(0);
    expect(summary.updatedSpuCount).toBe(2);
    expect(summary.createdSkuCount).toBe(0);
    expect(summary.updatedSkuCount).toBe(3);
    expect(batch.status).toBe('completed');
    expect(batch.failedRows).toBe(0);

    // 表里的结论：行数不变（没留下重复的商品），**id 也不变**（是更新，不是
    // 「删了重建」—— 后者会让商品丢掉原来的 id，指向它的东西都会跟着断）。
    const spus = await spusOf(client);
    const skus = await skusOf(client);
    expect(spus.map((spu) => spu.product_code)).toEqual(['P100', 'P200']);
    expect(spus.map((spu) => spu.id).sort()).toEqual(spuIdsBefore);
    expect(skus.map((sku) => sku.sku_code)).toEqual(['P100-BLUE', 'P100-RED', 'P200-BLK']);
    expect(skus.map((sku) => sku.spu_id).sort()).toEqual(skuIdsBefore);
    // 只多了一个批次，商品与规格一行没多。
    const countsAfter = await counts(client);
    expect(countsAfter).toEqual({
      ...countsBefore,
      batches: String(Number(countsBefore['batches']) + 1),
    });
    expect(countsAfter['spus']).toBe('2');
    expect(countsAfter['skus']).toBe('3');
  });

  it('坏 3 行：批次 partial_failed，失败行带行号与原因，好行照常落库', async () => {
    const response = await apply(app, csvOf(BAD_ROWS), 'products.csv', { storeId: STORE_B }).expect(
      201,
    );
    const { batch, errors, summary } = (response.body as ApplyEnvelope).data;

    expect(batch.status).toBe('partial_failed');
    expect(batch.sourceType).toBe('csv');
    // 6 行里：3 行 Parser 读不了（标题空、重复编码两行），1 行计划层拒（类目不存在），
    // 剩 2 行落库。两个失败计数是**互斥**的，加起来必须等于行数差。
    expect(summary).toEqual({
      totalRows: 6,
      successRows: 2,
      createdSpuCount: 2,
      updatedSpuCount: 0,
      createdSkuCount: 2,
      updatedSkuCount: 0,
      rejectedRowCount: 1,
      unreadableRowCount: 3,
    });
    expect(batch.failedRows).toBe(4);
    expect(summary.successRows + summary.rejectedRowCount + summary.unreadableRowCount).toBe(
      summary.totalRows,
    );

    // 判定标准 3 的正文：**行号能对回 Excel**。逐行比而不是「包含了哪些码」——
    // 行号错位的失败清单，操作员拿着它回表会改错行。
    expect(errors.map((error) => ({ row: error.rowNumber, code: error.errorCode }))).toEqual([
      { row: 2, code: 'missing_required_value' },
      { row: 3, code: 'category_not_found' },
      { row: 4, code: 'duplicate_sku_code' },
      { row: 5, code: 'duplicate_sku_code' },
    ]);
    // 说明是给人读的：类目那条要点出是哪个编码。
    expect(errors[1]?.errorMessage ?? '').toContain('NOPE');
    expect(errors[1]?.rawValueMasked).toBe('NOPE');

    // 被拒的商品**一行都没有进表**。这是「拒绝」与「记一笔拒绝但照样写」的分界：
    // 逐行比编码而不是数个数 —— 数字相等时，「四个编码对了三个、混进来一个被拒的」
    // 照样是同一个数。`P400`（标题空）、`P500`（类目不存在）、`P600`（重复编码，
    // 一行都不剩）三个都不在表里，这一条才算立住。
    const spus = await spusOf(client, TENANT, STORE_B);
    expect(spus.map((spu) => spu.product_code)).toEqual(['P300', 'P700']);
    const skus = await skusOf(client, TENANT, STORE_B);
    expect(skus.map((sku) => sku.sku_code)).toEqual(['P300-1', 'P700-1']);

    // 失败行不只是回执里的一个数组，它们被写进了 `product_import_errors`。
    const stored = await client.query<{ row_number: number; error_code: string }>(
      `SELECT row_number, error_code FROM product_import_errors
        WHERE tenant_id = $1 AND batch_id = $2
        ORDER BY row_number`,
      [TENANT, batch.id],
    );
    expect(stored.rows).toEqual([
      { row_number: 2, error_code: 'missing_required_value' },
      { row_number: 3, error_code: 'category_not_found' },
      { row_number: 4, error_code: 'duplicate_sku_code' },
      { row_number: 5, error_code: 'duplicate_sku_code' },
    ]);
  });

  it('失败行是这个批次的，不是随便一个批次的：GET 批次能读回同一份清单', async () => {
    const created = await apply(app, csvOf(BAD_ROWS), 'products.csv', { storeId: STORE_B }).expect(
      201,
    );
    const receipt = (created.body as ApplyEnvelope).data;
    // 第二遍坏例：两个好商品这次走更新（按编码命中上一遍写下的那两个），
    // 失败行还是那 4 行、还是那 4 个行号。
    expect(receipt.summary.createdSpuCount).toBe(0);
    expect(receipt.summary.updatedSpuCount).toBe(2);

    const read = await request(app.getHttpServer())
      .get(batchUrl(receipt.batch.id))
      .set('x-member-id', PLATFORM_ADMIN)
      .set('x-tenant-id', TENANT)
      .expect(200);
    const stored = (read.body as BatchEnvelope).data;

    expect(stored.batch.id).toBe(receipt.batch.id);
    expect(stored.batch.status).toBe('partial_failed');
    expect(stored.batch.totalRows).toBe(6);
    expect(stored.batch.failedRows).toBe(4);
    expect(stored.errors.map((error) => error.rowNumber)).toEqual([2, 3, 4, 5]);
  });

  it('跨租户的 storeId 被拒，且一个字节都没写', async () => {
    const before = await counts(client);
    const foreignBefore = await counts(client, FOREIGN_TENANT);

    const response = await apply(app, await xlsxOf(HAPPY_ROWS), 'products.xlsx', {
      storeId: FOREIGN_STORE,
    }).expect(400);
    expect((response.body as { code: string }).code).toBe('bad_request');

    // 判定标准 4 的正文在这里：**两边都没有新行**。只断言 400 的话，一个先写库、
    // 后校验的实现照样绿 —— 而跨租户写正是这条端点最贵的一种错。
    expect(await counts(client)).toEqual(before);
    expect(await counts(client, FOREIGN_TENANT)).toEqual(foreignBefore);
    expect((await spusOf(client, FOREIGN_TENANT, FOREIGN_STORE)).length).toBe(0);
  });

  it('不存在的 storeId 被拒，且一个字节都没写', async () => {
    const before = await counts(client);
    const response = await apply(app, await xlsxOf(HAPPY_ROWS), 'products.xlsx', {
      storeId: `store-ia-missing-${RUN}`,
    }).expect(400);
    expect((response.body as { code: string }).code).toBe('bad_request');
    expect(await counts(client)).toEqual(before);
  });

  it('整批读不懂：400 且不建批次（批次里的失败行按行号索引，文件级问题没行号可挂）', async () => {
    const before = await counts(client);
    const response = await apply(app, csvOf([]), 'empty.csv').expect(400);
    const body = response.body as { code: string; details: ReadonlyArray<unknown> };
    expect(body.code).toBe('bad_request');
    // 原因要传到调用方：`details: []` 正是「上传一个空文件，拿到一句 Bad Request」。
    expect(body.details.length).toBeGreaterThan(0);
    expect(body.details.every((detail) => typeof detail === 'string')).toBe(true);
    expect(await counts(client)).toEqual(before);
  });

  it('坐席（只读角色）被拒：403，且一个字节都没写', async () => {
    // 坐席自己的租户是 `tenant-acme`，所以 `x-tenant-id` 必须跟着它走。**这不是
    // 装饰**：`resolveTenantScope` 对「头里的租户与成员自己的租户不一致」先抛 403
    // （`tenant scope mismatch`），若这里仍写 `TENANT`，这条用例会在那一步就红
    // 成 403 —— 名字说的是「角色不够」，验的却是另一个判据，等于没验。
    // 租户对齐之后，403 只可能来自 `requireConfigurator`：storeId 是别的租户的，
    // 若角色判据被删掉，下一个判据 `assertStoreInTenant` 会给的是 **400**，
    // 所以 403 与 400 之别正是这条用例的承重点。
    const before = await counts(client, 'tenant-acme');
    const response = await apply(app, await xlsxOf(HAPPY_ROWS), 'products.xlsx', {
      memberId: AGENT,
      tenantId: 'tenant-acme',
    }).expect(403);
    expect((response.body as { code: string }).code).toBe('forbidden');
    // 权限先于读文件，也先于写库：一条都没有进那个租户。
    expect(await counts(client, 'tenant-acme')).toEqual(before);
  });

  /**
   * 二期（列映射 ＋ 规格列可选）的四条，方案判定标准 1–4 在这里。
   *
   * 全部发生在 {@link STORE_C} / {@link STORE_D}，与前面三条用例的门店分开：它们都要
   * 断言「表里恰好是这几个编码」，共用门店时先跑的那条写进去的商品会被后跑的那条数进来。
   */

  it('列名不改、只用 mapping 说清两层编码：4 行落成 2 个商品 4 个规格', async () => {
    const response = await apply(app, await xlsxOf(ERP_ROWS, ERP_COLUMNS), 'erp.xlsx', {
      storeId: STORE_C,
      mapping: JSON.stringify(ERP_MAPPING),
    }).expect(201);
    const { errors, warnings, summary } = (response.body as ApplyEnvelope).data;

    expect(errors).toEqual([]);
    expect(summary.createdSpuCount).toBe(2);
    expect(summary.createdSkuCount).toBe(4);
    // 只有 `颜色` 没人认领 —— 它不是错误，是「这列我们没要」。**没有**合成提醒：
    // 这份表有 `商品编码` 当规格列（映射认领了它），不该走合成那条路。
    expect(warnings.map((warning) => warning.code)).toEqual(['unknown_column']);
    expect(warnings.map((warning) => warning.column)).toEqual(['颜色']);

    // 从表里读回，不是从回执里读回：回执说 2 个商品、表里是**这两个**商品编码，
    // 中间隔着 plan 与 repository 两层。别名表若把 `商品编码` 读成商品级键，
    // 计数会变成 4 —— 而映射被整个忽略时，回执照样说「成功」。
    const spus = await spusOf(client, TENANT, STORE_C);
    expect(spus.map((spu) => spu.product_code)).toEqual(['YSSO4056B', 'YSSO4100']);
    // `商品标题` 没写进 mapping，仍由别名表认出来：映射是覆盖 + 补充，不是白名单。
    expect(spus.map((spu) => spu.title)).toEqual(['重磅卫衣', '工装裤']);

    const skus = await skusOf(client, TENANT, STORE_C);
    expect(skus.map((sku) => sku.sku_code)).toEqual([
      'YSSO4056B-01',
      'YSSO4056B-02',
      'YSSO4100-01',
      'YSSO4100-02',
    ]);
    // 归属：四个规格挂在**两个**商品下，同一款式的两条挂同一个 spu_id。
    const spuIdByCode = new Map(spus.map((spu) => [spu.product_code, spu.id]));
    expect(skus.map((sku) => sku.product_code)).toEqual([
      'YSSO4056B',
      'YSSO4056B',
      'YSSO4100',
      'YSSO4100',
    ]);
    expect(skus.map((sku) => sku.spu_id)).toEqual([
      spuIdByCode.get('YSSO4056B'),
      spuIdByCode.get('YSSO4056B'),
      spuIdByCode.get('YSSO4100'),
      spuIdByCode.get('YSSO4100'),
    ]);
  });

  it('预览也认同一份 mapping：先看懂，再决定要不要落库', async () => {
    // 预览与导入是两个入口、两段装配代码，共用同一个解析器。只验导入的话，
    // 「预览说不行的文件导入却进去了」这类分叉不会被任何断言拦住。
    const response = await preview(app, await xlsxOf(ERP_ROWS, ERP_COLUMNS), 'erp.xlsx', {
      storeId: STORE_C,
      mapping: JSON.stringify(ERP_MAPPING),
    }).expect(200);
    const result = (response.body as { data: { readonly previewRows: ReadonlyArray<unknown> } })
      .data;

    const rows = result.previewRows as ReadonlyArray<{
      readonly spu: { readonly productCode: string };
      readonly sku: { readonly skuCode: string };
    }>;
    expect(rows.map((row) => row.spu.productCode)).toEqual([
      'YSSO4056B',
      'YSSO4056B',
      'YSSO4100',
      'YSSO4100',
    ]);
    expect(rows.map((row) => row.sku.skuCode)).toEqual([
      'YSSO4056B-01',
      'YSSO4056B-02',
      'YSSO4100-01',
      'YSSO4100-02',
    ]);
  });

  it('mapping 写错列名：400 且点名那一列，不静默丢列', async () => {
    const before = await counts(client, TENANT);
    const response = await apply(app, await xlsxOf(ERP_ROWS, ERP_COLUMNS), 'erp.xlsx', {
      storeId: STORE_C,
      mapping: JSON.stringify({ product_code: '款号', sku_code: '商品编码' }),
    }).expect(400);

    const body = response.body as { code: string; details: ReadonlyArray<unknown> };
    expect(body.code).toBe('bad_request');
    // 判定标准 3 的正文：一个错别字丢掉的是一整列，所以回话里要能读到那一列的名字，
    // 而不是「文件不合法」。
    expect(body.details.join('\n')).toContain('款号');
    expect(await counts(client, TENANT)).toEqual(before);
  });

  it('mapping 不是合法 JSON：400，原因进 details（不是一句 Bad Request）', async () => {
    const before = await counts(client, TENANT);
    const response = await apply(app, await xlsxOf(ERP_ROWS, ERP_COLUMNS), 'erp.xlsx', {
      storeId: STORE_C,
      mapping: '{"product_code":"款式编码",}',
    }).expect(400);

    const body = response.body as { code: string; details: ReadonlyArray<unknown> };
    expect(body.code).toBe('bad_request');
    // 写坏的 JSON 若被静默丢掉，我们就会**按猜错的那套**读完整份文件再回 200：
    // 5,509 个商品变 23,328 个，一条错误都不报（二期方案 §1.1）。
    expect(body.details.length).toBeGreaterThan(0);
    expect(body.details.join('\n')).toContain('mapping');
    expect(await counts(client, TENANT)).toEqual(before);
  });

  it('没有规格列的表：201，每个商品一条合成规格，且回执里写明这件事', async () => {
    const response = await apply(app, await xlsxOf(NO_SKU_ROWS, NO_SKU_COLUMNS), 'nosku.xlsx', {
      storeId: STORE_D,
    }).expect(201);
    const { errors, warnings, summary } = (response.body as ApplyEnvelope).data;

    expect(errors).toEqual([]);
    expect(summary.createdSpuCount).toBe(2);
    expect(summary.createdSkuCount).toBe(2);
    // 判定标准 2：库里会出现两条**商家没写过**的规格，这件事必须在回执里说出来。
    // `errors` 装不下它（那张表按数据行号索引，`row_number` 的 CHECK 是 >= 1），
    // 所以它走 `warnings` —— 只有计数而不说是什么，等于让操作员自己去猜。
    expect(warnings.map((warning) => warning.code)).toEqual(['sku_code_synthesized']);
    expect(warnings[0]?.severity).toBe('warning');
    expect(warnings[0]?.rowNumber).toBeNull();

    const skus = await skusOf(client, TENANT, STORE_D);
    expect(skus.map((sku) => sku.sku_code)).toEqual(['S100', 'S200']);
    expect(skus.map((sku) => sku.product_code)).toEqual(['S100', 'S200']);
  });

  it('同一份数据分两批传：结果与一次传完逐行相同（判定标准 4，幂等）', async () => {
    // 上一条用例一次传完的结果 —— 「分批不改变结果」这句话需要一个对照物。
    const spusBefore = await spusOf(client, TENANT, STORE_C);
    const skusBefore = await skusOf(client, TENANT, STORE_C);
    const before = await counts(client, TENANT);

    const halves = [
      await apply(app, await xlsxOf(ERP_ROWS.slice(0, 2), ERP_COLUMNS), 'erp-1.xlsx', {
        storeId: STORE_C,
        mapping: JSON.stringify(ERP_MAPPING),
      }).expect(201),
      await apply(app, await xlsxOf(ERP_ROWS.slice(2), ERP_COLUMNS), 'erp-2.xlsx', {
        storeId: STORE_C,
        mapping: JSON.stringify(ERP_MAPPING),
      }).expect(201),
    ];

    // 两批全部命中已有编码：一个新建都没有。upsert 的键是编码，分批因此天然幂等 ——
    // 5000 行闸不动（方案 §2.3），商户的大表就靠这条切片上传。
    for (const response of halves) {
      const { summary } = (response.body as ApplyEnvelope).data;
      expect(summary.createdSpuCount).toBe(0);
      expect(summary.createdSkuCount).toBe(0);
    }

    // 逐行相同**且 id 不变**：不是「删了重建」那种看起来一样的幂等。
    expect(await spusOf(client, TENANT, STORE_C)).toEqual(spusBefore);
    expect(await skusOf(client, TENANT, STORE_C)).toEqual(skusBefore);
    const after = await counts(client, TENANT);
    expect(Number(after.spus)).toBe(Number(before.spus));
    expect(Number(after.skus)).toBe(Number(before.skus));
    // 批次本身是两次上传的证据，只有它会增加 —— 数它也是在证明前面两个数没动。
    expect(Number(after.batches)).toBe(Number(before.batches) + 2);
  });
});
