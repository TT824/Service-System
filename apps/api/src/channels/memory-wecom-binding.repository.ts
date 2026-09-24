/**
 * In-process {@link WecomBindingRepository} for a `test` boot.
 *
 * It exists so the environment boundary every other channel store follows —
 * `memory` for `APP_ENV=test`, `postgres` otherwise — holds for the binding and
 * cursor tables too, and so an interface test never needs a database to boot.
 * It starts *empty of bindings*, exactly as a fresh deployment does: the honest
 * answer to a callback for an account nobody bound is "this account is not bound
 * here", which is what the PostgreSQL adapter answers for an empty table too.
 *
 * It holds what {@link MemoryWecomBindingRepository.createBinding} wrote rather
 * than the empty set, because the binding surface is what a test boot has to be
 * able to exercise: a binding an operator could store in a real deployment and
 * not in a test one would make the whole console untestable. Two facts the
 * durable store enforces with SQL are reproduced here as the same decisions —
 * only an `active` row resolves an account, and a second *active* row for one
 * provider account is refused. The third, that a binding naming another tenant's
 * store resolves nothing, needs the `stores` table to answer and is therefore
 * proved against PostgreSQL alone; a scope that never entered this store cannot
 * be resolved from it.
 *
 * The cursor half carries every transition the durable statements carry, by
 * *calling* the shared rules instead of restating them: the claim, the renewal,
 * the page advance and the release are `@kefu/core`'s
 * `claimWeComSyncCursor`, `renewWeComSyncCursor`, `advanceWeComSyncCursor` and
 * `releaseWeComSyncCursor` applied to the stored row. A rule can therefore not
 * be fixed here without being fixed for the durable store too — including the
 * two the durable statements spell out in SQL: the lease length, and the refusal
 * to advance a pull to a blank position.
 */

import {
  advanceWeComSyncCursor,
  claimWeComSyncCursor,
  isWeComBindingActive,
  releaseWeComSyncCursor,
  renewWeComSyncCursor,
  type WeComChannelBinding,
  type WeComSyncCursor,
} from '@kefu/core';
import type {
  AdvanceCursorInput,
  ClaimCursorInput,
  CursorLeaseInput,
  RenewCursorInput,
  WecomActiveBinding,
  WecomBindingRepository,
  WecomCursorClaim,
} from './wecom-binding.repository';

/** One stored cursor row, addressed by the lease a caller claims to hold. */
type HeldRow = {
  readonly row: WeComSyncCursor;
  readonly owner: string;
  readonly now: string;
};

/** In-process binding and cursor store. */
export class MemoryWecomBindingRepository implements WecomBindingRepository {
  /** One row per binding, exactly as the durable table holds it. */
  readonly #bindings = new Map<string, WeComChannelBinding>();

  /** One row per binding, exactly as the durable table holds it. */
  readonly #cursors = new Map<string, WeComSyncCursor>();

  /** @inheritdoc */
  async findActiveBinding(
    corpId: string,
    openKfId: string,
  ): Promise<WecomActiveBinding | undefined> {
    const active = this.#activeBindings().filter(
      (binding) => binding.corpId === corpId && binding.openKfId === openKfId,
    );
    // The durable read asks for at most two rows and accepts only exactly one;
    // this one is written so that at most one can exist, and still takes the
    // same view rather than trusting its own write path.
    const [only, extra] = active;
    if (only === undefined || extra !== undefined) {
      return undefined;
    }
    return {
      id: only.id,
      tenantId: only.tenantId,
      storeId: only.storeId,
      corpId: only.corpId,
      openKfId: only.openKfId,
    };
  }

  /** @inheritdoc */
  async createBinding(binding: WeComChannelBinding): Promise<boolean> {
    // The durable `wecom_channel_bindings_active_key` refuses a second *active*
    // row for one account while leaving disabled rows free to coexist, so this
    // check has to be about the active set and not about the row's existence.
    const taken =
      binding.status === 'active' &&
      this.#activeBindings().some(
        (held) => held.corpId === binding.corpId && held.openKfId === binding.openKfId,
      );
    if (taken) {
      return false;
    }
    this.#bindings.set(binding.id, binding);
    return true;
  }

  /** @inheritdoc */
  async listBindings(): Promise<ReadonlyArray<WeComChannelBinding>> {
    // Newest first, then by id, which is the order the durable read asks for.
    return [...this.#bindings.values()].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    );
  }

  /** Every stored row that may currently resolve a provider account. */
  #activeBindings(): ReadonlyArray<WeComChannelBinding> {
    return [...this.#bindings.values()].filter(isWeComBindingActive);
  }

  /** @inheritdoc */
  async claimCursor(input: ClaimCursorInput): Promise<WecomCursorClaim | undefined> {
    const claimed = claimWeComSyncCursor(this.#rowFor(input), input.owner, input.now);
    if (claimed === undefined || claimed.leaseExpiresAt === null) {
      // A live lease somebody else holds, which the shared rule refuses.
      return undefined;
    }
    this.#cursors.set(claimed.bindingId, claimed);
    return {
      bindingId: claimed.bindingId,
      tenantId: claimed.tenantId,
      cursor: claimed.cursor,
      owner: input.owner,
      leaseExpiresAt: claimed.leaseExpiresAt,
    };
  }

  /** @inheritdoc */
  async renewCursor(input: RenewCursorInput): Promise<boolean> {
    const held = this.#held(input);
    return held === undefined
      ? false
      : this.#store(renewWeComSyncCursor(held.row, held.owner, held.now));
  }

  /** @inheritdoc */
  async advanceCursor(input: AdvanceCursorInput): Promise<boolean> {
    const held = this.#held(input);
    return held === undefined
      ? false
      : this.#store(advanceWeComSyncCursor(held.row, held.owner, input.cursor, held.now));
  }

  /** @inheritdoc */
  async releaseCursor(input: CursorLeaseInput): Promise<boolean> {
    const held = this.#held(input);
    return held === undefined
      ? false
      : this.#store(releaseWeComSyncCursor(held.row, held.owner, held.now));
  }

  /** Persist a transition that took effect, reporting whether it did. */
  #store(cursor: WeComSyncCursor | undefined): boolean {
    if (cursor === undefined) {
      return false;
    }
    this.#cursors.set(cursor.bindingId, cursor);
    return true;
  }

  /**
   * The row a claim starts from: the stored one, or the empty row a first claim
   * creates.
   *
   * The tenant guard mirrors the `tenant_id = $1` every durable mutation carries,
   * except on the claim, where the durable `INSERT ... ON CONFLICT` keeps the
   * stored row's tenant rather than rewriting it — so a row belonging to another
   * tenant stays that tenant's, and the caller that tried to address it gets that
   * tenant back and fails its later compare-by-owner writes.
   */
  #rowFor(input: ClaimCursorInput): WeComSyncCursor {
    return (
      this.#cursors.get(input.bindingId) ?? {
        id: `wecom-cursor-${input.bindingId}`,
        tenantId: input.tenantId,
        bindingId: input.bindingId,
        cursor: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastSyncedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      }
    );
  }

  /**
   * The stored row a caller may act on, or `undefined` when it has none.
   *
   * A cursor belonging to another tenant is not addressable, exactly as the
   * durable `WHERE tenant_id = $1` makes it not addressable.
   */
  #held(input: CursorLeaseInput): HeldRow | undefined {
    const row = this.#cursors.get(input.bindingId);
    if (row === undefined || row.tenantId !== input.tenantId) {
      return undefined;
    }
    return { row, owner: input.owner, now: input.now };
  }
}
