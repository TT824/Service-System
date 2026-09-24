/**
 * The API-owned port for the persistent half of the WeCom customer-service loop.
 *
 * Three facts live behind this port, and nothing else:
 *
 * - **which platform scope a provider account belongs to.** WeCom identifies a
 *   customer-service account by the pair `(corp_id, open_kfid)` and a callback
 *   carries no platform session at all, so the tenant and store a provider
 *   message may be written into can only come from a durable binding. Only
 *   `status = 'active'` rows resolve, and the store is joined back to the
 *   binding's own tenant, so a row that names another tenant's store resolves
 *   nothing rather than leaking a message across a tenant boundary.
 * - **that such a binding can be written at all.** The binding is the one thing
 *   a deployment cannot derive: an operator reads the account out of WeCom's own
 *   console, and until it is stored the platform has nothing to resolve a
 *   callback against. So the port both writes one binding and lists the ones it
 *   holds, rather than leaving a real deployment to INSERT the row by hand.
 * - **where that account's `kf/sync_msg` pull stopped, and who is pulling it.**
 *   The provider cursor belongs to the account, not to a caller, so it is one
 *   row per binding with a bounded lease. Claiming is a single atomic write, so
 *   two concurrent notifications for one account resolve to one live owner and
 *   the loser refuses instead of pulling the same window twice. The lease is
 *   what keeps a provider round trip out of a database transaction: the claim
 *   commits, the pull happens outside any transaction, and the cursor only
 *   advances for the owner that still holds the lease.
 *
 * Every mutation is compare-by-owner, so an owner whose lease expired and was
 * reclaimed can neither advance nor release the newer claim. `lease_owner` is an
 * opaque per-attempt identity — never a member, a session or a credential.
 *
 * The *rules* are not here. Who may take a claim, how long one lasts, what a
 * renewal may extend and what a page may advance to are the pure transitions
 * `claimWeComSyncCursor`, `renewWeComSyncCursor`, `advanceWeComSyncCursor` and
 * `releaseWeComSyncCursor` in `@kefu/core`, and no caller supplies a lease
 * length of its own. Both adapters below reproduce those transitions rather than
 * restating them: the in-process one by calling them, the durable one with one
 * statement per transition whose predicates are the same rules in SQL.
 *
 * Two adapters implement it, picked by the same environment boundary every other
 * channel store uses: `memory` for `APP_ENV=test`, `postgres` otherwise.
 */

import type { AppEnvironment, WeComChannelBinding } from '@kefu/core';

/** Injection token carrying the environment-selected binding store. */
export const WECOM_BINDING_REPOSITORY = Symbol('WECOM_BINDING_REPOSITORY');

/** One active provider-account binding, already rechecked against its scope. */
export type WecomActiveBinding = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  /** Provider identity of the account; not a secret, a callback carries it. */
  readonly corpId: string;
  readonly openKfId: string;
};

/** A taken lease, with the cursor the pull must resume from. */
export type WecomCursorClaim = {
  readonly bindingId: string;
  readonly tenantId: string;
  /** Provider cursor to resume from; `null` means no pull has succeeded yet. */
  readonly cursor: string | null;
  /** Opaque identity of the lease holder. */
  readonly owner: string;
  readonly leaseExpiresAt: string;
};

/** Data used to create or take over the cursor of one binding. */
export type ClaimCursorInput = {
  readonly tenantId: string;
  readonly bindingId: string;
  /** Opaque owner identity of this pull attempt. */
  readonly owner: string;
  readonly now: string;
};

/** Data addressing the lease one owner believes it holds. */
export type CursorLeaseInput = {
  readonly tenantId: string;
  readonly bindingId: string;
  readonly owner: string;
  readonly now: string;
};

/** Data used to extend a lease that is still held. */
export type RenewCursorInput = CursorLeaseInput;

/**
 * Data used to move the cursor forward after a whole page is durable.
 *
 * The position is a plain string because a page that produced no position is not
 * a page the platform may advance to: the lease kept here exists to protect a
 * position, and there is nothing to protect when there is none.
 */
export type AdvanceCursorInput = CursorLeaseInput & {
  readonly cursor: string;
};

/**
 * Decide which binding store an environment uses.
 *
 * @param appEnv - Application runtime boundary.
 * @returns `memory` for `test`, `postgres` otherwise.
 */
export function resolveWecomBindingMode(appEnv: AppEnvironment): 'memory' | 'postgres' {
  return appEnv === 'test' ? 'memory' : 'postgres';
}

/**
 * Durable provider-account bindings and `kf/sync_msg` cursors.
 *
 * A returned `undefined` is always a *decision* rather than an error: no active
 * binding resolves the account, or a live lease is already held by somebody
 * else. Both are answered with a stable refusal by the caller, never by
 * inventing a tenant or by pulling the same window twice.
 */
export interface WecomBindingRepository {
  /**
   * Resolve one provider account to the scope it is bound to.
   *
   * @param corpId - `corp_id` the callback was signed for.
   * @param openKfId - `open_kfid` of the customer-service account.
   * @returns The single active binding, or `undefined` when none resolves it:
   * unbound, disabled, ambiguous, unknown tenant, unknown store, or a store that
   * belongs to another tenant.
   */
  findActiveBinding(corpId: string, openKfId: string): Promise<WecomActiveBinding | undefined>;

  /**
   * Write one new binding.
   *
   * The row arrives already built — Core's `createWeComBinding` owns which
   * fields a binding has and what a blank one means — so a store decides one
   * thing only: whether this provider account is still free. An account that
   * already has a live binding is *refused*, never replaced: moving an account
   * to another scope has to disable the old binding first, which is a separate
   * decision the caller makes rather than a side effect of a create.
   *
   * @param binding - The row to store.
   * @returns `true` when it was written, `false` when an active binding already
   * holds this provider account.
   */
  createBinding(binding: WeComChannelBinding): Promise<boolean>;

  /**
   * Every binding the platform holds, active or disabled, newest first.
   *
   * Disabled rows are included on purpose: an account that was switched off is
   * still the reason a later binding of the same account cannot be written, and
   * a console that could not see it would have no way to explain the refusal.
   *
   * Unscoped, like the account directory: narrowing the list to the caller's
   * tenant is the caller's decision, and the surface that reads it already
   * knows which tenant it acts for.
   *
   * @returns The stored bindings, ordered by creation time then id.
   */
  listBindings(): Promise<ReadonlyArray<WeComChannelBinding>>;

  /**
   * Create or take over the cursor of one binding.
   *
   * The lease length is Core's `WECOM_SYNC_LEASE_MS` — a store cannot be handed
   * a different one, so two callers cannot lease the same account for different
   * lengths of time.
   *
   * @param input - Binding, owner and instant.
   * @returns The claim with the persisted cursor, or `undefined` when another
   * owner still holds a live lease.
   */
  claimCursor(input: ClaimCursorInput): Promise<WecomCursorClaim | undefined>;

  /**
   * Extend a lease this owner still holds.
   *
   * @param input - Lease identity.
   * @returns `true` only when the owner still held the lease.
   */
  renewCursor(input: RenewCursorInput): Promise<boolean>;

  /**
   * Move the cursor forward, keeping the lease.
   *
   * Called only after a whole page is durable, which is what makes the stored
   * cursor a position the platform has already ingested up to. The lease is kept
   * because a pull with more pages to fetch still owns the account; it is
   * {@link releaseCursor} that ends the claim.
   *
   * @param input - Lease identity and the provider's next cursor.
   * @returns `true` only when the owner still held the lease.
   * @throws When the position is blank, which is not a position to advance to.
   */
  advanceCursor(input: AdvanceCursorInput): Promise<boolean>;

  /**
   * Release the lease without moving the cursor.
   *
   * Ends a pull, whether it completed or gave up, so the next notification can
   * take the cursor over at once rather than waiting for the lease to expire.
   *
   * @param input - Lease identity.
   * @returns `true` only when the owner still held the lease.
   */
  releaseCursor(input: CursorLeaseInput): Promise<boolean>;
}
