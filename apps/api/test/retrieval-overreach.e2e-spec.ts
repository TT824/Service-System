import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAppConfig, type EmbeddingProvider } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';
import { EMBEDDING_PROVIDER } from '../src/retrieval/retrieval.module';
import {
  insertKnowledgeTerms,
  isDatabaseReachable,
  openDatabaseClient,
  resolveDatabaseUrl,
} from './database-test-support';

/**
 * The authorization surface of the suggestion path, against the real database.
 *
 * SDD-014's fifth acceptance clause — *no cross-tenant and no cross-store
 * retrieval* — is the one hard safety rule of the block that built the two-lane
 * read, and this suite is its evidence. It drives `POST
 * retrieval/suggestions` over HTTP rather than calling the service, because the
 * member and tenant the request carries are part of what is being tested.
 *
 * **Three predicates stand between a question and another tenant's knowledge,
 * and this suite attacks each one separately.**
 *
 *   1. `knowledge_chunks.tenant_id` in both recall legs' `scoped` CTE;
 *   2. `scope_type = 'tenant' OR store_id = $2`, in the same CTE — the store
 *      rule, which must also let a merchant-level slice through;
 *   3. the tenant-scoped source read-back in `retrieval.service.ts`, plus its
 *      store check, which is the *last* line and the only one that can turn a
 *      recalled slice into an answer.
 *
 * That ordering is why the injections below look asymmetric. Neutralising a
 * **leg** predicate cannot put another tenant's text in the response — the
 * read-back refuses it either way — so a leg injection is made observable the
 * only way it is observable: the foreign slices take the fused Top 5 and the
 * tenant's own slice is displaced out of its own answer. Neutralising the
 * **read-back** predicate is observable directly: the text lands in a candidate.
 * Both are the same harm at different depths, and a suite that only tested one
 * of them would be green while half the surface was open.
 *
 * **The fixtures bring their own tenant.** `knowledge-index-status.e2e-spec.ts`
 * asserts in its own `beforeAll` that `tenant-acme` and `tenant-beta` hold no
 * slices at all, so a suite that writes slices for those tenants is a suite that
 * fails depending on file order. Nothing here touches them.
 *
 * **Queries are made of one ASCII token and one Chinese word, per case.** The
 * keyword leg's fuzzy half is `content ILIKE '%term%'`, so a token is the only
 * reliable way to aim it; each case's token and word appear in that case's
 * fixtures and nowhere else, which is what keeps the cases from reading each
 * other's rows. The displacement cases additionally order by slice id — the
 * statement's own tie-break, `ORDER BY score DESC, id` — so the slices that must
 * lose are given ids that sort *before* the slice that must survive.
 */
const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Per-run suffix: every row this suite writes carries it, and all are removed. */
const RUN = randomUUID().slice(0, 8);

/**
 * The suite's own tenant, with two stores.
 *
 * A dedicated tenant keeps this suite's fixtures out of the two tenants the
 * sibling suites assert on, and makes cleanup one cascade instead of a list.
 */
const TENANT = `tenant-ov-${RUN}`;
/** The neighbour whose slices must never answer this tenant's questions. */
const FOREIGN_TENANT = `tenant-fo-${RUN}`;
/** The answering store, and the second store whose knowledge must stay out. */
const STORE_X = `store-ov-x-${RUN}`;
const STORE_Y = `store-ov-y-${RUN}`;
/** One conversation in store X: the whole suite asks questions in it. */
const CONVERSATION = `conversation-ov-${RUN}`;

/**
 * The identity the requests act through.
 *
 * `u-platform-admin` is the seeded platform administrator: its member has no
 * tenant of its own, so the tenant scope comes from `x-tenant-id` and can point
 * at a tenant this suite created. An agent would have to exist inside the tenant
 * and would be narrowed to one store, which is a second variable in a suite that
 * is about exactly one boundary at a time.
 */
const PLATFORM_ADMIN = 'u-platform-admin';

const SUGGESTIONS_URL = '/api/v1/retrieval/suggestions';

/** The model name the stub reports, and the one the stored vectors are filed under. */
const EMBEDDING_MODEL = `ov-e2e-embedding-${RUN}`;
/**
 * The cases whose slices carry a vector, each owning one dimension.
 *
 * The stub answers a question with the vector of the case that question belongs
 * to, so a slice sits at distance 0 from its own case's questions and at `√2`
 * from every other case's. That is not a relevance rule — the semantic leg has
 * none, and returns whatever the model server hands it — but it does put each
 * case's own slices at the head of its own answer, which is what keeps three
 * cases with vectors from deciding each other's fused Top 5. Without it, every
 * vector-bearing slice in the tenant competes for every question, and a case
 * would pass or fail on the alphabetical order of another case's slice ids.
 */
const VECTOR_CASES: ReadonlyArray<string> = ['ovqb', 'ovqj', 'ovqh'];
const VECTOR_DIMENSIONS = VECTOR_CASES.length;
/** One case's vector, in the text form the index writer stores one in. */
const vectorLiteral = (index: number): string =>
  `[${VECTOR_CASES.map((_, at) => (at === index ? 1 : 0)).join(',')}]`;
/** Every slice carries the same hash, so the stored vectors are never stale. */
const CONTENT_HASH = `hash-ov-${RUN}`;

/**
 * Whether the stub provider answers or reports itself down.
 *
 * `down` is the default, and it is the honest one: it is what a deployment with
 * no model configured, or a model server that stopped answering, looks like to
 * the semantic leg. Only the cases that need a *live* semantic leg set it to
 * `ok`, and the state is reset before every case so no case inherits it.
 */
type EmbeddingMode = 'ok' | 'down';
let embeddingMode: EmbeddingMode = 'down';

/**
 * The embedding provider this suite binds in place of the deployment's.
 *
 * It is a stub for the same reason the worker's sweep suite uses one: the
 * question being asked is about the *predicate* the semantic leg applies, and a
 * real model server would make the answer depend on a network hop and on the
 * numbers it produced. Its vectors are the case-keyed ones {@link VECTOR_CASES}
 * describes, so a slice is nearest to its own case's question and the fixture
 * can place it exactly where the case needs it.
 */
const embeddingProvider: EmbeddingProvider = {
  model: EMBEDDING_MODEL,
  embed: async (text: string) => {
    if (embeddingMode !== 'ok') {
      return { ok: false, code: 'model_server_down', reason: 'the overreach stub is told to fail' };
    }
    const found = VECTOR_CASES.findIndex((token) => text.includes(token));
    const index = found === -1 ? 0 : found;
    return { ok: true, vector: VECTOR_CASES.map((_, at) => (at === index ? 1 : 0)) };
  },
};

/** One FAQ row, as this suite writes it. */
type FaqFixture = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly question: string;
  readonly answer: string;
};

/** One shortcut row. A merchant-level phrase has no store of its own. */
type ShortcutFixture = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly scopeType: 'tenant' | 'store';
  readonly title: string;
  readonly content: string;
};

/** One slice row, and whether a vector is stored for it. */
type ChunkFixture = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly sourceKind: 'faq' | 'faq_variant' | 'shortcut';
  readonly sourceId: string;
  readonly content: string;
  readonly sourceField?: string;
  readonly chunkType?: string;
  readonly chunkIndex?: number;
  /** The case this slice is embedded for, if a vector row is stored for it. */
  readonly embeddedFor?: string;
};

/** A slice id whose sort position is part of the fixture — see the module note. */
const chunkId = (prefix: string, label: string): string => `kchunk-${prefix}-${RUN}-${label}`;
/** The slice that must survive each displacement case: it sorts last, on purpose. */
const survivorChunk = (label: string): string => chunkId('ov-z', label);
/** Five slices that must not be recalled, or must not displace the survivor. */
const displacerChunks = (prefix: string, label: string): ReadonlyArray<string> =>
  [1, 2, 3, 4, 5].map((index) => chunkId(prefix, `${label}-${index}`));

const faqId = (label: string): string => `faq-ov-${RUN}-${label}`;
const foreignFaqId = (label: string): string => `faq-fo-${RUN}-${label}`;
const shortcutKey = (label: string): string => `shortcut-ov-${RUN}-${label}`;
const foreignShortcutKey = (label: string): string => `shortcut-fo-${RUN}-${label}`;

/**
 * The tenant-level phrase of the *other* tenant, which case 3 aims at.
 *
 * It is merchant-level on purpose: the read-back's store check passes a phrase
 * that names no store, so the tenant predicate of the read is the only thing
 * between it and this tenant's answer.
 */
const FOREIGN_SHORTCUT_TITLE = 'ovqe 运费规则（外部租户）';

const FAQS: ReadonlyArray<FaqFixture> = [
  // Case 1a/1b: the tenant's own answers, and the foreign ones that must not replace them.
  {
    id: faqId('case1a'),
    tenantId: TENANT,
    storeId: STORE_X,
    question: 'ovqa 退货政策',
    answer: 'ovqa 支持七天无理由退货。',
  },
  {
    id: faqId('case1b'),
    tenantId: TENANT,
    storeId: STORE_X,
    question: 'ovqb 尺码怎么选',
    answer: 'ovqb 版型偏大，建议按小一码选择。',
  },
  // Case 2b: one answer in the asking store, five in the other one.
  {
    id: faqId('case2b'),
    tenantId: TENANT,
    storeId: STORE_X,
    question: 'ovqd 门店自提',
    answer: 'ovqd 自提需提前预约。',
  },
  ...[1, 2, 3, 4, 5].map((index): FaqFixture => ({
    id: faqId(`case2b-${index}`),
    tenantId: TENANT,
    storeId: STORE_Y,
    question: `ovqd 门店自提（${index}店）`,
    answer: `ovqd 自提说明第 ${index} 条。`,
  })),
  // Case 2c: the semantic leg's store rule. One FAQ per store again, because
  // the point is the same — the other store's slices are in this tenant and are
  // refused by the store half of the scope rule, not by the tenant half.
  {
    id: faqId('case2c-x'),
    tenantId: TENANT,
    storeId: STORE_X,
    question: 'ovqj 现货说明',
    answer: 'ovqj 现货充足，下单后当天发出。',
  },
  {
    id: faqId('case2c-y'),
    tenantId: TENANT,
    storeId: STORE_Y,
    question: 'ovqj 现货说明（另一店）',
    answer: 'ovqj 另一店的现货说明。',
  },
  // Case 4: one FAQ per store, so the store check has something to refuse.
  {
    id: faqId('case4-x'),
    tenantId: TENANT,
    storeId: STORE_X,
    question: 'ovqf 保修期限',
    answer: 'ovqf 本店保修两年。',
  },
  {
    id: faqId('case4-y'),
    tenantId: TENANT,
    storeId: STORE_Y,
    question: 'ovqf 保修期限（另一店）',
    answer: 'ovqf 另一店保修一年。',
  },
  // Case 3, second source kind: another tenant's FAQ, carrying *this* tenant's
  // store. The row is contradictory — `faqs` has one foreign key to `tenants`
  // and another to `stores`, and nothing ties the two — and it is here because
  // it is the only shape that makes the read-back's tenant predicate falsifiable:
  // with the store in this tenant, the store check below it cannot answer for a
  // missing tenant predicate, so the tenant predicate is all that stands between
  // this tenant's agent and another tenant's answer.
  {
    id: foreignFaqId('case3'),
    tenantId: FOREIGN_TENANT,
    storeId: STORE_X,
    question: 'ovqe 运费规则（外部租户）',
    answer: 'ovqe 外部租户的运费规则，不属于本租户。',
  },
  // Case 5: the answer that must survive a dead semantic leg.
  {
    id: faqId('case5'),
    tenantId: TENANT,
    storeId: STORE_X,
    question: 'ovqg 物流时效',
    answer: 'ovqg 48 小时内发出。',
  },
  // Case 6: one question whose two slices must become one candidate.
  {
    id: faqId('case6'),
    tenantId: TENANT,
    storeId: STORE_X,
    question: 'ovqh 换货流程',
    answer: 'ovqh 支持七天内换货。',
  },
];

const SHORTCUTS: ReadonlyArray<ShortcutFixture> = [
  // Case 2a: merchant-level, so the store rule has to let it through.
  {
    id: shortcutKey('case2a'),
    tenantId: TENANT,
    storeId: null,
    scopeType: 'tenant',
    title: 'ovqc 发票说明',
    content: 'ovqc 支持开具增值税普通发票。',
  },
  // Case 3: this tenant's own phrase, and the foreign one of the same shape.
  {
    id: shortcutKey('case3'),
    tenantId: TENANT,
    storeId: null,
    scopeType: 'tenant',
    title: 'ovqe 运费说明',
    content: 'ovqe 满 99 包邮。',
  },
  {
    id: foreignShortcutKey('case3'),
    tenantId: FOREIGN_TENANT,
    storeId: null,
    scopeType: 'tenant',
    title: FOREIGN_SHORTCUT_TITLE,
    content: 'ovqe 外部租户的运费规则，不属于本租户。',
  },
];

const CHUNKS: ReadonlyArray<ChunkFixture> = [
  // --- Case 1a: the keyword leg's tenant predicate. The five foreign slices
  // sort before this tenant's own, so losing the predicate costs the answer.
  {
    id: survivorChunk('case1a'),
    tenantId: TENANT,
    storeId: STORE_X,
    sourceKind: 'faq',
    sourceId: faqId('case1a'),
    content: 'ovqa 退货政策：支持七天无理由退货。',
  },
  ...displacerChunks('fo', 'case1a').map((id, index): ChunkFixture => ({
    id,
    tenantId: FOREIGN_TENANT,
    storeId: null,
    sourceKind: 'faq',
    sourceId: foreignFaqId(`case1a-${index + 1}`),
    content: `ovqa 退货政策：外部租户第 ${index + 1} 条。`,
  })),
  // --- Case 1b: the semantic leg's tenant predicate. Neither side's content
  // shares a word with the question, so the keyword leg answers nothing and the
  // semantic leg is the only way in — which is what makes its predicate the one
  // under test. Both sides carry a vector.
  {
    id: survivorChunk('case1b'),
    tenantId: TENANT,
    storeId: STORE_X,
    sourceKind: 'faq',
    sourceId: faqId('case1b'),
    content: '版型偏大，建议按小一码选择。',
    embeddedFor: 'ovqb',
  },
  ...displacerChunks('fo', 'case1b').map((id, index): ChunkFixture => ({
    id,
    tenantId: FOREIGN_TENANT,
    storeId: null,
    sourceKind: 'faq',
    sourceId: foreignFaqId(`case1b-${index + 1}`),
    content: `外部租户第 ${index + 1} 条版型说明。`,
    embeddedFor: 'ovqb',
  })),
  // --- Case 2c: the semantic leg's store rule, which is a second copy of the
  // rule the keyword leg applies. Same shape as 1b — no word in common with the
  // question — so the semantic leg is again the only way in, and this time what
  // is being asked is whether the store half of its `scoped` CTE holds.
  {
    id: survivorChunk('case2c'),
    tenantId: TENANT,
    storeId: STORE_X,
    sourceKind: 'faq',
    sourceId: faqId('case2c-x'),
    // Deliberately wordless: neither `ovqj` nor 现货 appears here, so the keyword
    // leg answers nothing for this question and the semantic leg's store rule is
    // the only thing the case measures. A slice that shares a word would be found
    // by the keyword leg as well, and its evidence would keep it in the answer
    // even after the semantic leg's own answer had displaced it.
    content: '下单后当天发出，库存实时同步。',
    embeddedFor: 'ovqj',
  },
  ...[1, 2, 3, 4, 5].map((index): ChunkFixture => ({
    id: chunkId('ov-y', `case2c-${index}`),
    tenantId: TENANT,
    storeId: STORE_Y,
    sourceKind: 'faq',
    sourceId: faqId(`case2c-y`),
    content: `另一店的现货说明第 ${index} 条。`,
    chunkIndex: index,
    embeddedFor: 'ovqj',
  })),
  // --- Case 2a: a merchant-level phrase, reachable only while the scope rule
  // keeps its `scope_type = 'tenant'` half.
  {
    id: chunkId('ov', 'case2a'),
    tenantId: TENANT,
    storeId: null,
    sourceKind: 'shortcut',
    sourceId: shortcutKey('case2a'),
    content: 'ovqc 发票说明：支持开具增值税普通发票。',
  },
  // --- Case 2b: the other store's five slices, and this store's one.
  ...displacerChunks('ov-y', 'case2b').map((id, index): ChunkFixture => ({
    id,
    tenantId: TENANT,
    storeId: STORE_Y,
    sourceKind: 'faq',
    sourceId: faqId(`case2b-${index + 1}`),
    content: `ovqd 自提说明：另一店第 ${index + 1} 条。`,
  })),
  {
    id: survivorChunk('case2b'),
    tenantId: TENANT,
    storeId: STORE_X,
    sourceKind: 'faq',
    sourceId: faqId('case2b'),
    content: 'ovqd 自提说明：本店需提前预约。',
  },
  // --- Case 3: the read-back's tenant predicate. A slice of *this* tenant
  // pointing at a source id that belongs to the neighbour — `source_id` is
  // polymorphic text with no foreign key (`0011`), so the slice table cannot
  // refuse to hold it, and the read that follows is where it has to be refused.
  {
    id: chunkId('ov', 'case3-foreign'),
    tenantId: TENANT,
    storeId: STORE_X,
    sourceKind: 'shortcut',
    sourceId: foreignShortcutKey('case3'),
    content: 'ovqe 运费说明：外部租户的话术。',
  },
  {
    id: chunkId('ov', 'case3-own'),
    tenantId: TENANT,
    storeId: STORE_X,
    sourceKind: 'shortcut',
    sourceId: shortcutKey('case3'),
    content: 'ovqe 运费说明：满 99 包邮。',
  },
  // The same attack through the other reader: a slice of this tenant naming
  // another tenant's FAQ, whose row carries this tenant's store.
  {
    id: chunkId('ov', 'case3-foreign-faq'),
    tenantId: TENANT,
    storeId: STORE_X,
    sourceKind: 'faq',
    sourceId: foreignFaqId('case3'),
    content: 'ovqe 运费说明：外部租户的常见问题。',
  },
  // --- Case 4: the read-back's store check. A merchant-level slice naming a
  // store's FAQ is a contradictory row — the indexer derives a slice's scope
  // from its source — and the store check is the only thing that refuses it:
  // the slice itself is in scope, and its source is in this tenant.
  {
    id: chunkId('ov', 'case4-tenant'),
    tenantId: TENANT,
    storeId: null,
    sourceKind: 'faq',
    sourceId: faqId('case4-y'),
    content: 'ovqf 保修说明：另一店保修一年。',
  },
  {
    id: chunkId('ov', 'case4-store'),
    tenantId: TENANT,
    storeId: STORE_X,
    sourceKind: 'faq',
    sourceId: faqId('case4-x'),
    content: 'ovqf 保修说明：本店保修两年。',
  },
  // --- Case 5: one answer, asked while the semantic leg is down.
  {
    id: chunkId('ov', 'case5'),
    tenantId: TENANT,
    storeId: STORE_X,
    sourceKind: 'faq',
    sourceId: faqId('case5'),
    content: 'ovqg 物流说明：48 小时内发出。',
  },
  // --- Case 6: two slices of one FAQ. The indexer writes a question slice and
  // an answer slice per FAQ; both are recalled, and the buyer is owed one entry.
  {
    id: chunkId('ov-x', 'case6-0'),
    tenantId: TENANT,
    storeId: STORE_X,
    sourceKind: 'faq',
    sourceId: faqId('case6'),
    content: 'ovqh 换货说明：支持七天内换货。',
    sourceField: 'question',
    chunkType: 'question',
    chunkIndex: 0,
    embeddedFor: 'ovqh',
  },
  {
    id: chunkId('ov-x', 'case6-1'),
    tenantId: TENANT,
    storeId: STORE_X,
    sourceKind: 'faq',
    sourceId: faqId('case6'),
    content: 'ovqh 换货流程：联系客服登记。',
    sourceField: 'answer',
    chunkType: 'answer',
    chunkIndex: 1,
    embeddedFor: 'ovqh',
  },
];

/** One candidate as the endpoint serializes it. */
type Candidate = {
  readonly sourceId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly kind: string;
  readonly title: string;
  readonly content: string;
  readonly rank: number;
};

/** The suggestion set as the endpoint serializes it. */
type SuggestSet = {
  readonly candidates: ReadonlyArray<Candidate>;
  readonly fallbackReasons: ReadonlyArray<string>;
};

const sourceIdsOf = (set: SuggestSet): ReadonlyArray<string> =>
  set.candidates.map((candidate) => candidate.sourceId);

const candidatesOf = (set: SuggestSet, sourceId: string): ReadonlyArray<Candidate> =>
  set.candidates.filter((candidate) => candidate.sourceId === sourceId);

describe.skipIf(!reachable)('Retrieval overreach (interface)', () => {
  let app: INestApplication;
  let client: Client;

  beforeAll(async () => {
    // `local` selects the PostgreSQL platform repository; `test` would serve the
    // in-process store, whose slices are always empty.
    const parsed = parseAppConfig({
      ...process.env,
      APP_ENV: 'local',
      // Refused by default in a production-shaped environment: this suite acts
      // as a platform administrator reading a tenant that is not its own.
      AUTH_DEMO_IDENTITY_HEADERS: 'true',
      // Pinned to blank so this suite never binds a generation provider. It
      // spreads `process.env`, and a developer who exports their real key would
      // otherwise have every `suggest()` in this file reach a live API — slow,
      // metered, and measuring the environment rather than the authorization
      // rules the suite is about. Generation has its own suite.
      DEEPSEEK_API_KEY: '',
    });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }

    client = await openDatabaseClient(databaseUrl);
    await seedFixtures(client);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    })
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(embeddingProvider)
      .compile();
    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);
  });

  afterAll(async () => {
    const tenants = [TENANT, FOREIGN_TENANT];
    // Explicit in dependency order rather than leaning on the cascade: a table
    // that gained a `RESTRICT` would turn cleanup into a mystery failure.
    for (const statement of [
      'DELETE FROM knowledge_chunk_terms WHERE tenant_id = ANY($1)',
      'DELETE FROM knowledge_chunk_embeddings WHERE tenant_id = ANY($1)',
      'DELETE FROM knowledge_chunk_keywords WHERE tenant_id = ANY($1)',
      'DELETE FROM knowledge_chunks WHERE tenant_id = ANY($1)',
      'DELETE FROM faqs WHERE tenant_id = ANY($1)',
      'DELETE FROM shortcuts WHERE tenant_id = ANY($1)',
      'DELETE FROM conversations WHERE tenant_id = ANY($1)',
      'DELETE FROM stores WHERE tenant_id = ANY($1)',
      'DELETE FROM tenants WHERE id = ANY($1)',
    ]) {
      await client.query(statement, [tenants]);
    }

    // The suite's own contract: it leaves nothing behind, so the day's slice
    // tables are back to what they were before it ran. Both halves are asserted
    // because they fail differently — the first means this suite leaked, the
    // second means some suite's rows are still in a table another suite counts.
    const leftovers = await client.query<{ total: string }>(
      `SELECT (SELECT count(*) FROM knowledge_chunks WHERE id LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM knowledge_chunk_keywords WHERE tenant_id LIKE 'tenant-%-' || $1)
            + (SELECT count(*) FROM knowledge_chunk_embeddings WHERE id LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM knowledge_chunk_terms WHERE tenant_id LIKE 'tenant-%-' || $1)
            AS total`,
      [RUN],
    );
    expect(leftovers.rows[0]?.total, `rows carrying this run's suffix ${RUN}`).toBe('0');

    const global = await client.query<{
      chunks: string;
      keywords: string;
      embeddings: string;
      terms: string;
    }>(
      `SELECT (SELECT count(*) FROM knowledge_chunks) AS chunks,
              (SELECT count(*) FROM knowledge_chunk_keywords) AS keywords,
              (SELECT count(*) FROM knowledge_chunk_embeddings) AS embeddings,
              (SELECT count(*) FROM knowledge_chunk_terms) AS terms`,
    );
    expect(global.rows[0], 'the slice tables are empty between suites').toEqual({
      chunks: '0',
      keywords: '0',
      embeddings: '0',
      terms: '0',
    });
    await client.end();

    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  beforeEach(() => {
    embeddingMode = 'down';
  });

  /**
   * Ask one question in store X, as the platform administrator reading this
   * suite's tenant.
   *
   * @param query - The buyer's question.
   * @returns The persisted set, as the endpoint serialized it.
   */
  async function suggest(query: string): Promise<SuggestSet> {
    const response = await request(app.getHttpServer())
      .post(SUGGESTIONS_URL)
      .set('x-member-id', PLATFORM_ADMIN)
      .set('x-tenant-id', TENANT)
      .send({ conversationId: CONVERSATION, query })
      .expect(201);
    return (response.body as { data: SuggestSet }).data;
  }

  /**
   * The assertion every case makes first, and the one no injection in any other
   * case may break: not one candidate may be another tenant's.
   *
   * @param set - The answer to inspect.
   */
  function expectNoForeignCandidate(set: SuggestSet): void {
    expect(set.candidates.filter((candidate) => candidate.tenantId !== TENANT)).toEqual([]);
  }

  it('answers with the tenant’s own slice when the neighbour holds five that match better', async () => {
    // The five foreign slices carry the question's token and word, score the
    // same as this tenant's slice, and sort before it; the fused list keeps five.
    const set = await suggest('ovqa 退货');
    expectNoForeignCandidate(set);
    expect(sourceIdsOf(set)).toContain(faqId('case1a'));
    expect(set.candidates.every((candidate) => !candidate.sourceId.includes('faq-fo-'))).toBe(true);
  });

  it('answers with the tenant’s own slice when the semantic leg is the only one that can find it', async () => {
    // No word is shared between the question and either side's slices, so the
    // keyword leg returns nothing at all: every slice below is reached by the
    // semantic leg or not at all.
    embeddingMode = 'ok';
    const set = await suggest('ovqb 尺码');
    expectNoForeignCandidate(set);
    expect(sourceIdsOf(set)).toContain(faqId('case1b'));
    expect(set.candidates.every((candidate) => !candidate.sourceId.includes('faq-fo-'))).toBe(true);
  });

  it('keeps a merchant-level slice in the answer', async () => {
    // The other half of the store rule. A phrase that names no store belongs to
    // the whole tenant, and the buyer asking in one store is entitled to it; a
    // rule that narrowed to the asking store would silently drop it. Its slice
    // is merchant-level, so only the rule's `scope_type = 'tenant'` half reaches it.
    const set = await suggest('ovqc 发票');
    expectNoForeignCandidate(set);
    expect(sourceIdsOf(set)).toContain(shortcutKey('case2a'));
  });

  it('keeps the other store’s slices out of the answer', async () => {
    // Five slices of the tenant's *other* store, all matching the question, all
    // sorting before this store's slice — so the fused Top 5 is theirs the moment
    // they are recalled at all, and this store's answer is displaced out of its
    // own answer. The store still must not be offered: a candidate records the
    // store it is filed under, and a slice recalled for another store answers a
    // question the buyer did not ask.
    const set = await suggest('ovqd 自提');
    expectNoForeignCandidate(set);
    expect(sourceIdsOf(set)).toContain(faqId('case2b'));
    expect(set.candidates.filter((candidate) => candidate.storeId === STORE_Y)).toEqual([]);
  });

  it('keeps the other store’s slices out of the semantic leg’s answer', async () => {
    // The store rule is written twice — once in each leg's `scoped` CTE — and
    // this is the copy the keyword leg's case cannot reach: no word is shared
    // between the question and either side's slices, so the question is answered
    // by the semantic leg or not at all. Five slices of the tenant's other store
    // are embedded for this question and sort before this store's, so for as
    // long as the leg recalls them they hold the whole fused Top 5.
    embeddingMode = 'ok';
    const set = await suggest('ovqj 现货');
    expectNoForeignCandidate(set);
    expect(sourceIdsOf(set)).toContain(faqId('case2c-x'));
    expect(set.candidates.filter((candidate) => candidate.storeId === STORE_Y)).toEqual([]);
  });

  it('refuses to read back a slice whose source id belongs to another tenant', async () => {
    // `source_id` is polymorphic text with no foreign key, so these slices are
    // holdable; the read-back is tenant-scoped, so they are not answerable. Both
    // readers are asked: the phrase names no store, and the FAQ carries this
    // tenant's store — so neither refusal is the store check's doing.
    const set = await suggest('ovqe 运费');
    expectNoForeignCandidate(set);
    expect(sourceIdsOf(set)).not.toContain(foreignShortcutKey('case3'));
    expect(sourceIdsOf(set)).not.toContain(foreignFaqId('case3'));
    expect(set.candidates.map((candidate) => candidate.title)).not.toContain(
      FOREIGN_SHORTCUT_TITLE,
    );
    expect(set.candidates.map((candidate) => candidate.title)).not.toContain(
      'ovqe 运费规则（外部租户）',
    );
    // The control: the same question is answerable with this tenant's own phrase,
    // so the refusals above are the tenant predicate working and not an empty answer.
    expect(sourceIdsOf(set)).toContain(shortcutKey('case3'));
  });

  it('refuses to read back a slice whose source belongs to another store', async () => {
    // A merchant-level slice naming a store's FAQ: in scope itself, its source in
    // this tenant, refused only by the store check.
    const set = await suggest('ovqf 保修');
    expect(sourceIdsOf(set)).not.toContain(faqId('case4-y'));
    expect(set.candidates.every((candidate) => candidate.storeId === STORE_X)).toBe(true);
    expect(sourceIdsOf(set)).toContain(faqId('case4-x'));
  });

  it('answers a question with the keyword leg’s evidence while the semantic leg is down', async () => {
    // The provider reports a failure rather than answering: half the search did
    // not run, which is a fact about the recall and not about the answer — so the
    // answer stands and the outage reaches the client as a fallback reason.
    const set = await suggest('ovqg 物流');
    expect(sourceIdsOf(set)).toContain(faqId('case5'));
    expect(set.fallbackReasons).toContain('semantic_recall_unavailable');
  });

  it('offers one candidate for a question whose two slices were both recalled', async () => {
    // Question slice and answer slice, one FAQ: the buyer is owed one entry, and
    // the entry that survives is the one whose evidence was stronger — the
    // fusion's first mention, which is the question slice here (it leads both
    // legs). What is asserted is the count, which is what the dedup decides.
    embeddingMode = 'ok';
    const set = await suggest('ovqh 换货');
    expect(candidatesOf(set, faqId('case6'))).toHaveLength(1);
  });
});

/** Write this run's tenant, stores, conversation and knowledge rows. */
async function seedFixtures(client: Client): Promise<void> {
  const now = new Date().toISOString();
  await client.query(
    `INSERT INTO tenants (id, code, name, enabled, created_at)
     VALUES ($1, $2, $3, true, $4), ($5, $6, $7, true, $4)`,
    [TENANT, `ov-${RUN}`, '越权验证租户', now, FOREIGN_TENANT, `fo-${RUN}`, '越权验证邻租户'],
  );
  await client.query(
    `INSERT INTO stores (id, tenant_id, code, name, enabled, created_at)
     VALUES ($1, $2, $3, $4, true, $5), ($6, $2, $7, $8, true, $5)`,
    [STORE_X, TENANT, `x-${RUN}`, '越权验证主店', now, STORE_Y, `y-${RUN}`, '越权验证分店'],
  );
  await client.query(
    `INSERT INTO conversations
       (id, tenant_id, store_id, channel, external_customer_id, status, opened_at,
        last_message_at, created_at)
     VALUES ($1, $2, $3, 'web', $4, 'open', $5, $5, $5)`,
    [CONVERSATION, TENANT, STORE_X, `ov-customer-${RUN}`, now],
  );

  for (const faq of FAQS) {
    await client.query(
      `INSERT INTO faqs (id, tenant_id, store_id, question, answer, enabled, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, true, $6, $6)`,
      [faq.id, faq.tenantId, faq.storeId, faq.question, faq.answer, now],
    );
  }

  for (const shortcut of SHORTCUTS) {
    await client.query(
      `INSERT INTO shortcuts
         (id, tenant_id, scope_type, store_id, code, title, content, sort_order,
          enabled, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, true, $8, $8)`,
      [
        shortcut.id,
        shortcut.tenantId,
        shortcut.scopeType,
        shortcut.storeId,
        shortcut.id,
        shortcut.title,
        shortcut.content,
        now,
      ],
    );
  }

  for (const chunk of CHUNKS) {
    await client.query(
      `INSERT INTO knowledge_chunks
         (id, tenant_id, store_id, scope_type, source_kind, source_id, source_field, chunk_type,
          chunk_index, content, char_count, enabled, content_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $13, $13)`,
      [
        chunk.id,
        chunk.tenantId,
        chunk.storeId,
        chunk.storeId === null ? 'tenant' : 'store',
        chunk.sourceKind,
        chunk.sourceId,
        chunk.sourceField ?? 'content',
        chunk.chunkType ?? 'content',
        chunk.chunkIndex ?? 0,
        chunk.content,
        chunk.content.length,
        CONTENT_HASH,
        now,
      ],
    );
    // The keyword leg reads the slice's *terms* and never its content, so a
    // fixture that stops at the chunk row is a slice that leg cannot answer with
    // — and every case below asks the keyword leg for a slice and asserts it came
    // back, which would read as a boundary the answer failed to cross.
    await insertKnowledgeTerms(client, chunk.tenantId, chunk.id, chunk.content);

    const embeddingCase = chunk.embeddedFor;
    if (embeddingCase !== undefined) {
      const index = VECTOR_CASES.indexOf(embeddingCase);
      if (index === -1) {
        throw new Error(`slice ${chunk.id} is embedded for an unknown case: ${embeddingCase}`);
      }
      await client.query(
        `INSERT INTO knowledge_chunk_embeddings
           (id, tenant_id, chunk_id, embedding_model, embedding_dimensions, embedding,
            content_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)`,
        [
          `kemb-ov-${RUN}-${chunk.id}`,
          chunk.tenantId,
          chunk.id,
          EMBEDDING_MODEL,
          VECTOR_DIMENSIONS,
          vectorLiteral(index),
          CONTENT_HASH,
          now,
        ],
      );
    }
  }
}
