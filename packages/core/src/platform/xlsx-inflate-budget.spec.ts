import { Workbook } from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { MAX_PRODUCT_IMPORT_FILE_BYTES, parseProductImportFile } from './product-import-parser';
import {
  XlsxInflateBudgetExceededError,
  assertXlsxWithinInflateBudget,
  xlsxInflateBudgetFor,
} from './xlsx-inflate-budget';

const MIB = 1024 * 1024;

/** 与 `product-import-parser.spec.ts` 同法：绕开 exceljs 自带的 `Buffer` 声明差异。 */
async function toNodeBuffer(pending: Promise<unknown>): Promise<Buffer> {
  return Buffer.from((await pending) as Uint8Array);
}

/** 拼一个真实可解析的 XLSX。 */
async function buildXlsx(): Promise<Buffer> {
  const workbook = new Workbook();
  const worksheet = workbook.addWorksheet('商品');
  worksheet.addRow(['商品编码', '商品标题', 'SKU编码']);
  worksheet.addRow(['P1', '标题1', 'SKU1']);
  return toNodeBuffer(workbook.xlsx.writeBuffer());
}

/**
 * 拼一颗「合法 ZIP、极度可压缩」的炸弹：单个条目塞满重复字符。
 *
 * 它刻意不是一份完备的 XLSX（没有 workbook.xml），因为要验证的是**闸门本身**，
 * 而闸门在 `exceljs` 之前跑 —— 能拦下它就说明拦得住把进程打死的那一步。
 */
async function buildBombZip(payloadBytes: number): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('xl/worksheets/sheet1.xml', 'A'.repeat(payloadBytes));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('xlsxInflateBudgetFor', () => {
  it('applies the floor for tiny archives', () => {
    expect(xlsxInflateBudgetFor(1024)).toBe(32 * MIB);
  });

  it('scales by ratio in the middle range', () => {
    // 4 MiB × 50 = 200 MiB：高于底线、低于上限，取比例值。
    expect(xlsxInflateBudgetFor(4 * MIB)).toBe(200 * MIB);
  });

  it('caps at the ceiling for archives near the compressed-size limit', () => {
    // 11 MiB × 50 = 550 MiB，被上限截到 256 MiB —— 否则上限形同虚设。
    expect(xlsxInflateBudgetFor(MAX_PRODUCT_IMPORT_FILE_BYTES + MIB)).toBe(256 * MIB);
  });
});

describe('assertXlsxWithinInflateBudget', () => {
  it('accepts a normal xlsx', async () => {
    await expect(assertXlsxWithinInflateBudget(await buildXlsx())).resolves.toBeUndefined();
  });

  it('rejects an archive whose real inflated size exceeds the budget', async () => {
    const bomb = await buildBombZip(2 * MIB);

    await expect(assertXlsxWithinInflateBudget(bomb, 512 * 1024)).rejects.toBeInstanceOf(
      XlsxInflateBudgetExceededError,
    );
  });

  it('aborts early instead of inflating the whole payload', async () => {
    const payloadBytes = 8 * MIB;
    const bomb = await buildBombZip(payloadBytes);

    let observed: unknown = null;
    try {
      await assertXlsxWithinInflateBudget(bomb, 256 * 1024);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(XlsxInflateBudgetExceededError);
    // 超预算即销毁流：量到的量应当只略微越过预算，而不是走完整份 8 MiB 载荷。
    // 这一条正是这道防线能扛住炸弹的原因，退化成「量到底再报错」就失效了。
    const counted = (observed as XlsxInflateBudgetExceededError).inflatedBytes;
    expect(counted).toBeGreaterThanOrEqual(256 * 1024);
    expect(counted).toBeLessThan(MIB);
  });

  it('reports the declared-size lie is irrelevant by measuring real output', async () => {
    // 载荷只有几百字节，但解压后 1 MiB：说明量的是真实输出而非体积大小。
    const bomb = await buildBombZip(MIB);

    expect(bomb.byteLength).toBeLessThan(16 * 1024);
    await expect(assertXlsxWithinInflateBudget(bomb, 64 * 1024)).rejects.toBeInstanceOf(
      XlsxInflateBudgetExceededError,
    );
  });
});

describe('parseProductImportFile — XLSX 解压预算', () => {
  it('rejects a decompression bomb as file_too_large instead of dying', async () => {
    // 载荷高于 32 MiB 底线预算，压缩后却远低于 10 MiB 的压缩体积闸门 ——
    // 所以只有解压预算这一道闸门拦得住它。
    // 修好之前，这里不是「断言失败」，而是整个测试进程 SIGABRT（EXIT=134）。
    const bomb = await buildBombZip(34 * MIB);

    expect(bomb.byteLength).toBeLessThan(MAX_PRODUCT_IMPORT_FILE_BYTES);

    const result = await parseProductImportFile({ format: 'xlsx', content: bomb });

    expect(result.summary.fatal).toBe(true);
    expect(result.summary.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'file_too_large')).toBe(true);
    expect(result.previewRows).toHaveLength(0);
  });

  it('still parses a normal xlsx', async () => {
    const result = await parseProductImportFile({ format: 'xlsx', content: await buildXlsx() });

    expect(result.summary.fatal).toBe(false);
    expect(result.summary.ok).toBe(true);
    expect(result.summary.sheetName).toBe('商品');
    expect(result.previewRows[0]?.spu.productCode).toBe('P1');
  });
});
