"""
Mutation testing sweep for app/meta_lead_import_service.py and app/lead_import_service.py.
"""

import subprocess
import sys
from pathlib import Path

META_IMPORT_FILE = Path(__file__).resolve().parent.parent / "app" / "meta_lead_import_service.py"
LEAD_IMPORT_FILE = Path(__file__).resolve().parent.parent / "app" / "lead_import_service.py"

MUTANTS = [
    # Mutant 1: break WATERMARK_NUDGE_MS
    (
        META_IMPORT_FILE,
        "WATERMARK_NUDGE_MS = 1000",
        "WATERMARK_NUDGE_MS = 0",
    ),
    # Mutant 2: break is_meta_lead_source
    (
        META_IMPORT_FILE,
        'return lead_source.get("kind") == LEAD_SOURCE_KINDS.META_LEAD_ADS',
        'return False',
    ),
    # Mutant 3: break sync_status_for_meta_error
    (
        META_IMPORT_FILE,
        'if isinstance(error, MetaLeadSourceNotConfiguredError):\n        return "needs_attention"',
        'if isinstance(error, MetaLeadSourceNotConfiguredError):\n        return "failed"',
    ),
    # Mutant 4: break sync_source status assignment in lead_import_service
    (
        LEAD_IMPORT_FILE,
        'sync_status = (\n                LEAD_SOURCE_SYNC_STATUSES.FAILED\n                if counts.failed > 0\n                else LEAD_SOURCE_SYNC_STATUSES.OK\n            )',
        'sync_status = (\n                LEAD_SOURCE_SYNC_STATUSES.FAILED\n                if counts.failed == 0\n                else LEAD_SOURCE_SYNC_STATUSES.OK\n            )',
    ),
]


def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_meta_lead_import_and_sync.py", "-q"],
        capture_output=True,
        text=True,
        cwd=META_IMPORT_FILE.parent.parent,
    )
    return res.returncode == 0


def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations...")
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

