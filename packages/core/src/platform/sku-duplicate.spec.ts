/**
 * 判据本身：什么样的两条规格算「同一件货被写了两个编码」。
 *
 * 这里钉的不是「能认出来」，而是**它不认什么** —— 判据放宽一格，商家的真商品就被
 * 悄悄抹掉一行，而那种损失在界面上看不出来。用例里的反例都来自 2026-09-20 对真实
 * 目录的普查（134 组同规格但不同货的行）。
 */

import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_SKU_CODE_SUFFIXES,
  isDuplicateSku,
  isSameGoodsCodePair,
  sameVariantAttributes,
} from './sku-duplicate';

describe('isSameGoodsCodePair', () => {
  it('认直接拼接与带连字符两种后缀', () => {
    expect(isSameGoodsCodePair('KD3008-02', 'KD3008-02BCP')).toBe(true);
    expect(isSameGoodsCodePair('KD3008-02', 'KD3008-02-BCP')).toBe(true);
    // 后缀名单就是判据：名单里的每一个都要真的被认出来。
    for (const suffix of DUPLICATE_SKU_CODE_SUFFIXES) {
      expect(isSameGoodsCodePair('X', `X${suffix}`)).toBe(true);
    }
  });

  it('是对称的：不假定谁是带后缀的那一个', () => {
    expect(isSameGoodsCodePair('KD3008-02BCP', 'KD3008-02')).toBe(true);
    // 库里的存量是带后缀那个时，导入这一侧靠的就是这一条。
    expect(isSameGoodsCodePair('KD3008-02-BCP', 'KD3008-02')).toBe(true);
  });

  it('后缀必须整体拼接，不是「包含 BCP」', () => {
    expect(isSameGoodsCodePair('KD3008-02', 'KD3008-02BCP1')).toBe(false);
    expect(isSameGoodsCodePair('KD3008-02', 'BCP-KD3008-02')).toBe(false);
    expect(isSameGoodsCodePair('KD3008-02', 'KD3008-02bcp')).toBe(false);
  });

  it('不相干的编码不是一对，哪怕只差一个字符', () => {
    expect(isSameGoodsCodePair('S26-BL-KLCDDX06', 'S26-BL-KLCDDX153')).toBe(false);
    expect(isSameGoodsCodePair('LC6132', 'LC613-H')).toBe(false);
    expect(isSameGoodsCodePair('X', 'X')).toBe(false);
  });
});

describe('sameVariantAttributes', () => {
  it('比键值对，不比键的顺序', () => {
    // 一边来自 `variant_json`（jsonb 归一化过键序），一边来自解析器按文件列序拼的对象。
    expect(sameVariantAttributes({ 颜色: '黑', 规格: 'M' }, { 规格: 'M', 颜色: '黑' })).toBe(true);
  });

  it('值不同、键不同、多一个空键都算不同', () => {
    expect(sameVariantAttributes({ 颜色: '黑' }, { 颜色: '白' })).toBe(false);
    expect(sameVariantAttributes({ 颜色: '黑' }, { 颜色: '黑', 规格: 'M' })).toBe(false);
    expect(sameVariantAttributes({ 颜色: '黑' }, { 颜色: '黑', 备注: '' })).toBe(false);
    expect(sameVariantAttributes({}, {})).toBe(true);
  });
});

describe('isDuplicateSku', () => {
  const base = { skuCode: 'KD3008-02', variant: { 颜色: '黑', 规格: 'M' } };

  it('编码成对且规格逐字相同，才算同一件货', () => {
    expect(isDuplicateSku({ ...base, skuCode: 'KD3008-02BCP' }, base)).toBe(true);
    // 反向也成立 —— 库里是带后缀的那个时靠这一条。
    expect(isDuplicateSku(base, { ...base, skuCode: 'KD3008-02BCP' })).toBe(true);
  });

  it('规格相同但编码不相干：不是重复（这是那 134 组里的多数）', () => {
    expect(isDuplicateSku({ ...base, skuCode: 'S26-BL-KLCDDX153' }, base)).toBe(false);
  });

  it('编码成对但规格不同：不是重复，是两件货', () => {
    expect(isDuplicateSku({ ...base, skuCode: 'KD3008-02BCP', variant: { 颜色: '白' } }, base)).toBe(
      false,
    );
  });

  it('售价与库存不参与判断', () => {
    // `isDuplicateSku` 的入参里根本没有这两样东西 —— 判据类型上就够不着它们。
    expect(Object.keys(base).sort()).toEqual(['skuCode', 'variant']);
    expect(isDuplicateSku({ ...base, skuCode: 'KD3008-02BCP' }, base)).toBe(true);
  });
});
