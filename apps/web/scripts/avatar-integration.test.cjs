/**
 * 头像：换成自己的之后要真的存到服务端，同事在自己的会话里要看到它。
 *
 * 起因是两个真实故障——改了头像刷新就没了（弹窗只把图片挂在本次页面内存里，
 * 从没提交给服务端），以及同事的头像无论怎么改都看不见（内部会话目录里根本没有
 * 这个字段）。这些用例钉住两件事：改头像必须提交到 `POST /auth/avatar`，以及
 * 服务端给的同事头像要出现在联系人、内部会话列表、消息气泡和成员区。
 *
 * 浏览器里那一步（把原图裁成方形再缩放）在 jsdom 里没有真实画布可跑，所以这里用
 * 假的 `Image` 与 canvas 只证明「取到图 → 裁成方形 → 提交上去 → 渲染服务端存下的
 * 那一份」这条链路，裁切本身是否好看仍只能由浏览器验证。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const ids = ['workspace', 'products', 'knowledge', 'phrases', 'analytics', 'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'];

const SELF = 'u-t1-agent-chen';
const PEER = 'u-t1-agent-wang';
const OTHER = 'u-t1-agent-zhao';
const THREAD = `internal-direct:t1:${SELF}:${PEER}`;
/** 服务端目录里同事这张脸，以及当前账号自己那张。 */
const PEER_PNG = 'data:image/png;base64,peer-avatar-bytes';
const SELF_PNG = 'data:image/png;base64,self-avatar-bytes';
/** 上传这一轮由假画布导出的值，也就是前端准备提交的东西。 */
const UPLOADED = 'data:image/webp;base64,uploaded-avatar-bytes';

/**
 * 在 jsdom 里启动完整前端，API 用最小桩替掉。
 *
 * @param {object} overrides - 覆盖桩上的方法，例如 `setAvatar` / `currentSession`。
 * @returns 页面上下文、调用记录以及给同事会话用的收件箱。
 */
async function boot(overrides = {}) {
  const { JSDOM } = await import('jsdom');
  const markup = read('index.html').replace('<div id="page-root"></div>', `<div id="page-root">${ids.map(id => read(`pages/${id}.html`)).join('')}</div>`);
  const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.structuredClone = structuredClone;
  const calls = { avatars: [] };
  const inbox = [
    { id: 'm1', tenantId: 't1', threadId: THREAD, senderMemberId: PEER, body: '第一句', createdAt: '2026-10-05T05:00:00.000Z' },
    { id: 'm2', tenantId: 't1', threadId: THREAD, senderMemberId: SELF, body: '收到', createdAt: '2026-10-05T05:01:00.000Z' },
  ];
  const session = {
    access: { role: 'agent', tenantId: 't1', storeId: 's1', member: { id: SELF, displayName: '陈小雨', tenantId: 't1' } },
    account: { id: 'u1', username: 'chenxiaoyu', display_name: '陈小雨', avatar_url: SELF_PNG },
  };
  w.KefuApi = {
    hasSession: () => true,
    health: async () => ({}),
    currentSession: async () => session,
    presence: async () => {},
    heartbeat: async () => {},
    directoryTenants: async () => [{ tenant: { id: 't1', name: '云集服饰' }, stores: [{ id: 's1', name: '云集服饰旗舰店' }], members: [] }],
    setWorkspaceTenant: () => {},
    setWorkspaceStore: () => {},
    conversations: async () => [],
    conversation: async () => ({ conversation: null, messages: [], deliveries: [] }),
    suggestions: async () => ({ candidates: [] }),
    exportJobs: async () => [],
    exportConversations: async () => [],
    internalPeers: async () => [
      { memberId: PEER, displayName: '王一帆', role: 'agent', storeId: 's1', avatarUrl: PEER_PNG },
      { memberId: OTHER, displayName: '赵梦', role: 'agent', storeId: 's1', avatarUrl: null },
    ],
    internalThreads: async () => [{
      thread: { id: THREAD, tenantId: 't1', kind: 'direct', participantMemberIds: [SELF, PEER], createdAt: '2026-10-05T05:00:00.000Z', lastMessageAt: '2026-10-05T05:01:00.000Z' },
      peer: { memberId: PEER, displayName: '王一帆', role: 'agent', storeId: 's1', avatarUrl: PEER_PNG },
      lastMessage: inbox[inbox.length - 1],
    }],
    internalOpenThread: async () => ({
      thread: { id: THREAD, tenantId: 't1', kind: 'direct', participantMemberIds: [SELF, PEER], createdAt: '2026-10-05T05:00:00.000Z', lastMessageAt: '2026-10-05T05:01:00.000Z' },
      peer: { memberId: PEER, displayName: '王一帆', role: 'agent', storeId: 's1', avatarUrl: PEER_PNG },
      lastMessage: inbox[inbox.length - 1],
    }),
    internalMessages: async () => inbox.slice(),
    internalSend: async () => inbox[inbox.length - 1],
    setAvatar: async avatarUrl => { calls.avatars.push(avatarUrl); return { id: 'u1', avatarUrl }; },
    clearToken: () => {},
    logout: async () => {},
    ...overrides,
  };
  w.KefuRealtime = { subscribe: () => () => {} };
  // jsdom 没有对象地址、没有画布，也没有图片解码：这一层替身只回答「这条链路会不
  // 会被走通」，不回答「图裁得好不好看」——那是浏览器的事。
  w.URL.createObjectURL = () => 'blob:avatar-draft';
  w.URL.revokeObjectURL = () => {};
  const crops = [];
  w.Image = class {
    constructor() { this.naturalWidth = 64; this.naturalHeight = 48; }
    set src(value) { this._src = value; queueMicrotask(() => this.onload && this.onload()); }
    get src() { return this._src; }
  };
  w.HTMLCanvasElement.prototype.getContext = function getContext() {
    // 只留裁切真正用到的四个位置参数：源点、源边长、输出边长。
    return { drawImage: (_image, sx, sy, sw, _sh, _dx, _dy, dw, _dh) => crops.push({ sx, sy, side: sw, edge: dw }) };
  };
  w.HTMLCanvasElement.prototype.toDataURL = function toDataURL(type) { return type === 'image/webp' ? UPLOADED : 'data:image/png;base64,fallback'; };
  try {
    w.eval(read('src/mock-data.js'));
    w.eval(read('src/admin-data.js'));
    w.eval(read('src/app.js'));
    await tick();
    await tick();
    return { dom, w, calls, crops, session };
  } catch (error) {
    dom.window.close();
    throw error;
  }
}

/** 打开「联系人 → 团队」，返回联系人列表。 */
async function openTeamContacts(w) {
  w.document.querySelector('[data-queue-mode="contacts"]').click();
  await tick();
  w.document.querySelector('[data-contact-category="team"]').click();
  await tick();
  await tick();
  return w.document.getElementById('contacts-list');
}

/** 把一张图片交给头像文件框，走的是操作者选完文件那条路。 */
async function chooseAvatar(w, name = 'face.png') {
  const input = w.document.getElementById('profile-avatar-file');
  const file = new w.File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new w.Event('change'));
  await tick();
  await tick();
  await tick();
  return input;
}

test('同事的头像来自服务端目录，出现在联系人与内部会话里', async () => {
  const { dom, w } = await boot();
  try {
    const list = await openTeamContacts(w);
    const peerRow = list.querySelector(`[data-contact-id="${PEER}"]`);
    const otherRow = list.querySelector(`[data-contact-id="${OTHER}"]`);
    assert.equal(peerRow.querySelector('img')?.getAttribute('src'), PEER_PNG, '同事上传过头像，联系人行就该是他的照片');
    assert.equal(otherRow.querySelector('img'), null, '没上传过头像的同事仍然画姓名首字');
    assert.match(otherRow.textContent, /赵/, '首字还在，不能因为没图就空着');

    // 内部会话列表那一行也要有。
    w.document.querySelector('[data-queue-mode="conversations"]').click();
    await tick();
    await tick();
    assert.equal(
      w.document.querySelector(`#conversations [data-internal-peer="${PEER}"] img`)?.getAttribute('src'),
      PEER_PNG,
    );

    // 打开会话：对方那条是自己那张脸，自己那条是当前账号挂在 /auth/session 上的脸。
    w.document.querySelector('[data-queue-mode="contacts"]').click();
    await tick();
    w.document.querySelector('[data-contact-id]').click();
    await tick();
    await tick();
    await tick();
    const bubbles = [...w.document.querySelectorAll('#group-chat-messages .message')];
    assert.equal(bubbles.length, 2);
    assert.equal(bubbles[0].querySelector('img')?.getAttribute('src'), PEER_PNG, '同事发的话配同事的脸');
    assert.equal(bubbles[1].querySelector('img')?.getAttribute('src'), SELF_PNG, '自己发的话配自己的脸');

    // 成员区两位都在，且都带图。
    const members = [...w.document.querySelectorAll('#group-chat-members .group-member img')].map(node => node.getAttribute('src'));
    assert.deepEqual(members.sort(), [PEER_PNG, SELF_PNG].sort());
  } finally {
    dom.window.close();
  }
});

test('改头像裁成方形后提交到服务端，并存下服务端返回的那一份', async () => {
  const { dom, w, calls, crops } = await boot();
  try {
    // 初始是 /auth/session 带回来的那张。
    assert.equal(w.document.getElementById('profile-rail-image').src, SELF_PNG);

    const input = await chooseAvatar(w);

    // 64×48 的原图裁成 48×48：横向留出两边各 8px，不许拉伸成方形。
    assert.deepEqual(crops, [{ sx: 8, sy: 0, side: 48, edge: 48 }]);
    assert.deepEqual(calls.avatars, [UPLOADED], '头像必须提交到服务端，不然刷新就没了');
    assert.equal(w.document.getElementById('profile-rail-image').src, UPLOADED, '界面画的是服务端存下的那一份');
    assert.equal(w.document.getElementById('profile-rail-initial').hidden, true);
    assert.match(w.document.getElementById('toast').textContent, /同事在内部会话里会看到/);
    assert.equal(input.value, '', '选完要清空文件框，同一张图才能再选一次');
  } finally {
    dom.window.close();
  }
});

test('刷新页面后头像还在，因为它是从 /auth/session 读回来的', async () => {
  // 上一轮存下的值由服务端记着，新开的页面只有这一个来源——这正是「刷新就没了」
  // 当初的病因：值只活在内存里，服务端从来没收到过。
  const { dom, w } = await boot({
    currentSession: async () => ({
      access: { role: 'agent', tenantId: 't1', storeId: 's1', member: { id: SELF, displayName: '陈小雨', tenantId: 't1' } },
      account: { id: 'u1', username: 'chenxiaoyu', avatar_url: UPLOADED },
    }),
  });
  try {
    assert.equal(w.document.getElementById('profile-rail-image').src, UPLOADED);
    assert.equal(w.document.getElementById('profile-rail-image').hidden, false);
    assert.equal(w.document.getElementById('profile-rail-initial').hidden, true);
    assert.equal(w.document.getElementById('profile-menu-image').src, UPLOADED);
  } finally {
    dom.window.close();
  }
});

test('服务端拒绝时说清楚原因，且不假装已经存上', async () => {
  const { dom, w } = await boot({
    setAvatar: async () => { throw Object.assign(new Error('Bad Request'), { status: 400, code: 'avatar_invalid' }); },
  });
  try {
    await chooseAvatar(w);

    assert.match(w.document.getElementById('toast').textContent, /不接受这张图片/);
    assert.equal(w.document.getElementById('profile-rail-image').src, SELF_PNG, '被拒绝时界面保持原样');
  } finally {
    dom.window.close();
  }
});

test('查看同事接待的客户会话时，客服气泡画的是那位同事的脸和名字', async () => {
  // 客户会话的消息行不带发送人，只记「谁在接待」（assignedMemberId）。所以客服那一侧
  // 只能按接待人归属——自己接待才是自己，否则同事说过的话会顶着自己的头像和名字。
  const assigned = { id: 'c1', tenantId: 't1', storeId: 's1', title: '测试客户', status: 'claimed', version: 7, assignedMemberId: PEER };
  const { dom, w } = await boot({
    currentSession: async () => ({
      // 管理员能读到同事的会话，但读到的会话是只读的（服务端给 canReply=false）。
      access: { role: 'merchant_admin', tenantId: 't1', storeId: 's1', member: { id: 'u-t1-admin', displayName: '云集管理员', tenantId: 't1' } },
      account: { id: 'u1', username: 'acme-owner', display_name: '云集管理员', avatar_url: SELF_PNG },
    }),
    conversations: async () => [assigned],
    conversation: async () => ({
      conversation: assigned,
      canReply: false,
      messages: [
        { id: 'm1', direction: 'inbound', content: '在吗', createdAt: '2026-10-05T05:00:00.000Z' },
        { id: 'm2', direction: 'outbound', content: '在的', createdAt: '2026-10-05T05:01:00.000Z' },
      ],
      deliveries: [],
    }),
  });
  try {
    // 同事目录是登录引导里后到的一步（会话先画、目录后到），消息区要等它回来再重画。
    await tick();
    await tick();
    await tick();
    const bubbles = [...w.document.querySelectorAll('#messages .message')];
    assert.equal(bubbles.length, 2);
    assert.equal(bubbles[0].querySelector('img'), null, '客户这一侧没有头像可取，仍是首字');
    assert.equal(bubbles[1].querySelector('img')?.getAttribute('src'), PEER_PNG, '客服气泡画接待人那张脸');
    assert.match(bubbles[1].textContent, /王一帆/, '署名也要跟着接待人走，不能写成当前登录者');
    assert.doesNotMatch(bubbles[1].textContent, /云集管理员/);
    // 只读：这块界面不该给出回复入口。
    assert.equal(w.document.querySelector('.composer').hidden, true);
  } finally {
    dom.window.close();
  }
});
