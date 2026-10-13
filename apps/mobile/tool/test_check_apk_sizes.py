"""Tests of tool/check_apk_sizes.py: the APK size budget passes below it and fails at it, over it, and with an APK
missing (P6-PERFORMANCE-01, -02; P6-TESTS-12: planting an oversized file turns it red).

    python -m unittest test_check_apk_sizes      (from apps/mobile/tool)
"""

from __future__ import annotations

import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_apk_sizes import ABIS, BUDGET_BYTES, apk_name, check_sizes, main  # noqa: E402


class CheckApkSizesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.folder_context = tempfile.TemporaryDirectory()
        self.folder = Path(self.folder_context.name)

    def tearDown(self) -> None:
        self.folder_context.cleanup()

    def plant(self, abi: str, size: int, flavour: str = 'production') -> None:
        """An APK of exactly [size] bytes (a sparse file: nothing is written but its length)."""
        with (self.folder / apk_name(abi, flavour)).open('wb') as file:
            file.truncate(size)

    def run_main(self, *arguments: str) -> tuple[int, str]:
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            exit_code = main(['--folder', str(self.folder), *arguments])
        return exit_code, printed.getvalue()

    def test_every_abi_below_the_budget_passes_and_each_size_is_printed(self) -> None:
        for abi in ABIS:
            self.plant(abi, BUDGET_BYTES - 1)
        exit_code, printed = self.run_main()
        self.assertEqual(exit_code, 0)
        for abi in ABIS:
            self.assertIn(f'app-{abi}-production-release.apk: 14,999,999 bytes', printed)

    def test_an_apk_at_the_budget_fails(self) -> None:
        for abi in ABIS:
            self.plant(abi, 10_000_000)
        self.plant('arm64-v8a', BUDGET_BYTES)
        exit_code, printed = self.run_main()
        self.assertEqual(exit_code, 1)
        self.assertIn('app-arm64-v8a-production-release.apk is 15,000,000 bytes, at or over the budget', printed)

    def test_a_planted_oversized_apk_fails(self) -> None:
        for abi in ABIS:
            self.plant(abi, 10_000_000)
        self.plant('x86_64', 40_000_000)
        self.assertEqual(self.run_main()[0], 1)

    def test_a_build_not_split_per_abi_fails(self) -> None:
        (self.folder / 'app-production-release.apk').write_bytes(b'one APK for every ABI')
        lines, problems = check_sizes(self.folder, 'production')
        self.assertEqual(lines, [])
        self.assertEqual(len(problems), len(ABIS))
        self.assertTrue(all('missing: build with --split-per-abi' in problem for problem in problems))

    def test_the_flavour_names_the_apks_checked(self) -> None:
        for abi in ABIS:
            self.plant(abi, 10_000_000, flavour='staging')
        self.assertEqual(self.run_main('--flavour', 'staging')[0], 0)
        self.assertEqual(self.run_main()[0], 1, 'the production APKs are missing')

    def test_the_budget_and_abis_are_the_designs(self) -> None:
        self.assertEqual(BUDGET_BYTES, 15_000_000)
        self.assertEqual(ABIS, ('arm64-v8a', 'armeabi-v7a', 'x86_64'))


if __name__ == '__main__':
    unittest.main()
