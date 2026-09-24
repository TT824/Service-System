/**
 * Access-context rules.
 *
 * A bearer session proves *who* is calling; the access context decides *what*
 * that caller may reach. It is derived once per request from the account, the
 * member it acts through, the member's tenant, the active member link and the
 * member's store scopes, so every surface (account center, tenant business
 * data, platform administration) enforces the same boundary.
 *
 * The `pending_config` rule lives here: an authenticated account whose member
 * configuration is incomplete may reach the account center and nothing else.
 */

import type { Member, Store, Tenant } from '../platform/types';
import { AuthError } from './errors';
import {
  allowsAccountCenter,
  allowsBusinessData,
  deriveAccessState,
  type AccessStateInput,
} from './policy';
import type { AccessContext, AuthSession, MemberStoreScope } from './types';

/** Facts one access context is built from. */
export type AccessResolutionInput = {
  readonly session: AuthSession;
  readonly accountStatus: AccessStateInput['accountStatus'];
  /** The member the session acts through, or `null` when it acts as none. */
  readonly member: Member | null;
  /** The member's tenant, or `null` for a platform member. */
  readonly tenant: Tenant | null;
  /** The active link binding the account to the member, when one exists. */
  readonly link: { readonly id: string } | undefined;
  /** Active store scopes of the member. */
  readonly storeScopes: ReadonlyArray<MemberStoreScope>;
  /** Stores of the member's tenant, used for tenant-wide resolution. */
  readonly tenantStores: ReadonlyArray<Store>;
};

/**
 * Build the access context of one authenticated request.
 *
 * @param input - Session, account, member and scope facts.
 * @returns The resolved access context.
 */
export function buildAccessContext(input: AccessResolutionInput): AccessContext {
  const member = input.member;
  const accessState = deriveAccessState({
    accountStatus: input.accountStatus,
    memberEnabled: member === null ? null : member.enabled,
    tenantEnabled: input.tenant === null ? null : input.tenant.enabled,
    hasActiveMemberLink: input.link !== undefined,
  });

  return {
    userId: input.session.userId,
    sessionId: input.session.id,
    accountStatus: input.accountStatus,
    accessState,
    member,
    tenantId: member === null ? null : member.tenantId,
    storeId: member === null ? null : member.storeId,
    role: member === null ? null : member.role,
    authorizedStoreIds: member === null ? [] : authorizedStoreIds(input),
    authMethod: input.session.authMethod,
    expiresAt: input.session.expiresAt,
  };
}

/**
 * Stores the context may operate on.
 *
 * Explicitly granted scopes, and nothing else: the member's home store is no
 * longer a scope of its own, because a store no longer narrows an actor (see
 * `AccessService.resolveStoreScope`). A member with no grant therefore falls
 * into the branch below and reaches the whole enabled tenant — the rule the
 * platform kernel already applied to a tenant administrator, now applied to a
 * seat as well.
 *
 * @param input - Access resolution input.
 * @returns The authorized store ids, deduplicated and ordered.
 */
function authorizedStoreIds(input: AccessResolutionInput): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const scope of input.storeScopes) {
    if (scope.revokedAt === null) {
      ids.add(scope.storeId);
    }
  }
  if (ids.size === 0) {
    for (const store of input.tenantStores) {
      if (store.enabled) {
        ids.add(store.id);
      }
    }
  }
  return [...ids].sort();
}

/**
 * Whether a store is inside the context's scope.
 *
 * @param context - Resolved access context.
 * @param storeId - Store to test.
 * @returns `true` when the store may be operated on.
 */
export function isStoreAuthorized(context: AccessContext, storeId: string): boolean {
  return context.authorizedStoreIds.includes(storeId);
}

/**
 * Resolve the effective store filter for a read or write.
 *
 * Mirrors the platform kernel's store-scope rule, narrowed-nothing version: an
 * explicit request is still validated against the authorized scope, but the
 * member's own store no longer supplies a default — a store never narrows an
 * actor, so "no request" means the whole tenant for every role.
 *
 * @param context - Resolved access context.
 * @param requestedStoreId - Store the caller asked for, if any.
 * @returns The store to filter by, or `undefined` for the whole tenant.
 * @throws {AuthError} `access_denied` when the store is outside the scope.
 */
export function resolveStoreFilter(
  context: AccessContext,
  requestedStoreId: string | undefined,
): string | undefined {
  if (requestedStoreId !== undefined) {
    if (!isStoreAuthorized(context, requestedStoreId)) {
      throw new AuthError('access_denied', 'store is outside the authorized scope');
    }
    return requestedStoreId;
  }
  return undefined;
}

/** Surfaces an access context can be checked against. */
export type AccessSurface = 'account_center' | 'business_data';

/**
 * Throw unless the context may reach a surface.
 *
 * The account center is reachable by every authenticated session except a
 * disabled one. Tenant business data needs a fully configured account, so a
 * `pending_config` session is refused with the dedicated `pending_config` code
 * rather than a generic authorization failure.
 *
 * @param context - Resolved access context.
 * @param surface - Surface the caller wants to reach.
 * @throws {AuthError} `access_denied` or `pending_config` when refused.
 */
export function assertAccessAllowed(context: AccessContext, surface: AccessSurface): void {
  const state = context.accessState;
  if (surface === 'account_center') {
    if (!allowsAccountCenter(state)) {
      throw new AuthError(
        'access_denied',
        'the account is not allowed to access the account center',
      );
    }
    return;
  }
  if (!allowsBusinessData(state)) {
    if (state === 'pending_config') {
      throw new AuthError(
        'pending_config',
        'the account is not configured for tenant business data yet',
      );
    }
    throw new AuthError('access_denied', 'the account is not allowed to access business data');
  }
}
