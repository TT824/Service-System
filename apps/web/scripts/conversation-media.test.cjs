const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

const PAGE_IDS = ['workspace', 'products', 'knowledge', 'phrases', 'analytics', 'exports', 'admin', 'settings', 'review', 'tenants', 'account', 'login'];

function pageMarkup() {
  return read('index.html').replace(
    '<div id="page-root"></div>',
    `<div id="page-root">${PAGE_IDS.map(id => read(`pages/${id}.html`)).join('')}</div>`,
  );
}

// 客户会话的附件：坐席点发送，字节真的走 POST /conversations/:id/messages/media，而不是
// 像以前那样弹一句「尚未开放」什么也不做。这里用假的 KefuApi 顶掉网络，断言的是前端有
// 没有按约定把字节和来源交出去、有没有把草稿收拾干净，以及客户的图片到底会不会显示出来。
test('conversation media: an attachment really goes out, text beside it does not', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(pageMarkup(), { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  // JSDOM 的窗口不关掉会一直占着心跳和提示条那两个定时器，用例失败时进程就卡住不退出。
  t.after(() => dom.window.close());
  w.structuredClone = structuredClone;
  // JSDOM 没有 createObjectURL，而附件预览正是用它生成地址的；这里只要一个字符串。
  w.URL.createObjectURL = () => 'blob:local-draft';
  w.URL.revokeObjectURL = () => {};

  const conversation = () => ({ id: 'c1', tenantId: 't1', storeId: 's1', title: '测试客户', status: 'claimed', version: 7, assignedMemberId: 'agent1' });
  const media = [];
  let releaseMedia = null;

  w.KefuApi = {
    hasSession: () => true,
    currentSession: async () => ({
      access: { role: 'agent', tenantId: 't1', storeId: 's1', member: { id: 'agent1', displayName: '陈小雨', tenantId: 't1' } },
      account: { username: 'chenxiaoyu', display_name: '陈小雨' },
    }),
    presence: async () => {}, heartbeat: async () => {},
    directoryTenants: async () => [{ tenant: { id: 't1', name: '云集服饰' }, stores: [{ id: 's1', name: '旗舰店', enabled: true }], members: [] }],
    setWorkspaceTenant: () => {},
    conversations: async () => [conversation()],
    conversation: async () => ({ conversation: conversation(), canReply: true, messages: [], deliveries: [] }),
    suggestions: async () => ({ candidates: [], fallbackReasons: [] }),
    suggestionsFor: async () => ({ candidates: [], fallbackReasons: [] }),
    sendMessage: async () => { throw new Error('文字发送不该被调用：这条是附件'); },
    // 上传与发送在服务端是同一次请求，所以这里也只有一个方法。让它停在一个我们自己
    // 放行的 promise 上，好在「发送中」那一刻检查界面。
    sendMediaMessage: async (...args) => {
      media.push(args);
      await new Promise(resolve => { releaseMedia = resolve; });
    },
    clearToken: () => {}, logout: async () => {},
  };
  w.KefuRealtime = { subscribe: (api, frame, state) => { state('connected'); return () => {}; } };
  w.eval(read('src/mock-data.js'));
  w.eval(read('src/admin-data.js'));
  w.eval(read('src/app.js'));
  await settle();

  const $ = id => w.document.getElementById(id);
  const pick = (inputId, file) => {
    Object.defineProperty($(inputId), 'files', { value: [file], configurable: true });
    $(inputId).dispatchEvent(new w.Event('change'));
  };

  // 服务端只收 PNG / JPEG / GIF 与 MP4，而且按内容类型判，不看坐席点的是哪个按钮。
  // 声明成图片却不在清单里的一律拒绝，不能悄悄当成「文件」发出去。
  pick('reply-image-file', { name: '截图.webp', type: 'image/webp', size: 1024 });
  assert.equal($('reply-attachment').hidden, true, 'WebP 图片不能被收下');
  assert.match($('toast').textContent, /格式不支持/);

  pick('reply-document-file', { name: '大文件.pdf', type: 'application/pdf', size: 21 * 1024 * 1024 });
  assert.equal($('reply-attachment').hidden, true, '超过 20 MB 的文件不能被收下');
  assert.match($('toast').textContent, /小于 20 MB/);

  pick('reply-image-file', { name: '对账单.png', type: 'image/png', size: 2048 });
  assert.equal($('reply-attachment').hidden, false, '合法图片应进入草稿');
  assert.match($('reply-attachment-name').textContent, /图片：对账单\.png/);
  // 选择器本身也别再列出服务端会拒的格式，否则坐席被允许选中一个必然失败的 WebP。
  assert.equal($('reply-image-file').getAttribute('accept'), 'image/png,image/jpeg,image/gif');
  assert.equal($('reply-video-file').getAttribute('accept'), 'video/mp4');

  // 附件和文字不能一起发：渠道的媒体消息没有说明文字，服务端也拒收，前端不能先发附件
  // 再把字丢掉。这里要求它拦下来并且什么都不提交。
  $('reply').value = '顺便说一句';
  $('send-btn').click();
  await settle();
  assert.equal(media.length, 0, '附件+文字的发送不该提交');
  assert.match($('toast').textContent, /不能同时带文字/);
  assert.equal($('reply').value, '顺便说一句', '被拦下的文字不能被清掉');

  $('reply').value = '';
  $('send-btn').click();
  await tick();
  assert.equal(media.length, 1, '点发送应提交一次媒体请求');
  assert.equal(media[0][0], 'c1', '提交给当前会话');
  assert.equal(media[0][1].name, '对账单.png', '交出去的是文件本身，不只是预览地址');
  assert.equal(media[0][2], 'manual_typed', '媒体消息没有候选可言，来源记手打');
  assert.match($('reply-attachment-name').textContent, /发送中/, '发送过程中要说清还没到服务端');
  assert.equal($('send-btn').disabled, true, '发送中不能重复提交');
  $('remove-attachment').click();
  assert.equal($('reply-attachment').hidden, false, '发送中的草稿不给撤');
  assert.match($('toast').textContent, /正在发送/);

  releaseMedia();
  await settle();
  assert.equal($('reply-attachment').hidden, true, '发出去的草稿要撤掉，否则下次点发送会再传一遍');
  assert.equal($('send-btn').disabled, false);
  assert.match($('toast').textContent, /附件已写入后端发送队列/);
});

// 客户发来的图片：服务端在详情里给了 media 和这次现签的地址，界面就该把它画出来——
// 这正是「客户发的内容坐席能看到」那半件事。没有签出地址的不画：画一个必然裂掉的图
// 比不画更糟。
test('conversation media: a customer image renders, and its placeholder text does not', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(pageMarkup(), { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  t.after(() => dom.window.close());
  w.structuredClone = structuredClone;
  w.URL.createObjectURL = () => 'blob:local-draft';
  w.URL.revokeObjectURL = () => {};

  const conversation = () => ({ id: 'c1', tenantId: 't1', storeId: 's1', title: '测试客户', status: 'claimed', version: 7, assignedMemberId: 'agent1' });
  const detail = {
    conversation: conversation(),
    canReply: true,
    deliveries: [],
    messages: [
      // 客户发来的图片：服务端记的是 image，但没有文件名（渠道那边没有）。
      { id: 'm1', direction: 'inbound', messageType: 'image', content: '[图片消息]', createdAt: '2026-10-06T02:00:00.000Z', media: { key: 'k1', mimeType: 'image/png', bytes: 10, name: null, providerMediaId: null } },
      // 图片的字节没留下（下载失败之类）：有 media 行却没有这一次的地址，气泡就不该有图。
      { id: 'm2', direction: 'inbound', messageType: 'image', content: '[图片消息]', createdAt: '2026-10-06T02:01:00.000Z', media: { key: 'k2', mimeType: 'image/png', bytes: 10, name: null, providerMediaId: null } },
      // 坐席发出的文档：内容是文件名，媒体就是那份文件。
      { id: 'm3', direction: 'outbound', messageType: 'file', content: '报价单.pdf', createdAt: '2026-10-06T02:02:00.000Z', media: { key: 'k3', mimeType: 'application/pdf', bytes: 20, name: '报价单.pdf', providerMediaId: 'pm1' } },
      { id: 'm4', direction: 'inbound', messageType: 'text', content: '好的谢谢', createdAt: '2026-10-06T02:03:00.000Z', media: null },
    ],
    mediaUrls: { m1: 'https://objects.example/signed/m1', m3: 'https://objects.example/signed/m3' },
  };

  w.KefuApi = {
    hasSession: () => true,
    currentSession: async () => ({
      access: { role: 'agent', tenantId: 't1', storeId: 's1', member: { id: 'agent1', displayName: '陈小雨', tenantId: 't1' } },
      account: { username: 'chenxiaoyu', display_name: '陈小雨' },
    }),
    presence: async () => {}, heartbeat: async () => {},
    directoryTenants: async () => [{ tenant: { id: 't1', name: '云集服饰' }, stores: [{ id: 's1', name: '旗舰店', enabled: true }], members: [] }],
    setWorkspaceTenant: () => {},
    conversations: async () => [conversation()],
    conversation: async () => detail,
    suggestions: async () => ({ candidates: [], fallbackReasons: [] }),
    suggestionsFor: async () => ({ candidates: [], fallbackReasons: [] }),
    clearToken: () => {}, logout: async () => {},
  };
  w.KefuRealtime = { subscribe: (api, frame, state) => { state('connected'); return () => {}; } };
  w.eval(read('src/mock-data.js'));
  w.eval(read('src/admin-data.js'));
  w.eval(read('src/app.js'));
  await settle();

  const $ = id => w.document.getElementById(id);
  const bubbles = [...$('messages').querySelectorAll('.message .bubble')];
  assert.equal(bubbles.length, 4, '四条消息都要画出来');

  const images = $('messages').querySelectorAll('img.message-image');
  assert.equal(images.length, 1, '只有签出地址的那条画图');
  assert.equal(images[0].src, 'https://objects.example/signed/m1');
  assert.equal(bubbles[0].textContent, '', '有图的气泡不该再写一遍「[图片消息]」');
  assert.equal(bubbles[1].textContent, '[图片消息]', '签不出地址的那条回退成服务端存下的占位说明：说清「客户发过一张图」，而不是空着');
  assert.equal(bubbles[1].querySelector('img'), null, '没有可读地址就不画图：画一个必然裂掉的图比不画更糟');

  const link = $('messages').querySelector('a.message-file');
  assert.ok(link, '文档消息要有一个下载入口');
  assert.equal(link.getAttribute('href'), 'https://objects.example/signed/m3');
  assert.equal(link.getAttribute('download'), '报价单.pdf', '下载下来的文件名要用服务端存的那个');
  assert.equal(bubbles[2].textContent, '下载文件：报价单.pdf', '文件名只说一次：气泡正文不该再重复一遍');

  assert.equal(bubbles[3].textContent, '好的谢谢', '普通文字消息不受影响');
});

// api-client 那一层：FormData 的字段名就是接口契约，写错一个字段服务端就按缺省值处理
// （来源变成 other、幂等键变成服务端自己生成的），而这些错在界面上完全看不出来。
test('api client: the media request carries the file, the source and a dedup key', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  t.after(() => dom.window.close());
  const calls = [];
  w.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ data: { id: 'm1' } }) }; };
  w.eval(read('src/api-client.js'));

  const file = new w.File(['x'], '对账单.png', { type: 'image/png' });
  await w.KefuApi.sendMediaMessage('c1', file, 'edited_send');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/conversations/c1/messages/media');
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.body instanceof w.FormData, 'body 必须是 FormData，好让浏览器生成 boundary');
  assert.equal(calls[0].init.headers['content-type'], undefined, 'multipart 的 Content-Type 要留给浏览器');
  assert.equal(calls[0].init.body.get('file').name, '对账单.png');
  assert.equal(calls[0].init.body.get('source'), 'edited_send');
  assert.match(calls[0].init.body.get('dedupKey'), /^frontend-media-c1-\d+-[a-z0-9]+$/);
});
