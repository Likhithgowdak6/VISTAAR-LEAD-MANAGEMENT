"""
Mutation sweep for app/ai_draft.py.
"""

import subprocess
import sys
from pathlib import Path

TARGET_FILE = Path("app/ai_draft.py")
TEST_COMMAND = [sys.executable, "-m", "pytest", "-q", "tests/test_ai_draft.py"]

MUTATIONS = [
    {
        "name": "Bypass AI enabled check",
        "original": "if not settings.ai_enabled:",
        "mutant": "if False and not settings.ai_enabled:",
    },
    {
        "name": "Bypass outcome validity check",
        "original": "if outcome not in AI_DRAFT_OUTCOME_VALUES:",
        "mutant": "if False and outcome not in AI_DRAFT_OUTCOME_VALUES:",
    },
    {
        "name": "Corrupt initial outcome in created document",
        "original": '"outcome": None,',
        "mutant": '"outcome": "auto_approved",',
    },
    {
        "name": "Bypass empty draft text error check",
        "original": "if not draft_text:",
        "mutant": "if False and not draft_text:",
    },
]

def run():
    source = TARGET_FILE.read_text(encoding="utf-8")
    killed = 0

    print(f"Starting mutation sweep on {TARGET_FILE} ({len(MUTATIONS)} mutants)...")

    for i, m in enumerate(MUTATIONS, 1):
        if m["original"] not in source:
            print(f"Error: Original snippet not found for mutant {i}: {m['name']}")
            sys.exit(1)

        mutated = source.replace(m["original"], m["mutant"], 1)
        TARGET_FILE.write_text(mutated, encoding="utf-8")

        try:
            res = subprocess.run(TEST_COMMAND, capture_output=True, text=True)
            if res.returncode != 0:
                killed += 1
                print(f"[KILL] Mutant {i}: {m['name']}")
            else:
                print(f"[SURVIVOR] Mutant {i}: {m['name']}")
        finally:
            TARGET_FILE.write_text(source, encoding="utf-8")

    print(f"\nMutation Sweep Result: {killed}/{len(MUTATIONS)} killed.")
    if killed != len(MUTATIONS):
        sys.exit(1)

if __name__ == "__main__":
    run()

