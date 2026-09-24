/**
 * 「同一件货被写了两个编码」的判据 —— 写一次，两个地方用。
 *
 * 2026-09-20 对真实目录的普查：14,996 条 SKU 里有 **99 对**同商品、同规格、编码只差
 * `BCP` 后缀的行（`KD3008-02` / `KD3008-02BCP`）。它们不是「相似的两种货」，是同一件货
 * 被 ERP 开了两个编码 —— 而切片是从规格派生的，两条一模一样的行会派生出两条一模一样
 * 的切片，于是检索的前五里同一个答案占两个位子，precision@5 直接掉一半。
 *
 * 这不是一次性的脏数据，所以判据不能只活在清理脚本里：清过的库会被下一份导入表重新
 * 灌回来。**清理脚本与导入计划读的是同一份规则**：
 *
 * - {@link isDuplicateSku} 是完整判据（编码 + 规格），导入计划用它
 *   （`product-import-plan.ts`：新建一行之前先找孪生）；
 * - {@link isSameGoodsCodePair} 是编码那一半，`database/scripts/dedupe-product-skus.cjs`
 *   用它 —— 那个脚本在 SQL 里按 `variant_json::text` 分组，规格相等已经由分组本身保证，
 *   它不需要（也不该）在 JS 里再判一次。
 *
 * ## 为什么判据不是「规格相同就是重复」
 *
 * 剩下 134 组同规格的行**不是重复**：多数是**不同的货碰巧共用一个颜色词**
 * （`S26-BL-KLCDDX06` 对 `S26-BL-KLCDDX153`、`LC6132` 对 `LC613-H`，尺码就在编码里），
 * 还有组合商品里的一件件货（`JJ福利品-蕉下胶囊五折伞` 下四条同色行挂的是不同款编码）。
 * 按规格去重会把商家的真商品删掉，而那是**不可见的损失** —— 比留一条重复坏得多。
 * 所以规格相等是**必要条件**，不是充分条件；编码上的 `BCP` 关系才是把「同一件货两个
 * 编码」与「同色不同货」分开的那半个判据。
 *
 * ## 判据不看售价与库存
 *
 * `search_attributes_json`（售价、库存）不参与比较：同一件货的两个编码各自带着自己的
 * 库存与价格是常态，价格不同不改变「这是同一件货」。实测那 99 对的
 * `search_attributes_json` 全是 `{}`，但判据**不靠**这一点成立。
 */

import type { VariantAttributes } from './catalog';

/**
 * ERP 给同一件货开的第二个编码后缀。
 *
 * 两种写法都见过：直接拼（`KD3008-02BCP`）和带连字符（`KD3008-02-BCP`）。列成一个短
 * 名单而不是写正则，是为了让「什么样的后缀算数」是读得出来的 —— 这个名单就是判据的
 * 全部，多一个写法要在这里加一行，而不是去猜正则匹配到了什么。
 */
export const DUPLICATE_SKU_CODE_SUFFIXES = ['BCP', '-BCP'] as const;

/** 判据的输入：一条规格身上与「是不是同一件货」有关的两样东西。 */
export type SkuIdentity = {
  readonly skuCode: string;
  readonly variant: VariantAttributes;
};

/**
 * 两个编码是不是同一件货的两个编码。
 *
 * **是对称的**：不假定谁带后缀。清理脚本按编码排序留下不带后缀的那个，而导入这一侧
 * 面对的是「库里已经有哪个」，两种方向都得认，否则一份只带来 `X`（库里是 `XBCP`）的
 * 文件会凭空多出一行。
 *
 * @param a - 一个 SKU 编码。
 * @param b - 另一个 SKU 编码。
 * @returns 两个编码只差一个 {@link DUPLICATE_SKU_CODE_SUFFIXES} 里的后缀时为 `true`。
 */
export function isSameGoodsCodePair(a: string, b: string): boolean {
  return DUPLICATE_SKU_CODE_SUFFIXES.some(
    (suffix) => a === `${b}${suffix}` || b === `${a}${suffix}`,
  );
}

/**
 * 两份规格是不是逐字相同。
 *
 * 比较的是**键值对集合**，不是键的顺序：一边来自 `variant_json`（jsonb 把键归一化过），
 * 一边来自解析器按文件列序拼出来的对象，键序不同而内容相同的两行是同一行。
 *
 * @param a - 一份规格。
 * @param b - 另一份规格。
 * @returns 键集合与取值都相同时为 `true`。
 */
export function sameVariantAttributes(a: VariantAttributes, b: VariantAttributes): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  return (
    keysA.length === keysB.length &&
    keysA.every((key, index) => key === keysB[index] && a[key] === b[key])
  );
}

/**
 * 一条规格是不是另一条的重复：**编码只差 `BCP` 后缀，且规格逐字相同**。
 *
 * 两个条件缺一不可，理由见模块说明（单看规格会删掉真商品，单看编码会把 `XBCP` 这种
 * 自成一款的可能性误判）。方向无所谓 —— 见 {@link isSameGoodsCodePair}。
 *
 * @param candidate - 待判的行。
 * @param sibling - 同一商品下已经存在（或本文件里已经认下）的一行。
 * @returns 两行是同一件货的两个编码时为 `true`。
 */
export function isDuplicateSku(candidate: SkuIdentity, sibling: SkuIdentity): boolean {
  return (
    isSameGoodsCodePair(candidate.skuCode, sibling.skuCode) &&
    sameVariantAttributes(candidate.variant, sibling.variant)
  );
}
