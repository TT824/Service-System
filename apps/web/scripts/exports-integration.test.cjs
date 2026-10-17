/**
 * 数据导出页的两处口径：下载按钮叫什么、范围提示说了什么。
 *
 * 起因是一个真实误读：顾客口径的第二个产物是名单，按钮却一律写「对话记录」，于是
 * 下载一个没有对话的文件去找对话。这些用例把「按钮名 = 文件内容」钉住，也钉住
 * 工作台带过来的会话确实会被选中。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * 打开导出页：只加载自己的页面片段和 `src/exports.js`，API 用一个最小桩替掉。
 *
 * @param {object} overrides - `jobs` / `conversations` 的替身数据。
 * @returns 页面上下文。
 */
async function openExports(overrides = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(`<div id="page-root">${read('pages/exports.html')}</div>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  const created = [];
  w.KefuApi = {
    directoryTenants: async () => [{ tenant: { id: 't1', name: '测试公司' } }],
    currentSession: async () => ({ access: { role: 'agent', tenantId: 't1', member: { id: 'agent1' } } }),
    exportJobs: async () => overrides.jobs || [],
    exportConversations: async () =>
      overrides.conversations || [{ id: 'c1', title: '林女士', storeId: 's1' }],
    createExport: async (tenantId, input) => {
      created.push([tenantId, input]);
    },
    downloadExport: async () => ({ blob: null, filename: 'f.txt' }),
  };
  w.eval(read('src/exports.js'));
  return { dom, w, created };
}

/** 一次成功的任务行，两个产物都在。 */
const jobOf = (id, scope, label) => ({
  id,
  scope,
  label,
  status: 'succeeded',
  createdAt: '2026-10-05T02:22:00.000Z',
  finishedAt: '2026-10-05T02:22:01.000Z',
  rowCount: 4,
  artifacts: ['xlsx', 'transcript'],
});

test('下载按钮按口径命名：顾客导出给的是名单，只有会话导出才是对话记录', async () => {
  const jobs = [
    jobOf('j1', 'customers', '2026-10-01 至 2026-10-07 的顾客'),
    jobOf('j2', 'conversation', '顾客「林女士」的对话'),
  ];
  const { dom, w } = await openExports({ jobs });
  try {
    await w.ExportPortal.open();
    await tick();
    await tick();
    const rows = [...w.document.querySelectorAll('#export-jobs tbody tr')];
    assert.equal(rows.length, 2);
    const buttonLabels = row => [...row.querySelectorAll('button[data-format]')].map(button => button.textContent);
    assert.deepEqual(buttonLabels(rows[0]), ['Excel', '顾客名单']);
    assert.deepEqual(buttonLabels(rows[1]), ['Excel', '对话记录']);
    // 按钮的 title 也要说清里面有没有对话：只看名字猜不出一个文件长什么样。
    assert.match(rows[0].querySelector('[data-format="transcript"]').title, /不含对话内容/);
    assert.match(rows[1].querySelector('[data-format="transcript"]').title, /每条消息/);
    assert.match(rows[0].textContent, /顾客/);
    assert.match(rows[1].textContent, /会话/);
  } finally {
    dom.window.close();
  }
});

test('导出范围提示说清这一口径的文件里有没有对话', async () => {
  const { dom, w } = await openExports();
  try {
    const hint = () => w.document.getElementById('export-scope-hint').textContent;
    // 默认是顾客口径：必须点明它不含对话，否则就会有人在名单里找聊天内容。
    assert.match(hint(), /不含对话内容/);
    assert.equal(w.document.getElementById('export-conversation-field').hidden, true);

    const scope = w.document.getElementById('export-scope');
    scope.value = 'conversation';
    scope.dispatchEvent(new w.Event('change'));
    assert.match(hint(), /对话记录/);
    assert.equal(w.document.getElementById('export-conversation-field').hidden, false);
    assert.equal(w.document.getElementById('export-customer-fields').hidden, true);
    assert.equal(w.document.getElementById('export-conversation').required, true);

    scope.value = 'customers';
    scope.dispatchEvent(new w.Event('change'));
    assert.equal(w.document.getElementById('export-customer-fields').hidden, false);
    assert.equal(w.document.getElementById('export-conversation').required, false);
  } finally {
    dom.window.close();
  }
});

test('工作台带过来的会话会连范围一起选中，但仍由操作者点创建', async () => {
  const { dom, w, created } = await openExports();
  try {
    w.ExportPortal.prefill({ scope: 'conversation', conversationId: 'c1' });
    await w.ExportPortal.open();
    await tick();
    assert.equal(w.document.getElementById('export-scope').value, 'conversation');
    assert.equal(w.document.getElementById('export-conversation').value, 'c1');
    assert.match(w.document.getElementById('export-notice').textContent, /已选中当前会话/);
    // 跳转不替操作者下单：任务必须由「创建导出任务」产生。
    assert.deepEqual(created, []);

    w.document.getElementById('export-submit').click();
    await tick();
    await tick();
    // 逐字段比对：请求体是在 jsdom 的 realm 里造的，跨 realm 的 deepStrictEqual 会
    // 因为原型不同而失败，与字段内容无关。
    assert.equal(created.length, 1);
    assert.equal(created[0][0], 't1');
    assert.equal(created[0][1].scope, 'conversation');
    assert.equal(created[0][1].conversationId, 'c1');
  } finally {
    dom.window.close();
  }
});

test('日期默认值是上月本日到本日，并按 UTC 自然日送给后端', async () => {
  const { dom, w, created } = await openExports();
  try {
    // 独立算一遍期望值（用日期归一化，而不是 `getUTCMonth() - 1` 那种下标算术），
    // 免得把实现里的同一个算错抄进用例。
    const pad = value => String(value).padStart(2, '0');
    const now = new Date();
    const end = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
    const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 24 * 60 * 60 * 1000);
    const start = `${lastOfPrevMonth.getUTCFullYear()}-${pad(lastOfPrevMonth.getUTCMonth() + 1)}-${pad(
      Math.min(now.getUTCDate(), lastOfPrevMonth.getUTCDate()),
    )}`;

    const from = w.document.getElementById('export-from'), to = w.document.getElementById('export-to');
    assert.equal(from.value, start);
    assert.equal(to.value, end);

    // 默认值必须是这一页真正会用的那个区间：结束日整天都要在内（`T23:59:59.999Z`），
    // 否则「本日」会漏掉今天已经发生的会话。
    await w.ExportPortal.open();
    await tick();
    w.document.getElementById('export-submit').click();
    await tick();
    await tick();
    assert.equal(created.length, 1);
    assert.equal(created[0][1].from, `${start}T00:00:00.000Z`);
    assert.equal(created[0][1].to, `${end}T23:59:59.999Z`);
  } finally {
    dom.window.close();
  }
});

test('上月没有这一天时夹到上月最后一天，1 月跨年，闰年取 2 月 29 日', async () => {
  const { dom, w } = await openExports();
  try {
    // jsdom 的 realm 里造的数组与 Node 的 Array 原型不同，`deepEqual`（strict）会
    // 因此失败，与内容无关，所以先摊成 Node 这边的数组。
    const at = iso => [...w.ExportPortal.defaultRange(new Date(iso))];
    assert.deepEqual(at('2026-10-07T06:00:00.000Z'), ['2026-09-07', '2026-10-07']);
    // UTC 当天 00:00 就算当天，不因为北京时间已经上午 8 点而挪一天。
    assert.deepEqual(at('2026-10-07T00:00:00.000Z'), ['2026-09-07', '2026-10-07']);
    assert.deepEqual(at('2026-03-31T00:00:00.000Z'), ['2026-02-28', '2026-03-31']);
    assert.deepEqual(at('2026-05-31T00:00:00.000Z'), ['2026-04-30', '2026-05-31']);
    assert.deepEqual(at('2026-01-15T00:00:00.000Z'), ['2025-12-15', '2026-01-15']);
    assert.deepEqual(at('2028-03-29T00:00:00.000Z'), ['2028-02-29', '2028-03-29']);
  } finally {
    dom.window.close();
  }
});

test('操作者改过日期后，再次打开导出页不把默认值盖回去', async () => {
  const { dom, w } = await openExports();
  try {
    const from = w.document.getElementById('export-from'), to = w.document.getElementById('export-to');
    assert.notEqual(from.value, '');
    from.value = '2026-01-01';
    to.value = '2026-01-31';
    await w.ExportPortal.open();
    await tick();
    assert.equal(from.value, '2026-01-01');
    assert.equal(to.value, '2026-01-31');
  } finally {
    dom.window.close();
  }
});

test('会话不在当前公司的导出范围内时说清原因，不静默留下空选择', async () => {
  const { dom, w } = await openExports({ conversations: [{ id: 'other', title: '别的会话', storeId: 's2' }] });
  try {
    w.ExportPortal.prefill({ scope: 'conversation', conversationId: 'c1' });
    await w.ExportPortal.open();
    await tick();
    assert.equal(w.document.getElementById('export-conversation').value, '');
    assert.match(w.document.getElementById('export-notice').textContent, /不在当前公司的导出范围内/);
  } finally {
    dom.window.close();
  }
});
