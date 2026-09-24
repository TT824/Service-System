'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Drop the SKU rows that duplicate another row of the same product.
 *
 * 2026-09-20 的实测：真实目录 14,996 条 SKU 里，**233 组、418 条**与同 SPU 下另一条
 * 的 `variant_json` 逐字相同（同颜色、同规格，`search_attributes_json` 全是 `{}`，
 * 即价格库存也没差）。它们不是「相似的两种货」，是同一件货被 ERP 写了两遍。
 *
 * 为什么必须清掉：切片文本是从 `variant_json` 派生的，两条一模一样的行派生出两条
 * 一模一样的切片。检索每条腿都按切片打分，重复切片于是**不是「多一条候选」而是
 * 「同一个答案占两个位子」** —— 前五里出现两次同一款同一色，precision@5 直接掉一半，
 * 而 `sameFamilyOtherValue` 那种「同款异色」的读数也被污染。答案侧同样：SKU 列表
 * 读的是 `product_skus`（**不看 `status`**），重复行会在候选里列两行。
 *
 * **判据只有一份，在 `@kefu/core` 的 `sku-duplicate.ts` 里**，本脚本只是它的一个使用者：
 * 同一个 `isSameGoodsCodePair` 也被导入计划用来拦「新进来的第二份编码」（见
 * `product-import-plan.ts`），否则清过的库会被下一份导入表原样灌回来。脚本读的是
 * **构建产物**，所以改完 core 要先 `npm run build:packages` 再跑（忘了会在启动时直接报错，
 * 不会静默按旧规则删）。
 *
 * **只认一种形状，而且这是量出来的，不是猜的。** 一条 `sku_code` 恰好是另一条后面加
 * `BCP`（`KD3008-02` / `KD3008-02BCP`）：同一件货被 ERP 开了两个编码，规格逐字相同。
 * 实测 99 组，全是这个形状。规格相等这一半由 SQL 的 `PARTITION BY ... variant_json::text`
 * 保证，所以这里只问编码那一半。
 *
 * **不认「同规格就是重复」，因为它是假的**：剩下 134 组同 `variant_json` 的行，看下去
 * 是**不同的 SKU 碰巧共用一个颜色词** —— `S26-BL-KLCDDX06` 对 `S26-BL-KLCDDX153`、
 * `LC6132` 对 `LC613-H`、`XCX-DX-BXL` 对 `XCX-DX-HXL`（尺码就在编码里）。那是真货，
 * 删了就是把商家的商品从库里抹掉。所以本脚本**没有**「按规格去重」的口径：要更宽的口径，
 * 得先有一份能区分「同款异码」和「同款重码」的证据，而不是一个 `--apply` 开关。
 * 组合类（`福利品|套装|组合|赠品` 标题、或同规格 3 条以上）同理：`JJ福利品-蕉下胶囊五折伞`
 * 下四条同色行挂的是 `S26-JJFL01-AS00408` 这类**不同款**编码，是组合里的一件件商品。
 *
 * **删行必须连切片一起删**：源扫描对「已经消失的源行」是**不管**的（见
 * `knowledge-index-state`：stale 只覆盖同一个源行少产出的切片），所以只删 SKU 行会把它
 * 那条切片留在库里继续被检索到 —— 那比不去重更坏。本脚本在同一条事务里删切片，
 * `knowledge_chunk_keywords` / `knowledge_chunk_embeddings` 有 `ON DELETE CASCADE`。
 *
 * **它是干跑，除非加 `--apply`**，而且 `--apply` 会先把将删的行整行写进还原文件
 * （默认落在仓库上一级目录，与「块5-租户存量备份」同一处）。**跑之前 Worker 要停**：
 * 一个正在跑的源扫描会把被删源行留下的切片重新算出来写回去的窗口关掉不难，但没必要赌。
 *
 * 用法（直接 `node`，别经 npm —— npm 会把 `--flag` 吃掉）：
 *
 *   node database/scripts/dedupe-product-skus.cjs                  # 预览
 *   node database/scripts/dedupe-product-skus.cjs --apply          # 清 99 条 BCP 孪生
 *   node database/scripts/dedupe-product-skus.cjs --tenant=tenant-acme --apply
 */

const fs = require('node:fs');
const path = require('node:path');

const { Client } = require('pg');

const dotenv = require('dotenv');

const { isSameGoodsCodePair } = require('@kefu/core');

const ROOT_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ROOT_ENV_PATH)) {
  dotenv.config({ path: ROOT_ENV_PATH });
}

// 读的是 `@kefu/core` 的构建产物。改了 core 没重建时，这里会安静地按旧规则删 —— 与
// 「先 build 再跑」这个前提相比，直接报错更便宜。
if (typeof isSameGoodsCodePair !== 'function') {
  throw new Error('@kefu/core 里没有 isSameGoodsCodePair：先跑 npm run build:packages');
}

function log(message) {
  console.log(`dedupe: ${message}`);
}

/**
 * Read one `--name=value` argument.
 *
 * @param {string} name - Argument name without the dashes.
 * @returns {string | null} The value, or `null` when the argument is absent.
 */
function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

/**
 * The duplicate groups of one tenant, with the winner and the losers of each.
 *
 * The group is `(spu_id, variant_json)` and the row kept is the smallest `sku_code`
 * (for a `BCP` twin that is always the un-suffixed one — `FK3029-01` sorts before
 * `FK3029-01BCP`). Every group is returned, including the 134 the script will not
 * touch, because the preview's job is to show both sides of that line.
 *
 * @param {Client} client - Connected client.
 * @param {string | null} tenantId - One tenant, or `null` for every tenant.
 * @returns {Promise<Array<{spuId: string, title: string, variant: string, keep: string, drop: Array<string>, dropIds: Array<string>}>>} The groups.
 */
async function duplicateGroups(client, tenantId) {
  const { rows } = await client.query(
    `WITH grouped AS (
       SELECT s.id, s.spu_id, s.sku_code, s.variant_json::text AS variant,
              row_number() OVER (
                PARTITION BY s.spu_id, s.variant_json::text ORDER BY s.sku_code, s.id
              ) AS rank
         FROM product_skus s
        WHERE ($1::text IS NULL OR s.tenant_id = $1)
     )
     SELECT g.spu_id                                        AS "spuId",
            p.title                                         AS title,
            min(g.variant)                                  AS variant,
            (array_agg(g.sku_code ORDER BY g.rank))[1]      AS keep,
            (array_agg(g.sku_code ORDER BY g.rank))[2:]     AS drop,
            (array_agg(g.id ORDER BY g.rank))[2:]           AS "dropIds"
       FROM grouped g
       JOIN product_spus p ON p.id = g.spu_id
      GROUP BY g.spu_id, p.title, g.variant
     HAVING count(*) > 1
      ORDER BY p.title, g.variant`,
    [tenantId],
  );
  return rows;
}

/**
 * Whether a group is the duplicate shape: two rows, one code the other plus `BCP`.
 *
 * The code half of the rule comes from `@kefu/core`; the "and the variants match"
 * half is the SQL `PARTITION BY s.spu_id, s.variant_json::text` above, which is
 * what put these two rows in the same group in the first place.
 *
 * @param {{keep: string, drop: Array<string>}} group - One duplicate group.
 * @returns {boolean} `true` when the group is a twin.
 */
function isBcpTwin(group) {
  return group.drop.length === 1 && isSameGoodsCodePair(group.keep, group.drop[0]);
}

/**
 * Whether a group is one of the shapes the script deliberately leaves alone.
 *
 * Only for the preview's tally: the reason a group is skipped is that it is not a
 * `BCP` twin, and this splits that remainder into "looks like components" and "two
 * different codes that share a colour word".
 *
 * @param {{title: string, drop: Array<string>}} group - One duplicate group.
 * @returns {boolean} `true` when the group looks like components rather than copies.
 */
function isProbablyComponents(group) {
  return /福利品|套装|组合|赠品/.test(group.title) || group.drop.length > 1;
}

/**
 * Delete the losers and their slices, in one transaction, after writing the undo file.
 *
 * @param {Client} client - Connected client.
 * @param {Array<object>} groups - The groups in scope.
 * @param {string} undoPath - Where the deleted rows are written before anything is.
 * @returns {Promise<{rows: number, chunks: number}>} What was deleted.
 */
async function apply(client, groups, undoPath) {
  const ids = groups.flatMap((group) => group.dropIds);
  await client.query('BEGIN');
  try {
    const doomed = await client.query(
      `SELECT * FROM product_skus WHERE id = ANY($1::text[]) ORDER BY id`,
      [ids],
    );
    fs.writeFileSync(
      undoPath,
      JSON.stringify({ deletedAt: new Date().toISOString(), productSkus: doomed.rows }, null, 1),
    );
    const chunks = await client.query(
      `DELETE FROM knowledge_chunks
        WHERE source_kind = 'product_sku' AND source_id = ANY($1::text[])`,
      [ids],
    );
    const rows = await client.query(`DELETE FROM product_skus WHERE id = ANY($1::text[])`, [ids]);
    await client.query('COMMIT');
    return { rows: rows.rowCount, chunks: chunks.rowCount };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const apply_ = process.argv.includes('--apply');
  const tenantId = argValue('tenant');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const groups = await duplicateGroups(client, tenantId);
    const scope = groups.filter(isBcpTwin);
    const skipped = groups.filter((group) => !isBcpTwin(group));
    const dropRows = scope.reduce((total, group) => total + group.drop.length, 0);

    log(`同规格重复共 ${groups.length} 组；其中 ${scope.length} 组是 BCP 孪生（可删 ${dropRows} 行）`);
    for (const group of scope.slice(0, 5)) {
      log(`  删 ${group.drop.join(', ')} ← 留 ${group.keep}（${group.title}）`);
    }
    if (scope.length > 5) {
      log(`  …共 ${scope.length} 组，逐组明细见 --apply 的还原文件`);
    }
    const componentLike = skipped.filter(isProbablyComponents).length;
    log(`不动 ${skipped.length} 组：${componentLike} 组形如组合/福利品或有 3 条以上`);
    for (const group of skipped.filter((group) => !isProbablyComponents(group)).slice(0, 3)) {
      log(`  同色不同码（不是重复）：${group.keep} / ${group.drop.join(', ')}（${group.title}）`);
    }

    if (!apply_) {
      log('干跑结束。加 --apply 才写库（会先写还原文件）。');
      return;
    }
    if (scope.length === 0) {
      log('没有可删的行，什么都没写。');
      return;
    }

    const undoPath =
      argValue('undo') ??
      path.resolve(
        __dirname,
        '..',
        '..',
        '..',
        `product-skus-去重备份-${new Date().toISOString().slice(0, 10)}.json`,
      );
    const deleted = await apply(client, scope, undoPath);
    log(`已删 ${deleted.rows} 行 SKU、${deleted.chunks} 条切片；还原文件 ${undoPath}`);
    log('复原：把还原文件里的行插回 product_skus，再跑一遍源扫描（切片会重新派生）。');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`dedupe: ${error.message}`);
  process.exitCode = 1;
});
