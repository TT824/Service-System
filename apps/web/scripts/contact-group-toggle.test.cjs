/**
 * 联系人分组标题的展开与收起。
 *
 * 这里盯的是一个「点了没反应」的 bug：登录后团队一栏按门店分组，默认展开，
 * 而当时的展开判断写成了「默认展开 或者 用户点开过」——默认值恒为真，用户的
 * 点击结果被它整个盖掉。所以测试要证明的不只是「第一下能收起」，还有
 * 「收起之后不会被后续的重新渲染自动弹回来」，后者才是用户看到的那个现象。
 *
 * 分组状态只存在浏览器内存里（演示界面），这里也顺带把这条边界钉住：
 * 它与后端无关，切栏目、搜索、重新渲染都不该丢。
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
const STORE = '云集服饰旗舰店';

async function boot() {
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
    presence: async () => {},
    heartbeat: async () => {},
    directoryTenants: async () => [{
      tenant: { id: 't1', name: '云集服饰' },
      stores: [{ id: 's1', name: STORE, enabled: true }],
      members: [],
    }],
    setWorkspaceTenant: () => {},
    conversations: async () => [],
    internalPeers: async () => [{ memberId: PEER, displayName: '王一帆', role: 'agent', storeId: 's1' }],
    internalThreads: async () => [],
    clearToken: () => {},
    logout: async () => {},
  };
  w.KefuRealtime = { subscribe: (api, frame, state) => { state('connected'); return () => {}; } };

  w.eval(read('src/mock-data.js'));
  w.eval(read('src/admin-data.js'));
  w.eval(read('src/app.js'));
  await tick(); await tick(); await tick();

  // 进联系人，再切到指定栏目；每次切换本身都是一次重新渲染，正好用来验证状态会不会被冲掉。
  const openCategory = async category => {
    w.document.querySelector('[data-queue-mode="contacts"]').click();
    await tick();
    w.document.querySelector(`[data-contact-category="${category}"]`).click();
    await tick(); await tick();
  };
  return { w, openCategory };
}

/** 一个分组此刻在画面上是展开还是收起：标题的 aria-expanded 和内容的 hidden 必须一致。 */
function groupState(w, name) {
  const toggle = w.document.querySelector(`#contacts-list .contact-group-toggle[data-group="${name}"]`);
  assert.ok(toggle, `联系人里应当有「${name}」这一组`);
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  assert.equal(toggle.parentElement.querySelector('.contact-group-body').hidden, !expanded,
    `「${name}」的 aria-expanded 与内容是否隐藏不一致`);
  return expanded;
}

function clickGroup(w, name) {
  const toggle = w.document.querySelector(`#contacts-list .contact-group-toggle[data-group="${name}"]`);
  assert.ok(toggle, `联系人里应当有「${name}」这一组`);
  toggle.click();
}

async function search(w, term) {
  w.document.getElementById('contact-search').value = term;
  w.document.getElementById('contact-search').oninput();
  await tick();
}

test('门店分组默认展开，点一下收起且不会被重新渲染弹回来', async () => {
  const { w, openCategory } = await boot();
  await openCategory('team');

  assert.equal(groupState(w, STORE), true, '登录后团队一栏按门店分组，默认展开');

  clickGroup(w, STORE);
  await tick();
  assert.equal(groupState(w, STORE), false, '点一下应当收起');

  clickGroup(w, STORE);
  await tick();
  assert.equal(groupState(w, STORE), true, '再点一下应当展开');

  // 收起之后连过三关：搜索、清空搜索、切走再回来。原来这三步里任何一次重新渲染
  // 都会把它按回默认展开，用户看到的就是「点了没反应」。
  clickGroup(w, STORE);
  await tick();
  assert.equal(groupState(w, STORE), false, '收起');

  await search(w, '王');
  assert.equal(groupState(w, STORE), false, '搜索时这一组仍按用户的意思收起（标题与人数还在，点开就能看）');

  await search(w, '');
  assert.equal(groupState(w, STORE), false, '清空搜索不该把它弹回展开');

  await openCategory('buyers');
  await openCategory('team');
  assert.equal(groupState(w, STORE), false, '切走再切回来，仍然收起');

  clickGroup(w, STORE);
  await tick();
  assert.equal(groupState(w, STORE), true, '再点一次仍能展开');
});

test('没点过的演示分组保持默认收起，点一下就能展开', async () => {
  const { w, openCategory } = await boot();
  // 登录状态下买家分组仍是演示数据，正好用来验证「默认收起」的那一半：
  // 团队一栏全是默认展开的门店分组，测不出这个方向。
  await openCategory('buyers');

  assert.equal(groupState(w, '重点客户'), true, '演示数据里预置展开的分组');
  assert.equal(groupState(w, '最近咨询'), false, '没预置、也没点过的分组应当收起');

  clickGroup(w, '最近咨询');
  await tick();
  assert.equal(groupState(w, '最近咨询'), true, '点一下应当展开');

  clickGroup(w, '重点客户');
  await tick();
  assert.equal(groupState(w, '重点客户'), false, '预置展开的分组也应当能收起');

  // 目标分组被收起过、又用它移人进去时，那一组要拉开给管理员看（见 openContactEditor）。
  await openCategory('team');
  await openCategory('buyers');
  assert.equal(groupState(w, '重点客户'), false, '收起状态要留住');
  assert.equal(groupState(w, '最近咨询'), true, '展开状态也要留住');
});
