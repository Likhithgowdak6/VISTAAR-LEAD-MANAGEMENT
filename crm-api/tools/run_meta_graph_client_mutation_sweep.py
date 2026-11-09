"""
Mutation testing sweep for app/meta_graph_client.py.
"""

import subprocess
import sys
from pathlib import Path

FILE_PATH = Path(__file__).resolve().parent.parent / "app" / "meta_graph_client.py"

MUTANTS = [
    # Mutant 1: break classify_meta_error 190
    ("if meta_code in (190, 102, 463, 467):", "if False:"),
    # Mutant 2: break rate limit classification
    ("or http_status == 429", "or False"),
    # Mutant 3: break build_meta_graph_url path cleanup
    ("clean_path = path.lstrip(\"/\")", "clean_path = path + \"/\""),
    # Mutant 4: break subscribe_page_to_leadgen success check
    ("return bool(body.get(\"success\") is True)", "return False"),
]

def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_meta_graph_client.py", "-q"],
        capture_output=True,
        text=True,
        cwd=FILE_PATH.parent.parent,
    )
    return res.returncode == 0

def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations on {FILE_PATH.name}...")
    for idx, (target, repl) in enumerate(MUTANTS, 1):
        original_code = FILE_PATH.read_text(encoding="utf-8")
        if target not in original_code:
            print(f"Error: target {target!r} not found in {FILE_PATH.name}.")
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

