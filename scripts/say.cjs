'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Say something as the customer, through the real inbound path.
 *
 * Posts a Mock WeCom callback — the same wire the customer page uses — so the
 * message enters the platform the way a customer's would: it opens the reply
 * window, joins the queue and becomes eligible for dispatch. Nothing is written
 * to the database directly.
 *
 *   node scripts/say.cjs "你们家羽绒服还有货吗"
 *
 * Options (all optional):
 *   --customer <id>  外部顾客 id, default `demo-customer`
 *   --session  <id>  外部会话 id, default = the customer id
 *   --store    <id>  门店, default `store-acme-flagship`
 *   --tenant   <id>  租户, default `tenant-acme`
 *   --member   <id>  投递身份（必须是该门店的成员）, default `u-t1-agent-2`
 *   --api      <url> API 地址, default `http://127.0.0.1:3000`
 *
 * Why a Node script rather than curl: the same Chinese text through `curl` on a
 * Windows console is encoded with the console code page and reaches the database
 * as mojibake. Node sends UTF-8, and the payload is built from the argument it
 * was given, so what you type is what the platform stores.
 *
 * The conversation id it prints is remembered in the system temp directory, so
 * `tail.cjs` needs no arguments to keep watching the same conversation.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Where the last conversation id is kept, for `tail.cjs` to pick up. */
const STATE_PATH = path.join(os.tmpdir(), 'kefu-demo-state.json');

const DEFAULTS = {
  customer: 'demo-customer',
  store: 'store-acme-flagship',
  tenant: 'tenant-acme',
  member: 'u-t1-agent-2',
  api: 'http://127.0.0.1:3000',
};

/**
 * Read the command line into a text plus the options that override a default.
 *
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{text: string, options: Record<string, string>}} Parsed invocation.
 */
function parseArgs(argv) {
  const options = {};
  const words = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`option ${token} needs a value`);
      }
      options[token.slice(2)] = value;
      index += 1;
    } else {
      words.push(token);
    }
  }
  return { text: words.join(' '), options };
}

async function main() {
  const { text, options } = parseArgs(process.argv.slice(2));
  if (text.length === 0) {
    throw new Error('usage: node scripts/say.cjs "顾客要说的话" [--customer id] [--store id] …');
  }

  const customer = options.customer ?? DEFAULTS.customer;
  const session = options.session ?? customer;
  const store = options.store ?? DEFAULTS.store;
  const tenant = options.tenant ?? DEFAULTS.tenant;
  const member = options.member ?? DEFAULTS.member;
  const api = (options.api ?? DEFAULTS.api).replace(/\/$/, '');

  const stamp = Date.now();
  const payload = {
    eventId: `evt-say-${stamp}`,
    tenantId: tenant,
    storeId: store,
    externalCustomerId: customer,
    externalConversationId: session,
    externalMessageId: `msg-say-${stamp}`,
    messageType: 'text',
    content: text,
    occurredAt: new Date().toISOString(),
  };

  const response = await fetch(`${api}/api/v1/channels/wecom/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // The Mock transport's own signature: it proves the callback was shaped by
      // an adapter that speaks the mock wire, and is checked before anything else.
      'x-mock-signature': 'mock-signature',
      // Local-only identity: refused outright when the demo headers are off.
      'x-member-id': member,
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  if (!response.ok) {
    console.error(`say: the platform refused it — HTTP ${response.status}`);
    console.error(`say: ${body.slice(0, 400)}`);
    process.exitCode = 1;
    return;
  }

  const envelope = JSON.parse(body);
  const conversationId = envelope?.data?.conversationId;
  const created = envelope?.data?.created;
  console.log(`顾客: ${text}`);
  console.log(`say: 已投递 → ${conversationId}${created === false ? '（重复事件，未新建）' : ''}`);

  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ conversationId, customer, store, member, api }, null, 2),
  );
  console.log(`say: 接着看回复 → node scripts/tail.cjs`);
}

main().catch((error) => {
  console.error(`say: ${error.message}`);
  process.exitCode = 1;
});
