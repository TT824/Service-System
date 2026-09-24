/**
 * Durable {@link WecomBindingRepository} over the tables migration `0007`
 * declares.
 *
 * Each statement carries the whole of its own step, and each is a single
 * statement on purpose — no transaction wraps a provider round trip:
 *
 * - **create** writes the row Core's `createWeComBinding` built, with the
 *   partial unique index `0007` declares as its conflict arbiter: a second
 *   *active* binding for one provider account is refused by the database rather
 *   than by a read that raced another writer. **list** reads every binding back,
 *   disabled rows included, so the console can show the account that is the
 *   reason a create was refused.
 * - **resolve** joins the binding to `tenants` and to `stores` *on the binding's
 *   own tenant*, so a row that names another tenant's store resolves nothing.
 *   It asks for at most two rows and accepts only exactly one, so an ambiguous
 *   account is refused rather than guessed; the partial unique index migration
 *   `0007` declares makes two active rows for one account impossible in the
 *   first place, and this read does not rely on that alone.
 * - **claim** is one `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE`, so the
 *   create and the takeover of an expired lease are the same atomic step and two
 *   racing notifications cannot both win. The `WHERE` accepts a row nobody holds,
 *   one whose lease already expired, or one whose live lease is *this* owner's,
 *   so a live lease is never stolen from another owner and the owner that holds
 *   it can renew in place — Core's `canClaimWeComSyncCursor`, in SQL.
 * - **renew**, **advance** and **release** are compare-by-owner updates: the row
 *   only moves when `lease_owner` is still the caller's, which is what stops an
 *   owner whose lease expired and was reclaimed from renewing, advancing or
 *   releasing the newer claim — Core's `renewWeComSyncCursor`,
 *   `advanceWeComSyncCursor` and `releaseWeComSyncCursor`, in SQL. Advancing
 *   *keeps* the lease rather than dropping it, because a pull that still has
 *   pages to fetch still owns the account; the caller releases the claim when the
 *   pull is over, so a finished pull frees the next notification immediately
 *   instead of making it wait for the lease to expire.
 *
 * Every statement is parameterised and scoped by `tenant_id`, and the cursor's
 * composite foreign key keeps it inside the binding's own tenant.
 *
 * The rules these statements reproduce live in `@kefu/core` and are named on
 * each statement below, so a reader can check the SQL against the transition it
 * mirrors instead of against prose. The lease length is read from Core too: no
 * caller passes one.
 */

import {
  isWeComBindingStatus,
  isWeComSyncCursorPosition,
  WECOM_SYNC_LEASE_MS,
  type WeComChannelBinding,
} from '@kefu/core';
import type { QueryResult, QueryResultRow } from 'pg';
import { toIso, toIsoOrNull, toText, toTextOrNull } from '../persistence/row-values';
import { DatabaseService } from '../database/database.service';
import type {
  AdvanceCursorInput,
  ClaimCursorInput,
  CursorLeaseInput,
  RenewCursorInput,
  WecomActiveBinding,
  WecomBindingRepository,
  WecomCursorClaim,
} from './wecom-binding.repository';

/** Binding store backed by the API-owned PostgreSQL pool. */
export class PostgresWecomBindingRepository implements WecomBindingRepository {
  /**
   * @param database - The API-owned connection pool. Every statement here is
   * one atomic write, so no explicit transaction boundary is needed.
   */
  constructor(private readonly database: DatabaseService) {}

  /** @inheritdoc */
  async findActiveBinding(
    corpId: string,
    openKfId: string,
  ): Promise<WecomActiveBinding | undefined> {
    const rows = await this.rows(
      `SELECT b.id, b.tenant_id, b.store_id, b.corp_id, b.open_kfid
         FROM wecom_channel_bindings b
         JOIN tenants t ON t.id = b.tenant_id
         JOIN stores s ON s.id = b.store_id AND s.tenant_id = b.tenant_id
        WHERE b.corp_id = $1 AND b.open_kfid = $2 AND b.status = 'active'
        ORDER BY b.updated_at, b.id
        LIMIT 2`,
      [corpId, openKfId],
    );
    // Exactly one, or nothing: two candidates is an ambiguous account, and a
    // callback must never be written into a scope that was picked by guessing.
    const [only, extra] = rows;
    return only !== undefined && extra === undefined ? toBinding(only) : undefined;
  }

  /** @inheritdoc */
  async createBinding(binding: WeComChannelBinding): Promise<boolean> {
    // One statement, and the uniqueness decision is the database's: the arbiter
    // is the partial unique index `0007` declares, named by its own predicate so
    // the inference cannot silently land on another index. `DO NOTHING` is the
    // refusal — the create is not a rebind, so an account that already resolves
    // a callback keeps resolving it, and the caller is the one that has to
    // disable that binding before asking for another.
    //
    // A disabled row cannot reach the arbiter at all: the index covers `active`
    // rows only, so two switched-off bindings of one account coexist, exactly as
    // the migration's own comment describes.
    const rows = await this.rows(
      `INSERT INTO wecom_channel_bindings
         (id, tenant_id, store_id, corp_id, open_kfid, status,
          created_at, updated_at, disabled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (corp_id, open_kfid) WHERE status = 'active' DO NOTHING
       RETURNING id`,
      [
        binding.id,
        binding.tenantId,
        binding.storeId,
        binding.corpId,
        binding.openKfId,
        binding.status,
        binding.createdAt,
        binding.updatedAt,
        binding.disabledAt,
      ],
    );
    return rows.length === 1;
  }

  /** @inheritdoc */
  async listBindings(): Promise<ReadonlyArray<WeComChannelBinding>> {
    const rows = await this.rows(
      `SELECT id, tenant_id, store_id, corp_id, open_kfid, status,
              created_at, updated_at, disabled_at
         FROM wecom_channel_bindings
        ORDER BY created_at DESC, id`,
      [],
    );
    return rows.map(toStoredBinding);
  }

  /** @inheritdoc */
  async claimCursor(input: ClaimCursorInput): Promise<WecomCursorClaim | undefined> {
    const leaseExpiresAt = leaseEndingAt(input.now);
    const rows = await this.rows(
      `INSERT INTO wecom_sync_cursors
         (id, tenant_id, binding_id, cursor, lease_owner, lease_expires_at,
          last_synced_at, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, $4, $5, NULL, $6, $6)
       ON CONFLICT (binding_id) DO UPDATE
          SET lease_owner = EXCLUDED.lease_owner,
              lease_expires_at = EXCLUDED.lease_expires_at,
              updated_at = EXCLUDED.updated_at
        WHERE wecom_sync_cursors.lease_expires_at IS NULL
           OR wecom_sync_cursors.lease_expires_at <= EXCLUDED.updated_at
           -- A live lease this same owner already holds is renewable in place,
           -- so the owner of a running pull is never locked out by itself.
           -- Another owner's live lease still matches none of these.
           OR wecom_sync_cursors.lease_owner = EXCLUDED.lease_owner
       RETURNING id, tenant_id, binding_id, cursor, lease_owner, lease_expires_at`,
      [
        `wecom-cursor-${input.bindingId}`,
        input.tenantId,
        input.bindingId,
        input.owner,
        leaseExpiresAt,
        input.now,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      // The conflict clause matched a row somebody else still holds: the
      // statement is a no-op and reports nothing, which is the refusal.
      return undefined;
    }
    return {
      bindingId: toText(row['binding_id']),
      tenantId: toText(row['tenant_id']),
      cursor: toTextOrNull(row['cursor']),
      owner: toText(row['lease_owner']),
      leaseExpiresAt: toIso(row['lease_expires_at']),
    };
  }

  /** @inheritdoc */
  async renewCursor(input: RenewCursorInput): Promise<boolean> {
    const leaseExpiresAt = leaseEndingAt(input.now);
    const rows = await this.rows(
      `UPDATE wecom_sync_cursors
          SET lease_expires_at = $5, updated_at = $4
        WHERE tenant_id = $1 AND binding_id = $2 AND lease_owner = $3
        RETURNING id`,
      [input.tenantId, input.bindingId, input.owner, input.now, leaseExpiresAt],
    );
    return rows.length === 1;
  }

  /** @inheritdoc */
  async advanceCursor(input: AdvanceCursorInput): Promise<boolean> {
    if (!isWeComSyncCursorPosition(input.cursor)) {
      // No row may be advanced to "no position": the stored cursor is where the
      // account resumes from, and erasing it re-pulls the backlog from the top.
      // The shared rule refuses this before it can reach the statement.
      throw new Error('channel invariant: a kf/sync_msg position must not be blank');
    }
    const rows = await this.rows(
      `UPDATE wecom_sync_cursors
          SET cursor = $5, last_synced_at = $4, updated_at = $4
        WHERE tenant_id = $1 AND binding_id = $2 AND lease_owner = $3
        RETURNING id`,
      [input.tenantId, input.bindingId, input.owner, input.now, input.cursor],
    );
    return rows.length === 1;
  }

  /** @inheritdoc */
  async releaseCursor(input: CursorLeaseInput): Promise<boolean> {
    const rows = await this.rows(
      `UPDATE wecom_sync_cursors
          SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $4
        WHERE tenant_id = $1 AND binding_id = $2 AND lease_owner = $3
        RETURNING id`,
      [input.tenantId, input.bindingId, input.owner, input.now],
    );
    return rows.length === 1;
  }

  /** Run one parameterised statement on the pool and return its rows. */
  private async rows(
    text: string,
    values: ReadonlyArray<unknown>,
  ): Promise<ReadonlyArray<QueryResultRow>> {
    const result = (await this.database.pool.query(text, [
      ...values,
    ])) as QueryResult<QueryResultRow>;
    return result.rows;
  }
}

/**
 * The instant a lease taken at `now` runs out.
 *
 * The length is Core's single `WECOM_SYNC_LEASE_MS`, so this statement and the
 * in-process store cannot lease the same account for different periods.
 */
function leaseEndingAt(now: string): string {
  return new Date(Date.parse(now) + WECOM_SYNC_LEASE_MS).toISOString();
}

/** Row-to-domain mapping for one active binding. */
function toBinding(row: QueryResultRow): WecomActiveBinding {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    corpId: toText(row['corp_id']),
    openKfId: toText(row['open_kfid']),
  };
}

/**
 * Row-to-domain mapping for one stored binding, disabled rows included.
 *
 * A status the domain does not know is read as `disabled` rather than as
 * `active`. The column carries a `CHECK`, so the case cannot arise through the
 * platform's own writes — but if it ever did, the safe answer is the one that
 * resolves no callback: defaulting the other way would switch a switched-off
 * account back on, which is the only direction that can write a customer's
 * message into a scope nobody authorized.
 */
function toStoredBinding(row: QueryResultRow): WeComChannelBinding {
  const status = toText(row['status']);
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    corpId: toText(row['corp_id']),
    openKfId: toText(row['open_kfid']),
    status: isWeComBindingStatus(status) ? status : 'disabled',
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
    disabledAt: toIsoOrNull(row['disabled_at']),
  };
}
