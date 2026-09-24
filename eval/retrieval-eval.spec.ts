import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import {
  FetchEmbeddingHttpClient,
  FetchRerankHttpClient,
  applyRerankOrder,
  constrainRecallByAttribute,
  createHttpRerankProvider,
  createOllamaEmbeddingProvider,
  fuseRecall,
  KNOWLEDGE_FUSION_TOP,
  KNOWLEDGE_RERANK_CANDIDATES,
  normalizeColourValues,
  normalizeSizeValues,
  parseAppConfig,
  parseKnowledgeQuery,
  sliceAttributeValues,
  type AppConfig,
  type AttributeConstraint,
  type ConstrainedDimension,
  type EmbeddingProvider,
  type FusedRecallHit,
  type RecalledChunk,
  type RerankProvider,
} from '@kefu/core';
import { DatabaseService } from '../apps/api/src/database/database.service';
import { PostgresKnowledgeKeywordRecall } from '../apps/api/src/retrieval/postgres-knowledge-keyword-recall';
import { PostgresKnowledgeSemanticRecall } from '../apps/api/src/retrieval/postgres-knowledge-semantic-recall';

/**
 * 检索评测：拿**冻结的题集**量两件事，并把没命中的题归因到具体一步。
 *
 *   npm run eval:retrieval
 *
 * 为什么放在 `eval/` 而不是 `apps/api/test/`：这是一把**尺子**，不是门禁。
 * 它需要真模型服务、需要索引已经建完、要跑几分钟；塞进门禁只会得到一条
 * 「要么慢到没人信、要么在缺模型时自己跳过」的绿线。见 `vitest.eval.config.ts`。
 *
 * 量什么：
 *   1. **Top-5 命中率**（主口径：窄词，见下）：融合后的前五条切片里，有没有一条
 *      属于这道题的目标 SPU 集合。另外报 Top-1 / Top-3 和 precision@5。
 *   2. **错品率**：`1 - precision@5`。对「词 + 颜色/尺码」的题，另报一个更细的
 *      **颜色/尺码不符**：前五条里属于「同一款但另一个颜色」的那些 —— 顾客最常
 *      抱怨的就是这个，它和「完全不相干的商品」不是一回事，混在一起报等于把
 *      两种失败平均掉。
 *   3. **归因**：没进前五时，是「两条腿都没召回」（检索问题）还是「召回了但融合
 *      没排进前五」（排序问题）。这是计划书里「能定位到检索没召回还是融合排序错了」
 *      那一条，逐题一条记录写在报告里。
 *
 * **两条臂，同一次跑。** 2026-09-21 起，每道题同时算两个前五：`fused`（融合顺序）
 * 和 `reranked`（融合候选交给交叉编码器重排后）。两臂共享题面、共享两条腿、共享
 * 同一批候选，唯一的差别是最后排不排序——所以两个读数之差就是重排器的效果，而不是
 * 两次运行之间的索引或环境差异。**报告里 `reranker.configured` 为 false 时两臂必然
 * 逐字段相同**：那个零的意思是「没有重排器」，不是「重排器没用」，所以有断言在
 * 盯着它（配了就必须每题都跑成，且必须至少改过一道题的前五）。
 *
 * 量的是**融合层**，不是 HTTP 层：`POST /retrieval/suggestions` 的候选上限是 3，
 * 而且每次调用都会写 `suggestion_sets` 和审计行、还会叫一次大模型。评测不该为了
 * 一个数字往生产表里写两百条记录，也不该把大模型的随机性混进检索的读数。两条腿和
 * `fuseRecall` 都是纯函数/纯读，直接调它们。
 *
 * **量具自己的证伪**（不然「尺子坏了」和「检索好了」读数一模一样）：
 *   * 冻结校验：`queries.validation.json` 的 sha256 必须与 `manifest.json` 里记的一致。
 *   * 索引就绪：库里的嵌入覆盖率必须 ≥ 98%，否则直接判本次作废 —— 语义腿在索引没建完时
 *     是空的，那不叫「召回失败」，那叫「尺子还没做完」。
 *   * 校准题（`code`）：用**商品编码本身**当查询，编码字面就写在标题切片里，关键词腿
 *     必须召回。它要是都不召回，本次所有数字都不可信。
 */

const HERE = __dirname;
const REPORTS_DIR = path.join(HERE, 'reports');
/**
 * 仓库根的 `.env`，**必须自己载**。
 *
 * vitest 进程不是 API 也不是 Worker：那两个都在各自 bootstrap 里 `loadDotenv`，
 * 而测试进程不会 —— 不载的话 `config.embedding` 是空的，provider 建不出来，
 * 语义腿会静默地一条都不返回，读出来的「召回失败」全是环境。
 * 用 `.env` 里的模型而不是写死常量也是**有意的**：向量是按模型名存的，
 * 索引是用哪个模型建的，这里就必须用哪个，否则语义腿一条都查不回来。
 */
loadDotenv({ path: path.resolve(HERE, '..', '.env') });

/** 题集里的字段，与 `generate-queries.cjs` 写出来的形状一一对应。 */
type QueryRecord = {
  readonly id: string;
  readonly type: 'family' | 'color' | 'size' | 'code' | 'negation';
  readonly query: string;
  readonly targetSpus: ReadonlyArray<string>;
  readonly familySpus?: ReadonlyArray<string>;
  readonly value?: string;
  readonly dimension?: string;
  readonly negated?: string;
  readonly negatedSpus?: ReadonlyArray<string>;
  readonly band?: string;
  readonly note?: string;
};

/**
 * 一条臂：同一道题、同一次召回，**同一个前五**的口径。
 *
 * 三条臂共用题面、共用两条腿、共用索引——差别只有融合之后那一步。所以两个读数
 * 之间的差就是那一步的效果，而不是两次运行之间的环境差异。
 */
type ArmOutcome = {
  /** 前五切片按顺序去重成的 SPU 列表。 */
  readonly spus: ReadonlyArray<string>;
  readonly hit1: boolean;
  readonly hit3: boolean;
  readonly hit5: boolean;
  readonly precision5: number;
  /** 前五里「同一款、另一个颜色/尺码」的条数（只有 color/size 题有）。 */
  readonly sameFamilyOtherValue: number;
  /** 前五里带着被否定值的条数（只有 negation 题有）。 */
  readonly contaminated: number;
  /**
   * 前五里「切片自己写着的值 == 题面记着的值」的比例；题面没有值时是 null。
   *
   * 这是**严格口径**，也是唯一不被自己的判据抬着走的那一个。目标集的定义是
   * 「有该颜色 SKU 的 SPU」，与属性约束层读的是同一个事实，所以目标集口径下的
   * 提升可能是同构的自我实现。这一项不看目标集：它只问前五条切片自己是不是带着
   * 题面那个颜色，池子里没有正确颜色时它会掉，而属性过滤刷不动一个池子里没有的
   * 东西。
   */
  readonly ownValueShare: number | null;
};

/**
 * 臂的名字。三条臂是同一条链上的三个位置，不是三种算法：
 *
 *   * `fused` —— 融合之后直接取前五。重排器缺席时每一次都会拿到的答案。
 *   * `constrained` —— 融合之后先过属性约束、再重排、再取前五。**这是线上那条链**。
 *   * `reranked` —— 融合之后直接重排、再取前五。改动之前的那条链，留着是为了
 *     让这一跑里同时有两组对照：约束相对重排的增量，和重排相对融合的增量。
 */
type Arm = 'fused' | 'constrained' | 'reranked';

/** 一道题的读数：两条臂共用题面与召回，各自有一个前五。 */
type QueryOutcome = {
  readonly id: string;
  readonly type: string;
  readonly band: string;
  readonly query: string;
  readonly targetCount: number;
  readonly keywordSpus: number;
  readonly semanticSpus: number | null;
  readonly semanticUnavailable: string | null;
  readonly legRecallKeyword: boolean;
  readonly legRecallSemantic: boolean | null;
  /** 融合给出了多少条候选（重排器看得到的条数）。 */
  readonly candidateCount: number;
  readonly arms: Readonly<Record<Arm, ArmOutcome>>;
  /** 重排这一题为什么没跑成；跑成了就是 null。 */
  readonly rerankUnavailable: string | null;
  /**
   * 属性约束层对这一题做了什么。
   *
   * 候选列表本身不进报告——二十条切片的正文乘以 334 道题会把报告撑到没人能读，
   * 而且它就在 `arms.constrained` 的读数里。
   */
  readonly constraint: Omit<AttributeConstraint, 'hits'>;
  readonly verdict: string;
};

/**
 * 一条臂的前五读数，从它自己的切片列表算出来。
 *
 * **先切五条切片、再去重成 SPU**，顺序不能反：反过来的话，前五条切片里若有两条
 * 属于同一个 SPU，会从候选里再补一条进来，读数就变了。这里刻意保留「先切」，
 * 因为 2026-09-20 的基线（`color` 错品率 49.2%）就是这么算的——改口径会让新旧
 * 数字不可比，而这一轮要回答的正是「重排把 49.2% 打到了多少」。两条臂用同一条
 * 规则，所以臂与臂之间可比；规则本身没动，所以和基线也可比。
 *
 * **收的是 hit 而不是 chunk，这个签名是有意的。** 两条臂拿到的都是融合吐出来的
 * `FusedRecallHit[]`，切片在 `hit.chunk` 里。2026-09-21 这里曾经声明成
 * `ReadonlyArray<RecalledChunk>`，于是两个调用点把 hit 直接传了进来：`chunkToSpu`
 * 读 `hit.sourceKind` 得到 undefined，一个分支都不命中，**一声不响地**每道题都返回
 * 空的前五——334 道题的两条臂全部读到 0，而两条腿的召回读数照旧 98.9%，看上去像
 * 「检索召回了但排序没排进前五」。修好签名之后，调用点再传错就过不了类型检查。
 *
 * @param hits - 这条臂的候选，最好是排好的。
 * @returns 它的前五条切片所覆盖的 SPU，以及由这些 SPU 算出的各项读数。
 */
function armOf(
  hits: ReadonlyArray<FusedRecallHit>,
  target: ReadonlySet<string>,
  family: ReadonlySet<string>,
  negated: ReadonlySet<string>,
  skuToSpu: ReadonlyMap<string, string>,
  spuIds: ReadonlySet<string>,
  dimension: ConstrainedDimension | null,
  asked: ReadonlyArray<string>,
): ArmOutcome {
  const top = hits.slice(0, KNOWLEDGE_FUSION_TOP);
  const spus = spuOrder(
    top.map((hit) => hit.chunk),
    skuToSpu,
    spuIds,
  );
  const inTarget = spus.filter((id) => target.has(id)).length;
  return {
    spus,
    hit1: spus[0] !== undefined && target.has(spus[0]),
    hit3: spus.slice(0, 3).some((id) => target.has(id)),
    hit5: inTarget > 0,
    precision5: ratio(inTarget, spus.length),
    sameFamilyOtherValue: spus.filter((id) => family.has(id) && !target.has(id)).length,
    contaminated: spus.filter((id) => negated.has(id)).length,
    // 分母是前五**切片**数而不是前五条数：切片不足五条时这一项会掉，而那正是
    // 它要说的事之一（这一臂没有给出五条候选）。
    ownValueShare:
      dimension === null || asked.length === 0
        ? null
        : ratio(
            top.filter((hit) =>
              sliceAttributeValues(hit.chunk.content, dimension).some((value) =>
                asked.includes(value),
              ),
            ).length,
            top.length,
          ),
  };
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(HERE, name), 'utf8')) as T;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 切片 → 目标 SPU。标题切片直接是 SPU id，规格切片要先查回它的 SPU。 */
function chunkToSpu(
  chunk: RecalledChunk,
  skuToSpu: ReadonlyMap<string, string>,
  spuIds: ReadonlySet<string>,
): string | undefined {
  if (chunk.sourceKind === 'product' || chunk.sourceKind === 'product_spu') {
    return spuIds.has(chunk.sourceId) ? chunk.sourceId : undefined;
  }
  if (chunk.sourceKind === 'product_sku') {
    return skuToSpu.get(chunk.sourceId);
  }
  return undefined;
}

/** 按顺序去重成 SPU 列表（前五条切片可能来自同一个 SPU）。 */
function spuOrder(
  chunks: ReadonlyArray<RecalledChunk>,
  skuToSpu: ReadonlyMap<string, string>,
  spuIds: ReadonlySet<string>,
): string[] {
  const seen: string[] = [];
  const known = new Set<string>();
  for (const chunk of chunks) {
    const spu = chunkToSpu(chunk, skuToSpu, spuIds);
    if (spu === undefined || known.has(spu)) continue;
    known.add(spu);
    seen.push(spu);
  }
  return seen;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * 重排一题的候选，或者原样退回——并说明为什么退。
 *
 * 与 `RetrievalService.rerank` 是同一条决策：没配 provider 就静默退回，配了而失败
 * 就退回并**报出原因**。这里把原因带回读数里而不是打日志，因为尺子的职责是把
 * 「重排器没跑」和「重排器没帮上忙」区分开——两者读数完全相同，而一个是环境问题、
 * 一个是结论。排序规则本身在 `applyRerankOrder` 里，两份调用方共用同一份，
 * 所以这个函数里没有任何会被抄错的东西。
 */
async function rerankCandidates(
  provider: RerankProvider | undefined,
  query: string,
  hits: ReadonlyArray<FusedRecallHit>,
): Promise<{ hits: ReadonlyArray<FusedRecallHit>; unavailable: string | null }> {
  if (provider === undefined || hits.length === 0) {
    return { hits, unavailable: null };
  }
  const outcome = await provider.rerank(
    query,
    hits.map((hit) => hit.chunk.content),
  );
  if (!outcome.ok) {
    return { hits, unavailable: outcome.code };
  }
  return { hits: applyRerankOrder(hits, outcome.scores), unavailable: null };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

describe('检索评测（真实目录 + 真实模型服务）', () => {
  let config: AppConfig;
  let database: DatabaseService;
  let provider: EmbeddingProvider;
  /** 重排 provider；没配置就是 undefined，那时两条臂读数相同。 */
  let rerank: RerankProvider | undefined;
  let keywordRecall: PostgresKnowledgeKeywordRecall;
  let semanticRecall: PostgresKnowledgeSemanticRecall;
  let tenantId: string;
  let storeId: string;
  let skuToSpu: Map<string, string>;
  let spuIds: Set<string>;
  let manifest: {
    seed: number;
    validation: { sha256: string; count: number };
    dev: { sha256: string; count: number };
  };
  let coverage = { chunks: 0, embedded: 0 };
  const outcomes: QueryOutcome[] = [];

  beforeAll(async () => {
    const parsed = parseAppConfig({ ...process.env });
    if (parsed._tag !== 'ok') {
      throw new Error(`配置不可用: ${parsed.error.message}`);
    }
    config = parsed.config;
    tenantId = 'tenant-acme';
    storeId = 'store-acme-flagship';

    database = new DatabaseService(config);
    const built = createOllamaEmbeddingProvider(config.embedding, new FetchEmbeddingHttpClient());
    if (built === undefined) {
      // 空 provider 会让语义腿永远空着；那样量出来的不是检索，是环境。
      throw new Error(
        `未配置 embedding provider；检查 ${path.resolve(HERE, '..', '.env')} 的 EMBEDDING_BASE_URL / EMBEDDING_MODEL`,
      );
    }
    provider = built;
    // 与 API 的组装根同一条规则：两个变量任一为空就不绑定 provider。这里**不抛**，
    // 与 embedding 那段不同——重排器缺席时读路径仍然给出完整答案（融合顺序），
    // 所以尺子照样能跑，只是 `reranked` 那条臂等于 `fused`。真跑不起来时要能看出来，
    // 见下面那条「重排腿就绪」的断言。
    rerank = createHttpRerankProvider(config.rerank, new FetchRerankHttpClient());
    keywordRecall = new PostgresKnowledgeKeywordRecall(database);
    semanticRecall = new PostgresKnowledgeSemanticRecall(database, provider);

    const skus = await database.pool.query(
      'SELECT id, spu_id FROM product_skus WHERE tenant_id = $1 AND store_id = $2',
      [tenantId, storeId],
    );
    skuToSpu = new Map(skus.rows.map((row) => [String(row.id), String(row.spu_id)]));
    const spus = await database.pool.query(
      'SELECT id FROM product_spus WHERE tenant_id = $1 AND store_id = $2',
      [tenantId, storeId],
    );
    spuIds = new Set(spus.rows.map((row) => String(row.id)));

    const counted = await database.pool.query(
      `SELECT
         count(*) AS chunks,
         count(*) FILTER (WHERE index_status = 'indexed') AS indexed,
         count(emb.id) AS embedded
         FROM knowledge_chunks chunk
         LEFT JOIN knowledge_chunk_embeddings emb
           ON emb.chunk_id = chunk.id AND emb.embedding_model = $2
        WHERE chunk.tenant_id = $1`,
      [tenantId, config.embedding.model],
    );
    coverage = {
      chunks: Number(counted.rows[0].chunks),
      embedded: Number(counted.rows[0].embedded),
    };
  }, 300_000);

  afterAll(async () => {
    if (database !== undefined) {
      await database.onModuleDestroy();
    }
  });

  it('冻结校验：验证集与 manifest 记下的 sha256 一致', () => {
    manifest = readJson<typeof manifest>('manifest.json');
    const raw = readFileSync(path.join(HERE, 'queries.validation.json'), 'utf8');
    expect(sha256(raw)).toBe(manifest.validation.sha256);
  });

  it('索引就绪：嵌入覆盖率 ≥ 98%', () => {
    // 索引没建完时语义腿是空的，此时报出来的「命中率」量的是索引进度，不是检索。
    const cover = coverage.chunks === 0 ? 0 : coverage.embedded / coverage.chunks;
    expect(
      cover,
      `切片 ${coverage.chunks} 条，带 ${config.embedding.model} 向量 ${coverage.embedded} 条（${percent(cover)}）；先跑 scripts/backfill-index.cjs`,
    ).toBeGreaterThanOrEqual(0.98);
  });

  it(
    '跑完题集，写出可复现报告',
    async () => {
      const devSet = readJson<ReadonlyArray<QueryRecord>>('queries.dev.json');
      const validationSet = readJson<ReadonlyArray<QueryRecord>>('queries.validation.json');

      const runSet = async (records: ReadonlyArray<QueryRecord>): Promise<QueryOutcome[]> => {
        const results: QueryOutcome[] = [];
        for (const record of records) {
          const target = new Set(record.targetSpus);
          const family = new Set(record.familySpus ?? record.targetSpus);
          const negated = new Set(record.negatedSpus ?? []);
          const parsed = parseKnowledgeQuery({ text: record.query });
          const [keyword, semantic] = await Promise.all([
            keywordRecall.recall({ tenantId, storeId, query: parsed }),
            semanticRecall.recall({
              tenantId,
              storeId,
              text: record.query,
              negations: parsed.negations.map((negation) => negation.text),
            }),
          ]);
          // 融合到候选上限，两条臂共用这一份候选。候选集同时是「重排最多能救回
          // 多少」的上限：重排只能重排它拿到的东西，融合没给它的它看不见。
          const fused = fuseRecall({ keyword, semantic, limit: KNOWLEDGE_RERANK_CANDIDATES });
          // 属性约束层。线上那条链是 融合 → 约束 → 重排，`constrained` 这一臂和它
          // 逐字相同——尺子要是只量服务，量到的就是另一条链。
          //
          // 约束没动手时（题面没点出池子里的任何值，或者滤空了而兜底）两个列表是
          // **同一个对象**，这一臂直接复用重排读数：省一次白跑，也顺手把「没动手」
          // 证成同一份输入。
          const constraint = constrainRecallByAttribute({ hits: fused.hits, query: record.query });
          const reranked = await rerankCandidates(rerank, record.query, fused.hits);
          const constrained =
            constraint.hits === fused.hits
              ? reranked
              : await rerankCandidates(rerank, record.query, constraint.hits);

          const keywordSpus = spuOrder(
            keyword.map((hit) => hit.chunk),
            skuToSpu,
            spuIds,
          );
          const semanticSpus =
            semantic.unavailable === null
              ? spuOrder(
                  semantic.hits.map((hit) => hit.chunk),
                  skuToSpu,
                  spuIds,
                )
              : null;
          const legRecallKeyword = keywordSpus.some((id) => target.has(id));
          const legRecallSemantic =
            semanticSpus === null ? null : semanticSpus.some((id) => target.has(id));

          // 只有 color/size 题报「同款异值」；别的题型没有这个概念，传空集合让它
          // 恒为 0——与改动前的 `record.dimension === undefined ? 0 : ...` 等价。
          const sameFamilySet = record.dimension === undefined ? new Set<string>() : family;

          // 严格口径用的是**题集里冻结的那一格值**，不是约束层自己从池子里读出来的
          // 那个——两者独立，所以这一项不会因为约束层读对了就跟着变好。
          const dimension: ConstrainedDimension | null =
            record.dimension === undefined
              ? null
              : record.dimension === '颜色'
                ? 'color'
                : 'size';
          const askedValues =
            dimension === null
              ? []
              : dimension === 'color'
                ? normalizeColourValues(record.value ?? '')
                : normalizeSizeValues(record.value ?? '');

          const arms: Record<Arm, ArmOutcome> = {
            fused: armOf(
              fused.hits,
              target,
              sameFamilySet,
              negated,
              skuToSpu,
              spuIds,
              dimension,
              askedValues,
            ),
            constrained: armOf(
              constrained.hits,
              target,
              sameFamilySet,
              negated,
              skuToSpu,
              spuIds,
              dimension,
              askedValues,
            ),
            reranked: armOf(
              reranked.hits,
              target,
              sameFamilySet,
              negated,
              skuToSpu,
              spuIds,
              dimension,
              askedValues,
            ),
          };

          // 归因仍按融合那一层判：它说的是「检索有没有召回」和「排序有没有把召回的
          // 排进前五」。重排有没有把第二格里的题救回来，直接读两条臂的差，不必再
          // 写进 verdict——那会让同一条 verdict 在两条臂里意思不同。
          let verdict: string;
          if (arms.fused.hit5) {
            verdict = '命中';
          } else if (record.type === 'negation') {
            verdict = '否定题（只看污染）';
          } else if (legRecallKeyword || legRecallSemantic === true) {
            verdict = '融合排序：召回有、前五没有';
          } else if (semanticSpus === null) {
            verdict = '语义腿不可用';
          } else {
            verdict = '检索没召回：两条腿都没有';
          }

          results.push({
            id: record.id,
            type: record.type,
            band: record.band ?? '-',
            query: record.query,
            targetCount: target.size,
            keywordSpus: keywordSpus.length,
            semanticSpus: semanticSpus === null ? null : semanticSpus.length,
            semanticUnavailable: semantic.unavailable === null ? null : semantic.unavailable.code,
            legRecallKeyword,
            legRecallSemantic,
            candidateCount: fused.hits.length,
            arms,
            rerankUnavailable: reranked.unavailable,
            constraint: {
              mode: constraint.mode,
              asked: constraint.asked,
              negated: constraint.negated,
              dropped: constraint.dropped,
              applied: constraint.applied,
            },
            verdict,
          });
        }
        return results;
      };

      const dev = await runSet(devSet);
      const validation = await runSet(validationSet);
      outcomes.push(...dev, ...validation);

      const scored = validation.filter((row) => row.type !== 'negation');
      const scoredDev = dev.filter((row) => row.type !== 'negation');

      /**
       * 一条臂的汇总读数。
       *
       * `recalled` 是召回层的事实，与哪条臂无关，所以两条臂报同一个数——它是
       * 归因用的，不是臂的读数。其余每一项都取自这条臂自己的前五。
       */
      const score = (rows: ReadonlyArray<QueryOutcome>, arm: Arm) => {
        const arms = rows.map((row) => row.arms[arm]);
        /** 只对题面记着一个值的题算严格口径；其余题这一项是 null，不进分母。 */
        const valued = arms.filter((entry) => entry.ownValueShare !== null);
        return {
          n: rows.length,
          hit1: ratio(arms.filter((entry) => entry.hit1).length, arms.length),
          hit3: ratio(arms.filter((entry) => entry.hit3).length, arms.length),
          hit5: ratio(arms.filter((entry) => entry.hit5).length, arms.length),
          precision5:
            arms.length === 0
              ? 0
              : arms.reduce((sum, entry) => sum + entry.precision5, 0) / arms.length,
          /** 严格口径：前五切片里自身值就是题面值的平均比例。 */
          ownValueShare:
            valued.length === 0
              ? 0
              : valued.reduce((sum, entry) => sum + (entry.ownValueShare ?? 0), 0) / valued.length,
          ownValueN: valued.length,
          /** 前五里出现「同一款、另一个颜色/尺码」的题数。 */
          sameFamily: arms.filter((entry) => entry.sameFamilyOtherValue > 0).length,
          /** 前五里仍带着被否定值的题数。 */
          contaminated: arms.filter((entry) => entry.contaminated > 0).length,
          recalled: ratio(
            rows.filter((row) => row.legRecallKeyword || row.legRecallSemantic === true).length,
            rows.length,
          ),
        };
      };

      const byType = (rows: ReadonlyArray<QueryOutcome>, arm: Arm) => {
        const types = [...new Set(rows.map((row) => row.type))];
        return Object.fromEntries(
          types.map((type) => [type, score(rows.filter((row) => row.type === type), arm)]),
        );
      };
      const byBand = (rows: ReadonlyArray<QueryOutcome>, band: string, arm: Arm) =>
        score(rows.filter((row) => row.band === band), arm);
      /** 三条臂的整套读数，同一次跑、同一份候选。 */
      const bothArms = (rows: ReadonlyArray<QueryOutcome>) => ({
        fused: {
          validation: score(rows, 'fused'),
          validationNarrow: byBand(rows, 'narrow', 'fused'),
          validationBroad: byBand(rows, 'broad', 'fused'),
          byType: byType(rows, 'fused'),
        },
        constrained: {
          validation: score(rows, 'constrained'),
          validationNarrow: byBand(rows, 'narrow', 'constrained'),
          validationBroad: byBand(rows, 'broad', 'constrained'),
          byType: byType(rows, 'constrained'),
        },
        reranked: {
          validation: score(rows, 'reranked'),
          validationNarrow: byBand(rows, 'narrow', 'reranked'),
          validationBroad: byBand(rows, 'broad', 'reranked'),
          byType: byType(rows, 'reranked'),
        },
      });

      const controls = validation.filter((row) => row.type === 'code');
      const controlRecall = ratio(
        controls.filter((row) => row.legRecallKeyword).length,
        controls.length,
      );
      const all = [...dev, ...validation];
      const rerankFailures = all.filter((row) => row.rerankUnavailable !== null);
      const candidates = all.map((row) => row.candidateCount);
      // 前五的 SPU 列表在两条臂之间变了的题数。为零只有两种解释：重排器没接上，
      // 或者它是个恒等映射——两种都必须让这一跑作废，不然读数会被读成「重排没用」。
      const reordered = all.filter(
        (row) =>
          row.arms.fused.spus.join('|') !== row.arms.reranked.spus.join('|') ||
          row.arms.fused.hit5 !== row.arms.reranked.hit5,
      ).length;

      const report = {
        ranAt: new Date().toISOString(),
        tenantId,
        storeId,
        seed: manifest.seed,
        frozen: {
          validationSha256: manifest.validation.sha256,
          validationCount: manifest.validation.count,
          devSha256: manifest.dev.sha256,
          devCount: manifest.dev.count,
        },
        index: coverage,
        // 两条臂的对照条件，写在报告里而不是留给读者去猜：同一份题集、同一次召回、
        // 同一批候选，只差最后排不排序。`configured: false` 时两条臂必然逐字段相同，
        // 那时的差是零，而零的意思是「没装重排器」，不是「重排器没用」。
        reranker: {
          configured: rerank !== undefined,
          model: rerank?.model ?? null,
          candidateBound: KNOWLEDGE_RERANK_CANDIDATES,
          maxCandidatesSeen: candidates.length === 0 ? 0 : Math.max(...candidates),
          failedQueries: rerankFailures.length,
          failureCodes: [...new Set(rerankFailures.map((row) => row.rerankUnavailable))],
          reorderedQueries: reordered,
        },
        aggregate: bothArms(scored),
        aggregateDev: bothArms(scoredDev),
        // 约束这一跑到底动了几道题。「一道没动」而读数变了，说明变的是别的东西——
        // 与 `reorderedQueries` 同性质：先证明它在跑，再读它的效果。
        constraint: {
          queriesRead: all.filter((row) => row.constraint.mode !== 'none').length,
          queriesApplied: all.filter((row) => row.constraint.applied).length,
          candidatesDropped: all.reduce((sum, row) => sum + row.constraint.dropped, 0),
          named: all.filter((row) => row.constraint.mode === 'named').length,
          rejected: all.filter((row) => row.constraint.mode === 'rejected').length,
        },
        controls: { count: controls.length, keywordLegRecall: controlRecall },
        negation: {
          count: validation.filter((row) => row.type === 'negation').length,
          fusedContaminated: score(
            validation.filter((row) => row.type === 'negation'),
            'fused',
          ).contaminated,
          constrainedContaminated: score(
            validation.filter((row) => row.type === 'negation'),
            'constrained',
          ).contaminated,
          rerankedContaminated: score(
            validation.filter((row) => row.type === 'negation'),
            'reranked',
          ).contaminated,
        },
        verdicts: Object.fromEntries(
          [...new Set(scored.map((row) => row.verdict))].map((verdict) => [
            verdict,
            scored.filter((row) => row.verdict === verdict).length,
          ]),
        ),
        outcomes: all,
      };

      mkdirSync(REPORTS_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(REPORTS_DIR, `retrieval-eval-${stamp}.json`);
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

      const narrow = (arm: Arm) => byBand(scored, 'narrow', arm);
      const arrow = (fused: number, reranked: number) =>
        `${percent(fused)} → ${percent(reranked)}`;

      const lines: string[] = [];
      lines.push(
        `验证集 ${manifest.validation.count} 题（冻结 ${manifest.validation.sha256.slice(0, 12)}）`,
      );
      lines.push(
        report.reranker.configured
          ? `重排器 ${report.reranker.model}，每题最多 ${report.reranker.candidateBound} 条候选（实测最多见到 ${report.reranker.maxCandidatesSeen}），改了前五的 ${reordered} 题`
          : '重排器：未配置 —— 下面两条臂逐字段相同，这不是「重排没用」，是「没有重排器」',
      );
      lines.push('');
      lines.push(`  ${''.padEnd(10)}${'融合'.padStart(8)}${'重排'.padStart(12)}`);
      lines.push(
        `  ${'窄词 Top-1'.padEnd(10)}${percent(narrow('fused').hit1).padStart(8)}${percent(narrow('reranked').hit1).padStart(12)}`,
      );
      lines.push(
        `  ${'窄词 Top-3'.padEnd(10)}${percent(narrow('fused').hit3).padStart(8)}${percent(narrow('reranked').hit3).padStart(12)}`,
      );
      lines.push(
        `  ${'窄词 Top-5'.padEnd(10)}${percent(narrow('fused').hit5).padStart(8)}${percent(narrow('reranked').hit5).padStart(12)}`,
      );
      lines.push(
        `  ${'窄词错品率'.padEnd(9)}${percent(1 - narrow('fused').precision5).padStart(8)}${percent(1 - narrow('reranked').precision5).padStart(12)}`,
      );
      lines.push(
        `  ${'全部 Top-5'.padEnd(10)}${percent(score(scored, 'fused').hit5).padStart(8)}${percent(score(scored, 'reranked').hit5).padStart(12)}`,
      );
      lines.push(
        `  ${'宽词 Top-5'.padEnd(10)}${percent(byBand(scored, 'broad', 'fused').hit5).padStart(8)}${percent(byBand(scored, 'broad', 'reranked').hit5).padStart(12)}`,
      );
      lines.push('');
      for (const [type, fused] of Object.entries(byType(scored, 'fused'))) {
        const reranked = byType(scored, 'reranked')[type];
        if (reranked === undefined) {
          // 两条臂的题型键集来自同一批题，缺一个只能是这里写错了，不是数据。
          throw new Error(`重排臂缺少题型 ${type}`);
        }
        lines.push(
          `  ${type.padEnd(9)} n=${String(fused.n).padStart(3)}  Top-5 ${arrow(fused.hit5, reranked.hit5).padEnd(20)} 错品率 ${arrow(1 - fused.precision5, 1 - reranked.precision5)}  两条腿召回 ${percent(fused.recalled)}`,
        );
      }
      lines.push('');
      lines.push(
        `  同款异值题数（越小越好） ${score(scored, 'fused').sameFamily} → ${score(scored, 'constrained').sameFamily} → ${score(scored, 'reranked').sameFamily}`,
      );
      lines.push(
        `  否定题 ${report.negation.count} 题，前五仍带被否定值 ${report.negation.fusedContaminated} → ${report.negation.constrainedContaminated} → ${report.negation.rerankedContaminated} 题`,
      );

      // 属性约束层单独一块。左边是改动之前那条链（直接重排），右边是线上那条链
      // （先约束再重排），所以每一行读出来都是「这一层值了多少」。**先看「动了多少
      // 题」再看读数**：一条一道题都没动的约束，和一条每题都动、读数照旧的约束，
      // 是两件完全不同的事。
      const strict = (row: { ownValueShare: number; ownValueN: number }) =>
        `严格 ${percent(row.ownValueShare)}（n=${row.ownValueN}）`;
      lines.push('');
      lines.push('  属性约束层（线上那条链：融合 → 约束 → 重排；左边是改动前的链）');
      lines.push(
        `    读到值的 ${report.constraint.queriesRead} 题，真动手的 ${report.constraint.queriesApplied} 题，丢掉候选 ${report.constraint.candidatesDropped} 条（点名 ${report.constraint.named} / 排除 ${report.constraint.rejected}）`,
      );
      lines.push(
        `    窄词 Top-1 ${arrow(narrow('reranked').hit1, narrow('constrained').hit1)}   错品率 ${arrow(1 - narrow('reranked').precision5, 1 - narrow('constrained').precision5)}`,
      );
      for (const [type, before] of Object.entries(byType(scored, 'reranked'))) {
        const after = byType(scored, 'constrained')[type];
        if (after === undefined) {
          throw new Error(`约束臂缺少题型 ${type}`);
        }
        lines.push(
          `    ${type.padEnd(9)} n=${String(before.n).padStart(3)} Top-1 ${arrow(before.hit1, after.hit1)} Top-5 ${arrow(before.hit5, after.hit5)} 错品率 ${arrow(1 - before.precision5, 1 - after.precision5)}`,
        );
        lines.push(`    ${' '.padEnd(9)}        ${strict(before)} → ${strict(after)}`);
      }
      lines.push(`  校准（编码题）${controls.length} 题，关键词腿召回 ${percent(controlRecall)}`);
      lines.push(`  归因（融合臂）: ${JSON.stringify(report.verdicts)}`);
      lines.push(`  报告: ${file}`);

      // 量具自己的证伪：校准题靠关键词腿的字面匹配，编码就写在切片文本里。
      // 它要都不召回，本次的所有数字都不必读。
      expect(
        controlRecall,
        `校准题（编码查询）关键词腿只召回 ${percent(controlRecall)} —— 先查索引与题集，别读下面的数字`,
      ).toBeGreaterThanOrEqual(0.9);
      // 「一道都没命中」不是结果，是故障。
      expect(score(scored, 'fused').hit5).toBeGreaterThan(0);
      // 候选确实扩到了融合前五之外 —— 不然重排器只看得到五个位子，
      // `KNOWLEDGE_RERANK_CANDIDATES` 就没有生效。
      expect(
        report.reranker.maxCandidatesSeen,
        '每题候选一直不超过融合前五：KNOWLEDGE_RERANK_CANDIDATES 没接上',
      ).toBeGreaterThan(KNOWLEDGE_FUSION_TOP);
      if (report.reranker.configured) {
        // 配了就必须每条都跑成。有失败时 `reranked` 那条臂是融合顺序的复制品，
        // 它报出来的「没变化」是环境的，不是结论的。
        expect(
          report.reranker.failedQueries,
          `重排器配了但有 ${report.reranker.failedQueries} 题没跑成（${JSON.stringify(report.reranker.failureCodes)}）—— 本次重排臂的数字作废`,
        ).toBe(0);
        // 一条都没改过顺序 = 没接上，或者接上了一个恒等映射。
        expect(
          report.reranker.reorderedQueries,
          '重排器一条前五都没改过：要么没接上，要么它是个恒等映射',
        ).toBeGreaterThan(0);
      }
      // 报告本身要在存在，且是这次跑出来的。
      expect(report.aggregate.fused.validation.n).toBe(scored.length);
      console.log(lines.join('\n'));
    },
    30 * 60_000,
  );
});
