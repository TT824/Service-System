/**
 * The store a seat serves in, decided without asking.
 *
 * One rule, one copy. Two callers need it — approving an applicant, and an
 * administrator creating a seat — and they must not disagree: the answer is
 * written into `members.store_id`, which the kernel's CHECK requires of every
 * `agent`, and which decides nothing the seat can see any more (a seat reads the
 * whole tenant). So the rule is allowed to be this blunt.
 *
 * The rule:
 *
 * 1. the store the tenant's enabled agents already serve in, by majority — the
 *    answer that puts a new seat where the work is;
 * 2. otherwise the first enabled store;
 * 3. otherwise the default store, created (or re-enabled) on the spot.
 *
 * Step 3 exists because of what the console stopped offering. The store is not a
 * concept in the product any more: there is no screen that creates one, so a
 * deployment whose stores are all gone or all switched off would otherwise be
 * unable to add a seat — or to approve the applicant waiting behind that seat —
 * with no way back from the interface. Refusing was the old behaviour and it was
 * right while a store screen existed; it is a deadlock now. A store nobody chose
 * is harmless here precisely because the seat does not read through it.
 */

import type { AuthIdGenerator } from './clock';
import type { AuthRepository } from './ports';
import { TRIAL_STORE_CODE, TRIAL_STORE_NAME } from './trial-workspace';
import type { Store } from '../platform/types';

/** What resolving a serving store reads, and what it may have to write. */
export type ServingStoreDirectory = Pick<
  AuthRepository,
  'listStores' | 'saveStore' | 'listMembers'
>;

/**
 * Pick the store a seat serves in, creating the default one if there is none.
 *
 * @param input.repository - Directory to read, and to write the default store to.
 * @param input.ids - Identifier generator, used only for a created store.
 * @param input.now - Instant stamped on a created store.
 * @param input.tenantId - The tenant the seat joins.
 * @returns The store to serve in, never `undefined`.
 */
export async function resolveServingStore(input: {
  readonly repository: ServingStoreDirectory;
  readonly ids: AuthIdGenerator;
  readonly now: string;
  readonly tenantId: string;
}): Promise<Store> {
  const { repository, ids, now, tenantId } = input;
  const stores = await repository.listStores(tenantId);
  const enabled = stores.filter((store) => store.enabled);
  const fallback = enabled[0];
  if (fallback === undefined) {
    return ensureDefaultStore({ repository, ids, now, tenantId, stores });
  }

  // Count only the seats that could actually be served by: an agent that is
  // switched off is not evidence that its store is where the work is.
  const serving = new Map<string, number>();
  for (const member of await repository.listMembers(tenantId)) {
    if (member.role !== 'agent' || !member.enabled || member.storeId === null) {
      continue;
    }
    serving.set(member.storeId, (serving.get(member.storeId) ?? 0) + 1);
  }

  let best = fallback;
  let bestCount = serving.get(best.id) ?? 0;
  for (const store of enabled) {
    const count = serving.get(store.id) ?? 0;
    if (count > bestCount) {
      best = store;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The store a tenant falls back to when it has no enabled one.
 *
 * An existing default store is switched back on rather than duplicated: the code
 * is a tenant-scoped natural key, so writing a second `main` would collide, and a
 * disabled default store means settings were changed, not that a new store is
 * wanted. The write goes through `saveStore` like every other directory write, so
 * a mirrored directory sees it too.
 *
 * @param input.repository - Directory to read and write.
 * @param input.ids - Identifier generator, used only when creating.
 * @param input.now - Instant stamped on a created store.
 * @param input.tenantId - Tenant the store belongs to.
 * @param input.stores - Every store of the tenant, enabled or not.
 * @returns The default store, enabled.
 */
async function ensureDefaultStore(input: {
  readonly repository: ServingStoreDirectory;
  readonly ids: AuthIdGenerator;
  readonly now: string;
  readonly tenantId: string;
  readonly stores: ReadonlyArray<Store>;
}): Promise<Store> {
  const { repository, ids, now, tenantId, stores } = input;
  const existing = stores.find((store) => store.code === TRIAL_STORE_CODE);
  const store: Store =
    existing === undefined
      ? {
          id: ids.next('store'),
          tenantId,
          code: TRIAL_STORE_CODE,
          name: TRIAL_STORE_NAME,
          enabled: true,
          createdAt: now,
        }
      : { ...existing, enabled: true };
  await repository.saveStore(store);
  return store;
}
