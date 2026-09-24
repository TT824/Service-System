import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Workbook } from 'exceljs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  EXPORT_CUSTOMER_LIMIT,
  exportJobPayload,
  parseAppConfig,
  type ExportRequest,
} from '@kefu/core';
import { WorkerDatabase } from '../database/worker-database';
import { toIsoOrNull, toNumber, toText, toTextOrNull } from '../database/row-values';
import { ExportProcessor } from './export-processor';
import { PostgresExportJobRepository } from './postgres-export-job-repository';
import type { ClaimedExportJob } from './export-job-repository';

/**
 * The export queue and its sources, in SQL, against the real PostgreSQL.
 *
 * `export-processor.spec.ts` settles the bookkeeping against a repository that
 * answers by hand, and `export-artifacts.spec.ts` settles the rendering. What is
 * left is everything that only a real database can answer, and three of those are
 * failure modes that no unit test can see:
 *
 *   1. **Two Workers, one queue.** `FOR UPDATE SKIP LOCKED` is a claim about
 *      concurrency; a single-threaded fake proves nothing about it. If it were
 *      dropped, every other test in the repository would still be green, and two
 *      Workers would render the same export twice.
 *   2. **The tenant predicate reaching the SQL.** The claim is platform-wide by
 *      design (a Worker serves every tenant, so the *job row* is the only thing
 *      that says whose data may be read). Every read is therefore scoped by
 *      `jobs.tenant_id`, and the test that matters is the one that points a job
 *      of one tenant at another tenant's conversation — a missing predicate there
 *      is a cross-tenant leak that reads as a working export.
 *   3. **The aggregate, as written.** The page and the export run the same
 *      `DISTINCT ON`. `apps/api/test/exports.e2e-spec.ts` proves the API's copy;
 *      this file proves the Worker's, *including the LIKE escaping*, because the
 *      duplication is real and the two copies can drift.
 *
 * The suite skips cleanly when no database is reachable, writes only rows
 * carrying a per-run suffix, and removes them again — the claim sweeps the whole
 * platform, so a row left pending here would be handed to the next suite's tick.
 *
 * **This file does not import the API's test helpers.** A Worker test reaching
 * into `apps/api` would make the two workspaces one workspace; the few lines of
 * plumbing below live here for that reason, as they do in the other
 * `*.integration.spec.ts` files under `apps/worker`.
 */

const databaseUrl = resolveDatabaseUrl();
const reachable = isDatabaseReachable(databaseUrl);

/** Per-run suffix: every row this suite writes carries it, and all are removed. */
const RUN = randomUUID().slice(0, 8);

const TENANT = `tenant-xw-${RUN}`;
const FOREIGN_TENANT = `tenant-xf-${RUN}`;
const STORE = `store-xw-${RUN}`;
const FOREIGN_STORE = `store-xf-${RUN}`;

const WECOM_CUSTOMER = `wm-xport-${RUN}`;
const WEB_CUSTOMER = `web-xport-${RUN}`;
const UNDERSCORE_CUSTOMER = `web_xport-${RUN}`;
const UNDERSCORE_DECOY = `webXxport-${RUN}`;
const FOREIGN_CUSTOMER = `wm-xforeign-${RUN}`;

const EARLY = '2026-09-10T02:00:00.000Z';
const LATE = '2026-09-15T02:01:00.000Z';
const AUGUST = '2026-08-01T02:00:00.000Z';

const OLDER_CONVERSATION = `conversation-xw-older-${RUN}`;
const LATEST_CONVERSATION = `conversation-xw-latest-${RUN}`;
const AUGUST_CONVERSATION = `conversation-xw-aug-${RUN}`;
const UNDERSCORE_CONVERSATION = `conversation-xw-score-${RUN}`;
const DECOY_CONVERSATION = `conversation-xw-decoy-${RUN}`;
const FOREIGN_CONVERSATION = `conversation-xf-${RUN}`;

/** Job ids this suite writes; the only ones its assertions are about. */
const JOB_OLD = `export-x-old-${RUN}`;
const JOB_NEW = `export-x-new-${RUN}`;
const JOB_BAD = `export-x-bad-${RUN}`;
/** One of this tenant's rows that is not an export at all. */
const JOB_OTHER_KIND = `job-x-other-${RUN}`;

const CONVERSATIONS = [
  { id: OLDER_CONVERSATION, tenantId: TENANT, storeId: STORE, channel: 'wecom', customer: WECOM_CUSTOMER, title: '张三', at: EARLY },
  { id: LATEST_CONVERSATION, tenantId: TENANT, storeId: STORE, channel: 'wecom', customer: WECOM_CUSTOMER, title: '张三的店铺', at: LATE },
  { id: AUGUST_CONVERSATION, tenantId: TENANT, storeId: STORE, channel: 'web', customer: WEB_CUSTOMER, title: '李四', at: AUGUST },
  { id: UNDERSCORE_CONVERSATION, tenantId: TENANT, storeId: STORE, channel: 'web', customer: UNDERSCORE_CUSTOMER, title: null, at: '2026-09-18T02:00:00.000Z' },
  { id: DECOY_CONVERSATION, tenantId: TENANT, storeId: STORE, channel: 'web', customer: UNDERSCORE_DECOY, title: null, at: '2026-09-19T02:00:00.000Z' },
  { id: FOREIGN_CONVERSATION, tenantId: FOREIGN_TENANT, storeId: FOREIGN_STORE, channel: 'wecom', customer: FOREIGN_CUSTOMER, title: '邻租户的顾客', at: LATE },
] as const;

describe.skipIf(!reachable)('Worker export persistence (PostgreSQL)', () => {
  let database: WorkerDatabase;
  let repository: PostgresExportJobRepository;

  beforeAll(async () => {
    // Idempotent: a developer machine may already have the migrations applied.
    runDatabaseCommand('migrate', databaseUrl);
    database = new WorkerDatabase(databaseUrl);
    repository = new PostgresExportJobRepository(database);

    const now = nowIso();
    await database.query(
      `INSERT INTO tenants (id, code, name, enabled, created_at)
       VALUES ($1, $2, $3, true, $4), ($5, $6, $7, true, $4)`,
      [TENANT, `xw-${RUN}`, '导出 Worker 验证租户', now, FOREIGN_TENANT, `xf-${RUN}`, '导出 Worker 邻租户'],
    );
    await database.query(
      `INSERT INTO stores (id, tenant_id, code, name, enabled, created_at)
       VALUES ($1, $2, $3, $4, true, $5), ($6, $7, $8, $9, true, $5)`,
      [STORE, TENANT, `xw-${RUN}`, '导出 Worker 验证店', now, FOREIGN_STORE, FOREIGN_TENANT, `xf-${RUN}`, '邻租户店'],
    );
    for (const conversation of CONVERSATIONS) {
      await database.query(
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
          conversation.at,
        ],
      );
    }
    await database.query(
      `INSERT INTO messages
         (id, tenant_id, store_id, conversation_id, channel, direction, source,
          message_type, content, created_at)
       VALUES ($1, $2, $3, $4, 'wecom', 'inbound', 'other', 'text', $5, $6),
              ($7, $2, $3, $4, 'wecom', 'outbound', 'manual_typed', 'text', $8, $9)`,
      [
        `message-xw-in-${RUN}`,
        TENANT,
        STORE,
        LATEST_CONVERSATION,
        '你好，羽绒服还有货吗',
        '2026-09-15T02:00:00.000Z',
        `message-xw-out-${RUN}`,
        '有货的，您要哪个尺码？',
        LATE,
      ],
    );
  });

  afterEach(async () => {
    // The claim is platform-wide: a row of this suite left pending is a row the
    // next test's tick claims, renders and writes back, which turns every later
    // assertion into a measurement of two tests at once. Artifacts go with the
    // job (`ON DELETE CASCADE`).
    await database.query('DELETE FROM jobs WHERE tenant_id = ANY($1)', [[TENANT, FOREIGN_TENANT]]);
  });

  afterAll(async () => {
    if (database !== undefined) {
      for (const statement of [
        'DELETE FROM jobs WHERE tenant_id = ANY($1)',
        'DELETE FROM messages WHERE tenant_id = ANY($1)',
        'DELETE FROM conversations WHERE tenant_id = ANY($1)',
        'DELETE FROM stores WHERE tenant_id = ANY($1)',
        'DELETE FROM tenants WHERE id = ANY($1)',
      ]) {
        await database.query(statement, [[TENANT, FOREIGN_TENANT]]);
      }

      const rows = await database.rows(
        `SELECT (SELECT count(*) FROM conversations WHERE tenant_id = ANY($1)) AS conversations,
                (SELECT count(*) FROM jobs WHERE tenant_id = ANY($1)) AS jobs,
                (SELECT count(*) FROM job_artifacts
                  WHERE job_id IN (SELECT id FROM jobs WHERE tenant_id = ANY($1))) AS artifacts`,
        [[TENANT, FOREIGN_TENANT]],
      );
      const leftover = rows[0];
      expect(
        leftover === undefined
          ? null
          : {
              conversations: toText(leftover['conversations']),
              jobs: toText(leftover['jobs']),
              artifacts: toText(leftover['artifacts']),
            },
        `本套件（${RUN}）跑完留下的行`,
      ).toEqual({ conversations: '0', jobs: '0', artifacts: '0' });
      await database.close();
    }
  });

  /**
   * Queue one export the way the API queues it.
   *
   * The payload is written by `@kefu/core`'s `exportJobPayload` — the same
   * function the API calls — because the thing under test is the seam between two
   * processes: a payload this file made up would test this file's idea of the
   * shape, which is exactly the shape nobody ships.
   */
  async function queue(
    id: string,
    tenantId: string,
    request: ExportRequest,
    createdAt: string,
    options: { readonly kind?: string; readonly payload?: unknown } = {},
  ): Promise<void> {
    await database.query(
      `INSERT INTO jobs (id, tenant_id, kind, status, payload, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending', $4::jsonb, $5, $5)`,
      [
        id,
        tenantId,
        options.kind ?? 'export',
        JSON.stringify(options.payload ?? exportJobPayload(request, '顾客「张三的店铺」的对话')),
        createdAt,
      ],
    );
  }

  /** One job row, as this suite's assertions read it. */
  async function jobRow(id: string): Promise<{
    readonly status: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly error: string | null;
    readonly result: unknown;
  }> {
    const rows = await database.rows(
      'SELECT status, started_at, finished_at, error, result FROM jobs WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`任务 ${id} 不见了`);
    }
    return {
      status: toText(row['status']),
      startedAt: toIsoOrNull(row['started_at']),
      finishedAt: toIsoOrNull(row['finished_at']),
      error: toTextOrNull(row['error']),
      result: row['result'],
    };
  }

  /** The stored artifacts of one job, by format. */
  async function artifactsOf(id: string): Promise<
    ReadonlyArray<{
      readonly format: string;
      readonly fileName: string;
      readonly contentType: string;
      readonly byteCount: number;
    }>
  > {
    const rows = await database.rows(
      `SELECT format, file_name, content_type, byte_count
       FROM job_artifacts WHERE job_id = $1 ORDER BY format`,
      [id],
    );
    return rows.map((row) => ({
      format: toText(row['format']),
      fileName: toText(row['file_name']),
      contentType: toText(row['content_type']),
      byteCount: toNumber(row['byte_count']),
    }));
  }

  /** The stored bytes of one artifact. */
  async function artifactBytes(id: string, format: string): Promise<Buffer> {
    const rows = await database.rows(
      'SELECT bytes FROM job_artifacts WHERE job_id = $1 AND format = $2',
      [id, format],
    );
    const bytes = rows[0]?.['bytes'];
    return Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(0);
  }

  const conversationJob = (overrides: Partial<ClaimedExportJob> = {}): ClaimedExportJob => ({
    id: JOB_OLD,
    tenantId: TENANT,
    scope: 'conversation',
    label: '顾客「张三的店铺」的对话',
    createdAt: nowIso(),
    request: { scope: 'conversation', conversationId: LATEST_CONVERSATION },
    ...overrides,
  });

  describe('认领与租约', () => {
    it('只领 pending 的导出任务，先到先做，并写下开始时刻', async () => {
      await queue(JOB_OLD, TENANT, { scope: 'conversation', conversationId: LATEST_CONVERSATION }, minutesAgo(30));
      await queue(JOB_NEW, TENANT, { scope: 'customers', filter: { query: null, from: null, to: null } }, minutesAgo(10));
      // 同一张表里还有别种工作，还有一个已经被别人领走的导出任务：两种都不该被领。
      await queue(
        JOB_OTHER_KIND,
        TENANT,
        { scope: 'customers', filter: { query: null, from: null, to: null } },
        minutesAgo(45),
        { kind: 'delivery' },
      );
      // 这个瞬间只算一次。`minutesAgo(60)` 每次调用都是新的一刻，断言里再算一遍
      // 就会差出几毫秒 —— 于是「领走时写的时间戳没被回收动过」这句话测的其实是
      // 两次 `Date.now()` 之间的漂移。
      const staleRunningAt = minutesAgo(60);
      await database.query(
        `INSERT INTO jobs (id, tenant_id, kind, status, payload, created_at, updated_at, started_at)
         VALUES ($1, $2, 'export', 'running', '{}'::jsonb, $3, $3, $3)`,
        [`${JOB_BAD}-running`, TENANT, staleRunningAt],
      );

      const claimAt = nowIso();
      const claimed = await repository.claimDue(claimAt, 5);
      const mine = claimed.filter((job) => job.id.includes(RUN)).map((job) => job.id);

      // 认领是全平台的口径（一个 Worker 服务所有租户），所以这里只断言属于本套件的
      // 那些：别的套件若也留了 pending 的导出任务，它们出现在这一批里是**对的**。
      expect(mine).toEqual([JOB_OLD, JOB_NEW]);
      expect(claimed.every((job) => typeof job.tenantId === 'string')).toBe(true);

      const old = await jobRow(JOB_OLD);
      expect(old.status).toBe('running');
      expect(old.startedAt).toBe(claimAt);
      expect(old.finishedAt).toBeNull();

      // 别种工作一动没动：它的时间列还全是空的，像从没被碰过一样。
      const other = await jobRow(JOB_OTHER_KIND);
      expect(other.status).toBe('pending');
      expect(other.startedAt).toBeNull();
      const running = await jobRow(`${JOB_BAD}-running`);
      expect(running.startedAt).toBe(staleRunningAt);
    });

    it('一次不过量领，批大小就是批大小', async () => {
      await queue(JOB_OLD, TENANT, { scope: 'conversation', conversationId: LATEST_CONVERSATION }, minutesAgo(30));
      await queue(JOB_NEW, TENANT, { scope: 'conversation', conversationId: OLDER_CONVERSATION }, minutesAgo(20));

      const claimed = await repository.claimDue(nowIso(), 1);

      // 恰好一条，不是「不超过一条」：库里此刻至少有两个待领的导出任务，
      // 批大小是 1 的话就正好领走 1 条。写成 `toBeLessThanOrEqual` 的话，
      // 领到 0 条（什么都没领）和领到 1 条长得一模一样。
      expect(claimed.length).toBe(1);
    });

    it('两个 Worker 同时领，谁也不会拿到同一条', async () => {
      await queue(JOB_OLD, TENANT, { scope: 'conversation', conversationId: LATEST_CONVERSATION }, minutesAgo(30));
      await queue(JOB_NEW, TENANT, { scope: 'conversation', conversationId: OLDER_CONVERSATION }, minutesAgo(20));

      // `FOR UPDATE SKIP LOCKED` 是这里唯一一句关于并发的断言：没有它，两个 Worker
      // 会把同一份导出渲染两遍，而所有别的用例都照样是绿的。
      const [first, second] = await Promise.all([
        repository.claimDue(nowIso(), 2),
        repository.claimDue(nowIso(), 2),
      ]);
      const ids = [...first, ...second].map((job) => job.id).filter((id) => id.includes(RUN));

      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual([JOB_NEW, JOB_OLD]);
    });

    it('租约到期的任务被放回队列，没到期的与别种工作都不动', async () => {
      await database.query(
        `INSERT INTO jobs (id, tenant_id, kind, status, payload, created_at, updated_at, started_at)
         VALUES ($1, $2, 'export', 'running', '{}'::jsonb, $3, $3, $3),
                ($4, $2, 'export', 'running', '{}'::jsonb, $5, $5, $5),
                ($6, $2, 'delivery', 'running', '{}'::jsonb, $3, $3, $3)`,
        [
          `${JOB_OLD}-stale`,
          TENANT,
          minutesAgo(20),
          `${JOB_NEW}-fresh`,
          minutesAgo(1),
          `${JOB_OTHER_KIND}-stale`,
        ],
      );

      const reclaimed = await repository.reclaimStale(nowIso(), 10 * 60 * 1_000);

      expect(reclaimed).toBeGreaterThanOrEqual(1);
      const stale = await jobRow(`${JOB_OLD}-stale`);
      expect(stale.status).toBe('pending');
      expect(stale.startedAt).toBeNull();
      // 一分钟前领走的还在跑：回收不能把正在干活的那个也抢回来。
      const fresh = await jobRow(`${JOB_NEW}-fresh`);
      expect(fresh.status).toBe('running');
      // `kind` 的约束在这里才被验到：不在这一条上，别种工作的行会被当成搁浅的导出。
      const other = await jobRow(`${JOB_OTHER_KIND}-stale`);
      expect(other.status).toBe('running');
    });

    it('读不出的 payload 变成一条能判失败的任务，而不是崩掉认领', async () => {
      await queue(JOB_BAD, TENANT, { scope: 'conversation', conversationId: LATEST_CONVERSATION }, minutesAgo(5), {
        payload: { 这不是: '导出请求' },
      });

      const claimed = await repository.claimDue(nowIso(), 5);
      const bad = claimed.find((job) => job.id === JOB_BAD);

      expect(bad?.request).toBeNull();
      // 说明退回任务 id：读不出 payload 的任务也要有一行看得懂的说明。
      expect(bad?.label).toBe(JOB_BAD);
    });
  });

  describe('读取导出内容', () => {
    it('一个会话读成一段对话记录：两位说话人、按时间、标题带渠道名', async () => {
      const source = await repository.readSource(conversationJob());

      expect(source).toEqual({
        scope: 'conversation',
        sections: [
          {
            heading: '张三的店铺 · 企业微信',
            messages: [
              { occurredAt: '2026-09-15T02:00:00.000Z', speaker: '顾客', content: '你好，羽绒服还有货吗' },
              { occurredAt: LATE, speaker: '客服', content: '有货的，您要哪个尺码？' },
            ],
          },
        ],
      });
    });

    it('邻租户拿着同一个会话 id 一个字节也读不到', async () => {
      // 读的口径只来自任务行本身：把这条谓词去掉，导出的就是别人的对话，
      // 而文件看起来完全正常。
      const source = await repository.readSource(conversationJob({ tenantId: FOREIGN_TENANT }));

      expect(source).toBeNull();
    });

    it('会话没了就是读不到，不是一段空记录', async () => {
      // 「空」与「没有」在文件里长得不一样：空记录会说这段对话没有消息。
      const source = await repository.readSource(
        conversationJob({ request: { scope: 'conversation', conversationId: `conversation-xw-gone-${RUN}` } }),
      );

      expect(source).toBeNull();
    });

    it('顾客口径读回聚合行，窗口内计数与最近会话的名都跟着窗口走', async () => {
      const whole = await repository.readSource(
        conversationJob({ scope: 'customers', request: { scope: 'customers', filter: { query: WECOM_CUSTOMER, from: null, to: null } } }),
      );

      expect(whole?.scope === 'customers' ? whole.customers : []).toEqual([
        {
          customerKey: `wecom:${WECOM_CUSTOMER}`,
          channel: 'wecom',
          externalCustomerId: WECOM_CUSTOMER,
          nickname: '张三的店铺',
          phone: null,
          wechat: WECOM_CUSTOMER,
          conversationCount: 2,
          lastMessageAt: LATE,
          lastConversationId: LATEST_CONVERSATION,
        },
      ]);

      const windowed = await repository.readSource(
        conversationJob({
          scope: 'customers',
          request: {
            scope: 'customers',
            filter: { query: WECOM_CUSTOMER, from: null, to: '2026-09-12T00:00:00.000Z' },
          },
        }),
      );
      const row = windowed?.scope === 'customers' ? windowed.customers[0] : undefined;
      expect(row).toMatchObject({ nickname: '张三', conversationCount: 1, lastMessageAt: EARLY });
    });

    it('这一份聚合里的下划线也是字面量', async () => {
      // 同一段 SQL 在 `exports.service.ts` 里还有一份（页面用）。两份都要被验到，
      // 因为它们可以各自漂移，而漂移的那一份没有别的信号。
      const source = await repository.readSource(
        conversationJob({
          scope: 'customers',
          request: {
            scope: 'customers',
            filter: { query: UNDERSCORE_CUSTOMER, from: null, to: null },
          },
        }),
      );
      const customers = source?.scope === 'customers' ? source.customers : [];

      expect(customers.map((customer) => customer.externalCustomerId)).toEqual([UNDERSCORE_CUSTOMER]);
    });

    it('顾客列表超过上限时多读一行，好让渲染层能拒绝而不是截断', async () => {
      // 上限之外的判断靠这一行：读回正好等于上限时，「刚好到顶」与「超过顶」
      // 就分不出来了，而截断的文件看起来是完整的。
      const source = await repository.readSource(
        conversationJob({ scope: 'customers', request: { scope: 'customers', filter: { query: null, from: null, to: null } } }),
      );
      const customers = source?.scope === 'customers' ? source.customers : [];

      // 本租户只有四位顾客，远在上限之下：这里断言的是**没有**被悄悄截掉。
      expect(customers).toHaveLength(4);
      expect(customers.length).toBeLessThan(EXPORT_CUSTOMER_LIMIT);
    });
  });

  describe('写回结果', () => {
    /** One rendered artifact, as the renderer hands it over. */
    const artifact = (format: 'xlsx' | 'transcript', bytes: Buffer) => ({
      format,
      fileName: `conversation-20260922-${RUN}.${format === 'xlsx' ? 'xlsx' : 'txt'}`,
      contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/plain; charset=utf-8',
      bytes,
    });

    it('两个产物与终态在一次事务里落库', async () => {
      await queue(JOB_OLD, TENANT, { scope: 'conversation', conversationId: LATEST_CONVERSATION }, minutesAgo(5));
      const finishedAt = nowIso();

      await repository.recordSuccess(
        JOB_OLD,
        [artifact('transcript', Buffer.from('对话', 'utf8')), artifact('xlsx', Buffer.from([0x50, 0x4b, 0x00, 0xff]))],
        2,
        finishedAt,
      );

      const row = await jobRow(JOB_OLD);
      expect(row.status).toBe('succeeded');
      expect(row.error).toBeNull();
      expect(row.result).toEqual({ rowCount: 2 });
      expect(row.finishedAt).toBe(finishedAt);

      const stored = await artifactsOf(JOB_OLD);
      expect(stored.map((entry) => entry.format)).toEqual(['transcript', 'xlsx']);
      expect(stored.map((entry) => entry.byteCount)).toEqual([6, 4]);
      expect(stored[0]?.fileName).toBe(`conversation-20260922-${RUN}.txt`);
    });

    it('重跑同一个任务只覆盖自己上一次的产物', async () => {
      // 租约回收之后任务会被重跑一遍：产物按 (job_id, format) 覆盖，
      // 于是「重跑」不会留下第三、第四个文件，也不会失败。
      await queue(JOB_OLD, TENANT, { scope: 'conversation', conversationId: LATEST_CONVERSATION }, minutesAgo(5));
      await repository.recordSuccess(JOB_OLD, [artifact('xlsx', Buffer.from('first'))], 1, nowIso());
      await repository.recordSuccess(JOB_OLD, [artifact('xlsx', Buffer.from('second'))], 3, nowIso());

      const stored = await artifactsOf(JOB_OLD);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.byteCount).toBe(6);
      expect((await jobRow(JOB_OLD)).result).toEqual({ rowCount: 3 });
    });

    it('失败写的是理由，不是「还在跑」', async () => {
      await queue(JOB_OLD, TENANT, { scope: 'conversation', conversationId: LATEST_CONVERSATION }, minutesAgo(5));
      const finishedAt = nowIso();

      await repository.recordFailure(JOB_OLD, '这条会话已经不存在了', finishedAt);

      const row = await jobRow(JOB_OLD);
      expect(row.status).toBe('failed');
      expect(row.error).toBe('这条会话已经不存在了');
      expect(row.finishedAt).toBe(finishedAt);
      expect(await artifactsOf(JOB_OLD)).toEqual([]);
    });
  });

  describe('跑一次循环', () => {
    it('从排队到两个文件落库，整条链走通', async () => {
      await queue(JOB_OLD, TENANT, { scope: 'conversation', conversationId: LATEST_CONVERSATION }, minutesAgo(5));
      const processor = new ExportProcessor(repository, {
        batchSize: 5,
        pollIntervalMs: 1_000,
        leaseMs: 10 * 60 * 1_000,
      });

      const tick = await processor.runOnce();

      // 认领是全平台的，别的套件若也在库里留了任务，这一批里会有它们 ——
      // 所以断言落在**这一条**任务上，而不是这一批的总数上。
      expect(tick.claimed).toBeGreaterThanOrEqual(1);
      const row = await jobRow(JOB_OLD);
      expect(row.status).toBe('succeeded');
      expect(row.result).toEqual({ rowCount: 2 });

      const stored = await artifactsOf(JOB_OLD);
      expect(stored.map((entry) => entry.format)).toEqual(['transcript', 'xlsx']);
      // 文件本身也读回来一次：任务成功与「文件里真的有那两句话」是两件事，
      // 而渲染出问题的时候任务行仍然是成功的。
      const workbook = new Workbook();
      await workbook.xlsx.load(await artifactBytes(JOB_OLD, 'xlsx'));
      const sheet = workbook.getWorksheet('对话记录');
      expect(sheet?.getCell('C3').value).toBe('顾客');
      expect(sheet?.getCell('D3').value).toBe('你好，羽绒服还有货吗');

      const text = (await artifactBytes(JOB_OLD, 'transcript')).toString('utf8');
      expect(text).toContain('【张三的店铺 · 企业微信】');
      expect(text).toContain('[2026-09-15T02:01:00.000Z] 客服：有货的，您要哪个尺码？');
      expect(text).toContain('消息时间均为 UTC。');
    });

    it('指向邻租户会话的任务被写成失败，而不是导出别人的对话', async () => {
      await queue(
        JOB_OLD,
        FOREIGN_TENANT,
        { scope: 'conversation', conversationId: LATEST_CONVERSATION },
        minutesAgo(5),
      );
      const processor = new ExportProcessor(repository, {
        batchSize: 5,
        pollIntervalMs: 1_000,
        leaseMs: 10 * 60 * 1_000,
      });

      await processor.runOnce();

      const row = await jobRow(JOB_OLD);
      expect(row.status).toBe('failed');
      expect(row.error).toBe('这条会话已经不存在了');
      expect(await artifactsOf(JOB_OLD)).toEqual([]);
    });
  });
});

/** The current instant, ISO 8601. */
function nowIso(): string {
  return new Date().toISOString();
}

/** One instant `minutes` before now, ISO 8601. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * Resolve the database the tests should talk to.
 *
 * Uses the same parser the Worker's entry point uses, so a test follows
 * `DATABASE_URL` when it is set and otherwise the documented local default.
 */
function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = parseAppConfig({ ...env, APP_ENV: 'test' });
  if (parsed._tag !== 'ok') {
    throw new Error(`test database configuration is invalid: ${parsed.error.message}`);
  }
  return parsed.config.databaseUrl.unwrap();
}

/**
 * Drive one `database/scripts` entrypoint, exactly as a developer would.
 *
 * The URL travels through the child environment, never through its command line.
 */
function runDatabaseCommand(command: 'migrate', url: string): void {
  execFileSync(
    process.execPath,
    [path.resolve(process.cwd(), 'database/scripts/migrate.cjs'), command],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    },
  );
}

/**
 * Child-process program that answers "is the database up?" with its exit code.
 *
 * Built by a function rather than held in a module constant, because the suite
 * decides `describe.skipIf(...)` at the top of this file: a `const` declared
 * down here would still be in its temporal dead zone at that point, and the
 * skip would silently read as "no database" on a machine that has one.
 */
function reachabilityProbe(): string {
  return [
    "const { Client } = require('pg');",
    'const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });',
    'client',
    '  .connect()',
    "  .then(() => client.query('SELECT 1'))",
    '  .then(() => client.end())',
    '  .then(() => process.exit(0))',
    '  .catch(() => process.exit(1));',
  ].join('\n');
}

/**
 * Probe the database with a bounded round trip.
 *
 * Synchronous on purpose: the suite has to decide `describe.skipIf(...)` while
 * Vitest collects it, before any hook has run.
 */
function isDatabaseReachable(url: string): boolean {
  try {
    execFileSync(process.execPath, ['-e', reachabilityProbe()], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}
