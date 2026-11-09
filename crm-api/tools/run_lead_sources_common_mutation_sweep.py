"""
Mutation testing sweep for app/lead_sources_common.py.
"""

import subprocess
import sys
from pathlib import Path

FILE_PATH = Path(__file__).resolve().parent.parent / "app" / "lead_sources_common.py"

MUTANTS = [
    # Mutant 1: change max length in sanitize_lead_source_error_text
    ("LEAD_SOURCE_ERROR_MAX_LENGTH = 300", "LEAD_SOURCE_ERROR_MAX_LENGTH = 100"),
    # Mutant 2: break serialize_lead_source usesFacebookLogin
    ("\"usesFacebookLogin\": bool(lead_source.get(\"metaConnectionId\"))",
     "\"usesFacebookLogin\": False"),
    # Mutant 3: break serialize_meta_connection id serialization
    ("\"id\": serialize_id(connection.get(\"_id\"))",
     "\"id\": None"),
    # Mutant 4: break clean_country_code in CreateLeadSourceBody
    ("s = str(v or \"91\").strip().lstrip(\"+\")",
     "s = \"12345\""),
]

def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_lead_sources_common.py", "-q"],
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

