/**
 * 管理员中心「员工分流」面板的前端行为。
 *
 * 这块面板 2026-10-08 从设置页的「会话分流」整块搬过来（设置页那一块已删掉），行为
 * 一条没改，所以断言也跟着搬，只换了入口和几个 id。它**没有在浏览器里真人点过**——
 * 平台管理员的密码在用户手上（`admin` 的密码已在 CHG-20261005-03 的改密验证里被改掉），
 * 所以这里把脚本能钉住的部分尽量钉住。每条断言各自对着一个「看着像小事、其实是设计
 * 决定」的地方：
 *
 * 1. **客服看不到，而且根本不去读**。读一次拿回 403 只会让页面出现一句读不懂的失败，
 *    而这一块对客服本来就没有可操作的东西。
 * 2. **「实际占比」是照输入框算的，不是服务端算的**：改一个数字占比立刻跟着变，整个
 *    过程一个请求都不发。回服务端算会让「还没保存的值」看起来像「已经保存了」。
 * 3. **保存只提交画出来的那几行**。服务端按名单更新、没提交的保持原值，所以这里传的
 *    是数组而不是整表；停用的席位不提交（它现在不接新会话，权重留着是为了重新启用）。
 * 4. **保存失败不清掉已读到的比例**。清掉之后页面看起来像「没有分流设置」，操作者会
 *    以为是自己把设置弄没了。
 * 5. **比例只留一处入口**：设置页那一块真的没了，且概览里「可参与接待」用的是同一份
 *    服务端数据，不是演示人数。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
/** 等 app.js 里那串 await 走完：登录 → 进管理员中心 → 目录 → 范围 → allSettled → 重画，多层嵌套，多让几次。 */
const settle = async (n = 10) => { for (let i = 0; i < n; i += 1) await tick(); };

const CHEN = 'u-t1-agent-chen';
const WANG = 'u-t1-agent-wang';
const ZHAO = 'u-t1-agent-zhao';

/** 服务端 `GET /assignment/routing` 的一个席位，字段与契约同名（camelCase）。 */
function seat(memberId, extra = {}) {
  return {
    memberId,
    weight: 1,
    configured: false,
    enabled: true,
    status: 'accepting',
    live: true,
    inProgressCount: 2,
    updatedAt: null,
    updatedBy: null,
    ...extra,
  };
}

/** 三个席位：陈小雨与王一帆在线且各 1 分，赵萌已停用（不接新会话，但权重还在）。 */
const SEATS = [
  seat(CHEN),
  seat(WANG, { inProgressCount: 0 }),
  seat(ZHAO, { enabled: false, live: false, status: 'offline', inProgressCount: 5 }),
];

async function boot(options = {}) {
  const { role = 'platform_admin', seats = SEATS, readFails = null, writeFails = null, writeResult = null } = options;
  const { JSDOM } = await import('jsdom');
  const ids = ['workspace', 'products', 'knowledge', 'phrases', 'analytics', 'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'];
  const markup = read('index.html').replace(
    '<div id="page-root"></div>',
    `<div id="page-root">${ids.map(id => read(`pages/${id}.html`)).join('')}</div>`,
  );
  const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.structuredClone = structuredClone;

  const calls = { routing: 0, save: [] };
  w.KefuApi = {
    hasSession: () => true,
    currentSession: async () => ({
      access: { role, tenantId: 't1', storeId: 's1', member: { id: CHEN, displayName: '陈小雨', tenantId: 't1' } },
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
    workspaceTenant: () => 't1',
    conversations: async () => [],
    internalPeers: async () => [],
    internalThreads: async () => [],
    knowledgeProducts: async () => [],
    knowledgeFaqs: async () => [],
    knowledgeShortcuts: async () => [],
    // 渠道那一块不是本轮的对象，给 null 就够了：renderSettingsChannel 对空 overview 是容错的。
    channelsOverview: async () => null,
    // 分流表要显示姓名，而姓名来自服务端成员目录（与比例同一套读取规则）。
    adminMembers: async () => [
      { id: CHEN, displayName: '陈小雨', enabled: true, storeId: 's1' },
      { id: WANG, displayName: '王一帆', enabled: true, storeId: 's1' },
      { id: ZHAO, displayName: '赵萌', enabled: false, storeId: 's1' },
    ],
    adminAccounts: async () => [],
    conversationRouting: async () => {
      calls.routing += 1;
      if (readFails) throw new Error(readFails);
      return { tenantId: 't1', seats };
    },
    saveConversationRouting: async (tenantId, weights) => {
      calls.save.push({ tenantId, weights });
      if (writeFails) throw new Error(writeFails);
      // 默认按「服务端把提交的那几行标成已单独设置」返回，用来验证页面认的是服务端那份。
      return writeResult || {
        tenantId,
        seats: weights.map(entry => seat(entry.member_id, { weight: entry.weight, configured: true, updatedAt: '2026-10-08T08:00:00.000Z', updatedBy: 'u-platform-admin' })),
      };
    },
    clearToken: () => {},
    logout: async () => {},
  };
  w.KefuRealtime = { subscribe: (api, frame, state) => { state('connected'); return () => {}; } };

  w.eval(read('src/mock-data.js'));
  w.eval(read('src/admin-data.js'));
  w.eval(read('src/app.js'));
  // 真实页面里 admin.js 紧跟着 app.js 加载；两个都先同步跑完，再等异步的登录流程。
  w.eval(read('src/admin.js'));
  await settle();

  /** 平台管理员登录后本来就落在管理员中心；再点一次是为了让「客服」那条路径也走到 refreshAccess。 */
  const openAdmin = async () => {
    w.document.querySelector('.nav-item[data-view="admin"]').click();
    await settle();
  };
  const openRouting = async () => {
    await openAdmin();
    w.document.querySelector('.admin-subnav [data-admin-view="routing"]').click();
    await settle();
  };
  return { w, calls, openAdmin, openRouting };
}

const body = w => w.document.querySelector('#admin-routing-body');
const share = (w, memberId) => body(w).querySelector(`[data-routing-share="${memberId}"]`).textContent;
const weightInput = (w, memberId) => body(w).querySelector(`[data-routing-weight="${memberId}"]`);
const typeWeight = (w, memberId, value) => {
  const input = weightInput(w, memberId);
  input.value = value;
  input.dispatchEvent(new w.Event('input'));
};

test('客服看不到员工分流，也不会去读它', async () => {
  const { w, calls, openRouting } = await boot({ role: 'agent' });
  await openRouting();
  assert.equal(w.document.querySelector('#admin-view-routing').hidden, true, '没权限就不该切到这一块');
  assert.equal(w.document.querySelector('#modal-title').textContent, '暂无权限');
  assert.equal(calls.routing, 0, '客服不该请求分流设置：一次必然 403 的读只会把页面弄脏');
  assert.equal(w.document.querySelectorAll('[data-routing-weight]').length, 0);
});

test('设置页不再有「会话分流」这一块：比例只留一处入口', async () => {
  const { w } = await boot();
  assert.equal(w.document.querySelector('#settings-routing-panel'), null, '两页各改一半就等于口径分叉');
  assert.doesNotMatch(w.document.querySelector('#settings').textContent, /会话分流/);
  // 删掉这一块之后设置页本身还得照常打开：剩下的渠道连接与客服账号不能跟着一起坏。
  w.document.querySelector('.nav-item[data-view="settings"]').click();
  await settle();
  // 徽章按**后端下发的角色**算（platform_admin → 平台侧），不是按演示下拉里的 merchant
  assert.equal(w.document.querySelector('#settings-access-badge').textContent, '平台管理员 · 可维护');
  assert.equal(w.document.querySelectorAll('[data-routing-weight]').length, 2, '这一页不该再出现权重输入框');
});

test('平台管理员看到席位表：默认权重写明「未单独设置」，占比照权重算', async () => {
  const { w, calls, openRouting } = await boot();
  await openRouting();
  assert.equal(calls.routing, 1, '进管理员中心时读一次，切到这一块不再重复读');
  assert.equal(w.document.querySelector('#admin-routing-state').textContent, '已启用');
  assert.equal(body(w).querySelectorAll('tr').length, 3);
  assert.match(body(w).textContent, /默认权重（未单独设置）/);
  // 两个在线席位都是权重 1 → 各 50%；赵萌已停用，算进分母会让在线的人看起来分得比实际少
  assert.equal(share(w, CHEN), '50.0%');
  assert.equal(share(w, WANG), '50.0%');
  assert.equal(share(w, ZHAO), '—');
  // 停用的席位不给输入框，权重只读展示（要改先启用）
  assert.equal(weightInput(w, ZHAO), null);
  assert.equal(body(w).querySelectorAll('[data-routing-weight]').length, 2);
  assert.equal(w.document.querySelector('#admin-routing-save').hidden, false);
  // 概览里那一格用的是同一份服务端数据：两个人已启用、在线且权重非 0
  assert.match(w.document.querySelector('#admin-overview-stats').textContent, /可参与接待2 人/);
});

test('改权重，占比立刻跟着变，且整个过程一个请求都不发', async () => {
  const { w, calls, openRouting } = await boot();
  await openRouting();
  typeWeight(w, CHEN, '6');
  typeWeight(w, WANG, '4');
  assert.equal(share(w, CHEN), '60.0%');
  assert.equal(share(w, WANG), '40.0%');
  assert.equal(calls.routing, 1, '占比是照输入框算的，不该为了这一列回服务端');
  assert.equal(calls.save.length, 0, '改输入不等于保存');
  // 清空中间态也不能把「—」画成 0%：没有可算的分母
  typeWeight(w, CHEN, '');
  assert.equal(share(w, CHEN), '—');
  assert.equal(share(w, WANG), '100.0%');
  // 权重 0 是正当值：这一行不参与自动分配，占比就没有它
  typeWeight(w, CHEN, '0');
  assert.equal(share(w, CHEN), '—');
  assert.equal(share(w, WANG), '100.0%');
});

test('保存只提交画出来的那几行，body 是 {member_id, weight}，并写进操作日志', async () => {
  const { w, calls, openRouting } = await boot();
  await openRouting();
  typeWeight(w, CHEN, '6');
  typeWeight(w, WANG, '4');
  w.document.querySelector('#admin-routing-save').click();
  await settle();
  assert.equal(calls.save.length, 1);
  assert.equal(calls.save[0].tenantId, 't1');
  // 过一遍 JSON 再比：这些对象是在 jsdom 那个 realm 里造的，原型与 Node 侧的不是同一个，
  // assert/strict 的 deepEqual 会因此判「结构相同但不是同一个引用」。
  assert.deepEqual(JSON.parse(JSON.stringify(calls.save[0].weights)), [
    { member_id: CHEN, weight: 6 },
    { member_id: WANG, weight: 4 },
  ]);
  assert.ok(!calls.save[0].weights.some(entry => entry.member_id === ZHAO), '停用的席位不提交：服务端按名单更新，它保持原值');
  assert.match(w.document.querySelector('#admin-audit-rows').textContent, /修改分流比例 · 陈小雨 · 1 → 6/);
});

test('保存成功后按服务端返回的整份数据重画，不用本地那份乐观值', async () => {
  const { w, openRouting } = await boot({
    writeResult: {
      tenantId: 't1',
      seats: [
        seat(CHEN, { weight: 6, configured: true, updatedAt: '2026-10-08T08:00:00.000Z', updatedBy: 'u-platform-admin' }),
        seat(WANG, { weight: 4, configured: true, updatedAt: '2026-10-08T08:00:00.000Z', updatedBy: 'u-platform-admin' }),
      ],
    },
  });
  await openRouting();
  typeWeight(w, CHEN, '9'); // 本地改成 9，而服务端回来的是 6 —— 页面必须认服务端那份
  w.document.querySelector('#admin-routing-save').click();
  await settle();
  assert.equal(weightInput(w, CHEN).value, '6');
  assert.match(body(w).textContent, /上次修改/);
  assert.doesNotMatch(body(w).textContent, /默认权重（未单独设置）/);
});

test('小数与负数在浏览器里先被挡下，一个请求都不发', async () => {
  const { w, calls, openRouting } = await boot();
  await openRouting();
  for (const bad of ['-1', '1.5']) {
    typeWeight(w, CHEN, bad);
    w.document.querySelector('#admin-routing-save').click();
    await settle(2);
    assert.equal(w.document.querySelector('#admin-routing-error').textContent, '权重只能填 0 或正整数。');
  }
  assert.equal(calls.save.length, 0);
});

test('保存失败只报错，不把已读到的比例清掉', async () => {
  const { w, openRouting } = await boot({ writeFails: '权重超过上限' });
  await openRouting();
  const before = body(w).textContent;
  typeWeight(w, CHEN, '6'); // 得先真的改一个值：一个数字都没改时这一版连请求都不发
  w.document.querySelector('#admin-routing-save').click();
  await settle();
  assert.equal(w.document.querySelector('#admin-routing-error').textContent, '保存失败：权重超过上限');
  assert.equal(body(w).textContent, before, '表还在、数字没变：清掉会让人以为设置被弄没了');
  assert.equal(body(w).querySelectorAll('[data-routing-weight]').length, 2);
  assert.doesNotMatch(w.document.querySelector('#admin-audit-rows').textContent, /修改分流比例/, '没成功的事不该进操作日志');
});

test('读不到时分流这一块照实说读不到，不铺一份空表', async () => {
  const { w, openRouting } = await boot({ readFails: '服务端拒绝了这次读取' });
  await openRouting();
  assert.equal(w.document.querySelector('#admin-routing-state').textContent, '未读取');
  assert.match(w.document.querySelector('#admin-routing-desc').textContent, /读取失败/);
  assert.match(w.document.querySelector('#admin-routing-error').textContent, /分流比例读取失败/);
  assert.doesNotMatch(body(w).textContent, /默认权重/, '空表会让人以为「还没设置」，而事实是没读到');
  // 概览那一格也不能装作有数据
  assert.match(w.document.querySelector('#admin-overview-stats').textContent, /可参与接待—/);
});
