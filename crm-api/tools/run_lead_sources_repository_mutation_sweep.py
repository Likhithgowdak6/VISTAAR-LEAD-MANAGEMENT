"""
Mutation testing sweep for app/lead_sources_repository.py.
"""

import subprocess
import sys
from pathlib import Path

REPO_FILE = Path(__file__).resolve().parent.parent / "app" / "lead_sources_repository.py"

MUTANTS = [
    # Mutant 1: change callSchedulingEnabled initialization from False to True
    (
        '"callSchedulingEnabled": False,',
        '"callSchedulingEnabled": True,',
    ),
    # Mutant 2: break save_meta_connection status
    (
        '"status": META_CONNECTION_STATUSES.ACTIVE,',
        '"status": META_CONNECTION_STATUSES.DISCONNECTED,',
    ),
    # Mutant 3: break disconnect_meta_connection status
    (
        '"status": META_CONNECTION_STATUSES.DISCONNECTED,',
        '"status": META_CONNECTION_STATUSES.ACTIVE,',
    ),
    # Mutant 4: break claim_due_call_scheduling_attempt attempts bump
    (
        '"$inc": {"attempts": 1},',
        '"$inc": {"attempts": 0},',
    ),
    # Mutant 5: break claim_follow_up_send flag
    (
        '{"$set": {"followUpClaimedAt": ts}}',
        '{"$set": {"followUpClaimedAt": None}}',
    ),
]


def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_lead_sources_repository.py", "-q"],
        capture_output=True,
        text=True,
        cwd=REPO_FILE.parent.parent,
    )
    return res.returncode == 0


def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations on {REPO_FILE.name}...")
    for idx, (target, repl) in enumerate(MUTANTS, 1):
        original_code = REPO_FILE.read_text(encoding="utf-8")
        if target not in original_code:
            print(f"Error: target {target!r} not found in {REPO_FILE.name}.")
            sys.exit(1)
        mutated = original_code.replace(target, repl, 1)
        REPO_FILE.write_text(mutated, encoding="utf-8")
        passed = run_test()
        REPO_FILE.write_text(original_code, encoding="utf-8")

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
