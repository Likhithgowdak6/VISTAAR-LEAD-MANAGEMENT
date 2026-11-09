"""
Mutation testing sweep for app/csv_parser.py and app/google_sheet_client.py.
"""

import subprocess
import sys
from pathlib import Path

CSV_FILE = Path(__file__).resolve().parent.parent / "app" / "csv_parser.py"
SHEET_FILE = Path(__file__).resolve().parent.parent / "app" / "google_sheet_client.py"

MUTANTS = [
    # Mutant 1 (csv_parser): break tab detection comparison
    (CSV_FILE, "first_line.count(\"\\t\") > first_line.count(\",\")", "first_line.count(\"\\t\") < first_line.count(\",\")"),
    # Mutant 2 (google_sheet_client): invert published detection in parse_google_sheet_url
    (SHEET_FILE, "published=True", "published=False"),
    # Mutant 3 (google_sheet_client): break html check
    (SHEET_FILE, "if looks_like_html(body):", "if False:"),
]

def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_csv_and_sheet.py", "-q"],
        capture_output=True,
        text=True,
        cwd=CSV_FILE.parent.parent,
    )
    return res.returncode == 0

def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations on csv_parser and google_sheet_client...")
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

