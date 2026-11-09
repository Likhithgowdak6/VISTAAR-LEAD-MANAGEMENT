"""
Mutation testing sweep for app/meta_activation_service.py.
"""

import subprocess
import sys
from pathlib import Path

SERVICE_FILE = Path(__file__).resolve().parent.parent / "app" / "meta_activation_service.py"

MUTANTS = [
    # Mutant 1: break status on initial creation (must start PAUSED)
    (
        '"status": LEAD_SOURCE_STATUSES.PAUSED,',
        '"status": LEAD_SOURCE_STATUSES.ACTIVE,',
    ),
    # Mutant 2: break import_existing epoch handling
    (
        '"import_from_time": BEGINNING_OF_TIME if import_existing else datetime.now(timezone.utc),',
        '"import_from_time": datetime.now(timezone.utc),',
    ),
    # Mutant 3: break page matching logic in require_page
    (
        'page = next((p for p in pages if (p.id if hasattr(p, "id") else p.get("id")) == page_id), None)',
        'page = next((p for p in pages if (p.id if hasattr(p, "id") else p.get("id")) != page_id), None)',
    ),
    # Mutant 4: break disconnected status check in require_user_token
    (
        'if not connection or connection.get("status") == META_CONNECTION_STATUSES.DISCONNECTED:',
        'if False and (not connection or connection.get("status") == META_CONNECTION_STATUSES.DISCONNECTED):',
    ),
]


def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_meta_activation_service.py", "-q"],
        capture_output=True,
        text=True,
        cwd=SERVICE_FILE.parent.parent,
    )
    return res.returncode == 0


def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations on {SERVICE_FILE.name}...")
    for idx, (target, repl) in enumerate(MUTANTS, 1):
        original_code = SERVICE_FILE.read_text(encoding="utf-8")
        if target not in original_code:
            print(f"Error: target {target!r} not found in {SERVICE_FILE.name}.")
            sys.exit(1)
        mutated = original_code.replace(target, repl, 1)
        SERVICE_FILE.write_text(mutated, encoding="utf-8")
        passed = run_test()
        SERVICE_FILE.write_text(original_code, encoding="utf-8")

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

