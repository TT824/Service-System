/**
 * The production {@link WecomScopeResolver}: the durable account binding.
 *
 * A real WeCom callback arrives with no platform session, so the only fact that
 * can say which tenant and store a message belongs to is the *persistent*
 * binding of the `(corp_id, open_kfid)` account that received it. WeCom posts
 * two callback shapes and both name that account:
 *
 * - a **direct message callback**, which carries the message itself and reaches
 *   this resolver through {@link RealWecomAdapter.readNotification}; and
 * - a **`kf_msg_or_event` notification**, which carries no message and is
 *   resolved by `WecomSyncService` before it pulls.
 *
 * They are two entry points to one decision, so they are one function: both ask
 * {@link WecomBindingRepository.findActiveBinding} for the same pair and both
 * refuse with `channel_not_configured` when it resolves nothing. Resolving the
 * account once here is what stops a deployment from being able to pull a
 * backlog for an account whose direct callbacks it refuses.
 *
 * The store's read is the first half of the recheck — only `status = 'active'`
 * rows resolve, and the store is joined back to the binding's own tenant. The
 * second half belongs to the ingestion path, which re-checks the resolved tenant
 * and store against the platform directory before anything is written.
 *
 * Nothing else is carried: no credential, no provider payload and no member
 * identity. A `null` return is a decision, never an error.
 */

import type { WecomScopeResolver } from './real-wecom.adapter';
import type { WecomBindingRepository } from './wecom-binding.repository';

/**
 * Resolve every customer-service callback from the durable account bindings.
 *
 * @param bindings - The environment-selected binding store, the same one the
 * `kf/sync_msg` pull resolves its account through.
 * @returns A resolver that answers from the persistent binding, or `null`.
 */
export function wecomScopeResolverFromBindings(
  bindings: WecomBindingRepository,
): WecomScopeResolver {
  return async ({ corpId, openKfId }) => {
    if (openKfId === null) {
      // A callback that names no account cannot be looked up, and guessing the
      // configured one would attribute a message to an account that did not
      // receive it.
      return null;
    }
    const binding = await bindings.findActiveBinding(corpId, openKfId);
    return binding === undefined ? null : { tenantId: binding.tenantId, storeId: binding.storeId };
  };
}
