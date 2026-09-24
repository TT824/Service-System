/**
 * XLSX 解压预算：在把字节交给 `exceljs` **之前**，先量一遍真实解压总量。
 *
 * 为什么需要它：`product-import-parser.ts` 里的体积判据（`MAX_PRODUCT_IMPORT_FILE_BYTES`）
 * 判的是**压缩后**字节，而 ZIP 能把很小的文件解压成极大。实测：305 KiB 的 xlsx 解压出
 * 300 MiB（放大 1007×），Parser 返回不了任何结果 —— 整个 Node 进程 V8 堆溢出后
 * SIGABRT（EXIT=134）。压缩体积闸门对这类文件完全无效。
 *
 * 为什么按**真实字节**而不是目录声明值：ZIP 中央目录里的 `uncompressedSize` 是攻击者可写
 * 的声明值，可以撒谎。这里逐个条目**流式解压并累计实际输出**，一旦超预算立刻销毁流中止，
 * 目录撒谎也绕不过去。
 *
 * 阈值依据（实测，不是拍脑袋）：
 * - 合法文件：5000 行中文商品表 0.15 MiB → 1.6 MiB，约 **11×**。
 * - 炸弹：305 KiB → 300 MiB，约 **1007×**。
 * 两者差两个数量级，中间有充裕的取值空间。
 */

import JSZip from 'jszip';
import type { Readable } from 'node:stream';

/** 允许的放大倍数。合法文件实测约 11×，取 50 留 ~4.5 倍余量。 */
const XLSX_INFLATE_RATIO_BUDGET = 50;

/** 底线预算：否则「压得极小、解出来中等」的炸弹能钻比例的空子。 */
const XLSX_INFLATE_BUDGET_FLOOR_BYTES = 32 * 1024 * 1024;

/** 绝对上限：即使按比例该放行，单次解压也不许超过这个量（11 MiB × 11× ≈ 121 MiB，留 2 倍）。 */
const XLSX_INFLATE_BUDGET_CEILING_BYTES = 256 * 1024 * 1024;

/** 解压总量超出预算。独立类，好让调用方与「文件损坏」区分开。 */
export class XlsxInflateBudgetExceededError extends Error {
  /** 中止时已量到的解压字节数。这是**下界**，不是真实总量 —— 超预算即停，不会量到底。 */
  readonly inflatedBytes: number;
  /** 本次允许的字节上限。 */
  readonly budgetBytes: number;

  constructor(inflatedBytes: number, budgetBytes: number) {
    super(`xlsx 解压后至少 ${inflatedBytes} 字节，超过预算 ${budgetBytes} 字节`);
    this.name = 'XlsxInflateBudgetExceededError';
    this.inflatedBytes = inflatedBytes;
    this.budgetBytes = budgetBytes;
  }
}

/** 按压缩体积算出本次的解压预算。 */
export function xlsxInflateBudgetFor(compressedBytes: number): number {
  return Math.min(
    XLSX_INFLATE_BUDGET_CEILING_BYTES,
    Math.max(XLSX_INFLATE_BUDGET_FLOOR_BYTES, compressedBytes * XLSX_INFLATE_RATIO_BUDGET),
  );
}

/**
 * 流式量一个条目解压后的字节数，超过 `remaining` 立刻中止并抛错。
 *
 * `entry.nodeStream()` 给的是**解压后**的流，所以这里量到的就是 inflate 的真实输出。
 * jszip 声明返回 `NodeJS.ReadableStream`（缺 `destroy`），运行时是真正的 `stream.Readable`
 * 子类，所以强转后调用 `destroy()` 是成立的 —— 不销毁的话，超预算的条目会继续解压到底，
 * 那正是要防的事。
 */
function countEntryBytes(
  entry: JSZip.JSZipObject,
  remaining: number,
  alreadyCounted: number,
  budgetBytes: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const stream = entry.nodeStream() as unknown as Readable;
    let seen = 0;
    stream.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > remaining) {
        stream.destroy();
        reject(new XlsxInflateBudgetExceededError(alreadyCounted + seen, budgetBytes));
      }
    });
    stream.on('end', () => resolve(seen));
    stream.on('error', reject);
  });
}

/**
 * 校验 XLSX 的解压总量在预算内；超预算抛 `XlsxInflateBudgetExceededError`。
 *
 * 只读中央目录后逐条目**流式**解压计数，不物化任何条目内容，因此自身的额外内存占用与
 * 单条目的解压块大小同阶，与文件总解压量无关。
 *
 * 不是合法 ZIP 时 jszip 会抛错 —— 这里**原样抛出**，由调用方决定怎么定性（Parser 会把它
 * 归到既有的 `unreadable_file` 路径，不新造错误语义）。
 */
export async function assertXlsxWithinInflateBudget(
  content: Buffer,
  budgetBytes: number = xlsxInflateBudgetFor(content.byteLength),
): Promise<void> {
  const zip = await JSZip.loadAsync(content);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) {
      continue;
    }
    total += await countEntryBytes(entry, budgetBytes - total, total, budgetBytes);
  }
}
