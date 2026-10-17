/**
 * 同事一对一内部会话的前端链路：进联系人 → 开真实会话 → 发送走接口 → 收实时事件补读。
 *
 * 这里用一个假的 KefuApi 和一条手动投递的实时帧模拟「另一个浏览器窗口」，
 * 因为问题恰恰出在两个窗口之间：只测自己发的消息看不出收不到别人的消息。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const SELF = 'u-t1-agent-chen';
const PEER = 'u-t1-agent-wang';
const THREAD = `internal-direct:t1:${SELF}:${PEER}`;

test('colleague 1:1 chat sends through the API and receives the other window\'s frame', async () => {
  const { JSDOM } = await import('jsdom');
  const ids = ['workspace', 'products', 'knowledge', 'phrases', 'analytics', 'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'];
  const markup = read('index.html').replace(
    '<div id="page-root"></div>',
    `<div id="page-root">${ids.map(id => read(`pages/${id}.html`)).join('')}</div>`,
  );
  const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.structuredClone = structuredClone;

  let onFrame = null;
  const inbox = [
    { id: 'm1', tenantId: 't1', threadId: THREAD, senderMemberId: PEER, body: '第一句', createdAt: '2026-10-05T05:00:00.000Z' },
  ];
  const sent = [];
  let readCount = 0;

  w.KefuApi = {
    hasSession: () => true,
    currentSession: async () => ({
      access: { role: 'agent', tenantId: 't1', storeId: 's1', member: { id: SELF, displayName: '陈小雨', tenantId: 't1' } },
      account: { username: 'chenxiaoyu', display_name: '陈小雨' },
    }),
    presence: async () => {},
    heartbeat: async () => {},
    directoryTenants: async () => [{
      tenant: { id: 't1', name: '云集服饰' },
      stores: [{ id: 's1', name: '云集服饰旗舰店', enabled: true }],
      members: [],
    }],
    setWorkspaceTenant: () => {},
    conversations: async () => [],
    internalPeers: async () => [
      { memberId: PEER, displayName: '王一帆', role: 'agent', storeId: 's1' },
    ],
    internalThreads: async () => [{
      thread: { id: THREAD, tenantId: 't1', kind: 'direct', participantMemberIds: [SELF, PEER], createdAt: '2026-10-05T05:00:00.000Z', lastMessageAt: '2026-10-05T05:00:00.000Z' },
      peer: { memberId: PEER, displayName: '王一帆', role: 'agent', storeId: 's1' },
      lastMessage: inbox[inbox.length - 1],
    }],
    internalOpenThread: async () => ({
      thread: { id: THREAD, tenantId: 't1', kind: 'direct', participantMemberIds: [SELF, PEER], createdAt: '2026-10-05T05:00:00.000Z', lastMessageAt: '2026-10-05T05:00:00.000Z' },
      peer: { memberId: PEER, displayName: '王一帆', role: 'agent', storeId: 's1' },
      lastMessage: inbox[inbox.length - 1] ?? null,
    }),
    internalMessages: async () => { readCount++; return inbox.slice(); },
    internalSend: async (threadId, content) => {
      sent.push({ threadId, content });
      const message = { id: `m${inbox.length + 1}`, tenantId: 't1', threadId, senderMemberId: SELF, body: content, createdAt: '2026-10-05T05:10:00.000Z' };
      inbox.push(message);
      return message;
    },
    clearToken: () => {},
    logout: async () => {},
  };
  w.KefuRealtime = { subscribe: (api, frame, state) => { onFrame = frame; state('connected'); return () => { onFrame = null }; } };

  w.eval(read('src/mock-data.js'));
  w.eval(read('src/admin-data.js'));
  w.eval(read('src/app.js'));
  await tick(); await tick(); await tick();

  const $ = id => w.document.getElementById(id);
  w.document.querySelector('[data-queue-mode="contacts"]').click();
  await tick();
  w.document.querySelector('[data-contact-category="team"]').click();
  await tick(); await tick();

  // 联系人里应该是真实同事目录（王一帆），不是演示名单。
  const names = [...w.document.querySelectorAll('#contacts-list .contact-entry-name')].map(node => node.textContent);
  assert.deepEqual(names, ['王一帆']);

  w.document.querySelector('[data-contact-id]').click();
  await tick(); await tick(); await tick();
  assert.match($('group-chat-messages').textContent, /第一句/, '打开会话时应读到服务端历史');

  // 发送：走接口，不是本地演示。
  $('group-chat-reply').value = '收到，我来跟';
  $('group-chat-send').onclick();
  await tick(); await tick();
  assert.deepEqual(sent, [{ threadId: THREAD, content: '收到，我来跟' }]);
  assert.match($('group-chat-messages').textContent, /收到，我来跟/);

  // 另一个窗口发来的消息：实时帧到达后必须回读并渲染出来。
  const before = readCount;
  onFrame({
    event_id: 'e1',
    event_type: 'internal.message.created',
    tenant_id: 't1',
    store_id: null,
    occurred_at: '2026-10-05T05:12:00.000Z',
    data: { thread_id: THREAD, message_id: 'm9', sender_member_id: PEER },
  });
  await tick(); await tick(); await tick();
  assert.ok(readCount > before, '收到事件后应回读 REST 补内容');
  assert.match($('group-chat-messages').textContent, /第一句/);

  // 有消息的同事会话要出现在「我的会话」里，并标明是客服发来的。
  w.document.querySelector('[data-queue-mode="conversations"]').click();
  await tick(); await tick();
  const rows = [...w.document.querySelectorAll('#conversations .conversation')];
  const internal = rows.find(row => row.dataset.internalPeer === PEER);
  assert.ok(internal, '同事会话应出现在「我的会话」列表里');
  assert.equal(internal.querySelector('.role-chip').textContent, '客服');
  // 摘要要写明这条消息是谁发的：最后一条是自己发的就写「我（客服）」，别人发的写「客服 名字」。
  const preview = internal.querySelector('.preview').textContent;
  assert.match(preview, /^(我（客服）|客服 王一帆)：/);
  assert.match(preview, /收到，我来跟/);
  assert.equal(internal.querySelector('.pill').textContent, '内部会话');

  // 点这一行应回到同事会话，而不是跳到客户会话。
  internal.click();
  await tick(); await tick();
  assert.equal($('group-chat-view').hidden, false, '点同事会话行应打开内部会话');
  assert.equal($('group-chat-title').textContent, '王一帆');
  assert.equal(internal.classList.contains('active') || w.document.querySelector('.conversation.internal.active') !== null, true);

  // 同事发来的附件：服务端给的是「怎么读」的签名地址，前端直接画出来——图片内嵌、视频
  // 给播放器、其余给下载链接。正文可以是空的：只有附件也是一条消息。
  const signed = id => `/api/v1/internal-media/${id}?tenant=t1&exp=1&sig=s`;
  inbox.push({
    id: 'm10', tenantId: 't1', threadId: THREAD, senderMemberId: PEER, body: '',
    createdAt: '2026-10-05T05:14:00.000Z',
    attachment: { id: 'a1', kind: 'image', fileName: '对账单.png', mimeType: 'image/png', byteSize: 3, url: signed('m10') },
  });
  inbox.push({
    id: 'm11', tenantId: 't1', threadId: THREAD, senderMemberId: PEER, body: '',
    createdAt: '2026-10-05T05:15:00.000Z',
    attachment: { id: 'a2', kind: 'file', fileName: '对账单.pdf', mimeType: 'application/pdf', byteSize: 9, url: signed('m11') },
  });
  onFrame({
    event_id: 'e2',
    event_type: 'internal.message.created',
    tenant_id: 't1',
    store_id: null,
    occurred_at: '2026-10-05T05:15:00.000Z',
    data: { thread_id: THREAD, message_id: 'm11', sender_member_id: PEER },
  });
  await tick(); await tick(); await tick();
  const image = $('group-chat-messages').querySelector('img.message-image');
  assert.ok(image, '同事发来的图片应内嵌显示');
  assert.equal(image.getAttribute('src'), signed('m10'), '图片要指向服务端签发的读取地址');
  const download = $('group-chat-messages').querySelector('a.message-file');
  assert.ok(download, '同事发来的文件应给下载链接');
  assert.equal(download.getAttribute('download'), '对账单.pdf');
  assert.equal(download.getAttribute('href'), signed('m11'));
  // 正文为空的消息不能把气泡画成空白：图片/文件就在里面。
  const bubbles = [...$('group-chat-messages').querySelectorAll('.bubble')];
  assert.ok(bubbles[bubbles.length - 1].querySelector('a.message-file'), '正文空的消息气泡里应当是那个附件');

  // 只有附件的消息到了「我的会话」列表：摘要不能空着，要说清最后来的是个什么文件。
  w.document.querySelector('[data-queue-mode="conversations"]').click();
  await tick(); await tick();
  const row = [...w.document.querySelectorAll('#conversations .conversation')].find(item => item.dataset.internalPeer === PEER);
  assert.match(row.querySelector('.preview').textContent, /\[文件\] 对账单\.pdf/, '只有附件的消息，摘要要写附件是什么');
});

test('customer conversations are labelled 客户, in the list and on each message', async () => {
  const { JSDOM } = await import('jsdom');
  const ids = ['workspace', 'products', 'knowledge', 'phrases', 'analytics', 'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'];
  const markup = read('index.html').replace(
    '<div id="page-root"></div>',
    `<div id="page-root">${ids.map(id => read(`pages/${id}.html`)).join('')}</div>`,
  );
  const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.structuredClone = structuredClone;
  const row = {
    id: 'c1', tenantId: 't1', storeId: 's1', title: '张女士', status: 'open',
    version: 1, assignedMemberId: SELF, lastMessageAt: '2026-10-05T05:00:00.000Z',
  };
  w.KefuApi = {
    hasSession: () => true,
    currentSession: async () => ({ access: { role: 'agent', tenantId: 't1', member: { id: SELF, displayName: '陈小雨' } }, account: {} }),
    presence: async () => {}, heartbeat: async () => {},
    directoryTenants: async () => [{ tenant: { id: 't1', name: '云集服饰' }, stores: [{ id: 's1', name: '云集服饰旗舰店', enabled: true }], members: [] }],
    setWorkspaceTenant: () => {},
    conversations: async () => [row],
    conversation: async () => ({
      conversation: row, canReply: true,
      messages: [
        { id: 'm1', direction: 'inbound', content: '什么时候发货', createdAt: '2026-10-05T05:00:00.000Z' },
        { id: 'm2', direction: 'outbound', content: '今天就能发', createdAt: '2026-10-05T05:02:00.000Z' },
      ],
      deliveries: [],
    }),
    internalPeers: async () => [], internalThreads: async () => [],
    // 打开会话详情会顺带取候选回复；这里不关心候选，但不能让它在启动链路里抛错。
    suggestions: async () => ({ id: 'set1', candidates: [], fallbackReasons: ['no_generation_provider'] }),
    suggestionDetail: async () => ({ id: 'set1', candidates: [], fallbackReasons: ['no_generation_provider'] }),
    clearToken: () => {}, logout: async () => {},
  };
  w.KefuRealtime = { subscribe: (api, frame, state) => { state('connected'); return () => {}; } };
  w.eval(read('src/mock-data.js'));
  w.eval(read('src/admin-data.js'));
  w.eval(read('src/app.js'));
  await tick(); await tick(); await tick();

  const $ = id => w.document.getElementById(id);
  const rowNode = w.document.querySelector('#conversations .conversation');
  assert.equal(rowNode.querySelector('.role-chip').textContent, '客户');
  // 门店显示名字而不是 store-acme-flagship 这种 ID。
  assert.equal(rowNode.querySelector('.store-chip').textContent, '云集服饰旗舰店');

  const roles = [...$('messages').querySelectorAll('.msg-role')].map(node => node.textContent);
  assert.deepEqual(roles, ['客户', '客服']);
});

test('a frame for a colleague the seat has no thread with does not throw', async () => {
  const { JSDOM } = await import('jsdom');
  const ids = ['workspace', 'products', 'knowledge', 'phrases', 'analytics', 'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'];
  const markup = read('index.html').replace(
    '<div id="page-root"></div>',
    `<div id="page-root">${ids.map(id => read(`pages/${id}.html`)).join('')}</div>`,
  );
  const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.structuredClone = structuredClone;
  let onFrame = null;
  w.KefuApi = {
    hasSession: () => true,
    currentSession: async () => ({ access: { role: 'agent', tenantId: 't1', member: { id: SELF, displayName: '陈小雨' } }, account: {} }),
    presence: async () => {}, heartbeat: async () => {},
    directoryTenants: async () => [{ tenant: { id: 't1', name: '云集服饰' }, stores: [{ id: 's1', name: '旗舰店', enabled: true }], members: [] }],
    setWorkspaceTenant: () => {}, conversations: async () => [],
    internalPeers: async () => [{ memberId: PEER, displayName: '王一帆', role: 'agent', storeId: 's1' }],
    internalThreads: async () => [],
    clearToken: () => {}, logout: async () => {},
  };
  w.KefuRealtime = { subscribe: (api, frame, state) => { onFrame = frame; state('connected'); return () => {}; } };
  w.eval(read('src/mock-data.js'));
  w.eval(read('src/admin-data.js'));
  w.eval(read('src/app.js'));
  await tick(); await tick(); await tick();
  onFrame({ event_id: 'e2', event_type: 'internal.message.created', tenant_id: 't1', store_id: null, occurred_at: '2026-10-05T05:12:00.000Z', data: { thread_id: 'other-thread', message_id: 'm1', sender_member_id: 'u-t1-agent-zhao' } });
  await tick(); await tick();
  assert.ok(true);
});

/**
 * 回复区（工具栏 + 输入框 + 发送按钮）是工作台的固定结构，但它整块挂在「当前有没有
 * 选中的会话」上：`renderMessages` 在没有当前会话时把整个 `.composer` 设为 hidden。
 * 所以一个名下没有客户会话的客服账号登录后，看到的是「当前分类暂无会话」和一块空
 * 白的下半屏 —— 从界面上看就像是回复工具栏被删掉了，而不是没有会话可回。这条测试
 * 把两种状态都钉住，避免下次再把「账号没有会话」当成工具栏回归来排查。
 */
test('the reply composer follows whether the seat actually has a conversation', async () => {
  const boot = async conversations => {
    const { JSDOM } = await import('jsdom');
    const ids = ['workspace', 'products', 'knowledge', 'phrases', 'analytics', 'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'];
    const markup = read('index.html').replace(
      '<div id="page-root"></div>',
      `<div id="page-root">${ids.map(id => read(`pages/${id}.html`)).join('')}</div>`,
    );
    const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    w.structuredClone = structuredClone;
    w.KefuApi = {
      hasSession: () => true,
      currentSession: async () => ({
        access: { role: 'agent', tenantId: 't1', storeId: 's1', member: { id: SELF, displayName: '陈小雨', tenantId: 't1' } },
        account: { username: 'chenxiaoyu', display_name: '陈小雨' },
      }),
      presence: async () => {}, heartbeat: async () => {},
      directoryTenants: async () => [{
        tenant: { id: 't1', name: '云集服饰' },
        stores: [{ id: 's1', name: '云集服饰旗舰店', enabled: true }],
        members: [],
      }],
      setWorkspaceTenant: () => {},
      conversations: async () => conversations,
      conversation: async () => ({
        conversation: conversations[0], canReply: true,
        messages: [
          { id: 'm1', direction: 'inbound', content: '杯子可以刻字吗？', createdAt: '2026-10-05T05:00:00.000Z' },
        ],
        deliveries: [],
      }),
      internalPeers: async () => [], internalThreads: async () => [],
      suggestions: async () => ({ id: 'set1', candidates: [], fallbackReasons: ['no_generation_provider'] }),
      suggestionDetail: async () => ({ id: 'set1', candidates: [], fallbackReasons: ['no_generation_provider'] }),
      clearToken: () => {}, logout: async () => {},
    };
    w.KefuRealtime = { subscribe: (api, frame, state) => { state('connected'); return () => {}; } };
    w.eval(read('src/mock-data.js'));
    w.eval(read('src/admin-data.js'));
    w.eval(read('src/app.js'));
    await tick(); await tick(); await tick();
    return w;
  };

  const row = {
    id: 'demo-conv-chen-zheng', tenantId: 't1', storeId: 's1', title: '郑女士', status: 'open',
    version: 1, assignedMemberId: SELF, lastMessageAt: '2026-10-05T05:00:00.000Z',
  };

  const withWork = await boot([row]);
  const composer = withWork.document.querySelector('#customer-chat-view .composer');
  assert.equal(composer.hidden, false, '有会话时回复区应当整块可见');
  assert.equal(composer.querySelector('.composer-toolbar').hidden, false, '工具栏应当可见');
  assert.equal(composer.querySelectorAll('.tool').length, 8, '工具栏的 8 个回复工具都在');
  assert.equal(withWork.document.getElementById('conversation-empty').hidden, true);

  const idle = await boot([]);
  assert.equal(idle.document.querySelector('#customer-chat-view .composer').hidden, true, '没有会话时回复区整块隐藏');
  assert.equal(idle.document.getElementById('conversation-empty').hidden, false, '此时应当显示空态说明');
});

test('the platform administrator sees internal chats instead of customer conversations', async () => {
  const { JSDOM } = await import('jsdom');
  const ids = ['workspace', 'products', 'knowledge', 'phrases', 'analytics', 'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'];
  const markup = read('index.html').replace(
    '<div id="page-root"></div>',
    `<div id="page-root">${ids.map(id => read(`pages/${id}.html`)).join('')}</div>`,
  );
  const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.structuredClone = structuredClone;

  const PLATFORM = 'u-platform-admin';
  const SEAT = 'u-t1-agent-wang';
  const THREAD = `internal-direct:t1:${PLATFORM}:${SEAT}`;
  const peer = { memberId: SEAT, displayName: '王一帆', role: 'agent', storeId: 's1' };
  const history = {
    id: 'm1', tenantId: 't1', threadId: THREAD, senderMemberId: SEAT,
    body: '这家公司的接待规则想确认一下', createdAt: '2026-10-05T05:11:00.000Z',
  };
  let conversationReads = 0;
  const sent = [];

  w.KefuApi = {
    hasSession: () => true,
    // 平台管理员不属于任何公司：自己的 tenantId 是 null，后端按他选定的租户范围
    // 返回同事目录，所以这里的租户范围是前端先选定、再由 x-tenant-id 带上去的。
    currentSession: async () => ({
      access: { role: 'platform_admin', tenantId: null, storeId: null, member: { id: PLATFORM, displayName: '平台管理员', tenantId: null } },
      account: { username: 'admin', display_name: '平台管理员' },
    }),
    presence: async () => {}, heartbeat: async () => {},
    directoryTenants: async () => [{
      tenant: { id: 't1', name: '云集服饰' },
      stores: [{ id: 's1', name: '云集服饰旗舰店', enabled: true }],
      members: [],
    }],
    setWorkspaceTenant: () => {},
    conversations: async () => { conversationReads += 1; return []; },
    internalPeers: async () => [peer],
    internalThreads: async () => [{
      thread: {
        id: THREAD, tenantId: 't1', kind: 'direct', participantMemberIds: [PLATFORM, SEAT],
        createdAt: '2026-10-05T05:10:00.000Z', lastMessageAt: history.createdAt,
      },
      peer,
      lastMessage: history,
    }],
    internalOpenThread: async () => ({
      thread: {
        id: THREAD, tenantId: 't1', kind: 'direct', participantMemberIds: [PLATFORM, SEAT],
        createdAt: '2026-10-05T05:10:00.000Z', lastMessageAt: history.createdAt,
      },
      peer,
      lastMessage: history,
    }),
    internalMessages: async () => [history],
    internalSend: async (threadId, content) => {
      sent.push({ threadId, content });
      return { id: 'm2', tenantId: 't1', threadId, senderMemberId: PLATFORM, body: content, createdAt: '2026-10-05T05:20:00.000Z' };
    },
    suggestions: async () => ({ id: 'set1', candidates: [], fallbackReasons: ['no_generation_provider'] }),
    suggestionDetail: async () => ({ id: 'set1', candidates: [], fallbackReasons: ['no_generation_provider'] }),
    clearToken: () => {}, logout: async () => {},
  };
  w.KefuRealtime = { subscribe: (api, frame, state) => { state('connected'); return () => {}; } };
  w.eval(read('src/mock-data.js'));
  w.eval(read('src/admin-data.js'));
  w.eval(read('src/app.js'));
  await tick(); await tick(); await tick();

  const $ = id => w.document.getElementById(id);
  // 客户会话一条都不该读：平台管理员拿到也只能只读，不该出现在这个工作台上。
  assert.equal(conversationReads, 0, '平台管理员的工作台不应读取客户会话');

  const rows = [...w.document.querySelectorAll('#conversations .conversation')];
  assert.equal(rows.some(row => row.dataset.id !== undefined && row.dataset.internalPeer === undefined), false, '列表里不应有客户会话行');
  const internal = rows.find(row => row.dataset.internalPeer === SEAT);
  assert.ok(internal, '与客服的内部会话应出现在「我的会话」里，且登录时就已经加载');
  assert.equal($('conversation-empty').hidden, false);
  assert.match($('conversation-empty').textContent, /平台管理员/, '空态要说明这一栏为什么不放客户会话');
  assert.match($('queue-caption').textContent, /云集服饰/, '要写清当前在跟哪家公司的客服说话');

  // 点开就是能发的内部会话，而不是「看得到消息、没有发送」的只读客户会话。
  internal.click();
  await tick(); await tick(); await tick();
  assert.equal($('group-chat-view').hidden, false, '点同事行应打开内部会话');
  assert.equal($('group-chat-title').textContent, '王一帆');
  assert.match($('group-chat-messages').textContent, /这家公司的接待规则想确认一下/);
  assert.equal($('group-chat-reply').hidden, false, '内部会话的输入框应当可见');
  assert.equal($('group-chat-send').hidden, false, '内部会话的发送按钮应当可见');

  $('group-chat-reply').value = '收到，我确认后回复你';
  $('group-chat-send').onclick();
  await tick(); await tick();
  assert.deepEqual(sent, [{ threadId: THREAD, content: '收到，我确认后回复你' }]);
  assert.match($('group-chat-messages').textContent, /收到，我确认后回复你/);
});

test('a sender missing from the directory still gets a name, a role and an openable thread', async () => {
  const { JSDOM } = await import('jsdom');
  const ids = ['workspace', 'products', 'knowledge', 'phrases', 'analytics', 'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'];
  const markup = read('index.html').replace(
    '<div id="page-root"></div>',
    `<div id="page-root">${ids.map(id => read(`pages/${id}.html`)).join('')}</div>`,
  );
  const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.structuredClone = structuredClone;

  const SELF = 'u-t1-agent-chen';
  const PLATFORM = 'u-platform-admin';
  const THREAD = `internal-direct:t1:${PLATFORM}:${SELF}`;
  // 前提就是目录里没有这个人：会话本身给出了他是谁，目录答不上来。旧构建的后端正是这样
  // （同事目录只列本租户成员），目录比会话旧（对方刚入职 / 刚被停用）时也会这样。
  const platformSide = { memberId: PLATFORM, displayName: '平台超级管理员', role: 'platform_admin', storeId: null };
  const inbox = [
    { id: 'm1', tenantId: 't1', threadId: THREAD, senderMemberId: PLATFORM, body: '今天的会话量有多少', createdAt: '2026-10-05T08:37:43.000Z' },
  ];
  let readCount = 0;
  const sent = [];

  w.KefuApi = {
    hasSession: () => true,
    currentSession: async () => ({
      access: { role: 'agent', tenantId: 't1', storeId: 's1', member: { id: SELF, displayName: '陈小雨', tenantId: 't1' } },
      account: { username: 'chenxiaoyu', display_name: '陈小雨' },
    }),
    presence: async () => {}, heartbeat: async () => {},
    directoryTenants: async () => [{
      tenant: { id: 't1', name: '云集服饰' },
      stores: [{ id: 's1', name: '云集服饰旗舰店', enabled: true }],
      members: [],
    }],
    setWorkspaceTenant: () => {},
    conversations: async () => [],
    internalPeers: async () => [{ memberId: 'u-t1-agent-wang', displayName: '王一帆', role: 'agent', storeId: 's1' }],
    internalThreads: async () => [{
      thread: {
        id: THREAD, tenantId: 't1', kind: 'direct', participantMemberIds: [PLATFORM, SELF],
        createdAt: inbox[0].createdAt, lastMessageAt: inbox[0].createdAt,
      },
      peer: platformSide,
      lastMessage: inbox[inbox.length - 1],
    }],
    internalOpenThread: async () => ({
      thread: {
        id: THREAD, tenantId: 't1', kind: 'direct', participantMemberIds: [PLATFORM, SELF],
        createdAt: inbox[0].createdAt, lastMessageAt: inbox[0].createdAt,
      },
      peer: platformSide,
      lastMessage: inbox[inbox.length - 1] ?? null,
    }),
    internalMessages: async () => { readCount += 1; return inbox.slice(); },
    internalSend: async (threadId, content) => {
      sent.push({ threadId, content });
      const message = { id: `m${inbox.length + 1}`, tenantId: 't1', threadId, senderMemberId: SELF, body: content, createdAt: '2026-10-05T08:40:00.000Z' };
      inbox.push(message);
      return message;
    },
    clearToken: () => {}, logout: async () => {},
  };
  w.KefuRealtime = { subscribe: (api, frame, state) => { state('connected'); return () => {}; } };
  w.eval(read('src/mock-data.js'));
  w.eval(read('src/admin-data.js'));
  w.eval(read('src/app.js'));
  await tick(); await tick(); await tick();

  const $ = id => w.document.getElementById(id);
  const internal = [...w.document.querySelectorAll('#conversations .conversation')].find(row => row.dataset.internalPeer === PLATFORM);
  assert.ok(internal, '平台侧发来的会话应出现在「我的会话」里，登录时就该在');
  // 目录里没有他，也必须写出服务端给的名字：显示成「同事」等于没说是谁。
  assert.equal(internal.querySelector('.conversation-name').textContent, '平台超级管理员');
  // 平台管理员不是本公司客服，标注跟着角色走，不写死「客服」。
  const chip = internal.querySelector('.role-chip');
  assert.equal(chip.textContent, '平台管理员');
  assert.match(chip.className, /platform/);
  assert.match(internal.querySelector('.preview').textContent, /^平台管理员 平台超级管理员：/);
  assert.match(internal.querySelector('.preview').textContent, /今天的会话量有多少/);

  // 点开必须真的能开：以前这里会因为目录里找不到人而画出空白面板，看起来就是「点不了」。
  internal.click();
  await tick(); await tick(); await tick();
  assert.equal($('group-chat-view').hidden, false, '点这一行应打开内部会话');
  assert.equal($('group-chat-title').textContent, '平台超级管理员');
  assert.match($('group-chat-messages').textContent, /今天的会话量有多少/);
  assert.equal($('group-chat-reply').hidden, false, '输入框应可见');
  assert.equal($('group-chat-send').hidden, false, '发送按钮应可见');
  const meta = $('group-chat-messages').querySelector('.msg-role');
  assert.equal(meta.textContent, '平台管理员');
  assert.match(meta.className, /platform/);
  assert.ok(readCount > 0, '打开会话应回读全文');

  $('group-chat-reply').value = '今天的会话量是 128 条';
  $('group-chat-send').onclick();
  await tick(); await tick();
  assert.deepEqual(sent, [{ threadId: THREAD, content: '今天的会话量是 128 条' }]);
  assert.match($('group-chat-messages').textContent, /今天的会话量是 128 条/);
});

test('internal composer: the emoji really goes out, an attachment is refused with a reason', async () => {
  const { JSDOM } = await import('jsdom');
  const ids = ['workspace', 'products', 'knowledge', 'phrases', 'analytics', 'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'];
  const markup = read('index.html').replace(
    '<div id="page-root"></div>',
    `<div id="page-root">${ids.map(id => read(`pages/${id}.html`)).join('')}</div>`,
  );
  const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.structuredClone = structuredClone;
  // JSDOM 没有 createObjectURL，而附件预览正是用它生成地址的；这里只要一个字符串。
  w.URL.createObjectURL = () => 'blob:local-draft';
  w.URL.revokeObjectURL = () => {};

  const SELF = 'u-t1-agent-chen';
  const PEER = 'u-t1-agent-wang';
  const THREAD = `internal-direct:t1:${SELF}:${PEER}`;
  const peer = { memberId: PEER, displayName: '王一帆', role: 'agent', storeId: 's1' };
  const history = { id: 'm1', tenantId: 't1', threadId: THREAD, senderMemberId: PEER, body: '第一句', createdAt: '2026-10-05T05:00:00.000Z' };
  const sent = [];

  w.KefuApi = {
    hasSession: () => true,
    currentSession: async () => ({
      access: { role: 'agent', tenantId: 't1', storeId: 's1', member: { id: SELF, displayName: '陈小雨', tenantId: 't1' } },
      account: { username: 'chenxiaoyu', display_name: '陈小雨' },
    }),
    presence: async () => {}, heartbeat: async () => {},
    directoryTenants: async () => [{
      tenant: { id: 't1', name: '云集服饰' },
      stores: [{ id: 's1', name: '云集服饰旗舰店', enabled: true }],
      members: [],
    }],
    setWorkspaceTenant: () => {},
    conversations: async () => [],
    internalPeers: async () => [peer],
    internalThreads: async () => [{
      thread: {
        id: THREAD, tenantId: 't1', kind: 'direct', participantMemberIds: [SELF, PEER],
        createdAt: history.createdAt, lastMessageAt: history.createdAt,
      },
      peer,
      lastMessage: history,
    }],
    internalOpenThread: async () => ({
      thread: {
        id: THREAD, tenantId: 't1', kind: 'direct', participantMemberIds: [SELF, PEER],
        createdAt: history.createdAt, lastMessageAt: history.createdAt,
      },
      peer,
      lastMessage: history,
    }),
    internalMessages: async () => [history],
    internalSend: async (threadId, content, attachmentId) => {
      sent.push({ threadId, content, attachmentId: attachmentId ?? null });
      return { id: `m${sent.length + 1}`, tenantId: 't1', threadId, senderMemberId: SELF, body: content, createdAt: '2026-10-05T05:10:00.000Z' };
    },
    clearToken: () => {}, logout: async () => {},
  };
  w.KefuRealtime = { subscribe: (api, frame, state) => { state('connected'); return () => {}; } };
  w.eval(read('src/mock-data.js'));
  w.eval(read('src/admin-data.js'));
  w.eval(read('src/app.js'));
  await tick(); await tick(); await tick();

  const $ = id => w.document.getElementById(id);
  // 通用项要和客户会话对齐：表情 / 图片 / 视频 / 文件都在（截图、快捷短语、商品链接、
  // 邀请下单是发给客户的工具，内部会话不搬）。
  ['group-emoji-btn', 'group-image-btn', 'group-video-btn', 'group-file-btn'].forEach((id) => {
    assert.ok($(id), `内部会话工具栏缺少 ${id}`);
  });

  w.document.querySelector('[data-queue-mode="contacts"]').click();
  await tick();
  w.document.querySelector('[data-contact-category="team"]').click();
  await tick(); await tick();
  w.document.querySelector('[data-contact-id]').click();
  await tick(); await tick(); await tick();
  assert.equal($('group-chat-view').hidden, false);
  // 一对一且已登录：这条线真的发得出去，标签不能还写着「仅本地演示」。
  assert.equal($('group-composer-pill').textContent, '已接通后端');

  // 表情：点开的是内部会话自己的面板，插进去的也是内部会话的输入框。
  $('group-emoji-btn').onclick();
  assert.equal($('group-emoji-picker').hidden, false, '点表情按钮应打开内部会话的表情面板');
  assert.equal($('emoji-picker').hidden, true, '客户会话的表情面板应同时关掉：两个面板不能一起浮着');
  $('group-emoji-picker').querySelector('button').click();
  assert.equal($('group-chat-reply').value, '😊');
  assert.equal($('reply').value, '', '表情不能插进客户回复框');
  assert.equal($('group-emoji-picker').hidden, true, '选完表情应收起面板');

  // 表情就是文本：它随消息一起真的提交给接口。
  $('group-chat-reply').value += '收到';
  $('group-chat-send').onclick();
  await tick(); await tick();
  assert.deepEqual(sent, [{ threadId: THREAD, content: '😊收到', attachmentId: null }], '纯文字消息不该报一个附件 ID');
  assert.equal($('group-chat-reply').value, '', '发出去之后输入框要清空');

  // 附件：真的上传。选完文件先上传换一个草稿 ID，发送时随消息一起认领——而不是先把文字
  // 发出去、把文件悄悄丢掉。这里用假的接口顶掉网络，断言的是前端有没有按两步走。
  const uploads = [];
  w.KefuApi.internalUploadAttachment = async (threadId, file) => {
    uploads.push({ threadId, name: file.name, size: file.size, type: file.type });
    return { id: 'internal-attachment-1', kind: 'image', fileName: file.name, mimeType: file.type, byteSize: file.size };
  };
  const file = new w.File(['x'], '对账单.png', { type: 'image/png' });
  Object.defineProperty($('group-image-file'), 'files', { value: [file], configurable: true });
  $('group-image-file').dispatchEvent(new w.Event('change'));
  await tick(); await tick();
  assert.deepEqual(uploads, [{ threadId: THREAD, name: '对账单.png', size: 1, type: 'image/png' }], '选完文件应立刻上传到本会话的附件接口');
  assert.equal($('group-attachment').hidden, false, '上传成功后应出现待发送附件');
  assert.match($('group-attachment-name').textContent, /图片：对账单\.png/);
  assert.doesNotMatch($('group-attachment-name').textContent, /上传中/, '上传完成后不该还写着上传中');

  $('group-chat-reply').value = '文件在附件里';
  $('group-chat-send').onclick();
  await tick(); await tick();
  assert.deepEqual(sent.at(-1), { threadId: THREAD, content: '文件在附件里', attachmentId: 'internal-attachment-1' }, '发送要把草稿 ID 一起报上去');
  assert.equal($('group-chat-reply').value, '');
  assert.equal($('group-attachment').hidden, true, '发出去之后草稿要清掉，否则下一条会重复带上同一个文件');

  // 只有附件、没有文字也是一条消息：服务端允许，前端不能把它当成空消息拦下来。
  w.KefuApi.internalUploadAttachment = async (threadId, uploaded) => (
    { id: 'internal-attachment-2', kind: 'file', fileName: uploaded.name, mimeType: uploaded.type, byteSize: uploaded.size }
  );
  const doc = new w.File(['y'], '合同.pdf', { type: 'application/pdf' });
  Object.defineProperty($('group-document-file'), 'files', { value: [doc], configurable: true });
  $('group-document-file').dispatchEvent(new w.Event('change'));
  await tick(); await tick();
  $('group-chat-send').onclick();
  await tick(); await tick();
  assert.deepEqual(sent.at(-1), { threadId: THREAD, content: '', attachmentId: 'internal-attachment-2' }, '只有附件时正文是空串，附件 ID 照报');

  // 上传失败：原因要落到人眼前，且草稿必须撤掉——留一个没有 ID 的草稿，发送时会被服务端
  // 以「附件不存在或已发送」拒绝，而用户以为文件早就选好了。
  w.KefuApi.internalUploadAttachment = async () => {
    const error = new Error('文件超过上限');
    error.details = ['图片不能超过 5242880 字节'];
    throw error;
  };
  const broken = new w.File(['z'], '超清大图.png', { type: 'image/png' });
  Object.defineProperty($('group-image-file'), 'files', { value: [broken], configurable: true });
  $('group-image-file').dispatchEvent(new w.Event('change'));
  await tick(); await tick();
  assert.equal($('group-attachment').hidden, true, '上传失败要把草稿撤掉');
  assert.match($('toast').textContent, /图片不能超过 5242880 字节/, '上传失败的原因要说清');
});
