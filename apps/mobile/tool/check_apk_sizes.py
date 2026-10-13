"""The release APKs' size budget (P6 design §3.21, §4.11; P6-PERFORMANCE-01, -02; P6-TESTS-12).

After a release build split per ABI,

    flutter build apk --release --split-per-abi --flavor production --dart-define-from-file=config/production.json

there must be one APK for each ABI the app ships for, and each must be below 15,000,000 bytes:

    python tool/check_apk_sizes.py [--folder build/app/outputs/flutter-apk] [--flavour production]

It prints each APK's size and exits 1 when one is missing or at or over the budget, so a build that grows past it
fails. Native libraries are stored compressed in release builds (android/app/build.gradle.kts, Q10), which is what
keeps the APKs under it.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

BUDGET_BYTES = 15_000_000
# The ABIs `--split-per-abi` builds for: every phone the app supports, and the emulator.
ABIS = ('arm64-v8a', 'armeabi-v7a', 'x86_64')
APP_FOLDER = Path(__file__).resolve().parents[1]
DEFAULT_FOLDER = APP_FOLDER / 'build' / 'app' / 'outputs' / 'flutter-apk'


def apk_name(abi: str, flavour: str) -> str:
    """The name Flutter gives the APK of [abi] in a split release build of [flavour]."""
    return f'app-{abi}-{flavour}-release.apk'


def check_sizes(folder: Path, flavour: str) -> tuple[list[str], list[str]]:
    """Each APK's size as a line to print, and each problem: an APK missing, or at or over the budget."""
    lines: list[str] = []
    problems: list[str] = []
    for abi in ABIS:
        path = folder / apk_name(abi, flavour)
        if not path.is_file():
            problems.append(f'{path.name} is missing: build with --split-per-abi')
            continue
        size = path.stat().st_size
        lines.append(f'{path.name}: {size:,} bytes ({size / 1_000_000:.1f} MB)')
        if size >= BUDGET_BYTES:
            problems.append(f'{path.name} is {size:,} bytes, at or over the budget of {BUDGET_BYTES:,}')
    return lines, problems


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--folder', type=Path, default=DEFAULT_FOLDER)
    parser.add_argument('--flavour', default='production')
    arguments = parser.parse_args(argv)
    lines, problems = check_sizes(arguments.folder, arguments.flavour)
    for line in lines:
        print(line)
    if problems:
        for problem in problems:
            print(f'FAIL  {problem}')
        return 1
    print(f'Every APK is below {BUDGET_BYTES:,} bytes.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
