"""
Mutation testing sweep for app/meta_lead_mapper.py.
"""

import subprocess
import sys
from pathlib import Path

MAPPER_FILE = Path(__file__).resolve().parent.parent / "app" / "meta_lead_mapper.py"

MUTANTS = [
    # Mutant 1: change strip_meta_prefix regex
    ("re.sub(r\"^[a-z]{1,3}:\", \"\", value)", "value"),
    # Mutant 2: break prettify_value replacement
    ("return re.sub(r\"_+\", \" \", value).strip()", "return value"),
    # Mutant 3: break phone header alias check
    ("if not empty_to_null(mapping.get(\"phone\")) and META_STANDARD_COLUMNS.PHONE_NUMBER not in by_header:",
     "if False:"),
    # Mutant 4: break is_organic boolean parsing
    ("row[META_STANDARD_COLUMNS.IS_ORGANIC] = \"true\" if lead[\"is_organic\"] else \"false\"",
     "row[META_STANDARD_COLUMNS.IS_ORGANIC] = \"true\""),
]

def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_meta_lead_mapper.py", "-q"],
        capture_output=True,
        text=True,
        cwd=MAPPER_FILE.parent.parent,
    )
    return res.returncode == 0

def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations on {MAPPER_FILE.name}...")
    for idx, (target, repl) in enumerate(MUTANTS, 1):
        original_code = MAPPER_FILE.read_text(encoding="utf-8")
        if target not in original_code:
            print(f"Error: target {target!r} not found in {MAPPER_FILE.name}.")
            sys.exit(1)
        mutated = original_code.replace(target, repl, 1)
        MAPPER_FILE.write_text(mutated, encoding="utf-8")
        passed = run_test()
        MAPPER_FILE.write_text(original_code, encoding="utf-8")

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
