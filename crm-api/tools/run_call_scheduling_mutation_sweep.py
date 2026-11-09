"""
Mutation testing sweep for app/call_scheduling.py and app/lead_context.py.
"""

import subprocess
import sys
from pathlib import Path

CALL_SCHED_FILE = Path(__file__).resolve().parent.parent / "app" / "call_scheduling.py"
LEAD_CTX_FILE = Path(__file__).resolve().parent.parent / "app" / "lead_context.py"

MUTANTS = [
    # Mutant 1: break aiContextEnabled gate in lead_context.py
    (
        LEAD_CTX_FILE,
        'if not lead_source or not lead_source.get("aiContextEnabled"):',
        'if False and (not lead_source or not lead_source.get("aiContextEnabled")):',
    ),
    # Mutant 2: break AUTO_GREET_KEY_PREFIX in call_scheduling.py
    (
        CALL_SCHED_FILE,
        'AUTO_GREET_KEY_PREFIX = "ai-brain-asked:auto-greet:"',
        'AUTO_GREET_KEY_PREFIX = "ai-brain-asked:other-greet:"',
    ),
    # Mutant 3: break NO_RESPONSE_FOLLOW_UP_BODY in call_scheduling.py
    (
        CALL_SCHED_FILE,
        'NO_RESPONSE_FOLLOW_UP_BODY = (\n    "As we have not received your response on WhatsApp to schedule a time, our team will call you today."\n)',
        'NO_RESPONSE_FOLLOW_UP_BODY = "Different follow up message"',
    ),
    # Mutant 4: break 1-hour deadline in register_call_scheduling_attempt
    (
        CALL_SCHED_FILE,
        'assert attempt["deadlineAt"] == t_sent + timedelta(hours=1)',
        'pass',
    ),  # We'll test a direct code mutation instead
]

MUTANTS_CODE = [
    # Mutant 1: break aiContextEnabled gate in lead_context.py
    (
        LEAD_CTX_FILE,
        'if not lead_source or not lead_source.get("aiContextEnabled"):',
        'if False and (not lead_source or not lead_source.get("aiContextEnabled")):',
    ),
    # Mutant 2: break AUTO_GREET_KEY_PREFIX in call_scheduling.py
    (
        CALL_SCHED_FILE,
        'AUTO_GREET_KEY_PREFIX = "ai-brain-asked:auto-greet:"',
        'AUTO_GREET_KEY_PREFIX = "ai-brain-asked:other-prefix:"',
    ),
    # Mutant 3: break NO_RESPONSE_FOLLOW_UP_BODY in call_scheduling.py
    (
        CALL_SCHED_FILE,
        '"As we have not received your response on WhatsApp to schedule a time, our team will call you today."',
        '"Different text"',
    ),
    # Mutant 4: break callSchedulingEnabled check on leadSource
    (
        CALL_SCHED_FILE,
        'or lead_source.get("callSchedulingEnabled") is not True',
        'or False',
    ),
]


def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_call_scheduling_and_context.py", "-q"],
        capture_output=True,
        text=True,
        cwd=CALL_SCHED_FILE.parent.parent,
    )
    return res.returncode == 0


def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS_CODE)} mutations...")
    for idx, (target_file, target, repl) in enumerate(MUTANTS_CODE, 1):
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

