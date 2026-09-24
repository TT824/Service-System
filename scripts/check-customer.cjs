'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Prove the customer page actually talks to the platform, without a browser.
 *
 * There is no browser driver in this repo, and "it renders" is not evidence that
 * anything reached the server. So this runs the page's own JavaScript in jsdom
 * against the running API and Vite dev server, and reports what the page ends
 * up showing:
 *
 *   - a message typed into the form arrives in the database, verbatim;
 *   - a seat's reply, sent through the console's own endpoint, shows up on the
 *     page without a reload — and is attributed to the seat, whether it was
 *     typed or picked from a candidate;
 *   - the platform's offline auto-reply is a bubble on the seat's side, but is
 *     signed as an automatic reply, never as a person;
 *   - reopening the page resumes the same conversation on its own.
 *
 * jsdom has no `fetch`, so one is supplied that resolves relative URLs against
 * the document — the same thing a browser does, which is why the page can use
 * `/api/v1/...` and never sees a cross-origin request.
 *
 * It writes to the database: every run adds a message to the conversation of
 * `网页顾客-验收`. That is the point — but it is not a read-only probe.
 *
 * Prerequisites: the API (`npm run dev:api`) and Vite (`npm run dev:web`) are
 * both up, with `AUTH_DEMO_IDENTITY_HEADERS=true` in `.env`.
 *
 * Usage: node scripts/check-customer.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = require('jsdom');

const API = 'http://127.0.0.1:3000/api/v1';
/** The identity the page borrows for reading; see the page's own header note. */
const MEMBER = 'u-t1-agent-2';
/** Its own customer id, so a rehearsal never collides with the real demo. */
const CUSTOMER = '网页顾客-验收';
const QUESTION = '请问这件羽绒服有加大码吗';
const ANSWER = '有的，加大码还有一件，今天下单明天发。';
const PAGE = `http://localhost:5173/customer.html?customer=${encodeURIComponent(CUSTOMER)}`;
const PAGE_FILE = path.resolve(__dirname, '..', 'apps', 'web', 'public', 'customer.html');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Print what the page is showing, and hand back the message nodes.
 *
 * 左＝客服、右＝顾客，和微信里一致；这里按屏幕上的排法写日志，好一眼看出
 * 谁的话跑到了哪一侧。左右本身是 CSS 排的，jsdom 不算布局——这一列只是把
 * 页面自己的 `data-dir` 翻出来，真正的左右还得靠眼睛。
 *
 * @param {string} label - What just happened.
 * @param {object} window - The jsdom window.
 * @returns {Element[]} Rendered `.msg` nodes, in order.
 */
function dump(label, window) {
  const nodes = [...window.document.querySelectorAll('.msg')];
  console.log(`--- ${label}：渲染 ${nodes.length} 条 ---`);
  for (const node of nodes) {
    const side = node.dataset.dir === 'inbound' ? '右' : '左';
    const who = node.querySelector('.label')?.textContent ?? '（无署名）';
    const text = node.querySelector('.bubble')?.textContent ?? '';
    console.log(`  ${side} ${who.padEnd(7)} ${text.replace(/\s+/g, ' ').trim()}`);
  }
  return nodes;
}

/** The signature the page printed above a message, or '' if it printed none. */
function signedAs(node) {
  return node?.querySelector('.label')?.textContent ?? '';
}

/**
 * Open the page in jsdom with a fetch that behaves like the browser's.
 *
 * @param {string} html - The page source.
 * @param {{customer?: string, conversationId?: string}} storage - Pre-seeded localStorage.
 * @returns {object} The jsdom window.
 */
function open(html, storage = {}) {
  const dom = new JSDOM(html, {
    url: PAGE,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (input, init) => fetch(new URL(input, window.location.href).href, init);
      if (storage.customer) window.localStorage.setItem('kefu.demo.customer', storage.customer);
      if (storage.conversationId) {
        window.localStorage.setItem('kefu.demo.conversation', storage.conversationId);
      }
    },
  });
  return dom.window;
}

async function main() {
  const html = fs.readFileSync(PAGE_FILE, 'utf8');
  const window = open(html);
  await sleep(400);

  window.document.getElementById('text').value = QUESTION;
  window.document
    .getElementById('composer')
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1600);
  dump('① 顾客在页面上发了一句', window);

  const conversationId = window.localStorage.getItem('kefu.demo.conversation');
  console.log(`页面记住了会话：${conversationId}`);

  // The seat's side, through the endpoint the console's own send calls.
  //
  // Sent as a candidate pick rather than as typing: 候选直发 is the source that
  // was being drawn as a centered system line on the customer page. Typing it
  // here would exercise manual_typed, which never broke, and would pass either
  // way — a check that cannot fail is not a check.
  const sent = await fetch(`${API}/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-member-id': MEMBER },
    body: JSON.stringify({ content: ANSWER, source: 'direct_candidate' }),
  });
  console.log(`坐席发送：HTTP ${sent.status}`);
  await sleep(2600);
  dump('② 坐席回话之后', window);

  await sleep(4000);
  const nodes = dump('③ 等到派单扫描跑过', window);
  const bodies = nodes.map((node) => node.textContent);
  const status = window.document.getElementById('status');

  // 取*最后*一条含这句话的：这条会话被跑过很多次，库里攒着一堆同样的句子，
  // 从前往后找会捞到上一轮留下的旧消息，那句是手打的，怎么都不会红。
  // 自动回复则要避开刚发的那句，否则匹配到的正是坐席自己。
  const seatsReply = [...nodes].reverse().find((node) => node.textContent.includes(ANSWER));
  const autoReply = nodes.find(
    (node) => signedAs(node) === '客服 · 自动回复' && !node.textContent.includes(ANSWER),
  );

  console.log('');
  console.log(`页面显示顾客那句        : ${bodies.some((text) => text.includes(QUESTION))}`);
  console.log(`页面显示坐席那句        : ${seatsReply !== undefined}`);
  // 这一条对着的就是用户看见的那个 bug：坐席点候选卡回的话被画成了居中系统行。
  // 上面那笔发送特意用了 direct_candidate，所以这条断言真的会红。
  console.log(`坐席候选回复署客服的名  : ${signedAs(seatsReply) === '客服 · 小蓝'}`);
  console.log(`自动回复也当客服消息发  : ${autoReply?.dataset.dir === 'outbound'}`);
  console.log(
    `自动回复不冒用坐席名字  : ${autoReply !== undefined && signedAs(autoReply) !== '客服 · 小蓝'}`,
  );
  console.log(
    `已经没有居中系统行      : ${!nodes.some((node) => node.classList.contains('system'))}`,
  );
  console.log(
    `每条都带头像            : ${nodes.every((node) => node.querySelector('.avatar') !== null)}`,
  );
  console.log(`连接状态                : ${status.dataset.state} / ${status.textContent}`);

  const read = await fetch(`${API}/conversations/${encodeURIComponent(conversationId)}`, {
    headers: { 'x-member-id': MEMBER },
  });
  const stored = (await read.json()).data.messages;
  console.log(
    `气泡数与库里条数一致    : ${nodes.length === stored.length} (${nodes.length}/${stored.length})`,
  );
  console.log(
    `库里那句 === 页面输入的 : ${stored.some((m) => m.direction === 'inbound' && m.content === QUESTION)}`,
  );
  window.close();

  // Reopening: with a conversation already stored, the page must resume it
  // without anything being typed.
  const reopened = open(html, { customer: CUSTOMER, conversationId });
  await sleep(1800);
  const after = dump('④ 刷新页面（没输入任何东西）', reopened);
  console.log(`刷新后自己接上同一条会话: ${after.length === stored.length}`);
  reopened.close();
}

main().catch((error) => {
  console.error(`check-customer: ${error.stack}`);
  process.exitCode = 1;
});
