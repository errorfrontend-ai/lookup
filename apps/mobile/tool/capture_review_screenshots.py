"""Captures review screenshots of the listener app on the emulator, for the Step 4 gate (design §2; S4-D28:
every Step 4 screen at 360 and 320 dp).

It reuses tool/run_emulator_tests.py rather than copying it: its pre-start checks (Docker, another emulator,
the fake's port), its release build on the cached engines (or --skip-build), the fake API, the lookup_test
boot, the device preparation and the uiautomator driver. Then, for each width:

  1. sets the screen to exactly that many dp (1080 x 2400 px at density 480 for 360 dp, 540 for 320 dp),
  2. installs the development APK fresh (no permission granted) and walks the app through every state it
     can reach, choosing each answer through the fake's scenario queue,
  3. saves an `adb exec-out screencap -p` PNG per state, named <number>-<state>-<width>dp.png; a screen
     that scrolls also gets <number>-<state>-scrolled-to-end-<width>dp.png,
  4. shows the production APK given an http address: the set-up problem screen.

Two states need help to be seen: Identifying (the fake has no slow scenario, so its process is paused for a
few seconds while the upload waits, then resumed) and Busy (its picture is chosen from raw frames by the
colour of its icon circle, so it is taken the moment Busy is drawn). "More options" uses the fake's
match-more-options scenario (a card of six buttons), and the phone failure its busy-without-request-id
scenario four times (the 4th busy answer with no id the API logged is a phone failure). Screen size, density
and font scale are reset
afterwards, and the emulator and the fake are stopped, whatever happens. The PNGs go to a new folder under the user's
temporary folder; its path and a JSON list of (file, state, width, notes) are printed at the end, and the
list is saved there as screenshots.json. Logs, the fake's request log and logcat are in its run-files/.

    python tool/capture_review_screenshots.py               # from apps/mobile, with Docker Desktop closed
    python tool/capture_review_screenshots.py --skip-build  # reuse the APKs kept in build/emulator-tests/
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))

import run_emulator_tests as emulator_tests  # noqa: E402  (the tool folder is put on the path first)
from fake_listener_api import BUSY_RETRY_AFTER_SECONDS  # noqa: E402
from run_emulator_tests import (  # noqa: E402
    DEVELOPMENT_PACKAGE, EMULATOR_SERIAL, IDENTIFY_LABELS, LABELS, MATCH_FIXTURE, PERMISSION_DIALOG_PACKAGES,
    PRODUCTION_PACKAGE, SECONDS_FOR_AN_IDENTIFY, AdbDevice, CardExpectation, Driver, RunContext, RunRecord,
    RunResources, RunStopped, Screen, ScreenNode, StepFailed, Tools, build_apks, describe_screen, find_nodes,
    find_permission_allow_button, find_tools, install_fresh, node_to_tap, prepare_device, reasons_not_to_start,
    require, save_evidence_quietly, slug, start_emulator, start_fake_api, stop_everything, wait_for_boot)

# ---- The screen sizes ---------------------------------------------------------------------------------------
SCREEN_SIZE_PIXELS = (1080, 2400)
# (dp wide, density): 1080 px x 160 / density = the width in dp.
WIDTHS: tuple[tuple[int, int], ...] = ((360, 480), (320, 540))
LARGE_FONT_SCALE = '2.0'

# ---- The words read on screen, beyond the driver's LABELS (design §2) ----------------------------------------
# Matched as a part of a node's text ("contains"), so a sentence split across lines still matches.
TEXTS: dict[str, str] = {
    'refused once': 'You chose not to allow the microphone.',                 # §2.3
    'refused for good': 'The microphone is turned off for Look Up.',          # §2.3
    'not now': 'Not now',                                                     # §2.3
    'identifying heading': 'Identifying…',                                    # §2.5
    'fallback note': "This ad isn't on air right now",                        # §2.7
    'more options': 'More options',                                           # §2.6
    'recording unusable heading': "We couldn't use that recording",           # §2.10
    'too many tries heading': 'Too many tries',                               # §2.10
    'newer app heading': 'This needs a newer Look Up',                        # §2.10
}

# Android 13's permission dialog: the deny button. The second request shows "don't ask again" in its place.
PERMISSION_DENY_BUTTON_IDS = ('permission_deny_and_dont_ask_again_button', 'permission_deny_button')
PERMISSION_DENY_BUTTON_TEXTS = ("Don't allow", 'Don’t allow', 'Deny', 'DENY')

# Every state, numbered once so a state has the same number at each width.
STATES: tuple[str, ...] = (
    'home', 'permission-not-asked', 'system-permission-dialog', 'permission-refused-once',
    'permission-refused-for-good', 'listening', 'identifying', 'result', 'copy-sheet', 'more-options',
    'result-default-card', 'no-match', 'busy', 'error-server-failure', 'error-recording-unusable',
    'error-no-connection', 'error-too-many-tries', 'error-newer-app-needed', 'error-phone-failure',
    'home-text-scale-2', 'result-text-scale-2', 'set-up-problem',
)
STATE_NUMBERS = {state: number for number, state in enumerate(STATES, start=1)}
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'

# Busy shows for the fake's Retry-After (6 s) per send; its picture is chosen from raw frames by colour, so it is
# taken while Busy is drawn rather than after a uiautomator read: the state screens draw their 88 dp icon circle
# at the top left,
# and only Busy (and Too many tries) fill it with warning-soft (lib/core/theme/look_up_tokens.dart, light theme).
WARNING_SOFT = bytes.fromhex('fbefd9')
ICON_CIRCLE_BOX_DP = (30, 95, 100, 165)   # left, top, right, bottom: a box inside the circle, in dp
LISTENING_SECONDS_LEFT = re.compile(r'(\d+) seconds? left')
MINIMUM_SECONDS_LEFT = 3   # a read that saw this much of the countdown leaves time for the picture


@dataclass
class Shot:
    """One line of the list: the file (none when the state was not captured), the state, the width, notes."""
    file: str | None
    state: str
    width_dp: int
    notes: str


# ---- Reading the screen (pure) ------------------------------------------------------------------------------

def find_permission_deny_button(nodes: Sequence[ScreenNode]) -> ScreenNode | None:
    """The system dialog's deny button, by resource id first, then by its text."""
    for button_id in PERMISSION_DENY_BUTTON_IDS:
        for node in nodes:
            if node.resource_id.endswith(f':id/{button_id}'):
                return node
    for text in PERMISSION_DENY_BUTTON_TEXTS:
        for node in nodes:
            if node.package_name in PERMISSION_DIALOG_PACKAGES and text in node.lines:
                return node
    return None


def app_content(screen: Screen, package_name: str) -> tuple[tuple[str, tuple[int, int, int, int]], ...]:
    """What the app shows and where: two reads differ when the screen scrolled."""
    return tuple((node.describe(), node.bounds) for node in screen.nodes
                 if node.package_name == package_name and node.lines)


def pause_process(process_id: int) -> None:
    """Suspends a process (the fake API's) without stopping it: its listening port keeps accepting."""
    _suspend_or_resume(process_id, is_pausing=True)


def resume_process(process_id: int) -> None:
    _suspend_or_resume(process_id, is_pausing=False)


def _suspend_or_resume(process_id: int, *, is_pausing: bool) -> None:
    if os.name != 'nt':
        os.kill(process_id, signal.SIGSTOP if is_pausing else signal.SIGCONT)
        return
    import ctypes
    process_suspend_resume = 0x0800
    kernel32, ntdll = ctypes.windll.kernel32, ctypes.windll.ntdll
    handle = kernel32.OpenProcess(process_suspend_resume, False, process_id)
    if not handle:
        raise StepFailed(f'cannot open the fake API process ({process_id}) to {"pause" if is_pausing else "resume"} it')
    try:
        status = (ntdll.NtSuspendProcess if is_pausing else ntdll.NtResumeProcess)(handle)
        if status != 0:
            raise StepFailed(f'{"pausing" if is_pausing else "resuming"} the fake API process failed '
                             f'(NTSTATUS 0x{status & 0xFFFFFFFF:08X})')
    finally:
        kernel32.CloseHandle(handle)


def seconds_left_on(screen: Screen) -> int | None:
    """The Listening countdown, "[n] seconds left", as a read of the screen showed it."""
    for node in screen.nodes:
        for line in node.lines:
            match = LISTENING_SECONDS_LEFT.fullmatch(line)
            if match:
                return int(match[1])
    return None


@dataclass(frozen=True)
class RawFrame:
    """One `screencap` without -p: RGBA pixels, row by row."""
    width: int
    height: int
    pixels: bytes


def parse_raw_screencap(data: bytes) -> RawFrame | None:
    """Reads `screencap`'s raw output: width, height and pixel format (little-endian), on newer Android a
    colour space, then 4 bytes per pixel. None for anything else."""
    if len(data) < 12:
        return None
    width, height, pixel_format = struct.unpack('<III', data[:12])
    header_size = len(data) - width * height * 4
    if pixel_format not in (1, 2) or header_size not in (12, 16):   # RGBA_8888, RGBX_8888
        return None
    return RawFrame(width, height, data[header_size:])


def share_of_colour(frame: RawFrame, box_dp: tuple[int, int, int, int], density: int, colour: bytes) -> float:
    """How much of a box (in dp, sampled every 3 dp) shows exactly [colour]."""
    scale = density / 160
    left, top, right, bottom = box_dp
    total = matching = 0
    for y_dp in range(top, bottom + 1, 3):
        for x_dp in range(left, right + 1, 3):
            offset = (int(y_dp * scale) * frame.width + int(x_dp * scale)) * 4
            total += 1
            matching += frame.pixels[offset:offset + 3] == colour
    return matching / total if total else 0.0


def png_from_frame(frame: RawFrame) -> bytes:
    """A raw frame as a PNG (8-bit RGBA, no row filter)."""
    stride = frame.width * 4
    rows = b''.join(b'\x00' + frame.pixels[y * stride:(y + 1) * stride] for y in range(frame.height))

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF)

    return (PNG_SIGNATURE + chunk(b'IHDR', struct.pack('>IIBBBBB', frame.width, frame.height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows, 6)) + chunk(b'IEND', b''))


def png_size(data: bytes) -> tuple[int, int] | None:
    """The width and height of a PNG, from its header; none when [data] is not a PNG."""
    if len(data) < 24 or not data.startswith(PNG_SIGNATURE):
        return None
    width, height = struct.unpack('>II', data[16:24])
    return width, height


# ---- Walking the app ------------------------------------------------------------------------------------------

class Walker:
    """Drives the app into each state and saves its picture."""

    def __init__(self, device: AdbDevice, fake_api: emulator_tests.HttpFakeApi,
                 fake_process: subprocess.Popen[bytes], apks: dict[str, Path], output_folder: Path,
                 evidence_folder: Path) -> None:
        self.device = device
        self.fake_api = fake_api
        self.fake_process = fake_process
        self.apks = apks
        self.output_folder = output_folder
        self.evidence_folder = evidence_folder
        self.driver = Driver(device, DEVELOPMENT_PACKAGE)
        self.context = RunContext(self.driver, device, fake_api, CardExpectation.from_fixture(MATCH_FIXTURE))
        self.match_action_count = len(json.loads(MATCH_FIXTURE.read_text(encoding='utf-8'))
                                      ['response']['result']['card']['actions'])
        self.width_dp = 0
        self.density = 160
        self.shots: list[Shot] = []

    # -- pictures --

    def file_name(self, state: str) -> str:
        number = STATE_NUMBERS[state.removesuffix('-scrolled-to-end')]
        return f'{number:02d}-{state}-{self.width_dp}dp.png'

    def screencap(self, state: str) -> tuple[Path, tuple[int, int]]:
        path = self.output_folder / self.file_name(state)
        with path.open('wb') as picture:
            completed = subprocess.run([self.device.adb_path, '-s', self.device.serial, 'exec-out', 'screencap', '-p'],
                                       stdout=picture, stderr=subprocess.PIPE, timeout=40)
        size = png_size(path.read_bytes()[:24])
        if completed.returncode != 0 or size is None:
            raise StepFailed(f'screencap gave no PNG for {state} '
                             f'({completed.stderr.decode("utf-8", "replace").strip()[:200] or "no message"})')
        return path, size

    def record(self, state: str, path: Path | None, notes: str) -> None:
        self.shots.append(Shot(path.name if path else None, state, self.width_dp, notes))
        print(f'{"SAVED" if path else "MISSED"}  {self.width_dp} dp  {state}: {path.name if path else ""} {notes}',
              flush=True)

    def capture(self, state: str, notes: str = '', *, check_scrolling: bool = True, settle_seconds: float = 0.8) -> None:
        """Saves the screen as [state]. With [check_scrolling], swipes up to see whether the screen scrolls;
        when it does, also saves the end of it, then scrolls back to the top."""
        self.driver.pause(settle_seconds)
        path, size = self.screencap(state)
        if not check_scrolling:
            self.record(state, path, self.with_size(notes, size))
            return
        before = app_content(self.driver.read_screen(), DEVELOPMENT_PACKAGE)
        swipes = 0
        for _ in range(8):
            self.driver.scroll(towards_end=True)
            after = app_content(self.driver.read_screen(), DEVELOPMENT_PACKAGE)
            if after == before:
                break
            before, swipes = after, swipes + 1
        if swipes == 0:
            self.record(state, path, self.with_size(join(notes, 'fits the screen (does not scroll)'), size))
            return
        self.record(state, path, self.with_size(join(notes, 'top of the screen; it scrolls'), size))
        end_path, end_size = self.screencap(f'{state}-scrolled-to-end')
        self.record(f'{state}-scrolled-to-end', end_path,
                    self.with_size(f'the same screen scrolled to its end ({swipes} swipe{"s" if swipes > 1 else ""})',
                                   end_size))
        for _ in range(swipes + 2):
            self.driver.scroll(towards_end=False)

    def with_size(self, notes: str, size: tuple[int, int]) -> str:
        return join(notes, f'{size[0]}x{size[1]} px')

    def raw_frame(self) -> RawFrame:
        completed = subprocess.run([self.device.adb_path, '-s', self.device.serial, 'exec-out', 'screencap'],
                                   capture_output=True, timeout=40)
        frame = parse_raw_screencap(completed.stdout)
        if completed.returncode != 0 or frame is None:
            raise StepFailed(f'screencap gave no raw frame ({len(completed.stdout)} bytes)')
        return frame

    def capture_frame_when(self, state: str, is_wanted: Callable[[RawFrame], bool], timeout_seconds: float,
                           notes: str) -> None:
        """Takes raw frames until one [is_wanted], and saves that one as the state's PNG."""
        deadline = time.monotonic() + timeout_seconds
        count = 0
        while time.monotonic() < deadline:
            frame = self.raw_frame()
            count += 1
            if is_wanted(frame):
                path = self.output_folder / self.file_name(state)
                path.write_bytes(png_from_frame(frame))
                self.record(state, path, self.with_size(join(notes, f'frame {count} of those taken, chosen by '
                                                                    f'its colours'), (frame.width, frame.height)))
                return
        raise StepFailed(f'none of the {count} frames taken in {timeout_seconds:g} s showed it')

    def capture_listening(self) -> None:
        """Listening lasts 8 s. The read that finds it also shows the countdown, so the picture taken straight
        after is kept only when enough of the countdown was left."""
        self.driver.wait_for(LABELS['listening heading'], 15)
        seconds_left = seconds_left_on(require_screen(self.driver.last_screen))
        path, size = self.screencap('listening')
        if seconds_left is not None and seconds_left >= MINIMUM_SECONDS_LEFT:
            self.record('listening', path, self.with_size(f'taken when the countdown read "{seconds_left} seconds '
                                                          f'left"', size))
            return
        if seconds_left is None and self.shows(LABELS['listening heading']):
            self.record('listening', path, self.with_size('confirmed by a read just after the picture', size))
            return
        path.unlink(missing_ok=True)
        raise StepFailed(f'Listening was found with {seconds_left} seconds left, too late for a sure picture')

    def capture_while_shown(self, state: str, text: str, timeout_seconds: float, notes: str = '',
                            *, exact: bool = True) -> None:
        """For a screen that shows only briefly: waits for [text], takes the picture at once, and keeps it only
        if [text] is still on screen after it; otherwise tries again until [timeout_seconds]."""
        deadline = time.monotonic() + timeout_seconds
        while True:
            self.wait_for_text(text, max(1.0, deadline - time.monotonic()), exact=exact)
            path, size = self.screencap(state)
            if self.shows(text, exact=exact):
                self.record(state, path, self.with_size(join(notes, 'taken while the screen showed; '
                                                                      'confirmed by a read just after'), size))
                return
            if time.monotonic() >= deadline:
                path.unlink(missing_ok=True)
                raise StepFailed(f'{text!r} came and went before a picture could be confirmed')

    # -- reading and tapping --

    def shows(self, text: str, *, exact: bool = True, package_name: str | None = DEVELOPMENT_PACKAGE) -> bool:
        return bool(find_nodes(self.driver.read_screen().nodes, text, package_name=package_name, exact=exact))

    def wait_for_text(self, text: str, timeout_seconds: float, *, exact: bool = True,
                      package_name: str | None = DEVELOPMENT_PACKAGE) -> ScreenNode:
        deadline = time.monotonic() + timeout_seconds
        while True:
            matches = find_nodes(self.driver.read_screen().nodes, text, package_name=package_name, exact=exact)
            if matches:
                return node_to_tap(matches)
            if time.monotonic() >= deadline:
                raise StepFailed(f'waited {timeout_seconds:.0f} s for {text!r}; '
                                 f'{describe_screen(self.driver.last_screen, package_name)}')
            self.driver.pause(0.4)

    def wait_for_system_button(self, finder: Callable[[Sequence[ScreenNode]], ScreenNode | None],
                               timeout_seconds: float) -> ScreenNode:
        deadline = time.monotonic() + timeout_seconds
        while True:
            button = finder(self.driver.read_screen().nodes)
            if button is not None:
                return button
            if time.monotonic() >= deadline:
                raise StepFailed(f'the system permission dialog did not appear within {timeout_seconds:.0f} s; '
                                 f'{describe_screen(self.driver.last_screen)}')
            self.driver.pause(0.4)

    def tap_identify(self) -> None:
        """Taps the identify control, scrolling to it when large text pushed it out of view."""
        for towards_end in (None, True, True, True):
            if towards_end is not None:
                self.driver.scroll(towards_end=True)
            screen = self.driver.read_screen()
            for label in IDENTIFY_LABELS:
                matches = find_nodes(screen.nodes, label, package_name=DEVELOPMENT_PACKAGE)
                if matches:
                    self.driver.tap_node(node_to_tap(matches), label)
                    return
        raise StepFailed(f'the identify control is not on screen; '
                         f'{describe_screen(self.driver.last_screen, DEVELOPMENT_PACKAGE)}')

    def identify(self, scenarios: Sequence[str]) -> None:
        if scenarios:
            self.fake_api.queue(scenarios)
        self.tap_identify()

    def back_home(self, label: str = LABELS['back to home']) -> None:
        self.context.back_home_from(label)

    def adb_quietly(self, *arguments: str) -> str:
        try:
            return self.device.adb(*arguments, check=False, timeout_seconds=30).strip()
        except StepFailed as failure:
            return str(failure)

    # -- the screen size --

    def set_width(self, width_dp: int, density: int) -> str:
        self.width_dp = width_dp
        self.density = density
        self.device.adb('shell', 'wm', 'size', f'{SCREEN_SIZE_PIXELS[0]}x{SCREEN_SIZE_PIXELS[1]}')
        self.device.adb('shell', 'wm', 'density', str(density))
        self.device.forget_screen_size()   # the driver keeps the size it read first; this one has changed
        size = self.device.screen_size()
        density_output = self.device.adb('shell', 'wm', 'density')
        dp = size[0] * 160 / density
        if round(dp) != width_dp or str(density) not in density_output:
            raise StepFailed(f'the screen is {size} at "{density_output.strip()}", not {width_dp} dp wide')
        return f'{size[0]}x{size[1]} px at density {density}: {dp:g} x {size[1] * 160 / density:.0f} dp'

    # -- the states --

    def start_fresh(self) -> None:
        """A fresh install with no permission, launched to Home."""
        install_fresh(self.device, self.apks['development'])
        self.device.launch_app(DEVELOPMENT_PACKAGE)
        self.driver.wait_for(LABELS['home heading'], 40)

    def grant_microphone(self) -> None:
        self.device.adb('shell', 'pm', 'grant', DEVELOPMENT_PACKAGE, 'android.permission.RECORD_AUDIO')

    def recover(self) -> None:
        """After a failure: an empty scenario queue (the fake's reset also forgets the issued tokens, so the app
        is installed fresh to register again), the microphone allowed, the app at Home."""
        self.adb_quietly('shell', 'settings', 'put', 'system', 'font_scale', '1.0')
        self.fake_api.reset()
        self.start_fresh()
        self.grant_microphone()

    def home(self) -> None:
        self.capture('home', 'development build: "Send a test error" at the top right is a development tool only '
                             '(§2.2), never in staging or production')

    def permission(self) -> None:
        self.tap_identify()
        self.driver.wait_for(LABELS['permission heading'], 15)
        self.capture('permission-not-asked', 'the variant "not asked yet" (§2.3)')
        self.driver.tap(LABELS['allow microphone'])
        self.wait_for_system_button(find_permission_allow_button, 15)
        self.capture('system-permission-dialog', "Android 13's own dialog, after \"Allow microphone\"",
                     check_scrolling=False)
        self.driver.tap_node(self.wait_for_system_button(find_permission_deny_button, 5), 'system dialog: deny')
        self.wait_for_text(TEXTS['refused once'], 15, exact=False)
        self.capture('permission-refused-once', 'after "Don\'t allow" once in the system dialog')
        self.driver.tap(LABELS['allow microphone'])
        self.driver.tap_node(self.wait_for_system_button(find_permission_deny_button, 15), 'system dialog: deny')
        self.wait_for_text(TEXTS['refused for good'], 15, exact=False)
        self.capture('permission-refused-for-good', 'after "Don\'t allow" a second time: Android will not ask again')
        self.driver.tap(TEXTS['not now'])
        self.driver.wait_for(LABELS['home heading'], 15)
        self.grant_microphone()   # the rest of the walk needs the microphone

    def listening_identifying_result_copy_sheet(self) -> None:
        card = self.context.card
        self.identify(['match'])
        try:
            self.capture_listening()
        except StepFailed as failure:
            self.record('listening', None, f'not captured: {failure}')
        # The fake has no slow scenario and answers at once. Paused, its port still accepts the connection and
        # the operating system keeps the ~26 KB upload, so the app waits in Identifying until it is resumed
        # (well inside the app's 15 s receive timeout).
        is_paused = False
        try:
            pause_process(self.fake_process.pid)
            is_paused = True
            self.capture_while_shown('identifying', TEXTS['identifying heading'], 25,
                                     'the fake API process was paused while the upload waited, then resumed')
        except StepFailed as failure:
            self.record('identifying', None, f'not captured: {failure}')
        finally:
            if is_paused:
                resume_process(self.fake_process.pid)
        self.driver.wait_for(LABELS['result header'], SECONDS_FOR_AN_IDENTIFY)
        more = self.shows(TEXTS['more options'])
        self.capture('result', f'scenario match ({MATCH_FIXTURE.name}): "{card.title}", {card.client_name}, '
                               f'{self.match_action_count} buttons, no banner'
                     + ('; "More options" shown' if more else ''))
        self.driver.tap_scrolling(card.call_label)
        self.driver.wait_for(LABELS['copy sheet heading'], 15)
        self.capture('copy-sheet', f'after tapping "{card.call_label}": the image has no dialler', check_scrolling=False)
        self.driver.tap(LABELS['copy sheet close'])
        self.back_home(LABELS['result back'])

    def more_options(self) -> None:
        self.identify(['match-more-options'])
        self.driver.wait_for(LABELS['result header'], SECONDS_FOR_AN_IDENTIFY)
        self.driver.tap_scrolling(TEXTS['more options'])
        self.capture('more-options', 'scenario match-more-options: the 4 buttons of match-campaign.json and the 2 '
                                     'of six-actions.json it does not hold; after tapping "More options" (S4-D18)')
        self.back_home(LABELS['result back'])

    def result_default_card(self) -> None:
        self.identify(['fallback'])
        self.driver.wait_for(LABELS['result header'], SECONDS_FOR_AN_IDENTIFY)
        self.wait_for_text(TEXTS['fallback note'], 10, exact=False)
        self.capture('result-default-card', 'scenario fallback (match-client-default.json)')
        self.back_home(LABELS['result back'])

    def no_match(self) -> None:
        self.identify(['no-match'])
        self.driver.wait_for(LABELS['no match heading'], SECONDS_FOR_AN_IDENTIFY)
        self.capture('no-match', 'scenario no-match')
        self.back_home()

    def busy(self) -> None:
        # Busy shows for Retry-After (6 s in the fake) per send; three busy answers give three chances, and the
        # fourth send is answered match, so the queue is empty again at Result.
        self.identify(['busy', 'busy', 'busy', 'match'])
        density = self.density

        def is_busy(frame: RawFrame) -> bool:
            return share_of_colour(frame, ICON_CIRCLE_BOX_DP, density, WARNING_SOFT) >= 0.5

        try:
            self.capture_frame_when('busy', is_busy, SECONDS_FOR_AN_IDENTIFY,
                                    'scenario busy, Retry-After 6 s (the fake shortens it), so the countdown is short')
        except StepFailed as failure:
            self.record('busy', None, f'not captured: {failure}')
        self.driver.wait_for(LABELS['result header'], 60)
        self.back_home(LABELS['result back'])

    def error(self, state: str, scenario: str, heading: str, notes: str) -> None:
        self.identify([scenario])
        self.wait_for_text(heading, SECONDS_FOR_AN_IDENTIFY, exact=False)
        self.capture(state, join(f'scenario {scenario}', notes))
        self.back_home()

    def error_server_failure(self) -> None:
        self.error('error-server-failure', 'error', LABELS['error heading'], 'HTTP 500 INTERNAL')

    def error_recording_unusable(self) -> None:
        self.error('error-recording-unusable', 'invalid-audio', TEXTS['recording unusable heading'],
                   'HTTP 400 INVALID_AUDIO')

    def error_no_connection(self) -> None:
        self.error('error-no-connection', 'drop', LABELS['no connection heading'], 'the fake closes the connection')

    def error_too_many_tries(self) -> None:
        self.error('error-too-many-tries', 'rate-limited', TEXTS['too many tries heading'],
                   'HTTP 429, Retry-After 42 s (a short wait)')

    def error_newer_app_needed(self) -> None:
        self.error('error-newer-app-needed', 'choose-station', TEXTS['newer app heading'], 'CHOOSE_STATION answer')

    def error_phone_failure(self) -> None:
        """The phone failure through the fake: four busy answers to one clip with no id the API logged, in the
        X-Request-Id header or the body. The app waits after the first three as for Busy; the 4th is the end (T21)
        and, with no id to show, a phone failure, reported to /client-errors so the accepted report's id gives the
        code (SendPolicy._serverFailure)."""
        self.identify(['busy-without-request-id'] * 4)
        self.wait_for_text(LABELS['error heading'], SECONDS_FOR_AN_IDENTIFY + 4 * BUSY_RETRY_AFTER_SECONDS, exact=False)
        try:
            self.wait_for_text(LABELS['reference code label'], 15)
            code_note = 'the crash report was accepted (202), so the reference code shows'
        except StepFailed:
            code_note = 'no reference code shown within 15 s'
        self.capture('error-phone-failure', f'scenario busy-without-request-id 4 times: the 4th busy answer carried no '
                                            f'request id; {code_note}')
        self.back_home()

    def text_scale(self) -> None:
        self.device.adb('shell', 'settings', 'put', 'system', 'font_scale', LARGE_FONT_SCALE)
        try:
            self.device.stop_app(DEVELOPMENT_PACKAGE)
            self.device.launch_app(DEVELOPMENT_PACKAGE)
            self.driver.wait_for(LABELS['home heading'], 40)
            self.capture('home-text-scale-2', f'system font scale {LARGE_FONT_SCALE}')
            self.identify(['match'])
            self.driver.wait_for(LABELS['result header'], SECONDS_FOR_AN_IDENTIFY)
            self.capture('result-text-scale-2', f'system font scale {LARGE_FONT_SCALE}, scenario match')
            self.back_home(LABELS['result back'])
        finally:
            self.device.adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0')
            self.device.stop_app(DEVELOPMENT_PACKAGE)
            self.device.launch_app(DEVELOPMENT_PACKAGE)
            self.driver.wait_for(LABELS['home heading'], 40)

    def set_up_problem(self) -> None:
        production_driver = Driver(self.device, PRODUCTION_PACKAGE)
        self.device.install(self.apks['production'])
        self.device.launch_app(PRODUCTION_PACKAGE)
        production_driver.wait_for(LABELS['set-up problem'], 40)
        self.driver.pause(0.8)
        path, size = self.screencap('set-up-problem')
        self.record('set-up-problem', path, self.with_size('the production APK given an http:// address '
                                                           '(the driver\'s cleartext build)', size))
        self.device.stop_app(PRODUCTION_PACKAGE)

    # -- one width --

    def walk(self, width_dp: int, density: int) -> None:
        print(f'\n---- {width_dp} dp: {self.set_width(width_dp, density)}', flush=True)
        self.start_fresh()
        journeys: list[tuple[Callable[[], None], tuple[str, ...]]] = [
            (self.home, ('home',)),
            (self.permission, ('permission-not-asked', 'system-permission-dialog', 'permission-refused-once',
                               'permission-refused-for-good')),
            (self.listening_identifying_result_copy_sheet, ('listening', 'identifying', 'result', 'copy-sheet')),
            (self.more_options, ('more-options',)),
            (self.result_default_card, ('result-default-card',)),
            (self.no_match, ('no-match',)),
            (self.busy, ('busy',)),
            (self.error_server_failure, ('error-server-failure',)),
            (self.error_recording_unusable, ('error-recording-unusable',)),
            (self.error_no_connection, ('error-no-connection',)),
            (self.error_too_many_tries, ('error-too-many-tries',)),
            (self.error_newer_app_needed, ('error-newer-app-needed',)),
            (self.error_phone_failure, ('error-phone-failure',)),
            (self.text_scale, ('home-text-scale-2', 'result-text-scale-2')),
            (self.set_up_problem, ('set-up-problem',)),
        ]
        for journey, states in journeys:
            try:
                journey()
            except Exception as error:   # one state that fails is noted; the walk goes on with the next
                reason = str(error) if isinstance(error, StepFailed) else f'{type(error).__name__}: {error}'
                evidence = save_evidence_quietly(self.device, f'{width_dp}dp-{slug(journey.__name__)}',
                                                 self.driver.last_screen)
                done = {shot.state.removesuffix('-scrolled-to-end') for shot in self.shots if shot.width_dp == width_dp}
                for state in states:
                    if state not in done:
                        self.record(state, None, f'not captured: {reason} (screen dump: {", ".join(evidence)})')
                try:
                    self.recover()
                except Exception as recovery_error:
                    raise RunStopped(f'the app could not be brought back to Home: {recovery_error}') from error

    def reset_device(self) -> list[str]:
        """Puts back everything the walk changed on the device. Never raises."""
        return [self.adb_quietly('shell', 'wm', 'size', 'reset'),
                self.adb_quietly('shell', 'wm', 'density', 'reset'),
                self.adb_quietly('shell', 'settings', 'put', 'system', 'font_scale', '1.0')]


def join(*parts: str) -> str:
    return '; '.join(part for part in parts if part)


def require_screen(screen: Screen | None) -> Screen:
    if screen is None:
        raise StepFailed('no screen was read')
    return screen


# ---- The run ------------------------------------------------------------------------------------------------

def run(tools: Tools, output_folder: Path, skip_build: bool) -> list[Shot]:
    run_files = output_folder / 'run-files'
    run_files.mkdir()
    record = RunRecord(run_files)
    resources = RunResources()
    walker: Walker | None = None

    def build() -> str:
        resources.apks.update(build_apks(tools, run_files, skip_build))
        record.apks = {flavour: str(path) for flavour, path in resources.apks.items()}
        return ', '.join(f'{flavour}: {path}' for flavour, path in resources.apks.items())

    def start_fake() -> str:
        resources.fake, resources.fake_api = start_fake_api(run_files, run_files / 'clip.m4a')
        return f'listening on {emulator_tests.FAKE_API_ADDRESS}'

    def boot() -> str:
        resources.emulator = start_emulator(tools, run_files)
        resources.device = AdbDevice(tools.adb, EMULATOR_SERIAL, run_files / 'evidence')
        return wait_for_boot(resources.device, resources.emulator)

    def prepare() -> str:
        record.device = prepare_device(require(resources.device))
        return f"{record.device['model']}, Android {record.device['android_version']}, {record.device['image']}"

    try:
        record.step('build the release APKs' + (' (reused)' if skip_build else ''), build, is_required=True)
        record.step('start the fake API', start_fake, is_required=True)
        record.step(f'start the {emulator_tests.AVD_NAME} virtual device', boot, is_required=True)
        record.step('prepare the device', prepare, is_required=True)
        walker = Walker(require(resources.device), require(resources.fake_api), require(resources.fake).process,
                        resources.apks, output_folder, run_files / 'evidence')
        for width_dp, density in WIDTHS:
            walker.walk(width_dp, density)
    except (RunStopped, StepFailed) as stopped:
        print(f'STOPPED  {stopped}', flush=True)
    finally:
        if walker is not None:
            print(f'reset the device: {" | ".join(walker.reset_device())}', flush=True)
        if resources.fake_api is not None:
            try:
                (run_files / 'fake-api-requests.json').write_text(
                    json.dumps(resources.fake_api.request_log(), indent=2, ensure_ascii=False), encoding='utf-8')
            except Exception:   # the request log is a help for reading a failure, never a reason to skip clean-up
                pass
        stop_everything(resources, run_files)
        record.write()
    return walker.shots if walker is not None else []


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):   # labels such as "Listening…" must never break the console
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(errors='backslashreplace')
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--skip-build', action='store_true', help='reuse the APKs kept in build/emulator-tests/')
    arguments = parser.parse_args(argv)
    try:
        tools = find_tools()
        reasons = reasons_not_to_start(tools)
    except (StepFailed, OSError, subprocess.SubprocessError) as error:
        print(f'Cannot start: {error}')
        return 2
    if reasons:
        print('Not starting the screenshot run:')
        for reason in reasons:
            print(f'  - {reason}')
        print('This script never stops Docker or another emulator: close them, then run it again.')
        return 2
    output_folder = Path(tempfile.mkdtemp(prefix='lookup-review-screenshots-'))
    print(f'Screenshot folder: {output_folder}', flush=True)
    shots: list[Shot] = []
    try:
        shots = run(tools, output_folder, arguments.skip_build)
    finally:
        listing = [asdict(shot) for shot in shots]
        (output_folder / 'screenshots.json').write_text(json.dumps(listing, indent=2, ensure_ascii=False),
                                                        encoding='utf-8')
        print(f'\nScreenshot folder: {output_folder}')
        print(json.dumps(listing, indent=2, ensure_ascii=False))
        missed = [f'{shot.state} at {shot.width_dp} dp' for shot in shots if shot.file is None]
        print(f'\n{sum(1 for shot in shots if shot.file)} pictures saved; not captured: {", ".join(missed) or "none"}')
    return 0 if shots and all(shot.file for shot in shots) else 1


if __name__ == '__main__':
    sys.exit(main())
