"""Runs the listener app's emulator tests (design §4.7; S4-TESTS-04, -07, -08; S4-COMPATIBILITY-01;
S4-SECURITY-02).

The release APK is driven from outside, as the Phase 0 capture app was (S4-D33): adb and uiautomator read
the screen as an accessibility tree and tap by label, and the fake API (tool/fake_listener_api.py) chooses
each answer from its scenario queue and records every request. In order, exiting non-zero on any failure:

  1. Refuses to start while Docker runs, another emulator runs, or port 3999 is taken. It never stops
     anything itself: Docker is shared with the user's other projects.
  2. Builds two release APKs on the cached engines: the development flavour against the fake API, and a
     production-flavour APK given an http:// address (its define file goes in the run's temporary folder,
     never into config/). Each is kept in build/emulator-tests/ for --skip-build.
  3. Starts the fake API on 127.0.0.1:3999 and the lookup_test virtual device (headless, audio on), waits
     for boot and installs the development APK fresh, with no permission granted.
  4. Drives the journeys of §4.7 step 3, checking each against the fake's request log.
  5. Checks the size of every recognize request the fake received (S4-REQUEST-02: the body at most 32,768
     bytes, the audio at least 16,000), then the clip the real recorder sent, with the fingerprinter's Python
     (PyAV).
  6. Installs the production APK: the set-up problem screen shows and the fake receives nothing.
  7. Stops the emulator and the fake, writes the run record (JSON, next to the temporary folder: device,
     image, each step's outcome, the screen dumps of any failure) and prints its path.

    python tool/run_emulator_tests.py               # from apps/mobile, with Docker Desktop closed
    python tool/run_emulator_tests.py --skip-build  # reuse the APKs kept by the last build

The builds use --no-pub: run `flutter pub get --offline` first if the packages changed.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Any, Callable, Protocol, Sequence, TypeVar
from xml.etree import ElementTree

from fake_listener_api import BUSY_RETRY_AFTER_SECONDS

# ---- The words the driver reads and taps --------------------------------------------------------------
# Copied from design §2 (docs/design/step-4-listener-app.md). A label matches a node when it equals the
# node's text or content description, or one line of them, after collapsing spaces. If the app's wording
# changes, correct it here.
LABELS: dict[str, str] = {
    'home heading': 'Heard an ad on the radio?',                       # §2.2
    'identify control': 'Identify the ad playing now',                 # §2.2, the control's screen-reader label
    'identify control text': 'Tap to identify',                        # §2.2, its visible label
    'send test error': 'Send a test error',                            # §2.2, development tools only
    'permission heading': 'Look Up needs your microphone',             # §2.3
    'allow microphone': 'Allow microphone',                            # §2.3
    'listening heading': 'Listening…',                                 # §2.4
    'result header': 'Found it',                                       # §2.6
    'result back': 'Back to home',                                     # §2.6, the header's Back arrow
    'copy sheet heading': "Couldn't open this",                        # §2.6
    'copy number': 'Copy number',                                      # §2.6
    'copy sheet close': 'Close',                                       # §2.6
    'no match heading': "We couldn't recognise that",                  # §2.8
    'back to home': 'Back to home',                                    # §2.8, §2.10
    'busy heading': 'Lots of people are listening right now',          # §2.9
    'error heading': 'Something went wrong on our side',               # §2.10, server failure
    'reference code label': 'Reference code',                          # §2.10
    'no connection heading': 'No connection',                          # §2.10
    'send again': 'Send again',                                        # §2.10
    'set-up problem': "This copy of Look Up isn't set up correctly.",  # §2.11
}

# Android 13's permission dialog. "While using the app" keeps the grant for the later journeys.
PERMISSION_ALLOW_BUTTON_IDS = ('permission_allow_foreground_only_button', 'permission_allow_button')
PERMISSION_ALLOW_BUTTON_TEXTS = ('While using the app', 'Allow', 'ALLOW')
PERMISSION_DIALOG_PACKAGES = ('com.android.permissioncontroller', 'com.google.android.permissioncontroller',
                              'com.android.packageinstaller')

# ---- Fixed settings of the run ----------------------------------------------------------------------------
APP_FOLDER = Path(__file__).resolve().parents[1]
REPOSITORY_FOLDER = APP_FOLDER.parents[1]
MATCH_FIXTURE = (REPOSITORY_FOLDER / 'packages' / 'contracts' / 'fixtures' / 'recognition' / 'recognize-response'
                 / 'valid' / 'match-campaign.json')
FAKE_API_SCRIPT = APP_FOLDER / 'tool' / 'fake_listener_api.py'
CLIP_CHECKER = APP_FOLDER / 'tool' / 'check_received_clip.py'
FINGERPRINTER_PYTHON = (REPOSITORY_FOLDER / 'services' / 'fingerprinter' / '.venv'
                        / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python'))
KEPT_APK_FOLDER = APP_FOLDER / 'build' / 'emulator-tests'
DEVELOPMENT_APK_NAME = 'listener-development-fake.apk'
PRODUCTION_APK_NAME = 'listener-production-cleartext.apk'
DEVELOPMENT_DEFINES = 'config/development-fake.json'
AVD_NAME = 'lookup_test'
EMULATOR_PORT = 5584
EMULATOR_SERIAL = f'emulator-{EMULATOR_PORT}'
FAKE_API_PORT = 3999
FAKE_API_ADDRESS = f'http://127.0.0.1:{FAKE_API_PORT}'
EMULATOR_API_ADDRESS = f'http://10.0.2.2:{FAKE_API_PORT}/api/v1'
DEVELOPMENT_PACKAGE = 'zm.lookup.listener.development'
PRODUCTION_PACKAGE = 'zm.lookup.listener'
MAIN_ACTIVITY = 'zm.lookup.listener.MainActivity'
INSTALLS_PATH = '/api/v1/installs'
RECOGNIZE_PATH = '/api/v1/recognize'
DOCKER_PROCESS_NAMES = ('com.docker.backend', 'docker desktop')
# S4-REQUEST-02: the request for an 8-second clip never goes over 32 KB (design §3.10). Its audio is at least
# 16,000 bytes: a real 8-second clip at 24,000 bit/s is about 25-27 KB, so less means the recorder sent too little.
LARGEST_RECOGNIZE_BODY_BYTES = 32_768
SMALLEST_CLIP_BYTES = 16_000
UUID_PATTERN = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', re.IGNORECASE)


Resource = TypeVar('Resource')


class StepFailed(Exception):
    """A check that did not hold. The message says what was expected and what was found."""


class RunStopped(Exception):
    """A step the rest of the run depends on failed; the run goes straight to clean-up."""


# ---- Reading a screen dump (pure) -------------------------------------------------------------------------

def normalise(text: str) -> str:
    """Collapses runs of white space (no-break spaces included) to one space."""
    return ' '.join(text.replace(' ', ' ').replace(' ', ' ').split())


@dataclass(frozen=True)
class ScreenNode:
    text: str
    content_description: str
    resource_id: str
    class_name: str
    package_name: str
    is_clickable: bool
    bounds: tuple[int, int, int, int]

    @property
    def center(self) -> tuple[int, int]:
        left, top, right, bottom = self.bounds
        return (left + right) // 2, (top + bottom) // 2

    @property
    def area(self) -> int:
        left, top, right, bottom = self.bounds
        return max(0, right - left) * max(0, bottom - top)

    @property
    def lines(self) -> list[str]:
        """The node's text and content description, whole and line by line, normalised."""
        lines: list[str] = []
        for value in (self.text, self.content_description):
            if value:
                lines.append(normalise(value))
                lines.extend(normalise(line) for line in value.splitlines() if line.strip())
        return lines

    def describe(self) -> str:
        return ' / '.join(dict.fromkeys(self.lines)) or self.resource_id or self.class_name


@dataclass(frozen=True)
class Screen:
    nodes: tuple[ScreenNode, ...]
    raw_dump: str
    problem: str | None = None


def parse_screen_dump(raw_dump: str) -> Screen:
    """Reads `uiautomator dump` output, which may carry text before and after the XML
    ("UI hierchary dumped to: /dev/tty"). A dump that holds no hierarchy, such as uiautomator's
    "ERROR: could not get idle state." while the screen keeps changing, gives a screen with a problem."""
    start = raw_dump.find('<hierarchy')
    end = raw_dump.rfind('</hierarchy>')
    if start < 0 or end < 0:
        return Screen((), raw_dump, f'the screen could not be read ({normalise(raw_dump)[:200] or "no output"})')
    try:
        root = ElementTree.fromstring(raw_dump[start:end + len('</hierarchy>')])
    except ElementTree.ParseError as error:
        return Screen((), raw_dump, f'the screen dump is not XML ({error})')
    nodes = []
    for element in root.iter('node'):
        numbers = [int(number) for number in re.findall(r'-?\d+', element.get('bounds', ''))]
        bounds = (numbers[0], numbers[1], numbers[2], numbers[3]) if len(numbers) >= 4 else (0, 0, 0, 0)
        nodes.append(ScreenNode(element.get('text', ''), element.get('content-desc', ''), element.get('resource-id', ''),
                                element.get('class', ''), element.get('package', ''),
                                element.get('clickable') == 'true', bounds))
    return Screen(tuple(nodes), raw_dump)


def find_nodes(nodes: Sequence[ScreenNode], label: str, *, package_name: str | None = None,
               exact: bool = True) -> list[ScreenNode]:
    """The nodes showing [label]: equal to their text or content description or one line of them, or, when
    not [exact], containing it. With [package_name], only that app's nodes."""
    wanted = normalise(label)
    return [node for node in nodes
            if (package_name is None or node.package_name == package_name)
            and (wanted in node.lines if exact else any(wanted in line for line in node.lines))]


def node_to_tap(matches: Sequence[ScreenNode]) -> ScreenNode:
    """Of several nodes showing one label, a clickable one, else the smallest (the most specific)."""
    clickable = [node for node in matches if node.is_clickable]
    return min(clickable or matches, key=lambda node: node.area)


def find_permission_allow_button(nodes: Sequence[ScreenNode]) -> ScreenNode | None:
    """The system dialog's allow button, by resource id first, then by its text."""
    for button_id in PERMISSION_ALLOW_BUTTON_IDS:
        for node in nodes:
            if node.resource_id.endswith(f':id/{button_id}'):
                return node
    for text in PERMISSION_ALLOW_BUTTON_TEXTS:
        for node in nodes:
            if node.package_name in PERMISSION_DIALOG_PACKAGES and text in node.lines:
                return node
    return None


def describe_screen(screen: Screen | None, package_name: str | None = None, limit: int = 15) -> str:
    if screen is None:
        return 'no screen was read'
    if screen.problem:
        return screen.problem
    descriptions = list(dict.fromkeys(node.describe() for node in screen.nodes
                                      if node.lines and (package_name is None or node.package_name == package_name)))
    if not descriptions:
        packages = sorted({node.package_name for node in screen.nodes if node.package_name})
        return f'the screen shows nothing of {package_name or "any app"} (packages on screen: {", ".join(packages)})'
    return 'the screen shows: ' + ' | '.join(descriptions[:limit])


def parse_window_size(wm_size_output: str) -> tuple[int, int] | None:
    """`wm size` prints the physical size and, when set, an override; the last one is in force."""
    sizes = re.findall(r'(\d+)x(\d+)', wm_size_output)
    return (int(sizes[-1][0]), int(sizes[-1][1])) if sizes else None


# ---- What the checks expect (pure) ------------------------------------------------------------------------

def reference_code_for_request_id(request_id: Any) -> str | None:
    """The code the Error screen shows for an API request id (S4-D9): its first 8 hex digits, upper case,
    as XXXX-XXXX; none for anything but a UUID the API accepts. Mirrors referenceCodeForRequestId."""
    if not isinstance(request_id, str) or not UUID_PATTERN.fullmatch(request_id):
        return None
    digits = request_id[:8].upper()
    return f'{digits[:4]}-{digits[4:]}'


def phone_number_display(phone_number_e164: str) -> str:
    """A Zambian number as the copy sheet shows it, `+260 97 712 3456`; any other number unchanged."""
    match = re.fullmatch(r'\+260([0-9]{2})([0-9]{3})([0-9]{4})', phone_number_e164)
    return f'+260 {match[1]} {match[2]} {match[3]}' if match else phone_number_e164


@dataclass(frozen=True)
class CardExpectation:
    """What the Result screen shows for the fake's `match` answer, read from the shared fixture it sends."""
    title: str
    client_name: str
    via_line: str
    call_label: str
    call_number_display: str

    @classmethod
    def from_fixture(cls, fixture_path: Path) -> CardExpectation:
        result = json.loads(fixture_path.read_text(encoding='utf-8'))['response']['result']
        call = next(action for action in result['card']['actions'] if action['type'] == 'CALL')
        station = result['station']
        return cls(result['title'], result['client']['name'], f"via {station['name']} · {station['frequency_label']}",
                   call['label'], phone_number_display(call['phone_number_e164']))

    @property
    def labels(self) -> list[str]:
        return [self.client_name, self.via_line, self.title, self.call_label]


def requests_to(log: dict[str, Any], path: str) -> list[dict[str, Any]]:
    """The requests the fake accepted on [path], in order."""
    return [request for request in log.get('requests', []) if request.get('path') == path and 'refused' not in request]


def refused_requests(log: dict[str, Any]) -> list[str]:
    """Every request the fake refused, with its reason: the app sent something the contract does not allow."""
    return [f"{request.get('method')} {request.get('path')}: {request['refused']}"
            for request in log.get('requests', []) if 'refused' in request]


def problems_with_sends(new_requests: Sequence[dict[str, Any]], expected_scenarios: Sequence[str]) -> list[str]:
    """Checks the recognize requests of one identify: the fake answered [expected_scenarios] in order; every
    send carried the same idempotency key (one clip) and its own request id (one per HTTP attempt, §3.8)."""
    problems = []
    scenarios = [request.get('scenario') for request in new_requests]
    if scenarios != list(expected_scenarios):
        problems.append(f'the fake answered {scenarios}, not {list(expected_scenarios)}')
    keys = {request.get('idempotency_key') for request in new_requests}
    if len(new_requests) > 1 and len(keys) != 1:
        problems.append(f'the sends of one clip carried {len(keys)} idempotency keys, not one: {sorted(map(str, keys))}')
    request_ids = [request.get('request_id') for request in new_requests]
    if len(set(request_ids)) != len(request_ids):
        problems.append('two sends carried the same request id; each HTTP attempt needs its own')
    return problems


def problems_with_request_sizes(log: dict[str, Any]) -> list[str]:
    """Checks every recognize request the fake accepted (S4-REQUEST-02; design §3.10): the whole body at most
    LARGEST_RECOGNIZE_BODY_BYTES, so "about 25 KB of data" on Home is true, and the audio at least
    SMALLEST_CLIP_BYTES, so a small body cannot pass because the recorder sent next to nothing."""
    recognize_requests = requests_to(log, RECOGNIZE_PATH)
    if not recognize_requests:
        return ['the fake received no recognize request to measure']
    problems = []
    for number, request in enumerate(recognize_requests, start=1):
        name = f"recognize request {number} ({request.get('scenario')}, request id {request.get('request_id')})"
        body_bytes, audio_bytes = request.get('body_bytes'), request.get('audio_bytes')
        if not isinstance(body_bytes, int) or body_bytes > LARGEST_RECOGNIZE_BODY_BYTES:
            problems.append(f'{name}: a body of {body_bytes} bytes, over {LARGEST_RECOGNIZE_BODY_BYTES:,}')
        if not isinstance(audio_bytes, int) or audio_bytes < SMALLEST_CLIP_BYTES:
            problems.append(f'{name}: {audio_bytes} bytes of audio, under {SMALLEST_CLIP_BYTES:,} '
                            f'(a real 8-second clip is about 25 KB)')
    return problems


def docker_process_names(process_names: Sequence[str]) -> list[str]:
    """The running processes that mean Docker Desktop is up."""
    return sorted({name for name in process_names
                   if os.path.basename(name).lower().removesuffix('.exe') in DOCKER_PROCESS_NAMES})


def process_names_from_tasklist(tasklist_csv: str) -> list[str]:
    """The image names from `tasklist /FO CSV /NH`."""
    return [row[0] for row in csv.reader(io.StringIO(tasklist_csv)) if row]


def emulator_serials(adb_devices_output: str) -> list[str]:
    """The emulators `adb devices` lists."""
    return [line.split()[0] for line in adb_devices_output.splitlines() if line.startswith('emulator-')]


# ---- Driving the app --------------------------------------------------------------------------------------

class Device(Protocol):
    def read_screen(self) -> Screen: ...
    def tap(self, x: int, y: int) -> None: ...
    def swipe(self, start: tuple[int, int], end: tuple[int, int]) -> None: ...
    def screen_size(self) -> tuple[int, int]: ...
    def launch_app(self, package_name: str) -> None: ...
    def stop_app(self, package_name: str) -> None: ...
    def save_evidence(self, name: str, screen: Screen | None) -> list[str]: ...


class FakeApiControl(Protocol):
    def queue(self, scenario_names: Sequence[str]) -> None: ...
    def request_log(self) -> dict[str, Any]: ...
    def reset(self) -> None: ...


@dataclass(frozen=True)
class Observation:
    """Whether a screen that may show only briefly was seen, and how many reads were possible."""
    is_seen: bool
    readable_count: int
    unreadable_count: int

    def describe(self) -> str:
        return 'seen' if self.is_seen else (f'not seen ({self.readable_count} screens read, '
                                            f'{self.unreadable_count} unreadable while it kept changing)')


class Driver:
    """Reads the screen, waits for labels and taps them, with polling waits. Time is injected so the steps
    can be tested without a device."""

    def __init__(self, device: Device, app_package: str, *, monotonic: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep, poll_seconds: float = 0.5,
                 settle_seconds: float = 0.8) -> None:
        self.device = device
        self.app_package = app_package
        self.monotonic = monotonic
        self.sleep = sleep
        self.poll_seconds = poll_seconds
        self.settle_seconds = settle_seconds
        self.last_screen: Screen | None = None
        self.taps: list[str] = []

    def read_screen(self) -> Screen:
        self.last_screen = self.device.read_screen()
        return self.last_screen

    def pause(self, seconds: float) -> None:
        self.sleep(seconds)

    def wait_for_any(self, labels: Sequence[str], timeout_seconds: float) -> tuple[str, ScreenNode]:
        """Waits until the app shows one of [labels]; returns the label and its node."""
        deadline = self.monotonic() + timeout_seconds
        while True:
            screen = self.read_screen()
            for label in labels:
                matches = find_nodes(screen.nodes, label, package_name=self.app_package)
                if matches:
                    return label, node_to_tap(matches)
            if self.monotonic() >= deadline:
                wanted = ' or '.join(repr(label) for label in labels)
                raise StepFailed(f'waited {timeout_seconds:g} s for {wanted}; '
                                 f'{describe_screen(screen, self.app_package)}')
            self.sleep(self.poll_seconds)

    def wait_for(self, label: str, timeout_seconds: float) -> ScreenNode:
        return self.wait_for_any([label], timeout_seconds)[1]

    def tap_node(self, node: ScreenNode, label: str) -> None:
        self.device.tap(*node.center)
        self.taps.append(label)
        self.sleep(self.settle_seconds)

    def tap(self, labels: str | Sequence[str], timeout_seconds: float = 10.0) -> None:
        """Waits for one of [labels] and taps it."""
        label, node = self.wait_for_any([labels] if isinstance(labels, str) else labels, timeout_seconds)
        self.tap_node(node, label)

    def scroll(self, *, towards_end: bool) -> None:
        width, height = self.device.screen_size()
        lower, upper = (width // 2, int(height * 0.75)), (width // 2, int(height * 0.35))
        self.device.swipe(*((lower, upper) if towards_end else (upper, lower)))
        self.sleep(self.settle_seconds)

    def find_scrolling(self, label: str, *, swipes: int = 3) -> ScreenNode:
        """The node showing [label]. When it is not in view, scrolls towards the end, then back past the start
        (a header's Back button is out of view once the list below it has been scrolled)."""
        for towards_end in [None, *([True] * swipes), *([False] * (2 * swipes))]:
            if towards_end is not None:
                self.scroll(towards_end=towards_end)
            matches = find_nodes(self.read_screen().nodes, label, package_name=self.app_package)
            if matches:
                return node_to_tap(matches)
        raise StepFailed(f'{label!r} is not on the screen, even after scrolling; '
                         f'{describe_screen(self.last_screen, self.app_package)}')

    def tap_scrolling(self, label: str) -> None:
        self.tap_node(self.find_scrolling(label), label)

    def expect_all(self, labels: Sequence[str], *, swipes: int = 3) -> None:
        """Checks the app shows every one of [labels], scrolling when some are out of view, then scrolls back."""
        missing = list(labels)
        swipe_count = 0
        while True:
            screen = self.read_screen()
            missing = [label for label in missing if not find_nodes(screen.nodes, label, package_name=self.app_package)]
            if not missing or swipe_count == swipes:
                break
            self.scroll(towards_end=True)
            swipe_count += 1
        for _ in range(swipe_count):
            self.scroll(towards_end=False)
        if missing:
            raise StepFailed(f'the screen does not show {missing}; {describe_screen(screen, self.app_package)}')

    def allow_microphone_in_system_dialog(self, timeout_seconds: float) -> str:
        """Taps the allow button of Android's own permission dialog; returns what it said."""
        deadline = self.monotonic() + timeout_seconds
        while True:
            button = find_permission_allow_button(self.read_screen().nodes)
            if button is not None:
                self.tap_node(button, f'system dialog: {button.describe()}')
                return button.describe()
            if self.monotonic() >= deadline:
                raise StepFailed(f'the system permission dialog did not appear within {timeout_seconds:g} s; '
                                 f'{describe_screen(self.last_screen)}')
            self.sleep(self.poll_seconds)

    def observe(self, label: str, timeout_seconds: float) -> Observation:
        """Looks for a screen that may show only briefly, or that uiautomator cannot read while it animates."""
        deadline = self.monotonic() + timeout_seconds
        readable_count = unreadable_count = 0
        while True:
            screen = self.read_screen()
            if screen.problem:
                unreadable_count += 1
            else:
                readable_count += 1
                if find_nodes(screen.nodes, label, package_name=self.app_package):
                    return Observation(True, readable_count, unreadable_count)
            if self.monotonic() >= deadline:
                return Observation(False, readable_count, unreadable_count)
            self.sleep(self.poll_seconds)

    def wait_until(self, condition: Callable[[], Any], timeout_seconds: float, description: str) -> Any:
        """Polls [condition] until it returns something truthy, and returns that."""
        deadline = self.monotonic() + timeout_seconds
        while True:
            value = condition()
            if value:
                return value
            if self.monotonic() >= deadline:
                raise StepFailed(f'waited {timeout_seconds:g} s for {description}')
            self.sleep(self.poll_seconds)


# ---- The journeys (§4.7 step 3) ---------------------------------------------------------------------------

IDENTIFY_LABELS = (LABELS['identify control'], LABELS['identify control text'])
SECONDS_FOR_AN_IDENTIFY = 45   # 8 s of recording, the upload, and a slow emulator


@dataclass
class RunContext:
    driver: Driver
    device: Device
    fake_api: FakeApiControl
    card: CardExpectation
    app_package: str = DEVELOPMENT_PACKAGE

    def recognize_count(self) -> int:
        return len(requests_to(self.fake_api.request_log(), RECOGNIZE_PATH))

    def recognize_requests_since(self, count_before: int) -> list[dict[str, Any]]:
        return requests_to(self.fake_api.request_log(), RECOGNIZE_PATH)[count_before:]

    def back_home_from(self, label: str) -> None:
        self.driver.tap_scrolling(label)
        self.driver.wait_for(LABELS['home heading'], 15)


def check_sends(context: RunContext, count_before: int, expected_scenarios: Sequence[str]) -> list[dict[str, Any]]:
    new_requests = context.recognize_requests_since(count_before)
    problems = problems_with_sends(new_requests, expected_scenarios)
    if problems:
        raise StepFailed('; '.join(problems))
    return new_requests


def first_launch_registers_once(context: RunContext) -> str:
    context.device.launch_app(context.app_package)
    context.driver.wait_for(LABELS['home heading'], 40)
    context.driver.wait_until(lambda: requests_to(context.fake_api.request_log(), INSTALLS_PATH), 20,
                              'the app to register (POST /api/v1/installs)')
    context.driver.pause(3)   # a second registration would arrive by now
    installs = requests_to(context.fake_api.request_log(), INSTALLS_PATH)
    if len(installs) != 1:
        raise StepFailed(f'the first launch made {len(installs)} /installs calls, not one')
    return f"one /installs call (request id {installs[0].get('request_id')})"


def identify_after_allowing_microphone(context: RunContext) -> str:
    driver, card = context.driver, context.card
    count_before = context.recognize_count()
    context.fake_api.queue(['match'])
    driver.tap(IDENTIFY_LABELS)
    driver.wait_for(LABELS['permission heading'], 15)
    driver.tap(LABELS['allow microphone'])
    allowed_with = driver.allow_microphone_in_system_dialog(15)
    listening = driver.observe(LABELS['listening heading'], 6)
    if not listening.is_seen and listening.unreadable_count == 0:
        raise StepFailed(f'Listening never showed after the microphone was allowed; '
                         f'{describe_screen(driver.last_screen, context.app_package)}')
    driver.wait_for(LABELS['result header'], SECONDS_FOR_AN_IDENTIFY)
    driver.expect_all(card.labels)
    check_sends(context, count_before, ['match'])
    # The image has no dialler, so opening tel: fails and the copy sheet must offer the number (S4-D19).
    driver.tap_scrolling(card.call_label)
    driver.wait_for(LABELS['copy sheet heading'], 15)
    driver.expect_all([card.call_number_display, LABELS['copy number']], swipes=0)
    driver.tap(LABELS['copy sheet close'])
    context.back_home_from(LABELS['result back'])
    return (f'allowed with "{allowed_with}"; Listening {listening.describe()}; Result showed '
            f'"{card.title}"; the copy sheet showed {card.call_number_display}')


def identify_with_no_match(context: RunContext) -> str:
    count_before = context.recognize_count()
    context.fake_api.queue(['no-match'])
    context.driver.tap(IDENTIFY_LABELS)
    context.driver.wait_for(LABELS['no match heading'], SECONDS_FOR_AN_IDENTIFY)
    check_sends(context, count_before, ['no-match'])
    context.back_home_from(LABELS['back to home'])
    return 'No match shown'


def identify_when_busy(context: RunContext) -> str:
    count_before = context.recognize_count()
    context.fake_api.queue(['busy', 'match'])
    context.driver.tap(IDENTIFY_LABELS)
    # The fake's busy answer says Retry-After 6 s, so Busy stays on screen across two or more reads (a uiautomator
    # read takes about 2-3 s, then the driver waits poll_seconds): it must be seen, not only inferred from the log.
    first_seen, _ = context.driver.wait_for_any([LABELS['busy heading'], LABELS['result header']],
                                                SECONDS_FOR_AN_IDENTIFY)
    if first_seen != LABELS['busy heading']:
        raise StepFailed(f'Busy never showed: the app reached Result first, though the fake answered busy with '
                         f'Retry-After {BUSY_RETRY_AFTER_SECONDS} s; '
                         f'{describe_screen(context.driver.last_screen, context.app_package)}')
    context.driver.wait_for(LABELS['result header'], 30)
    sends = check_sends(context, count_before, ['busy', 'match'])
    context.back_home_from(LABELS['result back'])
    return f"Busy seen; both sends carried idempotency key {sends[0].get('idempotency_key')}"


def identify_with_server_error(context: RunContext) -> str:
    count_before = context.recognize_count()
    context.fake_api.queue(['error'])
    context.driver.tap(IDENTIFY_LABELS)
    context.driver.wait_for(LABELS['error heading'], SECONDS_FOR_AN_IDENTIFY)
    sends = check_sends(context, count_before, ['error'])
    code = reference_code_for_request_id(sends[0].get('request_id'))
    if code is None:
        raise StepFailed(f"the fake echoed {sends[0].get('request_id')!r}, which gives no reference code")
    context.driver.expect_all([LABELS['reference code label'], code])
    context.back_home_from(LABELS['back to home'])
    return f"reference code {code} from request id {sends[0].get('request_id')}"


def identify_with_dropped_connection(context: RunContext) -> str:
    count_before = context.recognize_count()
    context.fake_api.queue(['drop', 'match'])
    context.driver.tap(IDENTIFY_LABELS)
    context.driver.wait_for(LABELS['no connection heading'], SECONDS_FOR_AN_IDENTIFY)
    context.driver.tap_scrolling(LABELS['send again'])
    context.driver.wait_for(LABELS['result header'], 30)
    sends = check_sends(context, count_before, ['drop', 'match'])
    context.back_home_from(LABELS['result back'])
    return f"the clip was sent again with idempotency key {sends[0].get('idempotency_key')}"


def send_test_error(context: RunContext) -> str:
    def reports() -> list[dict[str, Any]]:
        return list(context.fake_api.request_log().get('client_error_reports', []))

    count_before = len(reports())
    context.driver.tap(LABELS['send test error'])
    context.driver.wait_until(lambda: len(reports()) > count_before, 20, 'a report at /api/v1/client-errors')
    context.driver.pause(3)   # a second report would arrive by now
    new_reports = reports()[count_before:]
    if len(new_reports) != 1:
        raise StepFailed(f'the test error sent {len(new_reports)} reports, not one')
    report = new_reports[0]
    if report.get('source') != 'listener-app' or not UUID_PATTERN.fullmatch(str(report.get('request_id'))):
        raise StepFailed(f"the report's source is {report.get('source')!r} and its request id "
                         f"{report.get('request_id')!r}")
    context.driver.wait_for(LABELS['home heading'], 10)
    return (f"one report, kind {report.get('kind')}, request id {report.get('request_id')} "
            f"(reference code {reference_code_for_request_id(report.get('request_id'))})")


def restart_makes_no_new_registration(context: RunContext) -> str:
    count_before = len(requests_to(context.fake_api.request_log(), INSTALLS_PATH))
    context.device.stop_app(context.app_package)
    context.device.launch_app(context.app_package)
    context.driver.wait_for(LABELS['home heading'], 40)
    context.driver.pause(5)   # a registration would arrive by now
    count_after = len(requests_to(context.fake_api.request_log(), INSTALLS_PATH))
    if count_after != count_before:
        raise StepFailed(f'the restart made {count_after - count_before} new /installs calls')
    return f'still {count_after} /installs call after the restart'


JOURNEYS: list[tuple[str, Callable[[RunContext], str]]] = [
    ('first launch registers once', first_launch_registers_once),
    ('Home, Permission, system dialog, Listening, Result; the call button offers the copy sheet',
     identify_after_allowing_microphone),
    ('no match', identify_with_no_match),
    ('busy, then the automatic retry reaches Result with one idempotency key', identify_when_busy),
    ("a server error shows the reference code of the fake's echoed request id", identify_with_server_error),
    ('a dropped connection shows No connection; "Send again" reaches Result', identify_with_dropped_connection),
    ('"Send a test error" sends one report to /client-errors', send_test_error),
    ('a restart of the installed app makes no new /installs call', restart_makes_no_new_registration),
]


@dataclass
class StepOutcome:
    name: str
    is_passed: bool
    detail: str
    seconds: float
    evidence: list[str] = field(default_factory=list)
    taps: list[str] = field(default_factory=list)


def slug(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:60]


def recover_to_home(context: RunContext) -> None:
    """After a failed journey: restart the app, so the next journey starts at Home."""
    context.device.stop_app(context.app_package)
    context.device.launch_app(context.app_package)
    context.driver.wait_for(LABELS['home heading'], 40)


def run_journeys(context: RunContext, journeys: Sequence[tuple[str, Callable[[RunContext], str]]],
                 *, first_number: int = 1, monotonic: Callable[[], float] = time.monotonic) -> list[StepOutcome]:
    """Runs each journey; a failure saves the screen, restarts the app and goes on with the next one. A request
    the fake refused fails the journey that made it, because the app broke the contract."""
    outcomes: list[StepOutcome] = []
    for index, (name, journey) in enumerate(journeys):
        started = monotonic()
        context.driver.taps = []
        log_before = context.fake_api.request_log()
        refused_before = len(refused_requests(log_before))
        try:
            detail = journey(context)
            refused = refused_requests(context.fake_api.request_log())[refused_before:]
            if refused:
                raise StepFailed('the fake API refused what the app sent: ' + '; '.join(refused))
            outcomes.append(StepOutcome(name, True, detail, monotonic() - started, taps=context.driver.taps))
            print(f'PASS  {name}: {detail}', flush=True)
        except Exception as error:   # any failure of one journey is recorded, then the next one runs
            detail = str(error) if isinstance(error, StepFailed) else f'{type(error).__name__}: {error}'
            try:
                detail += f'. The fake API saw: {what_the_fake_saw(log_before, context.fake_api.request_log())}'
            except Exception:   # the fake may be the thing that failed; the failure itself is what matters
                pass
            evidence = save_evidence_quietly(context.device, f'{first_number + index:02d}-{slug(name)}',
                                             context.driver.last_screen)
            outcomes.append(StepOutcome(name, False, detail, monotonic() - started, evidence, context.driver.taps))
            print(f'FAIL  {name}: {detail}', flush=True)
            try:
                recover_to_home(context)
            except Exception as recovery_error:
                for remaining_name, _ in journeys[index + 1:]:
                    outcomes.append(StepOutcome(remaining_name, False,
                                                f'not run: the app could not be brought back to Home ({recovery_error})', 0))
                break
    return outcomes


def what_the_fake_saw(log_before: dict[str, Any], log_after: dict[str, Any]) -> str:
    """The requests and crash reports the fake received during one journey, in a line: what the app sent,
    the scenario each recognize met, why any request was refused, and each report's kind and message."""
    requests = log_after.get('requests', [])[len(log_before.get('requests', [])):]
    reports = log_after.get('client_error_reports', [])[len(log_before.get('client_error_reports', [])):]
    parts = []
    for request in requests:
        outcome = f"refused: {request['refused']}" if 'refused' in request else request.get('scenario', 'answered')
        parts.append(f"{request.get('method')} {request.get('path')} ({outcome})")
    for report in reports:
        parts.append(f"crash report {report.get('kind')}: {str(report.get('message', ''))[:160]}")
    return '; '.join(parts) if parts else 'nothing'


def save_evidence_quietly(device: Device, name: str, screen: Screen | None) -> list[str]:
    try:
        return device.save_evidence(name, screen)
    except Exception as error:   # evidence is a help, never a reason to lose the run record
        return [f'(no evidence saved: {type(error).__name__}: {error})']


# ---- The device, the fake API and the processes -----------------------------------------------------------

class AdbDevice:
    """The emulator, through adb."""

    def __init__(self, adb_path: str, serial: str, evidence_folder: Path) -> None:
        self.adb_path = adb_path
        self.serial = serial
        self.evidence_folder = evidence_folder
        self._screen_size: tuple[int, int] | None = None

    def adb(self, *arguments: str, timeout_seconds: float = 60, check: bool = True) -> str:
        try:
            completed = subprocess.run([self.adb_path, '-s', self.serial, *arguments], capture_output=True, text=True,
                                       encoding='utf-8', errors='replace', timeout=timeout_seconds)
        except subprocess.TimeoutExpired as error:
            raise StepFailed(f'adb {" ".join(arguments)} did not finish within {timeout_seconds:g} s') from error
        if check and completed.returncode != 0:
            raise StepFailed(f'adb {" ".join(arguments)} failed: {(completed.stderr or completed.stdout).strip()[:300]}')
        return completed.stdout

    def read_screen(self) -> Screen:
        dump_file = '/sdcard/lookup_window_dump.xml'
        try:
            output = self.adb('exec-out', 'uiautomator', 'dump', '/dev/tty', timeout_seconds=40, check=False)
            screen = parse_screen_dump(output)
            if screen.problem and 'idle' not in output.lower():
                # An image that cannot dump to /dev/tty: dump to a fresh file and read it back.
                self.adb('shell', 'rm', '-f', dump_file, check=False)
                self.adb('shell', 'uiautomator', 'dump', dump_file, timeout_seconds=40, check=False)
                screen = parse_screen_dump(self.adb('exec-out', 'cat', dump_file, check=False))
            return screen
        except StepFailed as failure:
            return Screen((), '', str(failure))

    def tap(self, x: int, y: int) -> None:
        self.adb('shell', 'input', 'tap', str(x), str(y))

    def swipe(self, start: tuple[int, int], end: tuple[int, int]) -> None:
        self.adb('shell', 'input', 'swipe', str(start[0]), str(start[1]), str(end[0]), str(end[1]), '300')

    def screen_size(self) -> tuple[int, int]:
        """The window size in pixels, read once and kept: `wm size` is slow, and the size rarely changes."""
        if self._screen_size is None:
            self._screen_size = parse_window_size(self.adb('shell', 'wm', 'size')) or (1080, 1920)
        return self._screen_size

    def forget_screen_size(self) -> None:
        """Forgets the kept window size, so the next screen_size() reads it again: call it after `wm size` or
        `wm density` changed the screen."""
        self._screen_size = None

    def launch_app(self, package_name: str) -> None:
        output = self.adb('shell', 'am', 'start', '-W', '-n', f'{package_name}/{MAIN_ACTIVITY}')
        if 'Error' in output:
            raise StepFailed(f'the app {package_name} did not start: {output.strip()[:300]}')

    def stop_app(self, package_name: str) -> None:
        self.adb('shell', 'am', 'force-stop', package_name)

    def install(self, apk_path: Path) -> None:
        output = ''
        for _ in range(3):   # the package manager can refuse for a moment right after boot
            output = self.adb('install', '-r', str(apk_path), timeout_seconds=300, check=False)
            if 'Success' in output:
                return
            time.sleep(5)
        raise StepFailed(f'adb install {apk_path.name} failed: {output.strip()[:300]}')

    def property(self, name: str) -> str:
        return self.adb('shell', 'getprop', name, check=False).strip()

    def save_evidence(self, name: str, screen: Screen | None) -> list[str]:
        self.evidence_folder.mkdir(parents=True, exist_ok=True)
        dump_path = self.evidence_folder / f'{name}.xml'
        dump_path.write_text((screen or self.read_screen()).raw_dump or '(empty dump)', encoding='utf-8')
        screenshot_path = self.evidence_folder / f'{name}.png'
        with screenshot_path.open('wb') as screenshot:
            subprocess.run([self.adb_path, '-s', self.serial, 'exec-out', 'screencap', '-p'], stdout=screenshot,
                           stderr=subprocess.DEVNULL, timeout=40, check=False)
        return [str(dump_path), str(screenshot_path)]


class HttpFakeApi:
    """The fake API's control routes (tool/fake_listener_api.py)."""

    def __init__(self, base_address: str) -> None:
        self.base_address = base_address
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # never through a proxy

    def send(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode('utf-8')
        request = urllib.request.Request(self.base_address + path, data=data, method=method,
                                         headers={'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=10) as response:
                return json.loads(response.read() or b'null')
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise StepFailed(f'the fake API did not answer {method} {path}: {error}') from error

    def queue(self, scenario_names: Sequence[str]) -> None:
        self.send('POST', '/__fake/scenarios', list(scenario_names))

    def request_log(self) -> dict[str, Any]:
        return self.send('GET', '/__fake/requests')

    def reset(self) -> None:
        self.send('POST', '/__fake/reset', {})


@dataclass
class StartedProcess:
    process: subprocess.Popen[bytes]
    log_file: IO[str]


@dataclass(frozen=True)
class Tools:
    adb: str
    emulator: str
    flutter: str


def android_sdk_folder() -> Path:
    for variable in ('ANDROID_HOME', 'ANDROID_SDK_ROOT'):
        if os.environ.get(variable):
            return Path(os.environ[variable])
    return Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'Android' / 'Sdk'


def find_tools() -> Tools:
    suffix = '.exe' if os.name == 'nt' else ''
    sdk = android_sdk_folder()

    def in_sdk_or_on_path(relative_path: str, name: str) -> str | None:
        path = sdk / relative_path / f'{name}{suffix}'
        return str(path) if path.exists() else shutil.which(name)

    adb = os.environ.get('ADB') or in_sdk_or_on_path('platform-tools', 'adb')
    emulator = in_sdk_or_on_path('emulator', 'emulator')
    flutter = shutil.which('flutter')
    if adb is None or emulator is None or flutter is None:
        missing = [name for name, path in (('adb', adb), ('emulator', emulator), ('flutter', flutter)) if path is None]
        raise StepFailed(f'cannot find {", ".join(missing)}: install the Android SDK tools or set ANDROID_HOME, '
                         'and put Flutter on the PATH')
    return Tools(adb, emulator, flutter)


def running_process_names() -> list[str]:
    if os.name == 'nt':
        output = subprocess.run(['tasklist', '/FO', 'CSV', '/NH'], capture_output=True, text=True, errors='replace',
                                timeout=30).stdout
        return process_names_from_tasklist(output)
    output = subprocess.run(['ps', '-A', '-o', 'comm='], capture_output=True, text=True, errors='replace',
                            timeout=30).stdout
    return [line.strip() for line in output.splitlines() if line.strip()]


def reasons_not_to_start(tools: Tools) -> list[str]:
    """Docker running, another emulator running, or the fake's port taken (S4-TESTS-07, S4-D29)."""
    reasons = []
    docker = shutil.which('docker')
    if docker:
        try:
            if subprocess.run([docker, 'info'], capture_output=True, timeout=20).returncode == 0:
                reasons.append('Docker is running (docker info answered): close Docker Desktop')
        except subprocess.TimeoutExpired:
            reasons.append('docker info did not answer within 20 s, so Docker Desktop may be starting: close it')
    for name in docker_process_names(running_process_names()):
        reasons.append(f'the process {name} is running: close Docker Desktop')
    devices = subprocess.run([tools.adb, 'devices'], capture_output=True, text=True, errors='replace', timeout=60).stdout
    for serial in emulator_serials(devices):
        reasons.append(f'an emulator is already running ({serial}): close it')
    try:
        with socket.create_connection(('127.0.0.1', FAKE_API_PORT), timeout=1):
            reasons.append(f'something already listens on 127.0.0.1:{FAKE_API_PORT} (an earlier fake API?): stop it')
    except OSError:
        pass
    return reasons


def build_apk(tools: Tools, flavour: str, define_file: str, kept_name: str, log_path: Path) -> Path:
    command = [tools.flutter, 'build', 'apk', '--release', '--no-pub', '--flavor', flavour,
               '--target-platform', 'android-x64', f'--dart-define-from-file={define_file}']
    print(f'      building the {flavour} APK (log: {log_path})', flush=True)
    started = time.time()
    with log_path.open('w', encoding='utf-8', errors='replace') as log:
        completed = subprocess.run(command, cwd=APP_FOLDER, stdout=log, stderr=subprocess.STDOUT, timeout=3600)
    if completed.returncode != 0:
        tail = '\n'.join(log_path.read_text(encoding='utf-8', errors='replace').splitlines()[-25:])
        raise StepFailed(f'flutter build apk --flavor {flavour} failed with exit code {completed.returncode}:\n{tail}')
    built = APP_FOLDER / 'build' / 'app' / 'outputs' / 'flutter-apk' / f'app-{flavour}-release.apk'
    if not built.exists() or built.stat().st_mtime < started - 1:
        raise StepFailed(f'the build reported success but did not write {built}')
    KEPT_APK_FOLDER.mkdir(parents=True, exist_ok=True)
    kept = KEPT_APK_FOLDER / kept_name
    shutil.copy2(built, kept)
    return kept


def production_cleartext_defines() -> dict[str, str]:
    """The production APK's defines (S4-SECURITY-02): a build that is right in every way but its plain http
    address, so the set-up screen it must show can only be the http refusal. The support number is the
    development fake's own: staging and production refuse to start without one (S4-D32)."""
    development = json.loads((APP_FOLDER / DEVELOPMENT_DEFINES).read_text(encoding='utf-8'))
    return {'LOOKUP_FLAVOUR': 'production',
            'LOOKUP_API_BASE_URL': EMULATOR_API_ADDRESS,
            'LOOKUP_SUPPORT_WHATSAPP_NUMBER': development['LOOKUP_SUPPORT_WHATSAPP_NUMBER']}


def build_apks(tools: Tools, temporary_folder: Path, skip_build: bool) -> dict[str, Path]:
    kept = {'development': KEPT_APK_FOLDER / DEVELOPMENT_APK_NAME, 'production': KEPT_APK_FOLDER / PRODUCTION_APK_NAME}
    if skip_build:
        missing = [str(path) for path in kept.values() if not path.exists()]
        if missing:
            raise StepFailed(f'--skip-build needs the APKs of an earlier build: {", ".join(missing)} missing')
        return kept
    production_defines = temporary_folder / 'production-cleartext.json'
    production_defines.write_text(json.dumps(production_cleartext_defines(), indent=2), encoding='utf-8')
    return {
        'development': build_apk(tools, 'development', DEVELOPMENT_DEFINES, DEVELOPMENT_APK_NAME,
                                 temporary_folder / 'build-development.log'),
        'production': build_apk(tools, 'production', str(production_defines), PRODUCTION_APK_NAME,
                                temporary_folder / 'build-production.log'),
    }


def start_fake_api(temporary_folder: Path, clip_path: Path) -> tuple[StartedProcess, HttpFakeApi]:
    log_file = (temporary_folder / 'fake-api.log').open('w', encoding='utf-8', errors='replace')
    process = subprocess.Popen([sys.executable, str(FAKE_API_SCRIPT), '--port', str(FAKE_API_PORT),
                                '--save-audio-to', str(clip_path)], cwd=APP_FOLDER, stdout=log_file,
                               stderr=subprocess.STDOUT)
    started = StartedProcess(process, log_file)
    fake_api = HttpFakeApi(FAKE_API_ADDRESS)
    deadline = time.monotonic() + 15
    while True:
        if process.poll() is not None:
            raise StepFailed(f'the fake API stopped at once (exit code {process.returncode}); see fake-api.log')
        try:
            fake_api.request_log()
            return started, fake_api
        except StepFailed:
            if time.monotonic() > deadline:
                raise StepFailed('the fake API did not answer within 15 s; see fake-api.log') from None
            time.sleep(0.3)


def start_emulator(tools: Tools, temporary_folder: Path) -> StartedProcess:
    log_file = (temporary_folder / 'emulator.log').open('w', encoding='utf-8', errors='replace')
    # Audio stays on (no -no-audio), so the recorder has an input.
    command = [tools.emulator, '-avd', AVD_NAME, '-port', str(EMULATOR_PORT), '-no-window', '-no-snapshot-save',
               '-no-boot-anim']
    return StartedProcess(subprocess.Popen(command, stdout=log_file, stderr=subprocess.STDOUT), log_file)


def wait_for_boot(device: AdbDevice, emulator: StartedProcess, timeout_seconds: float = 420) -> str:
    started = time.monotonic()
    while True:
        if emulator.process.poll() is not None:
            raise StepFailed(f'the emulator stopped while booting (exit code {emulator.process.returncode}); '
                             f'see emulator.log')
        try:
            if device.adb('shell', 'getprop', 'sys.boot_completed', timeout_seconds=15, check=False).strip() == '1' \
                    and 'package:' in device.adb('shell', 'pm', 'path', 'android', timeout_seconds=15, check=False):
                return f'booted in {time.monotonic() - started:.0f} s'
        except StepFailed:
            pass
        if time.monotonic() - started > timeout_seconds:
            raise StepFailed(f'the emulator did not finish booting within {timeout_seconds:g} s')
        time.sleep(3)


def prepare_device(device: AdbDevice) -> dict[str, Any]:
    """Animations off (Flutter then sets disableAnimations, and uiautomator can read the screens), screen awake
    and unlocked; refuses an image with Google Play services (S4-COMPATIBILITY-01)."""
    for setting in ('window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'):
        device.adb('shell', 'settings', 'put', 'global', setting, '0')
    device.adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP', check=False)
    device.adb('shell', 'wm', 'dismiss-keyguard', check=False)
    device.adb('shell', 'svc', 'power', 'stayon', 'true', check=False)
    has_play_services = 'package:com.google.android.gms' in device.adb('shell', 'pm', 'list', 'packages',
                                                                       'com.google.android.gms', check=False)
    avd_lines = device.adb('emu', 'avd', 'name', check=False).splitlines()
    description = {
        'serial': device.serial,
        'avd': avd_lines[0].strip() if avd_lines else '',
        'model': device.property('ro.product.model'),
        'product': device.property('ro.product.name'),
        'android_version': device.property('ro.build.version.release'),
        'sdk': device.property('ro.build.version.sdk'),
        'abi': device.property('ro.product.cpu.abi'),
        'image': device.property('ro.build.fingerprint'),
        'screen_size': device.screen_size(),
        'has_google_play_services': has_play_services,
        'animations': 'off',
    }
    if has_play_services:
        raise StepFailed('this image has Google Play services; the run must use the lookup_test aosp_atd image '
                         'without them (S4-COMPATIBILITY-01)')
    return description


def install_fresh(device: AdbDevice, apk_path: Path) -> str:
    for package_name in (DEVELOPMENT_PACKAGE, PRODUCTION_PACKAGE):
        device.adb('uninstall', package_name, check=False)
    device.install(apk_path)   # no -g: the permission prompt must appear
    return f'{apk_path.name} installed with no permission granted'


def check_recognize_request_sizes(fake_api: FakeApiControl) -> str:
    """S4-REQUEST-02 on the emulator: every recognize request of the journeys, measured by the fake."""
    log = fake_api.request_log()
    problems = problems_with_request_sizes(log)
    if problems:
        raise StepFailed('; '.join(problems))
    requests = requests_to(log, RECOGNIZE_PATH)
    bodies = [request['body_bytes'] for request in requests]
    clips = [request['audio_bytes'] for request in requests]
    return (f'{len(requests)} recognize requests: bodies {min(bodies):,}-{max(bodies):,} bytes (at most '
            f'{LARGEST_RECOGNIZE_BODY_BYTES:,}), audio {min(clips):,}-{max(clips):,} bytes (at least '
            f'{SMALLEST_CLIP_BYTES:,})')


def check_received_clip(clip_path: Path) -> str:
    if not clip_path.exists():
        raise StepFailed('the fake API saved no clip: no recognize request reached it')
    if not FINGERPRINTER_PYTHON.exists():
        raise StepFailed(f"{FINGERPRINTER_PYTHON} is missing: the clip check runs on the fingerprinter's Python (PyAV)")
    completed = subprocess.run([str(FINGERPRINTER_PYTHON), str(CLIP_CHECKER), str(clip_path)], capture_output=True,
                               text=True, errors='replace', timeout=180)
    output = (completed.stdout + completed.stderr).strip()
    if completed.returncode != 0:
        raise StepFailed(output or f'the clip check failed with exit code {completed.returncode}')
    return output


def production_build_refuses_cleartext(device: AdbDevice, fake_api: HttpFakeApi, apk_path: Path,
                                       driver: Driver) -> str:
    fake_api.reset()
    device.install(apk_path)
    device.launch_app(PRODUCTION_PACKAGE)
    driver.wait_for(LABELS['set-up problem'], 40)
    driver.pause(5)   # a request would arrive by now
    log = fake_api.request_log()
    sent = len(log.get('requests', [])) + len(log.get('client_error_reports', []))
    if sent:
        raise StepFailed(f'the production build sent {sent} requests to {EMULATOR_API_ADDRESS}')
    return 'the set-up problem screen showed and the fake received nothing (S4-SECURITY-02)'


def stop_process(started: StartedProcess | None, timeout_seconds: float) -> None:
    if started is None:
        return
    try:
        started.process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        started.process.terminate()
        try:
            started.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            started.process.kill()
    finally:
        started.log_file.close()


# ---- The run record ---------------------------------------------------------------------------------------

class RunRecord:
    def __init__(self, temporary_folder: Path) -> None:
        self.temporary_folder = temporary_folder
        self.started_at = datetime.now(timezone.utc)
        self.device: dict[str, Any] = {}
        self.apks: dict[str, str] = {}
        self.steps: list[StepOutcome] = []

    @property
    def path(self) -> Path:
        return self.temporary_folder.parent / f'{self.temporary_folder.name}-record.json'

    @property
    def is_passed(self) -> bool:
        return bool(self.steps) and all(step.is_passed for step in self.steps)

    def step(self, name: str, action: Callable[[], str], *, is_required: bool, device: AdbDevice | None = None,
             driver: Driver | None = None) -> bool:
        """Runs one step and records it; a failed required step stops the run."""
        started = time.monotonic()
        try:
            detail = action()
        except Exception as error:   # every failure is recorded with what it said
            detail = str(error) if isinstance(error, StepFailed) else f'{type(error).__name__}: {error}'
            evidence = (save_evidence_quietly(device, f'{len(self.steps) + 1:02d}-{slug(name)}',
                                              driver.last_screen if driver else None) if device else [])
            self.steps.append(StepOutcome(name, False, detail, time.monotonic() - started, evidence))
            print(f'FAIL  {name}: {detail}', flush=True)
            if is_required:
                raise RunStopped(name) from error
            return False
        self.steps.append(StepOutcome(name, True, detail, time.monotonic() - started))
        print(f'PASS  {name}: {detail}', flush=True)
        return True

    def write(self) -> None:
        record = {
            'outcome': 'passed' if self.is_passed else 'failed',
            'started_at': self.started_at.isoformat(timespec='seconds'),
            'finished_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'device': self.device,
            'image': self.device.get('image', ''),
            'apks': self.apks,
            'temporary_folder': str(self.temporary_folder),
            'steps': [asdict(step) for step in self.steps],
        }
        self.path.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding='utf-8')


# ---- The run ----------------------------------------------------------------------------------------------

@dataclass
class RunResources:
    """What the run started, so clean-up stops exactly that."""
    apks: dict[str, Path] = field(default_factory=dict)
    fake: StartedProcess | None = None
    fake_api: HttpFakeApi | None = None
    emulator: StartedProcess | None = None
    device: AdbDevice | None = None


def run(tools: Tools, record: RunRecord, skip_build: bool) -> None:
    temporary_folder = record.temporary_folder
    clip_path = temporary_folder / 'clip.m4a'
    resources = RunResources()

    def build() -> str:
        resources.apks.update(build_apks(tools, temporary_folder, skip_build))
        record.apks = {flavour: str(path) for flavour, path in resources.apks.items()}
        return ', '.join(f'{flavour}: {path}' for flavour, path in resources.apks.items())

    def start_fake() -> str:
        resources.fake, resources.fake_api = start_fake_api(temporary_folder, clip_path)
        return f'listening on {FAKE_API_ADDRESS}'

    def boot() -> str:
        resources.emulator = start_emulator(tools, temporary_folder)
        resources.device = AdbDevice(tools.adb, EMULATOR_SERIAL, temporary_folder / 'evidence')
        return wait_for_boot(resources.device, resources.emulator)

    def prepare() -> str:
        record.device = prepare_device(require(resources.device))
        return f"{record.device['model']}, Android {record.device['android_version']}, {record.device['image']}"

    try:
        record.step('build the release APKs' + (' (reused)' if skip_build else ''), build, is_required=True)
        record.step('start the fake API', start_fake, is_required=True)
        record.step(f'start the {AVD_NAME} virtual device', boot, is_required=True)
        device, fake_api = require(resources.device), require(resources.fake_api)
        record.step('prepare the device', prepare, is_required=True)
        record.step('install the development APK', lambda: install_fresh(device, resources.apks['development']),
                    is_required=True)
        context = RunContext(Driver(device, DEVELOPMENT_PACKAGE), device, fake_api,
                             CardExpectation.from_fixture(MATCH_FIXTURE))
        record.steps.extend(run_journeys(context, JOURNEYS, first_number=len(record.steps) + 1))
        record.step('every recognize request is at most 32,768 bytes and carries a real clip (S4-REQUEST-02)',
                    lambda: check_recognize_request_sizes(fake_api), is_required=False)
        record.step('the clip the real recorder sent', lambda: check_received_clip(clip_path), is_required=False)
        production_driver = Driver(device, PRODUCTION_PACKAGE)
        record.step('a production build given an http address refuses to start',
                    lambda: production_build_refuses_cleartext(device, fake_api, resources.apks['production'],
                                                               production_driver),
                    is_required=False, device=device, driver=production_driver)
    except RunStopped:
        pass
    finally:
        if resources.fake_api is not None:
            try:   # everything the fake received, for reading a failure afterwards
                (temporary_folder / 'fake-api-requests.json').write_text(
                    json.dumps(resources.fake_api.request_log(), indent=2, ensure_ascii=False), encoding='utf-8')
            except Exception:
                pass
        stop_everything(resources, temporary_folder)


def require(value: Resource | None) -> Resource:
    if value is None:
        raise RunStopped('a step the run depends on did not finish')
    return value


def stop_everything(resources: RunResources, temporary_folder: Path) -> None:
    """Keeps the device log, stops the emulator (adb emu kill) and the fake. Never raises."""
    if resources.device is not None:
        try:
            (temporary_folder / 'logcat.txt').write_text(
                resources.device.adb('logcat', '-d', '-t', '3000', check=False, timeout_seconds=60), encoding='utf-8')
        except StepFailed:
            pass
        try:
            resources.device.adb('emu', 'kill', check=False, timeout_seconds=30)
        except StepFailed:
            pass
    stop_process(resources.emulator, timeout_seconds=90)
    if resources.fake is not None:
        resources.fake.process.terminate()
    stop_process(resources.fake, timeout_seconds=15)


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
        print(f'Cannot start the emulator tests: {error}')
        return 2
    if reasons:
        print('Not starting the emulator tests:')
        for reason in reasons:
            print(f'  - {reason}')
        print('This script never stops Docker or another emulator: close them, then run it again.')
        return 2
    record = RunRecord(Path(tempfile.mkdtemp(prefix='lookup-emulator-run-')))
    print(f'Run folder: {record.temporary_folder}', flush=True)
    try:
        run(tools, record, arguments.skip_build)
    finally:
        record.write()
        failed = sum(1 for step in record.steps if not step.is_passed)
        print(f'\n{len(record.steps) - failed} passed, {failed} failed. Run record: {record.path}', flush=True)
    return 0 if record.is_passed else 1


if __name__ == '__main__':
    sys.exit(main())
