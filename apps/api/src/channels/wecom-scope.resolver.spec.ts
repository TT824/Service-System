import { describe, expect, it } from 'vitest';
import type { WeComChannelBinding } from '@kefu/core';
import type {
  AdvanceCursorInput,
  ClaimCursorInput,
  CursorLeaseInput,
  RenewCursorInput,
  WecomActiveBinding,
  WecomBindingRepository,
  WecomCursorClaim,
} from './wecom-binding.repository';
import { wecomScopeResolverFromBindings } from './wecom-scope.resolver';

/**
 * Unit tests for the production scope resolver.
 *
 * This is the value the module binds to {@link WECOM_SCOPE_RESOLVER}, so these
 * prove the property the defect was about: a direct message callback resolves
 * its tenant and store from the *same persistent binding* the `kf/sync_msg`
 * pull resolves its account through, and refuses — rather than guesses — when
 * that binding is absent or the callback names no account.
 */
const CORP_ID = 'ww-corp';
const OPEN_KF_ID = 'wk-account';

/** The one binding the store answers with, or `undefined` for an unbound account. */
const BINDING: WecomActiveBinding = {
  id: 'binding-1',
  tenantId: 'tenant-acme',
  storeId: 'store-acme-flagship',
  corpId: CORP_ID,
  openKfId: OPEN_KF_ID,
};

/** A binding store that records the pairs it was asked about. */
class RecordingBindings implements WecomBindingRepository {
  readonly lookups: Array<{ corpId: string; openKfId: string }> = [];
  binding: WecomActiveBinding | undefined = BINDING;

  async findActiveBinding(
    corpId: string,
    openKfId: string,
  ): Promise<WecomActiveBinding | undefined> {
    this.lookups.push({ corpId, openKfId });
    return this.binding;
  }

  // The resolver only ever reads, so the writing half of the port answers as a
  // store nothing is written to: this spec is about which account a callback
  // resolves, not about how a binding gets there.
  async createBinding(_binding: WeComChannelBinding): Promise<boolean> {
    return false;
  }

  async listBindings(): Promise<ReadonlyArray<WeComChannelBinding>> {
    return [];
  }

  async claimCursor(_input: ClaimCursorInput): Promise<WecomCursorClaim | undefined> {
    return undefined;
  }

  async renewCursor(_input: RenewCursorInput): Promise<boolean> {
    return false;
  }

  async advanceCursor(_input: AdvanceCursorInput): Promise<boolean> {
    return false;
  }

  async releaseCursor(_input: CursorLeaseInput): Promise<boolean> {
    return false;
  }
}

describe('wecomScopeResolverFromBindings', () => {
  it('resolves the account through the persistent binding store', async () => {
    const bindings = new RecordingBindings();
    const resolve = wecomScopeResolverFromBindings(bindings);

    expect(
      await resolve({ corpId: CORP_ID, openKfId: OPEN_KF_ID, externalCustomerId: 'wm-customer-1' }),
    ).toEqual({ tenantId: 'tenant-acme', storeId: 'store-acme-flagship' });
    // The lookup is the same call the sync pull makes for the same account, so
    // both callback shapes name one tenant.
    expect(bindings.lookups).toEqual([{ corpId: CORP_ID, openKfId: OPEN_KF_ID }]);
  });

  it('resolves nothing for an account no active binding covers', async () => {
    const bindings = new RecordingBindings();
    bindings.binding = undefined;
    const resolve = wecomScopeResolverFromBindings(bindings);

    // Unbound, disabled, ambiguous, unknown tenant or a store of another tenant:
    // one `null` decision, which the caller turns into
    // `channel_not_configured` rather than writing into a guessed scope.
    expect(
      await resolve({ corpId: CORP_ID, openKfId: OPEN_KF_ID, externalCustomerId: 'wm-customer-1' }),
    ).toBeNull();
  });

  it('resolves nothing for a callback that names no account, without reading the store', async () => {
    const bindings = new RecordingBindings();
    const resolve = wecomScopeResolverFromBindings(bindings);

    expect(
      await resolve({ corpId: CORP_ID, openKfId: null, externalCustomerId: 'wm-customer-1' }),
    ).toBeNull();
    // Guessing the configured account would attribute a message to an account
    // that did not receive it, so the store is never asked.
    expect(bindings.lookups).toEqual([]);
  });
});
