/**
 * What the import plan decides, and the four ways it can be wrong while looking
 * right.
 *
 * The planner is a few `Map`s and some spreads, so the suite is written against
 * the mistakes that produce a **plausible plan**: every one of them yields
 * writes that execute cleanly and leave the catalogue subtly different from the
 * file.
 *
 *   * **Copied instead of upserted.** A second import of the same file must
 *     update, not create a twin. The same key is asserted from both sides: an
 *     existing code goes to `update`, an unknown code goes to `create`.
 *   * **The file's silence read as an instruction.** The parser cannot tell
 *     "this column was absent" from "this cell was empty", so a patch that
 *     carries those fields back would blank a merchant's subtitles and revive
 *     withdrawn variants. Two tests hold that line, and a third shows the
 *     asymmetry it does *not* apply to `create`.
 *   * **A half-imported product.** A group rejected at the variant level must
 *     not leave a product behind with no variants under it — it would render in
 *     the console as a broken product.
 *   * **A silent overwrite of someone else's row.** `sku_code` is unique per
 *     store, so a code that already belongs to another product is a refusal,
 *     never a move.
 */

import { describe, expect, it } from 'vitest';

import type { ProductCategory, ProductSku, ProductSpu, SkuStatus, SpuShelfStatus } from './catalog';
import {
  planProductImport,
  type ProductImportPlan,
  type ProductImportSkuWrite,
  type ProductImportSpuWrite,
} from './product-import-plan';
import type { ProductImportPreviewRow } from './product-import-parser';

const TENANT = 'tenant-1';
const STORE = 'store-1';

/** 一行解析结果，只写这条用例关心的字段。 */
function row(input: {
  readonly rowNumber: number;
  readonly productCode: string;
  readonly skuCode: string;
  readonly title?: string;
  readonly categoryCode?: string | null;
  readonly subtitle?: string | null;
  readonly sellingPoints?: ReadonlyArray<string>;
  readonly shelfStatus?: SpuShelfStatus;
  readonly skuStatus?: SkuStatus;
  readonly variant?: Readonly<Record<string, string>>;
}): ProductImportPreviewRow {
  return {
    rowNumber: input.rowNumber,
    spu: {
      productCode: input.productCode,
      title: input.title ?? `商品 ${input.productCode}`,
      categoryCode: input.categoryCode ?? null,
      externalProductId: null,
      subtitle: input.subtitle ?? null,
      productUrl: null,
      mainImageUrl: null,
      sellingPoints: input.sellingPoints ?? [],
      commonAttributes: {},
      shelfStatus: input.shelfStatus ?? 'unknown',
      sourceUpdatedAt: null,
    },
    sku: {
      skuCode: input.skuCode,
      variant: input.variant ?? {},
      searchAttributes: {},
      status: input.skuStatus ?? 'active',
    },
  };
}

/** 库里已有的商品。 */
function existingSpu(input: {
  readonly id: string;
  readonly productCode: string;
  readonly title?: string;
  readonly subtitle?: string | null;
  readonly shelfStatus?: SpuShelfStatus;
}): ProductSpu {
  return {
    id: input.id,
    tenantId: TENANT,
    storeId: STORE,
    categoryId: null,
    externalProductId: null,
    productCode: input.productCode,
    title: input.title ?? `库里 ${input.productCode}`,
    subtitle: input.subtitle ?? null,
    mainImageUrl: null,
    productUrl: null,
    sellingPoints: [],
    commonAttributes: {},
    shelfStatus: input.shelfStatus ?? 'off_shelf',
    sourceType: 'manual',
    sourceUpdatedAt: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

/** 库里已有的规格。 */
function existingSku(input: {
  readonly id: string;
  readonly spuId: string;
  readonly skuCode: string;
  readonly status?: SkuStatus;
  readonly variant?: Readonly<Record<string, string>>;
}): ProductSku {
  return {
    id: input.id,
    tenantId: TENANT,
    storeId: STORE,
    spuId: input.spuId,
    externalSkuId: null,
    skuCode: input.skuCode,
    variant: input.variant ?? {},
    searchAttributes: {},
    status: input.status ?? 'active',
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

/** 本门店的类目。 */
function category(code: string, id: string): ProductCategory {
  return {
    id,
    tenantId: TENANT,
    storeId: STORE,
    parentId: null,
    code,
    name: `类目 ${code}`,
    status: 'enabled',
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

/**
 * 更新补丁上的键集合。
 *
 * 用抛错而不是 `expect` 来收窄联合类型：`expect` 是普通函数调用，TS 不会因此把
 * `create | update` 缩到 `update`，而 `expect.unreachable` 在本仓库的 vitest 版本里
 * 也没有 `never` 返回类型 —— 写成断言会让 `patch` 编译不过。
 *
 * @param write - 一条写指令，可能是新建。
 * @returns 补丁上的键，排序后。
 */
function patchKeysOf(
  write: ProductImportSpuWrite | ProductImportSkuWrite | undefined,
): ReadonlyArray<string> {
  if (write === undefined || write.action !== 'update') {
    throw new Error('期望这是一条更新写指令');
  }
  return Object.keys(write.patch).sort();
}

/** 走一遍计划器，省掉每条用例里的重复摆盘。 */
function plan(input: {
  readonly rows: ReadonlyArray<ProductImportPreviewRow>;
  readonly categories?: ReadonlyArray<ProductCategory>;
  readonly spus?: ReadonlyArray<ProductSpu>;
  readonly skus?: ReadonlyArray<ProductSku>;
}): ProductImportPlan {
  return planProductImport({
    rows: input.rows,
    categories: input.categories ?? [],
    existingSpus: input.spus ?? [],
    existingSkus: input.skus ?? [],
  });
}

describe('planProductImport', () => {
  it('每个商品编码一条商品写指令，每个规格一条规格写指令', () => {
    const result = plan({
      rows: [
        row({ rowNumber: 1, productCode: 'P-1', skuCode: 'S-1' }),
        row({ rowNumber: 2, productCode: 'P-2', skuCode: 'S-2' }),
      ],
    });

    expect(result.spuWrites.map((write) => write.productCode)).toEqual(['P-1', 'P-2']);
    expect(result.spuWrites.every((write) => write.action === 'create')).toBe(true);
    expect(result.skuWrites.map((write) => write.skuCode)).toEqual(['S-1', 'S-2']);
    expect(result.spuCount).toBe(2);
    expect(result.skuCount).toBe(2);
    expect(result.rejections).toEqual([]);
  });

  it('同一个商品编码的多行归并成一个商品，商品级字段取首个给了值的行', () => {
    const result = plan({
      rows: [
        row({
          rowNumber: 1,
          productCode: 'P-1',
          skuCode: 'S-1',
          title: '第一行标题',
          shelfStatus: 'on_shelf',
        }),
        row({ rowNumber: 2, productCode: 'P-1', skuCode: 'S-2', title: '第二行标题' }),
      ],
    });

    expect(result.spuWrites).toHaveLength(1);
    // 一个商品两个规格，不是两个商品各一个规格。
    expect(result.skuWrites).toHaveLength(2);
    expect(result.spuWrites[0]).toMatchObject({
      action: 'create',
      rowNumbers: [1, 2],
      values: { title: '第一行标题', shelfStatus: 'on_shelf' },
    });
  });

  it('已有的商品编码走 update 而不是新建', () => {
    const result = plan({
      rows: [row({ rowNumber: 1, productCode: 'P-1', skuCode: 'S-1', title: '商家改过的标题' })],
      spus: [existingSpu({ id: 'spu-1', productCode: 'P-1' })],
      skus: [existingSku({ id: 'sku-1', spuId: 'spu-1', skuCode: 'S-1' })],
    });

    expect(result.spuWrites).toEqual([
      {
        action: 'update',
        productCode: 'P-1',
        spuId: 'spu-1',
        rowNumbers: [1],
        patch: { title: '商家改过的标题' },
      },
    ]);
    // 规格也是更新：同一个 SKU 编码再导一次不该长出第二条。
    expect(result.skuWrites).toMatchObject([{ action: 'update', skuId: 'sku-1', skuCode: 'S-1' }]);
  });

  it('更新补丁只装文件给了值的字段：文件没提到的，一个都不回写', () => {
    const result = plan({
      // 三列文件：商品编码 / 标题 / SKU 编码。其余列一律没有。
      rows: [row({ rowNumber: 1, productCode: 'P-1', skuCode: 'S-1', title: '只改了标题' })],
      spus: [
        existingSpu({
          id: 'spu-1',
          productCode: 'P-1',
          subtitle: '库里原有的副标题',
          shelfStatus: 'off_shelf',
        }),
      ],
      skus: [existingSku({ id: 'sku-1', spuId: 'spu-1', skuCode: 'S-1', status: 'inactive' })],
    });

    // 「没提到」必须表现为「键不在」，不是「键在、值是 null」——后者会清空副标题。
    expect(patchKeysOf(result.spuWrites[0])).toEqual(['title']);
    // 停售的规格不能被一份没写状态的表悄悄重新上架。
    expect(patchKeysOf(result.skuWrites[0])).toEqual([]);
  });

  it('上下架列缺失（unknown）更新时不写，新建时照写', () => {
    const updated = plan({
      rows: [row({ rowNumber: 1, productCode: 'P-1', skuCode: 'S-1' })],
      spus: [existingSpu({ id: 'spu-1', productCode: 'P-1', shelfStatus: 'off_shelf' })],
    });
    expect(updated.spuWrites[0]).toMatchObject({ action: 'update', patch: {} });

    const created = plan({ rows: [row({ rowNumber: 1, productCode: 'P-1', skuCode: 'S-1' })] });
    // 新建没有「原有的值」可保，Parser 的缺省是诚实的，照写。
    expect(created.spuWrites[0]).toMatchObject({
      action: 'create',
      values: { shelfStatus: 'unknown', sourceType: 'csv' },
    });
  });

  it('类目编码在本门店找不到：该商品整组被拒，其余商品照常进', () => {
    const result = plan({
      rows: [
        row({ rowNumber: 1, productCode: 'P-1', skuCode: 'S-1', categoryCode: 'CAT-未知' }),
        row({ rowNumber: 2, productCode: 'P-1', skuCode: 'S-2', categoryCode: 'CAT-未知' }),
        row({ rowNumber: 3, productCode: 'P-2', skuCode: 'S-3', categoryCode: 'CAT-1' }),
      ],
      categories: [category('CAT-1', 'cat-1')],
    });

    // 整组被拒：不能只拒一行，否则同一份商品一半进一半不进。
    expect(result.spuWrites.map((write) => write.productCode)).toEqual(['P-2']);
    expect(result.rejections).toEqual([
      {
        rowNumber: 1,
        fieldName: 'category_code',
        errorCode: 'category_not_found',
        errorMessage: expect.stringContaining('CAT-未知'),
        rawValueMasked: 'CAT-未知',
      },
      {
        rowNumber: 2,
        fieldName: 'category_code',
        errorCode: 'category_not_found',
        errorMessage: expect.stringContaining('CAT-未知'),
        rawValueMasked: 'CAT-未知',
      },
    ]);
    expect(result.rejectedRowCount).toBe(2);
    // 命中的类目要真的换成 id，不是把编码原样写进去。
    expect(result.spuWrites[0]).toMatchObject({ values: { categoryId: 'cat-1' } });
  });

  it('文件里重复的 SKU 编码：只有第一行进', () => {
    const result = plan({
      rows: [
        row({ rowNumber: 1, productCode: 'P-1', skuCode: 'S-1' }),
        row({ rowNumber: 2, productCode: 'P-2', skuCode: 'S-1' }),
      ],
    });

    expect(result.skuWrites.map((write) => write.skuCode)).toEqual(['S-1']);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        rowNumber: 2,
        errorCode: 'duplicate_sku_code',
        fieldName: 'sku_code',
      }),
    ]);
    // 第二个商品一行都没活下来，所以它也不落 —— 不留一个没有规格的商品。
    expect(result.spuWrites.map((write) => write.productCode)).toEqual(['P-1']);
  });

  it('SKU 编码已属于另一个商品：拒绝，不把别人的规格挪走', () => {
    const result = plan({
      rows: [row({ rowNumber: 1, productCode: 'P-2', skuCode: 'S-1' })],
      spus: [
        existingSpu({ id: 'spu-1', productCode: 'P-1' }),
        existingSpu({ id: 'spu-2', productCode: 'P-2' }),
      ],
      skus: [existingSku({ id: 'sku-1', spuId: 'spu-1', skuCode: 'S-1' })],
    });

    expect(result.skuWrites).toEqual([]);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        rowNumber: 1,
        errorCode: 'sku_code_conflict',
        errorMessage: expect.stringContaining('P-1'),
      }),
    ]);
    // 该组唯一一行被拒 ⇒ 商品 P-2 也不落。
    expect(result.spuWrites).toEqual([]);
  });
});

/**
 * 孪生拦截：同一件货被 ERP 开了两个编码时，入口只放行一个。
 *
 * 这一组用例的判据在 `sku-duplicate.ts`，这里钉的是**计划怎么用它** —— 三条边界比
 * 「能不能拦下来」更容易做错：
 *
 *   * **只拦新建。** 编码已经在库里时写的是更新，把它也拦下会让同一份文件重导一次
 *     报一堆错，而那些行的孪生本来就在库里。
 *   * **对称。** 不假定带后缀的是文件那一行：库里是 `XBCP`、文件带来 `X` 时同样拦，
 *     否则库里凭空多一行。
 *   * **只跨不过商品边界。** 两个商品的同规格行是两件不同的货，规格相同不构成孪生。
 */
describe('planProductImport 的孪生拦截', () => {
  const VARIANT = { 颜色: '黑', 规格: 'M' };

  it('文件里前后两行互为孪生时，只留先出现的那一行', () => {
    const result = plan({
      rows: [
        row({ rowNumber: 1, productCode: 'P-1', skuCode: 'KD3008-02', variant: VARIANT }),
        row({ rowNumber: 2, productCode: 'P-1', skuCode: 'KD3008-02BCP', variant: VARIANT }),
      ],
    });

    expect(result.skuWrites.map((write) => write.skuCode)).toEqual(['KD3008-02']);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        rowNumber: 2,
        fieldName: 'sku_code',
        errorCode: 'duplicate_variant',
        errorMessage: expect.stringContaining('KD3008-02'),
      }),
    ]);
    expect(result.rejectedRowCount).toBe(1);
  });

  it('库里已有的那一行留下，文件带来的孪生被拒', () => {
    const result = plan({
      rows: [row({ rowNumber: 1, productCode: 'P-1', skuCode: 'KD3008-02BCP', variant: VARIANT })],
      spus: [existingSpu({ id: 'spu-1', productCode: 'P-1' })],
      skus: [
        existingSku({ id: 'sku-1', spuId: 'spu-1', skuCode: 'KD3008-02', variant: VARIANT }),
      ],
    });

    // 这一行是新建（`KD3008-02BCP` 库里没有），而它的孪生已经在库里 —— 拦下来，
    // 否则清理脚本清掉的那 99 对会被下一份表原样灌回来。
    expect(result.skuWrites).toEqual([]);
    expect(result.rejections).toEqual([
      expect.objectContaining({ rowNumber: 1, errorCode: 'duplicate_variant' }),
    ]);
  });

  it('反向也算孪生：库里是带后缀的那个，文件带来的不带后缀同样被拒', () => {
    const result = plan({
      rows: [row({ rowNumber: 1, productCode: 'P-1', skuCode: 'KD3008-02', variant: VARIANT })],
      spus: [existingSpu({ id: 'spu-1', productCode: 'P-1' })],
      skus: [
        existingSku({ id: 'sku-1', spuId: 'spu-1', skuCode: 'KD3008-02BCP', variant: VARIANT }),
      ],
    });

    expect(result.skuWrites).toEqual([]);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        rowNumber: 1,
        errorCode: 'duplicate_variant',
        errorMessage: expect.stringContaining('KD3008-02BCP'),
      }),
    ]);
  });

  it('同一份文件重导一遍：已有的编码照常更新，孪生行仍是拒绝', () => {
    const result = plan({
      rows: [
        row({ rowNumber: 1, productCode: 'P-1', skuCode: 'KD3008-02', variant: VARIANT }),
        row({ rowNumber: 2, productCode: 'P-1', skuCode: 'KD3008-02BCP', variant: VARIANT }),
      ],
      spus: [existingSpu({ id: 'spu-1', productCode: 'P-1' })],
      skus: [
        existingSku({ id: 'sku-1', spuId: 'spu-1', skuCode: 'KD3008-02', variant: VARIANT }),
      ],
    });

    // 第一行是更新 —— 拦下它会让每次重导都报错，而它并没有多写一行。
    expect(result.skuWrites).toEqual([
      expect.objectContaining({ action: 'update', skuCode: 'KD3008-02', skuId: 'sku-1' }),
    ]);
    expect(result.rejections).toEqual([
      expect.objectContaining({ rowNumber: 2, errorCode: 'duplicate_variant' }),
    ]);
  });

  it('规格一样但编码不相干的行照落：那是同色不同货，不是重复', () => {
    // 真实目录里剩下 134 组同规格的行，多数长这样：尺码就在编码里。
    // 判据放宽到「规格相同即重复」时，这条用例会红 —— 那是把商家的真商品删掉。
    const result = plan({
      rows: [
        row({ rowNumber: 1, productCode: 'P-1', skuCode: 'S26-BL-KLCDDX06', variant: VARIANT }),
        row({ rowNumber: 2, productCode: 'P-1', skuCode: 'S26-BL-KLCDDX153', variant: VARIANT }),
        row({ rowNumber: 3, productCode: 'P-1', skuCode: 'LC6132', variant: VARIANT }),
        row({ rowNumber: 4, productCode: 'P-1', skuCode: 'LC613-H', variant: VARIANT }),
      ],
    });

    expect(result.rejections).toEqual([]);
    expect(result.skuWrites).toHaveLength(4);
  });

  it('编码只差 BCP 但规格不同：不是同一件货，两行都落', () => {
    const result = plan({
      rows: [
        row({ rowNumber: 1, productCode: 'P-1', skuCode: 'KD3008-02', variant: { 颜色: '黑' } }),
        row({ rowNumber: 2, productCode: 'P-1', skuCode: 'KD3008-02BCP', variant: { 颜色: '白' } }),
      ],
    });

    expect(result.rejections).toEqual([]);
    expect(result.skuWrites).toHaveLength(2);
  });

  it('两个商品之间的同规格行不互相拦', () => {
    const result = plan({
      rows: [
        row({ rowNumber: 1, productCode: 'P-1', skuCode: 'KD3008-02', variant: VARIANT }),
        row({ rowNumber: 2, productCode: 'P-2', skuCode: 'KD3008-02BCP', variant: VARIANT }),
      ],
    });

    expect(result.rejections).toEqual([]);
    expect(result.skuWrites.map((write) => write.skuCode)).toEqual([
      'KD3008-02',
      'KD3008-02BCP',
    ]);
  });
});
