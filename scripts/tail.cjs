'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Watch one conversation the way the customer page does: by polling.
 *
 *   node scripts/tail.cjs                  # the conversation `say.cjs` last used
 *   node scripts/tail.cjs conversation-…   # or one named outright
 *
 * Options: --interval <ms> (default 1500), --once, --member <id>, --api <url>.
 *
 * Polling rather than a push is not a shortcut: under the Mock transport a
 * reply never leaves the process, so the only way the customer side can see it
 * is to ask. This is the same read the browser page will perform.
 *
 * Messages already printed are remembered by id, so re-running it — or leaving
 * it open while the seat works — only ever shows what is new. The platform's
 * offline auto-reply is labelled as such: it is sent by the dispatcher, not by
 * a person, and mistaking one for the other is how a demo goes wrong.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_PATH = path.join(os.tmpdir(), 'kefu-demo-state.json');

const DEFAULTS = {
  member: 'u-t1-agent-2',
  api: 'http://127.0.0.1:3000',
  interval: '1500',
};

/** Text the dispatcher sends when no seat can take the conversation. */
const OFFLINE_REPLY_MARKER = '暂无客服在线';

/**
 * Read the command line into a conversation id plus the options.
 *
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{conversationId: string|null, options: Record<string, string>, once: boolean}} Parsed invocation.
 */
function parseArgs(argv) {
  const options = {};
  let conversationId = null;
  let once = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--once') {
      once = true;
    } else if (token.startsWith('--')) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`option ${token} needs a value`);
      }
      options[token.slice(2)] = value;
      index += 1;
    } else {
      conversationId = token;
    }
  }
  return { conversationId, options, once };
}

/**
 * The conversation `say.cjs` last spoke into.
 *
 * @returns {{conversationId?: string, member?: string, api?: string}} Stored state, empty when absent.
 */
function readState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Label one message the way a person reading the terminal needs it.
 *
 * @param {{direction: string, source?: string, content: string, createdAt?: string}} message - Wire message.
 * @returns {string} One printable line.
 */
function line(message) {
  const who = message.direction === 'inbound' ? '顾客' : '客服';
  const at = (message.createdAt ?? '').slice(11, 19);
  const automated =
    message.direction === 'outbound' &&
    (message.source !== 'manual_typed' || message.content.includes(OFFLINE_REPLY_MARKER));
  const note = automated ? '  ← 平台自动回复（无坐席在线）' : '';
  return `${at}  ${who}  ${message.content}${note}`;
}

async function fetchMessages(api, conversationId, member) {
  const response = await fetch(`${api}/api/v1/conversations/${conversationId}`, {
    headers: { 'x-member-id': member },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  const envelope = await response.json();
  return envelope?.data?.messages ?? [];
}

async function main() {
  const { conversationId: named, options, once } = parseArgs(process.argv.slice(2));
  const state = readState();

  const conversationId = named ?? state.conversationId;
  if (conversationId === undefined || conversationId === null) {
    throw new Error(
      'no conversation to watch — run scripts/say.cjs first, or pass a conversation id',
    );
  }
  const member = options.member ?? state.member ?? DEFAULTS.member;
  const api = (options.api ?? state.api ?? DEFAULTS.api).replace(/\/$/, '');
  const interval = Number(options.interval ?? DEFAULTS.interval);

  console.log(`tail: 看着 ${conversationId}（每 ${interval}ms 拉一次，Ctrl+C 退出）`);
  const seen = new Set();

  for (;;) {
    try {
      const messages = await fetchMessages(api, conversationId, member);
      for (const message of messages) {
        if (seen.has(message.id)) {
          continue;
        }
        seen.add(message.id);
        console.log(line(message));
      }
    } catch (error) {
      console.error(`tail: ${error.message}`);
    }
    if (once) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

main().catch((error) => {
  console.error(`tail: ${error.message}`);
  process.exitCode = 1;
});
