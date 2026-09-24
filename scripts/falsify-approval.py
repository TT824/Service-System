"""Falsify the approval gate: break each claim, confirm the suite notices.

A green suite means the assertions held, not that the behaviour they name is
what ran. This script mutates one claim at a time, runs the two core specs that
are supposed to pin it, and reports the process verdict — a mutant that stays
green is a test that would not have caught the bug.

This script rewrites source files, so no more than one copy of it may run at a
time: a second run would read the first run's mutation as the real code and
"catch" a bug that nobody wrote. A lock file enforces that, because the failure
it prevents is silent — two overlapping runs once made a healthy baseline look
like three broken tests, and the cause was this script, not the suite. Both
readings are guarded too: the baseline is retried once if it comes back red, and
a mutant has to be red twice to count as caught.

Usage:  python scripts/falsify-approval.py
"""

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUTH = ROOT / "packages/core/src/auth/auth.service.ts"
ADMIN = ROOT / "packages/core/src/auth/admin.service.ts"
BELL = ROOT / "apps/web/src/auth/ApplicationsBell.tsx"
PENDING = ROOT / "apps/web/src/auth/PendingConfigScreen.tsx"
MESSAGES = ROOT / "apps/web/src/auth/messages.ts"
LOCK = ROOT / "scripts/.falsify-approval.lock"

CORE_SPECS = [
    "packages/core/src/auth/auth.service.spec.ts",
    "packages/core/src/auth/admin.service.spec.ts",
]

BELL_SPECS = [
    "apps/web/src/auth/applications.spec.ts",
    "apps/web/src/auth/ApplicationsBell.spec.tsx",
    "apps/web/src/auth/binding.spec.ts",
    "apps/web/src/auth/PendingConfigScreen.spec.tsx",
    "apps/web/src/auth/messages.spec.ts",
]

# (label, file, before, after) — applied one at a time, always reverted.
CORE_MUTANTS = [
    (
        "registration writes `active` instead of `pending`",
        AUTH,
        "      status: 'pending',",
        "      status: 'active',",
    ),
    (
        "registration provisions a trial workspace again",
        AUTH,
        "    // Registration stops here.",
        "    await this.#onboarding.provisionTrial(account);\n    // Registration stops here.",
    ),
    (
        "approval stops linking the account to its member",
        ADMIN,
        """    await this.linkMember(access, {
      memberId: member.id,
      userId: account.id,
      linkedBy: access.userId,
    });""",
        "    void member;",
    ),
    (
        "rejection stops switching the account off",
        ADMIN,
        "    await this.disableAccount(access, userId);",
        "    void userId;",
    ),
    (
        "the approved agent gets no store, which the kernel CHECK forbids",
        ADMIN,
        "        storeId: await this.#servingStore(tenant.id),",
        "        storeId: null,",
    ),
    (
        "the agent is sent to the tenant's first store instead of where the work is",
        ADMIN,
        """    let best = fallback.id;
    let bestCount = serving.get(best) ?? 0;
    for (const store of stores) {
      const count = serving.get(store.id) ?? 0;
      if (count > bestCount) {
        best = store.id;
        bestCount = count;
      }
    }
    return best;""",
        "    void serving;\n    return fallback.id;",
    ),
    (
        "approval proceeds even when no store is enabled",
        ADMIN,
        """    if (fallback === undefined) {
      throw new AuthError('invalid_request', 'this deployment has no enabled store to serve in');
    }""",
        """    if (fallback === undefined) {
      return '';
    }""",
    ),
]

# The console half of the same gate: the bell is where the decision is made, so
# these break what the operator sees rather than what the platform does.
BELL_MUTANTS = [
    (
        "the bell stops polling, so an application never arrives",
        BELL,
        "const timer = window.setInterval(tick, APPLICATIONS_POLL_MS);",
        "const timer = window.setInterval(() => {}, APPLICATIONS_POLL_MS);",
    ),
    (
        "the red dot never appears",
        BELL,
        "{count > 0 && <span className=\"bell-dot\" aria-hidden=\"true\" />}",
        "{false && <span className=\"bell-dot\" aria-hidden=\"true\" />}",
    ),
    (
        "通过 posts to the rejection endpoint",
        BELL,
        "const path = decision === 'approve' ? approvePath(row.id) : rejectPath(row.id);",
        "const path = rejectPath(row.id);",
    ),
    (
        "a decision no longer re-reads the queue",
        BELL,
        "      await apiJson<unknown>(path, 'POST', scope);\n      reload();",
        "      await apiJson<unknown>(path, 'POST', scope);",
    ),
    (
        "a refused decision is swallowed",
        BELL,
        "      setError(toApiError(cause));",
        "      void cause;",
    ),
    (
        "the applicant is shown the configuration page again",
        PENDING,
        "  const awaitingDecision = account.status === 'pending';",
        "  const awaitingDecision = false;",
    ),
    (
        "the waiting screen stops checking, so an approval never lands",
        PENDING,
        "const timer = window.setInterval(() => void auth.refreshAccess(), APPLICATIONS_POLL_MS);",
        "const timer = window.setInterval(() => {}, APPLICATIONS_POLL_MS);",
    ),
    (
        "checking the result signs the applicant out instead",
        PENDING,
        "      await auth.refreshAccess();",
        "      await auth.logout();",
    ),
    (
        "the duplicate-registration sentence is keyed on a code that never arrives",
        MESSAGES,
        "  conflict:\n    '该用户名或手机号已经注册过",
        "  username_taken:\n    '该用户名或手机号已经注册过",
    ),
    (
        "the wrong-password sentence is keyed on a code that never arrives",
        MESSAGES,
        "  unauthorized:\n    '用户名或密码不正确",
        "  invalid_credentials:\n    '用户名或密码不正确",
    ),
    (
        "an unmapped code echoes the API's own message",
        MESSAGES,
        "  return mapped === undefined ? fallback : mapped;",
        "  return mapped === undefined ? error.message : mapped;",
    ),
]

# (name, specs, mutants)
GROUPS = [
    ("core", CORE_SPECS, CORE_MUTANTS),
    ("console", BELL_SPECS, BELL_MUTANTS),
]


ANSI = re.compile(r"\x1b\[[0-9;]*m")


def run_specs(specs: list[str]) -> tuple[int, str, list[str]]:
    """Run one group's specs; return the exit code, vitest's summary, the failures.

    The failure names are printed when the baseline is red so a bad run says what
    broke instead of only that something did. A mutant only counts as caught when
    *both* of its runs are red, which is what keeps a stray failure — a machine
    under load, a leftover edit — from being read as a test that noticed.
    """
    completed = subprocess.run(
        ["npx", "vitest", "run", "--config", "vitest.unit.config.ts", *specs],
        cwd=ROOT,
        shell=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    clean = ANSI.sub("", completed.stdout)
    summary = ""
    failures = []
    for line in clean.splitlines():
        stripped = line.strip()
        if "Tests " in line and ("passed" in line or "failed" in line):
            summary = stripped
        if stripped.startswith("×") or stripped.startswith("FAIL"):
            failures.append(stripped)
    return completed.returncode, summary, failures


def main() -> int:
    if LOCK.exists():
        print(f"{LOCK} exists: another falsification run is mutating the sources.")
        print("Wait for it to finish, or delete the file if you know it is stale.")
        return 3
    LOCK.write_text("running\n", encoding="utf-8")
    try:
        return mutate()
    finally:
        os.remove(LOCK)


def mutate() -> int:
    for name, specs, mutants in GROUPS:
        print(f"=== {name} ({len(mutants)} mutants) ===")
        verdict = falsify(specs, mutants)
        if verdict != 0:
            return verdict
        print()
    return 0


def falsify(specs: list[str], mutants: list[tuple[str, Path, str, str]]) -> int:
    """Break one group's claims one at a time; return 0 when every one is caught."""
    baseline_rc, baseline, baseline_failures = run_specs(specs)
    # One retry, because the mutants are judged against this baseline and a red
    # baseline aborts the run.
    if baseline_rc != 0:
        print(f"baseline (attempt 1) rc=1  {baseline}")
        for line in baseline_failures[:6]:
            print(f"  {line}")
        print("retrying the baseline once…")
        baseline_rc, baseline, baseline_failures = run_specs(specs)
    print(f"baseline      rc={baseline_rc}  {baseline}")
    if baseline_rc != 0:
        print("baseline is not green; fix that before mutating")
        return 2

    survivors = []
    for label, path, before, after in mutants:
        # Bytes, not text: `read_text` translates line endings and `write_text`
        # writes the platform's own, so a revert through str would hand a Windows
        # checkout CRLF files and a clean `prettier --check` afterwards would be a
        # lie. The revert has to be the original bytes or it is not a revert.
        original = path.read_bytes()
        if before.encode("utf-8") not in original:
            print(f"SKIPPED  {label}: anchor not found in {path.name}")
            survivors.append(label)
            continue
        path.write_bytes(original.replace(before.encode("utf-8"), after.encode("utf-8"), 1))
        try:
            # Twice: a mutation that reds once and greens once is a flaky reading,
            # not a test that noticed, and this file must not be able to claim a
            # catch it did not make.
            rc, summary, _ = run_specs(specs)
            caught = rc != 0
            if caught:
                second_rc, second_summary, _ = run_specs(specs)
                caught = second_rc != 0
                summary = f"{summary} / {second_summary}"
        finally:
            path.write_bytes(original)
        verdict = "RED (caught)" if caught else "GREEN (SURVIVED)"
        print(f"{verdict:15} {label}  {summary}")
        if not caught:
            survivors.append(label)

    if survivors:
        print(f"{len(survivors)} of {len(mutants)} mutants survived:")
        for label in survivors:
            print(f"  - {label}")
        return 1
    print(f"all {len(mutants)} mutants caught")
    return 0


if __name__ == "__main__":
    sys.exit(main())
