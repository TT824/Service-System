'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * 一次性把知识库索引的嵌入补齐（跑真代码，只是跑得更密）。
 *
 *   node scripts/backfill-index.cjs
 *
 * 为什么要有这个东西：Worker 的索引循环是**有意**慢的 —— 每 5 秒一批 10 条
 * （`CHUNK_INDEX_POLL_INTERVAL_MS` / `CHUNK_INDEX_BATCH_SIZE`，两者的理由都写在
 * `worker.module.ts` 的注释里）。刚导完 14,996 个 SKU 时库里是 1.8 万条 chunk，
 * 按那个节奏要 ~2.5 小时才补完嵌入，而语义召回在补齐之前基本是空的。
 *
 * 这里**不改那两个常量**（它们是产品决定），也不自己写 SQL：直接 boot 与
 * `apps/worker/src/main.ts` 同一个 Nest 应用上下文，拿真的 `ChunkIndexProcessor`，
 * 反复调它公开的 `runOnce()`。`#tick` 内部不 sleep（`pollIntervalMs` 只在 `#loop`
 * 里），所以背靠背调用就把吞吐从 2 条/秒提到 ~10 条/秒，而且走的仍是
 * 「park → claim → embed → 落库（带 content_hash 校验）」这条唯一路径。
 *
 * 结束条件：连续 3 次一条都没 claim 到（队列真空 + 退避未到）。
 */

const path = require('node:path');
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { config: loadDotenv } = require('dotenv');
const { parseAppConfig } = require('@kefu/core');
const { WorkerModule } = require('../apps/worker/dist/worker.module.js');
const { ChunkIndexProcessor } = require('../apps/worker/dist/knowledge/chunk-index-processor.js');

const ROOT = path.resolve(__dirname, '..');
/**
 * 连续多少次「一条都没 claim 到」才收工。
 *
 * 退避最长是按分钟计的（`knowledgeIndexRetryDelayMs` 指数退避），所以「暂时没得 claim」
 * 不等于「干完了」：初版设 3 次（15 秒）就退出，结果剩 1.3 万条没嵌入就报「完成」——
 * 那比不跑更坏，因为它看起来像跑完了。这里的口径是「歇够了再说」。
 */
const IDLE_TICKS_TO_STOP = 40;
const IDLE_SLEEP_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  loadDotenv({ path: path.join(ROOT, '.env') });
  const parsed = parseAppConfig(process.env);
  if (parsed._tag === 'err') {
    throw new Error(`配置不可用: ${parsed.error.message}`);
  }

  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(parsed.config), {
    logger: false,
  });
  try {
    const processor = app.get(ChunkIndexProcessor);
    if (!processor.providerConfigured) {
      throw new Error('未绑定 embedding provider（EMBEDDING_BASE_URL / EMBEDDING_MODEL）');
    }

    let indexed = 0;
    let failed = 0;
    let parked = 0;
    let superseded = 0;
    let idle = 0;
    const started = Date.now();
    for (;;) {
      const tick = await processor.runOnce();
      indexed += tick.indexed;
      failed += tick.failed;
      parked += tick.parked;
      superseded += tick.superseded;
      // 每次只写一行，外部重定向到文件；别把整段日志喂回上下文。
      process.stdout.write(
        `${new Date().toISOString()} claimed=${tick.claimed} indexed=${tick.indexed} failed=${tick.failed} parked=${tick.parked} 累计嵌入=${indexed} 用时=${Math.round((Date.now() - started) / 1000)}s\n`,
      );
      if (tick.claimed === 0) {
        idle += 1;
        if (idle >= IDLE_TICKS_TO_STOP) break;
        // 队列空多半是「退避未到」，歇一下再问。
        await sleep(IDLE_SLEEP_MS);
      } else {
        idle = 0;
      }
    }
    process.stdout.write(
      `完成: 嵌入 ${indexed}，失败 ${failed}，封存 ${parked}，被覆盖 ${superseded}，用时 ${Math.round((Date.now() - started) / 1000)}s\n`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(`backfill-index: ${error.message}`);
  process.exitCode = 1;
});
