"""
Mutation sweep for realtime outbox and lead import runner.
"""

import subprocess
import sys
from pathlib import Path

REALTIME_OUTBOX_FILE = Path(__file__).resolve().parent.parent / "app" / "realtime_outbox.py"
LEAD_IMPORT_RUNNER_FILE = Path(__file__).resolve().parent.parent / "app" / "lead_import_runner.py"

MUTANTS = [
    # Mutant 1: Expired lease max attempts off-by-one
    (
        REALTIME_OUTBOX_FILE,
        '"attempts": {"$gte": max_attempts},',
        '"attempts": {"$gt": max_attempts},',
    ),
    # Mutant 2: Release outbox event status guard
    (
        REALTIME_OUTBOX_FILE,
        '"status": REALTIME_OUTBOX_STATUS_PUBLISHING,',
        '"status": REALTIME_OUTBOX_STATUS_PENDING,',
    ),
    # Mutant 3: Exponential backoff constant
    (
        REALTIME_OUTBOX_FILE,
        'return min(1000 * (2 ** max(0, attempts - 1)), 60_000)',
        'return 60_000',
    ),
    # Mutant 4: Realtime runner re-entrancy guard
    (
        REALTIME_OUTBOX_FILE,
        'if self._running:\n            return False',
        'if False and self._running:\n            return False',
    ),
    # Mutant 5: Lead import runner enabled check
    (
        LEAD_IMPORT_RUNNER_FILE,
        'if self._running or not self._enabled:\n            return False',
        'if self._running:\n            return False',
    ),
]


def run_tests():
    cmd = [
        sys.executable,
        "-m",
        "pytest",
        "tests/test_realtime_outbox.py",
        "tests/test_lead_import_runner.py",
        "-q",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, cwd=REALTIME_OUTBOX_FILE.parent.parent)
    return res.returncode == 0


def main():
    print(f"Running baseline tests on {len(MUTANTS)} mutants...")
    if not run_tests():
        print("BASELINE FAILED! Aborting mutation sweep.")
        sys.exit(1)

    print("Baseline passed. Beginning mutation testing...")
    killed = 0
    survived = 0

    for idx, (filepath, target, replacement) in enumerate(MUTANTS, 1):
        content = filepath.read_text(encoding="utf-8")
        if target not in content:
            print(f"ERROR: Mutant {idx} target not found in {filepath.name}!")
            sys.exit(1)

        mutated = content.replace(target, replacement, 1)
        filepath.write_text(mutated, encoding="utf-8")

        try:
            passed = run_tests()
            if passed:
                print(f"[-] Mutant {idx} SURVIVED!")
                survived += 1
            else:
                print(f"[+] Mutant {idx} KILLED")
                killed += 1
        finally:
            filepath.write_text(content, encoding="utf-8")

    print("\nMutation Sweep Summary:")
    print(f"Total Mutants: {len(MUTANTS)}")
    print(f"Killed: {killed}")
    print(f"Survived: {survived}")

    if survived > 0:
        print("FAILED: Some mutants survived.")
        sys.exit(1)
    else:
        print("SUCCESS: All mutants killed with 0 survivors.")


if __name__ == "__main__":
    main()

