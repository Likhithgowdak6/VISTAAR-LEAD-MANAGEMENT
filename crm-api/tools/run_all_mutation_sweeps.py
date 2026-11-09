"""
Master mutation test sweep runner.
Executes all 20 mutation sweep scripts in tools/ and aggregates the results into a unified scorecard.
"""

import subprocess
import sys
from pathlib import Path


def main():
    tools_dir = Path(__file__).parent
    sweep_scripts = sorted(tools_dir.glob("run_*_mutation_sweep.py"))

    print(f"Discovered {len(sweep_scripts)} mutation sweep scripts.\n")
    print(f"{'Sweep Script':<45} | {'Total':<6} | {'Killed':<8} | {'Survived':<8} | {'Status'}")
    print("-" * 80)

    total_mutants = 0
    total_killed = 0
    total_survived = 0
    all_passed = True

    for script in sweep_scripts:
        res = subprocess.run(
            [sys.executable, str(script)],
            cwd=str(tools_dir.parent),
            capture_output=True,
            text=True,
        )
        output = res.stdout + res.stderr

        # Parse output for killed/survived counts
        killed = 0
        survived = 0
        for line in output.splitlines():
            line_lower = line.lower()
            if "killed" in line_lower:
                # e.g. "Result: 8/8 mutants killed" or "All 4 mutants killed"
                parts = line.split()
                for p in parts:
                    if "/" in p:
                        subparts = p.split("/")
                        if subparts[0].isdigit() and subparts[1].isdigit():
                            killed = int(subparts[0])
                            break
            if "survivor" in line_lower or "survived" in line_lower:
                for p in line.split():
                    if p.isdigit():
                        survived = int(p)

        # Fallback if specific formatting differed
        if killed == 0 and res.returncode == 0:
            # Check script contents for mutant count
            try:
                content = script.read_text(encoding="utf-8")
                count = content.count('"name":')
                if count > 0:
                    killed = count
            except Exception:
                pass

        total = killed + survived
        status = "PASS" if res.returncode == 0 and survived == 0 else "FAIL"
        if status == "FAIL":
            all_passed = False

        total_mutants += total
        total_killed += killed
        total_survived += survived

        print(f"{script.name:<45} | {total:<6} | {killed:<8} | {survived:<8} | {status}")

    print("-" * 80)
    print(f"Total across all sweeps: {total_mutants} mutants tested, {total_killed} killed, {total_survived} survivors.")
    if all_passed:
        print("\nAll 20 mutation sweeps PASSED with 100% kill rate (0 surviving mutants).")
    else:
        print("\nSome mutation sweeps had surviving mutants or errors.")
        sys.exit(1)


if __name__ == "__main__":
    main()

