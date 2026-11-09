"""
Mutation testing sweep for app/meta_webhook_service.py.
"""

import subprocess
import sys
from pathlib import Path

SERVICE_FILE = Path(__file__).resolve().parent.parent / "app" / "meta_webhook_service.py"

MUTANTS = [
    # Mutant 1: break field check in extract_leadgen_events
    (
        'if raw_change.get("field") != "leadgen":',
        'if False and raw_change.get("field") != "leadgen":',
    ),
    # Mutant 2: break object == "page" check
    (
        'if body.get("object") != "page" or not isinstance(body.get("entry"), list):',
        'if False and (body.get("object") != "page" or not isinstance(body.get("entry"), list)):',
    ),
    # Mutant 3: break no-source guard
    (
        'if not lead_source:\n                logger.info(\n                    "Meta webhook ignored: no lead source configured for page %s and form %s.",\n                    event.page_id,\n                    event.form_id,\n                )\n                return "no_source"',
        'if False:\n                return "no_source"',
    ),
    # Mutant 4: break count bump on outcome == "imported"
    (
        'if outcome == "imported":',
        'if outcome == "duplicate":',
    ),
]


def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_meta_webhook_service.py", "-q"],
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

