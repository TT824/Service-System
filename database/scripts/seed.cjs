'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Idempotent seed for the kefu-saas database.
 *
 * Writes the same deterministic test fixtures the in-process store seeds in
 * `packages/core/src/platform/store.ts` — two tenants, three stores, six
 * members — plus the member store scopes those members imply. The durable
 * fixtures and the in-memory fixtures therefore describe the same platform, so
 * a later task can move a business service from the store to PostgreSQL
 * without changing behaviour or tests.
 *
 * It then provisions the initial platform administrator *account* — username
 * `admin`, linked to the seeded platform member `u-platform-admin` — so the
 * console can be signed into with a real password instead of a spoofable
 * header. The password is the documented local credential `Admin123456`; the
 * row stores only the encoded scrypt hash, in the same format the domain hasher
 * produces (see `packages/core/src/auth/password.ts`), and the seed never
 * writes the plaintext anywhere.
 *
 * Idempotency: every row is inserted with `ON CONFLICT DO NOTHING`, so the
 * command is safe to run repeatedly and never overwrites or deletes existing
 * data. Re-running reports `0 inserted` and leaves the row contents untouched —
 * in particular the administrator password hash and its timestamps.
 *
 * Conflicts fail loudly: if the `admin` username, the fixed account id, the
 * password identity or the platform member is already owned by something else,
 * the seed stops with a diagnostic and rolls the whole transaction back rather
 * than adopting the row.
 *
 * Ordering: rows are inserted parents-first (tenants, stores, members, member
 * store scopes, then accounts, identities and member links) inside a single
 * transaction, so a partially seeded database is impossible.
 *
 * Secrets: the connection string is read from `DATABASE_URL` and never printed.
 *
 * Usage (from the repository root):
 *   npm run db:seed
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

/** Fixed instant the in-memory seed stamps on every fixture row. */
const SEEDED_AT = '2026-08-01T00:00:00.000Z';

/**
 * Tenants seeded by `KefuStore.seed()`.
 *
 * `tenant-beta` stays, and that is deliberate. The product serves one
 * organisation, so nothing in the console or in `admin.service.ts` will make a
 * second one — but a second *data* tenant is what the interface suite's
 * cross-tenant arithmetic is written against (`assignment.e2e-spec.ts` reads
 * `x-tenant-id: tenant-beta` as `u-t2-agent-1`, and the kernel suites assert a
 * foreign tenant is answered 404/403). Those suites run with `APP_ENV=test`,
 * which means PostgreSQL, so the rows have to be here for the gate to pass.
 *
 * Removing this row is therefore not a tidy-up: it reds the interface gate, and
 * the rows it needs would have to be created some other way first. Reducing the
 * deployment to one organisation is `prune.cjs --apply`, which is a statement
 * about a running database rather than about this fixture file — and re-running
 * the seed after a prune brings the fixture back, which is what makes the two
 * order-dependent rather than contradictory.
 */
const TENANTS = [
  { id: 'tenant-acme', code: 'acme', name: '云集服饰', enabled: true, createdAt: SEEDED_AT },
  { id: 'tenant-beta', code: 'beta', name: '蓝图数码', enabled: true, createdAt: SEEDED_AT },
];

/** Stores seeded by `KefuStore.seed()`. */
const STORES = [
  {
    id: 'store-acme-flagship',
    tenantId: 'tenant-acme',
    code: 'flagship',
    name: '云集服饰旗舰店',
    enabled: true,
    createdAt: SEEDED_AT,
  },
  {
    id: 'store-acme-distribution',
    tenantId: 'tenant-acme',
    code: 'distribution',
    name: '云集服饰分销店',
    enabled: true,
    createdAt: SEEDED_AT,
  },
  {
    id: 'store-beta-official',
    tenantId: 'tenant-beta',
    code: 'official',
    name: '蓝图数码官方店',
    enabled: true,
    createdAt: SEEDED_AT,
  },
];

/** Members seeded by `KefuStore.seed()`. */
const MEMBERS = [
  {
    id: 'u-platform-admin',
    tenantId: null,
    storeId: null,
    role: 'platform_admin',
    username: 'root',
    displayName: '平台超级管理员',
    enabled: true,
    createdAt: SEEDED_AT,
  },
  {
    id: 'u-t1-admin',
    tenantId: 'tenant-acme',
    storeId: null,
    role: 'merchant_admin',
    username: 'acme-owner',
    displayName: '云集管理员',
    enabled: true,
    createdAt: SEEDED_AT,
  },
  {
    id: 'u-t1-agent-1',
    tenantId: 'tenant-acme',
    storeId: 'store-acme-flagship',
    role: 'agent',
    username: 'agent-01',
    displayName: '客服小云',
    enabled: true,
    createdAt: SEEDED_AT,
  },
  {
    id: 'u-t1-agent-2',
    tenantId: 'tenant-acme',
    storeId: 'store-acme-flagship',
    role: 'agent',
    username: 'agent-02',
    displayName: '客服小蓝',
    enabled: true,
    createdAt: SEEDED_AT,
  },
  {
    id: 'u-t2-admin',
    tenantId: 'tenant-beta',
    storeId: null,
    role: 'merchant_admin',
    username: 'beta-owner',
    displayName: '蓝图管理员',
    enabled: true,
    createdAt: SEEDED_AT,
  },
  {
    id: 'u-t2-agent-1',
    tenantId: 'tenant-beta',
    storeId: 'store-beta-official',
    role: 'agent',
    username: 'beta-agent',
    displayName: '数码顾问',
    enabled: true,
    createdAt: SEEDED_AT,
  },
];

/** The store scope each store-bound seeded member implies, as its primary store. */
const MEMBER_STORE_SCOPES = MEMBERS.filter((member) => member.storeId !== null).map((member) => ({
  tenantId: member.tenantId,
  memberId: member.id,
  storeId: member.storeId,
  isPrimary: true,
  grantedAt: SEEDED_AT,
  revokedAt: null,
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT,
}));

/** Password of the seeded administrator account. Documented local credential. */
const ADMIN_PASSWORD = 'Admin123456';

/**
 * Fixed identities of the seeded administrator account.
 *
 * Every identifier is a literal so a second run finds exactly the rows it wrote
 * before, and so a conflicting owner can be named in a diagnostic instead of
 * being silently adopted.
 */
const ADMIN_ACCOUNT = {
  userId: 'user-platform-admin',
  username: 'admin',
  displayName: '平台管理员',
  identityId: 'identity-admin-password',
  linkId: 'link-platform-admin',
  tenantId: null,
  memberId: 'u-platform-admin',
  linkedBy: 'seed',
};

/** Password of the seeded seat account. Documented local credential. */
const SEAT_PASSWORD = 'Agent123456';

/**
 * The login a demo works conversations with.
 *
 * A seat is what the assignment sweep dispatches to and what a workspace acts
 * as, so a demo of 入池被派单 cannot sign in as the platform administrator:
 * `AssignmentService.requireSeat` admits only a store-scoped `agent`, and the
 * sweep's eligibility rule reads a member with no presence row as `offline`.
 * Binding a login to a seat is therefore what makes the second half of the demo
 * reachable at all — the members already exist; only the account did not.
 *
 * It is bound to 客服小蓝 rather than 客服小云 because
 * `member_user_links_member_active_idx` admits **one** unrevoked link per member,
 * and 客服小云 already carries one: an account named `merchant-demo` was bound to
 * `u-t1-agent-1` by hand on 2026-09-15, whose password was never written down.
 * The fixture is inserted with `ON CONFLICT DO NOTHING`, so aiming at that member
 * would have made this account silently unlinked — a demo that fails at sign-in
 * with nothing in the log to say why. Revoking the older link is the operator's
 * call, not a seed's.
 *
 * `tenantId` is the link's tenant, not the member's: a platform administrator is
 * bound through no tenant (`null`), while this one is bound inside 云集服饰.
 */
const SEAT_ACCOUNT = {
  userId: 'user-agent-xiaolan',
  username: 'agent01',
  displayName: '客服小蓝',
  identityId: 'identity-agent-xiaolan-password',
  linkId: 'link-agent-xiaolan',
  tenantId: 'tenant-acme',
  memberId: 'u-t1-agent-2',
  linkedBy: 'seed',
};

/**
 * Every account the seed writes, each with the password hashed into it.
 *
 * The password is attached here rather than read from a single constant so a new
 * fixture cannot be added without one — the hash is the only thing that makes
 * the row a usable login, and `hashPassword` is called once per account.
 */
const SEEDED_ACCOUNTS = [
  { ...ADMIN_ACCOUNT, password: ADMIN_PASSWORD },
  { ...SEAT_ACCOUNT, password: SEAT_PASSWORD },
];

/**
 * scrypt cost parameters the encoded hash is written with.
 *
 * Kept in step with `DEFAULT_SCRYPT_PARAMS` in `packages/core/src/auth/password.ts`;
 * the encoded string is self-describing, so a verifier reads the parameters back
 * out of the row rather than assuming these values.
 */
const SCRYPT_PARAMS = { n: 16_384, r: 8, p: 1, keyLength: 64 };
/** Random salt bytes mixed into the hash, matching the domain hasher. */
const SCRYPT_SALT_BYTES = 16;

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
 * Authentication fixtures: one account per seeded login, each with its verified
 * password identity and the link that binds it to a member.
 *
 * The hash is generated per run with a fresh salt, which is safe precisely
 * because `ON CONFLICT DO NOTHING` never re-writes an existing row: a repeat
 * run leaves the stored hash — and its timestamps — exactly as it found them.
 */
const AUTH_BATCHES = [
  {
    table: 'user_accounts',
    columns: [
      'id',
      'username',
      'display_name',
      'status',
      'password_hash',
      'password_updated_at',
      'created_at',
      'updated_at',
    ],
    rows: SEEDED_ACCOUNTS.map((account) => [
      account.userId,
      account.username,
      account.displayName,
      'active',
      hashPassword(account.password),
      SEEDED_AT,
      SEEDED_AT,
      SEEDED_AT,
    ]),
  },
  {
    table: 'user_identities',
    columns: [
      'id',
      'user_id',
      'provider',
      'subject',
      'verified',
      'verified_at',
      'created_at',
      'updated_at',
    ],
    rows: SEEDED_ACCOUNTS.map((account) => [
      account.identityId,
      account.userId,
      'password',
      account.username,
      true,
      SEEDED_AT,
      SEEDED_AT,
      SEEDED_AT,
    ]),
  },
  {
    table: 'member_user_links',
    columns: [
      'id',
      'user_id',
      'tenant_id',
      'member_id',
      'linked_by',
      'linked_at',
      'revoked_at',
      'created_at',
      'updated_at',
    ],
    rows: SEEDED_ACCOUNTS.map((account) => [
      account.linkId,
      account.userId,
      account.tenantId,
      account.memberId,
      account.linkedBy,
      SEEDED_AT,
      null,
      SEEDED_AT,
      SEEDED_AT,
    ]),
  },
];

/** Tenant and store the demo knowledge belongs to: 云集服饰旗舰店. */
const DEMO_TENANT_ID = 'tenant-acme';
const DEMO_STORE_ID = 'store-acme-flagship';

/**
 * Products the suggestion engine can answer a demo question with.
 *
 * These exist because the retrieval engine's tokenizer does **not** segment
 * Chinese: `tokenizeQuery` in `packages/core/src/platform/suggestion.ts` splits
 * on whitespace and punctuation only, and a candidate scores when the resulting
 * token appears *verbatim* in a product's title (3 points) or description (1).
 * A buyer's whole sentence therefore tokenizes to one string that no title
 * contains, and answers nothing. Until that is fixed, a demo works because the
 * fixtures and the demo question agree on a keyword: four titles carry 羽绒服,
 * so asking about 羽绒服 with a space-separated second word clears the engine's
 * three-candidate cut with room to spare.
 *
 * Products reach the engine on the direct lane (`RetrievalService` reads
 * `listProducts` and never touches the index), so none of this needs the
 * embedding service, the indexer or the Worker to have run — which is what
 * makes the demo reproducible on a machine where none of them are up.
 */
const DEMO_PRODUCTS = [
  {
    id: 'prod-acme-down-01',
    sku: 'ACME-DOWN-001',
    title: '云集轻暖羽绒服 90白鸭绒 连帽中长款',
    description:
      '充绒量 180g，90% 白鸭绒，连帽中长款。尺码 S-XXL，颜色：黑色、米白、雾霾蓝。现货充足，当天下单 48 小时内发出。',
  },
  {
    id: 'prod-acme-down-02',
    sku: 'ACME-DOWN-002',
    title: '云集羽绒服 轻薄短款 可收纳',
    description:
      '整件仅 320g，可折叠收纳成一小包。尺码 S-XL，颜色：黑色、奶白。现货，支持 7 天无理由退换。',
  },
  {
    id: 'prod-acme-down-03',
    sku: 'ACME-DOWN-003',
    title: '云集儿童羽绒服 加厚款',
    description:
      '适合 3-12 岁，充绒量 150g，防泼水面料。尺码 110-160，颜色：藏青、粉红。现货，48 小时内发出。',
  },
  {
    id: 'prod-acme-down-04',
    sku: 'ACME-DOWN-004',
    title: '云集羽绒服 情侣款 长款过膝',
    description:
      '充绒量 200g，防风面料，长款过膝。尺码 M-XXL，颜色：黑色、燕麦。此款为预售，下单后 7 天发货。',
  },
  {
    id: 'prod-acme-vest-01',
    sku: 'ACME-VEST-001',
    title: '云集轻便羽绒马甲 背心款',
    description: '充绒量 90g，可内搭可外穿。尺码 S-XL，颜色：黑色、卡其。现货。',
  },
  {
    id: 'prod-acme-parka-01',
    sku: 'ACME-PARKA-001',
    title: '云集加厚派克服 可拆卸内胆',
    description: '外套配可拆卸内胆，充绒量 160g。尺码 M-XXL，颜色：军绿、黑色。现货。',
  },
  {
    id: 'prod-acme-tee-01',
    sku: 'ACME-TEE-001',
    title: '云集纯棉圆领T恤 新疆长绒棉',
    description: '克重 200g，不易变形。尺码 S-XXL，颜色：白色、黑色、灰色。现货。',
  },
  {
    id: 'prod-acme-jeans-01',
    sku: 'ACME-JEANS-001',
    title: '云集直筒牛仔裤 弹力面料',
    description: '弹力面料，直筒版型。尺码 28-38，颜色：深蓝、浅蓝。现货，48 小时内发出。',
  },
];

/** Fixture batches, parents first so foreign keys resolve within one transaction. */
const BATCHES = [
  {
    table: 'tenants',
    columns: ['id', 'code', 'name', 'enabled', 'created_at'],
    rows: TENANTS.map((tenant) => [
      tenant.id,
      tenant.code,
      tenant.name,
      tenant.enabled,
      tenant.createdAt,
    ]),
  },
  {
    table: 'stores',
    columns: ['id', 'tenant_id', 'code', 'name', 'enabled', 'created_at'],
    rows: STORES.map((store) => [
      store.id,
      store.tenantId,
      store.code,
      store.name,
      store.enabled,
      store.createdAt,
    ]),
  },
  {
    table: 'members',
    columns: [
      'id',
      'tenant_id',
      'store_id',
      'role',
      'username',
      'display_name',
      'enabled',
      'created_at',
    ],
    rows: MEMBERS.map((member) => [
      member.id,
      member.tenantId,
      member.storeId,
      member.role,
      member.username,
      member.displayName,
      member.enabled,
      member.createdAt,
    ]),
  },
  {
    table: 'member_store_scopes',
    columns: [
      'tenant_id',
      'member_id',
      'store_id',
      'is_primary',
      'granted_at',
      'revoked_at',
      'created_at',
      'updated_at',
    ],
    rows: MEMBER_STORE_SCOPES.map((scope) => [
      scope.tenantId,
      scope.memberId,
      scope.storeId,
      scope.isPrimary,
      scope.grantedAt,
      scope.revokedAt,
      scope.createdAt,
      scope.updatedAt,
    ]),
  },
  {
    table: 'products',
    columns: [
      'id',
      'tenant_id',
      'store_id',
      'sku',
      'title',
      'description',
      'enabled',
      'updated_at',
      'created_at',
    ],
    rows: DEMO_PRODUCTS.map((product) => [
      product.id,
      DEMO_TENANT_ID,
      DEMO_STORE_ID,
      product.sku,
      product.title,
      product.description,
      true,
      SEEDED_AT,
      SEEDED_AT,
    ]),
  },
];

/** Tables the seed writes to; all of them come from the migrations. */
const REQUIRED_TABLES = [...BATCHES, ...AUTH_BATCHES].map((batch) => batch.table);

function log(message) {
  console.log(`db: ${message}`);
}

function fail(message) {
  console.error(`db: ${message}`);
  process.exitCode = 1;
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

/**
 * Build a multi-row `INSERT ... ON CONFLICT DO NOTHING` for one fixture batch.
 *
 * Table and column names are static literals from {@link BATCHES}; every
 * fixture value travels as a bound parameter.
 *
 * @param {{ table: string, columns: string[], rows: unknown[][] }} batch
 * @returns {string} Parameterized SQL statement.
 */
function buildInsert(batch) {
  const width = batch.columns.length;
  const tuples = batch.rows.map((_row, rowIndex) => {
    const placeholders = batch.columns.map(
      (_column, columnIndex) => `$${rowIndex * width + columnIndex + 1}`,
    );
    return `(${placeholders.join(', ')})`;
  });
  return [
    `INSERT INTO ${batch.table} (${batch.columns.join(', ')})`,
    `VALUES ${tuples.join(', ')}`,
    'ON CONFLICT DO NOTHING',
  ].join('\n');
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
 * Refuse to seed an administrator identity the platform already uses otherwise.
 *
 * The seed is additive by design: it never edits a row it did not write. The
 * flip side is that `ON CONFLICT DO NOTHING` would also swallow a genuine
 * collision — a different account already holding the `admin` username, or a
 * member link that belongs to someone else — and quietly leave the platform
 * without a working administrator. So every fixed identity is checked first,
 * inside the transaction, and a collision aborts the whole seed instead.
 *
 * Diagnostics name only the fixed identity the seed wanted and never another
 * row's contents, so a failure message is safe to paste into a ticket.
 *
 * @param {Client} client - Client inside the seed transaction.
 * @returns {Promise<void>} Resolves when nothing conflicts.
 */
async function assertAuthSeedUnowned(client) {
  const conflict = (detail) => {
    throw new Error(`auth seed conflict: ${detail}; resolve it and run "npm run db:seed" again`);
  };

  const account = await client.query(
    'SELECT username, password_hash FROM user_accounts WHERE id = $1',
    [ADMIN_ACCOUNT.userId],
  );
  if (account.rowCount > 0) {
    const row = account.rows[0];
    if (row.username.toLowerCase() !== ADMIN_ACCOUNT.username) {
      conflict(`account id "${ADMIN_ACCOUNT.userId}" already exists with another username`);
    }
    if (row.password_hash === null) {
      conflict(`account "${ADMIN_ACCOUNT.username}" exists without a password credential`);
    }
  }

  const usernameOwner = await client.query(
    'SELECT id FROM user_accounts WHERE lower(username) = $1',
    [ADMIN_ACCOUNT.username],
  );
  if (usernameOwner.rowCount > 0 && usernameOwner.rows[0].id !== ADMIN_ACCOUNT.userId) {
    conflict(`the username "${ADMIN_ACCOUNT.username}" already belongs to another account`);
  }

  const identity = await client.query(
    `SELECT user_id FROM user_identities WHERE provider = 'password' AND lower(subject) = $1`,
    [ADMIN_ACCOUNT.username],
  );
  if (identity.rowCount > 0 && identity.rows[0].user_id !== ADMIN_ACCOUNT.userId) {
    conflict(`a password identity for "${ADMIN_ACCOUNT.username}" belongs to another account`);
  }

  const link = await client.query(
    'SELECT user_id FROM member_user_links WHERE member_id = $1 AND revoked_at IS NULL',
    [ADMIN_ACCOUNT.memberId],
  );
  if (link.rowCount > 0 && link.rows[0].user_id !== ADMIN_ACCOUNT.userId) {
    conflict(`member "${ADMIN_ACCOUNT.memberId}" is already linked to another account`);
  }

  const member = await client.query('SELECT role, tenant_id FROM members WHERE id = $1', [
    ADMIN_ACCOUNT.memberId,
  ]);
  if (member.rowCount === 0) {
    conflict(`member "${ADMIN_ACCOUNT.memberId}" is missing; the directory seed must run first`);
  }
  const memberRow = member.rows[0];
  if (memberRow.role !== 'platform_admin' || memberRow.tenant_id !== null) {
    conflict(
      `member "${ADMIN_ACCOUNT.memberId}" is not a platform-level platform_admin; refusing to bind the administrator account to it`,
    );
  }
}

/**
 * Insert one fixture batch and record what it added.
 *
 * @param {Client} client - Client inside the seed transaction.
 * @param {{ table: string, columns: string[], rows: unknown[][] }} batch
 * @param {Array<{ table: string, inserted: number, existing: number }>} results
 * @returns {Promise<void>}
 */
async function insertBatch(client, batch, results) {
  const values = batch.rows.flat();
  const result = await client.query(buildInsert(batch), values);
  const inserted = result.rowCount ?? 0;
  results.push({
    table: batch.table,
    inserted,
    existing: batch.rows.length - inserted,
  });
}

/**
 * @param {Client} client
 * @returns {Promise<Array<{ table: string, inserted: number, existing: number }>>}
 */
async function applySeed(client) {
  await client.query('BEGIN');
  try {
    /** @type {Array<{ table: string, inserted: number, existing: number }>} */
    const results = [];
    // Directory rows first: the account seed links to a member inserted here.
    for (const batch of BATCHES) {
      await insertBatch(client, batch, results);
    }
    // Accounts second, and only once nothing they claim is already owned.
    await assertAuthSeedUnowned(client);
    for (const batch of AUTH_BATCHES) {
      await insertBatch(client, batch, results);
    }
    await client.query('COMMIT');
    return results;
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
    const results = await applySeed(client);
    for (const result of results) {
      log(`${result.table}: ${result.inserted} inserted, ${result.existing} already present`);
    }
    const inserted = results.reduce((total, result) => total + result.inserted, 0);
    const existing = results.reduce((total, result) => total + result.existing, 0);
    log(
      `administrator account "${ADMIN_ACCOUNT.username}" is linked to member "${ADMIN_ACCOUNT.memberId}" (see README for the local credential)`,
    );
    log(`seed complete (${inserted} inserted, ${existing} already present)`);
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
