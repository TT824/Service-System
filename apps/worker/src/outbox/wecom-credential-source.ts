/**
 * The credentials a real outbound send authenticates with, asked once per send.
 *
 * **This query is the API's query, re-said.** `apps/api` reads the same table
 * through its own `PostgresWecomCredentialRepository`, and the two are
 * deliberately not shared: the Worker does not import anything under `apps/api`,
 * because that would make the two workspaces one workspace. What is duplicated
 * is one statement; what is not is the rule it serves —
 * {@link resolveWecomCredentials} is `@kefu/core`'s, so both processes decide
 * "stored beats environment, and a half-typed stored set is still the one to
 * report" from the same code.
 *
 * The read itself is a *function* rather than a snapshot, and that is the whole
 * point of the exercise: a Worker started before an operator typed anything into
 * the console has to pick the values up without being restarted. Caching them
 * here would reproduce, one process further out, exactly the bug this replaced —
 * and would do it worse, because `channel_not_configured` is not retryable, so a
 * single send attempted against a stale snapshot can burn an outbox entry the
 * operator believes is only waiting.
 *
 * A read that *fails* is not swallowed. Falling back to the environment during a
 * database outage would authenticate as a company nobody chose, which is a
 * failure of a different order from refusing to send for a moment.
 *
 * The read asks for at most two rows and accepts only exactly one. That is the
 * same stance the API's read takes, and the reason it can is that the API's
 * *write* refuses a second live credential — so the ambiguous state is one only
 * a hand-edited database reaches, and answering it with 「未配置」 is the loud
 * failure rather than a silent pick.
 */

import {
  resolveWecomCredentials,
  type AppConfig,
  type WecomCredentialResolution,
  type WecomCredentialValues,
} from '@kefu/core';
import type { QueryResultRow } from 'pg';
import type { WecomCredentialReader } from '@kefu/wecom';
import type { WorkerDatabase } from '../database/worker-database';
import { toText } from '../database/row-values';

/** Injection token carrying the Worker's credential reader. */
export const WECOM_CREDENTIAL_READER = Symbol('WECOM_CREDENTIAL_READER');

/**
 * Build the Worker's credential reader over its own pool.
 *
 * @param input - The Worker's database and the parsed environment the stored
 * set falls back to.
 * @returns A function the shared transport calls once per operation.
 */
export function wecomCredentialReaderOf(input: {
  readonly database: WorkerDatabase;
  readonly environment: AppConfig['wecom'];
}): WecomCredentialReader {
  return async (): Promise<WecomCredentialResolution> => {
    const rows = await input.database.rows(
      `SELECT c.kf_secret, c.callback_token, c.aes_key, b.corp_id, b.open_kfid
         FROM wecom_channel_credentials c
         JOIN wecom_channel_bindings b ON b.id = c.binding_id
         JOIN tenants t ON t.id = b.tenant_id
         JOIN stores s ON s.id = b.store_id AND s.tenant_id = b.tenant_id
        WHERE b.status = 'active'
        ORDER BY c.updated_at DESC, c.binding_id
        LIMIT 2`,
      [],
    );
    const [only, extra] = rows;
    const stored = only !== undefined && extra === undefined ? valuesOf(only) : undefined;
    return resolveWecomCredentials({ stored, environment: input.environment });
  };
}

/** The five values the transport authenticates with, read off one joined row. */
function valuesOf(row: QueryResultRow): WecomCredentialValues {
  return {
    corpId: toText(row['corp_id']),
    kfSecret: toText(row['kf_secret']),
    callbackToken: toText(row['callback_token']),
    aesKey: toText(row['aes_key']),
    openKfId: toText(row['open_kfid']),
  };
}
