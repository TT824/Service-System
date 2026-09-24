/**
 * Trial workspace onboarding.
 *
 * **Frozen: nothing reaches this any more.** It used to be how a registration
 * became its own merchant; registration now stops at `pending` and holds nothing
 * at all, and `POST /auth/onboarding/retry` — its other caller — is gone. An
 * account becomes an agent through `AuthAdminService.approveAccount`, which joins
 * the *existing* organisation instead of minting a new one. This service and its
 * model are kept because they are legitimate and deleting them would touch four
 * files and two e2e suites for no visible gain; they are not an available door.
 * Re-connecting either caller would hand every applicant a way to approve
 * themselves.
 *
 * What it still describes, for whoever reads it next: `provisionTrial` decides
 * what a trial workspace is and asks storage for it. Provisioning is deliberately
 * *not* encapsulated as "create a workspace" — the repository resolves an account
 * that already has one and returns it unchanged, so calling this twice is the
 * same as calling it once, and a caller never has to know whether the first
 * attempt got that far.
 */

import type { AuthClock, AuthIdGenerator } from './clock';
import { SystemAuthClock, RandomAuthIdGenerator } from './clock';
import type { AuthRepository, TrialWorkspaceProvision } from './ports';
import { buildTrialWorkspace } from './trial-workspace';
import type { UserAccount } from './types';

/** Dependencies of {@link OnboardingService}. */
export type OnboardingDeps = {
  readonly repository: AuthRepository;
  readonly clock?: AuthClock;
  readonly ids?: AuthIdGenerator;
};

/** Gives an account the trial workspace it acts through. */
export class OnboardingService {
  readonly #repository: AuthRepository;
  readonly #clock: AuthClock;
  readonly #ids: AuthIdGenerator;

  /**
   * @param deps - Repository plus the clock and identifier source the rows are
   * stamped with. Both default to the production implementations.
   */
  constructor(deps: OnboardingDeps) {
    this.#repository = deps.repository;
    this.#clock = deps.clock ?? new SystemAuthClock();
    this.#ids = deps.ids ?? new RandomAuthIdGenerator();
  }

  /**
   * Provision the trial workspace of one account, or return the one it has.
   *
   * Idempotent on the account: an account that already acts through a workspace
   * — including one an administrator configured by hand — is returned as-is and
   * nothing is written, so the account can never end up owning two tenants.
   *
   * The lookup below is an optimisation, not the guard: it keeps a repeat call
   * from allocating identifiers for rows that will not be written. The
   * repository re-checks inside the same unit of work that writes them, which is
   * what actually makes the call safe to repeat.
   *
   * @param account - Account to provision for.
   * @returns The workspace and whether this call created it.
   */
  async provisionTrial(account: UserAccount): Promise<TrialWorkspaceProvision> {
    const existing = await this.#repository.findTrialWorkspace(account.id);
    if (existing !== undefined) {
      return { ...existing, provisioned: false };
    }
    return this.#repository.provisionTrialWorkspace(
      buildTrialWorkspace({ account, now: this.#clock.now(), ids: this.#ids }),
    );
  }
}
