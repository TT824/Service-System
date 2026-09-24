'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * 跑**一遍**源扫描，不等 Worker 的 60 秒轮询。
 *
 *   node scripts/sweep-once.cjs
 *
 * 为什么要有这个东西：改写切片文本的是源扫描（`KnowledgeSourceSweep`），而它只被
 * `apps/worker/src/main.ts` 的 `start()` 驱动 —— 想让它跑一遍，要么起一个真的
 * Worker 等一分钟（顺带启动那些有意慢的循环），要么在源码里临时接线。都不是好选项。
 *
 * 这里走 `backfill-index.cjs` 同一条路：boot 与 `main.ts` 同一个 Nest 应用上下文，
 * 拿真的 `KnowledgeSourceSweep`，调它公开的 `runOnce()`。`main.ts` 的 `start()` 没被
 * 调用，所以出站投递、索引循环都没起 —— 只有这一遍扫描。
 *
 * 典型用法（改完索引源之后重建索引）：
 *
 *   npm run build -w @kefu/worker
 *   node scripts/sweep-once.cjs        # 切片文本变了 → 进 pending
 *   node scripts/backfill-index.cjs    # 把 pending 嵌完
 *
 * 扫描不写索引列（`resetsIndexState`），所以「文本变了」这件事由写入路径自己发现：
 * `content_hash` 不一致 → `reindex`。**改的是映射而不是内容时（例如只改了注释）
 * 这里什么都不会发生** —— 那是对的，不是坏了。
 */

const path = require('node:path');
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { config: loadDotenv } = require('dotenv');
const { parseAppConfig } = require('@kefu/core');
const { WorkerModule } = require('../apps/worker/dist/worker.module.js');
const {
  KnowledgeSourceSweep,
} = require('../apps/worker/dist/knowledge/knowledge-source-sweep.js');

loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

async function main() {
  const parsed = parseAppConfig(process.env);
  if (parsed._tag === 'err') {
    throw new Error(`配置不可用: ${parsed.error.message}`);
  }

  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(parsed.config), {
    logger: false,
  });
  try {
    const sweep = app.get(KnowledgeSourceSweep);
    const started = Date.now();
    const result = await sweep.runOnce();
    process.stdout.write(
      `${new Date().toISOString()} 扫描完成: ${JSON.stringify(result)} 用时=${Math.round((Date.now() - started) / 1000)}s\n`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(`sweep-once: ${error.message}`);
  process.exitCode = 1;
});
