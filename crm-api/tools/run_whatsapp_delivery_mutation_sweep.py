"""
Mutation testing sweep for Phase 11 (WhatsApp Accounts & Outbound Delivery):
  app/whatsapp_accounts_service.py
  app/outbound_delivery.py
  app/echo_guard.py
"""

import subprocess
import sys
from pathlib import Path

ACCOUNTS_FILE = Path(__file__).resolve().parent.parent / "app" / "whatsapp_accounts_service.py"
DELIVERY_FILE = Path(__file__).resolve().parent.parent / "app" / "outbound_delivery.py"
ECHO_GUARD_FILE = Path(__file__).resolve().parent.parent / "app" / "echo_guard.py"

MUTANTS = [
    # Mutant 1: WhatsApp Accounts brandKey collision check
    (
        ACCOUNTS_FILE,
        "if existing:\n        raise AccountBrandKeyExistsError()",
        "if False:\n        raise AccountBrandKeyExistsError()",
    ),
    # Mutant 2: Sendable accounts socket running gate
    (
        ACCOUNTS_FILE,
        'if manager.get_session_state(account["_id"]).get("running") is True',
        'if manager.get_session_state(account["_id"]).get("running") is False',
    ),
    # Mutant 3: Account removal reference check
    (
        ACCOUNTS_FILE,
        'if not purged and references.get("total", 0) > 0:',
        'if not purged and references.get("total", 0) > 1000:',
    ),
    # Mutant 4: Outbound delivery test allowlist permit check
    (
        DELIVERY_FILE,
        "if not self.allowlist.permits(recipient, contact_phone):",
        "if self.allowlist.permits(recipient, contact_phone):",
    ),
    # Mutant 5: Outbound delivery quiet hours check
    (
        DELIVERY_FILE,
        "if is_within_quiet_hours(now, self.quiet_hours_start, self.quiet_hours_end, self.business_timezone):",
        "if False and is_within_quiet_hours(now, self.quiet_hours_start, self.quiet_hours_end, self.business_timezone):",
    ),
    # Mutant 6: Outbound delivery sales rejection check
    (
        DELIVERY_FILE,
        'if conv and conv.get("salesRejectedAt"):',
        'if False and conv and conv.get("salesRejectedAt"):',
    ),
    # Mutant 7: Outbound delivery staleness guard threshold direction
    (
        DELIVERY_FILE,
        "if (now.timestamp() - sched_ts) * 1000 > self.stale_after_ms:",
        "if (now.timestamp() - sched_ts) * 1000 < self.stale_after_ms:",
    ),
    # Mutant 8: Echo guard exists count threshold
    (
        ECHO_GUARD_FILE,
        "return bool(count and count >= 1)",
        "return bool(count and count > 1)",
    ),
]


def run_test() -> bool:
    res = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "tests/test_whatsapp_accounts.py",
            "tests/test_outbound_delivery.py",
            "-q",
        ],
        capture_output=True,
        text=True,
        cwd=ACCOUNTS_FILE.parent.parent,
    )
    return res.returncode == 0


def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations on WhatsApp Accounts & Outbound Delivery...")
    for idx, (target_file, target, repl) in enumerate(MUTANTS, 1):
        original_code = target_file.read_text(encoding="utf-8")
        if target not in original_code:
            print(f"Error: target {target!r} not found in {target_file.name}.")
            sys.exit(1)
        mutated = original_code.replace(target, repl, 1)
        target_file.write_text(mutated, encoding="utf-8")
        passed = run_test()
        target_file.write_text(original_code, encoding="utf-8")

        if not passed:
            killed += 1
            print(f"  Mutant {idx}: KILLED")
        else:
            survived += 1
            print(f"  Mutant {idx}: SURVIVED")

    print(f"\nResult: {killed} killed, {survived} survived.")
    if survived > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()

