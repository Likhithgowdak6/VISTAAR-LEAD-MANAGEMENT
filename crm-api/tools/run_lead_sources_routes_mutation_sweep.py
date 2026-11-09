"""
Mutation testing sweep for app/routers/lead_sources.py, app/routers/meta.py, and app/lead_source_service.py.
"""

import subprocess
import sys
from pathlib import Path

LEAD_SOURCES_ROUTER_FILE = Path(__file__).resolve().parent.parent / "app" / "routers" / "lead_sources.py"
META_ROUTER_FILE = Path(__file__).resolve().parent.parent / "app" / "routers" / "meta.py"
LEAD_SOURCE_SERVICE_FILE = Path(__file__).resolve().parent.parent / "app" / "lead_source_service.py"

MUTANTS = [
    # Mutant 1: Server-side check for non-Meta updating meta fields
    (
        LEAD_SOURCE_SERVICE_FILE,
        'if not is_meta and (access_token is not None or form_id is not None or form_name is not None):',
        'if False and not is_meta and (access_token is not None or form_id is not None or form_name is not None):',
    ),
    # Mutant 2: Server-side restriction that only Meta sources can have call scheduling
    (
        LEAD_SOURCE_SERVICE_FILE,
        'resolved_call_scheduling = bool(is_meta and call_scheduling_enabled)',
        'resolved_call_scheduling = bool(call_scheduling_enabled)',
    ),
    # Mutant 3: LeadSourceError must be mapped to 502 Bad Gateway
    (
        LEAD_SOURCES_ROUTER_FILE,
        'status_code=502,',
        'status_code=500,',
    ),
    # Mutant 4: Suggested fact key mapping in field discovery
    (
        LEAD_SOURCES_ROUTER_FILE,
        '"suggestedFactKey": suggested,',
        '"suggestedFactKey": None,',
    ),
    # Mutant 5: Webhook HMAC signature validation gating
    (
        META_ROUTER_FILE,
        'if not valid:',
        'if False and not valid:',
    ),
    # Mutant 6: OAuth error cancellation result flag in return URL
    (
        META_ROUTER_FILE,
        '"metaConnectResult": "cancelled",',
        '"metaConnectResult": "ok",',
    ),
]


def run_test() -> bool:
    res = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "tests/test_lead_sources_routes.py",
            "tests/test_meta_public_routes.py",
            "-q",
        ],
        capture_output=True,
        text=True,
        cwd=LEAD_SOURCES_ROUTER_FILE.parent.parent.parent,
    )
    return res.returncode == 0


def main():
    killed = 0
    survived = 0

    print(f"Running {len(MUTANTS)} mutations...")
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

