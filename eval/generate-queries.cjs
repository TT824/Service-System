'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * 生成冻结的检索评测集（只读库、不调模型、可复现）。
 *
 *   node eval/generate-queries.cjs [--seed 20260920] [--dev 120] [--validation 240]
 *
 * 出的东西（`eval/` 下）：
 *   queries.dev.json         开发集：调参时可以随便看、随便挑错例
 *   queries.validation.json  验证集：**冻结**，manifest 里记着它的 sha256
 *   manifest.json            冻结记录：种子、目录指纹、两个文件的 sha256
 *
 * 三类查询，都从**真实商品目录**里长出来，判据机器可算：
 *   1. `family`   品类/款式词（「中筒袜」「天然植物男士」）：目标是**标题命中该词的
 *      所有 SPU**（一个集合，不是一条）——顾客问「有棵树男士内裤」时，任何一个该款
 *      命中都算对，硬钉在某一条 SPU 上会把「答对了但换了同款」算成失败。
 *      只保留目标集大小在 `2..40` 的词：太大（如「内裤」上千条）等于没判别力，
 *      等于白送命中率。
 *   2. `color` / `size`  词 + 颜色/尺码（「中筒袜 黑色」「羽绒服 XL」）：目标是
 *      **标题含该词 且 有 SKU 带该颜色/尺码** 的 SPU。这一类的错品率就是 SDD-014
 *      点名要量「明确型号/颜色/尺码」的那一个。
 *   3. `code`     款式编码（`YAAU1189`）：目标就是这条 SPU。**只取编码本身出现在
 *      标题里的那些** —— 编码不在任何切片文本里时，文字检索按构造就找不回来，
 *      拿它当「检索失败」是冤枉检索。这一类在评测里当**量具校准**用。
 *   4. `negation` 词 + `不要黑色`：目标是「该词的全部 SPU」，另记 `negated` 值，
 *      量的是**污染率**（前五里还有没有黑色），而不是命中率。
 *
 * 为什么颜色值要拆：ERP 的「颜色」单元格是多件装的组合（`黑色+深灰+烟灰+浅灰+白色24-26`），
 * 整串当词匹配不到任何东西；这里按 `+`、顿号等拆开，并剥掉尾部尺码（`乌云灰S` → `乌云灰`）。
 * 拆出来的是**词表**，不保证每个都是人话，所以只留出现频次在中间段的那些。
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = __dirname;

const DEFAULTS = {
  tenant: 'tenant-acme',
  store: 'store-acme-flagship',
  seed: 20260920,
  dev: 120,
  validation: 240,
};

/** 目标集大小下界：1 条目标等于「唯一正解」，把同款换货算成失败。 */
const MIN_TARGETS = 2;
/**
 * 窄词/宽词的分界。
 *
 * 上界不是用来筛掉「没有判别力的词」的 —— 顾客真会打的就是「防晒帽」这种名词，
 * 而这类词在目录里天然有几百条命中，之前按 40 条一刀切，等于**把最真实的题全扔了、
 * 只留下切得歪的碎片**。分成两档量、分开报：窄词（≤ 40 条目标）是主口径，
 * 宽词（41..120）另算一档，读者一眼能看出两档不是一回事。
 */
const NARROW_MAX_TARGETS = 40;
/** 再宽就不当题了：3,634 条 SPU 里随便抓五条都可能碰上，「命中率」不再是信息。 */
const MAX_TARGETS = 120;
/** 每个类型抽多少条（最终按 dev/validation 切）。 */
const MIX = { family: 130, color: 130, size: 40, code: 34, negation: 30 };
/** LIKE 探测（查目标集）的次数上限，免得候选词上万时把库刷爆。 */
const MAX_PROBES = 800;
/** 词表候选：颜色/尺码值出现过的 SPU 数必须在这一段里。 */
const VALUE_MIN_SPUS = 15;
/** 尺码的独立门槛，理由见下面 `vocabulary` 的调用处。 */
const SIZE_MIN_SPUS = 4;
const VALUE_MAX_SPUS = 1500;

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} 需要值`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return {
    tenant: options.tenant,
    store: options.store,
    seed: Number.parseInt(String(options.seed), 10),
    dev: Number.parseInt(String(options.dev), 10),
    validation: Number.parseInt(String(options.validation), 10),
  };
}

function databaseUrl() {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const match = /^DATABASE_URL=(.+)$/m.exec(env);
  if (match === null) throw new Error('.env 里没有 DATABASE_URL');
  return match[1].trim();
}

/** 固定种子的伪随机：同一个种子出同一份评测集。 */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1));
    [copy[index], copy[pick]] = [copy[pick], copy[index]];
  }
  return copy;
}

function chineseRuns(text) {
  return text.match(/[一-鿿]+/g) ?? [];
}

/** 剥掉尾部的尺码/编号（`乌云灰S` → `乌云灰`、`漫暮黑-165/72A(L)` → `漫暮黑`）。 */
function stripSizeSuffix(token) {
  return token.replace(/[A-Za-z0-9+\-/.()（）\s]+$/u, '').trim();
}

/** 颜色值 → 词表候选（多件装按 `+`、`、`、`,` 拆开）。 */
function colorTokens(raw) {
  return String(raw)
    .split(/[+、,，/]/u)
    .map((part) => stripSizeSuffix(part))
    .filter((part) => part.length >= 2 && /^[一-鿿]+$/u.test(part));
}

/** 规格值 → 尺码候选（`L (95-120斤);XL (120-140斤)` → `L`、`XL`）。 */
function sizeTokens(raw) {
  return String(raw)
    .split(';')
    .map((part) => part.split(/[(（]/u)[0].trim())
    .filter((part) => part.length > 0 && part.length <= 6 && !/^[一-鿿]+$/u.test(part));
}

function sha256(text) {
  return require('node:crypto').createHash('sha256').update(text).digest('hex');
}

async function main() {
  const { tenant, store, seed, dev, validation } = parseArgs(process.argv.slice(2));
  const random = makeRandom(seed);
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();

  try {
    const spuRows = await client.query(
      `SELECT spu.id, spu.product_code, spu.title, cat.name AS category_name
         FROM product_spus spu
         LEFT JOIN product_categories cat ON cat.id = spu.category_id
        WHERE spu.tenant_id = $1 AND spu.store_id = $2 ORDER BY spu.id`,
      [tenant, store],
    );
    const skuRows = await client.query(
      `SELECT spu_id, variant_json FROM product_skus
        WHERE tenant_id = $1 AND store_id = $2 ORDER BY id`,
      [tenant, store],
    );

    const spus = spuRows.rows.map((row) => ({
      id: row.id,
      code: row.product_code,
      title: row.title,
      category: row.category_name ?? '',
    }));
    const titleById = new Map(spus.map((spu) => [spu.id, spu.title]));

    // 每个 SPU 自己的颜色/尺码集合，和「某个值出现在多少个 SPU 上」的全局频次。
    const spuValues = new Map();
    const colorSpus = new Map();
    const sizeSpus = new Map();
    for (const row of skuRows.rows) {
      const variant = row.variant_json ?? {};
      const bucket =
        spuValues.get(row.spu_id) ??
        (() => {
          const fresh = { colors: new Set(), sizes: new Set() };
          spuValues.set(row.spu_id, fresh);
          return fresh;
        })();
      for (const token of colorTokens(variant['颜色'] ?? '')) {
        bucket.colors.add(token);
        if (!colorSpus.has(token)) colorSpus.set(token, new Set());
        colorSpus.get(token).add(row.spu_id);
      }
      for (const token of sizeTokens(variant['规格'] ?? '')) {
        bucket.sizes.add(token);
        if (!sizeSpus.has(token)) sizeSpus.set(token, new Set());
        sizeSpus.get(token).add(row.spu_id);
      }
    }

    const vocabulary = (index, minSpus) =>
      [...index.entries()]
        .filter(([, ids]) => ids.size >= minSpus && ids.size <= VALUE_MAX_SPUS)
        .sort((a, b) => b[1].size - a[1].size)
        .map(([text, ids]) => ({ text, ids: [...ids], count: ids.size }));

    const colors = vocabulary(colorSpus, VALUE_MIN_SPUS).slice(0, 60);
    // 尺码的门槛单独放宽：这份目录里「规格」只填了 1,019 个 SKU，按颜色的门槛会只剩 3 个值，
    // 等于没有尺码维度可言。放宽到 4 个 SPU 是**如实把这一维量出来**，不是把题凑够。
    const sizes = vocabulary(sizeSpus, SIZE_MIN_SPUS).slice(0, 60);

    // ---- 词候选：从真实标题里切出来，再用库里的 LIKE 数一遍到底命中几条 SPU ----
    const sampled = shuffled(spus, random).slice(0, 900);
    /** 每个标题自己按偏好排好的候选词，探测时按「志愿层」摊开。 */
    const perTitle = new Map();
    const candidates = new Map();
    for (const spu of sampled) {
      const title = spu.code === '' ? spu.title : spu.title.split(spu.code).join(' ');
      // 只取**后缀**，不取任意窗口：中文标题是「修饰语 + 名词」，后缀才落在名词上
      // （「…男士中筒袜」→「男士中筒袜」），任意窗口会切出「炖燕窝雪」这种没人会打的碎片。
      // 再往名词上钉一下：标题大多以**类目名**收尾，所以优先取「恰好停在类目名上」的
      // 后缀（`双饮保温杯` 而不是 `行保温杯`），长度从类目名往上放到 +3 字。
      for (const run of chineseRuns(title)) {
        // 试的顺序就是「像不像人话」的顺序：
        //   1. 整段（`有棵树男士船袜`）—— 真实标题本身就是最真实的题面
        //   2. 类目名词本身（`防晒帽`）—— 顾客真会这么打
        //   3. 名词 + 2 字修饰（`女士防晒帽`）
        //   4. 名词 + 1 字 —— 一定是被切断的（`士防晒帽`），所以排在 +2 后面
        //   5. 名词 + 3 字
        //   6. 兜底：类目名对不上标题尾巴时的 4..8 后缀（长的先试）
        const ordered = [];
        if (run.length >= 2 && run.length <= 8) ordered.push(run);
        if (spu.category.length >= 2 && run.endsWith(spu.category)) {
          const base = spu.category.length;
          for (const length of [base, base + 2, base + 1, base + 3]) {
            if (length <= run.length) ordered.push(run.slice(-length));
          }
        } else {
          for (let length = 8; length >= 4; length -= 1) {
            if (length <= run.length) ordered.push(run.slice(-length));
          }
        }
        for (const phrase of ordered) {
          if (!candidates.has(phrase)) candidates.set(phrase, []);
          candidates.get(phrase).push(spu.id);
          const options = perTitle.get(spu.id) ?? [];
          if (!options.includes(phrase)) options.push(phrase);
          perTitle.set(spu.id, options);
        }
      }
    }

    // 探测的顺序：**先所有人的第一志愿，再所有人的第二志愿**（按志愿分层），
    // 不是「先把标题 1 试到底」。探测预算有限（MAX_PROBES），分层才能让尽量多的
    // 标题用上自己最像人话的那个候选，而不是几十个标题占满预算。
    const probeOrder = [];
    let level = 0;
    for (;;) {
      const tier = [...perTitle.values()]
        .map((options) => options[level])
        .filter((phrase) => phrase !== undefined);
      if (tier.length === 0) break;
      probeOrder.push(...tier);
      level += 1;
    }

    // 拿真实标题再数一遍命中几条 SPU（LIKE 走的是库里的标题，不是我手里的，
    // 所以「目标集」与评测时的检索面一致）。
    const phraseTargets = new Map();
    let probes = 0;
    for (const phrase of probeOrder) {
      if (phraseTargets.size >= 220 || probes >= MAX_PROBES) break;
      if (phraseTargets.has(phrase)) continue;
      // 已经收了一个更长的词，就不再收被它包含的短后缀：
      // 一个标题不该同时贡献「蕾丝内裤」和「丝内裤」两道近乎重复的题。
      if ([...phraseTargets.keys()].some((taken) => taken.includes(phrase))) continue;
      probes += 1;
      const found = await client.query(
        `SELECT id FROM product_spus
          WHERE tenant_id = $1 AND store_id = $2 AND title LIKE '%' || $3 || '%'
          ORDER BY id LIMIT ${MAX_TARGETS + 1}`,
        [tenant, store, phrase],
      );
      const ids = found.rows.map((row) => row.id);
      if (ids.length >= MIN_TARGETS && ids.length <= MAX_TARGETS) {
        phraseTargets.set(phrase, ids);
      }
    }
    const phrases = shuffled([...phraseTargets.keys()], random);
    const bandOf = (targets) => (targets.length <= NARROW_MAX_TARGETS ? 'narrow' : 'broad');

    // ---- 组题 ----
    const pool = [];
    const push = (type, text, targetSpus, extra) => {
      pool.push({
        id: `${type}-${String(pool.length + 1).padStart(3, '0')}`,
        type,
        query: text,
        targetSpus: [...targetSpus].sort(),
        ...extra,
      });
    };

    for (const phrase of phrases.slice(0, MIX.family)) {
      const targets = phraseTargets.get(phrase);
      push('family', phrase, targets, {
        phrase,
        band: bandOf(targets),
        note: `目标集 ${targets.length} 条`,
      });
    }

    // 一个颜色值配多个词，而不是配一个就换下一个值：颜色词只有几十个，
    // 每个值只出一题的话「明确颜色的错品率」就压在三十来道题上。
    const PER_VALUE_LIMIT = 4;
    for (const token of colors) {
      if (pool.filter((item) => item.type === 'color').length >= MIX.color) break;
      let used = 0;
      for (const phrase of phrases) {
        if (used >= PER_VALUE_LIMIT) break;
        const family = phraseTargets.get(phrase);
        const targets = family.filter((id) => spuValues.get(id)?.colors.has(token.text));
        if (targets.length < 1) continue;
        push('color', `${phrase} ${token.text}`, targets, {
          phrase,
          value: token.text,
          dimension: '颜色',
          band: bandOf(targets),
          familySpus: [...family].sort(),
          note: `该词下带此色的 ${targets.length} 条`,
        });
        used += 1;
      }
    }

    for (const token of sizes) {
      if (pool.filter((item) => item.type === 'size').length >= MIX.size) break;
      for (const phrase of phrases) {
        const family = phraseTargets.get(phrase);
        const targets = family.filter((id) => spuValues.get(id)?.sizes.has(token.text));
        if (targets.length < 1) continue;
        push('size', `${phrase} ${token.text}`, targets, {
          phrase,
          value: token.text,
          dimension: '规格',
          band: bandOf(targets),
          familySpus: [...family].sort(),
          note: `该词下带此尺码的 ${targets.length} 条`,
        });
        break;
      }
    }

    // 校准用：编码写在标题里的 SPU，用编码本身当查询词。
    const codable = shuffled(
      spus.filter((spu) => spu.code !== '' && spu.title.includes(spu.code)),
      random,
    );
    for (const spu of codable.slice(0, MIX.code)) {
      push('code', spu.code, [spu.id], {
        phrase: spu.code,
        band: 'exact',
        note: '编码本就写在标题里',
      });
    }

    for (const token of colors) {
      if (pool.filter((item) => item.type === 'negation').length >= MIX.negation) break;
      for (const phrase of phrases) {
        const family = phraseTargets.get(phrase);
        const carrying = family.filter((id) => spuValues.get(id)?.colors.has(token.text));
        if (carrying.length < 1) continue;
        push('negation', `${phrase} 不要${token.text}`, family, {
          phrase,
          value: token.text,
          dimension: '颜色',
          band: bandOf(family),
          familySpus: [...family].sort(),
          negated: token.text,
          negatedSpus: carrying,
          note: `该词下有 ${carrying.length} 条带此色，题面把它排除`,
        });
        break;
      }
    }

    const ordered = shuffled(pool, random);
    const devSet = ordered.slice(0, dev);
    const validationSet = ordered.slice(dev, dev + validation);
    if (validationSet.length === 0) throw new Error('验证集为空，检查 --dev/--validation');

    const maxUpdated = await client.query(
      'SELECT max(updated_at) AS at FROM product_spus WHERE tenant_id = $1 AND store_id = $2',
      [tenant, store],
    );

    const write = (name, items) => {
      const text = `${JSON.stringify(items, null, 2)}\n`;
      fs.writeFileSync(path.join(OUT_DIR, name), text, 'utf8');
      return { file: name, count: items.length, sha256: sha256(text) };
    };
    const devFile = write('queries.dev.json', devSet);
    const validationFile = write('queries.validation.json', validationSet);

    const countByType = (items) =>
      items.reduce((acc, item) => ({ ...acc, [item.type]: (acc[item.type] ?? 0) + 1 }), {});
    const manifest = {
      generatedAt: new Date().toISOString(),
      seed,
      tenant,
      store,
      licence: '验证集冻结：改了 queries.validation.json 就必须重新生成并在这里记下新的 sha256。',
      catalogue: {
        spus: spus.length,
        skus: skuRows.rows.length,
        maxUpdatedAt: maxUpdated.rows[0].at,
        titleByIdSample: [...titleById.entries()].slice(0, 3),
      },
      dev: devFile,
      validation: validationFile,
      types: countByType(ordered),
      vocabulary: { colors: colors.length, sizes: sizes.length, phrases: phraseTargets.size },
      probes,
    };
    fs.writeFileSync(
      path.join(OUT_DIR, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    console.log(`SPU ${spus.length} / SKU ${skuRows.rows.length}`);
    console.log(
      `词候选探测 ${probes} 次，可用词 ${phraseTargets.size}，颜色词 ${colors.length}，尺码词 ${sizes.length}`,
    );
    console.log(`题池 ${ordered.length}：${JSON.stringify(countByType(ordered))}`);
    console.log(`开发集 ${devFile.count}（${devFile.sha256.slice(0, 12)}）`);
    console.log(`验证集 ${validationFile.count}（${validationFile.sha256.slice(0, 12)}）`);
    console.log(
      `例子：${ordered
        .slice(0, 5)
        .map((item) => `${item.type}:${item.query}`)
        .join(' | ')}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`generate-queries: ${error.message}`);
  process.exitCode = 1;
});
