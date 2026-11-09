"""
Mutation testing sweep for app/lead_pipeline.py.
"""

import subprocess
import sys
from pathlib import Path

PIPELINE_FILE = Path(__file__).resolve().parent.parent / "app" / "lead_pipeline.py"

MUTANTS = [
    # Mutant 1: invert allowlist check
    (
        "if not self.allowlist.permits_inbound_jid(f\"{normalized_phone}@{WHATSAPP_JID_DOMAIN}\", normalized_phone):",
        "if False and not self.allowlist.permits_inbound_jid(f\"{normalized_phone}@{WHATSAPP_JID_DOMAIN}\", normalized_phone):",
    ),
    # Mutant 2: swap skip reasons for no phone
    (
        "LEAD_SKIP_REASONS.NO_PHONE\n                if lead.phone is None\n                else LEAD_SKIP_REASONS.UNPARSABLE_PHONE",
        "LEAD_SKIP_REASONS.UNPARSABLE_PHONE\n                if lead.phone is None\n                else LEAD_SKIP_REASONS.NO_PHONE",
    ),
    # Mutant 3: swap event types for resubmission
    (
        "ACTIVITY_EVENTS[\"LEAD_RESUBMITTED\"]\n                if is_resubmission\n                else ACTIVITY_EVENTS[\"LEAD_IMPORTED\"]",
        "ACTIVITY_EVENTS[\"LEAD_IMPORTED\"]\n                if is_resubmission\n                else ACTIVITY_EVENTS[\"LEAD_RESUBMITTED\"]",
    ),
    # Mutant 4: break is_duplicate_key_error
    (
        "if code == 11000:",
        "if code == 99999:",
    ),
    # Mutant 5: remove max_rows_per_tick slice
    (
        "[: self.max_rows_per_tick]",
        "[:]",
    ),
]


def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_lead_pipeline.py", "-q"],
        capture_output=True,
        text=True,
        cwd=PIPELINE_FILE.parent.parent,
    )
    return res.returncode == 0


def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations on {PIPELINE_FILE.name}...")
    for idx, (target, repl) in enumerate(MUTANTS, 1):
        original_code = PIPELINE_FILE.read_text(encoding="utf-8")
        if target not in original_code:
            print(f"Error: target {target!r} not found in {PIPELINE_FILE.name}.")
            sys.exit(1)
        mutated = original_code.replace(target, repl, 1)
        PIPELINE_FILE.write_text(mutated, encoding="utf-8")
        passed = run_test()
        PIPELINE_FILE.write_text(original_code, encoding="utf-8")

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

