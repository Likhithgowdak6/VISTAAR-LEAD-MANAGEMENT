"""
Mutation testing sweep for AI Knowledge module:
  app/ai_knowledge_service.py, app/routers/ai_knowledge.py, app/ai_knowledge_repository.py.
"""

import subprocess
import sys
from pathlib import Path

SERVICE_FILE = Path(__file__).resolve().parent.parent / "app" / "ai_knowledge_service.py"
ROUTER_FILE = Path(__file__).resolve().parent.parent / "app" / "routers" / "ai_knowledge.py"
REPO_FILE = Path(__file__).resolve().parent.parent / "app" / "ai_knowledge_repository.py"

MUTANTS = [
    # Mutant 1: Optimize fallback to RULES
    (
        SERVICE_FILE,
        'else AI_KNOWLEDGE_CATEGORIES.RULES',
        'else AI_KNOWLEDGE_CATEGORIES.OTHER',
    ),
    # Mutant 2: Read-before-write 404 gate on update/delete/archive
    (
        SERVICE_FILE,
        'if not existing:',
        'if False and not existing:',
    ),
    # Mutant 3: 409 status code on brain not configured
    (
        ROUTER_FILE,
        'status_code=409,',
        'status_code=500,',
    ),
    # Mutant 4: 502 status code on brain upstream error
    (
        ROUTER_FILE,
        'status_code=502,',
        'status_code=500,',
    ),
    # Mutant 5: Archived status write
    (
        REPO_FILE,
        '"status": AI_KNOWLEDGE_STATUSES.ARCHIVED,',
        '"status": AI_KNOWLEDGE_STATUSES.ACTIVE,',
    ),
]


def run_test() -> bool:
    res = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_ai_knowledge.py", "-q"],
        capture_output=True,
        text=True,
        cwd=SERVICE_FILE.parent.parent,
    )
    return res.returncode == 0


def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations on AI Knowledge...")
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

