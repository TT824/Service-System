/**
 * The API-owned port for the credentials a real WeCom connection runs on.
 *
 * Until now these five values only ever came from the environment, and the
 * environment is read **once, at process start**: `RealWecomAdapter` and
 * `WecomTokenProvider` both take a snapshot in their constructors, so a value
 * typed into the console could not take effect without restarting two processes.
 * To let an operator type them and press 连接, they have to live somewhere both
 * processes read and either can be told is stale — which is the database.
 *
 * Three facts live behind this port, and nothing else:
 *
 * - **which values a deployment is currently connecting with.** Exactly one set
 *   at a time, because the transport is one account: the adapter signs with one
 *   `kf_secret` and one `open_kfid`. {@link WecomCredentialRepository.readCurrentCredentials}
 *   therefore answers by *refusal* rather than by picking — see its own note.
 * - **that a set was written by somebody, and whether it ever worked.** The
 *   verdict of the last real connection attempt is stored beside the values, so
 *   「上次验证时间」 survives a restart and a redeploy. A verdict belongs to the
 *   values it was reached on, which is why writing a new set clears it.
 * - **that a set can be written at all.** `wecom_channel_bindings` deliberately
 *   holds no credentials — Core's invariant is that nothing about a binding is a
 *   secret — and the console reads bindings, so credentials live in their own
 *   table keyed by binding. Credentials for a binding that is not `active` are
 *   refused: a disabled account resolves no callback, so its credentials could
 *   only ever fail.
 *
 * The *rules* are not here. What counts as a usable set — which fields must be
 * present and which length an `EncodingAESKey` has — is Core's
 * `wecomCredentialProblems`, and both adapters below store what they are given
 * without a second opinion: a set the database refused to keep would be a set
 * the operator could never be shown the problem with.
 *
 * Two adapters implement it, picked by the same environment boundary every other
 * channel store uses: `memory` for `APP_ENV=test`, `postgres` otherwise.
 */

import type { AppEnvironment, WecomCredentialValues } from '@kefu/core';

/** Injection token carrying the environment-selected credential store. */
export const WECOM_CREDENTIAL_REPOSITORY = Symbol('WECOM_CREDENTIAL_REPOSITORY');

/**
 * One stored credential set, with the binding it belongs to.
 *
 * The provider identity (`corpId`, `openKfId`) is the *binding's*, not a copy
 * kept beside the secrets: a credential row that carried its own `corp_id` could
 * disagree with the binding it hangs off, and there would be no answer to which
 * of the two a callback should match. {@link wecomCredentialValuesOf} assembles
 * the five values the transport needs from the two rows.
 *
 * `storeId` is read for the surfaces that have to say which scope this
 * connection writes into. `updated_by` is written by the table but not read
 * here: the account that typed a secret is an audit fact, not an input to
 * connecting, and the API does not expose one.
 */
export type WecomCredentialSet = {
  readonly bindingId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly corpId: string;
  readonly openKfId: string;
  readonly kfSecret: string;
  readonly callbackToken: string;
  readonly aesKey: string;
  /** When the last real connection attempt happened; `null` means never. */
  readonly verifiedAt: string | null;
  /** Why it failed, in the provider's own words; `null` means it did not. */
  readonly verifiedError: string | null;
  readonly updatedAt: string;
};

/** Data used to write (or replace) the credentials of one binding. */
export type SaveWecomCredentialsInput = {
  readonly tenantId: string;
  readonly bindingId: string;
  readonly values: WecomCredentialValues;
  readonly now: string;
  /** Account that typed them; `null` when unknown. */
  readonly updatedBy: string | null;
};

/** The outcome of one real connection attempt, to be stored. */
export type RecordWecomVerificationInput = {
  readonly tenantId: string;
  readonly bindingId: string;
  readonly now: string;
  /** Failure reason, or `null` when the attempt succeeded. */
  readonly error: string | null;
};

/**
 * Decide which credential store an environment uses.
 *
 * @param appEnv - Application runtime boundary.
 * @returns `memory` for `test`, `postgres` otherwise.
 */
export function resolveWecomCredentialMode(appEnv: AppEnvironment): 'memory' | 'postgres' {
  return appEnv === 'test' ? 'memory' : 'postgres';
}

/**
 * The five values the transport needs, assembled from a stored set.
 *
 * The one place the names of the two rows are joined: `WECOM_TOKEN` is stored as
 * `callback_token` and handed to the transport as `callbackToken`, and the
 * provider identity comes from the binding.
 *
 * @param set - A stored credential set.
 * @returns The typed values, in the shape Core's rules read.
 */
export function wecomCredentialValuesOf(set: WecomCredentialSet): WecomCredentialValues {
  return {
    corpId: set.corpId,
    kfSecret: set.kfSecret,
    callbackToken: set.callbackToken,
    aesKey: set.aesKey,
    openKfId: set.openKfId,
  };
}

/**
 * Credentials for the WeCom connection, keyed by the binding they belong to.
 *
 * A returned `undefined` or `false` is always a *decision* rather than an error:
 * no such binding, a binding in another tenant, a binding that is not active, or
 * nothing to record a verdict against. Each is answered with a stable refusal by
 * the caller, never by inventing a scope or by storing a secret nothing can use.
 */
export interface WecomCredentialRepository {
  /**
   * Write, or replace, the credentials of one binding.
   *
   * Replacing clears the stored verdict: 「上次验证成功」 is a fact about the
   * values that were verified, and it stops being one the moment they change.
   *
   * @param input - Binding, values and who wrote them.
   * @returns `true` when a row was written, `false` when the binding does not
   * exist in this tenant or is not active.
   */
  saveCredentials(input: SaveWecomCredentialsInput): Promise<boolean>;

  /**
   * Record the outcome of one real connection attempt.
   *
   * @param input - Binding and the verdict.
   * @returns `true` when there were credentials to record it against, `false`
   * when there are none (or the binding is not this tenant's).
   */
  recordVerification(input: RecordWecomVerificationInput): Promise<boolean>;

  /**
   * The set this deployment is connecting with.
   *
   * `undefined` is a decision with three names — nothing stored, no stored set
   * whose binding still resolves, or more than one of them — and no caller may
   * tell them apart from here. That is the same stance `findActiveBinding`
   * takes, and for the same reason: a connection that quietly served the newest
   * of two accounts would send one company's replies under an identity nobody
   * chose. A deployment that holds two credentialed accounts therefore reports
   * 「未配置」 and fails loudly, and the console's own binding list is where the
   * operator can see why.
   */
  readCurrentCredentials(): Promise<WecomCredentialSet | undefined>;
}
