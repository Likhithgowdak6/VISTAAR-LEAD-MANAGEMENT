"""
Mutation sweep over the 6 expanded modules:
- reminder_sweep
- reminder_message
- reminder_lead_context
- deep_link
- commitment_retry
- inbound_media
"""

import subprocess
import sys
from pathlib import Path

MUTATIONS = [
    (
        "app/reminder_sweep.py",
        "if attempts >= REMINDER_MAX_DELIVERY_ATTEMPTS:",
        "if attempts > REMINDER_MAX_DELIVERY_ATTEMPTS:",
        "tests/test_reminder_sweep.py",
    ),
    (
        "app/reminder_sweep.py",
        'status=REMINDER_DELIVERY_STATUSES["SENT"]',
        'status=REMINDER_DELIVERY_STATUSES["FAILED"]',
        "tests/test_reminder_sweep.py",
    ),
    (
        "app/reminder_message.py",
        'suffix = "PM" if parts.hour >= 12 else "AM"',
        'suffix = "AM" if parts.hour >= 12 else "PM"',
        "tests/test_reminder_message.py",
    ),
    (
        "app/reminder_message.py",
        "REASON_MAX_LENGTH = 200",
        "REASON_MAX_LENGTH = 10",
        "tests/test_reminder_message.py",
    ),
    (
        "app/reminder_lead_context.py",
        "if len(digits) < 8 or len(digits) > 15:",
        "if len(digits) < 15:",
        "tests/test_reminder_lead_context.py",
    ),
    (
        "app/reminder_lead_context.py",
        'if note != "":',
        "if False:",
        "tests/test_reminder_lead_context.py",
    ),
    (
        "app/deep_link.py",
        '"localhost"',
        '"dummy_never_match"',
        "tests/test_deep_link.py",
    ),
    (
        "app/deep_link.py",
        'return f"{base}&reminder={reminder_id}" if reminder_id else base',
        'return f"{base}&rem={reminder_id}" if reminder_id else base',
        "tests/test_deep_link.py",
    ),
    (
        "app/commitment_retry.py",
        "return int(COMMITMENT_RETRY_BASE_BACKOFF_MS * (2 ** max(0, attempts - 1)))",
        "return int(COMMITMENT_RETRY_BASE_BACKOFF_MS * (2 ** attempts))",
        "tests/test_commitment_retry.py",
    ),
    (
        "app/commitment_retry.py",
        '"status": COMMITMENT_RETRY_STATUSES["FAILED_PERMANENT"]',
        '"status": "abandoned"',
        "tests/test_commitment_retry.py",
    ),
    (
        "app/inbound_media.py",
        "if not enabled:",
        "if False:",
        "tests/test_inbound_media.py",
    ),
    (
        "app/inbound_media.py",
        "if isinstance(size_bytes, int) and size_bytes > limit:",
        "if False:",
        "tests/test_inbound_media.py",
    ),
]


def main():
    killed = 0
    for rel_path, orig, mut, test_file in MUTATIONS:
        path = Path(rel_path)
        content = path.read_text(encoding="utf-8")
        if orig not in content:
            print(f"ERROR: could not find target in {rel_path}:\n{orig[:50]}")
            sys.exit(1)
        mutated = content.replace(orig, mut, 1)
        path.write_text(mutated, encoding="utf-8")
        try:
            res = subprocess.run(
                [sys.executable, "-m", "pytest", "-q", test_file],
                capture_output=True,
                text=True,
            )
            if res.returncode != 0:
                killed += 1
                print(f"KILLED: {rel_path} -> {orig[:30]}...")
            else:
                print(f"SURVIVED: {rel_path} -> {orig[:30]}...")
                sys.exit(2)
        finally:
            path.write_text(content, encoding="utf-8")

    print(f"\nAll {killed}/{len(MUTATIONS)} mutants successfully KILLED! 0 survivors.")


if __name__ == "__main__":
    main()
