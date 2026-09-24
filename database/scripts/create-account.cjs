'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Create an account from the command line.
 *
 * The console can create accounts (`POST /admin/accounts`), and that is the
 * normal way to put an agent on duty. This script is the fuse for the case the
 * console cannot help with: an administrator who is locked out of the console
 * because the only platform account is gone, disabled or unlinked. It writes
 * exactly the two rows the endpoint writes — an `active` account carrying an
 * encoded hash, and its verified `password` identity — and optionally binds the
 * new account to an existing member, which is what makes it able to reach
 * anything at all.
 *
 * It is deliberately not a second implementation of the domain rules: the hash
 * format mirrors `packages/core/src/auth/password.ts` (as `seed.cjs` does), and
 * the length window is the same policy registration applies. Anything it cannot
 * check here — a username that is already taken, a member that already has an
 * active link — is checked against the database and reported instead of guessed.
 *
 * The password is only ever a bound parameter: it is not printed, not written to
 * a history file, and not echoed back.
 *
 * Usage (from the repository root):
 *   node database/scripts/create-account.cjs --username agent02 --display-name 客服小蓝 --password '...'
 *   node database/scripts/create-account.cjs --username admin2 --display-name 备用管理员 \
 *     --password '...' --member u-platform-admin
 *   node database/scripts/create-account.cjs --username admin2 ... --member u-platform-admin --relink
 *
 * Through npm, spell the arguments `key=value`: npm parses and swallows anything
 * beginning with `--` before the script sees it (verified: `npm run
 * db:create-account -- --username agent02` reaches this script as a bare
 * `agent02`), so the dashed form only works when the script is run directly.
 *
 *   npm run db:create-account -- username=admin2 display-name=备用管理员 password='...' member=u-platform-admin
 *
 * Prefer the direct form when the account is a real one: npm echoes the script
 * it resolved — password included — before this script runs, so the secret ends
 * up in the terminal scrollback and in any captured CI log. This script prints
 * the password nowhere (the direct form's output never contains it).
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, scryptSync } = require('node:crypto');

const { Client } = require('pg');

const dotenv = require('dotenv');

const ROOT_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ROOT_ENV_PATH)) {
  dotenv.config({ path: ROOT_ENV_PATH });
}

/**
 * Password length window, kept in step with `PASSWORD_MIN_LENGTH` /
 * `PASSWORD_MAX_LENGTH` in `packages/core/src/auth/password.ts`.
 */
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 200;

/**
 * scrypt cost parameters, kept in step with `DEFAULT_SCRYPT_PARAMS` in the
 * domain hasher. The encoded string is self-describing, so the verifier reads
 * them back out of the row rather than assuming these values.
 */
const SCRYPT_PARAMS = { n: 16_384, r: 8, p: 1, keyLength: 64 };
/** Random salt bytes mixed into the hash, matching the domain hasher. */
const SCRYPT_SALT_BYTES = 16;

function log(message) {
  console.log(`db: ${message}`);
}

function fail(message) {
  console.error(`db: ${message}`);
  process.exitCode = 1;
}

/** Printed on `--help` and whenever the arguments do not make sense. */
const USAGE = [
  '用法（在仓库根目录执行）：',
  '  node database/scripts/create-account.cjs --username <用户名> --display-name <显示名> --password <密码> [选项]',
  '',
  '经 npm 执行时写成 key=value（npm 会先吃掉所有 `--` 开头的参数）：',
  '  npm run db:create-account -- username=<用户名> display-name=<显示名> password=<密码> [member=<成员ID>] [relink]',
  '',
  '  用户名/显示名/密码   必填；密码每个账号各不相同',
  '  --member <成员ID>   把新账号绑定到这个成员（可选；不填则账号建好但进不了控制台）',
  '  --relink           该成员已有有效绑定时，先撤销旧的再绑定（默认拒绝，不改动任何数据）',
  '  --help             显示这段说明',
  '',
  `密码长度：${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 个字符。`,
].join('\n');

/**
 * Encode a password the way the domain hasher does.
 *
 * Format: `scrypt$N=<n>,r=<r>,p=<p>$<salt-base64url>$<hash-base64url>`.
 *
 * @param {string} plain - Password to hash. Never stored or printed.
 * @returns {string} The encoded hash, safe to persist.
 */
function hashPassword(plain) {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(plain, salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.n,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: Math.max(32 * 1024 * 1024, 256 * SCRYPT_PARAMS.n * SCRYPT_PARAMS.r),
  });
  return [
    'scrypt',
    `N=${SCRYPT_PARAMS.n},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Read the command line.
 *
 * Two spellings, because the two ways of starting this script disagree about
 * what reaches it: run directly, the arguments arrive as written (`--username
 * agent02`), while `npm run` parses anything beginning with `--` as its own
 * configuration and drops it, forwarding only the bare words (`agent02`) — so
 * the `key=value` spelling is the one that survives npm.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{ username?: string, displayName?: string, password?: string, member?: string, relink: boolean, help: boolean, unknown: string[] }}
 */
function parseArgs(argv) {
  const options = /** @type {Record<string, unknown>} */ ({ relink: false, help: false });
  const unknown = [];
  /** Bare option name → the field of {@link options} it fills. */
  const named = new Map([
    ['username', 'username'],
    ['display-name', 'displayName'],
    ['display_name', 'displayName'],
    ['password', 'password'],
    ['member', 'member'],
  ]);
  /** `--display-name` and `display-name` both name the same field. */
  const bare = (token) => token.replace(/^--?/, '').replace(/_/g, '-');

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    // npm leaves its `--` separator behind in some versions; it names nothing.
    if (token === '--') continue;
    const equals = token.indexOf('=');
    const inline = equals > 0 ? token.slice(equals + 1) : null;
    const name = bare(equals > 0 ? token.slice(0, equals) : token);
    if (name === 'relink') {
      options.relink = true;
      continue;
    }
    if (name === 'help' || token === '-h') {
      options.help = true;
      continue;
    }
    const field = named.get(name);
    if (field === undefined) {
      unknown.push(token);
      continue;
    }
    if (inline !== null) {
      options[field] = inline;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith('--')) {
      unknown.push(token);
      continue;
    }
    options[field] = String(value);
    index += 1;
  }
  return { ...options, unknown };
}

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

/** Whether a table this script writes to exists. */
async function assertSchemaReady(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS total FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('user_accounts', 'user_identities', 'member_user_links')`,
  );
  if (rows[0].total !== 3) {
    throw new Error('schema is not migrated: run `npm run db:migrate` first');
  }
}

/**
 * Validate the arguments the way the API would.
 *
 * @param {{ username?: string, displayName?: string, password?: string }} options
 * @returns {{ username: string, displayName: string, password: string }}
 */
function requireInput(options) {
  const username = (options.username ?? '').trim();
  const displayName = (options.displayName ?? '').trim();
  const password = options.password ?? '';
  if (username === '') throw new Error('--username is required');
  if (displayName === '') throw new Error('--display-name is required');
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(
      `the password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  return { username, displayName, password };
}

/**
 * Create the account, and optionally bind it to a member.
 *
 * One transaction: a refusal for a taken username or an occupied member leaves
 * the database exactly as it was, rather than an account nobody can reach.
 *
 * @param {Client} client - Connected client.
 * @param {{ username: string, displayName: string, password: string }} input
 * @param {{ member?: string, relink: boolean }} options
 * @returns {Promise<{ userId: string, memberId: string | null, revokedLinkId: string | null }>}
 */
async function createAccount(client, input, options) {
  const now = new Date();
  const userId = `user-cli-${randomBytes(6).toString('hex')}`;
  const identityId = `identity-cli-${randomBytes(6).toString('hex')}`;

  await client.query('BEGIN');
  try {
    const existing = await client.query(
      'SELECT id FROM user_accounts WHERE lower(username) = lower($1)',
      [input.username],
    );
    if (existing.rowCount > 0) {
      throw new Error(`the username "${input.username}" is already taken`);
    }

    await client.query(
      `INSERT INTO user_accounts
         (id, username, display_name, status, password_hash, password_updated_at,
          failed_login_count, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4, $5, 0, $5, $5)`,
      [userId, input.username, input.displayName, hashPassword(input.password), now],
    );
    await client.query(
      `INSERT INTO user_identities
         (id, user_id, provider, subject, verified, verified_at, created_at, updated_at)
       VALUES ($1, $2, 'password', $3, TRUE, $4, $4, $4)`,
      [identityId, userId, input.username, now],
    );

    let memberId = null;
    let revokedLinkId = null;
    if (options.member !== undefined) {
      memberId = options.member;
      const member = await client.query('SELECT id, tenant_id FROM members WHERE id = $1', [
        memberId,
      ]);
      if (member.rowCount === 0) {
        throw new Error(`no member "${memberId}" exists`);
      }

      const active = await client.query(
        'SELECT id FROM member_user_links WHERE member_id = $1 AND revoked_at IS NULL',
        [memberId],
      );
      if (active.rowCount > 0) {
        if (!options.relink) {
          throw new Error(
            `member "${memberId}" already has an active link (${active.rows[0].id}); pass --relink to replace it`,
          );
        }
        revokedLinkId = active.rows[0].id;
        await client.query(
          'UPDATE member_user_links SET revoked_at = $2, updated_at = $2 WHERE id = $1',
          [revokedLinkId, now],
        );
      }

      await client.query(
        `INSERT INTO member_user_links
           (id, user_id, tenant_id, member_id, linked_by, linked_at, revoked_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'create-account.cjs', $5, NULL, $5, $5)`,
        [
          `link-cli-${randomBytes(6).toString('hex')}`,
          userId,
          member.rows[0].tenant_id,
          memberId,
          now,
        ],
      );
    }

    await client.query('COMMIT');
    return { userId, memberId, revokedLinkId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log(USAGE);
    return;
  }
  if (options.unknown.length > 0) {
    fail(`unrecognized argument(s): ${options.unknown.join(', ')}`);
    log(USAGE);
    return;
  }

  let input;
  try {
    input = requireInput(options);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    log(USAGE);
    return;
  }

  let client;
  try {
    client = await connect();
  } catch (error) {
    fail(`cannot reach database: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    await assertSchemaReady(client);
    const result = await createAccount(client, input, options);
    log(`account ${result.userId} created for "${input.username}" (${input.displayName})`);
    if (result.revokedLinkId !== null) {
      log(`previous link ${result.revokedLinkId} revoked`);
    }
    if (result.memberId === null) {
      log('the account is not bound to a member yet: bind it in 组织与成员 before it can sign in');
    } else {
      log(`bound to member "${result.memberId}": it can sign in now with the password you gave`);
    }
  } catch (error) {
    fail(`create-account failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  fail(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
});
