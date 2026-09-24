/**
 * Durable {@link WecomCredentialRepository} over the table migration `0017`
 * declares.
 *
 * Each statement carries the whole of its own step and is one statement on
 * purpose: a write here is followed by a *provider round trip*, so no
 * transaction may be held open across it — the values are committed first and
 * the verdict is written by a second statement afterwards.
 *
 * - **save** is one `INSERT ... SELECT ... ON CONFLICT ... DO UPDATE`. The
 *   `SELECT` is the guard, not a read the caller makes first: it resolves the
 *   binding by `id` **and** `tenant_id` **and** `status = 'active'` *and*
 *   through the same `tenants`/`stores` join the read uses, so a write naming
 *   another tenant's binding, a switched-off account, or a binding whose scope
 *   does not resolve inserts nothing and matches no conflict — the statement is
 *   a no-op and that is the refusal. That last clause is what keeps the write
 *   and the read from disagreeing: a set stored on a scope that cannot carry a
 *   connection would let 连接 report success on credentials the transport would
 *   then never pick up. The update half clears `verified_at`/`verified_error`,
 *   because a verdict belongs to the values it was reached on.
 * - **save also refuses a second live credential.** `NOT EXISTS` asks the read's
 *   own question — is there another credential row whose binding resolves? — and
 *   refuses the write when there is. Without it a second account could be
 *   connected over a first, and the deployment's single transport would then
 *   read *two* live sets: the read refuses that as ambiguous, which is the
 *   correct answer and a terrible outcome, because the connection that was
 *   working stops. Refusing the write is where 「一个部署连一个客服账号」 becomes a
 *   rule of the store rather than a coincidence of use, and it is why the read
 *   can go on treating "no single live set" as "nothing to authenticate with"
 *   and let the environment be the fallback. An account switched *off* is not in
 *   this question's scope — its row stays, and stops counting, exactly as it
 *   stops resolving.
 * - **record** is one `UPDATE` whose `EXISTS` clause is the tenant guard. It is
 *   deliberately *not* restricted to active bindings: it writes down what an
 *   attempt did, and an account switched off between the write and the probe
 *   would otherwise lose a verdict that really was reached. A row whose binding
 *   is gone cannot be updated at all — migration `0017` gives the credential row
 *   `ON DELETE CASCADE`, so there is nothing left to write to.
 * - **read current** joins `tenants` and `stores` *on the binding's own tenant*,
 *   exactly as the account resolution does, so a credential set pointing at a
 *   scope that no longer resolves cannot carry a connection. It asks for at most
 *   two rows and accepts only exactly one: two credentialed accounts are refused
 *   rather than guessed, because the transport is one account.
 *
 * Every statement is parameterised. No statement here ever returns a value to a
 * caller that is not the transport: the only projection of these columns is
 * {@link WecomCredentialSet}, and the surfaces above it decide what may be said
 * out loud.
 */

import type { QueryResult, QueryResultRow } from 'pg';
import { toIso, toIsoOrNull, toText, toTextOrNull } from '../persistence/row-values';
import { DatabaseService } from '../database/database.service';
import type {
  RecordWecomVerificationInput,
  SaveWecomCredentialsInput,
  WecomCredentialRepository,
  WecomCredentialSet,
} from './wecom-credential.repository';

/** Credential store backed by the API-owned PostgreSQL pool. */
export class PostgresWecomCredentialRepository implements WecomCredentialRepository {
  /**
   * @param database - The API-owned connection pool. Every statement here is
   * one atomic write, so no explicit transaction boundary is needed.
   */
  constructor(private readonly database: DatabaseService) {}

  /** @inheritdoc */
  async saveCredentials(input: SaveWecomCredentialsInput): Promise<boolean> {
    const rows = await this.rows(
      `INSERT INTO wecom_channel_credentials
         (binding_id, kf_secret, callback_token, aes_key,
          verified_at, verified_error, created_at, updated_at, updated_by)
       SELECT b.id, $3, $4, $5, NULL, NULL, $6, $6, $7
         FROM wecom_channel_bindings b
         JOIN tenants t ON t.id = b.tenant_id
         JOIN stores s ON s.id = b.store_id AND s.tenant_id = b.tenant_id
        WHERE b.id = $1 AND b.tenant_id = $2 AND b.status = 'active'
          AND NOT EXISTS (
            SELECT 1
              FROM wecom_channel_credentials c2
              JOIN wecom_channel_bindings b2 ON b2.id = c2.binding_id
              JOIN tenants t2 ON t2.id = b2.tenant_id
              JOIN stores s2 ON s2.id = b2.store_id AND s2.tenant_id = b2.tenant_id
             WHERE b2.status = 'active' AND c2.binding_id <> b.id)
       ON CONFLICT (binding_id) DO UPDATE
          SET kf_secret = EXCLUDED.kf_secret,
              callback_token = EXCLUDED.callback_token,
              aes_key = EXCLUDED.aes_key,
              verified_at = NULL,
              verified_error = NULL,
              updated_at = EXCLUDED.updated_at,
              updated_by = EXCLUDED.updated_by
       RETURNING binding_id`,
      [
        input.bindingId,
        input.tenantId,
        input.values.kfSecret,
        input.values.callbackToken,
        input.values.aesKey,
        input.now,
        input.updatedBy,
      ],
    );
    return rows.length === 1;
  }

  /** @inheritdoc */
  async recordVerification(input: RecordWecomVerificationInput): Promise<boolean> {
    // `verified_at` is written on both outcomes: migration `0017`'s check
    // constraint says a reason requires an instant beside it, and 「试过了、失败
    // 了、因为什么」 is one fact in three parts rather than two.
    const rows = await this.rows(
      `UPDATE wecom_channel_credentials c
          SET verified_at = $3, verified_error = $4, updated_at = $3
        WHERE c.binding_id = $1
          AND EXISTS (SELECT 1 FROM wecom_channel_bindings b
                       WHERE b.id = c.binding_id AND b.tenant_id = $2)
       RETURNING c.binding_id`,
      [input.bindingId, input.tenantId, input.now, input.error],
    );
    return rows.length === 1;
  }

  /** @inheritdoc */
  async readCurrentCredentials(): Promise<WecomCredentialSet | undefined> {
    const rows = await this.rows(
      `SELECT c.binding_id, c.kf_secret, c.callback_token, c.aes_key,
              c.verified_at, c.verified_error, c.updated_at,
              b.tenant_id, b.store_id, b.corp_id, b.open_kfid
         FROM wecom_channel_credentials c
         JOIN wecom_channel_bindings b ON b.id = c.binding_id
         JOIN tenants t ON t.id = b.tenant_id
         JOIN stores s ON s.id = b.store_id AND s.tenant_id = b.tenant_id
        WHERE b.status = 'active'
        ORDER BY c.updated_at DESC, c.binding_id
        LIMIT 2`,
      [],
    );
    // Exactly one, or nothing: two credentialed accounts cannot both own one
    // transport, and picking the newest would send replies under an identity
    // nobody chose.
    const [only, extra] = rows;
    return only !== undefined && extra === undefined ? toCredentialSet(only) : undefined;
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

/** Row-to-domain mapping for one stored credential set. */
function toCredentialSet(row: QueryResultRow): WecomCredentialSet {
  return {
    bindingId: toText(row['binding_id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    corpId: toText(row['corp_id']),
    openKfId: toText(row['open_kfid']),
    kfSecret: toText(row['kf_secret']),
    callbackToken: toText(row['callback_token']),
    aesKey: toText(row['aes_key']),
    verifiedAt: toIsoOrNull(row['verified_at']),
    verifiedError: toTextOrNull(row['verified_error']),
    updatedAt: toIso(row['updated_at']),
  };
}
