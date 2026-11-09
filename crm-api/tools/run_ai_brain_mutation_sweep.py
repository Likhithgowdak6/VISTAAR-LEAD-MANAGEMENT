"""
Mutation testing sweep for Phase 10 (AI Brain routes and runners):
  app/nurture_sweep.py
  app/payment_followup.py
  app/booking_countdown.py
  app/event_reminder.py
  app/daily_scheduler.py
  app/owner_call_escalation.py
"""

import subprocess
import sys
from pathlib import Path

NURTURE_FILE = Path(__file__).resolve().parent.parent / "app" / "nurture_sweep.py"
PAYMENT_FILE = Path(__file__).resolve().parent.parent / "app" / "payment_followup.py"
COUNTDOWN_FILE = Path(__file__).resolve().parent.parent / "app" / "booking_countdown.py"
EVENT_REMINDER_FILE = Path(__file__).resolve().parent.parent / "app" / "event_reminder.py"
SCHEDULER_FILE = Path(__file__).resolve().parent.parent / "app" / "daily_scheduler.py"
ESCALATION_FILE = Path(__file__).resolve().parent.parent / "app" / "owner_call_escalation.py"

MUTANTS = [
    # Mutant 1: Nurture sales rejection check bypass
    (
        NURTURE_FILE,
        'if conversation.get("salesRejectedAt"):',
        'if False and conversation.get("salesRejectedAt"):',
    ),
    # Mutant 2: Nurture promise outranks cadence bypass
    (
        NURTURE_FILE,
        'if conversation.get("promisedFollowUpAt"):',
        'if False and conversation.get("promisedFollowUpAt"):',
    ),
    # Mutant 3: Payment reply keyword parsing
    (
        PAYMENT_FILE,
        'answer in POSITIVE_ANSWERS',
        'answer not in POSITIVE_ANSWERS',
    ),
    # Mutant 4: Booking countdown returns empty string instead of None
    (
        COUNTDOWN_FILE,
        'if not bookings:\n        return None',
        'if not bookings:\n        return ""',
    ),
    # Mutant 5: Event reminder window extraction
    (
        EVENT_REMINDER_FILE,
        'if not event_date:\n        return None',
        'if False:\n        return None',
    ),
    # Mutant 6: Daily scheduler hour/minute comparison
    (
        SCHEDULER_FILE,
        'if not has_reached_local_time(reference, self.hour, self.minute, self.time_zone):',
        'if has_reached_local_time(reference, self.hour, self.minute, self.time_zone):',
    ),
    # Mutant 7: Owner call escalation sayable facts
    (
        ESCALATION_FILE,
        'return f"a {normalized.replace(\'_\', \' \')} enquiry"',
        'return "unknown"',
    ),
]


def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_ai_brain_runners.py", "tests/test_ai_brain_routes.py", "-q"],
        capture_output=True,
        text=True,
        cwd=NURTURE_FILE.parent.parent,
    )
    return res.returncode == 0


def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations on AI Brain & Runners...")
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

