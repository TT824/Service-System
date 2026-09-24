import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig, type CustomerSummary, type ExportJobRecord } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';
import {
  isDatabaseReachable,
  openDatabaseClient,
  resolveDatabaseUrl,
} from './database-test-support';

/**
 * The customer list and the export queue, over HTTP, against the real database.
 *
 * The orderings, the aggregate and the escaping are settled by
 * `customer-directory.spec.ts` and `exports.service.spec.ts` against hand-built
 * rows. What only an endpoint test can settle is everything the *database* is
 * asked: whether the aggregate that runs is the one that was written (a `GROUP
 * BY` that lost the latest conversation's title reads perfectly in a unit test),
 * whether the tenant scope reaches the SQL at all, and whether the bytes a
 * download answers with are the bytes the Worker stored.
 *
 * **这家租户是自带的。** The fixtures live in their own tenant rather than in
 * `tenant-acme`, for the reason `retrieval-overreach.e2e-spec.ts` gives: sibling
 * suites count rows in the seeded tenants, so a suite that writes conversations
 * into one of them fails depending on file order.
 *
 * **身份是平台管理员加 `x-tenant-id`。** `x-member-id` goes through the demo
 * directory, which knows the seeded members and nothing about this suite's tenant,
 * so the tenant scope has to come from the header — and only a platform
 * administrator's scope may. `APP_ENV=local` is what makes that header resolve at
 * all: `test` serves the in-process store, in which this suite's tenant does not
 * exist and every request would be a 404.
 */
const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Per-run suffix: every row this suite writes carries it, and all are removed. */
const RUN = randomUUID().slice(0, 8);

const TENANT = `tenant-ex-${RUN}`;
/** The neighbour whose rows must never appear in this tenant's answers. */
const FOREIGN_TENANT = `tenant-fx-${RUN}`;
const STORE = `store-ex-${RUN}`;
const FOREIGN_STORE = `store-fx-${RUN}`;

const PLATFORM_ADMIN = 'u-platform-admin';

/** One WeCom customer with two conversations — the aggregate's two-row case. */
const WECOM_CUSTOMER = `wm-alpha-${RUN}`;
/** One web customer, last active in August: the time window's excluded row. */
const WEB_CUSTOMER = `web-beta-${RUN}`;
/** A customer id holding a `_`, and its one-character decoy. */
const UNDERSCORE_CUSTOMER = `web_gamma-${RUN}`;
const UNDERSCORE_DECOY = `webXgamma-${RUN}`;
/** A customer of the neighbouring tenant. */
const FOREIGN_CUSTOMER = `wm-foreign-${RUN}`;

/**
 * The suite's instants, written down rather than read from the clock.
 *
 * A window asserted against `Date.now()` is a test that passes for the wrong
 * reason: it agrees with the filter because both are "now", not because the
 * filter works.
 */
const EARLY = '2026-09-10T02:00:00.000Z';
const LATE = '2026-09-15T02:01:00.000Z';
const AUGUST = '2026-08-01T02:00:00.000Z';
const GAMMA_AT = '2026-09-20T02:00:00.000Z';
const DECOY_AT = '2026-09-21T02:00:00.000Z';

const OLDER_CONVERSATION = `conversation-ex-older-${RUN}`;
const LATEST_CONVERSATION = `conversation-ex-latest-${RUN}`;
const AUGUST_CONVERSATION = `conversation-ex-aug-${RUN}`;
const GAMMA_CONVERSATION = `conversation-ex-gamma-${RUN}`;
const DECOY_CONVERSATION = `conversation-ex-decoy-${RUN}`;
const FOREIGN_CONVERSATION = `conversation-ex-foreign-${RUN}`;

/** Rows written by hand so the task list has something to leave out. */
const FOREIGN_JOB = `export-foreign-${RUN}`;
const OTHER_KIND_JOB = `job-other-${RUN}`;

const CUSTOMERS_URL = '/api/v1/customers';
const EXPORTS_URL = '/api/v1/exports';

type Envelope<T> = { request_id: string; data: T; meta: Record<string, never> };
type ErrorBody = {
  request_id: string;
  code: string;
  message: string;
  details: ReadonlyArray<string>;
};

/**
 * One conversation, as the fixture table writes it.
 *
 * `lastMessageAt` is the row's own clock and the messages below carry times that
 * fall inside it — a fixture whose conversation says 02:00 and whose messages say
 * 03:00 is a fixture that answers a question nobody asked.
 */
type ConversationFixture = {
  readonly id: string;
  readonly channel: string;
  readonly customer: string;
  readonly title: string | null;
  readonly lastMessageAt: string;
  readonly tenantId: string;
  readonly storeId: string;
};

const CONVERSATIONS: ReadonlyArray<ConversationFixture> = [
  {
    id: OLDER_CONVERSATION,
    channel: 'wecom',
    customer: WECOM_CUSTOMER,
    title: '张三',
    lastMessageAt: EARLY,
    tenantId: TENANT,
    storeId: STORE,
  },
  {
    id: LATEST_CONVERSATION,
    channel: 'wecom',
    customer: WECOM_CUSTOMER,
    title: '张三的店铺',
    lastMessageAt: LATE,
    tenantId: TENANT,
    storeId: STORE,
  },
  {
    id: AUGUST_CONVERSATION,
    channel: 'web',
    customer: WEB_CUSTOMER,
    title: '李四',
    lastMessageAt: AUGUST,
    tenantId: TENANT,
    storeId: STORE,
  },
  {
    id: GAMMA_CONVERSATION,
    channel: 'web',
    customer: UNDERSCORE_CUSTOMER,
    title: null,
    lastMessageAt: GAMMA_AT,
    tenantId: TENANT,
    storeId: STORE,
  },
  {
    id: DECOY_CONVERSATION,
    channel: 'web',
    customer: UNDERSCORE_DECOY,
    title: null,
    lastMessageAt: DECOY_AT,
    tenantId: TENANT,
    storeId: STORE,
  },
  {
    id: FOREIGN_CONVERSATION,
    channel: 'wecom',
    customer: FOREIGN_CUSTOMER,
    title: '邻租户的顾客',
    lastMessageAt: LATE,
    tenantId: FOREIGN_TENANT,
    storeId: FOREIGN_STORE,
  },
];

describe.skipIf(!reachable)('Customer list and export tasks (interface)', () => {
  let app: INestApplication;
  let client: Client;

  beforeAll(async () => {
    const parsed = parseAppConfig({
      ...process.env,
      APP_ENV: 'local',
      AUTH_DEMO_IDENTITY_HEADERS: 'true',
    });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }

    client = await openDatabaseClient(databaseUrl);
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO tenants (id, code, name, enabled, created_at)
       VALUES ($1, $2, $3, true, $4), ($5, $6, $7, true, $4)`,
      [TENANT, `ex-${RUN}`, '导出验证租户', now, FOREIGN_TENANT, `fx-${RUN}`, '导出邻租户'],
    );
    await client.query(
      `INSERT INTO stores (id, tenant_id, code, name, enabled, created_at)
       VALUES ($1, $2, $3, $4, true, $5), ($6, $7, $8, $9, true, $5)`,
      [STORE, TENANT, `ex-${RUN}`, '导出验证店', now, FOREIGN_STORE, FOREIGN_TENANT, `fx-${RUN}`, '邻租户店'],
    );
    for (const conversation of CONVERSATIONS) {
      await client.query(
        `INSERT INTO conversations
           (id, tenant_id, store_id, channel, external_customer_id, title, status,
            opened_at, last_message_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $7, $7)`,
        [
          conversation.id,
          conversation.tenantId,
          conversation.storeId,
          conversation.channel,
          conversation.customer,
          conversation.title,
          conversation.lastMessageAt,
        ],
      );
    }
    // Two messages, one each way: the transcript's only two speakers, and the
    // reason the exported conversation is worth downloading at all.
    await client.query(
      `INSERT INTO messages
         (id, tenant_id, store_id, conversation_id, channel, direction, source,
          message_type, content, created_at)
       VALUES ($1, $2, $3, $4, 'wecom', 'inbound', 'other', 'text', $5, $6),
              ($7, $2, $3, $4, 'wecom', 'outbound', 'manual_typed', 'text', $8, $9)`,
      [
        `message-ex-in-${RUN}`,
        TENANT,
        STORE,
        LATEST_CONVERSATION,
        '你好，羽绒服还有货吗',
        '2026-09-15T02:00:00.000Z',
        `message-ex-out-${RUN}`,
        '有货的，您要哪个尺码？',
        LATE,
      ],
    );
    // `jobs` is the platform's general work table: a neighbouring tenant's
    // export, and one of this tenant's rows that is not an export at all. The
    // task list has to answer with neither.
    await client.query(
      `INSERT INTO jobs (id, tenant_id, kind, status, payload, created_at, updated_at)
       VALUES ($1, $2, 'export', 'pending', $3::jsonb, $4, $4),
              ($5, $6, 'delivery', 'pending', '{}'::jsonb, $4, $4)`,
      [
        FOREIGN_JOB,
        FOREIGN_TENANT,
        JSON.stringify({
          scope: 'customers',
          label: '邻租户的顾客',
          filter: { query: null, from: null, to: null },
        }),
        now,
        OTHER_KIND_JOB,
        TENANT,
      ],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    }).compile();
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
      'DELETE FROM job_artifacts WHERE job_id IN (SELECT id FROM jobs WHERE tenant_id = ANY($1))',
      'DELETE FROM jobs WHERE tenant_id = ANY($1)',
      'DELETE FROM messages WHERE tenant_id = ANY($1)',
      'DELETE FROM conversations WHERE tenant_id = ANY($1)',
      'DELETE FROM stores WHERE tenant_id = ANY($1)',
      'DELETE FROM tenants WHERE id = ANY($1)',
    ]) {
      await client.query(statement, [tenants]);
    }

    // This suite's own contract: it leaves nothing behind. Both halves are
    // counted because they fail differently — rows left in `conversations` mean
    // the fixture cleanup missed, rows left in `jobs` mean the API's own writes
    // did, and a suite that only counted the first would call itself clean.
    const leftovers = await client.query<{ conversations: string; jobs: string; artifacts: string }>(
      `SELECT (SELECT count(*) FROM conversations WHERE tenant_id = ANY($1)) AS conversations,
              (SELECT count(*) FROM jobs WHERE tenant_id = ANY($1)) AS jobs,
              (SELECT count(*) FROM job_artifacts
                WHERE job_id IN (SELECT id FROM jobs WHERE tenant_id = ANY($1))) AS artifacts`,
      [tenants],
    );
    expect(leftovers.rows[0], `本套件（${RUN}）跑完留下的行`).toEqual({
      conversations: '0',
      jobs: '0',
      artifacts: '0',
    });
    await client.end();

    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  /** GET a JSON route as the platform administrator, scoped to a tenant. */
  function getJson(
    pathname: string,
    query: Readonly<Record<string, string>> = {},
    tenantId = TENANT,
  ): request.Test {
    return request(app.getHttpServer())
      .get(pathname)
      .query(query)
      .set('x-member-id', PLATFORM_ADMIN)
      .set('x-tenant-id', tenantId);
  }

  /** POST an export request as the platform administrator, scoped to a tenant. */
  function postExport(body: unknown, tenantId = TENANT): request.Test {
    return request(app.getHttpServer())
      .post(EXPORTS_URL)
      .set('x-member-id', PLATFORM_ADMIN)
      .set('x-tenant-id', tenantId)
      .send(body as object);
  }

  /** The customer page, as the console reads it. */
  async function customersOf(
    query: Readonly<Record<string, string>> = {},
    tenantId = TENANT,
  ): Promise<ReadonlyArray<CustomerSummary>> {
    const response = await getJson(CUSTOMERS_URL, query, tenantId).expect(200);
    return (response.body as Envelope<ReadonlyArray<CustomerSummary>>).data;
  }

  /** One row by its channel-side id, or a failure naming what came back. */
  function rowFor(
    rows: ReadonlyArray<CustomerSummary>,
    externalCustomerId: string,
  ): CustomerSummary {
    const row = rows.find((candidate) => candidate.externalCustomerId === externalCustomerId);
    if (row === undefined) {
      throw new Error(
        `列表里没有 ${externalCustomerId}：${rows.map((row) => row.externalCustomerId).join(',')}`,
      );
    }
    return row;
  }

  describe('顾客列表', () => {
    it('一位顾客一行，名字与会话数取最近那条会话', async () => {
      const rows = await customersOf();

      // 这位顾客有两条会话，表里只有一行：DISTINCT ON 丢掉的是旧那条，
      // 所以名字（「张三的店铺」）与条数（2）来自两个不同的地方，两个都要对。
      const wecom = rowFor(rows, WECOM_CUSTOMER);
      expect(wecom).toMatchObject({
        customerKey: `wecom:${WECOM_CUSTOMER}`,
        channel: 'wecom',
        nickname: '张三的店铺',
        conversationCount: 2,
        lastMessageAt: LATE,
        // 「导出这位顾客的对话」导的就是这一条。
        lastConversationId: LATEST_CONVERSATION,
        // 平台没有电话这个字段，微信是渠道侧给的 external userid。
        phone: null,
        wechat: WECOM_CUSTOMER,
      });

      // 非微信渠道没有微信，标题为空的顾客名就退回 id —— 一行空白比 id 难认。
      const gamma = rowFor(rows, UNDERSCORE_CUSTOMER);
      expect(gamma).toMatchObject({
        channel: 'web',
        nickname: UNDERSCORE_CUSTOMER,
        wechat: null,
        phone: null,
        conversationCount: 1,
      });
    });

    it('按最近活跃倒序，邻租户的顾客一条都不在', async () => {
      const rows = await customersOf();

      expect(rows.map((row) => row.externalCustomerId)).toEqual([
        UNDERSCORE_DECOY,
        UNDERSCORE_CUSTOMER,
        WECOM_CUSTOMER,
        WEB_CUSTOMER,
      ]);
      expect(rows.map((row) => row.externalCustomerId)).not.toContain(FOREIGN_CUSTOMER);
    });

    it('关键字同时搜 id 与昵称', async () => {
      const byId = await customersOf({ q: WEB_CUSTOMER });
      expect(byId.map((row) => row.externalCustomerId)).toEqual([WEB_CUSTOMER]);

      const byNickname = await customersOf({ q: '李四' });
      expect(byNickname.map((row) => row.externalCustomerId)).toEqual([WEB_CUSTOMER]);
    });

    it('关键字里的下划线是字面量', async () => {
      // 不做转义的话 `_` 是「任意一个字符」，`web_gamma` 会连 `webXgamma` 一起捞出来 ——
      // 而这条 SQL 是全平台唯一一处把关键字交给 LIKE 的地方，转义只在这里才被验到。
      const rows = await customersOf({ q: UNDERSCORE_CUSTOMER });
      expect(rows.map((row) => row.externalCustomerId)).toEqual([UNDERSCORE_CUSTOMER]);
    });

    it('时间段之外的行被筛掉', async () => {
      const rows = await customersOf({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.000Z' });

      expect(rows.map((row) => row.externalCustomerId)).not.toContain(WEB_CUSTOMER);
      expect(rows.map((row) => row.externalCustomerId)).toContain(WECOM_CUSTOMER);
    });

    it('名字与会话数跟着时间段走，而不是整段历史', async () => {
      // 同一位顾客，两个窗口，两行不同的答案：`count(*) OVER` 数的是窗口里的行，
      // 标题取的也是窗口里最近那条 —— 用一个整段历史的数字配上窗口里的日期，
      // 是这一页最难自己发现的一种错。
      const whole = rowFor(await customersOf({ q: WECOM_CUSTOMER }), WECOM_CUSTOMER);
      expect(whole).toMatchObject({ nickname: '张三的店铺', conversationCount: 2, lastMessageAt: LATE });

      const after = rowFor(
        await customersOf({ q: WECOM_CUSTOMER, from: '2026-09-12T00:00:00.000Z' }),
        WECOM_CUSTOMER,
      );
      expect(after).toMatchObject({ nickname: '张三的店铺', conversationCount: 1, lastMessageAt: LATE });

      const before = rowFor(
        await customersOf({ q: WECOM_CUSTOMER, to: '2026-09-12T00:00:00.000Z' }),
        WECOM_CUSTOMER,
      );
      expect(before).toMatchObject({ nickname: '张三', conversationCount: 1, lastMessageAt: EARLY });
    });

    it('读不出来的时间被拒绝，而不是当成没有时间范围', async () => {
      // 「不筛选」与「筛了个空」在页面上都是更长的一列；这里必须是 400 并把话说清楚。
      const response = await getJson(CUSTOMERS_URL, { from: '昨天' }).expect(400);
      const body = response.body as ErrorBody;

      expect(body.code).toBe('bad_request');
      expect(body.details.join('')).toContain('起始时间');
    });

    it('邻租户拿自己的身份看到的只有自己那一行', async () => {
      const rows = await customersOf({}, FOREIGN_TENANT);

      expect(rows.map((row) => row.externalCustomerId)).toEqual([FOREIGN_CUSTOMER]);
    });
  });

  describe('排队导出', () => {
    it('会话导出落成一条 pending 任务，五个时间列各就各位', async () => {
      const response = await postExport({
        scope: 'conversation',
        conversationId: LATEST_CONVERSATION,
      }).expect(201);
      const job = (response.body as Envelope<ExportJobRecord>).data;

      expect(job).toMatchObject({
        tenantId: TENANT,
        scope: 'conversation',
        label: '顾客「张三的店铺」的对话',
        status: 'pending',
        // 还没轮到：开始与完成时刻是空的，「进行中」与「还没开始」靠这两列区分。
        startedAt: null,
        finishedAt: null,
        rowCount: null,
        error: null,
        artifacts: [],
      });
      expect(job.id).toMatch(/^export-/);
      expect(job.createdAt).not.toBe('');

      // 落库的那一行与回执是同一件事：任务列表读的是库，不是回执。
      const stored = await client.query<{ kind: string; status: string; payload: unknown }>(
        'SELECT kind, status, payload FROM jobs WHERE id = $1',
        [job.id],
      );
      expect(stored.rows[0]).toMatchObject({ kind: 'export', status: 'pending' });
      expect(stored.rows[0]?.payload).toMatchObject({
        scope: 'conversation',
        conversationId: LATEST_CONVERSATION,
      });
    });

    it('顾客口径的说明写着时间段与关键字', async () => {
      const response = await postExport({
        scope: 'customers',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
        q: '张三',
      }).expect(201);

      expect((response.body as Envelope<ExportJobRecord>).data.label).toBe(
        '2026-09-01 至 2026-09-30 的顾客 · 关键字「张三」',
      );
    });

    it('别的租户的会话排不出任务', async () => {
      // 排队时不查，Worker 里就会变成一条永远失败的任务 —— 那种失败要到任务列表里
      // 才知道，而这里是操作者唯一看得见原话的地方。
      const response = await postExport({
        scope: 'conversation',
        conversationId: FOREIGN_CONVERSATION,
      }).expect(404);
      expect((response.body as ErrorBody).code).toBe('not_found');
    });

    it('形状不对的请求被拒绝，并逐条说出问题', async () => {
      const response = await postExport({ scope: 'everything' }).expect(400);
      const body = response.body as ErrorBody;

      expect(body.code).toBe('bad_request');
      expect(body.details.length).toBeGreaterThan(0);
    });
  });

  describe('任务列表', () => {
    it('只列本租户的导出任务，倒序', async () => {
      const created = await postExport({
        scope: 'conversation',
        conversationId: LATEST_CONVERSATION,
      }).expect(201);
      const job = (created.body as Envelope<ExportJobRecord>).data;

      const response = await getJson(EXPORTS_URL).expect(200);
      const jobs = (response.body as Envelope<ReadonlyArray<ExportJobRecord>>).data;

      expect(jobs.map((row) => row.id)).toContain(job.id);
      // 邻租户的任务与别种 kind 的行都在同一张表里，一条都不能漏进来。
      expect(jobs.map((row) => row.id)).not.toContain(FOREIGN_JOB);
      expect(jobs.map((row) => row.id)).not.toContain(OTHER_KIND_JOB);
      expect(jobs.every((row) => row.tenantId === TENANT)).toBe(true);
      // 倒序：不管这一轮跑过多少用例，创建时刻必须是单调不增的。
      const stamps = jobs.map((row) => Date.parse(row.createdAt));
      expect(stamps).toEqual([...stamps].sort((left, right) => right - left));
      expect(jobs.every((row) => row.scope === 'conversation' || row.scope === 'customers')).toBe(true);
    });

    it('邻租户看不到别人的任务', async () => {
      const created = await postExport({
        scope: 'conversation',
        conversationId: LATEST_CONVERSATION,
      }).expect(201);
      const job = (created.body as Envelope<ExportJobRecord>).data;

      const response = await getJson(EXPORTS_URL, {}, FOREIGN_TENANT).expect(200);
      const jobs = (response.body as Envelope<ReadonlyArray<ExportJobRecord>>).data;

      expect(jobs.map((row) => row.id)).not.toContain(job.id);
      expect(jobs.map((row) => row.id)).toEqual([FOREIGN_JOB]);
    });
  });

  describe('下载产物', () => {
    /** 一次会话导出，返回任务 id。 */
    async function queueOne(): Promise<string> {
      const response = await postExport({
        scope: 'conversation',
        conversationId: LATEST_CONVERSATION,
      }).expect(201);
      return (response.body as Envelope<ExportJobRecord>).data.id;
    }

    /**
     * 下载一个产物。
     *
     * 自己带解析器，因为这条路由的两种答案都要按各自的形状读：成功是文件本体
     * （默认解析器会把它读成一个空对象，于是「下载到了什么」永远测不出来），
     * 失败是 JSON 报错体，而那个解析器不认识 JSON。按响应的 content-type 分。
     */
    function download(jobId: string, format: string, tenantId = TENANT): request.Test {
      return request(app.getHttpServer())
        .get(`${EXPORTS_URL}/${jobId}/download/${format}`)
        .set('x-member-id', PLATFORM_ADMIN)
        .set('x-tenant-id', tenantId)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Array<Buffer> = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const body = Buffer.concat(chunks);
            callback(
              null,
              String(response.headers['content-type']).includes('json')
                ? JSON.parse(body.toString('utf8'))
                : body,
            );
          });
        });
    }

    /** 一个文件，照 Worker 落库的样子写进去。 */
    async function storeArtifact(
      jobId: string,
      format: string,
      fileName: string,
      contentType: string,
      bytes: Buffer,
    ): Promise<void> {
      await client.query(
        `INSERT INTO job_artifacts
           (job_id, format, file_name, content_type, bytes, byte_count, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [jobId, format, fileName, contentType, bytes, bytes.byteLength, new Date().toISOString()],
      );
    }

    it('还没渲染完下载不到，邻租户拿同一个 id 也是同一个答案', async () => {
      const jobId = await queueOne();

      await download(jobId, 'xlsx').expect(404);
      // 「任务不存在」「不是我租户的」「还没渲染好」共用一个答案：分开回答等于
      // 给了一个可以拿来探测任务 id 是否存在的接口。
      await download(jobId, 'xlsx', FOREIGN_TENANT).expect(404);
    });

    it('格式不在两项里就拒绝，并说出有哪两项', async () => {
      const jobId = await queueOne();

      const response = await download(jobId, 'pdf').expect(400);
      expect((response.body as ErrorBody).details.join('')).toContain('transcript');
    });

    it('渲染好的文件按字节下载，文件名与类型来自任务行', async () => {
      const jobId = await queueOne();
      // 带 0x00 与 0xff 的几个字节：一个把 body 当字符串转一圈的实现会在这里露馅，
      // 而「下载回来了一些字节」在损坏的文件上照样成立。
      const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x41, 0x42]);
      const fileName = `conversation-20260922-${RUN}.xlsx`;
      await storeArtifact(
        jobId,
        'xlsx',
        fileName,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes,
      );

      const response = await download(jobId, 'xlsx').expect(200);

      expect(response.headers['content-disposition']).toBe(`attachment; filename="${fileName}"`);
      expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
      // 一个租户的顾客名单不能进任何共享缓存。
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(Buffer.compare(response.body as Buffer, bytes)).toBe(0);

      // 文件确实生成了，别人也还是拿不到：这一条必须打在**有产物**的任务上 ——
      // 拿一条还没渲染的任务去试，租户没拦住和文件不存在都是 404，测了等于没测。
      await download(jobId, 'xlsx', FOREIGN_TENANT).expect(404);
    });

    it('两种产物各自下载，文本按 UTF-8 送', async () => {
      const jobId = await queueOne();
      const text = Buffer.from('[2026-09-15T02:00:00.000Z] 顾客：你好，羽绒服还有货吗\n', 'utf8');
      await storeArtifact(jobId, 'transcript', `conversation-20260922-${RUN}.txt`, 'text/plain; charset=utf-8', text);

      const response = await download(jobId, 'transcript').expect(200);

      expect(response.headers['content-type']).toContain('charset=utf-8');
      expect(Buffer.compare(response.body as Buffer, text)).toBe(0);
      expect((response.body as Buffer).toString('utf8')).toContain('顾客：你好，羽绒服还有货吗');
    });
  });
});
