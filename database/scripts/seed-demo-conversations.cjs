'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Optional demo conversations, for a workspace that has none.
 *
 * `npm run db:seed` writes accounts and directory rows only: the database it
 * leaves behind has no conversations, and the workspace's 我的会话 and 买家
 * folders are then genuinely empty, so every click opens nothing. Conversations
 * normally arrive through the WeCom channel callback, which needs a bound
 * channel account this machine does not have. This command is the stand-in: it
 * writes the demo customers from `apps/web/src/mock-data.js` into the demo
 * tenant, store and seat, so the prototype's own examples resolve against real
 * backend rows.
 *
 * Deliberately **not** part of `db:seed`, and deliberately not run by any test:
 * it writes business rows into whichever database `DATABASE_URL` names, and the
 * local `kefu` database is the one the e2e suite runs against. Run it when a demo
 * needs data.
 *
 * Usage (from the repository root):
 *   npm run db:seed:demo                              # write the demo rows
 *   npm run seed:demo --workspace @kefu/database -- --undo   # delete them again
 *
 * `--undo` deletes exactly the conversations this file names, and messages go
 * with them through the foreign key's `ON DELETE CASCADE`. `db:prune` is *not*
 * the way to take these rows back: it prunes a different thing entirely (it
 * deletes the second tenant, and states that a pruned database cannot pass the
 * interface gate).
 *
 * Scope: `tenant-acme` / `store-acme-flagship` / seat `u-t1-agent-2` (`agent01`)
 * only. Nothing here touches another tenant, another store, or the platform
 * administrator, so a failure leaves the other fixtures untouched.
 *
 * Idempotency: every row is inserted with `ON CONFLICT DO NOTHING` under a fixed
 * id, so a repeat run reports `0 inserted` and changes nothing. Timestamps are
 * computed relative to the run that first wrote a row, because the id — not the
 * clock — is what makes the row the same row.
 *
 * What it intentionally leaves out, so a later reader does not take these rows
 * for a complete record of an inbound conversation: `conversation_assignments`
 * (no transfer happened), `message_deliveries` / `message_status_events` (nothing
 * was handed to a channel), and any review-eligible outbound (the audit queue is
 * not being demonstrated). `pending_since` and `next_assignment_at` stay NULL:
 * these conversations were never in the pool, and the assignment schedule check
 * only permits a due time on a pooled conversation.
 *
 * It does write `send_quota_windows`, one per demo customer, because the rows
 * above *imply* one: a customer's inbound message opens the 48-hour reply window
 * inside which the five-reply budget is spent, and the workspace's 外发提醒 banner
 * is a reading of that window (`GET /conversations/:id` returns it as
 * `replyWindow`). A row that was never inserted — because these messages never
 * went through the channel pipeline — would leave the banner saying "no window
 * has opened", which is false of a conversation whose transcript opens with the
 * customer speaking. The window is derived from the transcript exactly as the
 * inbound path would have opened it: the *latest* inbound message is the opening
 * instant, and the replies after it are the slots already spent, so a demo
 * conversation whose last message is the customer's shows a full budget and one
 * whose last message is the agent's shows one fewer.
 *
 * That count is the transcript's replies, not provider attempts — the strict
 * reading of `reserved_count` ("handed to the provider") would be `0`, since this
 * file deliberately writes no `message_deliveries`. Both readings are defensible
 * for a dataset that pretends the channel delivered these messages, and the
 * transcript's is the one that makes the banner useful: with every window at 5,
 * a demo could not show that the number is read from the server at all, which is
 * the whole of what the banner has to demonstrate.
 */

/**
 * Reply-window length in milliseconds, and the replies it allows.
 *
 * Deliberately written out rather than imported: this is a CommonJS database
 * script with no build step, and `packages/core` ships as TypeScript it cannot
 * `require`. The pair mirrors `DELIVERY_WINDOW_HOURS` /
 * `DELIVERY_WINDOW_MESSAGE_LIMIT` in `packages/core/src/channel-reliability.ts`,
 * which is the rule the API and the worker enforce — if the kernel's numbers ever
 * move, these two move with them.
 */
const REPLY_WINDOW_MS = 48 * 60 * 60 * 1000;
const REPLY_WINDOW_MESSAGE_LIMIT = 5;

const fs = require('node:fs');
const path = require('node:path');

const { Client } = require('pg');
const dotenv = require('dotenv');

// Same bootstrap as `scripts/check.cjs`: read the repository `.env` when it
// exists so the command works from a fresh shell, and fall back to whatever the
// environment already provides on a machine that sets DATABASE_URL itself.
const ROOT_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ROOT_ENV_PATH)) {
  dotenv.config({ path: ROOT_ENV_PATH });
}

/** Tenant, store and seat the demo is scoped to. All three are `db:seed` fixtures. */
const TENANT_ID = 'tenant-acme';
const STORE_ID = 'store-acme-flagship';
const SEAT_MEMBER_ID = 'u-t1-agent-2';
/** The first-phase business channel; conversations outside it are not part of the MVP. */
const CHANNEL = 'wecom';

/**
 * The seat's display name in the transcript. Mirrors the seeded member name so
 * the workspace shows the same sender the seat account is bound to.
 */
const SEAT_NAME = '客服小蓝';

/**
 * Spacing between two messages of one conversation, in minutes. Kept small and
 * fixed so a transcript reads as a single exchange and its order never depends
 * on how long the insert took.
 */
const MINUTES_BETWEEN_MESSAGES = 2;

/**
 * The demo conversations, keyed by fixed id.
 *
 * `title` is what the workspace renders as the customer name
 * (`backendConversationOf` prefers `title`), and it is deliberately the same
 * name as the matching buyer contact in `apps/web/src/mock-data.js`. The
 * prototype's buyer rows carry mock conversation ids that the real backend list
 * cannot match, so the frontend links a buyer to a conversation by id and then
 * by name; spelling the names identically is what makes that fallback land.
 *
 * @type {ReadonlyArray<{id: string, title: string, status: 'claimed'|'closed',
 *   externalCustomerId: string, openedMinutesAgo: number,
 *   messages: ReadonlyArray<{direction: 'inbound'|'outbound', text: string}>}>}
 */
const DEMO_CONVERSATIONS = [
  {
    id: 'demo-conv-lin',
    title: '林女士',
    status: 'claimed',
    externalCustomerId: 'demo-customer-lin',
    openedMinutesAgo: 64,
    messages: [
      { direction: 'inbound', text: '您好，请问这款保温杯有黑色吗？' },
      { direction: 'outbound', text: '有的，请问您看的是 500ml 这款吗？' },
      { direction: 'inbound', text: '对，500ml 的。保温效果怎么样？' },
    ],
  },
  {
    id: 'demo-conv-zhou',
    title: '周先生',
    status: 'claimed',
    externalCustomerId: 'demo-customer-zhou',
    openedMinutesAgo: 56,
    messages: [{ direction: 'inbound', text: '发货一般需要多久？' }],
  },
  {
    id: 'demo-conv-liu',
    title: '刘女士',
    status: 'claimed',
    externalCustomerId: 'demo-customer-liu',
    openedMinutesAgo: 45,
    messages: [{ direction: 'inbound', text: '有适合送礼的包装吗？' }],
  },
  {
    id: 'demo-conv-wu',
    title: '吴先生',
    status: 'claimed',
    externalCustomerId: 'demo-customer-wu',
    openedMinutesAgo: 38,
    messages: [
      { direction: 'inbound', text: '想问一下米白色有货吗？' },
      { direction: 'outbound', text: '米白色目前有货，付款后 48 小时内发出，具体以商品页为准。' },
    ],
  },
  {
    id: 'demo-conv-zhao',
    title: '赵女士',
    status: 'closed',
    externalCustomerId: 'demo-customer-zhao',
    openedMinutesAgo: 150,
    messages: [
      { direction: 'inbound', text: '这个和上次买的那款有什么区别？' },
      { direction: 'outbound', text: '主要是容量和杯盖结构不同，我发一下对比给您。' },
      { direction: 'inbound', text: '谢谢，已经了解了' },
    ],
  },
];

/** Tables this command requires, so a missing migration is named rather than guessed. */
const REQUIRED_TABLES = [
  'conversations',
  'messages',
  'members',
  'stores',
  'send_quota_windows',
];

/** @returns {Promise<Client>} */
async function connect() {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is not set (copy .env.example to .env and adjust if needed)');
  }
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 4000,
    statement_timeout: 30_000,
  });
  await client.connect();
  return client;
}

/** @param {string} message */
function log(message) {
  process.stdout.write(`[seed:demo] ${message}\n`);
}

/** @param {string} message */
function fail(message) {
  process.stderr.write(`[seed:demo] ${message}\n`);
  process.exitCode = 1;
}

/**
 * @param {Client} client
 * @returns {Promise<void>} Resolves when every required table exists.
 */
async function assertSchemaReady(client) {
  const missing = [];
  for (const table of REQUIRED_TABLES) {
    const result = await client.query(`SELECT to_regclass($1)::text AS name`, [table]);
    if (result.rows[0]?.name === null || result.rows[0] === undefined) {
      missing.push(table);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `missing table(s) ${missing.join(', ')}; run "npm run db:migrate" before seeding`,
    );
  }
}

/**
 * Refuse to demo into a platform that is not the one this command describes.
 *
 * The insert is `ON CONFLICT DO NOTHING`, which would also swallow a fixed demo
 * id that already belongs to another tenant — the demo would then silently show
 * someone else's rows. Every precondition is therefore checked first, inside the
 * transaction, and a mismatch aborts the whole run.
 *
 * @param {Client} client - Client inside the transaction.
 * @returns {Promise<void>} Resolves when every precondition holds.
 */
async function assertDemoScope(client) {
  const store = await client.query('SELECT tenant_id FROM stores WHERE id = $1', [STORE_ID]);
  if (store.rowCount === 0) {
    throw new Error(
      `store "${STORE_ID}" is missing; run "npm run db:seed" first (directory fixtures)`,
    );
  }
  if (store.rows[0].tenant_id !== TENANT_ID) {
    throw new Error(
      `store "${STORE_ID}" belongs to tenant "${store.rows[0].tenant_id}", not "${TENANT_ID}"`,
    );
  }

  const member = await client.query('SELECT tenant_id, store_id, role FROM members WHERE id = $1', [
    SEAT_MEMBER_ID,
  ]);
  if (member.rowCount === 0) {
    throw new Error(
      `seat "${SEAT_MEMBER_ID}" is missing; run "npm run db:seed" first (directory fixtures)`,
    );
  }
  const seat = member.rows[0];
  if (seat.tenant_id !== TENANT_ID || seat.store_id !== STORE_ID || seat.role !== 'agent') {
    throw new Error(
      `member "${SEAT_MEMBER_ID}" is not a "${STORE_ID}" seat of "${TENANT_ID}"; refusing to assign demo conversations to it`,
    );
  }

  const foreign = await client.query(
    `SELECT id FROM conversations WHERE id = ANY($1::text[]) AND tenant_id <> $2`,
    [DEMO_CONVERSATIONS.map((conversation) => conversation.id), TENANT_ID],
  );
  if (foreign.rowCount > 0) {
    throw new Error(
      `demo conversation id "${foreign.rows[0].id}" already belongs to another tenant; refusing to adopt it`,
    );
  }
}

/**
 * Fixed, monotonic timestamps for one conversation.
 *
 * Anchored to the run clock so a fresh seed reads as today's work, and counted
 * in whole minutes so a transcript's order never depends on how long the insert
 * took. A closed conversation is closed right after its last message, which is
 * what makes 已结束 sort by the time it actually ended.
 *
 * @param {{openedMinutesAgo: number, status: string, messages: ReadonlyArray<unknown>}} conversation
 * @returns {{openedAt: Date, lastMessageAt: Date, closedAt: Date|null, messageAt: (index: number) => Date}}
 */
function timelineOf(conversation) {
  const minute = 60 * 1000;
  const openedAt = new Date(Date.now() - conversation.openedMinutesAgo * minute);
  const messageAt = (index) =>
    new Date(openedAt.valueOf() + index * MINUTES_BETWEEN_MESSAGES * minute);
  const lastMessageAt = messageAt(conversation.messages.length - 1);
  const closedAt =
    conversation.status === 'closed'
      ? new Date(lastMessageAt.valueOf() + MINUTES_BETWEEN_MESSAGES * minute)
      : null;
  return { openedAt, lastMessageAt, closedAt, messageAt };
}

/**
 * The reply window one demo conversation's transcript implies, or `null` for one
 * the customer has not written into.
 *
 * The rule the platform applies to a real conversation is "the latest inbound
 * event opens the window, and every reply handed to the provider after it spends
 * a slot" (`evaluateDeliveryWindow`). This reads the same two facts off the
 * seeded transcript, so the demo's banner and the worker's own gate agree on the
 * same numbers instead of one of them being a guess.
 *
 * @param {{messages: ReadonlyArray<{direction: 'inbound'|'outbound'}>}} conversation
 * @param {(index: number) => Date} messageAt - Timestamp of the message at `index`.
 * @returns {{openedAt: Date, endsAt: Date, reservedCount: number}|null}
 */
function quotaWindowOf(conversation, messageAt) {
  let lastInbound = -1;
  for (const [index, message] of conversation.messages.entries()) {
    if (message.direction === 'inbound') {
      lastInbound = index;
    }
  }
  if (lastInbound < 0) {
    return null;
  }
  const openedAt = messageAt(lastInbound);
  const reservedCount = conversation.messages
    .slice(lastInbound + 1)
    .filter((message) => message.direction === 'outbound').length;
  return { openedAt, endsAt: new Date(openedAt.valueOf() + REPLY_WINDOW_MS), reservedCount };
}

/**
 * @param {Client} client - Client inside the transaction.
 * @returns {Promise<{conversations: number, messages: number, windows: number, visible: number}>} Rows inserted,
 *   and how many conversations the demo seat can read once the insert is done.
 */
async function applyDemo(client) {
  await client.query('BEGIN');
  try {
    await assertDemoScope(client);

    let insertedConversations = 0;
    let insertedMessages = 0;
    let insertedWindows = 0;

    for (const conversation of DEMO_CONVERSATIONS) {
      const { openedAt, lastMessageAt, closedAt, messageAt } = timelineOf(conversation);
      const firstOutboundIndex = conversation.messages.findIndex(
        (message) => message.direction === 'outbound',
      );
      const firstOutboundAt = firstOutboundIndex >= 0 ? messageAt(firstOutboundIndex) : null;

      const result = await client.query(
        `INSERT INTO conversations (
           id, tenant_id, store_id, channel, external_customer_id, external_conversation_id,
           title, status, version, assigned_member_id, opened_at, last_message_at, closed_at, created_at,
           pending_since, first_response_started_at, next_assignment_at, dispatch_attempts,
           assigned_at, offline_reply_at, first_reply_at
         ) VALUES ($1, $2, $3, $4, $5, NULL,
                   $6, $7, 1, $8, $9, $10, $11, $9,
                   NULL, $9, NULL, 0,
                   $9, NULL, $12)
         ON CONFLICT DO NOTHING`,
        [
          conversation.id,
          TENANT_ID,
          STORE_ID,
          CHANNEL,
          conversation.externalCustomerId,
          conversation.title,
          conversation.status,
          SEAT_MEMBER_ID,
          openedAt,
          lastMessageAt,
          closedAt,
          firstOutboundAt,
        ],
      );
      insertedConversations += result.rowCount ?? 0;

      for (const [index, message] of conversation.messages.entries()) {
        const messageResult = await client.query(
          `INSERT INTO messages (
             id, tenant_id, store_id, conversation_id, channel, direction, source, message_type,
             content, dedup_key, review_eligible, review_state, candidate_id, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'text',
                     $8, NULL, FALSE, 'none', NULL, $9)
           ON CONFLICT DO NOTHING`,
          [
            `${conversation.id}-m${index + 1}`,
            TENANT_ID,
            STORE_ID,
            conversation.id,
            CHANNEL,
            message.direction,
            message.direction === 'outbound' ? 'manual_typed' : null,
            message.text,
            messageAt(index),
          ],
        );
        insertedMessages += messageResult.rowCount ?? 0;
      }

      // The window the transcript implies; the key is the same quadruple the
      // platform keys it by, so a re-run after a real inbound callback landed
      // would leave that callback's own row alone rather than overwrite it.
      const window = quotaWindowOf(conversation, messageAt);
      if (window !== null) {
        const windowResult = await client.query(
          `INSERT INTO send_quota_windows (
             id, tenant_id, store_id, channel, external_customer_id, window_started_at,
             window_ends_at, message_limit, reserved_count, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6)
           ON CONFLICT (tenant_id, store_id, channel, external_customer_id) DO NOTHING`,
          [
            `${conversation.id}-window`,
            TENANT_ID,
            STORE_ID,
            CHANNEL,
            conversation.externalCustomerId,
            window.openedAt,
            window.endsAt,
            REPLY_WINDOW_MESSAGE_LIMIT,
            window.reservedCount,
          ],
        );
        insertedWindows += windowResult.rowCount ?? 0;
      }
    }

    // Read the rows back inside the same transaction: an insert that reported
    // success but left a seat with no readable queue would be the exact failure
    // this command exists to fix, so it is checked rather than assumed.
    const visible = await client.query(
      `SELECT count(*)::int AS total FROM conversations c
        WHERE c.tenant_id = $1 AND c.store_id = $2
          AND (c.assigned_member_id IS NULL OR c.assigned_member_id = $3)`,
      [TENANT_ID, STORE_ID, SEAT_MEMBER_ID],
    );

    await client.query('COMMIT');
    return {
      conversations: insertedConversations,
      messages: insertedMessages,
      windows: insertedWindows,
      visible: visible.rows[0].total,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * Delete the demo conversations this file names, by fixed id and inside the demo
 * tenant only.
 *
 * Scoped by `tenant_id` as well as id so a database that happens to hold the same
 * id under another tenant is left alone — the same reason
 * {@link assertDemoScope} exists. Messages are removed by the foreign key's
 * `ON DELETE CASCADE`, so no second statement is needed and none is written: a
 * hand-written message delete could drift from the constraint.
 *
 * @param {Client} client
 * @returns {Promise<{conversations: number, windows: number}>} Rows deleted.
 */
async function undoDemo(client) {
  await client.query('BEGIN');
  try {
    const result = await client.query(
      'DELETE FROM conversations WHERE tenant_id = $1 AND id = ANY($2::text[])',
      [TENANT_ID, DEMO_CONVERSATIONS.map((conversation) => conversation.id)],
    );
    // The reply windows go explicitly: nothing cascades to them (the key is the
    // customer, not the conversation), and leaving them behind would leave the
    // banner of a *different* conversation with the same customer showing a
    // window this command no longer had a conversation to justify.
    const windows = await client.query(
      `DELETE FROM send_quota_windows
        WHERE tenant_id = $1 AND store_id = $2 AND channel = $3 AND external_customer_id = ANY($4::text[])`,
      [
        TENANT_ID,
        STORE_ID,
        CHANNEL,
        DEMO_CONVERSATIONS.map((conversation) => conversation.externalCustomerId),
      ],
    );
    await client.query('COMMIT');
    return { conversations: result.rowCount ?? 0, windows: windows.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function main() {
  let client;
  try {
    client = await connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`cannot reach database: ${message}`);
    return;
  }

  try {
    await assertSchemaReady(client);
    if (process.argv.includes('--undo')) {
      const removed = await undoDemo(client);
      log(
        `undo complete: ${removed.conversations} demo conversation(s) deleted (messages cascade), ` +
          `${removed.windows} reply window(s) removed with them`,
      );
      return;
    }
    const result = await applyDemo(client);
    log(
      `conversations: ${result.conversations} inserted, ${DEMO_CONVERSATIONS.length - result.conversations} already present`,
    );
    log(`messages: ${result.messages} inserted`);
    log(
      `reply windows: ${result.windows} inserted, ` +
        `${DEMO_CONVERSATIONS.length - result.windows} already present`,
    );
    log(`seat "${SEAT_MEMBER_ID}" (${SEAT_NAME}) can now read ${result.visible} conversation(s)`);
    if (result.visible === 0) {
      log('warning: the queue is still empty for this seat; check tenant, store and assignment');
    }
    log('delete them again with "npm run seed:demo --workspace @kefu/database -- --undo"');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`seed failed: ${message}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(`unexpected error: ${message}`);
});
