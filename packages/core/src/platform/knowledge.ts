/**
 * The lifecycle rule for knowledge sources: `enabled` decides usability.
 *
 * A knowledge row (product, FAQ, shortcut) is never deleted when it goes out of
 * service — it is 停用, a reversible state, so the management surface has to be
 * able to find it again and put it back. That is why the knowledge reads return
 * every row of the tenant scope, enabled or not, and why the read that feeds the
 * reply pipeline is the one that applies this rule.
 *
 * It lives here, once, rather than inside each adapter's query: the SQL and the
 * in-process store have to agree by construction, and a second copy would be a
 * second answer to "may this be used to answer a customer?".
 */

/**
 * The knowledge entries that may still be used as candidate material.
 *
 * @param items - Knowledge rows of one tenant and store scope, in any state.
 * @returns The enabled rows, in the order they were given.
 */
export function usableKnowledge<T extends { readonly enabled: boolean }>(
  items: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return items.filter((item) => item.enabled);
}
