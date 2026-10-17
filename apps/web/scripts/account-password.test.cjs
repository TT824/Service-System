/**
 * 账号中心「修改密码」与登录失败的提示。
 *
 * 起因是一个真实故障：修改密码的弹窗只做前端格式检查、从不调用后端，操作者因此
 * 以为密码已经改了；用「新密码」登录自然失败，连续失败又触发锁定，于是旧密码也
 * 被拒——看起来像账号坏了。这些用例钉住两件事：修改密码必须真的提交到
 * `POST /auth/password/change`，以及锁定必须说成锁定而不是密码错误。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const ids = ['workspace', 'products', 'knowledge', 'phrases', 'analytics', 'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'];

/**
 * 在 jsdom 里启动完整前端，API 用最小桩替掉。
 *
 * @param {object} overrides - 覆盖桩上的方法，例如 `login` / `changePassword`。
 * @returns 页面上下文与调用记录。
 */
async function boot(overrides = {}) {
  const { JSDOM } = await import('jsdom');
  const markup = read('index.html').replace('<div id="page-root"></div>', `<div id="page-root">${ids.map(id => read(`pages/${id}.html`)).join('')}</div>`);
  const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.structuredClone = structuredClone;
  const calls = { locked: [], changed: [] };
  const session = { access: { role: 'agent', tenantId: 't1', member: { id: 'agent1', displayName: '客服一' } }, account: { id: 'u1', username: 'agent01' } };
  w.KefuApi = {
    hasSession: () => true,
    health: async () => ({}),
    currentSession: async () => session,
    presence: async () => {},
    heartbeat: async () => {},
    directoryTenants: async () => [{ tenant: { id: 't1', name: '测试公司' }, stores: [{ id: 's1', name: '旗舰店' }], members: [] }],
    setWorkspaceTenant: () => {},
    setWorkspaceStore: () => {},
    conversations: async () => [],
    conversation: async () => ({ conversation: null, messages: [], deliveries: [] }),
    suggestions: async () => ({ candidates: [] }),
    assignments: async () => [],
    transferTargets: async () => [],
    exportJobs: async () => [],
    exportConversations: async () => [],
    clearToken: () => {},
    logout: async () => {},
    changePassword: async (current, next) => {
      calls.changed.push([current, next]);
      return { userId: 'u1', revokedSessions: 2 };
    },
    ...overrides,
  };
  w.KefuRealtime = { subscribe: () => () => {} };
  const opened = [];
  try {
    w.eval(read('src/mock-data.js'));
    w.eval(read('src/admin-data.js'));
    w.eval(read('src/app.js'));
    await tick();
    await tick();
    w.alert = message => opened.push(message);
    return { dom, w, calls };
  } catch (error) {
    dom.window.close();
    throw error;
  }
}

/** 打开修改密码弹窗并填入三个字段。 */
function openPasswordForm(w, current, next, confirm) {
  w.document.getElementById('account-change-password').click();
  w.document.getElementById('profile-current-password').value = current;
  w.document.getElementById('profile-new-password').value = next;
  w.document.getElementById('profile-confirm-password').value = confirm;
}

test('修改密码会真的提交到后端，成功后说明其他设备已退出', async () => {
  const { dom, w, calls } = await boot();
  try {
    openPasswordForm(w, 'Admin123456', 'NewPassword123', 'NewPassword123');
    w.document.getElementById('modal-confirm').click();
    await tick();
    await tick();
    assert.deepEqual(calls.changed, [['Admin123456', 'NewPassword123']]);
    assert.match(w.document.getElementById('toast').textContent, /2 个设备的登录已退出/);
    // 成功才关弹窗：提交完不该把操作者留在原地，也不该把他踢下线。
    assert.equal(w.document.getElementById('modal-bg').classList.contains('show'), false);
    assert.equal(w.KefuApi.hasSession(), true);
  } finally {
    dom.window.close();
  }
});

test('前端先拦下不合规的新密码，不浪费一次往返', async () => {
  const cases = [
    ['Admin123456', 'short', 'short', /至少需要 10 个字符/],
    ['Admin123456', 'NewPassword123', 'NewPassword124', /两次输入的新密码不一致/],
    ['Admin123456', 'Admin123456', 'Admin123456', /不能与当前密码相同/],
    ['', 'NewPassword123', 'NewPassword123', /请输入当前密码/],
  ];
  for (const [current, next, confirm, expected] of cases) {
    const { dom, w, calls } = await boot();
    try {
      openPasswordForm(w, current, next, confirm);
      w.document.getElementById('modal-confirm').click();
      await tick();
      assert.match(w.document.getElementById('password-form-error').textContent, expected);
      assert.deepEqual(calls.changed, []);
      assert.equal(w.document.getElementById('modal-bg').classList.contains('show'), true);
      assert.equal(w.document.getElementById('modal-confirm').disabled, false);
    } finally {
      dom.window.close();
    }
  }
});

test('后端拒绝时留在弹窗里说明原因，并恢复可提交', async () => {
  const failure = Object.assign(new Error('Bad Request'), { status: 400, code: 'bad_request' });
  const { dom, w } = await boot({ changePassword: async () => { throw failure; } });
  try {
    openPasswordForm(w, 'WrongCurrent1', 'NewPassword123', 'NewPassword123');
    w.document.getElementById('modal-confirm').click();
    await tick();
    await tick();
    assert.match(w.document.getElementById('password-form-error').textContent, /当前密码不正确/);
    assert.equal(w.document.getElementById('modal-bg').classList.contains('show'), true);
    assert.equal(w.document.getElementById('modal-confirm').disabled, false);
    assert.equal(w.document.getElementById('modal-confirm').textContent, '确认修改');
  } finally {
    dom.window.close();
  }
});

test('账号被锁定时说的是锁定，而不是密码错误', async () => {
  const { dom, w } = await boot({
    hasSession: () => false,
    login: async () => { throw Object.assign(new Error('Unauthorized'), { status: 401, code: 'account_locked' }); },
  });
  try {
    w.document.getElementById('auth-username').value = 'admin';
    w.document.getElementById('auth-secret').value = 'Admin123456';
    w.document.getElementById('auth-submit').click();
    await tick();
    await tick();
    const status = w.document.getElementById('auth-status').textContent;
    assert.match(status, /锁定/);
    assert.match(status, /15 分钟/);
    assert.doesNotMatch(status, /密码错误/);
  } finally {
    dom.window.close();
  }
});
