/**
 * In-process {@link WecomCredentialRepository} for a `test` boot.
 *
 * It exists so the environment boundary every other channel store follows —
 * `memory` for `APP_ENV=test`, `postgres` otherwise — holds for the credential
 * table too, and so a test boot can exercise the whole console flow (type,
 * 连接, read the verdict) without a database.
 *
 * It keeps the binding store in view on purpose. The durable statements decide
 * two of their three conditions *against the binding* — credentials may only be
 * written for a binding that is `active` in the caller's tenant, and only a
 * credential row whose binding is active may carry a connection — and both are
 * asked of the same {@link WecomBindingRepository} the rest of the module
 * resolves accounts with. A test boot therefore cannot hold a credential the
 * durable one would have refused, and the in-process store is not a second set
 * of rules but the same rules asked of an in-memory binding table.
 *
 * The third durable condition — that the binding's store still belongs to the
 * binding's tenant — needs the `stores` table, which this store does not hold,
 * so it is proved against PostgreSQL alone: a binding the in-process store holds
 * is taken as resolvable, exactly as {@link MemoryWecomBindingRepository} takes
 * it. That is the one place the two stores can disagree, and the disagreement is
 * not expressible here at all — a row in this store has no store catalogue to
 * contradict it — which is why the durable suite, whose rows can name any
 * `store_id` the table accepts, is where the clause is tested.
 */

import { isWeComBindingActive, type WeComChannelBinding } from '@kefu/core';
import type {
  RecordWecomVerificationInput,
  SaveWecomCredentialsInput,
  WecomCredentialRepository,
  WecomCredentialSet,
} from './wecom-credential.repository';
import type { WecomBindingRepository } from './wecom-binding.repository';

/** One stored credential row, exactly as the durable table holds it. */
type StoredRow = {
  readonly tenantId: string;
  readonly kfSecret: string;
  readonly callbackToken: string;
  readonly aesKey: string;
  readonly verifiedAt: string | null;
  readonly verifiedError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** One stored row together with the binding it hangs off, once it resolves. */
type ResolvableCredential = {
  readonly bindingId: string;
  readonly row: StoredRow;
  readonly binding: WeComChannelBinding;
};

/** In-process credential store. */
export class MemoryWecomCredentialRepository implements WecomCredentialRepository {
  /** One row per binding, keyed the way the durable primary key is. */
  readonly #rows = new Map<string, StoredRow>();

  /**
   * @param bindings - The same binding store the module resolves accounts with,
   * which is what both guards here are decided against.
   */
  constructor(private readonly bindings: WecomBindingRepository) {}

  /** @inheritdoc */
  async saveCredentials(input: SaveWecomCredentialsInput): Promise<boolean> {
    // Both halves of the durable `WHERE` on the binding, asked of the same store
    // the API resolves accounts with: the binding has to be this tenant's and it
    // has to be active. A disabled account resolves no callback, so credentials
    // written onto it could only ever be failed ones.
    const binding = await this.#bindingOf(input.tenantId, input.bindingId);
    if (binding === undefined) {
      return false;
    }
    // The other half of the durable guard: one deployment serves one account, so
    // a second live credential is refused rather than stored. Refusing here is
    // what lets the read treat "no single live set" as "nothing to authenticate
    // with" instead of having to tell "none" apart from "two" — see
    // {@link PostgresWecomCredentialRepository} for the whole argument.
    if (await this.#otherLiveCredentialExists(input.bindingId)) {
      return false;
    }
    const held = this.#rows.get(input.bindingId);
    this.#rows.set(input.bindingId, {
      tenantId: binding.tenantId,
      kfSecret: input.values.kfSecret,
      callbackToken: input.values.callbackToken,
      aesKey: input.values.aesKey,
      // The verdict belongs to the values it was reached on, so a replacement
      // starts out unverified — the same two NULLs the durable update writes.
      verifiedAt: null,
      verifiedError: null,
      createdAt: held?.createdAt ?? input.now,
      updatedAt: input.now,
    });
    return true;
  }

  /** @inheritdoc */
  async recordVerification(input: RecordWecomVerificationInput): Promise<boolean> {
    const held = this.#rows.get(input.bindingId);
    // Existence and tenant only: this records what an attempt *did*. A binding
    // switched off between the write and the probe would otherwise lose a
    // verdict that really was reached, leaving 「从未验证」 on a connection that
    // just succeeded.
    if (held === undefined || held.tenantId !== input.tenantId) {
      return false;
    }
    this.#rows.set(input.bindingId, {
      ...held,
      verifiedAt: input.now,
      verifiedError: input.error,
      updatedAt: input.now,
    });
    return true;
  }

  /** @inheritdoc */
  async readCurrentCredentials(): Promise<WecomCredentialSet | undefined> {
    const all = await this.bindings.listBindings();
    const resolvable = [...this.#rows.entries()]
      .map(([bindingId, row]) => ({
        bindingId,
        row,
        binding: all.find((candidate) => candidate.id === bindingId),
      }))
      .filter(
        (entry): entry is ResolvableCredential =>
          entry.binding !== undefined && isWeComBindingActive(entry.binding),
      )
      // Newest write first, then by id — the order the durable read asks for.
      .sort(
        (left, right) =>
          right.row.updatedAt.localeCompare(left.row.updatedAt) ||
          left.bindingId.localeCompare(right.bindingId),
      );

    // Only when there is exactly one: the durable read asks for at most two rows
    // and accepts only exactly one, and this takes the same view rather than
    // trusting its own write path to have prevented a second.
    const [only, extra] = resolvable;
    if (only === undefined || extra !== undefined) {
      return undefined;
    }
    return {
      bindingId: only.bindingId,
      tenantId: only.binding.tenantId,
      storeId: only.binding.storeId,
      corpId: only.binding.corpId,
      openKfId: only.binding.openKfId,
      kfSecret: only.row.kfSecret,
      callbackToken: only.row.callbackToken,
      aesKey: only.row.aesKey,
      verifiedAt: only.row.verifiedAt,
      verifiedError: only.row.verifiedError,
      updatedAt: only.row.updatedAt,
    };
  }

  /** The stored binding with this id, whatever its status or tenant. */
  async #binding(bindingId: string): Promise<WeComChannelBinding | undefined> {
    const all = await this.bindings.listBindings();
    return all.find((binding) => binding.id === bindingId);
  }

  /**
   * Whether another credential row is carried by a binding that still resolves.
   *
   * The durable `NOT EXISTS` asked of this store's own two facts — a row exists,
   * and its binding is active. A row left behind by an account that was switched
   * off does not count, here or there: it is not a live connection.
   */
  async #otherLiveCredentialExists(bindingId: string): Promise<boolean> {
    const all = await this.bindings.listBindings();
    for (const [heldId, row] of this.#rows) {
      if (heldId === bindingId) {
        continue;
      }
      const binding = all.find((candidate) => candidate.id === heldId);
      if (binding !== undefined && binding.tenantId === row.tenantId && isWeComBindingActive(binding)) {
        return true;
      }
    }
    return false;
  }

  /** The stored binding a write may target, or `undefined` when none may. */
  async #bindingOf(tenantId: string, bindingId: string): Promise<WeComChannelBinding | undefined> {
    const binding = await this.#binding(bindingId);
    if (binding === undefined || binding.tenantId !== tenantId) {
      return undefined;
    }
    return isWeComBindingActive(binding) ? binding : undefined;
  }
}
