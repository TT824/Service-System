/**
 * The credential reader both applications authenticate through.
 *
 * One function, because the API and the Worker must never disagree about which
 * account this deployment speaks as: they share one customer-service token, so
 * "the API sent as acme and the Worker retried as beta" is not a divergence the
 * platform can explain to a customer. Both build their reader here, over their
 * own repository instance, and the decision itself is `@kefu/core`'s
 * `resolveWecomCredentials`.
 *
 * **Read on every operation, never cached.** The obvious optimisation is a few
 * seconds of memoisation, and it is wrong here: a delivery the transport refuses
 * because the account is not configured is classified `retryable: false`, so an
 * outbox entry that reads a stale credential can be burned permanently by it.
 * The read is one indexed `SELECT ... LIMIT 2` against a table with at most a
 * couple of rows, and it happens once per send or callback — the same paths that
 * are already doing database work. Correctness first; the query is not the cost
 * in this loop.
 *
 * A read that fails is not swallowed. Falling back to the environment when the
 * database is unreachable would mean authenticating as a company the operator
 * did not choose, silently, for the duration of an outage — the one thing this
 * whole arrangement exists to prevent. The failure propagates to a caller that
 * can classify it, exactly as a database failure anywhere else does.
 */

import { resolveWecomCredentials, type AppConfig, type WecomCredentialResolution } from '@kefu/core';
import { wecomCredentialValuesOf, type WecomCredentialRepository } from './wecom-credential.repository';

/**
 * Injection token carrying the bound reader.
 *
 * A token rather than each caller building one: the reader *is* the deployment's
 * answer to "which account are we", and two readers built over two repository
 * instances would be two answers. One provider, one reader, both applications.
 */
export const WECOM_CREDENTIAL_READER = Symbol('WECOM_CREDENTIAL_READER');

/**
 * Build the reader a transport authenticates through.
 *
 * @param input.repository - Credential store, the durable one in a real boot.
 * @param input.config - Parsed configuration, whose `wecom` slice is the fallback.
 * @returns A reader answering what this deployment authenticates with, now.
 */
export function wecomCredentialReaderOf(input: {
  readonly repository: WecomCredentialRepository;
  readonly config: AppConfig;
}): () => Promise<WecomCredentialResolution> {
  return async () => {
    const stored = await input.repository.readCurrentCredentials();
    return resolveWecomCredentials({
      // `undefined` has three names in the store — nothing stored, nothing whose
      // binding resolves, more than one — and all three mean the same thing
      // here: the console holds no set this deployment can speak as, so the
      // environment's is the one to use.
      stored: stored === undefined ? undefined : wecomCredentialValuesOf(stored),
      environment: input.config.wecom,
    });
  };
}
