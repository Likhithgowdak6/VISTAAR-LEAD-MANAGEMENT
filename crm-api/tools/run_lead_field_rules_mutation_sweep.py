"""
Mutation testing sweep for app/lead_field_rules.py.
"""

import subprocess
import sys
from pathlib import Path

FILE_PATH = Path(__file__).resolve().parent.parent / "app" / "lead_field_rules.py"

MUTANTS = [
    # Mutant 1: change MIN_LABELLED_LINES from 3 to 10
    ("MIN_LABELLED_LINES = 3", "MIN_LABELLED_LINES = 10"),
    # Mutant 2: break is_blank_answer check
    ("return str(value if value is not None else \"\").strip().lower() in BLANK_VALUES",
     "return False"),
    # Mutant 3: break slugify_label fallback
    ("return \"field\" if not slug else slug", "return slug"),
    # Mutant 4: break derive_facts photography check
    ("derived[\"photo_or_video\"] = \"photography only\"", "derived[\"photo_or_video\"] = \"something_else\""),
    # Mutant 5: break omit_contact_facts
    ("if k not in CONTACT_FACT_KEYS", "if True"),
]

def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_lead_field_rules.py", "-q"],
        capture_output=True,
        text=True,
        cwd=FILE_PATH.parent.parent,
    )
    return res.returncode == 0

def main():
    original_code = FILE_PATH.read_text(encoding="utf-8")
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations on {FILE_PATH.name}...")
    for idx, (target, repl) in enumerate(MUTANTS, 1):
        if target not in original_code:
            print(f"Error: target {target!r} not found in file.")
            sys.exit(1)
        mutated = original_code.replace(target, repl, 1)
        FILE_PATH.write_text(mutated, encoding="utf-8")
        passed = run_test()
        FILE_PATH.write_text(original_code, encoding="utf-8")

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

