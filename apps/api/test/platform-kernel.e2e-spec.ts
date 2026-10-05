import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KefuStore, parseAppConfig, type Member } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';

const T1 = 'tenant-acme';
const S1 = 'store-acme-flagship';

type Envelope = { data?: unknown; code?: string; message?: string };
type DataEnvelope = { request_id: string; data: unknown; meta: Record<string, never> };
type ErrorEnvelope = { request_id: string; code: string; message: string; details: unknown[] };

/**
 * Seed one platform-directory member directly into the in-process store.
 *
 * The `0005` invariant makes a tenant-scoped `platform_admin` impossible to
 * write, so the only way to reproduce the legacy row a pre-`0005` database may
 * still hold is to place it in the directory the same way such a database
 * would have loaded it. Nothing else in the store is touched.
 *
 * @param store - The application's platform directory.
 * @param member - The contradictory row to seed.
 */
function seedDirectoryMember(store: KefuStore, member: Member): void {
  const directory = store as unknown as { members: Member[] };
  directory.members.push(member);
}

/**
 * Interface tests for the platform kernel.
 *
 * These tests boot the real Nest application in-process and drive it over HTTP
 * with `supertest`, exercising identity/directory, conversations with optimistic
 * concurrency, tenant and store isolation, knowledge, retrieval/suggestions,
 * review, reports, audit and the disabled channel contract.
 */
describe('Platform kernel (interface)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    }).compile();

    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);
  });

  afterAll(async () => {
    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  it('reports the platform administrator account status with an unconfigured real wecom transport', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/access/status').expect(200);
    const body = response.body as DataEnvelope;
    const data = body.data as Record<string, unknown>;
    expect(body.request_id).toBe(response.headers['x-request-id']);
    expect(data['member']).toMatchObject({ id: 'u-platform-admin', role: 'platform_admin' });
    expect(data['tenant']).toBeNull();
    // The account surface claims neither credentials nor a real connection: the
    // default product path is the real transport, and without credentials it is
    // disabled rather than replaced by a simulated loop.
    expect(data['wecom']).toMatchObject({
      provider: 'wecom',
      mode: 'disabled',
      enableRequested: false,
      credentialsPresent: false,
      operational: false,
      realTransportConnected: false,
    });
    expect(data['reviewPolicy']).toMatchObject({ scope: 'platform', requireReview: true });
  });

  it('refuses unknown members and tenant-scoped calls without a tenant id', async () => {
    const unknown = await request(app.getHttpServer())
      .get('/api/v1/access/status')
      .set('x-member-id', 'someone-else')
      .expect(401);
    expect((unknown.body as ErrorEnvelope).code).toBe('unauthorized');

    const noTenant = await request(app.getHttpServer()).get('/api/v1/conversations').expect(400);
    expect((noTenant.body as ErrorEnvelope).code).toBe('bad_request');
  });

  it('lists tenants and scopes the directory by member tenant', async () => {
    const adminDirectory = await request(app.getHttpServer())
      .get('/api/v1/directory/tenants')
      .expect(200);
    const allTenants = (adminDirectory.body as DataEnvelope).data as unknown[];
    expect(allTenants.length).toBe(2);

    const merchantDirectory = await request(app.getHttpServer())
      .get('/api/v1/directory/tenants')
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const merchantTenants = (merchantDirectory.body as DataEnvelope).data as Array<
      Record<string, unknown>
    >;
    expect(merchantTenants.length).toBe(1);
    expect(merchantTenants[0]).toMatchObject({ tenant: { id: T1 } });

    const forbidden = await request(app.getHttpServer())
      .get('/api/v1/directory/tenants/tenant-beta')
      .set('x-member-id', 'u-t1-admin')
      .expect(403);
    expect((forbidden.body as ErrorEnvelope).code).toBe('forbidden');
  });

  it('lists conversations within the tenant and narrows agents to their store', async () => {
    const adminList = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set('x-tenant-id', T1)
      .expect(200);
    const adminConversations = (adminList.body as DataEnvelope).data as Array<
      Record<string, unknown>
    >;
    expect(adminConversations.length).toBe(3);

    const agentList = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    const agentConversations = (agentList.body as DataEnvelope).data as Array<
      Record<string, unknown>
    >;
    expect(agentConversations.length).toBe(3);
    expect(agentConversations.every((item) => item['storeId'] === S1)).toBe(true);
  });

  it('enforces tenant isolation across stores and members', async () => {
    const otherTenant = await request(app.getHttpServer())
      .get('/api/v1/conversations/conversation-acme-1')
      .set('x-member-id', 'u-t2-agent-1')
      .expect(404);
    expect((otherTenant.body as ErrorEnvelope).code).toBe('not_found');

    const crossStore = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set('x-member-id', 'u-t2-agent-1')
      .set('x-tenant-id', T1)
      .expect(403);
    expect((crossStore.body as ErrorEnvelope).code).toBe('forbidden');
  });

  it('claims an open conversation with an optimistic version check', async () => {
    const claim = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/claim')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ expectedVersion: 2 })
      .expect(201);
    const conversation = (claim.body as DataEnvelope).data as Record<string, unknown>;
    expect(conversation).toMatchObject({
      id: 'conversation-acme-2',
      status: 'claimed',
      assignedMemberId: 'u-t1-agent-1',
      version: 3,
    });

    const staleClaim = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/claim')
      .set('x-member-id', 'u-t1-agent-2')
      .send({ expectedVersion: 2 })
      .expect(409);
    expect((staleClaim.body as ErrorEnvelope).code).toBe('conflict');
  });

  it('keeps a live assignee’s conversation to that assignee', async () => {
    // 受理人在线（`away` 也算在线：它只是不接新单）——会话是他的，同店坐席碰不了。
    await request(app.getHttpServer())
      .put('/api/v1/assignment/presence')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ status: 'away' })
      .expect(200);

    // 同店坐席连看都看不到这条会话：队列里没有这一行，点进去是 403。以前两条都不成立
    // （队列按租户/门店给，详情没有门），那是「多个客服都能看到这条会话」的原样。
    const seatList = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set('x-member-id', 'u-t1-agent-2')
      .expect(200);
    const seatRows = (seatList.body as DataEnvelope).data as Array<Record<string, unknown>>;
    expect(seatRows.map((row) => row['id'])).not.toContain('conversation-acme-2');

    const seatRead = await request(app.getHttpServer())
      .get('/api/v1/conversations/conversation-acme-2')
      .set('x-member-id', 'u-t1-agent-2')
      .expect(403);
    expect((seatRead.body as ErrorEnvelope).code).toBe('forbidden');

    // 控制台拿到的判决来自服务端，所以在线这一半也在这里钉住：详情说不行，
    // 界面就一个动作都不给。读的人是管理员——坐席读不到这条会话，而在线这一半
    // 正是「连管理员也拿不开」（`mayTakeOverClaim`：受理人还活着，谁都别动）。
    const liveDetail = await request(app.getHttpServer())
      .get('/api/v1/conversations/conversation-acme-2')
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const live = (liveDetail.body as DataEnvelope).data as {
      canTakeOver: boolean;
      canReply: boolean;
      historyUntil: string | null;
    };
    expect(live.canTakeOver).toBe(false);
    // 管理员读得到全部，但不替顾客回话——话由受理人说。
    expect(live.canReply).toBe(false);
    expect(live.historyUntil).toBeNull();

    const notAssigned = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/return')
      .set('x-member-id', 'u-t1-agent-2')
      .send({ expectedVersion: 3 })
      .expect(403);
    expect((notAssigned.body as ErrorEnvelope).code).toBe('forbidden');

    const returned = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/return')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ expectedVersion: 3 })
      .expect(201);
    const conversation = (returned.body as DataEnvelope).data as Record<string, unknown>;
    expect(conversation).toMatchObject({ status: 'open', assignedMemberId: null, version: 4 });
  });

  it('lets a same-store seat take an offline assignee’s conversation off her', async () => {
    // UC-08：坐席掉线，她「接待中」的会话仍归她名下（不做自动转出），需要他人
    // 接手就走退单——这条旁路只在受理人离线时开着，所以上面那条测试仍然红。
    //
    // 发起人小云此刻在点「在线接单」（在线表里的 `accepting`）：接手＝转给自己，
    // 而派单只派给 accepting 的坐席。
    await request(app.getHttpServer())
      .put('/api/v1/assignment/presence')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ status: 'accepting' })
      .expect(200);

    const held = await request(app.getHttpServer())
      .get('/api/v1/conversations/conversation-acme-2')
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    const version = ((held.body as DataEnvelope).data as { conversation: Record<string, unknown> })
      .conversation.version as number;

    const claimed = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/claim')
      .set('x-member-id', 'u-t1-agent-2')
      .send({ expectedVersion: version })
      .expect(201);
    const conversation = (claimed.body as DataEnvelope).data as Record<string, unknown>;
    expect(conversation).toMatchObject({ status: 'claimed', assignedMemberId: 'u-t1-agent-2' });

    // 小蓝没有在线心跳。判决必须是**她名下**的时候读的（会话在池子里时对谁都不开放），
    // 而这两份判决就是控制台据以长出「接手」或「释放回池」的那一对。
    //
    // 这条读之所以还给得出来：上一条测试里小云**自己**把这单退回了池子，而退回也是一次
    // 「从我手里出去」——`from_member_id` 记的是放手的那位，所以她留着这段历史。
    const held2 = await request(app.getHttpServer())
      .get('/api/v1/conversations/conversation-acme-2')
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    const verdict = (held2.body as DataEnvelope).data as {
      conversation: Record<string, unknown>;
      canTakeOver: boolean;
      canTakeOverSelf: boolean;
      replyWindow: {
        open: boolean;
        windowEndsAt: string | null;
        messageLimit: number;
        remaining: number;
        refusal: string | null;
      };
    };
    expect(verdict.canTakeOver).toBe(true);
    // 小云在线接单，接得住：控制台给她的是「接手」。
    expect(verdict.canTakeOverSelf).toBe(true);
    // 外发提醒读的那份窗口随详情一起下发。这条会话的客户从未通过渠道发来消息（没有开户
    // 事件），所以窗口是「还没有」，而不是「已关闭」——控制台要能说清这个区别。
    expect(verdict.replyWindow).toMatchObject({
      open: false,
      windowEndsAt: null,
      messageLimit: 5,
      remaining: 0,
      refusal: 'window_missing',
    });

    // 同一份会话，小云改成「离开」：旁路照旧开着（拿得开），但派单不会再派给她，
    // 于是「接手」必须收回去——否则坐席在界面上点到的只会是一个 409。
    await request(app.getHttpServer())
      .put('/api/v1/assignment/presence')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ status: 'away' })
      .expect(200);
    const held3 = await request(app.getHttpServer())
      .get('/api/v1/conversations/conversation-acme-2')
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    const awayVerdict = (held3.body as DataEnvelope).data as {
      conversation: Record<string, unknown>;
      canTakeOver: boolean;
      canTakeOverSelf: boolean;
    };
    expect(awayVerdict.canTakeOver).toBe(true);
    expect(awayVerdict.canTakeOverSelf).toBe(false);

    // 拿得开的那件事仍然做得到：同店的小云可以把它退回池子。
    const handOver = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/return')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ expectedVersion: verdict.conversation.version })
      .expect(201);
    expect((handOver.body as DataEnvelope).data).toMatchObject({
      status: 'open',
      assignedMemberId: null,
    });
  });

  it('hands a conversation over, and stops the seat that let it go', async () => {
    // 转交走的是会话，不是记录：交出去的那位留着到那一刻为止的历史，看不到之后
    // 同事说了什么，也不能再说话。接手的那位接手之后一切照旧。
    //
    // 上一条测试把 conversation-acme-2 退回了池子，所以这里从小云接单开始。
    await request(app.getHttpServer())
      .put('/api/v1/assignment/presence')
      .set('x-member-id', 'u-t1-agent-2')
      .send({ status: 'accepting' })
      .expect(200);

    const pooled = await request(app.getHttpServer())
      .get('/api/v1/conversations/conversation-acme-2')
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    const pooledData = (pooled.body as DataEnvelope).data as {
      conversation: Record<string, unknown>;
    };
    const claimed = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/claim')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ expectedVersion: pooledData.conversation.version })
      .expect(201);
    const claimedVersion = ((claimed.body as DataEnvelope).data as { version: number }).version;

    // 交出去之前，持有人的这句话是这条会话的记录。
    const before = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/messages')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ content: '转交前由我答复：白色 M 有货。', source: 'manual_typed' })
      .expect(201);
    expect(
      ((before.body as DataEnvelope).data as { message: { content: string } }).message.content,
    ).toBe('转交前由我答复：白色 M 有货。');

    await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/transfer')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ expectedVersion: claimedVersion, toMemberId: 'u-t1-agent-2' })
      .expect(201);

    /** 一条会话的读，取读得到的那几件事实。 */
    async function readConversation(memberId: string): Promise<{
      readonly canReply: boolean;
      readonly historyUntil: string | null;
      readonly assignee: unknown;
      readonly contents: ReadonlyArray<string>;
    }> {
      const response = await request(app.getHttpServer())
        .get('/api/v1/conversations/conversation-acme-2')
        .set('x-member-id', memberId)
        .expect(200);
      const data = (response.body as DataEnvelope).data as {
        conversation: { assignedMemberId: unknown };
        messages: ReadonlyArray<{ content: string }>;
        canReply: boolean;
        historyUntil: string | null;
      };
      return {
        canReply: data.canReply,
        historyUntil: data.historyUntil,
        assignee: data.conversation.assignedMemberId,
        contents: data.messages.map((message) => message.content),
      };
    }

    const handedOff = await readConversation('u-t1-agent-1');
    expect(handedOff.assignee).toBe('u-t1-agent-2');
    // 读得到的是历史：截止那一刻，而且不再是说话的人。那一刻得是 ISO 报文——
    // 持久化适配器那一侧拿到的是驱动的 `Date`，形状不对在界面上只会表现为
    // 「2026-09-23T03:39:52.661Z 之后的记录你看不到了」这句里少一截（或整句 undefined）。
    expect(handedOff.historyUntil).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(handedOff.canReply).toBe(false);
    expect(handedOff.contents).toContain('转交前由我答复：白色 M 有货。');
    expect(handedOff.contents).toContain('这款白色 M 有货吗？');

    const holder = await readConversation('u-t1-agent-2');
    expect(holder.canReply).toBe(true);
    expect(holder.historyUntil).toBeNull();

    // 接手的那位接着服务，这句话只属于他。
    await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/messages')
      .set('x-member-id', 'u-t1-agent-2')
      .send({ content: '转交后由我接手：今天下单明天发出。', source: 'manual_typed' })
      .expect(201);

    const afterHandover = await readConversation('u-t1-agent-1');
    expect(afterHandover.contents).toContain('转交前由我答复：白色 M 有货。');
    expect(afterHandover.contents).not.toContain('转交后由我接手：今天下单明天发出。');
    expect((await readConversation('u-t1-agent-2')).contents).toContain(
      '转交后由我接手：今天下单明天发出。',
    );

    // 交出去之后也不能再说话——控制台把写信区整块换掉，服务端这一侧是这里。
    const formerSeatSend = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/messages')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ content: '我不该还能说话。', source: 'manual_typed' })
      .expect(403);
    expect((formerSeatSend.body as ErrorEnvelope).code).toBe('forbidden');

    // 队列：交出去的那位还看得见这一行（它的历史在那里），但受理人已经换了名字。
    const formerSeatQueue = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    const formerSeatRows = (formerSeatQueue.body as DataEnvelope).data as Array<
      Record<string, unknown>
    >;
    const handedOffRow = formerSeatRows.find((row) => row['id'] === 'conversation-acme-2');
    expect(handedOffRow).toBeDefined();
    expect(handedOffRow?.['assignedMemberId']).toBe('u-t1-agent-2');

    // 管理员读得到全部（不给历史截断），但照样不替顾客回话。
    const adminRead = await readConversation('u-t1-admin');
    expect(adminRead.historyUntil).toBeNull();
    expect(adminRead.canReply).toBe(false);
    expect(adminRead.contents).toContain('转交后由我接手：今天下单明天发出。');

    // 回到池子，让这条会话不再是某个人的（后面的用例读它时不受影响）。
    const holder2 = await request(app.getHttpServer())
      .get('/api/v1/conversations/conversation-acme-2')
      .set('x-member-id', 'u-t1-agent-2')
      .expect(200);
    const holderVersion = ((holder2.body as DataEnvelope).data as {
      conversation: { version: number };
    }).conversation.version;
    await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-2/return')
      .set('x-member-id', 'u-t1-agent-2')
      .send({ expectedVersion: holderVersion })
      .expect(201);

    // 收工：小蓝也改回「离开」。池子里留一条谁都接不了的单，后面的用例读到的
    // 会话表就不会被派单扫描改写（这也是这条文件里唯一一个让坐席「在线接单」的
    // 场合——转交目标必须是能接单的人）。
    await request(app.getHttpServer())
      .put('/api/v1/assignment/presence')
      .set('x-member-id', 'u-t1-agent-2')
      .send({ status: 'away' })
      .expect(200);
  });

  it('sends outbound messages with idempotency keys and refuses closed conversations', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-1/messages')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ content: '好的，已为您备注。', source: 'manual_typed', dedupKey: 'kefu-e2e-dedup' })
      .expect(201);
    const firstSend = (first.body as DataEnvelope).data as Record<string, unknown>;
    const firstMessage = firstSend['message'] as Record<string, unknown>;
    expect(firstMessage).toMatchObject({
      direction: 'outbound',
      source: 'manual_typed',
      reviewState: 'none',
    });
    // The send result always carries the provider-facing delivery alongside the
    // message, so the workspace never has to assume the reply was delivered.
    const firstDelivery = firstSend['delivery'] as Record<string, unknown>;
    expect(firstDelivery).toMatchObject({
      messageId: firstMessage['id'],
      conversationId: 'conversation-acme-1',
      channel: 'wecom',
      status: 'pending',
      attemptCount: 0,
    });

    const replay = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-1/messages')
      .set('x-member-id', 'u-t1-agent-1')
      .send({
        content: 'duplicate should be ignored',
        source: 'manual_typed',
        dedupKey: 'kefu-e2e-dedup',
      })
      .expect(201);
    const replaySend = (replay.body as DataEnvelope).data as Record<string, unknown>;
    const replayedMessage = replaySend['message'] as Record<string, unknown>;
    expect(replayedMessage['id']).toBe(firstMessage['id']);
    // A replayed logical message reuses its delivery; it never creates a second
    // one, so no extra provider attempt is made.
    expect((replaySend['delivery'] as Record<string, unknown>)['id']).toBe(firstDelivery['id']);
    expect((replaySend['delivery'] as Record<string, unknown>)['attemptCount']).toBe(0);

    const closed = await request(app.getHttpServer())
      .post('/api/v1/conversations/conversation-acme-3/messages')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ content: 'hi', source: 'manual_typed' })
      .expect(409);
    expect((closed.body as ErrorEnvelope).code).toBe('conflict');
  });

  it('lists knowledge and only lets admins write it', async () => {
    const products = await request(app.getHttpServer())
      .get('/api/v1/knowledge/products')
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const list = (products.body as DataEnvelope).data as Array<Record<string, unknown>>;
    expect(list.length).toBe(2);
    expect(list.every((item) => item['tenantId'] === T1)).toBe(true);

    const forbiddenWrite = await request(app.getHttpServer())
      .post('/api/v1/knowledge/products')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ storeId: S1, sku: 'K-9', title: '越权商品', description: 'no' })
      .expect(403);
    expect((forbiddenWrite.body as ErrorEnvelope).code).toBe('forbidden');

    const created = await request(app.getHttpServer())
      .post('/api/v1/knowledge/products')
      .set('x-member-id', 'u-t1-admin')
      .send({ storeId: S1, sku: 'K-100', title: '新款连帽卫衣', description: '测试上架商品' })
      .expect(201);
    expect((created.body as DataEnvelope).data).toMatchObject({
      storeId: S1,
      sku: 'K-100',
      tenantId: T1,
    });
  });

  it('takes knowledge out of service and back, and a 停用 row stops being a candidate', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/knowledge/products')
      .set('x-member-id', 'u-t1-admin')
      .send({
        storeId: S1,
        sku: 'K-200',
        title: '停用测试防雨冲锋衣',
        description: '停用测试防雨冲锋衣的描述',
      })
      .expect(201);
    const productId = String(
      ((created.body as DataEnvelope).data as Record<string, unknown>)['id'],
    );

    /** The source ids the deterministic engine offers for one query. */
    const offeredSources = async (query: string): Promise<ReadonlyArray<string>> => {
      const suggested = await request(app.getHttpServer())
        .post('/api/v1/retrieval/suggestions')
        .set('x-member-id', 'u-t1-agent-1')
        .send({ conversationId: 'conversation-acme-2', query })
        .expect(201);
      const data = (suggested.body as DataEnvelope).data as Record<string, unknown>;
      return (data['candidates'] as Array<Record<string, unknown>>).map((candidate) =>
        String(candidate['sourceId']),
      );
    };

    // In service: it is candidate material.
    expect(await offeredSources('停用测试防雨冲锋衣')).toContain(productId);

    const disabled = await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/products/${productId}`)
      .set('x-member-id', 'u-t1-admin')
      .send({ enabled: false })
      .expect(200);
    expect((disabled.body as DataEnvelope).data).toMatchObject({
      id: productId,
      enabled: false,
      title: '停用测试防雨冲锋衣',
    });

    // 停用, not deleted: the management read still answers with the row, which
    // is what lets the console show it and put it back.
    const listed = await request(app.getHttpServer())
      .get('/api/v1/knowledge/products')
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const rows = (listed.body as DataEnvelope).data as Array<Record<string, unknown>>;
    expect(rows.find((row) => row['id'] === productId)?.['enabled']).toBe(false);

    // ...and it is no longer offered as a source.
    expect(await offeredSources('停用测试防雨冲锋衣')).not.toContain(productId);

    // A patch names what changes: the fields it omits keep their value, so a
    // rename does not put the entry back in service.
    const retitled = await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/products/${productId}`)
      .set('x-member-id', 'u-t1-admin')
      .send({ title: '停用测试防雨冲锋衣（改名）' })
      .expect(200);
    expect((retitled.body as DataEnvelope).data).toMatchObject({
      sku: 'K-200',
      enabled: false,
      title: '停用测试防雨冲锋衣（改名）',
    });

    // Putting it back is the same call with the other value.
    await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/products/${productId}`)
      .set('x-member-id', 'u-t1-admin')
      .send({ enabled: true })
      .expect(200);
    expect(await offeredSources('停用测试防雨冲锋衣')).toContain(productId);
  });

  it('refuses a knowledge change an agent may not make, an empty patch, and a foreign tenant', async () => {
    const agentAttempt = await request(app.getHttpServer())
      .patch('/api/v1/knowledge/products/product-acme-black-xl')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ title: '客服改的标题' })
      .expect(403);
    expect((agentAttempt.body as ErrorEnvelope).code).toBe('forbidden');

    // A patch that names no field would be a write that only moves `updated_at`,
    // which the audit trail would read as a change nothing made.
    const empty = await request(app.getHttpServer())
      .patch('/api/v1/knowledge/products/product-acme-black-xl')
      .set('x-member-id', 'u-t1-admin')
      .send({})
      .expect(400);
    expect((empty.body as ErrorEnvelope).code).toBe('bad_request');

    await request(app.getHttpServer())
      .patch('/api/v1/knowledge/products/product-does-not-exist')
      .set('x-member-id', 'u-t1-admin')
      .send({ title: '无此商品' })
      .expect(404);

    // The platform administrator narrowed to another tenant cannot reach this
    // tenant's row, and is told it does not exist rather than that it is denied.
    const foreign = await request(app.getHttpServer())
      .patch('/api/v1/knowledge/products/product-acme-black-xl')
      .set('x-tenant-id', 'tenant-beta')
      .send({ title: '越权改名' })
      .expect(404);
    expect((foreign.body as ErrorEnvelope).code).toBe('not_found');
  });

  it('generates source-aware suggestions and persists the suggestion set', async () => {
    const suggested = await request(app.getHttpServer())
      .post('/api/v1/retrieval/suggestions')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ conversationId: 'conversation-acme-2', query: '白色 M 现货' })
      .expect(201);
    const set = (suggested.body as DataEnvelope).data as Record<string, unknown>;
    expect(set['conversationId']).toBe('conversation-acme-2');
    expect(set['provider']).toBe('none');
    const candidates = set['candidates'] as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toMatchObject({ kind: 'product', tenantId: T1, storeId: S1, rank: 1 });
    expect(set['fallbackReasons']).toContain('no_generation_provider');

    const fetched = await request(app.getHttpServer())
      .get(`/api/v1/retrieval/suggestions/${String(set['id'])}`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    expect((fetched.body as DataEnvelope).data).toMatchObject({ id: set['id'] });
  });

  it('records stable fallback reasons when the query is empty', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/retrieval/suggestions')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ conversationId: 'conversation-acme-2', query: '' })
      .expect(201);
    const set = (response.body as DataEnvelope).data as Record<string, unknown>;
    expect(set['candidates']).toEqual([]);
    expect(set['fallbackReasons']).toContain('empty_query');
  });

  it('exposes the review policy and only the platform administrator may change it', async () => {
    const policy = await request(app.getHttpServer()).get('/api/v1/review/policy').expect(200);
    expect((policy.body as DataEnvelope).data).toMatchObject({
      scope: 'platform',
      requireReview: true,
    });

    const denied = await request(app.getHttpServer())
      .patch('/api/v1/review/policy')
      .set('x-member-id', 'u-t1-admin')
      .send({ requireReview: false })
      .expect(403);
    expect((denied.body as ErrorEnvelope).code).toBe('forbidden');

    const updated = await request(app.getHttpServer())
      .patch('/api/v1/review/policy')
      .send({ requireReview: false })
      .expect(200);
    expect((updated.body as DataEnvelope).data).toMatchObject({
      requireReview: false,
      updatedBy: 'u-platform-admin',
    });
  });

  it('refuses a tenant-scoped platform administrator the platform review policy', async () => {
    // The rogue row the `0005` invariant forbids: the platform role held inside
    // a tenant, the same shape a member/account link produced before the
    // migration. It is seeded into the directory and then reached over HTTP, so
    // the request carries exactly the context a resolved session would.
    seedDirectoryMember(app.get(KefuStore), {
      id: 'u-rogue-review-admin',
      tenantId: T1,
      storeId: null,
      role: 'platform_admin',
      username: 'rogue-review-admin',
      displayName: '越权平台管理员',
      enabled: true,
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const before = await request(app.getHttpServer()).get('/api/v1/review/policy').expect(200);
    const policyBefore = (before.body as DataEnvelope).data;

    const denied = await request(app.getHttpServer())
      .patch('/api/v1/review/policy')
      .set('x-member-id', 'u-rogue-review-admin')
      .send({ requireReview: false })
      .expect(403);
    expect((denied.body as ErrorEnvelope).code).toBe('forbidden');

    // The global policy is untouched: the rogue role was refused before the
    // handler could write anything, and it is not demoted to a tenant authority
    // that could still reach it.
    const after = await request(app.getHttpServer()).get('/api/v1/review/policy').expect(200);
    expect((after.body as DataEnvelope).data).toEqual(policyBefore);

    // The genuine platform administrator still owns the policy.
    const updated = await request(app.getHttpServer())
      .patch('/api/v1/review/policy')
      .send({ requireReview: true })
      .expect(200);
    expect((updated.body as DataEnvelope).data).toMatchObject({
      requireReview: true,
      updatedBy: 'u-platform-admin',
    });
  });

  it('approves candidate messages into approved phrases with audit', async () => {
    const queue = await request(app.getHttpServer())
      .get('/api/v1/review/queue')
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    expect(((queue.body as DataEnvelope).data as unknown[]).length).toBe(2);

    const approved = await request(app.getHttpServer())
      .post('/api/v1/review/approve')
      .set('x-member-id', 'u-t1-admin')
      .send({ messageId: 'message-acme-1-4' })
      .expect(201);
    const payload = (approved.body as DataEnvelope).data as Record<string, unknown>;
    expect(payload['message']).toMatchObject({ id: 'message-acme-1-4', reviewState: 'approved' });
    expect(payload['phrase']).toMatchObject({
      approvedBy: 'u-t1-admin',
      sourceMessageId: 'message-acme-1-4',
    });

    const phrases = await request(app.getHttpServer())
      .get('/api/v1/review/phrases')
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    expect(((phrases.body as DataEnvelope).data as unknown[]).length).toBe(2);

    const ineligible = await request(app.getHttpServer())
      .post('/api/v1/review/approve')
      .set('x-member-id', 'u-t1-admin')
      .send({ messageId: 'message-acme-1-1' })
      .expect(400);
    expect((ineligible.body as ErrorEnvelope).code).toBe('bad_request');

    const repeated = await request(app.getHttpServer())
      .post('/api/v1/review/approve')
      .set('x-member-id', 'u-t1-admin')
      .send({ messageId: 'message-acme-1-4' })
      .expect(409);
    expect((repeated.body as ErrorEnvelope).code).toBe('conflict');
  });

  it('returns reports and the audit trail within the tenant', async () => {
    const summary = await request(app.getHttpServer())
      .get('/api/v1/reports/summary')
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const data = (summary.body as DataEnvelope).data as Record<string, unknown>;
    expect(data['conversations']).toMatchObject({ total: 3 });
    expect(data['retention']).toMatchObject({ tenantId: T1 });
    expect(data['review']).toMatchObject({ pending: 1, approvedPhrases: 2 });

    const audit = await request(app.getHttpServer())
      .get('/api/v1/reports/audit')
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const entries = (audit.body as DataEnvelope).data as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry['action'] === 'review.message_approved')).toBe(true);
  });

  it('reports the unconfigured real wecom transport honestly', async () => {
    const overview = await request(app.getHttpServer()).get('/api/v1/channels').expect(200);
    const data = (overview.body as DataEnvelope).data as Record<string, unknown>;
    const providers = data['providers'] as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      provider: 'wecom',
      mode: 'disabled',
      operational: false,
      realTransportConnected: false,
      // This test config sets no WECOM_* variable at all, so the channel is not
      // asked for and holds no credential — a request is never reported as a
      // configured credential.
      enableRequested: false,
      credentialsPresent: false,
      capabilities: {
        receiveText: true,
        receiveImage: true,
        sendText: true,
        sendImage: true,
        sendLink: true,
      },
    });
    expect(providers[0]?.['note']).toContain('credentials are incomplete');

    // The account surface reports the same channel description, so an operator
    // cannot read "disabled" on one page and "operational" on the other.
    const account = await request(app.getHttpServer())
      .get('/api/v1/access/status')
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const accountWecom = ((account.body as DataEnvelope).data as Record<string, unknown>)[
      'wecom'
    ] as Record<string, unknown>;
    expect(accountWecom).toMatchObject({
      provider: 'wecom',
      mode: providers[0]?.['mode'],
      enableRequested: providers[0]?.['enableRequested'],
      credentialsPresent: providers[0]?.['credentialsPresent'],
      operational: providers[0]?.['operational'],
      realTransportConnected: false,
      note: providers[0]?.['note'],
    });

    // Pushing messages to real customers still has no enabled channel behind it.
    const sync = await request(app.getHttpServer()).post('/api/v1/channels/wecom/sync').expect(503);
    expect(sync.body as Envelope).toMatchObject({ code: 'channel_disabled' });

    // A real callback cannot be accepted before the real credential set exists.
    const unsigned = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/webhook')
      .set('x-tenant-id', T1)
      .send({ eventId: 'event-unsigned' })
      .expect(503);
    expect(unsigned.body as Envelope).toMatchObject({ code: 'channel_not_configured' });
  });

  it('files a product under a category and expresses colour and size as variants', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/knowledge/categories')
      .set('x-member-id', 'u-t1-admin')
      .send({ storeId: S1, code: 'apparel', name: '服饰' })
      .expect(201);
    const category = (created.body as DataEnvelope).data as Record<string, unknown>;
    expect(category).toMatchObject({
      tenantId: T1,
      storeId: S1,
      status: 'enabled',
      parentId: null,
    });
    const categoryId = category['id'] as string;

    const declared = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/categories/${categoryId}/attributes`)
      .set('x-member-id', 'u-t1-admin')
      .send({
        attributeCode: 'sleeve',
        attributeName: '袖长',
        valueType: 'enum',
        isSearchable: true,
        allowedValues: ['长袖', '短袖'],
      })
      .expect(201);
    expect((declared.body as DataEnvelope).data).toMatchObject({
      attributeCode: 'sleeve',
      valueType: 'enum',
      isSearchable: true,
      allowedValues: ['长袖', '短袖'],
    });

    // A free-text attribute carries no closed value list, even if one is sent:
    // the list is only meaningful for the two enum kinds.
    const freeText = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/categories/${categoryId}/attributes`)
      .set('x-member-id', 'u-t1-admin')
      .send({
        attributeCode: 'material',
        attributeName: '面料',
        valueType: 'text',
        allowedValues: ['纯棉'],
      })
      .expect(201);
    expect((freeText.body as DataEnvelope).data).toMatchObject({
      valueType: 'text',
      allowedValues: [],
    });

    const product = await request(app.getHttpServer())
      .post('/api/v1/knowledge/spus')
      .set('x-member-id', 'u-t1-admin')
      .send({
        storeId: S1,
        categoryId,
        productCode: 'TS-100',
        title: '纯棉圆领 T 恤',
        sellingPoints: ['100% 纯棉'],
        commonAttributes: { 袖长: '长袖' },
        shelfStatus: 'on_shelf',
      })
      .expect(201);
    const spu = (product.body as DataEnvelope).data as Record<string, unknown>;
    expect(spu).toMatchObject({
      tenantId: T1,
      storeId: S1,
      productCode: 'TS-100',
      categoryId,
      shelfStatus: 'on_shelf',
      sourceType: 'manual',
      commonAttributes: { 袖长: '长袖' },
      sellingPoints: ['100% 纯棉'],
    });
    const spuId = spu['id'] as string;

    const variants: ReadonlyArray<Record<string, unknown>> = [
      { skuCode: 'TS-100-BLK-M', variant: { 颜色: '黑', 尺码: 'M' } },
      { skuCode: 'TS-100-WHT-L', variant: { 颜色: '白', 尺码: 'L' } },
    ];
    const skuIds: string[] = [];
    for (const variant of variants) {
      const sku = await request(app.getHttpServer())
        .post(`/api/v1/knowledge/spus/${spuId}/skus`)
        .set('x-member-id', 'u-t1-admin')
        .send(variant)
        .expect(201);
      const payload = (sku.body as DataEnvelope).data as Record<string, unknown>;
      expect(payload).toMatchObject({
        spuId,
        storeId: S1,
        status: 'active',
        variant: variant['variant'],
      });
      skuIds.push(payload['id'] as string);
    }

    // The product read answers with its variants: one product, two things sold.
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/spus/${spuId}`)
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const { spu: readSpu, skus } = (detail.body as DataEnvelope).data as {
      spu: Record<string, unknown>;
      skus: Array<Record<string, unknown>>;
    };
    expect(readSpu['id']).toBe(spuId);
    expect(skus.map((sku) => sku['skuCode'])).toEqual(['TS-100-BLK-M', 'TS-100-WHT-L']);

    const filtered = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/spus?categoryId=${categoryId}`)
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    expect(
      ((filtered.body as DataEnvelope).data as Array<Record<string, unknown>>).some(
        (item) => item['id'] === spuId,
      ),
    ).toBe(true);

    // Unfiling the product and taking it off the shelf: both are states, not
    // deletions, and the fields the patch does not name keep their values.
    const shelfChanged = await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/spus/${spuId}`)
      .set('x-member-id', 'u-t1-admin')
      .send({ categoryId: null, shelfStatus: 'off_shelf' })
      .expect(200);
    expect((shelfChanged.body as DataEnvelope).data).toMatchObject({
      id: spuId,
      categoryId: null,
      shelfStatus: 'off_shelf',
      title: '纯棉圆领 T 恤',
    });

    const withdrawn = await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/skus/${skuIds[0]}`)
      .set('x-member-id', 'u-t1-admin')
      .send({ status: 'inactive' })
      .expect(200);
    expect((withdrawn.body as DataEnvelope).data).toMatchObject({
      skuCode: 'TS-100-BLK-M',
      status: 'inactive',
    });

    const afterWithdrawal = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/spus/${spuId}`)
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const listedSkus = (
      (afterWithdrawal.body as DataEnvelope).data as {
        skus: Array<Record<string, unknown>>;
      }
    ).skus;
    // A withdrawn variant stays on the list so the console can put it back.
    expect(listedSkus.length).toBe(2);
    expect(listedSkus.find((sku) => sku['id'] === skuIds[0])?.['status']).toBe('inactive');
  });

  it('refuses catalogue writes outside the caller scope', async () => {
    const own = await request(app.getHttpServer())
      .post('/api/v1/knowledge/categories')
      .set('x-member-id', 'u-t1-admin')
      .send({ storeId: S1, code: 'scope-check', name: '范围校验' })
      .expect(201);
    const categoryId = ((own.body as DataEnvelope).data as Record<string, unknown>)['id'] as string;

    // Another tenant asking for the same id is answered as if it did not exist.
    const foreignRead = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/categories/${categoryId}`)
      .set('x-tenant-id', 'tenant-beta')
      .expect(404);
    expect((foreignRead.body as ErrorEnvelope).code).toBe('not_found');

    // A category tree is store-scoped: a product of another store cannot be
    // filed under it.
    const crossStore = await request(app.getHttpServer())
      .post('/api/v1/knowledge/spus')
      .set('x-member-id', 'u-t1-admin')
      .send({
        storeId: 'store-acme-distribution',
        categoryId,
        productCode: 'TS-200',
        title: '跨店挂靠',
      })
      .expect(400);
    expect((crossStore.body as ErrorEnvelope).code).toBe('bad_request');

    const missingCategory = await request(app.getHttpServer())
      .post('/api/v1/knowledge/spus')
      .set('x-member-id', 'u-t1-admin')
      .send({
        storeId: S1,
        categoryId: 'category-does-not-exist',
        productCode: 'TS-201',
        title: '不存在的类目',
      })
      .expect(404);
    expect((missingCategory.body as ErrorEnvelope).code).toBe('not_found');

    // An agent reads knowledge but does not configure it.
    const agentWrite = await request(app.getHttpServer())
      .post('/api/v1/knowledge/spus')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ storeId: S1, productCode: 'TS-202', title: '坐席建品' })
      .expect(403);
    expect((agentWrite.body as ErrorEnvelope).code).toBe('forbidden');

    const spu = await request(app.getHttpServer())
      .post('/api/v1/knowledge/spus')
      .set('x-member-id', 'u-t1-admin')
      .send({ storeId: S1, productCode: 'TS-203', title: '空补丁' })
      .expect(201);
    const spuId = ((spu.body as DataEnvelope).data as Record<string, unknown>)['id'] as string;

    const emptyPatch = await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/spus/${spuId}`)
      .set('x-member-id', 'u-t1-admin')
      .send({})
      .expect(400);
    expect((emptyPatch.body as ErrorEnvelope).code).toBe('bad_request');

    const agentPatch = await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/spus/${spuId}`)
      .set('x-member-id', 'u-t1-agent-1')
      .send({ shelfStatus: 'off_shelf' })
      .expect(403);
    expect((agentPatch.body as ErrorEnvelope).code).toBe('forbidden');
  });

  it('collects the ways one question is asked, and stops using one on its own', async () => {
    const faqId = 'faq-acme-shrink';

    const generated = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/faqs/${faqId}/variants`)
      .set('x-member-id', 'u-t1-admin')
      .send({ questionText: '会不会缩水', source: 'generated' })
      .expect(201);
    const variant = (generated.body as DataEnvelope).data as Record<string, unknown>;
    expect(variant).toMatchObject({
      tenantId: T1,
      faqId,
      questionText: '会不会缩水',
      source: 'generated',
      status: 'enabled',
    });
    const variantId = variant['id'] as string;

    // A near-question sent without an origin is recorded as typed by a person,
    // not as generated: the default has to be the claim that is hardest to be
    // wrong about.
    const typed = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/faqs/${faqId}/variants`)
      .set('x-member-id', 'u-t1-admin')
      .send({ questionText: '洗了会不会变小' })
      .expect(201);
    expect((typed.body as DataEnvelope).data).toMatchObject({ source: 'manual' });

    const listed = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/faqs/${faqId}/variants`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    expect((listed.body as DataEnvelope).data).toHaveLength(2);

    const disabled = await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/faq-variants/${variantId}`)
      .set('x-member-id', 'u-t1-admin')
      .send({ status: 'disabled' })
      .expect(200);
    expect((disabled.body as DataEnvelope).data).toMatchObject({
      questionText: '会不会缩水',
      status: 'disabled',
      source: 'generated',
    });
    // Switching one off leaves the FAQ's other phrasings in use.
    const afterDisable = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/faqs/${faqId}/variants`)
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    expect((afterDisable.body as DataEnvelope).data).toHaveLength(2);

    const agentWrite = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/faqs/${faqId}/variants`)
      .set('x-member-id', 'u-t1-agent-1')
      .send({ questionText: '坐席加词' })
      .expect(403);
    expect((agentWrite.body as ErrorEnvelope).code).toBe('forbidden');

    const missingFaq = await request(app.getHttpServer())
      .post('/api/v1/knowledge/faqs/faq-does-not-exist/variants')
      .set('x-member-id', 'u-t1-admin')
      .send({ questionText: '孤儿词' })
      .expect(404);
    expect((missingFaq.body as ErrorEnvelope).code).toBe('not_found');

    const emptyPatch = await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/faq-variants/${variantId}`)
      .set('x-member-id', 'u-t1-admin')
      .send({})
      .expect(400);
    expect((emptyPatch.body as ErrorEnvelope).code).toBe('bad_request');

    // Another tenant's FAQ is out of scope for a write and invisible to a read.
    const foreignFaq = await request(app.getHttpServer())
      .post('/api/v1/knowledge/faqs/faq-beta-shipping/variants')
      .set('x-member-id', 'u-t1-admin')
      .send({ questionText: '跨租户加词' })
      .expect(404);
    expect((foreignFaq.body as ErrorEnvelope).code).toBe('not_found');
  });

  it('keeps an honest record of an import, including the lines it could not take', async () => {
    const opened = await request(app.getHttpServer())
      .post('/api/v1/knowledge/import-batches')
      .set('x-member-id', 'u-t1-admin')
      .send({
        storeId: S1,
        sourceType: 'csv',
        fileObjectKey: 'imports/2026-09/acme-t3.csv',
        fileSha256: 'b'.repeat(64),
      })
      .expect(201);
    const batch = (opened.body as DataEnvelope).data as Record<string, unknown>;
    expect(batch).toMatchObject({
      tenantId: T1,
      storeId: S1,
      sourceType: 'csv',
      status: 'uploaded',
      totalRows: 0,
      successRows: 0,
      failedRows: 0,
      startedAt: null,
      finishedAt: null,
      // The author comes from the authenticated member, not from the body.
      createdBy: 'u-t1-admin',
    });
    const batchId = batch['id'] as string;

    const recorded = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/import-batches/${batchId}/errors`)
      .set('x-member-id', 'u-t1-admin')
      .send({
        errors: [
          { rowNumber: 7, fieldName: 'sku', errorCode: 'sku_duplicate', rawValueMasked: 'TS-0**' },
          { rowNumber: 3, errorCode: 'price_missing', errorMessage: '价格为空' },
        ],
      })
      .expect(201);
    expect((recorded.body as DataEnvelope).data).toHaveLength(2);

    const moved = await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/import-batches/${batchId}`)
      .set('x-member-id', 'u-t1-admin')
      .send({
        status: 'partial_failed',
        totalRows: 400,
        successRows: 398,
        failedRows: 2,
        finishedAt: '2026-09-14T08:30:00.000Z',
      })
      .expect(200);
    expect((moved.body as DataEnvelope).data).toMatchObject({
      status: 'partial_failed',
      totalRows: 400,
      successRows: 398,
      failedRows: 2,
      finishedAt: '2026-09-14T08:30:00.000Z',
      fileSha256: 'b'.repeat(64),
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/import-batches/${batchId}`)
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const payload = (detail.body as DataEnvelope).data as {
      batch: Record<string, unknown>;
      errors: Array<Record<string, unknown>>;
    };
    expect(payload.batch['status']).toBe('partial_failed');
    // Ordered by the line an operator has to open the sheet and look at.
    expect(payload.errors.map((item) => item['rowNumber'])).toEqual([3, 7]);
    expect(payload.errors[0]).toMatchObject({
      batchId,
      rowNumber: 3,
      fieldName: null,
      errorCode: 'price_missing',
      errorMessage: '价格为空',
    });

    // A row number is a line in a file: `0` is not a line, and a report that
    // named one would send an operator to nowhere.
    const zeroRow = await request(app.getHttpServer())
      .post(`/api/v1/knowledge/import-batches/${batchId}/errors`)
      .set('x-member-id', 'u-t1-admin')
      .send({ errors: [{ rowNumber: 0, errorCode: 'nonsense' }] })
      .expect(400);
    expect((zeroRow.body as ErrorEnvelope).code).toBe('bad_request');

    const badSource = await request(app.getHttpServer())
      .post('/api/v1/knowledge/import-batches')
      .set('x-member-id', 'u-t1-admin')
      .send({ storeId: S1, sourceType: 'pdf' })
      .expect(400);
    expect((badSource.body as ErrorEnvelope).code).toBe('bad_request');

    const agentWrite = await request(app.getHttpServer())
      .post('/api/v1/knowledge/import-batches')
      .set('x-member-id', 'u-t1-agent-1')
      .send({ storeId: S1, sourceType: 'csv' })
      .expect(403);
    expect((agentWrite.body as ErrorEnvelope).code).toBe('forbidden');
  });

  it('shows every store the merchant-level shortcuts and only its own store-level ones', async () => {
    const merchantWide = await request(app.getHttpServer())
      .post('/api/v1/knowledge/shortcuts')
      .set('x-member-id', 'u-t1-admin')
      .send({
        storeId: null,
        code: 'welcome',
        title: '欢迎语',
        content: '您好，很高兴为您服务。',
        sortOrder: 1,
      })
      .expect(201);
    const welcome = (merchantWide.body as DataEnvelope).data as Record<string, unknown>;
    expect(welcome).toMatchObject({
      tenantId: T1,
      scopeType: 'tenant',
      storeId: null,
      sortOrder: 1,
    });

    const own = await request(app.getHttpServer())
      .post('/api/v1/knowledge/shortcuts')
      .set('x-member-id', 'u-t1-admin')
      .send({
        storeId: S1,
        code: 'delivery',
        title: '本店发货时效',
        content: '下单后 48 小时内发货。',
      })
      .expect(201);
    expect((own.body as DataEnvelope).data).toMatchObject({ scopeType: 'store', storeId: S1 });

    // A different store of the same merchant sees the merchant-level phrase and
    // not the flagship's own.
    const distributionList = await request(app.getHttpServer())
      .get('/api/v1/knowledge/shortcuts')
      .query({ storeId: 'store-acme-distribution' })
      .set('x-member-id', 'u-t1-admin')
      .expect(200);
    const codes = (
      (distributionList.body as DataEnvelope).data as Array<Record<string, unknown>>
    ).map((item) => item['code']);
    expect(codes).toContain('welcome');
    expect(codes).not.toContain('delivery');

    // An agent of the flagship may read the merchant-level phrase, because it is
    // not another store's: `storeId: null` is in everyone's scope.
    const read = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/shortcuts/${welcome['id'] as string}`)
      .set('x-member-id', 'u-t1-agent-1')
      .expect(200);
    expect((read.body as DataEnvelope).data).toMatchObject({ code: 'welcome' });

    // Omitting the field is refused rather than read as either scope: a caller
    // who forgot it must not silently get the wider one.
    const omitted = await request(app.getHttpServer())
      .post('/api/v1/knowledge/shortcuts')
      .set('x-member-id', 'u-t1-admin')
      .send({ code: 'ambiguous', title: '没写范围', content: '内容' })
      .expect(400);
    expect((omitted.body as ErrorEnvelope).code).toBe('bad_request');

    // The scope is not patchable, so the change that moves a phrase between a
    // store and the whole merchant is not expressible here.
    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/shortcuts/${welcome['id'] as string}`)
      .set('x-member-id', 'u-t1-admin')
      .send({ intentCode: 'greeting', sortOrder: 5 })
      .expect(200);
    expect((patched.body as DataEnvelope).data).toMatchObject({
      code: 'welcome',
      scopeType: 'tenant',
      storeId: null,
      intentCode: 'greeting',
      sortOrder: 5,
    });
  });
});
