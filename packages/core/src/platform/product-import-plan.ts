/**
 * 把一次商品导入的解析结果，变成一份「要写什么」的计划。
 *
 * Parser 只回答「文件里写了什么」（`product-import-parser.ts`），本模块回答
 * 「相对于库里已有的东西，该写什么」——两者之间是纯函数边界：这里不碰数据库、
 * 不碰 HTTP、不看时间。给了同样的 rows / categories / existing 三份输入，就必然
 * 得到同样的计划，所以 upsert 的每一条规则都能被单测钉住，而落库那一侧只需要
 * 照着计划执行。
 *
 * ## 为什么 upsert 的键是「编码」而不是 id
 *
 * 商家手里那份表是从他们自己的系统导出来的，「商品编码」「SKU 编码」是他们认识
 * 的主键。库里正好有 `UNIQUE (tenant_id, store_id, product_code)` 与
 * `UNIQUE (tenant_id, store_id, sku_code)` 两条约束（迁移 0009），所以「同一个编码
 * 再导一次」天然是更新而不是新增 —— 这也是「同一份文件导两遍不炸」的实现方式。
 *
 * ## 更新为什么是「只写文件给了值的字段」
 *
 * Parser 分不清「这一列没有」和「这一格是空的」：两者都落到 `null`，而
 * `shelfStatus` / `skuStatus` 更进一步，列缺失时给的是 `'unknown'` / `'active'`
 * 这两个**看起来像真值的默认值**。
 *
 * 于是两条路都是坑：
 *
 * - 全字段覆盖：一份只有「商品编码/标题/SKU 编码」三列的表，会把已有商品的副标题、
 *   链接、卖点、属性**悄悄清空**，还把下架商品改回 `active`（等于把停售的规格重新上架）。
 * - 只写非空：仍会写进 `unknown` 与 `active` 两个默认值，上一条的后半截照样中招。
 *
 * 本模块选第三条：**只写文件确实提供了值的字段**，`null`、空数组、空对象、
 * `'unknown'`（上下架列缺失时的默认）与 `'active'`（规格状态列缺失时的默认）都
 * 视为「文件没说」，一律不动。代价是「用导入清空一个字段」和「把规格从
 * inactive 改回 active」在本版做不到 —— 这写在方案的已知取舍里，不藏着。
 *
 * 新建走的是另一条规则：新商品没有「原有的值」可保，`unknown` 与 `active` 是
 * Parser 给出的、诚实的缺省，照写。
 *
 * ## 为什么新建之前要找一次孪生
 *
 * 同一件货被 ERP 开了两个编码（`KD3008-02` / `KD3008-02BCP`）在真实目录里有 99 对，
 * 而两条一模一样的行会派生出两条一模一样的切片 —— 检索的前五里同一个答案占两个位子。
 * 清理脚本（`database/scripts/dedupe-product-skus.cjs`）清的是库里的存量，**入口这一侧
 * 必须自己判一遍**，否则清过的库会被下一份表重新灌回来。判据本身只有一份，在
 * `sku-duplicate.ts`。
 *
 * 只有新建会走这一步：编码已经存在时写的是更新，不会多出一行来，而把「更新既有行」
 * 也拦下来会让**同一份文件重导一次就报一堆错** —— 那些行的孪生本来就在库里。
 *
 * 孪生关系是对称的（不假定谁带后缀）：库里是 `XBCP`、文件带来 `X` 时同样拒绝 `X`，
 * 否则库里会凭空多出一行。所以这里的口径是**先到先得** —— 已经在库里的行、或本文件里
 * 先出现的行，就是留下的那一行。
 */

import type {
  CatalogAttributes,
  ProductCategory,
  ProductSku,
  ProductSkuPatch,
  ProductSpu,
  ProductSpuPatch,
  SkuStatus,
  SpuShelfStatus,
  SpuSourceType,
  VariantAttributes,
} from './catalog';
import type { ProductImportField, ProductImportPreviewRow } from './product-import-parser';
import { isDuplicateSku, type SkuIdentity } from './sku-duplicate';

/**
 * 计划层自己的拒绝码。
 *
 * 与 Parser 的 `PRODUCT_IMPORT_ISSUE_CODES` 分开：那一组说的是「文件读不懂」，
 * 这一组说的是「文件读得懂，但库这边不能照办」—— 两者的处置方式不同，混在一起
 * 会让操作员以为是文件格式问题。
 */
export const PRODUCT_IMPORT_PLAN_ISSUE_CODES = [
  /** `类目编码` 在本门店的类目里找不到。不自动建类目：那会把错别字变成真类目。 */
  'category_not_found',
  /** 同一个 `SKU 编码` 在文件里出现第二次，第二次这一行不落。 */
  'duplicate_sku_code',
  /** 这个 `SKU 编码` 在库里已经属于**另一个**商品，挪过来等于把别人的规格偷走。 */
  'sku_code_conflict',
  /**
   * 同一商品下已经有一条规格逐字相同、编码只差 `BCP` 后缀的行 —— 同一件货的第二个
   * 编码。判据在 `sku-duplicate.ts`，两个地方共用同一份规则。只有**新建**会被拒：
   * 编码已经存在时写的是更新，不会多出一行来。
   */
  'duplicate_variant',
] as const;

/** 一条计划层拒绝码。 */
export type ProductImportPlanIssueCode = (typeof PRODUCT_IMPORT_PLAN_ISSUE_CODES)[number];

/** 文件导入一律记 `csv`：`product_spus.source_type` 的 CHECK 里没有 `xlsx`。 */
const IMPORT_SPU_SOURCE_TYPE: SpuSourceType = 'csv';

/** 列缺失时 Parser 给的上下架默认值，视为「文件没说」。 */
const UNSTATED_SHELF_STATUS: SpuShelfStatus = 'unknown';

/** 列缺失时 Parser 给的规格状态默认值，视为「文件没说」。 */
const UNSTATED_SKU_STATUS = 'active';

/** 一行被计划拒绝的记录，字段与 `NewProductImportError` 一一对应。 */
export type ProductImportRowRejection = {
  /** 数据行序号，从 1 开始；与 Parser 的 `rowNumber` 同一套编号。 */
  readonly rowNumber: number;
  readonly fieldName: ProductImportField | null;
  readonly errorCode: ProductImportPlanIssueCode;
  /** 面向操作员的中文说明。 */
  readonly errorMessage: string;
  /** 触发拒绝的原始值。 */
  readonly rawValueMasked: string | null;
};

/** 一个商品的字段集。tenant / store / id 由落库那一侧补齐，计划里不带。 */
export type ProductImportSpuValues = {
  readonly productCode: string;
  readonly title: string;
  readonly categoryId: string | null;
  readonly externalProductId: string | null;
  readonly subtitle: string | null;
  readonly productUrl: string | null;
  readonly mainImageUrl: string | null;
  readonly sellingPoints: ReadonlyArray<string>;
  readonly commonAttributes: CatalogAttributes;
  readonly shelfStatus: SpuShelfStatus;
  readonly sourceType: SpuSourceType;
  readonly sourceUpdatedAt: string | null;
};

/** 一个规格的字段集。 */
export type ProductImportSkuValues = {
  readonly skuCode: string;
  readonly variant: VariantAttributes;
  readonly searchAttributes: VariantAttributes;
  readonly status: SkuStatus;
};

/** 商品的写指令：新建给完整字段，更新给一份只含「文件说了」的补丁。 */
export type ProductImportSpuWrite =
  | {
      readonly action: 'create';
      readonly productCode: string;
      /** 归并进这一条商品的数据行，按文件顺序。 */
      readonly rowNumbers: ReadonlyArray<number>;
      readonly values: ProductImportSpuValues;
    }
  | {
      readonly action: 'update';
      readonly productCode: string;
      readonly spuId: string;
      readonly rowNumbers: ReadonlyArray<number>;
      readonly patch: ProductSpuPatch;
    };

/** 规格的写指令。新建时给商品编码而不是 spuId：新建商品的 id 要等落库才知道。 */
export type ProductImportSkuWrite =
  | {
      readonly action: 'create';
      readonly skuCode: string;
      /** 所属商品编码；落库那一侧把它换成刚拿到（或已有）的 spuId。 */
      readonly productCode: string;
      readonly rowNumber: number;
      readonly values: ProductImportSkuValues;
    }
  | {
      readonly action: 'update';
      readonly skuCode: string;
      readonly skuId: string;
      readonly rowNumber: number;
      readonly patch: ProductSkuPatch;
    };

/** 计划：按顺序执行 `spuWrites` 再执行 `skuWrites`，即可得到文件描述的状态。 */
export type ProductImportPlan = {
  readonly spuWrites: ReadonlyArray<ProductImportSpuWrite>;
  readonly skuWrites: ReadonlyArray<ProductImportSkuWrite>;
  readonly rejections: ReadonlyArray<ProductImportRowRejection>;
  /** 进得了库的商品数（新建 + 更新）。 */
  readonly spuCount: number;
  /** 进得了库的规格数（新建 + 更新）。 */
  readonly skuCount: number;
  /** 被拒的数据行数。 */
  readonly rejectedRowCount: number;
};

/** 计划输入：文件里读到的行，加上库里已有的三份事实。 */
export type ProductImportPlanInput = {
  readonly rows: ReadonlyArray<ProductImportPreviewRow>;
  /** 本门店的类目，用于把 `类目编码` 换成 `categoryId`。 */
  readonly categories: ReadonlyArray<ProductCategory>;
  /** 本门店已有的商品。 */
  readonly existingSpus: ReadonlyArray<ProductSpu>;
  /** 本门店已有的规格。 */
  readonly existingSkus: ReadonlyArray<ProductSku>;
};

/**
 * 把解析结果编成一份落库计划。
 *
 * 同一条 `product_code` 的多行归并成一个商品（一个商品多个规格是正常情况，Parser
 * 有意不预先折叠）。商品级字段取该组**首个给出了值的那一行**：文件自己前后矛盾时
 * 以先出现者为准，不静默合并 —— 合并会让「文件说什么」变得不可预测。
 *
 * **一组要么整体落，要么整体不落**：类目找不到时该组全部行被拒；若一组的所有行都
 * 在规格这一层被拒（编码重复、编码属于别的商品），该商品也不落 —— 库里不该出现一个
 * 没有任何规格的商品，那在控制台上看起来就是个坏掉的商品。
 *
 * @param input - 文件里的行与库里已有的类目/商品/规格。
 * @returns 写指令与逐行拒绝清单。
 */
export function planProductImport(input: ProductImportPlanInput): ProductImportPlan {
  const categoryIdByCode = new Map(
    input.categories.map((category) => [category.code, category.id]),
  );
  const spuByCode = new Map(input.existingSpus.map((spu) => [spu.productCode, spu]));
  const skuByCode = new Map(input.existingSkus.map((sku) => [sku.skuCode, sku]));
  // 规格 → 所属商品编码：判断一个已有的 SKU 编码是不是属于**这个**商品要用它。
  const spuCodeById = new Map(input.existingSpus.map((spu) => [spu.id, spu.productCode]));
  // 一个商品下已经存在的规格，用来在新建之前找孪生（见模块说明）。孪生只可能出现在
  // 同一个商品内部 —— 两个商品的同规格行是两件不同的货 —— 所以按商品编码分堆，
  // 每堆都是一个商品自己的几条规格。本文件认下的行也往这里加，于是一份文件里前后两行
  // 互为孪生时，第二行同样拦得住。
  const siblings = new Map<string, SkuIdentity[]>();
  for (const sku of input.existingSkus) {
    const productCode = spuCodeById.get(sku.spuId);
    // 本门店的规格必然属于本门店的商品；对不上号的行（不该存在）按「没有兄弟」处理，
    // 而不是按编码猜一个商品给它。
    if (productCode !== undefined) {
      addSibling(siblings, productCode, { skuCode: sku.skuCode, variant: sku.variant });
    }
  }

  const groups = groupByProductCode(input.rows);
  const spuWrites: ProductImportSpuWrite[] = [];
  const skuWrites: ProductImportSkuWrite[] = [];
  const rejections: ProductImportRowRejection[] = [];
  const claimedSkuCodes = new Set<string>();

  for (const group of groups) {
    const categoryCode = firstNonNull(group.rows.map((entry) => entry.row.spu.categoryCode));
    const categoryId = categoryCode === null ? null : (categoryIdByCode.get(categoryCode) ?? null);
    if (categoryCode !== null && categoryId === null) {
      // 整组拒绝：类目编码是这一组每一行都写着的字段，只拒一行会让同一份商品
      // 一半进一半不进，操作员拿到的是半成品。
      for (const entry of group.rows) {
        rejections.push({
          rowNumber: entry.rowNumber,
          fieldName: 'category_code',
          errorCode: 'category_not_found',
          errorMessage: `类目编码 ${categoryCode} 在本门店的类目里不存在，请先建类目或改正编码`,
          rawValueMasked: categoryCode,
        });
      }
      continue;
    }

    const existing = spuByCode.get(group.productCode);
    const values = spuValuesOf(group.rows, group.productCode, categoryId);

    // 规格先全部裁决完，再决定商品落不落 —— 一组要么整体落，要么整体不落。
    const groupSkuWrites: ProductImportSkuWrite[] = [];
    for (const entry of group.rows) {
      const skuCode = entry.row.sku.skuCode;
      if (claimedSkuCodes.has(skuCode)) {
        rejections.push({
          rowNumber: entry.rowNumber,
          fieldName: 'sku_code',
          errorCode: 'duplicate_sku_code',
          errorMessage: `SKU 编码 ${skuCode} 在本文件中出现了多次，只有第一行会被导入`,
          rawValueMasked: skuCode,
        });
        continue;
      }
      claimedSkuCodes.add(skuCode);

      const existingSku = skuByCode.get(skuCode);
      if (existingSku !== undefined) {
        const owner = spuCodeById.get(existingSku.spuId) ?? null;
        if (owner !== group.productCode) {
          rejections.push({
            rowNumber: entry.rowNumber,
            fieldName: 'sku_code',
            errorCode: 'sku_code_conflict',
            errorMessage:
              owner === null
                ? `SKU 编码 ${skuCode} 已属于另一个商品`
                : `SKU 编码 ${skuCode} 已属于商品 ${owner}，改编码或先把原商品处理掉`,
            rawValueMasked: skuCode,
          });
          continue;
        }
        groupSkuWrites.push({
          action: 'update',
          skuCode,
          skuId: existingSku.id,
          rowNumber: entry.rowNumber,
          patch: skuPatchOf(entry.row),
        });
        continue;
      }

      const identity: SkuIdentity = { skuCode, variant: entry.row.sku.variant };
      const twin = findSkuTwin(siblings, group.productCode, identity);
      if (twin !== null) {
        rejections.push({
          rowNumber: entry.rowNumber,
          fieldName: 'sku_code',
          errorCode: 'duplicate_variant',
          errorMessage: `SKU 编码 ${skuCode} 与同一商品的 ${twin} 规格逐字相同、编码只差 BCP 后缀，是同一件货，只保留 ${twin}`,
          rawValueMasked: skuCode,
        });
        continue;
      }

      addSibling(siblings, group.productCode, identity);
      groupSkuWrites.push({
        action: 'create',
        skuCode,
        productCode: group.productCode,
        rowNumber: entry.rowNumber,
        values: skuValuesOf(entry.row),
      });
    }

    if (groupSkuWrites.length === 0) {
      // 该组一行都没活下来。规格级的拒因已经逐行记过，这里不再补第二条 —— 同一行
      // 报两个原因是噪声，操作员按第一条改就行。
      continue;
    }

    spuWrites.push(
      existing === undefined
        ? {
            action: 'create',
            productCode: group.productCode,
            rowNumbers: group.rows.map((entry) => entry.rowNumber),
            values,
          }
        : {
            action: 'update',
            productCode: group.productCode,
            spuId: existing.id,
            rowNumbers: group.rows.map((entry) => entry.rowNumber),
            patch: spuPatchOf(values),
          },
    );
    skuWrites.push(...groupSkuWrites);
  }

  return {
    spuWrites,
    skuWrites,
    rejections,
    spuCount: spuWrites.length,
    skuCount: skuWrites.length,
    rejectedRowCount: new Set(rejections.map((rejection) => rejection.rowNumber)).size,
  };
}

/**
 * 把一个商品的规格记进孪生索引。
 *
 * 同一个编码记两次是无害的（已有的行会在新建检查里再被看到一次），但**不记**才会坏：
 * 一份文件里先后两行互为孪生时，第二行靠的就是第一行在这里留下的痕迹。
 *
 * @param siblings - 按商品编码分堆的孪生索引。
 * @param productCode - 这一行属于哪个商品。
 * @param identity - 这一行的编码与规格。
 */
function addSibling(
  siblings: Map<string, SkuIdentity[]>,
  productCode: string,
  identity: SkuIdentity,
): void {
  const existing = siblings.get(productCode);
  if (existing === undefined) {
    siblings.set(productCode, [identity]);
    return;
  }
  if (!existing.some((sibling) => sibling.skuCode === identity.skuCode)) {
    existing.push(identity);
  }
}

/**
 * 这个商品下有没有已经存在的行，和待新建的这行是同一件货。
 *
 * 判据只有 `isDuplicateSku` 一个来源；这里只负责把「同一个商品的那几条规格」找出来，
 * 一条商品通常只有几条规格，所以直接扫，不为它造第二种「规格相等」的实现。
 *
 * @param siblings - 按商品编码分堆的孪生索引。
 * @param productCode - 待新建的行属于哪个商品。
 * @param candidate - 待新建的行。
 * @returns 已经存在的那一行的编码，没有孪生时为 `null`。
 */
function findSkuTwin(
  siblings: Map<string, SkuIdentity[]>,
  productCode: string,
  candidate: SkuIdentity,
): string | null {
  const known = siblings.get(productCode) ?? [];
  const twin = known.find((sibling) => isDuplicateSku(candidate, sibling));
  return twin?.skuCode ?? null;
}

/** 一种商品的若干行，按 `product_code` 归并，保持文件顺序。 */
type ProductCodeGroup = {
  readonly productCode: string;
  readonly rows: ReadonlyArray<{
    readonly rowNumber: number;
    readonly row: ProductImportPreviewRow;
  }>;
};

/**
 * 按 `product_code` 归并数据行。
 *
 * 用 Map 而不是先 sort：顺序要保留文件里的「第一次出现」，排序会让「文件自己前后
 * 矛盾时以先出现者为准」这条规则依赖于编码的字面顺序。
 */
function groupByProductCode(
  rows: ReadonlyArray<ProductImportPreviewRow>,
): ReadonlyArray<ProductCodeGroup> {
  const groups = new Map<string, ProductCodeGroup['rows'][number][]>();
  for (const row of rows) {
    const bucket = groups.get(row.spu.productCode);
    if (bucket === undefined) {
      groups.set(row.spu.productCode, [{ rowNumber: row.rowNumber, row }]);
      continue;
    }
    bucket.push({ rowNumber: row.rowNumber, row });
  }
  return [...groups.entries()].map(([productCode, entries]) => ({ productCode, rows: entries }));
}

/**
 * 该组商品级字段：逐个字段取首个「文件确实给了值」的那一行。
 *
 * 刻意**不掺库里的旧值**：`values` 的语义是「这份文件说了什么」，掺进旧值之后
 * 更新补丁就会把文件根本没提的字段回写一遍 —— 值虽然一样，但那是巧合，不是规则。
 */
function spuValuesOf(
  rows: ProductCodeGroup['rows'],
  productCode: string,
  categoryId: string | null,
): ProductImportSpuValues {
  const spus = rows.map((entry) => entry.row.spu);
  return {
    productCode,
    // title 是 Parser 的必填字段，每行都有；仍走一次首个非空，免得空串混进来。
    title: firstNonNull(spus.map((spu) => spu.title)) ?? '',
    categoryId,
    externalProductId: firstNonNull(spus.map((spu) => spu.externalProductId)),
    subtitle: firstNonNull(spus.map((spu) => spu.subtitle)),
    productUrl: firstNonNull(spus.map((spu) => spu.productUrl)),
    mainImageUrl: firstNonNull(spus.map((spu) => spu.mainImageUrl)),
    sellingPoints: firstNonEmptyArray(spus.map((spu) => spu.sellingPoints)) ?? [],
    commonAttributes: firstNonEmptyRecord(spus.map((spu) => spu.commonAttributes)) ?? {},
    shelfStatus: firstNonNull(spus.map((spu) => spu.shelfStatus)) ?? UNSTATED_SHELF_STATUS,
    sourceType: IMPORT_SPU_SOURCE_TYPE,
    sourceUpdatedAt: firstNonNull(spus.map((spu) => spu.sourceUpdatedAt)),
  };
}

/**
 * 商品的更新补丁：只装文件确实提供了值的字段。
 *
 * `shelfStatus === 'unknown'` 与 `sellingPoints` / `commonAttributes` 为空，
 * 都是「文件没说」而不是「改成空」—— 见文件头那段取舍说明。
 */
function spuPatchOf(values: ProductImportSpuValues): ProductSpuPatch {
  const patch: {
    categoryId?: string | null;
    title?: string;
    subtitle?: string | null;
    mainImageUrl?: string | null;
    productUrl?: string | null;
    sellingPoints?: ReadonlyArray<string>;
    commonAttributes?: CatalogAttributes;
    shelfStatus?: SpuShelfStatus;
  } = {};
  if (values.categoryId !== null) patch.categoryId = values.categoryId;
  if (values.title.length > 0) patch.title = values.title;
  if (values.subtitle !== null) patch.subtitle = values.subtitle;
  if (values.mainImageUrl !== null) patch.mainImageUrl = values.mainImageUrl;
  if (values.productUrl !== null) patch.productUrl = values.productUrl;
  if (values.sellingPoints.length > 0) patch.sellingPoints = values.sellingPoints;
  if (Object.keys(values.commonAttributes).length > 0)
    patch.commonAttributes = values.commonAttributes;
  if (values.shelfStatus !== UNSTATED_SHELF_STATUS) patch.shelfStatus = values.shelfStatus;
  return patch;
}

/** 新建规格的字段：Parser 给的缺省（`active`）是诚实的，照写。 */
function skuValuesOf(row: ProductImportPreviewRow): ProductImportSkuValues {
  return {
    skuCode: row.sku.skuCode,
    variant: row.sku.variant,
    searchAttributes: row.sku.searchAttributes,
    status: row.sku.status,
  };
}

/** 规格的更新补丁：同样只装文件确实提供了值的字段。 */
function skuPatchOf(row: ProductImportPreviewRow): ProductSkuPatch {
  const patch: {
    variant?: VariantAttributes;
    searchAttributes?: VariantAttributes;
    status?: SkuStatus;
  } = {};
  if (Object.keys(row.sku.variant).length > 0) patch.variant = row.sku.variant;
  if (Object.keys(row.sku.searchAttributes).length > 0)
    patch.searchAttributes = row.sku.searchAttributes;
  if (row.sku.status !== UNSTATED_SKU_STATUS) patch.status = row.sku.status;
  return patch;
}

/** 首个非 `null`（空串也算没给）。 */
function firstNonNull<T>(values: ReadonlyArray<T | null>): T | null {
  for (const value of values) {
    if (value === null) continue;
    if (typeof value === 'string' && value.length === 0) continue;
    return value;
  }
  return null;
}

/** 首个非空数组。 */
function firstNonEmptyArray<T>(values: ReadonlyArray<ReadonlyArray<T>>): ReadonlyArray<T> | null {
  for (const value of values) {
    if (value.length > 0) return value;
  }
  return null;
}

/** 首个非空对象。 */
function firstNonEmptyRecord<V>(
  values: ReadonlyArray<Readonly<Record<string, V>>>,
): Readonly<Record<string, V>> | null {
  for (const value of values) {
    if (Object.keys(value).length > 0) return value;
  }
  return null;
}
