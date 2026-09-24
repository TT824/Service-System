/**
 * The shape of a trial workspace.
 *
 * A newly registered account is not an account waiting for an administrator: it
 * is the merchant that owns its own directory. This module decides what that
 * directory is — one tenant, its default store, the merchant administrator
 * member that runs it, and the link binding the account to that member — and it
 * decides it the same way every time, so a retry after a failed or interrupted
 * provisioning proposes exactly the same workspace instead of a second one.
 *
 * Only the tenant code is derived from the account. Identifiers come from the
 * injected generator like every other row in the domain; the code is the
 * natural key the durable schema makes globally unique, and deriving it from
 * the account is what keeps a retry from colliding with, or duplicating, the
 * tenant a previous attempt already wrote.
 */

import type { Member, Store, Tenant } from '../platform/types';
import type { AuthIdGenerator } from './clock';
import type { TrialWorkspaceInput } from './ports';
import type { MemberUserLink, UserAccount } from './types';

/** Prefix of the tenant code derived from an account id. */
export const TRIAL_TENANT_CODE_PREFIX = 'trial-';

/** Code of the default store every trial workspace starts with. */
export const TRIAL_STORE_CODE = 'main';

/** Display name of that default store. */
export const TRIAL_STORE_NAME = '默认门店';

/**
 * Tenant code of the trial workspace belonging to one account.
 *
 * @param userId - Account id.
 * @returns A code unique to that account across every tenant.
 */
export function trialTenantCode(userId: string): string {
  return `${TRIAL_TENANT_CODE_PREFIX}${userId}`;
}

/**
 * Build the rows of one account's trial workspace.
 *
 * Pure: the same account, instant and identifier generator produce the same
 * workspace, and nothing is written here. The caller hands the result to
 * `provisionTrialWorkspace`, which decides whether it is needed at all.
 *
 * @param input.account - Account the workspace is created for.
 * @param input.now - Instant stamped on every row.
 * @param input.ids - Identifier generator.
 * @returns The tenant, default store, merchant administrator member and link.
 */
export function buildTrialWorkspace(input: {
  readonly account: UserAccount;
  readonly now: string;
  readonly ids: AuthIdGenerator;
}): TrialWorkspaceInput {
  const { account, now, ids } = input;

  const tenant: Tenant = {
    id: ids.next('tenant'),
    code: trialTenantCode(account.id),
    name: account.displayName,
    enabled: true,
    createdAt: now,
  };

  const store: Store = {
    id: ids.next('store'),
    tenantId: tenant.id,
    code: TRIAL_STORE_CODE,
    name: TRIAL_STORE_NAME,
    enabled: true,
    createdAt: now,
  };

  // The member is tenant-wide (`storeId: null`) and a merchant administrator:
  // it owns the whole trial tenant, and is scoped to individual stores through
  // store scopes once the merchant creates some. That is the same shape the
  // seeded merchant administrators have, so a trial tenant behaves like every
  // other tenant from the first request on.
  const member: Member = {
    id: ids.next('member'),
    tenantId: tenant.id,
    storeId: null,
    role: 'merchant_admin',
    username: account.username,
    displayName: account.displayName,
    enabled: true,
    createdAt: now,
  };

  const link: MemberUserLink = {
    id: ids.next('link'),
    userId: account.id,
    tenantId: tenant.id,
    memberId: member.id,
    // The account provisions its own workspace, so the link is its own doing.
    // Administration surfaces report it as such: no administrator is claimed.
    linkedBy: account.id,
    linkedAt: now,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  return { userId: account.id, tenant, store, member, link };
}
