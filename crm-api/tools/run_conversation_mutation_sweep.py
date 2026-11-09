"""
Mutation test for conversations routes and serializer.
"""

import subprocess
import sys
from pathlib import Path

MUTATIONS = [
    (
        "app/routers/conversations.py",
        'status_code = 201 if result["outcome"] == "created" else 200',
        "status_code = 200",
        "tests/test_conversations_routes.py",
    ),
    (
        "app/routers/conversations.py",
        "if body.aiCategory not in CATEGORY_PLAYBOOKS:",
        "if False:",
        "tests/test_conversations_routes.py",
    ),
    (
        "app/routers/conversations.py",
        "if not media_object_key_belongs_to(",
        "if False and not media_object_key_belongs_to(",
        "tests/test_conversations_routes.py",
    ),
    (
        "app/conversation_serializer.py",
        "stale = (message_count is None) or (current_message_count > message_count)",
        "stale = False",
        "tests/test_conversation_serializer.py",
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
                print(f"KILLED: {rel_path} -> {orig[:35]}...")
            else:
                print(f"SURVIVED: {rel_path} -> {orig[:35]}...")
                sys.exit(2)
        finally:
            path.write_text(content, encoding="utf-8")

    print(f"\nAll {killed}/{len(MUTATIONS)} mutants successfully KILLED! 0 survivors.")


if __name__ == "__main__":
    main()

