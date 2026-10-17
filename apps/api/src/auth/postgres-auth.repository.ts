import type { QueryResultRow } from 'pg';
import { AuthError } from '@kefu/core';
import type {
  AuthRepository,
  AuthSession,
  Member,
  MemberStoreScope,
  MemberUserLink,
  OtpChallenge,
  OtpPurpose,
  Store,
  Tenant,
  TrialWorkspace,
  TrialWorkspaceInput,
  TrialWorkspaceProvision,
  TrustedDevice,
  UserAccount,
  UserIdentity,
} from '@kefu/core';
import { DatabaseService } from '../database/database.service';
import { TransactionManager } from '../persistence/transaction-manager';

/**
 * Durable {@link AuthRepository} over the tables added by migrations `0003` and
 * `0004`.
 *
 * The adapter owns no policy: it maps rows to the domain records the
 * in-memory adapter also produces, and every rule (expiry, attempt limits,
 * rate limits, access state) stays in the shared domain services. That is what
 * lets the same workflow run against memory in `test` and PostgreSQL in
 * `local`/`production` without a branch.
 *
 * It issues plain parameterised SQL through the API-owned pool. All statements
 * are parameterised, so no caller value is ever interpolated into SQL text.
 */
export class PostgresAuthRepository implements AuthRepository {
  /**
   * @param database - The API-owned PostgreSQL connection boundary.
   * @param transactions - Transaction boundary used by writes that span more
   * than one table. Trial provisioning is the only such write here.
   */
  constructor(
    private readonly database: DatabaseService,
    private readonly transactions: TransactionManager,
  ) {}

  // --------------------------------------------------------------------------
  // Directory
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async listTenants(): Promise<ReadonlyArray<Tenant>> {
    const rows = await this.query('SELECT * FROM tenants ORDER BY id');
    return rows.map(toTenant);
  }

  /** @inheritdoc */
  async getTenant(tenantId: string): Promise<Tenant | undefined> {
    const rows = await this.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    return rows.length === 0 ? undefined : toTenant(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async saveTenant(tenant: Tenant): Promise<void> {
    await this.query(
      `INSERT INTO tenants (id, code, name, enabled, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE
         SET code = EXCLUDED.code, name = EXCLUDED.name, enabled = EXCLUDED.enabled`,
      [tenant.id, tenant.code, tenant.name, tenant.enabled, tenant.createdAt],
    );
  }

  /** @inheritdoc */
  async listStores(tenantId: string): Promise<ReadonlyArray<Store>> {
    const rows = await this.query('SELECT * FROM stores WHERE tenant_id = $1 ORDER BY id', [
      tenantId,
    ]);
    return rows.map(toStore);
  }

  /** @inheritdoc */
  async getStore(tenantId: string, storeId: string): Promise<Store | undefined> {
    const rows = await this.query('SELECT * FROM stores WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      storeId,
    ]);
    return rows.length === 0 ? undefined : toStore(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async findStoreById(storeId: string): Promise<Store | undefined> {
    const rows = await this.query('SELECT * FROM stores WHERE id = $1', [storeId]);
    return rows.length === 0 ? undefined : toStore(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async saveStore(store: Store): Promise<void> {
    await this.query(
      `INSERT INTO stores (id, tenant_id, code, name, enabled, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET code = EXCLUDED.code, name = EXCLUDED.name, enabled = EXCLUDED.enabled`,
      [store.id, store.tenantId, store.code, store.name, store.enabled, store.createdAt],
    );
  }

  /** @inheritdoc */
  async listMembers(tenantId: string): Promise<ReadonlyArray<Member>> {
    const rows = await this.query(
      `SELECT id, tenant_id, store_id, role, username, display_name, enabled, created_at
         FROM members WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    );
    return rows.map(toMember);
  }

  /** @inheritdoc */
  async getMember(memberId: string): Promise<Member | undefined> {
    const rows = await this.query(
      `SELECT id, tenant_id, store_id, role, username, display_name, enabled, created_at
         FROM members WHERE id = $1`,
      [memberId],
    );
    return rows.length === 0 ? undefined : toMember(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async listAllMembers(): Promise<ReadonlyArray<Member>> {
    const rows = await this.query(
      `SELECT id, tenant_id, store_id, role, username, display_name, enabled, created_at
         FROM members ORDER BY id`,
    );
    return rows.map(toMember);
  }

  /** @inheritdoc */
  async saveMember(member: Member): Promise<void> {
    // A platform member has a NULL tenant; the store column is only set for a
    // member that is pinned to one.
    await this.query(
      `INSERT INTO members (id, tenant_id, store_id, role, username, display_name, enabled, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE
         SET store_id = EXCLUDED.store_id,
             role = EXCLUDED.role,
             username = EXCLUDED.username,
             display_name = EXCLUDED.display_name,
             enabled = EXCLUDED.enabled`,
      [
        member.id,
        member.tenantId,
        member.storeId,
        member.role,
        member.username,
        member.displayName,
        member.enabled,
        member.createdAt,
      ],
    );
  }

  // --------------------------------------------------------------------------
  // Accounts and identities
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async getUser(userId: string): Promise<UserAccount | undefined> {
    const rows = await this.query('SELECT * FROM user_accounts WHERE id = $1', [userId]);
    return rows.length === 0 ? undefined : toUserAccount(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async findUserByUsername(username: string): Promise<UserAccount | undefined> {
    const rows = await this.query(
      'SELECT * FROM user_accounts WHERE lower(username) = lower(btrim($1)) LIMIT 1',
      [username],
    );
    return rows.length === 0 ? undefined : toUserAccount(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async listAllAccounts(): Promise<ReadonlyArray<UserAccount>> {
    const rows = await this.query('SELECT * FROM user_accounts ORDER BY id');
    return rows.map(toUserAccount);
  }

  /** @inheritdoc */
  async saveUser(user: UserAccount): Promise<void> {
    await this.query(
      `INSERT INTO user_accounts (
         id, username, display_name, status, password_hash, password_updated_at,
         failed_login_count, locked_until, last_login_at, idempotency_key, created_at, updated_at,
         avatar_url
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         username = EXCLUDED.username,
         display_name = EXCLUDED.display_name,
         status = EXCLUDED.status,
         password_hash = EXCLUDED.password_hash,
         password_updated_at = EXCLUDED.password_updated_at,
         failed_login_count = EXCLUDED.failed_login_count,
         locked_until = EXCLUDED.locked_until,
         last_login_at = EXCLUDED.last_login_at,
         updated_at = EXCLUDED.updated_at,
         avatar_url = EXCLUDED.avatar_url`,
      [
        user.id,
        user.username,
        user.displayName,
        user.status,
        user.passwordHash,
        user.passwordUpdatedAt,
        user.failedLoginCount,
        user.lockedUntil,
        user.lastLoginAt,
        user.idempotencyKey,
        user.createdAt,
        user.updatedAt,
        user.avatarUrl,
      ],
    );
  }

  /** @inheritdoc */
  async findIdentity(provider: string, subject: string): Promise<UserIdentity | undefined> {
    const rows = await this.query(
      'SELECT * FROM user_identities WHERE provider = $1 AND lower(subject) = lower(btrim($2)) LIMIT 1',
      [provider, subject],
    );
    return rows.length === 0 ? undefined : toUserIdentity(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async getIdentity(identityId: string): Promise<UserIdentity | undefined> {
    const rows = await this.query('SELECT * FROM user_identities WHERE id = $1', [identityId]);
    return rows.length === 0 ? undefined : toUserIdentity(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async listIdentities(userId: string): Promise<ReadonlyArray<UserIdentity>> {
    const rows = await this.query('SELECT * FROM user_identities WHERE user_id = $1 ORDER BY id', [
      userId,
    ]);
    return rows.map(toUserIdentity);
  }

  /** @inheritdoc */
  async saveIdentity(identity: UserIdentity): Promise<void> {
    await this.query(
      `INSERT INTO user_identities (id, user_id, provider, subject, verified, verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         subject = EXCLUDED.subject,
         verified = EXCLUDED.verified,
         verified_at = EXCLUDED.verified_at,
         updated_at = EXCLUDED.updated_at`,
      [
        identity.id,
        identity.userId,
        identity.provider,
        identity.subject,
        identity.verified,
        identity.verifiedAt,
        identity.createdAt,
        identity.updatedAt,
      ],
    );
  }

  /** @inheritdoc */
  async deleteIdentity(identityId: string): Promise<void> {
    await this.query('DELETE FROM user_identities WHERE id = $1', [identityId]);
  }

  // --------------------------------------------------------------------------
  // Membership and store scope
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async getActiveLinkForMember(memberId: string): Promise<MemberUserLink | undefined> {
    const rows = await this.query(
      'SELECT * FROM member_user_links WHERE member_id = $1 AND revoked_at IS NULL LIMIT 1',
      [memberId],
    );
    return rows.length === 0 ? undefined : toMemberLink(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async listActiveLinksForUser(userId: string): Promise<ReadonlyArray<MemberUserLink>> {
    const rows = await this.query(
      `SELECT * FROM member_user_links
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY linked_at DESC, id DESC`,
      [userId],
    );
    return rows.map(toMemberLink);
  }

  /** @inheritdoc */
  async saveLink(link: MemberUserLink): Promise<void> {
    // (user_id, member_id) is unique across revoked and active rows, so a
    // re-link updates the existing row instead of inserting a duplicate.
    await this.query(
      `INSERT INTO member_user_links (
         id, user_id, tenant_id, member_id, linked_by, linked_at, revoked_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, member_id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         linked_by = EXCLUDED.linked_by,
         linked_at = EXCLUDED.linked_at,
         revoked_at = EXCLUDED.revoked_at,
         updated_at = EXCLUDED.updated_at`,
      [
        link.id,
        link.userId,
        link.tenantId,
        link.memberId,
        link.linkedBy,
        link.linkedAt,
        link.revokedAt,
        link.createdAt,
        link.updatedAt,
      ],
    );
  }

  /** @inheritdoc */
  async listMemberAvatars(
    memberIds: ReadonlyArray<string>,
  ): Promise<ReadonlyMap<string, string>> {
    if (memberIds.length === 0) {
      // A statement with an empty array still costs a round trip, and `= ANY('{}')`
      // is never true — so the empty answer is the same one, for free.
      return new Map();
    }
    // One statement for the whole directory, because the alternative is a join
    // per colleague. Only active links count (a revoked one is a person who used
    // to be this member), and `u.avatar_url IS NOT NULL` is left to the database
    // so a member without a picture costs nothing to answer.
    const rows = await this.query(
      `SELECT l.member_id, u.avatar_url
         FROM member_user_links l
         JOIN user_accounts u ON u.id = l.user_id
        WHERE l.member_id = ANY($1::text[])
          AND l.revoked_at IS NULL
          AND u.avatar_url IS NOT NULL`,
      [memberIds],
    );
    return new Map(
      rows.map((row) => [String(row['member_id']), String(row['avatar_url'])]),
    );
  }

  // --------------------------------------------------------------------------
  // Trial workspace
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async findTrialWorkspace(userId: string): Promise<TrialWorkspace | undefined> {
    return this.findTrialWorkspaceWith((text, values) => this.query(text, values), userId);
  }

  /** @inheritdoc */
  async provisionTrialWorkspace(input: TrialWorkspaceInput): Promise<TrialWorkspaceProvision> {
    return this.transactions
      .run(async (client) => {
        const run = async (
          text: string,
          values: ReadonlyArray<unknown>,
        ): Promise<ReadonlyArray<QueryResultRow>> => rowsOf(await client.query(text, [...values]));

        // The existence check and the writes below share one transaction, so two
        // concurrent provisions cannot both find nothing and then both write. A
        // failure anywhere rolls the transaction back and leaves the account with
        // exactly the directory it had before — the account itself is untouched,
        // so it stays usable through the account center and can be retried.
        const existing = await this.findTrialWorkspaceWith(run, input.userId);
        if (existing !== undefined) {
          return { ...existing, provisioned: false };
        }

        // The account's own trial tenant, by the natural key that identifies it.
        // Finding one means a previous provisioning wrote the tenant and the
        // account later lost the link to it: the rows are reused and the link is
        // re-established, so the account never ends up owning two tenants.
        const own = await this.findTenantByCodeWith(run, input.tenant.code);
        if (own === undefined) {
          await run(
            `INSERT INTO tenants (id, code, name, enabled, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              input.tenant.id,
              input.tenant.code,
              input.tenant.name,
              input.tenant.enabled,
              input.tenant.createdAt,
            ],
          );
          await run(
            `INSERT INTO stores (id, tenant_id, code, name, enabled, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              input.store.id,
              input.store.tenantId,
              input.store.code,
              input.store.name,
              input.store.enabled,
              input.store.createdAt,
            ],
          );
          await run(
            `INSERT INTO members (
               id, tenant_id, store_id, role, username, display_name, enabled, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              input.member.id,
              input.member.tenantId,
              input.member.storeId,
              input.member.role,
              input.member.username,
              input.member.displayName,
              input.member.enabled,
              input.member.createdAt,
            ],
          );
          await run(
            `INSERT INTO member_user_links (
               id, user_id, tenant_id, member_id, linked_by, linked_at, revoked_at, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              input.link.id,
              input.link.userId,
              input.link.tenantId,
              input.link.memberId,
              input.link.linkedBy,
              input.link.linkedAt,
              input.link.revokedAt,
              input.link.createdAt,
              input.link.updatedAt,
            ],
          );
        } else {
          // The member is identified by what provisioning wrote: the account's own
          // username, in the role provisioning grants. A tenant carrying the
          // account's code without such a member was not provisioned for this
          // account, and adopting it would put the account inside a directory that
          // is not its own.
          await this.restoreTrialWorkspaceWith(run, input, own);
        }

        // The workspace is read back rather than assumed: a re-activated link
        // keeps the id and creation instant it was written with, and the store is
        // whichever one the member already acts through.
        const provisioned = await this.findTrialWorkspaceWith(run, input.userId);
        if (provisioned === undefined) {
          throw new Error('the trial workspace could not be read back after provisioning');
        }
        return { ...provisioned, provisioned: true };
      })
      .catch((error: unknown): never => {
        throw asTrialProvisioningConflict(error);
      });
  }

  /**
   * Re-establish the link between an account and its own trial tenant.
   *
   * The tenant already exists because a previous provisioning wrote it; the
   * account has no active link to it because something revoked that link. The
   * store and the member are reused when they are there, created when they are
   * not, and the link is re-activated in place — `(user_id, member_id)` is unique
   * across revoked and active rows, so the account keeps one link per
   * membership, never two.
   *
   * @throws {AuthError} `idempotency_conflict` when the tenant holds no member
   * this account could act through, or when the member registration created for
   * it is actively linked to a different account — adopting either would put the
   * account inside a directory that is not its own.
   */
  private async restoreTrialWorkspaceWith(
    run: (text: string, values: ReadonlyArray<unknown>) => Promise<ReadonlyArray<QueryResultRow>>,
    input: TrialWorkspaceInput,
    tenant: Tenant,
  ): Promise<void> {
    const memberRows = await run(
      `SELECT * FROM members
        WHERE tenant_id = $1 AND username = $2 AND role = $3
        ORDER BY id
        LIMIT 1`,
      [tenant.id, input.member.username, input.member.role],
    );
    const memberRow = memberRows[0];
    if (memberRow === undefined) {
      throw new AuthError(
        'idempotency_conflict',
        `tenant ${tenant.code} already exists without a member for this account`,
      );
    }
    const member = toMember(memberRow);

    // The member is the account's by construction, but nothing in the schema
    // says so: an administrator can link that member to a different account, and
    // the partial unique index on `member_user_links (member_id)` would then
    // reject the re-activation below. Refusing here says the same thing without
    // relying on the driver's error, and leaves the store write undone.
    const holderRows = await run(
      `SELECT * FROM member_user_links
        WHERE member_id = $1 AND revoked_at IS NULL
        LIMIT 1`,
      [member.id],
    );
    const holder = holderRows[0];
    if (holder !== undefined && holder.user_id !== input.userId) {
      throw new AuthError(
        'idempotency_conflict',
        `member ${member.id} is already linked to another account`,
      );
    }

    const storeRows = await run(
      `SELECT * FROM stores
        WHERE tenant_id = $1
        ORDER BY (id = $2) DESC, id
        LIMIT 1`,
      [tenant.id, member.storeId],
    );
    if (storeRows[0] === undefined) {
      // The store belongs to the tenant that already exists. The tenant id the
      // caller's input carries names a tenant that was never written, so a row
      // filed under it fails the `stores_tenant_id_fkey` constraint — a raw
      // driver fault, not a conflict this method recognises.
      await run(
        `INSERT INTO stores (id, tenant_id, code, name, enabled, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.store.id,
          tenant.id,
          input.store.code,
          input.store.name,
          input.store.enabled,
          input.store.createdAt,
        ],
      );
    }

    await run(
      `INSERT INTO member_user_links (
         id, user_id, tenant_id, member_id, linked_by, linked_at, revoked_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, member_id) DO UPDATE SET
         linked_by = EXCLUDED.linked_by,
         linked_at = EXCLUDED.linked_at,
         revoked_at = NULL,
         updated_at = EXCLUDED.updated_at`,
      [
        input.link.id,
        input.link.userId,
        tenant.id,
        member.id,
        input.link.linkedBy,
        input.link.linkedAt,
        input.link.revokedAt,
        input.link.createdAt,
        input.link.updatedAt,
      ],
    );
  }

  /** One tenant by the code that identifies it, or `undefined`. */
  private async findTenantByCodeWith(
    run: (text: string, values: ReadonlyArray<unknown>) => Promise<ReadonlyArray<QueryResultRow>>,
    code: string,
  ): Promise<Tenant | undefined> {
    const rows = await run('SELECT * FROM tenants WHERE code = $1', [code]);
    return rows.length === 0 ? undefined : toTenant(rows[0] as QueryResultRow);
  }

  /**
   * Read the workspace one account already acts through.
   *
   * The link, its member, that member's tenant and the tenant's default store
   * are read in one statement so the answer is consistent even while others
   * write — and so the same query serves both the plain read and the check
   * inside the provisioning transaction. A platform administrator member has no
   * tenant, and the inner joins drop it: it owns no workspace.
   *
   * The store is the member's own when it has one, otherwise the tenant's first
   * store by id; a tenant with no store at all still yields a workspace, with
   * `store: null`.
   */
  private async findTrialWorkspaceWith(
    run: (text: string, values: ReadonlyArray<unknown>) => Promise<ReadonlyArray<QueryResultRow>>,
    userId: string,
  ): Promise<TrialWorkspace | undefined> {
    const rows = await run(
      `SELECT
         t.id AS tenant_id, t.code AS tenant_code, t.name AS tenant_name,
         t.enabled AS tenant_enabled, t.created_at AS tenant_created_at,
         m.id AS member_id, m.tenant_id AS member_tenant_id, m.store_id AS member_store_id,
         m.role AS member_role, m.username AS member_username,
         m.display_name AS member_display_name, m.enabled AS member_enabled,
         m.created_at AS member_created_at,
         l.id AS link_id, l.user_id AS link_user_id, l.tenant_id AS link_tenant_id,
         l.member_id AS link_member_id, l.linked_by AS link_linked_by,
         l.linked_at AS link_linked_at, l.revoked_at AS link_revoked_at,
         l.created_at AS link_created_at, l.updated_at AS link_updated_at,
         s.id AS store_id, s.tenant_id AS store_tenant_id, s.code AS store_code,
         s.name AS store_name, s.enabled AS store_enabled, s.created_at AS store_created_at
       FROM member_user_links l
       JOIN members m ON m.id = l.member_id
       JOIN tenants t ON t.id = m.tenant_id
       LEFT JOIN LATERAL (
         SELECT st.* FROM stores st
          WHERE st.tenant_id = t.id
          ORDER BY (st.id = m.store_id) DESC, st.id
          LIMIT 1
       ) s ON TRUE
      WHERE l.user_id = $1 AND l.revoked_at IS NULL
      ORDER BY l.linked_at DESC, l.id DESC
      LIMIT 1`,
      [userId],
    );

    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      tenant: toTenant({
        id: row['tenant_id'],
        code: row['tenant_code'],
        name: row['tenant_name'],
        enabled: row['tenant_enabled'],
        created_at: row['tenant_created_at'],
      }),
      store:
        row['store_id'] === null || row['store_id'] === undefined
          ? null
          : toStore({
              id: row['store_id'],
              tenant_id: row['store_tenant_id'],
              code: row['store_code'],
              name: row['store_name'],
              enabled: row['store_enabled'],
              created_at: row['store_created_at'],
            }),
      member: toMember({
        id: row['member_id'],
        tenant_id: row['member_tenant_id'],
        store_id: row['member_store_id'],
        role: row['member_role'],
        username: row['member_username'],
        display_name: row['member_display_name'],
        enabled: row['member_enabled'],
        created_at: row['member_created_at'],
      }),
      link: toMemberLink({
        id: row['link_id'],
        user_id: row['link_user_id'],
        tenant_id: row['link_tenant_id'],
        member_id: row['link_member_id'],
        linked_by: row['link_linked_by'],
        linked_at: row['link_linked_at'],
        revoked_at: row['link_revoked_at'],
        created_at: row['link_created_at'],
        updated_at: row['link_updated_at'],
      }),
    };
  }

  /** @inheritdoc */
  async listActiveStoreScopes(
    tenantId: string,
    memberId: string,
  ): Promise<ReadonlyArray<MemberStoreScope>> {
    const rows = await this.query(
      `SELECT * FROM member_store_scopes
        WHERE tenant_id = $1 AND member_id = $2 AND revoked_at IS NULL
        ORDER BY store_id`,
      [tenantId, memberId],
    );
    return rows.map(toStoreScope);
  }

  /** @inheritdoc */
  async saveStoreScope(scope: MemberStoreScope): Promise<void> {
    await this.query(
      `INSERT INTO member_store_scopes (
         tenant_id, member_id, store_id, is_primary, granted_by, granted_at,
         revoked_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, member_id, store_id) DO UPDATE SET
         is_primary = EXCLUDED.is_primary,
         granted_by = EXCLUDED.granted_by,
         granted_at = EXCLUDED.granted_at,
         revoked_at = EXCLUDED.revoked_at,
         updated_at = EXCLUDED.updated_at`,
      [
        scope.tenantId,
        scope.memberId,
        scope.storeId,
        scope.isPrimary,
        scope.grantedBy,
        scope.grantedAt,
        scope.revokedAt,
        scope.createdAt,
        scope.updatedAt,
      ],
    );
  }

  /** @inheritdoc */
  async revokeStoreScope(
    tenantId: string,
    memberId: string,
    storeId: string,
    revokedAt: string,
  ): Promise<void> {
    await this.query(
      `UPDATE member_store_scopes
          SET revoked_at = $4, is_primary = FALSE, updated_at = $4
        WHERE tenant_id = $1 AND member_id = $2 AND store_id = $3 AND revoked_at IS NULL`,
      [tenantId, memberId, storeId, revokedAt],
    );
  }

  // --------------------------------------------------------------------------
  // One-time challenges
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async saveOtp(challenge: OtpChallenge): Promise<void> {
    await this.query(
      `INSERT INTO otp_challenges (
         id, tenant_id, user_id, purpose, channel, subject, code_hash, code_algorithm,
         status, failed_attempts, max_attempts, idempotency_key, issued_at, expires_at,
         consumed_at, revoked_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         failed_attempts = EXCLUDED.failed_attempts,
         consumed_at = EXCLUDED.consumed_at,
         revoked_at = EXCLUDED.revoked_at,
         updated_at = EXCLUDED.updated_at`,
      [
        challenge.id,
        challenge.tenantId,
        challenge.userId,
        challenge.purpose,
        challenge.channel,
        challenge.subject,
        challenge.codeHash,
        challenge.codeAlgorithm,
        challenge.status,
        challenge.failedAttempts,
        challenge.maxAttempts,
        challenge.idempotencyKey,
        challenge.issuedAt,
        challenge.expiresAt,
        challenge.consumedAt,
        challenge.revokedAt,
        challenge.createdAt,
        challenge.updatedAt,
      ],
    );
  }

  /** @inheritdoc */
  async getOtp(challengeId: string): Promise<OtpChallenge | undefined> {
    const rows = await this.query('SELECT * FROM otp_challenges WHERE id = $1', [challengeId]);
    return rows.length === 0 ? undefined : toOtpChallenge(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async findPendingOtp(subject: string, purpose: OtpPurpose): Promise<OtpChallenge | undefined> {
    const rows = await this.query(
      `SELECT * FROM otp_challenges
        WHERE subject = $1 AND purpose = $2 AND status = 'pending'
        ORDER BY issued_at DESC LIMIT 1`,
      [subject, purpose],
    );
    return rows.length === 0 ? undefined : toOtpChallenge(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async listOtpIssuedAt(
    subject: string,
    purpose: OtpPurpose,
    sinceIso: string,
  ): Promise<ReadonlyArray<string>> {
    const rows = await this.query(
      `SELECT issued_at FROM otp_challenges
        WHERE subject = $1 AND purpose = $2 AND issued_at >= $3
        ORDER BY issued_at`,
      [subject, purpose, sinceIso],
    );
    return rows.map((row) => toIso(row['issued_at']));
  }

  /** @inheritdoc */
  async listOtpsSince(
    subject: string,
    purpose: OtpPurpose,
    sinceIso: string,
  ): Promise<ReadonlyArray<OtpChallenge>> {
    const rows = await this.query(
      `SELECT * FROM otp_challenges
        WHERE subject = $1 AND purpose = $2 AND issued_at >= $3
        ORDER BY issued_at`,
      [subject, purpose, sinceIso],
    );
    return rows.map(toOtpChallenge);
  }

  // --------------------------------------------------------------------------
  // Trusted devices
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async saveDevice(device: TrustedDevice): Promise<void> {
    await this.query(
      `INSERT INTO trusted_devices (
         id, user_id, tenant_id, label, platform, credential_fingerprint, status,
         idempotency_key, trusted_at, expires_at, last_seen_at, revoked_at, revoked_reason,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label,
         platform = EXCLUDED.platform,
         status = EXCLUDED.status,
         last_seen_at = EXCLUDED.last_seen_at,
         revoked_at = EXCLUDED.revoked_at,
         revoked_reason = EXCLUDED.revoked_reason,
         updated_at = EXCLUDED.updated_at`,
      [
        device.id,
        device.userId,
        device.tenantId,
        device.label,
        device.platform,
        device.credentialFingerprint,
        device.status,
        device.idempotencyKey,
        device.trustedAt,
        device.expiresAt,
        device.lastSeenAt,
        device.revokedAt,
        device.revokedReason,
        device.createdAt,
        device.updatedAt,
      ],
    );
  }

  /** @inheritdoc */
  async getDevice(deviceId: string): Promise<TrustedDevice | undefined> {
    const rows = await this.query('SELECT * FROM trusted_devices WHERE id = $1', [deviceId]);
    return rows.length === 0 ? undefined : toTrustedDevice(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async findDeviceByFingerprint(fingerprint: string): Promise<TrustedDevice | undefined> {
    const rows = await this.query(
      'SELECT * FROM trusted_devices WHERE credential_fingerprint = $1 LIMIT 1',
      [fingerprint],
    );
    return rows.length === 0 ? undefined : toTrustedDevice(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async listDevices(userId: string): Promise<ReadonlyArray<TrustedDevice>> {
    const rows = await this.query(
      'SELECT * FROM trusted_devices WHERE user_id = $1 ORDER BY trusted_at DESC, id DESC',
      [userId],
    );
    return rows.map(toTrustedDevice);
  }

  // --------------------------------------------------------------------------
  // Sessions
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async saveSession(session: AuthSession): Promise<void> {
    await this.query(
      `INSERT INTO auth_sessions (
         id, user_id, tenant_id, member_id, trusted_device_id, token_fingerprint,
         previous_token_fingerprint, rotation_family_id, auth_method, status, mfa_satisfied,
         client_fingerprint, idempotency_key, issued_at, expires_at, last_seen_at,
         revoked_at, revoked_reason, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (id) DO UPDATE SET
         trusted_device_id = EXCLUDED.trusted_device_id,
         token_fingerprint = EXCLUDED.token_fingerprint,
         previous_token_fingerprint = EXCLUDED.previous_token_fingerprint,
         status = EXCLUDED.status,
         mfa_satisfied = EXCLUDED.mfa_satisfied,
         expires_at = EXCLUDED.expires_at,
         last_seen_at = EXCLUDED.last_seen_at,
         revoked_at = EXCLUDED.revoked_at,
         revoked_reason = EXCLUDED.revoked_reason,
         updated_at = EXCLUDED.updated_at`,
      [
        session.id,
        session.userId,
        session.tenantId,
        session.memberId,
        session.trustedDeviceId,
        session.tokenFingerprint,
        session.previousTokenFingerprint,
        session.rotationFamilyId,
        session.authMethod,
        session.status,
        session.mfaSatisfied,
        session.clientFingerprint,
        session.idempotencyKey,
        session.issuedAt,
        session.expiresAt,
        session.lastSeenAt,
        session.revokedAt,
        session.revokedReason,
        session.createdAt,
        session.updatedAt,
      ],
    );
  }

  /** @inheritdoc */
  async findSessionByFingerprint(fingerprint: string): Promise<AuthSession | undefined> {
    const rows = await this.query(
      'SELECT * FROM auth_sessions WHERE token_fingerprint = $1 LIMIT 1',
      [fingerprint],
    );
    return rows.length === 0 ? undefined : toAuthSession(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async findSessionByPreviousFingerprint(fingerprint: string): Promise<AuthSession | undefined> {
    const rows = await this.query(
      `SELECT * FROM auth_sessions
        WHERE previous_token_fingerprint = $1
        ORDER BY issued_at DESC LIMIT 1`,
      [fingerprint],
    );
    return rows.length === 0 ? undefined : toAuthSession(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async getSession(sessionId: string): Promise<AuthSession | undefined> {
    const rows = await this.query('SELECT * FROM auth_sessions WHERE id = $1', [sessionId]);
    return rows.length === 0 ? undefined : toAuthSession(rows[0] as QueryResultRow);
  }

  /** @inheritdoc */
  async listSessionsForUser(userId: string): Promise<ReadonlyArray<AuthSession>> {
    const rows = await this.query(
      'SELECT * FROM auth_sessions WHERE user_id = $1 ORDER BY issued_at DESC, id DESC',
      [userId],
    );
    return rows.map(toAuthSession);
  }

  /** @inheritdoc */
  async listSessionsForDevice(deviceId: string): Promise<ReadonlyArray<AuthSession>> {
    const rows = await this.query(
      'SELECT * FROM auth_sessions WHERE trusted_device_id = $1 ORDER BY issued_at DESC, id DESC',
      [deviceId],
    );
    return rows.map(toAuthSession);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /** Run one parameterised statement and return its rows. */
  private async query(
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Promise<ReadonlyArray<QueryResultRow>> {
    const result = await this.database.pool.query(text, [...values]);
    return result.rows;
  }
}

/** Rows of a statement run on a transaction connection, which reports `unknown`. */
function rowsOf(result: unknown): ReadonlyArray<QueryResultRow> {
  const rows = (result as { rows?: ReadonlyArray<QueryResultRow> } | null)?.rows;
  return rows ?? [];
}

/**
 * Translate a provisioning failure that is a directory conflict into the
 * documented `idempotency_conflict` refusal.
 *
 * The transactional body already refuses the conflicts it can recognise — a
 * tenant code held by somebody else's directory, a member actively linked to
 * another account — but two concurrent provisions of the same account can still
 * collide on a unique index that neither of them could have seen
 * (`tenants.code`, `stores (tenant_id, code)`, the active-link index). The
 * driver reports those as SQLSTATE `23505`; a caller must not see that as a raw
 * 500, because the request itself is well-formed and retrying it is the right
 * response. Anything else — a connection failure, a bug — is rethrown
 * unchanged, so a real fault is not disguised as a conflict.
 */
function asTrialProvisioningConflict(error: unknown): unknown {
  if (error instanceof AuthError) {
    return error;
  }
  if ((error as { code?: unknown } | null)?.code !== '23505') {
    return error;
  }
  return new AuthError(
    'idempotency_conflict',
    'the trial workspace conflicts with a directory row it cannot reuse',
  );
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : '';
}

function toIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function toTextOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toStringValue(value);
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function toTenant(row: QueryResultRow): Tenant {
  return {
    id: toStringValue(row['id']),
    code: toStringValue(row['code']),
    name: toStringValue(row['name']),
    enabled: toBoolean(row['enabled']),
    createdAt: toIso(row['created_at']),
  };
}

function toStore(row: QueryResultRow): Store {
  return {
    id: toStringValue(row['id']),
    tenantId: toStringValue(row['tenant_id']),
    code: toStringValue(row['code']),
    name: toStringValue(row['name']),
    enabled: toBoolean(row['enabled']),
    createdAt: toIso(row['created_at']),
  };
}

function toMember(row: QueryResultRow): Member {
  return {
    id: toStringValue(row['id']),
    tenantId: toTextOrNull(row['tenant_id']),
    storeId: toTextOrNull(row['store_id']),
    role: toStringValue(row['role']) as Member['role'],
    username: toStringValue(row['username']),
    displayName: toStringValue(row['display_name']),
    enabled: toBoolean(row['enabled']),
    createdAt: toIso(row['created_at']),
  };
}

function toUserAccount(row: QueryResultRow): UserAccount {
  return {
    id: toStringValue(row['id']),
    username: toStringValue(row['username']),
    displayName: toStringValue(row['display_name']),
    status: toStringValue(row['status']) as UserAccount['status'],
    passwordHash: toTextOrNull(row['password_hash']),
    passwordUpdatedAt: toIsoOrNull(row['password_updated_at']),
    failedLoginCount: toNumber(row['failed_login_count']),
    lockedUntil: toIsoOrNull(row['locked_until']),
    lastLoginAt: toIsoOrNull(row['last_login_at']),
    // The column is added by `0015`; a row written before it reads back as
    // `null` rather than as an error, which is what an account without a
    // picture is.
    avatarUrl: toTextOrNull(row['avatar_url']),
    idempotencyKey: toTextOrNull(row['idempotency_key']),
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
  };
}

function toUserIdentity(row: QueryResultRow): UserIdentity {
  return {
    id: toStringValue(row['id']),
    userId: toStringValue(row['user_id']),
    provider: toStringValue(row['provider']) as UserIdentity['provider'],
    subject: toStringValue(row['subject']),
    verified: toBoolean(row['verified']),
    verifiedAt: toIsoOrNull(row['verified_at']),
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
  };
}

function toMemberLink(row: QueryResultRow): MemberUserLink {
  return {
    id: toStringValue(row['id']),
    userId: toStringValue(row['user_id']),
    tenantId: toTextOrNull(row['tenant_id']),
    memberId: toStringValue(row['member_id']),
    linkedBy: toTextOrNull(row['linked_by']),
    linkedAt: toIso(row['linked_at']),
    revokedAt: toIsoOrNull(row['revoked_at']),
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
  };
}

function toStoreScope(row: QueryResultRow): MemberStoreScope {
  return {
    tenantId: toStringValue(row['tenant_id']),
    memberId: toStringValue(row['member_id']),
    storeId: toStringValue(row['store_id']),
    isPrimary: toBoolean(row['is_primary']),
    grantedBy: toTextOrNull(row['granted_by']),
    grantedAt: toIso(row['granted_at']),
    revokedAt: toIsoOrNull(row['revoked_at']),
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
  };
}

function toOtpChallenge(row: QueryResultRow): OtpChallenge {
  return {
    id: toStringValue(row['id']),
    tenantId: toTextOrNull(row['tenant_id']),
    userId: toTextOrNull(row['user_id']),
    purpose: toStringValue(row['purpose']) as OtpChallenge['purpose'],
    channel: toStringValue(row['channel']) as OtpChallenge['channel'],
    subject: toStringValue(row['subject']),
    codeHash: toStringValue(row['code_hash']),
    codeAlgorithm: toStringValue(row['code_algorithm']),
    status: toStringValue(row['status']) as OtpChallenge['status'],
    failedAttempts: toNumber(row['failed_attempts']),
    maxAttempts: toNumber(row['max_attempts']),
    idempotencyKey: toTextOrNull(row['idempotency_key']),
    issuedAt: toIso(row['issued_at']),
    expiresAt: toIso(row['expires_at']),
    consumedAt: toIsoOrNull(row['consumed_at']),
    revokedAt: toIsoOrNull(row['revoked_at']),
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
  };
}

function toTrustedDevice(row: QueryResultRow): TrustedDevice {
  return {
    id: toStringValue(row['id']),
    userId: toStringValue(row['user_id']),
    tenantId: toTextOrNull(row['tenant_id']),
    label: toStringValue(row['label']),
    platform: toStringValue(row['platform']) as TrustedDevice['platform'],
    credentialFingerprint: toStringValue(row['credential_fingerprint']),
    status: toStringValue(row['status']) as TrustedDevice['status'],
    idempotencyKey: toTextOrNull(row['idempotency_key']),
    trustedAt: toIso(row['trusted_at']),
    expiresAt: toIsoOrNull(row['expires_at']),
    lastSeenAt: toIso(row['last_seen_at']),
    revokedAt: toIsoOrNull(row['revoked_at']),
    revokedReason: toTextOrNull(row['revoked_reason']) as TrustedDevice['revokedReason'],
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
  };
}

function toAuthSession(row: QueryResultRow): AuthSession {
  return {
    id: toStringValue(row['id']),
    userId: toStringValue(row['user_id']),
    tenantId: toTextOrNull(row['tenant_id']),
    memberId: toTextOrNull(row['member_id']),
    trustedDeviceId: toTextOrNull(row['trusted_device_id']),
    tokenFingerprint: toStringValue(row['token_fingerprint']),
    previousTokenFingerprint: toTextOrNull(row['previous_token_fingerprint']),
    rotationFamilyId: toStringValue(row['rotation_family_id']),
    authMethod: toStringValue(row['auth_method']) as AuthSession['authMethod'],
    status: toStringValue(row['status']) as AuthSession['status'],
    mfaSatisfied: toBoolean(row['mfa_satisfied']),
    clientFingerprint: toTextOrNull(row['client_fingerprint']),
    idempotencyKey: toTextOrNull(row['idempotency_key']),
    issuedAt: toIso(row['issued_at']),
    expiresAt: toIso(row['expires_at']),
    lastSeenAt: toIso(row['last_seen_at']),
    revokedAt: toIsoOrNull(row['revoked_at']),
    revokedReason: toTextOrNull(row['revoked_reason']) as AuthSession['revokedReason'],
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
  };
}
