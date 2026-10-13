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
  7. Proves the emulator commands later journeys depend on (P6 design fact 8): airplane mode, or Wi-Fi and
     mobile data switched off with svc; a notification read with dumpsys; whether the image has a
     notification shade. Each result is written in the run record.
  8. Stops the emulator and the fake, writes the run record (JSON, next to the temporary folder: device,
     image, each step's outcome, the screen dumps of any failure, and the app's own reason whenever a
     request got no answer, P6 design fact 21) and prints its path.

    python tool/run_emulator_tests.py                            # from apps/mobile, with Docker Desktop closed
    python tool/run_emulator_tests.py --skip-build               # reuse the APKs kept by the last build
    python tool/run_emulator_tests.py --prove-emulator-commands  # only step 7: boot, prove, record, stop

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
    'set-up problem': "This copy of Look Up isn't set up correctly.",  # §2.11
    # The full listener app (P6 design).
    'chooser title': 'Which station are you listening to?',            # P6 §2.6
    'chooser lead': 'This ad is on more than one station right now.',  # P6 §2.6
    'chooser remember': 'Remember my station — skip this next time',   # P6 §2.6
    'chooser cancel': 'Cancel',                                        # P6 §2.6
    'saved to history': 'Saved to History',                            # P6 §2.7
    'tab identify': 'Identify',                                        # P6 §2.2
    'tab history': 'History',                                          # P6 §2.2
    'tab settings': 'Settings',                                        # P6 §2.2
    'history earlier': 'Earlier',                                      # P6 §2.9
    'saved result heading': 'Saved result',                            # P6 §2.10
    'back': 'Back',                                                    # P6 §2.10, §2.12, the pages' Back arrow
    'settings my station': 'My station',                               # P6 §2.11
    'picker no station': 'No station',                                 # P6 §2.12
    'how it works': 'How Look Up works',                               # P6 §2.3
    'saved no connection': "Saved — we'll identify it when you're back online",   # P6 §2.8
    'saved busy': "Saved — we'll identify it when Look Up is less busy",          # P6 §2.8
    'saved ok': 'OK',                                                  # P6 §2.8
    'see it in history': 'See it in History',                          # P6 §2.8
    'allow notifications': 'Allow notifications',                      # P6 §2.8 (T50)
    'notifications allowed': "You'll get a notification with the result, including the station's buttons.",
    'history waiting': 'Waiting for signal',                           # P6 §2.9
    'pending': 'Pending',                                              # P6 §2.9, inside the waiting row's label
    'history choose your station': 'Choose your station to see the buttons',     # P6 §2.9
    'update heading': 'Please update the app',                         # P6 §2.15
    # Piece 4 (P6 design §2.5, §2.11, §2.14).
    'identifying slow': 'Still working — the connection is slow.',      # P6 §2.5
    'clip sent': 'Clip sent — waiting for the answer',                 # P6 §2.5
    'each identify uses': 'Each identify uses',                        # P6 §2.11
    'about 25 KB': 'about 25 KB',                                      # P6 §2.11
    'used this month': 'Used this month',                              # P6 §2.11
    'load pictures': 'Load ad pictures on mobile data',                # P6 §2.11, the switch row's first line
    'report this': 'Report this',                                      # P6 §2.14
    'reported': 'Reported',                                            # P6 §2.14
    'report sheet title': 'Report this ad',                            # P6 §2.14
    'report reason scam': 'It looks like a scam',                      # P6 §2.14
    'send report': 'Send report',                                      # P6 §2.14
    'report thanks': "Thanks — we'll check this ad.",                  # P6 §2.14
}

# "Clip [n]% sent" (P6 §2.5), and an amount of data as Settings shows it: whole kilobytes below 1,000 KB, then
# megabytes with one decimal, each 1,000 of the one before (DataAmount.of).
CLIP_PERCENT_SENT = re.compile(r'^Clip (\d{1,3})% sent$')
DATA_AMOUNT = re.compile(r'^(\d+(?:\.\d)?) (KB|MB)$')

# A saved clip's notification (P6 design §2.16, amendment A6): the same generic words for every outcome, and none of
# the ad's, the advertiser's or the stations' words, since it shows on a locked phone.
NOTIFICATION_TITLE = 'Look Up'
NOTIFICATION_TEXT = 'Your saved clip has been checked. Tap to see the result.'
WORDS_A_NOTIFICATION_MUST_NOT_HOLD = ('Brand A', 'Summer service offer', 'Station A', 'Station B')
# The extra a notification's tap starts the app with (device_services' LAUNCH_RECOGNITION_ID_EXTRA).
LAUNCH_RECOGNITION_ID_EXTRA = 'zm.lookup.recognition_id'

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
PICTURES_FIXTURE = (REPOSITORY_FOLDER / 'packages' / 'contracts' / 'fixtures' / 'recognition' / 'recognize-response'
                    / 'valid' / 'match-with-images.json')
CHOOSER_FIXTURE = (REPOSITORY_FOLDER / 'packages' / 'contracts' / 'fixtures' / 'recognition' / 'recognize-response'
                   / 'valid' / 'choose-station.json')
STATION_LIST_FIXTURE = (REPOSITORY_FOLDER / 'packages' / 'contracts' / 'fixtures' / 'recognition'
                        / 'listener-station-list' / 'valid' / 'two-stations.json')
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
# P6 design §4.8: with "No signal" the emulator's network stays up, so only the outbox's own wake-up sends again;
# the development build retries after at most 5, 10, 20 and 40 seconds.
SECONDS_FOR_AN_OUTBOX_RETRY = 45
# With the app closed, WorkManager starts the job once Android reports the network, then the job's own wait (at most
# 5 s in the development build): allowed generously, as the emulator's job scheduler is slow to notice.
SECONDS_FOR_THE_BACKGROUND_JOB = 180
# The saved clips' pauses the stand-in asks for (fake_listener_api.py): a shed send, and one over the deferred
# allowance (P6-OFFLINE-17, -18).
DEFERRED_SHED_RETRY_AFTER_SECONDS = 60
DEFERRED_LIMITED_RETRY_AFTER_SECONDS = 90
DOCKER_PROCESS_NAMES = ('com.docker.backend', 'docker desktop')
# A slow identify (piece 4): 8 s of recording, the stand-in's 9-10 s of slow reading, and a slow emulator.
SECONDS_FOR_A_SLOW_IDENTIFY = 60
# How long Android may take to make mobile data its network once Wi-Fi is off, and Wi-Fi again once it is back on.
SECONDS_FOR_A_NETWORK_CHANGE = 60
# The share of the screen's width the 2:1 banner box takes at least: the card spans the screen less its margins.
BANNER_BOX_SHARE_OF_WIDTH = 0.3
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
    # A switch or checkbox: whether it is on; None for a node that cannot be checked.
    checked: bool | None = None

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
                                element.get('clickable') == 'true', bounds,
                                element.get('checked') == 'true' if element.get('checkable') == 'true' else None))
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

    @property
    def history_title(self) -> str:
        """The first line of its row in History (P6 §2.9)."""
        return f'{self.client_name} — {self.title}'


@dataclass(frozen=True)
class ListedStation:
    """A station as the "Which station?" sheet and the "My station" picker show it."""
    station_id: str
    name: str
    spoken_label: str   # the row's screen-reader label, e.g. `Station B, 104.3 FM, Kitwe`
    via_line: str       # the Result's line, e.g. `via Station B · 104.3 FM`

    @classmethod
    def from_station(cls, station: dict[str, Any]) -> ListedStation:
        spoken = ', '.join(part for part in (station['name'], station['frequency_label'], station.get('city')) if part)
        return cls(station['id'], station['name'], spoken, f"via {station['name']} · {station['frequency_label']}")


def chooser_stations(fixture_path: Path) -> list[ListedStation]:
    """The stations of the stand-in's "Which station?" answer, in the order the sheet shows them."""
    response = json.loads(fixture_path.read_text(encoding='utf-8'))['response']
    return [ListedStation.from_station(candidate['station']) for candidate in response['candidates']]


def listed_stations(fixture_path: Path) -> list[ListedStation]:
    """The stations of the stand-in's `GET /stations` answer."""
    return [ListedStation.from_station(station)
            for station in json.loads(fixture_path.read_text(encoding='utf-8'))['response']['stations']]


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


def measured_recognize_requests(log: dict[str, Any]) -> list[dict[str, Any]]:
    """The recognize requests the fake read: one cut off by "No signal", or turned away by the update gate, was
    never read, so it has no sizes."""
    return [request for request in requests_to(log, RECOGNIZE_PATH)
            if 'dropped' not in request and not request.get('update_required')]


def problems_with_request_sizes(log: dict[str, Any]) -> list[str]:
    """Checks every recognize request the fake accepted (S4-REQUEST-02; design §3.10): the whole body at most
    LARGEST_RECOGNIZE_BODY_BYTES, so "about 25 KB of data" on Home is true, and the audio at least
    SMALLEST_CLIP_BYTES, so a small body cannot pass because the recorder sent next to nothing."""
    recognize_requests = measured_recognize_requests(log)
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


# ---- The app's own reason for a request that got no answer (pure; P6 design fact 21) -------------------
# A development build with its developer tools writes one JSON line to the device log for each request that got
# no answer (DevelopmentLog.noAnswerEvent), and a build with verbose logs writes every request with the same fields.
NO_ANSWER_EVENTS = ('api request without answer', 'api request')
# ApiNoAnswerReason's values (lib/core/network/api_no_answer_reason.dart).
NO_ANSWER_REASONS = ('noConnection', 'timedOut', 'connectionDropped', 'cancelled', 'plainHttpRefused',
                     'unexpectedFailure')


@dataclass(frozen=True)
class NoAnswer:
    """One request the app sent that got no answer, and why, as the app itself saw it."""
    method: str
    path: str
    reason: str
    request_id: str
    duration_milliseconds: int | None = None
    fault_type_name: str | None = None

    def describe(self) -> str:
        fault = f' ({self.fault_type_name})' if self.fault_type_name else ''
        took = f' after {self.duration_milliseconds} ms' if self.duration_milliseconds is not None else ''
        return f'{self.method} {self.path}: {self.reason}{fault}{took} (request id {self.request_id})'


def no_answers_in_device_log(device_log: str) -> list[NoAnswer]:
    """The app's no-answer lines in a device log, in order. Each is one JSON object after logcat's own prefix
    ("10-08 21:46:22.761  2153  2174 I flutter : {...}"); a line that is not one, or names a reason the app does
    not have, is skipped, so nothing else in the log can pass for the app's reason."""
    found = []
    for line in device_log.splitlines():
        start = line.find('{')
        if start < 0:
            continue
        try:
            entry = json.loads(line[start:])
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get('event') not in NO_ANSWER_EVENTS:
            continue
        reason = entry.get('noAnswerReason')
        if reason not in NO_ANSWER_REASONS:
            continue
        duration = entry.get('durationMilliseconds')
        fault = entry.get('faultTypeName')
        found.append(NoAnswer(str(entry.get('method')), str(entry.get('path')), reason, str(entry.get('requestId')),
                              duration if isinstance(duration, int) else None,
                              fault if isinstance(fault, str) else None))
    return found


def new_no_answers(before: Sequence[NoAnswer], after: Sequence[NoAnswer]) -> list[NoAnswer]:
    """The no-answers in [after] that [before] did not hold: those of one journey."""
    seen = set(before)
    return [no_answer for no_answer in after if no_answer not in seen]


# ---- The emulator commands later journeys depend on (pure parts; P6 design fact 8) ----------------------------
# The shade's own views in SystemUI, by resource id: any of them on screen means the image has a shade.
NOTIFICATION_SHADE_IDS = ('notification_stack_scroller', 'notification_panel', 'notification_shade',
                          'quick_settings_panel', 'qs_frame', 'shade_header', 'notification_container_parent')
SYSTEM_UI_PACKAGE = 'com.android.systemui'
PROOF_NOTIFICATION_TITLE = 'Look Up emulator check'
PROOF_NOTIFICATION_TEXT = 'Proof that dumpsys reads notifications'
PROOF_NOTIFICATION_TAG = 'lookup-emulator-check'
SHELL_PACKAGE = 'com.android.shell'


@dataclass(frozen=True)
class DumpedNotification:
    """One notification as `dumpsys notification --noredact` lists it."""
    package_name: str
    title: str | None
    text: str | None


def notifications_in_dumpsys(dumpsys_output: str, package_name: str | None = None) -> list[DumpedNotification]:
    """The notifications `dumpsys notification --noredact` lists, with their title and text, of [package_name] only
    when given. Each starts at `NotificationRecord(`; its `extras` hold `android.title=String (…)` and
    `android.text=String (…)`."""
    notifications = []
    for block in dumpsys_output.split('NotificationRecord(')[1:]:
        package_match = re.search(r'\bpkg=(\S+)', block)
        if not package_match:
            continue
        title = re.search(r'^\s*android\.title=\w+ \((.*)\)\s*$', block, re.MULTILINE)
        text = re.search(r'^\s*android\.text=\w+ \((.*)\)\s*$', block, re.MULTILINE)
        notification = DumpedNotification(package_match[1], title[1] if title else None, text[1] if text else None)
        if package_name is None or notification.package_name == package_name:
            notifications.append(notification)
    return notifications


def has_notification_shade(screen: Screen) -> bool:
    """Whether the screen shows SystemUI's notification shade or quick settings."""
    return any(node.package_name == SYSTEM_UI_PACKAGE and node.resource_id.split('/')[-1] in NOTIFICATION_SHADE_IDS
               for node in screen.nodes)


def airplane_mode_setting(settings_output: str) -> bool | None:
    """`settings get global airplane_mode_on`: on, off, or unknown."""
    value = settings_output.strip()
    return {'1': True, '0': False}.get(value)


def active_default_network(dumpsys_connectivity: str) -> str | None:
    """The `Active default network:` line of `dumpsys connectivity`: a network id, 'none', or None when the image
    prints no such line."""
    match = re.search(r'Active default network:\s*(\S+)', dumpsys_connectivity)
    return match[1] if match else None


@dataclass(frozen=True)
class DefaultNetwork:
    """Android's default network as `dumpsys connectivity` describes it."""
    network_id: str
    transports: tuple[str, ...]
    is_metered: bool

    def describe(self) -> str:
        return f"{'/'.join(self.transports) or 'no transport'}, {'metered' if self.is_metered else 'not metered'}"


def default_network_of(dumpsys_connectivity: str) -> DefaultNetwork | None:
    """The default network, its transports and whether it is metered (no NOT_METERED capability), from the
    `Active default network:` line and that network's NetworkAgentInfo line; None when either is missing."""
    network_id = active_default_network(dumpsys_connectivity)
    if network_id in (None, 'none'):
        return None
    for line in dumpsys_connectivity.splitlines():
        if f'network{{{network_id}}}' in line and 'Transports:' in line:
            transports = re.search(r'Transports:\s*([A-Z_|]+)', line)
            capabilities = re.search(r'Capabilities:\s*(\S+)', line)
            return DefaultNetwork(network_id, tuple(transports[1].split('|')) if transports else (),
                                  'NOT_METERED' not in (capabilities[1] if capabilities else ''))
    return None


def ping_reached(ping_output: str) -> bool | None:
    """Whether one ping got its reply: True, False, or None when the image has no ping to ask."""
    if 'not found' in ping_output or 'inaccessible' in ping_output:
        return None
    match = re.search(r'(\d+) packets transmitted, (\d+) (?:packets )?received', ping_output)
    if match:
        return int(match[2]) > 0
    return False if ('unreachable' in ping_output.lower() or 'exit=1' in ping_output or 'exit=2' in ping_output) else None


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
    def clear_app_data(self, package_name: str) -> None: ...
    def save_evidence(self, name: str, screen: Screen | None) -> list[str]: ...
    def read_device_log(self) -> str: ...
    # The full listener app's piece 3 (P6 design §4.8).
    def notifications_of(self, package_name: str) -> list[DumpedNotification]: ...
    def open_saved_result(self, package_name: str, recognition_id: str) -> None: ...
    def close_in_background(self, package_name: str) -> None: ...
    def is_app_running(self, package_name: str) -> bool: ...
    def grant_notifications(self, package_name: str) -> None: ...
    def take_network_away(self) -> str: ...
    def bring_network_back(self) -> None: ...
    def use_mobile_data_only(self) -> str: ...
    def use_wifi_again(self) -> None: ...


class FakeApiControl(Protocol):
    def queue(self, scenario_names: Sequence[str]) -> None: ...
    def request_log(self) -> dict[str, Any]: ...
    def reset(self) -> None: ...
    def set_offline(self, is_offline: bool) -> None: ...
    def set_minimum_app_version(self, minimum_app_version: str | None) -> None: ...
    def state(self) -> dict[str, Any]: ...


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

    def shows(self, label: str, *, exact: bool = True) -> bool:
        """Whether the screen shows [label] now, whole or, when not [exact], inside a longer label."""
        return bool(find_nodes(self.read_screen().nodes, label, package_name=self.app_package, exact=exact))

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
    """A dropped connection (T27′): the clip is saved, "OK" goes Home, and the outbox sends the same clip again by
    itself, marked deferred."""
    count_before = context.recognize_count()
    context.fake_api.queue(['drop', 'match'])
    context.driver.tap(IDENTIFY_LABELS)
    context.driver.wait_for(LABELS['saved no connection'], SECONDS_FOR_AN_IDENTIFY)
    context.driver.tap(LABELS['saved ok'])
    context.driver.wait_for(LABELS['home heading'], 15)
    context.driver.wait_until(lambda: len(context.recognize_requests_since(count_before)) >= 2,
                              SECONDS_FOR_AN_OUTBOX_RETRY, 'the saved clip to be sent again')
    sends = check_sends(context, count_before, ['drop', 'match'])
    problems = deferred_send_problems(sends)
    if problems:
        raise StepFailed('; '.join(problems))
    return (f"saved; the outbox sent the clip again as deferred with idempotency key {sends[0].get('idempotency_key')}"
            f" at {sends[1].get('sent_at')}")


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


# ---- The full listener app, pieces 1 and 2 (P6 design §4.8 steps 1-5 and 17) ------------------------------

CHOOSER_STATIONS = chooser_stations(CHOOSER_FIXTURE)
LISTED_STATIONS = listed_stations(STATION_LIST_FIXTURE)


def choice_requests(log: dict[str, Any]) -> list[dict[str, Any]]:
    """The station choices the fake answered: neither refused nor cut off by "No signal"."""
    return [request for request in log.get('requests', [])
            if str(request.get('path', '')).endswith('/choice') and 'refused' not in request
            and 'dropped' not in request]


def new_choices(fake_api: FakeApiControl, count_before: int) -> list[dict[str, Any]]:
    """The choices the fake holds beyond the first [count_before]: one per recognition, the first sent."""
    return list(fake_api.state().get('choices', []))[count_before:]


def choose_a_station_with_no_signal(context: RunContext) -> str:
    """Step 1 (P6-TESTS-07 part 1, P6-CHOOSER-10): the sheet with both rows and "Remember" ticked; with "No signal"
    on, a tap on Station B shows its Result at once; once the signal is back, the outbox sends the choice by
    itself, exactly once."""
    driver, fake_api = context.driver, context.fake_api
    station_a, station_b = CHOOSER_STATIONS[0], CHOOSER_STATIONS[1]
    count_before = context.recognize_count()
    choices_before = len(fake_api.state().get('choices', []))
    answered_before = len(choice_requests(fake_api.request_log()))
    fake_api.queue(['choose-station'])
    driver.tap(IDENTIFY_LABELS)
    driver.wait_for(LABELS['chooser title'], SECONDS_FOR_AN_IDENTIFY)
    driver.expect_all([LABELS['chooser lead'], station_a.spoken_label, station_b.spoken_label,
                       LABELS['chooser remember'], LABELS['chooser cancel']], swipes=0)
    check_sends(context, count_before, ['choose-station'])
    fake_api.set_offline(True)
    try:
        driver.tap(station_b.spoken_label)
        driver.wait_for(LABELS['result header'], 10)
        driver.expect_all([station_b.via_line])
        if new_choices(fake_api, choices_before):
            raise StepFailed('a choice reached the fake while "No signal" was on')
    finally:
        fake_api.set_offline(False)
    driver.wait_until(lambda: new_choices(fake_api, choices_before), SECONDS_FOR_AN_OUTBOX_RETRY,
                      'the choice to reach the fake after "No signal" was switched off')
    driver.pause(10)   # a second send of the same choice would arrive by now
    choices = new_choices(fake_api, choices_before)
    answered = choice_requests(fake_api.request_log())[answered_before:]
    if [choice.get('station_id') for choice in choices] != [station_b.station_id] or len(answered) != 1:
        raise StepFailed(f'the fake holds {choices} as new choices after {len(answered)} answered choice requests, '
                         f'not one choice of {station_b.name} sent once')
    context.back_home_from(LABELS['result back'])
    return (f'{station_b.name} shown at once with no signal; its choice arrived once the signal was back '
            f"(request id {answered[0].get('request_id')})")


def remembered_station_skips_the_sheet(context: RunContext) -> str:
    """Step 2 (P6-CHOOSER-15, the stand-in's half): "Remember" was ticked in step 1, so the next identify carries
    Station B as its hint, and the stand-in's "Match by my station" answers with Station B's card: no sheet."""
    driver, fake_api = context.driver, context.fake_api
    station_b = CHOOSER_STATIONS[1]
    count_before = context.recognize_count()
    fake_api.queue(['match-by-hint'])
    driver.tap(IDENTIFY_LABELS)
    seen, _ = driver.wait_for_any([LABELS['result header'], LABELS['chooser title']], SECONDS_FOR_AN_IDENTIFY)
    if seen != LABELS['result header']:
        raise StepFailed('the sheet "Which station?" showed, though My station was set in the step before')
    driver.expect_all([station_b.via_line])
    check_sends(context, count_before, ['match-by-hint'])
    hint = (fake_api.state().get('recognitions') or [{}])[-1].get('station_hint')
    if hint != station_b.station_id:
        raise StepFailed(f'the identify carried the hint {hint!r}, not {station_b.name} ({station_b.station_id})')
    context.back_home_from(LABELS['result back'])
    return f'no sheet; the identify carried {station_b.name} as its hint, and the Result shows it'


def cancel_on_the_sheet_chooses_nothing(context: RunContext) -> str:
    """Step 3 (P6-CHOOSER-14): Cancel on the sheet goes Home, and no choice is sent."""
    driver, fake_api = context.driver, context.fake_api
    count_before = context.recognize_count()
    answered_before = len(choice_requests(fake_api.request_log()))
    fake_api.queue(['choose-station'])
    driver.tap(IDENTIFY_LABELS)
    driver.wait_for(LABELS['chooser title'], SECONDS_FOR_AN_IDENTIFY)
    check_sends(context, count_before, ['choose-station'])
    driver.tap(LABELS['chooser cancel'])
    driver.wait_for(LABELS['home heading'], 15)
    driver.pause(15)   # the outbox would have sent a queued choice by now (development builds wait at most 5 s)
    sent = choice_requests(fake_api.request_log())[answered_before:]
    if sent:
        raise StepFailed(f'{len(sent)} choice request(s) reached the fake after Cancel')
    return 'Home, and no choice sent'


def history_keeps_a_result_that_works_with_no_data(context: RunContext) -> str:
    """Step 4 (P6-HISTORY-02, the emulator's half): the Result says "Saved to History"; History lists it under
    "Earlier"; with "No signal" on, the row opens the saved result, and its Call button offers the copy sheet (the
    test image has no dialler)."""
    driver, card, fake_api = context.driver, context.card, context.fake_api
    count_before = context.recognize_count()
    fake_api.queue(['match'])
    driver.tap(IDENTIFY_LABELS)
    driver.wait_for(LABELS['result header'], SECONDS_FOR_AN_IDENTIFY)
    check_sends(context, count_before, ['match'])
    driver.expect_all([LABELS['saved to history']])
    context.back_home_from(LABELS['result back'])
    driver.tap(LABELS['tab history'])
    driver.wait_for(LABELS['history earlier'], 15)
    requests_before = len(fake_api.request_log().get('requests', []))
    fake_api.set_offline(True)
    try:
        driver.tap_scrolling(card.history_title)
        driver.wait_for(LABELS['saved result heading'], 15)
        driver.expect_all(card.labels)
        driver.tap_scrolling(card.call_label)
        driver.wait_for(LABELS['copy sheet heading'], 15)
        driver.expect_all([card.call_number_display, LABELS['copy number']], swipes=0)
        driver.tap(LABELS['copy sheet close'])
        driver.tap_scrolling(LABELS['back'])
        driver.wait_for(LABELS['history earlier'], 15)
    finally:
        fake_api.set_offline(False)
    # The Call tap is queued to be counted (piece 5), and the outbox may try to send it; that is no data the
    # saved result needs. Anything else is.
    asked = [request for request in fake_api.request_log().get('requests', [])[requests_before:]
             if request.get('path') != ENGAGEMENTS_PATH]
    if asked:
        raise StepFailed(f'opening the saved result sent {len(asked)} request(s): it must need no data')
    driver.tap(LABELS['tab identify'])
    driver.wait_for(LABELS['home heading'], 15)
    return (f'History listed "{card.history_title}"; with no signal it opened with no request, and Call offered '
            f'{card.call_number_display}')


def station_list_is_asked_for_once(context: RunContext) -> str:
    """Step 5 (P6-MYSTATION-02, -04): Settings, then My station: the picker lists exactly the stations the stand-in
    returned, after one GET /stations; opened again, it asks for nothing (the list is kept for 24 hours)."""
    driver, fake_api = context.driver, context.fake_api
    requests_before = int(fake_api.state().get('station_list_requests', 0))
    driver.tap(LABELS['tab settings'])
    driver.tap(LABELS['settings my station'], 15)
    driver.expect_all([LABELS['picker no station'], *[station.spoken_label for station in LISTED_STATIONS]])
    asked = int(fake_api.state().get('station_list_requests', 0)) - requests_before
    if asked != 1:
        raise StepFailed(f'opening the picker made {asked} station-list requests, not one')
    driver.tap_scrolling(LABELS['back'])
    driver.tap(LABELS['settings my station'], 15)
    driver.expect_all([station.spoken_label for station in LISTED_STATIONS])
    driver.pause(3)   # a second request would arrive by now
    asked = int(fake_api.state().get('station_list_requests', 0)) - requests_before
    if asked != 1:
        raise StepFailed(f'opening the picker again asked for the list again ({asked} requests in all); '
                         'it is kept for 24 hours')
    driver.tap_scrolling(LABELS['back'])
    driver.tap(LABELS['tab identify'])
    driver.wait_for(LABELS['home heading'], 15)
    return (f"the picker listed {', '.join(station.name for station in LISTED_STATIONS)} after one GET /stations, "
            'and asked for nothing when opened again')


def first_open_shows_how_look_up_works_once(context: RunContext) -> str:
    """Step 17 (ALL-USABILITY-04): with the app's data cleared, the first start shows "How Look Up works" on Home,
    and a restart does not. It runs last: clearing the data also forgets the install and the microphone grant."""
    driver, device = context.driver, context.device
    device.stop_app(context.app_package)
    device.clear_app_data(context.app_package)
    device.launch_app(context.app_package)
    driver.wait_for(LABELS['how it works'], 40)
    driver.pause(2)   # the note is recorded as shown once it has been drawn
    device.stop_app(context.app_package)
    device.launch_app(context.app_package)
    driver.wait_for(LABELS['home heading'], 40)
    driver.pause(2)
    if find_nodes(driver.read_screen().nodes, LABELS['how it works'], package_name=context.app_package):
        raise StepFailed('"How Look Up works" showed again after a restart: it belongs to the first start only')
    return 'the note showed on the first start, and not after a restart'


# ---- The full listener app, piece 3: clips sent later (P6 design §4.8 steps 6-11, 16 and 18) ----------------

def deferred_send_problems(sends: Sequence[dict[str, Any]]) -> list[str]:
    """Checks the sends of one saved clip, oldest first: the first may be the live send (is_deferred false), every
    later one is deferred; all carry the same key and capture time; each sends a later send time than the one before
    (contract R2; P6-OUTBOX-07)."""
    if not sends:
        return ['the stand-in received no send of the clip']
    problems = []
    if len({send.get('idempotency_key') for send in sends}) != 1:
        problems.append('the sends carried more than one idempotency key')
    if len({send.get('captured_at') for send in sends}) != 1:
        problems.append('the sends carried more than one capture time')
    deferred = [send.get('is_deferred') for send in sends[1:]]
    if any(value != 'true' for value in deferred):
        problems.append(f'a send after the first was not marked deferred: {deferred}')
    sent_times = [str(send.get('sent_at')) for send in sends]
    if any(later <= earlier for earlier, later in zip(sent_times, sent_times[1:])):
        problems.append(f'the send times do not move on: {sent_times}')
    return problems


def notification_problems(notifications: Sequence[DumpedNotification], expected_count: int) -> list[str]:
    """Checks the app's saved-clip notifications (P6-OFFLINE-20, A6): exactly [expected_count], each with the generic
    title and text, and none naming the ad, the advertiser or a station."""
    problems = []
    if len(notifications) != expected_count:
        problems.append(f'{len(notifications)} notifications of the app, not {expected_count}')
    for notification in notifications:
        if (notification.title, notification.text) != (NOTIFICATION_TITLE, NOTIFICATION_TEXT):
            problems.append(f'a notification says {notification.title!r} / {notification.text!r}')
        shown = f'{notification.title} {notification.text}'
        named = [word for word in WORDS_A_NOTIFICATION_MUST_NOT_HOLD if word in shown]
        if named:
            problems.append(f'a notification names {named}: it shows on a locked phone')
    return problems


def answered_deferred_sends(context: RunContext, count_before: int, scenario: str) -> list[dict[str, Any]]:
    """The deferred sends since [count_before] the stand-in answered with [scenario]."""
    return [send for send in context.recognize_requests_since(count_before)
            if send.get('is_deferred') == 'true' and send.get('scenario') == scenario]


def save_a_clip_with_no_signal(context: RunContext) -> None:
    """With "No signal" on (or the network away), an identify ends on "Saved"."""
    context.driver.tap(IDENTIFY_LABELS)
    context.driver.wait_for(LABELS['saved no connection'], SECONDS_FOR_AN_IDENTIFY)


def allow_notifications(context: RunContext) -> str:
    """T50: "Allow notifications" on the Saved screen, then the system dialog's Allow; where the dialog cannot be
    reached, `pm grant`, recorded as such (P6 design §4.8)."""
    driver = context.driver
    if driver.shows(LABELS['notifications allowed']):
        return 'notifications were already allowed'
    try:
        driver.tap_scrolling(LABELS['allow notifications'])
        answer = driver.allow_microphone_in_system_dialog(10)
        driver.wait_for(LABELS['notifications allowed'], 10)
        return f'notifications allowed in the system dialog ({answer})'
    except StepFailed as failure:
        context.device.grant_notifications(context.app_package)
        return f'notifications granted with pm grant: the dialog could not be reached ({failure})'


def open_through_the_notification(context: RunContext, recognition_id: str) -> None:
    """Opens a saved result as its notification's tap does: the activity with the recognition id as the launch
    extra (the emulator image has no shade to tap, P6 design §4.8 step 18)."""
    context.device.open_saved_result(context.app_package, recognition_id)
    context.driver.wait_for(LABELS['saved result heading'], 20)


def go_to_history(context: RunContext) -> None:
    if not context.driver.shows(LABELS['tab history']):
        context.driver.tap_scrolling(LABELS['back'])
    context.driver.tap(LABELS['tab history'])
    context.driver.wait_for_any([LABELS['history earlier'], LABELS['history waiting']], 15)


def go_home(context: RunContext) -> None:
    context.driver.tap(LABELS['tab identify'])
    context.driver.wait_for(LABELS['home heading'], 15)


def saved_offline_then_the_result_and_its_notification(context: RunContext) -> str:
    """Step 6 (P6-TESTS-09 part 1, P6-OFFLINE-19 to -21): with "No signal", an identify ends on "Saved"; History shows
    the clip Pending; with the signal back the outbox sends it as deferred, History moves it to Earlier, and one
    notification with the generic words opens the saved result."""
    driver, fake_api, device = context.driver, context.fake_api, context.device
    count_before = context.recognize_count()
    notifications_before = len(device.notifications_of(context.app_package))
    fake_api.set_offline(True)
    try:
        save_a_clip_with_no_signal(context)
        allowed = allow_notifications(context)
        driver.tap_scrolling(LABELS['see it in history'])
        driver.wait_for(LABELS['history waiting'], 15)
        if not driver.shows(LABELS['pending'], exact=False):
            raise StepFailed('the waiting row does not say "Pending"')
        fake_api.queue(['match'])
    finally:
        fake_api.set_offline(False)
    sends = driver.wait_until(lambda: answered_deferred_sends(context, count_before, 'match'),
                              SECONDS_FOR_AN_OUTBOX_RETRY, 'the saved clip to be sent as deferred')
    driver.wait_until(lambda: not driver.shows(LABELS['pending'], exact=False), 20,
                      'History to move the clip from "Waiting for signal" to Earlier')
    driver.expect_all([LABELS['history earlier'], context.card.history_title])
    notifications = driver.wait_until(
        lambda: device.notifications_of(context.app_package)[notifications_before:] or None, 20,
        "the saved clip's notification")
    problems = notification_problems(notifications, 1)
    if problems:
        raise StepFailed('; '.join(problems))
    recognition_id = str(sends[0].get('recognition_id'))
    open_through_the_notification(context, recognition_id)
    driver.expect_all(context.card.labels)
    driver.tap_scrolling(LABELS['back'])
    go_home(context)
    return (f'{allowed}; the clip went as deferred once the signal was back (key {sends[0].get("idempotency_key")}), '
            f'History moved it to Earlier, and its notification ("{NOTIFICATION_TITLE}") opened {recognition_id}')


def a_saved_clip_survives_a_restart(context: RunContext) -> str:
    """Step 8: a clip saved with no signal is still Pending after the app is stopped and started again, and is
    sent once the signal is back."""
    driver, fake_api, device = context.driver, context.fake_api, context.device
    count_before = context.recognize_count()
    fake_api.set_offline(True)
    try:
        save_a_clip_with_no_signal(context)
        driver.tap(LABELS['saved ok'])
        device.stop_app(context.app_package)
        device.launch_app(context.app_package)
        driver.wait_for(LABELS['home heading'], 40)
        go_to_history(context)
        if not driver.shows(LABELS['pending'], exact=False):
            raise StepFailed('after the restart History no longer shows the clip Pending')
        fake_api.queue(['no-match'])
    finally:
        fake_api.set_offline(False)
    driver.wait_until(lambda: answered_deferred_sends(context, count_before, 'no-match'), SECONDS_FOR_AN_OUTBOX_RETRY,
                      'the clip kept across the restart to be sent')
    go_home(context)
    return 'still Pending after a restart, and sent once the signal was back'


def a_crash_report_waits_for_the_signal(context: RunContext) -> str:
    """Step 11 (P6-ERRORREPORTING-05): "Send a test error" with no signal is kept, and sent once the signal is back,
    with the time it happened."""
    driver, fake_api = context.driver, context.fake_api
    reports_before = len(fake_api.state().get('client_error_reports', []))
    fake_api.set_offline(True)
    try:
        driver.tap(LABELS['send test error'])
        driver.pause(5)   # the report has met no answer by now, and is kept
    finally:
        fake_api.set_offline(False)
    reports = driver.wait_until(lambda: fake_api.state().get('client_error_reports', [])[reports_before:],
                                SECONDS_FOR_AN_OUTBOX_RETRY, 'the kept crash report to arrive')
    driver.pause(5)   # a second copy would arrive by now
    reports = fake_api.state().get('client_error_reports', [])[reports_before:]
    if len(reports) != 1 or not reports[0].get('occurred_at'):
        raise StepFailed(f'the stand-in received {reports}, not one report with the time it happened')
    return f"one report, sent later with occurredAt {reports[0]['occurred_at']}"


def saved_clips_wait_as_the_server_asks(context: RunContext) -> str:
    """Step 9 (P6-OFFLINE-17, -18; P6-D38): a saved clip shed as busy is sent again no sooner than its Retry-After
    (60 s), and one over the deferred allowance no sooner than 90 s; meanwhile a station choice goes at once, as the
    pause holds the clips only."""
    driver, fake_api = context.driver, context.fake_api
    station_b = CHOOSER_STATIONS[1]
    findings = []
    for pause_scenario, pause_seconds in (('busy-deferred-shed', DEFERRED_SHED_RETRY_AFTER_SECONDS),
                                          ('rate-limited-deferred', DEFERRED_LIMITED_RETRY_AFTER_SECONDS)):
        count_before = context.recognize_count()
        fake_api.queue(['drop', pause_scenario])
        driver.tap(IDENTIFY_LABELS)
        driver.wait_for(LABELS['saved no connection'], SECONDS_FOR_AN_IDENTIFY)
        driver.tap(LABELS['saved ok'])
        driver.wait_for(LABELS['home heading'], 15)
        paused = driver.wait_until(lambda: answered_deferred_sends(context, count_before, pause_scenario),
                                   SECONDS_FOR_AN_OUTBOX_RETRY, f'the saved clip to be answered {pause_scenario}')[0]
        if pause_scenario == 'busy-deferred-shed':
            # While the clips are paused, a choice made now still goes at once.
            choices_before = len(fake_api.state().get('choices', []))
            identify_count = context.recognize_count()
            fake_api.queue(['choose-station'])
            driver.tap(IDENTIFY_LABELS)
            driver.wait_for(LABELS['chooser title'], SECONDS_FOR_AN_IDENTIFY)
            driver.tap(station_b.spoken_label)
            driver.wait_for(LABELS['result header'], 10)
            driver.wait_until(lambda: new_choices(fake_api, choices_before), 20,
                              'the choice to go while the clips are paused')
            context.back_home_from(LABELS['result back'])
            check_sends(context, identify_count, ['choose-station'])
        fake_api.queue(['match'])
        resend = driver.wait_until(lambda: answered_deferred_sends(context, count_before, 'match'),
                                   pause_seconds + SECONDS_FOR_AN_OUTBOX_RETRY,
                                   f'the clip paused by {pause_scenario} to be sent again')[0]
        waited = float(resend['received_at_seconds']) - float(paused['received_at_seconds'])
        if waited < pause_seconds - 1:
            raise StepFailed(f'the clip was sent again {waited:.0f} s after {pause_scenario}, '
                             f'sooner than the {pause_seconds} s asked')
        findings.append(f'{pause_scenario}: sent again after {waited:.0f} s (asked {pause_seconds} s)')
    return '; '.join(findings) + '; a choice went at once while the clips were paused'


def airplane_mode_with_the_app_open(context: RunContext) -> str:
    """Step 16 (P6-TESTS-08, P6-OFFLINE-01, -02, P6-ERRORREPORTING-05): with the network away, an identify is saved,
    History shows it Pending, and a test error is kept; when Android reports the network back, the clip goes as
    deferred and the report with its time, History shows the result, and the notification is posted."""
    driver, fake_api, device = context.driver, context.fake_api, context.device
    count_before = context.recognize_count()
    reports_before = len(fake_api.state().get('client_error_reports', []))
    notifications_before = len(device.notifications_of(context.app_package))
    how = device.take_network_away()
    try:
        save_a_clip_with_no_signal(context)
        driver.tap_scrolling(LABELS['see it in history'])
        driver.wait_for(LABELS['history waiting'], 15)
        if not driver.shows(LABELS['pending'], exact=False):
            raise StepFailed('the waiting row does not say "Pending"')
        go_home(context)
        driver.tap(LABELS['send test error'])
        driver.pause(5)
        fake_api.queue(['match'])
    finally:
        device.bring_network_back()
    driver.wait_until(lambda: answered_deferred_sends(context, count_before, 'match'), 60,
                      'the clip to be sent once Android reported the network back')
    driver.wait_until(lambda: fake_api.state().get('client_error_reports', [])[reports_before:], 60,
                      'the kept test error to arrive')
    reports = fake_api.state().get('client_error_reports', [])[reports_before:]
    if len(reports) != 1 or not reports[0].get('occurred_at'):
        raise StepFailed(f'the stand-in received {reports}, not one report with the time it happened')
    go_to_history(context)
    driver.wait_until(lambda: not driver.shows(LABELS['pending'], exact=False), 20, 'the Pending row to go')
    notifications = driver.wait_until(
        lambda: device.notifications_of(context.app_package)[notifications_before:] or None, 20,
        "the saved clip's notification")
    problems = notification_problems(notifications, 1)
    if problems:
        raise StepFailed('; '.join(problems))
    go_home(context)
    return f'network taken away by {how}; the clip and the report arrived once it was back, with the notification'


def two_notifications_open_their_own_results(context: RunContext) -> str:
    """Step 18 (P6-OFFLINE-21): two clips saved with no signal get two results; each notification opens its own:
    the one answered first Station A's, the other Station B's."""
    driver, fake_api, device = context.driver, context.fake_api, context.device
    station_a, station_b = CHOOSER_STATIONS[0], CHOOSER_STATIONS[1]
    count_before = context.recognize_count()
    notifications_before = len(device.notifications_of(context.app_package))
    fake_api.set_offline(True)
    try:
        for _ in range(2):
            save_a_clip_with_no_signal(context)
            driver.tap(LABELS['saved ok'])
            driver.wait_for(LABELS['home heading'], 15)
        fake_api.queue(['match', 'match-station-b'])
    finally:
        fake_api.set_offline(False)
    driver.wait_until(lambda: len([send for send in context.recognize_requests_since(count_before)
                                   if send.get('is_deferred') == 'true' and send.get('scenario')]) >= 2,
                      2 * SECONDS_FOR_AN_OUTBOX_RETRY, 'both saved clips to be sent')
    # The stand-in answers in the order the sends come: Station A's match to the first, Station B's to
    # the second. With "No signal" Android still reports a network, so each clip keeps the wait its
    # own failed send left, and the newer may go first; oldest first holds among the clips that are
    # due (P6-OFFLINE-11, unit-tested), and when Android reports the network back (step 16).
    older = answered_deferred_sends(context, count_before, 'match')[0]
    newer = answered_deferred_sends(context, count_before, 'match-station-b')[0]
    notifications = driver.wait_until(
        lambda: (lambda new: new if len(new) >= 2 else None)(device.notifications_of(context.app_package)[notifications_before:]),
        20, 'two notifications')
    problems = notification_problems(notifications, 2)
    if problems:
        raise StepFailed('; '.join(problems))
    for send, station in ((older, station_a), (newer, station_b)):
        open_through_the_notification(context, str(send.get('recognition_id')))
        driver.expect_all([station.via_line])
        driver.tap_scrolling(LABELS['back'])
    go_home(context)
    return 'two notifications; the older opened Station A\'s result, the newer Station B\'s'


# ---- Piece 4: a slow identify, "Report this", data use and the pictures switch (P6 design §4.8) ----------

@dataclass(frozen=True)
class SlowSendSeen:
    """What Identifying showed during a slow identify."""
    is_slow_seen: bool
    percents: tuple[int, ...]
    is_clip_sent_seen: bool
    is_result_seen: bool
    readable_count: int
    unreadable_count: int

    def describe(self) -> str:
        shares = ', '.join(f'{percent}%' for percent in self.percents) or 'no share'
        return (f'"Still working" {"seen" if self.is_slow_seen else "not seen"}; {shares} sent shown; "Clip sent" '
                f'{"seen" if self.is_clip_sent_seen else "not seen"} ({self.readable_count} screens read, '
                f'{self.unreadable_count} unreadable)')


def watch_a_slow_send(driver: Driver, timeout_seconds: float) -> SlowSendSeen:
    """Reads Identifying until the Result shows: whether it said "Still working", each share of the clip it said was
    sent, in order, and whether it said "Clip sent"."""
    deadline = driver.monotonic() + timeout_seconds
    is_slow_seen = is_clip_sent_seen = False
    percents: list[int] = []
    readable_count = unreadable_count = 0
    while True:
        screen = driver.read_screen()
        if screen.problem:
            unreadable_count += 1
        else:
            readable_count += 1
            lines = [line for node in screen.nodes if node.package_name == driver.app_package for line in node.lines]
            is_slow_seen = is_slow_seen or normalise(LABELS['identifying slow']) in lines
            is_clip_sent_seen = is_clip_sent_seen or normalise(LABELS['clip sent']) in lines
            for line in lines:
                match = CLIP_PERCENT_SENT.match(line)
                if match and (not percents or percents[-1] != int(match[1])):
                    percents.append(int(match[1]))
            if normalise(LABELS['result header']) in lines:
                return SlowSendSeen(is_slow_seen, tuple(percents), is_clip_sent_seen, True, readable_count,
                                    unreadable_count)
        if driver.monotonic() >= deadline:
            return SlowSendSeen(is_slow_seen, tuple(percents), is_clip_sent_seen, False, readable_count,
                                unreadable_count)
        driver.sleep(driver.poll_seconds)


def slow_send_problems(seen: SlowSendSeen) -> list[str]:
    """P6-LISTENING-01: "Still working", then progress (a share of the clip, or "Clip sent"), then the Result."""
    problems = []
    if not seen.is_result_seen:
        problems.append('the Result never showed')
    if not seen.is_slow_seen:
        problems.append('Identifying never said "Still working — the connection is slow."')
    if not seen.percents and not seen.is_clip_sent_seen:
        problems.append('Identifying showed no progress: neither a share of the clip sent nor "Clip sent"')
    if list(seen.percents) != sorted(seen.percents):
        problems.append(f'the share of the clip sent went down: {list(seen.percents)}')
    if any(percent > 100 for percent in seen.percents):
        problems.append(f'a share over 100%: {list(seen.percents)}')
    return problems


def a_slow_answer_says_still_working(context: RunContext) -> str:
    """Step 19 (P6-LISTENING-01; piece 4 walkthrough (a) step 3): with "Slow upload" (the stand-in reads the clip about
    3 KB a second), Identifying says "Still working — the connection is slow." after 5 seconds, then how much of the
    clip has gone or "Clip sent — waiting for the answer", then the Result. The clip may fit in the phone's and the
    emulator's buffers, so the app may count it all sent at once (the widget test proves a growing share); the
    emulator's console can slow its network, but changing the speed back drops the app's open connection (run 3), so
    it is left alone."""
    driver, fake_api = context.driver, context.fake_api
    count_before = context.recognize_count()
    fake_api.queue(['slow-upload'])
    driver.tap(IDENTIFY_LABELS)
    seen = watch_a_slow_send(driver, SECONDS_FOR_A_SLOW_IDENTIFY)
    problems = slow_send_problems(seen)
    if problems:
        raise StepFailed('; '.join(problems) + f' ({seen.describe()})')
    check_sends(context, count_before, ['slow-upload'])
    context.back_home_from(LABELS['result back'])
    return seen.describe()


def match_station_id() -> str:
    """The station of the stand-in's "Match" answer: the one a report on its Result names."""
    return json.loads(MATCH_FIXTURE.read_text(encoding='utf-8'))['response']['result']['station']['id']


def report_requests_since(context: RunContext, requests_before: int) -> list[dict[str, Any]]:
    return [request for request in context.fake_api.request_log().get('requests', [])[requests_before:]
            if str(request.get('path', '')).endswith('/report') and 'report' in request]


def topmost(nodes: Sequence[ScreenNode]) -> ScreenNode:
    return min(nodes, key=lambda node: node.bounds[1])


def report_this_sends_one_report(context: RunContext) -> str:
    """Step 12 (P6-RESULT-04, -05 on the device; P6 design §2.14): on a Result, "Report this" → "It looks like a scam"
    → "Send report" with "No signal" on: the footer says "Reported" at once; once the signal is back the outbox sends
    exactly one report, naming the station shown and the reason; the saved result in History still says
    "Reported"."""
    driver, fake_api, card = context.driver, context.fake_api, context.card
    count_before = context.recognize_count()
    fake_api.queue(['match'])
    driver.tap(IDENTIFY_LABELS)
    driver.wait_for(LABELS['result header'], SECONDS_FOR_AN_IDENTIFY)
    recognition_id = check_sends(context, count_before, ['match'])[0].get('recognition_id')
    requests_before = len(fake_api.request_log().get('requests', []))
    fake_api.set_offline(True)
    try:
        driver.tap_scrolling(LABELS['report this'])
        driver.wait_for(LABELS['report sheet title'], 15)
        driver.tap(LABELS['report reason scam'])
        driver.tap(LABELS['send report'])
        thanks = driver.observe(LABELS['report thanks'], 5)
        driver.find_scrolling(LABELS['reported'])
        if driver.shows(LABELS['report this']):
            raise StepFailed('"Report this" still shows after the report was sent')
    finally:
        fake_api.set_offline(False)
    driver.wait_until(lambda: report_requests_since(context, requests_before), SECONDS_FOR_AN_OUTBOX_RETRY,
                      'the report to reach the stand-in once the signal was back')
    driver.pause(5)   # time for a second send, which must not come
    reports = report_requests_since(context, requests_before)
    wanted = {'recognition_id': recognition_id, 'station_id': match_station_id(), 'reason': 'LOOKS_LIKE_A_SCAM'}
    sent = [{key: report.get(key) for key in wanted} for report in reports]
    if sent != [wanted]:
        raise StepFailed(f'the stand-in received {sent}, not exactly one report {wanted}')
    context.back_home_from(LABELS['result back'])
    driver.tap(LABELS['tab history'])
    driver.wait_for(LABELS['history earlier'], 15)
    driver.tap_node(topmost(find_nodes(driver.read_screen().nodes, card.history_title,
                                       package_name=context.app_package)), card.history_title)
    driver.wait_for(LABELS['saved result heading'], 15)
    driver.find_scrolling(LABELS['reported'])
    if driver.shows(LABELS['report this']):
        raise StepFailed('the saved result offers "Report this" again')
    driver.tap_scrolling(LABELS['back'])
    driver.wait_for(LABELS['history earlier'], 15)
    go_home(context)
    return (f'"Reported" at once with no signal; thanks {thanks.describe()}; one report ({wanted["reason"]}, the station '
            'shown) once the signal was back; the saved result in History says "Reported"')


def data_amount_bytes(text: str) -> int | None:
    """An amount as Settings shows it ("312 KB", "1.4 MB") in bytes, or None for anything else."""
    match = DATA_AMOUNT.match(normalise(text))
    if not match:
        return None
    return round(float(match[1]) * (1_000 if match[2] == 'KB' else 1_000_000))


def used_this_month(screen: Screen, app_package: str) -> int:
    """The bytes "Used this month" shows: the one amount on the screen ("about 25 KB" is not an amount)."""
    amounts = {line for node in screen.nodes if node.package_name == app_package for line in node.lines
               if data_amount_bytes(line) is not None}
    if len(amounts) != 1:
        raise StepFailed(f'Settings shows {sorted(amounts) or "no amount"} for "Used this month", not one amount; '
                         f'{describe_screen(screen, app_package)}')
    return data_amount_bytes(amounts.pop()) or 0


def read_used_this_month(context: RunContext) -> int:
    context.driver.tap(LABELS['tab settings'])
    context.driver.find_scrolling(LABELS['used this month'])
    return used_this_month(context.driver.read_screen(), context.app_package)


def pictures_switch(context: RunContext) -> ScreenNode:
    """The "Load ad pictures on mobile data" row in Settings, scrolled into view; a node that says whether it is
    on."""
    node = context.driver.find_scrolling(LABELS['load pictures'])
    if node.checked is None:
        raise StepFailed('the "Load ad pictures on mobile data" row does not say whether it is on')
    return node


def set_pictures_switch(context: RunContext, is_on: bool) -> None:
    """Opens Settings and taps the row's words (the whole row toggles, P6-DATASAVER-04) until it is [is_on]."""
    context.driver.tap(LABELS['tab settings'])
    node = pictures_switch(context)
    if node.checked != is_on:
        context.driver.tap_node(node, LABELS['load pictures'])
        node = pictures_switch(context)
        if node.checked != is_on:
            raise StepFailed(f'tapping the row did not turn "Load ad pictures on mobile data" {"on" if is_on else "off"}')


def data_use_and_the_pictures_switch(context: RunContext) -> str:
    """Step 20 (P6-DATASAVER-02 to -04 on the device; piece 4 walkthrough (a) steps 1-2): Settings → Data shows "Each
    identify uses — about 25 KB" and "Used this month"; one identify adds at least its request to it, and less than
    twice that; the whole row of "Load ad pictures on mobile data", on at first, turns it off, it stays off after a
    restart, and the row turns it on again."""
    driver, fake_api, device = context.driver, context.fake_api, context.device
    driver.tap(LABELS['tab settings'])
    driver.expect_all([LABELS['each identify uses'], LABELS['about 25 KB'], LABELS['used this month']])
    before = read_used_this_month(context)
    go_home(context)
    count_before = context.recognize_count()
    fake_api.queue(['match'])
    driver.tap(IDENTIFY_LABELS)
    driver.wait_for(LABELS['result header'], SECONDS_FOR_AN_IDENTIFY)
    body_bytes = int(check_sends(context, count_before, ['match'])[0].get('body_bytes') or 0)
    context.back_home_from(LABELS['result back'])
    after = read_used_this_month(context)
    # Settings rounds to whole kilobytes, so each reading may be up to 500 bytes off.
    if not body_bytes - 1_000 <= after - before < 1.5 * body_bytes:
        raise StepFailed(f'"Used this month" grew by {after - before:,} bytes for an identify whose request was '
                         f'{body_bytes:,} bytes')
    if pictures_switch(context).checked is not True:
        raise StepFailed('"Load ad pictures on mobile data" is not on at first')
    set_pictures_switch(context, False)
    device.stop_app(context.app_package)
    device.launch_app(context.app_package)
    driver.wait_for(LABELS['home heading'], 40)
    driver.tap(LABELS['tab settings'])
    if pictures_switch(context).checked is not False:
        raise StepFailed('"Load ad pictures on mobile data" was on again after a restart')
    set_pictures_switch(context, True)
    go_home(context)
    return (f'"about 25 KB" shown; "Used this month" went from {before:,} to {after:,} bytes for a request of '
            f'{body_bytes:,}; the row turned the switch off, it stayed off after a restart, and the row turned it on')


def pictures_card_title() -> str:
    return json.loads(PICTURES_FIXTURE.read_text(encoding='utf-8'))['response']['result']['title']


def title_top_of_a_result_with_pictures(context: RunContext) -> int:
    """Identifies with "Match with pictures" and returns how far down the Result's title starts, in pixels: the 2:1
    banner box above it pushes it down (no picture loads on the emulator, fact 17, but the box keeps its size)."""
    driver = context.driver
    count_before = context.recognize_count()
    context.fake_api.queue(['match-with-images'])
    driver.tap(IDENTIFY_LABELS)
    driver.wait_for(LABELS['result header'], SECONDS_FOR_AN_IDENTIFY)
    check_sends(context, count_before, ['match-with-images'])
    titles = find_nodes(driver.read_screen().nodes, pictures_card_title(), package_name=context.app_package)
    if not titles:
        raise StepFailed(f'the Result does not show its title in view; {describe_screen(driver.last_screen, context.app_package)}')
    top = topmost(titles).bounds[1]
    context.back_home_from(LABELS['result back'])
    return top


def pictures_follow_the_switch_on_mobile_data(context: RunContext) -> str:
    """Step 21 (P6-DATASAVER-05, -06, the emulator's half): with the switch off, a Result with pictures keeps its
    banner box on Wi-Fi; on a metered mobile network (Wi-Fi off) it has none, so its title sits higher by at least
    BANNER_BOX_SHARE_OF_WIDTH of the screen's width; with the switch on again the box is back. That the pictures
    are then requested, or not, is the widget journey's and the phone's (walkthrough (c))."""
    device = context.device
    width = device.screen_size()[0]
    set_pictures_switch(context, False)
    go_home(context)
    try:
        on_wifi = title_top_of_a_result_with_pictures(context)
        network = device.use_mobile_data_only()
        try:
            held_back = title_top_of_a_result_with_pictures(context)
            set_pictures_switch(context, True)
            go_home(context)
            allowed = title_top_of_a_result_with_pictures(context)
        finally:
            device.use_wifi_again()
    finally:
        set_pictures_switch(context, True)
        go_home(context)
    problems = []
    if held_back > on_wifi - BANNER_BOX_SHARE_OF_WIDTH * width:
        problems.append(f'on mobile data with the switch off the title starts at {held_back} px, against {on_wifi} px on '
                        'Wi-Fi: the banner box still showed')
    if abs(allowed - on_wifi) > 20:
        problems.append(f'with the switch on again the title starts at {allowed} px, not about {on_wifi} px as on '
                        'Wi-Fi: the banner box did not come back')
    if problems:
        raise StepFailed('; '.join(problems))
    return (f'switch off: the title starts at {on_wifi} px on Wi-Fi (box shown) and {held_back} px on {network} '
            f'(no box); switch on, on mobile data: {allowed} px (box shown)')


# ---- Piece 5: taps counted once, and answers lost (P6 design §4.8 steps 13, 14) ---------------------------

ENGAGEMENTS_PATH = '/api/v1/engagements'


@dataclass(frozen=True)
class FixtureButton:
    """A button of a card the stand-in answers with: its type, id and label."""
    action_type: str
    action_id: str
    label: str


def buttons_of(card: dict[str, Any]) -> list[FixtureButton]:
    return [FixtureButton(action['type'], action['id'].lower(), action['label']) for action in card['actions']]


def match_buttons() -> list[FixtureButton]:
    """The buttons of the stand-in's "Match" card, in the card's order."""
    return buttons_of(json.loads(MATCH_FIXTURE.read_text(encoding='utf-8'))['response']['result']['card'])


def chooser_buttons_of(station_id: str) -> list[FixtureButton]:
    """The buttons of [station_id]'s card in the stand-in's "Which station?" answer."""
    response = json.loads(CHOOSER_FIXTURE.read_text(encoding='utf-8'))['response']
    card = next(candidate['card'] for candidate in response['candidates'] if candidate['station']['id'] == station_id)
    return buttons_of(card)


def button(buttons: Sequence[FixtureButton], action_type: str) -> FixtureButton:
    return next(each for each in buttons if each.action_type == action_type)


def tap_requests_since(context: RunContext, requests_before: int) -> list[dict[str, Any]]:
    """The taps the stand-in answered (204, or a lost answer) since [requests_before] requests."""
    return [request for request in context.fake_api.request_log().get('requests', [])[requests_before:]
            if request.get('path') == ENGAGEMENTS_PATH and 'engagement' in request]


def kept_taps_of(context: RunContext, recognition_id: str) -> list[dict[str, Any]]:
    """The taps the stand-in keeps for [recognition_id]: one per button, as the real API keeps them."""
    return [tap for tap in context.fake_api.state().get('engagements', []) if tap.get('recognition_id') == recognition_id]


def tap_a_button(context: RunContext, label: str) -> str:
    """Taps the Result's button [label] and comes back to the Result: the copy sheet is closed when the phone could
    not open the address; an app that opened is left by starting Look Up again. Returns which happened."""
    driver = context.driver
    driver.tap_scrolling(label)
    def what_shows() -> str | None:
        screen = driver.read_screen()
        if find_nodes(screen.nodes, LABELS['copy sheet heading'], package_name=context.app_package):
            return 'the copy sheet'
        if screen.nodes and not any(node.package_name == context.app_package for node in screen.nodes):
            return 'another app'
        return None
    shown = driver.wait_until(what_shows, 15, f'the copy sheet or another app after "{label}"')
    if shown == 'the copy sheet':
        driver.tap(LABELS['copy sheet close'])
    else:
        context.device.launch_app(context.app_package)
    driver.wait_for(LABELS['result header'], 20)
    return shown


def taps_are_counted_once_and_wait_for_the_signal(context: RunContext) -> str:
    """Step 13 (P6-OUTBOX-06, the emulator's half; piece 5 walkthrough (a)): on a Result, "Call us" tapped twice (the
    test image has no dialler, so the copy sheet shows each time) gives one tap at the stand-in; a button tapped with
    "No signal" on reaches it once the signal is back, once."""
    driver, fake_api, card = context.driver, context.fake_api, context.card
    count_before = context.recognize_count()
    fake_api.queue(['match'])
    driver.tap(IDENTIFY_LABELS)
    driver.wait_for(LABELS['result header'], SECONDS_FOR_AN_IDENTIFY)
    recognition_id = str(check_sends(context, count_before, ['match'])[0].get('recognition_id'))
    buttons = match_buttons()
    call, directions = button(buttons, 'CALL'), button(buttons, 'MAP')
    for _ in range(2):
        tap_a_button(context, card.call_label)
    driver.wait_until(lambda: kept_taps_of(context, recognition_id), SECONDS_FOR_AN_OUTBOX_RETRY,
                      'the Call tap to reach the stand-in')
    driver.pause(5)   # time for a second tap of Call to arrive, which must not count
    kept = [tap.get('action_id') for tap in kept_taps_of(context, recognition_id)]
    if kept != [call.action_id]:
        raise StepFailed(f'two Call taps left {len(kept)} taps at the stand-in, not one for Call')
    requests_before = len(fake_api.request_log().get('requests', []))
    fake_api.set_offline(True)
    try:
        opened = tap_a_button(context, directions.label)
        driver.pause(5)
        if tap_requests_since(context, requests_before):
            raise StepFailed('a tap reached the stand-in while "No signal" was on')
    finally:
        fake_api.set_offline(False)
    driver.wait_until(lambda: len(kept_taps_of(context, recognition_id)) == 2, SECONDS_FOR_AN_OUTBOX_RETRY,
                      f'the "{directions.label}" tap to reach the stand-in once the signal was back')
    kept = [tap.get('action_id') for tap in kept_taps_of(context, recognition_id)]
    if kept != [call.action_id, directions.action_id]:
        raise StepFailed(f'the stand-in keeps the taps {kept}, not Call then {directions.label}')
    context.back_home_from(LABELS['result back'])
    return (f'two Call taps (the copy sheet each time) gave one tap; "{directions.label}" with no signal ({opened}) '
            'arrived once the signal was back')


def answers_lost_still_count_once(context: RunContext) -> str:
    """Step 14 (P6-OUTBOX-05): a clip whose answer is lost on the way is saved and sent again, and gets its answer as
    a replay; a choice and a tap whose answers are lost are sent again too. The stand-in holds one recognition for
    the clip's key, one choice and one tap, however often each was sent."""
    driver, fake_api = context.driver, context.fake_api
    station_b = CHOOSER_STATIONS[1]
    # The clip.
    count_before = context.recognize_count()
    fake_api.queue(['match-answer-lost'])
    driver.tap(IDENTIFY_LABELS)
    driver.wait_for(LABELS['saved no connection'], SECONDS_FOR_AN_IDENTIFY)
    driver.tap(LABELS['saved ok'])
    driver.wait_for(LABELS['home heading'], 15)
    driver.wait_until(lambda: [send for send in context.recognize_requests_since(count_before) if send.get('scenario') == 'replay'],
                      SECONDS_FOR_AN_OUTBOX_RETRY, 'the saved clip to be sent again')
    sends = context.recognize_requests_since(count_before)
    if [send.get('scenario') for send in sends] != ['match-answer-lost', 'replay'] or \
            len({send.get('idempotency_key') for send in sends}) != 1 or len({send.get('recognition_id') for send in sends}) != 1:
        raise StepFailed(f'the lost answer gave {[(send.get("scenario"), send.get("recognition_id")) for send in sends]}, '
                         'not one recognition sent twice with one key')
    # The choice and the tap.
    count_before = context.recognize_count()
    requests_before = len(fake_api.request_log().get('requests', []))
    fake_api.queue(['choose-station', 'choice-answer-lost', 'engagement-answer-lost'])
    driver.tap(IDENTIFY_LABELS)
    driver.wait_for(LABELS['chooser title'], SECONDS_FOR_AN_IDENTIFY)
    recognition_id = str(check_sends(context, count_before, ['choose-station'])[0].get('recognition_id'))
    driver.tap(station_b.spoken_label)
    driver.wait_for(LABELS['result header'], 15)
    call = button(chooser_buttons_of(station_b.station_id), 'CALL')
    tap_a_button(context, call.label)
    log_of = lambda: fake_api.request_log().get('requests', [])[requests_before:]   # noqa: E731
    driver.wait_until(lambda: len([request for request in log_of() if 'choice' in request]) >= 2
                      and len([request for request in log_of() if 'engagement' in request]) >= 2,
                      3 * SECONDS_FOR_AN_OUTBOX_RETRY, 'the choice and the tap to be sent again after their lost answers')
    choices = [choice for choice in fake_api.state().get('choices', []) if choice.get('recognition_id') == recognition_id]
    taps = kept_taps_of(context, recognition_id)
    if [choice.get('station_id') for choice in choices] != [station_b.station_id]:
        raise StepFailed(f'the stand-in keeps {len(choices)} choices for the recognition, not one for Station B')
    if [tap.get('action_id') for tap in taps] != [call.action_id]:
        raise StepFailed(f'the stand-in keeps {len(taps)} taps for the recognition, not one for Call')
    context.back_home_from(LABELS['result back'])
    sent = log_of()
    return (f'the clip went twice with one key and one recognition id; the choice was sent '
            f'{len([request for request in sent if "choice" in request])} times and the tap '
            f'{len([request for request in sent if "engagement" in request])} times, and the stand-in keeps one of each')


def a_saved_clip_is_sent_with_the_app_closed(context: RunContext) -> str:
    """Step 7 (P6-OFFLINE-08): with the network away, a clip is saved and the app closed; when the network comes
    back, WorkManager's job sends it with no activity open, and History holds the result at the next start."""
    driver, fake_api, device = context.driver, context.fake_api, context.device
    count_before = context.recognize_count()
    how = device.take_network_away()
    try:
        save_a_clip_with_no_signal(context)
        driver.tap(LABELS['saved ok'])
        driver.wait_for(LABELS['home heading'], 15)
        device.close_in_background(context.app_package)
        if device.is_app_running(context.app_package):
            raise StepFailed('the app was still running after it was closed in the background')
        fake_api.queue(['match'])
    finally:
        device.bring_network_back()
    sends = driver.wait_until(lambda: answered_deferred_sends(context, count_before, 'match'),
                              SECONDS_FOR_THE_BACKGROUND_JOB, 'the background job to send the clip')
    device.launch_app(context.app_package)
    driver.wait_for(LABELS['home heading'], 40)
    go_to_history(context)
    driver.expect_all([LABELS['history earlier'], context.card.history_title])
    go_home(context)
    return (f'network taken away by {how}; with the app closed, the job sent the clip '
            f"(key {sends[0].get('idempotency_key')}), and History held its result at the next start")


def the_update_gate_and_its_end(context: RunContext) -> str:
    """Step 10 (P6-COMPATIBILITY-02, amendment A2): with a minimum newer than the app, an identify shows "Please update
    the app"; a choice made on a saved chooser waits; with the minimum back down, the next start's probe sends it."""
    driver, fake_api, device = context.driver, context.fake_api, context.device
    station_b = CHOOSER_STATIONS[1]
    count_before = context.recognize_count()
    # A saved chooser: a clip saved with no signal, answered "Which station?" once the signal is back.
    fake_api.set_offline(True)
    try:
        save_a_clip_with_no_signal(context)
        driver.tap(LABELS['saved ok'])
        driver.wait_for(LABELS['home heading'], 15)
        fake_api.queue(['choose-station'])
    finally:
        fake_api.set_offline(False)
    saved = driver.wait_until(lambda: answered_deferred_sends(context, count_before, 'choose-station'),
                              SECONDS_FOR_AN_OUTBOX_RETRY, 'the saved clip to be answered "Which station?"')[0]
    choices_before = len(fake_api.state().get('choices', []))
    gated_before = int(fake_api.state().get('update_required_answers', 0))
    fake_api.set_minimum_app_version('0.2.0')
    try:
        driver.tap(IDENTIFY_LABELS)
        driver.wait_for(LABELS['update heading'], SECONDS_FOR_AN_IDENTIFY)
        context.back_home_from(LABELS['back to home'])
        go_to_history(context)
        driver.tap_scrolling(LABELS['history choose your station'])
        driver.wait_for(LABELS['chooser title'], 15)
        driver.tap(station_b.spoken_label)
        driver.wait_for(LABELS['result header'], 10)
        driver.wait_until(lambda: int(fake_api.state().get('update_required_answers', 0)) >= gated_before + 2,
                          SECONDS_FOR_AN_OUTBOX_RETRY, 'the choice to be answered 426')
        if new_choices(fake_api, choices_before):
            raise StepFailed('the choice was kept while the update gate held')
    finally:
        fake_api.set_minimum_app_version(None)
    device.stop_app(context.app_package)
    device.launch_app(context.app_package)
    driver.wait_for(LABELS['home heading'], 40)
    choices = driver.wait_until(lambda: new_choices(fake_api, choices_before), SECONDS_FOR_AN_OUTBOX_RETRY,
                                "the waiting choice to go at the next start's probe")
    if choices[0].get('recognition_id') != saved.get('recognition_id') or choices[0].get('station_id') != station_b.station_id:
        raise StepFailed(f'the stand-in holds {choices[0]}, not {station_b.name} for the saved recognition')
    return ('"Please update the app" with the gate on; the saved chooser\'s choice waited, '
            'and went at the next start once the gate was off')


JOURNEYS: list[tuple[str, Callable[[RunContext], str]]] = [
    ('first launch registers once', first_launch_registers_once),
    ('Home, Permission, system dialog, Listening, Result; the call button offers the copy sheet',
     identify_after_allowing_microphone),
    ('no match', identify_with_no_match),
    ('busy, then the automatic retry reaches Result with one idempotency key', identify_when_busy),
    ("a server error shows the reference code of the fake's echoed request id", identify_with_server_error),
    ('a dropped connection is saved, and the outbox sends the same clip again as deferred',
     identify_with_dropped_connection),
    ('"Send a test error" sends one report to /client-errors', send_test_error),
    ('a restart of the installed app makes no new /installs call', restart_makes_no_new_registration),
    ('"Which station?" with no signal: Station B shows at once, and its choice is sent once the signal is back',
     choose_a_station_with_no_signal),
    ('"Remember my station": the next identify carries the hint, and no sheet shows', remembered_station_skips_the_sheet),
    ('Cancel on "Which station?" goes Home and sends no choice', cancel_on_the_sheet_chooses_nothing),
    ('History keeps the result: with no signal it opens, and Call offers the copy sheet',
     history_keeps_a_result_that_works_with_no_data),
    ('the "My station" list is asked for once, then kept', station_list_is_asked_for_once),
    # Piece 3 (P6 design §4.8 steps 6-11, 16, 18). Steps 11 and 16 each send the test error, more than a minute
    # apart (step 9 between them), as the app sends the same error at most once a minute.
    ('Saved offline, Pending in History, then the result and its notification', saved_offline_then_the_result_and_its_notification),
    ('a saved clip survives a restart', a_saved_clip_survives_a_restart),
    ('a crash report with no signal is kept and sent later with its time', a_crash_report_waits_for_the_signal),
    ('saved clips wait as the server asks, while a choice goes at once', saved_clips_wait_as_the_server_asks),
    ('airplane mode with the app open: the clip and a test error go when the network is back',
     airplane_mode_with_the_app_open),
    ('two notifications open their own results', two_notifications_open_their_own_results),
    ('with the app closed, the background job sends a saved clip', a_saved_clip_is_sent_with_the_app_closed),
    ('the update gate: "Please update the app", a choice that waits, and the probe at the next start',
     the_update_gate_and_its_end),
    # Piece 4 (P6 design §4.8 steps 12, 19-21).
    ('"Report this" with no signal: "Reported" at once, and one report once the signal is back',
     report_this_sends_one_report),
    ('a slow identify says "Still working", shows its progress, then the Result', a_slow_answer_says_still_working),
    ('Data: "about 25 KB", "Used this month" counts an identify, and the pictures switch keeps its place',
     data_use_and_the_pictures_switch),
    ('on mobile data the pictures switch decides the banner box; on Wi-Fi it always shows',
     pictures_follow_the_switch_on_mobile_data),
    # Piece 5 (P6 design §4.8 steps 13, 14).
    ('two Call taps count once, and a tap with no signal goes once the signal is back',
     taps_are_counted_once_and_wait_for_the_signal),
    ('answers lost on the way: one recognition, one choice and one tap however often sent',
     answers_lost_still_count_once),
    # Last: clearing the app's data forgets the install and the microphone grant the journeys above rely on.
    ('"How Look Up works" shows on the first start only', first_open_shows_how_look_up_works_once),
]


@dataclass
class StepOutcome:
    name: str
    is_passed: bool
    detail: str
    seconds: float
    evidence: list[str] = field(default_factory=list)
    taps: list[str] = field(default_factory=list)
    # The app's own reason for every request of the step that got no answer (P6 design fact 21, §4.8), and whether
    # the device log could be read for them at all.
    no_answers: list[str] = field(default_factory=list)
    are_no_answers_read: bool = True


def slug(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:60]


def recover_to_home(context: RunContext) -> None:
    """After a failed journey: restart the app, so the next journey starts at Home."""
    context.device.stop_app(context.app_package)
    context.device.launch_app(context.app_package)
    context.driver.wait_for(LABELS['home heading'], 40)


def read_no_answers_quietly(device: Device) -> list[NoAnswer] | None:
    """The app's no-answer lines in the device log so far, or None when the log could not be read: evidence is a
    help, never a reason to fail a journey."""
    try:
        return no_answers_in_device_log(device.read_device_log())
    except Exception:   # an unreadable log only means the reason is not recorded
        return None


def run_journeys(context: RunContext, journeys: Sequence[tuple[str, Callable[[RunContext], str]]],
                 *, first_number: int = 1, monotonic: Callable[[], float] = time.monotonic) -> list[StepOutcome]:
    """Runs each journey; a failure saves the screen, restarts the app and goes on with the next one. A request
    the fake refused fails the journey that made it, because the app broke the contract. Every journey's outcome
    records the app's own reason for each of its requests that got no answer (P6 design fact 21)."""
    outcomes: list[StepOutcome] = []
    for index, (name, journey) in enumerate(journeys):
        started = monotonic()
        context.driver.taps = []
        log_before = context.fake_api.request_log()
        refused_before = len(refused_requests(log_before))
        no_answers_before = read_no_answers_quietly(context.device)

        def no_answers_of_this_journey() -> list[str] | None:
            after = read_no_answers_quietly(context.device)
            if after is None or no_answers_before is None:
                return None
            return [no_answer.describe() for no_answer in new_no_answers(no_answers_before, after)]

        try:
            detail = journey(context)
            refused = refused_requests(context.fake_api.request_log())[refused_before:]
            if refused:
                raise StepFailed('the fake API refused what the app sent: ' + '; '.join(refused))
            no_answers = no_answers_of_this_journey()
            outcomes.append(StepOutcome(name, True, detail, monotonic() - started, taps=context.driver.taps,
                                        no_answers=no_answers or [], are_no_answers_read=no_answers is not None))
            print(f'PASS  {name}: {detail}{describe_no_answers(no_answers)}', flush=True)
        except Exception as error:   # any failure of one journey is recorded, then the next one runs
            detail = str(error) if isinstance(error, StepFailed) else f'{type(error).__name__}: {error}'
            try:
                detail += f'. The fake API saw: {what_the_fake_saw(log_before, context.fake_api.request_log())}'
            except Exception:   # the fake may be the thing that failed; the failure itself is what matters
                pass
            no_answers = no_answers_of_this_journey()
            evidence = save_evidence_quietly(context.device, f'{first_number + index:02d}-{slug(name)}',
                                             context.driver.last_screen)
            outcomes.append(StepOutcome(name, False, detail, monotonic() - started, evidence, context.driver.taps,
                                        no_answers or [], no_answers is not None))
            print(f'FAIL  {name}: {detail}{describe_no_answers(no_answers)}', flush=True)
            try:
                recover_to_home(context)
            except Exception as recovery_error:
                for remaining_name, _ in journeys[index + 1:]:
                    outcomes.append(StepOutcome(remaining_name, False,
                                                f'not run: the app could not be brought back to Home ({recovery_error})', 0))
                break
    return outcomes


def describe_no_answers(no_answers: Sequence[str] | None) -> str:
    """The no-answer reasons for a PASS or FAIL line: nothing when every request was answered, and a note when the
    device log could not be read for them."""
    if no_answers is None:
        return ". (The device log could not be read, so the app's no-answer reasons are not recorded.)"
    return f'. The app got no answer: {"; ".join(no_answers)}' if no_answers else ''


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

    def clear_app_data(self, package_name: str) -> None:
        """As a fresh install: the app's files, settings and grants are deleted (`pm clear`)."""
        output = self.adb('shell', 'pm', 'clear', package_name, check=False)
        if 'Success' not in output:
            raise StepFailed(f'pm clear {package_name} failed: {output.strip()[:300]}')

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

    def read_device_log(self) -> str:
        """The app's own lines in the device log so far: Flutter writes them under the `flutter` tag."""
        return self.adb('logcat', '-d', '-s', 'flutter', check=False, timeout_seconds=60)

    def notifications_of(self, package_name: str) -> list[DumpedNotification]:
        """The notifications [package_name] has posted, as `dumpsys notification --noredact` lists them."""
        return notifications_in_dumpsys(
            self.adb('shell', 'dumpsys', 'notification', '--noredact', check=False, timeout_seconds=60), package_name)

    def open_saved_result(self, package_name: str, recognition_id: str) -> None:
        """Starts the app as a saved clip's notification does: its activity with the recognition id as the launch
        extra (P6 design §3.15). Used where the image has no notification shade to tap."""
        output = self.adb('shell', 'am', 'start', '-n', f'{package_name}/{MAIN_ACTIVITY}',
                          '--es', LAUNCH_RECOGNITION_ID_EXTRA, recognition_id)
        if 'Error' in output:
            raise StepFailed(f'the app {package_name} did not start with the launch extra: {output.strip()[:300]}')

    def close_in_background(self, package_name: str) -> None:
        """Home, then `am kill`: the process ends as Android ends a background app, without the stopped state of
        force-stop, which would hold back the app's WorkManager jobs until it is opened again."""
        self.adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
        time.sleep(2)
        self.adb('shell', 'am', 'kill', package_name, check=False)
        time.sleep(2)

    def is_app_running(self, package_name: str) -> bool:
        return bool(self.adb('shell', 'pidof', package_name, check=False).strip())

    def grant_notifications(self, package_name: str) -> None:
        self.adb('shell', 'pm', 'grant', package_name, 'android.permission.POST_NOTIFICATIONS')

    def take_network_away(self) -> str:
        """Airplane mode, else Wi-Fi and mobile data off (P6 design fact 8); returns which, once Android reports no
        network. Raises when neither takes it away; the network is switched back on first."""
        for name, commands_off, commands_on in (('airplane mode', AIRPLANE_MODE_OFF_COMMANDS, AIRPLANE_MODE_ON_COMMANDS),
                                                ('Wi-Fi and data off', RADIOS_OFF_COMMANDS, RADIOS_ON_COMMANDS)):
            for command in commands_off:
                self.adb(*command, check=False)
            deadline = time.monotonic() + SECONDS_FOR_THE_NETWORK_TO_GO
            while time.monotonic() < deadline:
                if is_network_gone(network_state(self)):
                    self._commands_on = commands_on
                    return name
                time.sleep(2)
            for command in commands_on:
                self.adb(*command, check=False)
        raise StepFailed('neither airplane mode nor Wi-Fi and data off took the network away')

    def bring_network_back(self) -> None:
        for command in getattr(self, '_commands_on', AIRPLANE_MODE_ON_COMMANDS):
            self.adb(*command, check=False)
        deadline = time.monotonic() + SECONDS_FOR_THE_NETWORK_TO_COME_BACK
        while not is_network_back(network_state(self)):
            if time.monotonic() >= deadline:
                raise StepFailed('the network did not come back')
            time.sleep(2)

    def use_mobile_data_only(self) -> str:
        """Wi-Fi off and mobile data on; returns once Android's default network is a metered mobile one (P6 design
        §3.16: "mobile data" means a metered network). Raises, with Wi-Fi back on, when it never is."""
        self.adb('shell', 'svc', 'data', 'enable', check=False)
        self.adb('shell', 'svc', 'wifi', 'disable', check=False)
        deadline = time.monotonic() + SECONDS_FOR_A_NETWORK_CHANGE
        while True:
            network = default_network_of(self.adb('shell', 'dumpsys', 'connectivity', check=False, timeout_seconds=60))
            if network is not None and 'CELLULAR' in network.transports and network.is_metered:
                return network.describe()
            if time.monotonic() >= deadline:
                self.use_wifi_again()
                raise StepFailed('with Wi-Fi off, Android never made a metered mobile network its default (it reported '
                                 f'{network.describe() if network else "no network"})')
            time.sleep(2)

    def use_wifi_again(self) -> None:
        """Wi-Fi on; returns once Android's default network is Wi-Fi again."""
        self.adb('shell', 'svc', 'wifi', 'enable', check=False)
        deadline = time.monotonic() + SECONDS_FOR_A_NETWORK_CHANGE
        while True:
            network = default_network_of(self.adb('shell', 'dumpsys', 'connectivity', check=False, timeout_seconds=60))
            if network is not None and 'WIFI' in network.transports:
                return
            if time.monotonic() >= deadline:
                raise StepFailed('Wi-Fi did not come back as the default network '
                                 f'(Android reported {network.describe() if network else "no network"})')
            time.sleep(2)

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

    def set_offline(self, is_offline: bool) -> None:
        """"No signal": with it on, the fake closes every /api/v1 connection unanswered."""
        self.send('POST', '/__fake/offline', {'is_offline': is_offline})

    def state(self) -> dict[str, Any]:
        """What the fake holds: switches, counts, the recognitions' hints and the choices (never an answer)."""
        return self.send('GET', '/__fake/state')

    def set_minimum_app_version(self, minimum_app_version: str | None) -> None:
        """The update gate: with a minimum newer than the app's, every request with a token gets 426."""
        self.send('POST', '/__fake/minimum-app-version', {'minimum_app_version': minimum_app_version})


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
    requests = measured_recognize_requests(log)
    bodies = [request['body_bytes'] for request in requests]
    clips = [request['audio_bytes'] for request in requests]
    return (f'{len(requests)} recognize requests: bodies {min(bodies):,}-{max(bodies):,} bytes (at most '
            f'{LARGEST_RECOGNIZE_BODY_BYTES:,}), audio {min(clips):,}-{max(clips):,} bytes (at least '
            f'{SMALLEST_CLIP_BYTES:,})')


# What must never reach the device log outside a development build with verbose logs (S4-PRIVACY-04).
FAKE_INSTALL_TOKEN = re.compile(r'fake\.[A-Za-z0-9_-]{16,}\.token')
# The cards' numbers: the Zambian sample numbers, and the UK drama-range numbers that replace them (P6-D29).
CARD_PHONE_NUMBER = re.compile(r'\+?(?:2609[0-9]{8}|447700900[0-9]{3})(?![0-9])')
REQUEST_BODY_FIELDS = ('idempotency_key', 'clip_duration_milliseconds', 'captured_at', 'install_id')


def private_values_in_device_log(device_log: str, log: dict[str, Any]) -> list[str]:
    """Every private value found in the device log: an install id the fake saw registered, an install
    token it issued, an Authorization header, a card's phone number, a request body's field names, or
    the clip's bytes. Each problem names what was found, never the value itself."""
    problems = []
    install_ids = {request['install_id'] for request in log.get('requests', []) if request.get('install_id')}
    if any(install_id in device_log for install_id in install_ids):
        problems.append('an install id')
    if FAKE_INSTALL_TOKEN.search(device_log):
        problems.append('an install token')
    if 'Bearer ' in device_log or 'Authorization:' in device_log:
        problems.append('an Authorization header')
    if CARD_PHONE_NUMBER.search(device_log):
        problems.append('a phone number from a card')
    if any(field in device_log for field in REQUEST_BODY_FIELDS):
        problems.append('a request body')
    if 'ftypM4A' in device_log:
        problems.append('audio bytes')
    return problems


def check_device_log_holds_no_private_values(device: AdbDevice, fake_api: FakeApiControl) -> str:
    """S4-PRIVACY-04 on the emulator: after every journey, the whole device log is read. The build is the
    development flavour with verbose logs off, the nearest to production that can reach the fake over
    http; the Dart tests show staging and production write nothing at all."""
    device_log = device.adb('logcat', '-d', check=False, timeout_seconds=60)
    if len(device_log) < 1_000:
        raise StepFailed('the device log could not be read')
    problems = private_values_in_device_log(device_log, fake_api.request_log())
    if problems:
        raise StepFailed('the device log holds ' + ', '.join(problems))
    return f'{len(device_log.splitlines()):,} lines read: no install id, token, Authorization header, card phone number, request body or audio'


EMULATOR_LONGEST_CLIP_SECONDS = 10.5


def check_received_clip(clip_path: Path) -> str:
    if not clip_path.exists():
        raise StepFailed('the fake API saved no clip: no recognize request reached it')
    if not FINGERPRINTER_PYTHON.exists():
        raise StepFailed(f"{FINGERPRINTER_PYTHON} is missing: the clip check runs on the fingerprinter's Python (PyAV)")
    # The emulator's virtual microphone gives the recorder more audio than real time, so a clip of 8 seconds
    # of recording decodes to 8 to 10 seconds here; the strict 7.5-8.5 s check runs on the phone (design §4.9).
    completed = subprocess.run([str(FINGERPRINTER_PYTHON), str(CLIP_CHECKER), str(clip_path),
                                '--longest-seconds', str(EMULATOR_LONGEST_CLIP_SECONDS)], capture_output=True,
                               text=True, errors='replace', timeout=180)
    output = (completed.stdout + completed.stderr).strip()
    if completed.returncode != 0:
        raise StepFailed(output or f'the clip check failed with exit code {completed.returncode}')
    return f'{output} (the emulator allows up to {EMULATOR_LONGEST_CLIP_SECONDS} s: its microphone over-delivers)'


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


# ---- Proving the emulator commands later journeys depend on (P6 design fact 8) ------------------------------

NETWORK_PROBE_ADDRESS = '10.0.2.2'   # the PC, as the emulator reaches it
SECONDS_FOR_THE_NETWORK_TO_GO = 30
SECONDS_FOR_THE_NETWORK_TO_COME_BACK = 60
AIRPLANE_MODE_OFF_COMMANDS = (('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'),)
AIRPLANE_MODE_ON_COMMANDS = (('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'),)
RADIOS_OFF_COMMANDS = (('shell', 'svc', 'wifi', 'disable'), ('shell', 'svc', 'data', 'disable'))
RADIOS_ON_COMMANDS = (('shell', 'svc', 'wifi', 'enable'), ('shell', 'svc', 'data', 'enable'))


def network_state(device: AdbDevice) -> dict[str, Any]:
    """What Android says of its network now: airplane mode, the active default network, and whether the PC
    answers a ping (None when the image cannot say)."""
    return {
        'airplane_mode': airplane_mode_setting(
            device.adb('shell', 'settings', 'get', 'global', 'airplane_mode_on', check=False)),
        'active_default_network': active_default_network(
            device.adb('shell', 'dumpsys', 'connectivity', check=False, timeout_seconds=60)),
        'reaches_the_pc': ping_reached(
            device.adb('shell', f'ping -c 1 -W 2 {NETWORK_PROBE_ADDRESS}; echo exit=$?', check=False)),
    }


def is_network_gone(state: dict[str, Any]) -> bool:
    """Android reports no active network; or, on an image that prints no such line, the PC no longer answers."""
    network = state['active_default_network']
    return network == 'none' or (network is None and state['reaches_the_pc'] is False)


def is_network_back(state: dict[str, Any]) -> bool:
    network = state['active_default_network']
    return network not in (None, 'none') or (network is None and state['reaches_the_pc'] is True)


def prove_network_switch(device: AdbDevice, driver: Driver, commands_off: Sequence[Sequence[str]],
                         commands_on: Sequence[Sequence[str]]) -> dict[str, Any]:
    """Runs [commands_off], waits for Android to report the network gone, then always runs [commands_on] and waits
    for it to come back, so a failed proof never leaves the emulator offline for the steps after it."""
    result: dict[str, Any] = {
        'commands_off': [' '.join(command[1:]) for command in commands_off],
        'commands_on': [' '.join(command[1:]) for command in commands_on],
        'before': network_state(device),
    }
    outputs: list[str] = []
    try:
        for command in commands_off:
            outputs.append(device.adb(*command, check=False).strip()[:200])
        try:
            result['while_off'] = driver.wait_until(
                lambda: state if is_network_gone(state := network_state(device)) else None,
                SECONDS_FOR_THE_NETWORK_TO_GO, 'Android to report the network gone')
            result['network_went'] = True
        except StepFailed:
            result['while_off'] = network_state(device)
            result['network_went'] = False
    finally:
        for command in commands_on:
            outputs.append(device.adb(*command, check=False).strip()[:200])
        try:
            result['after'] = driver.wait_until(
                lambda: state if is_network_back(state := network_state(device)) else None,
                SECONDS_FOR_THE_NETWORK_TO_COME_BACK, 'the network to come back')
            result['network_came_back'] = True
        except StepFailed:
            result['after'] = network_state(device)
            result['network_came_back'] = False
    result['outputs'] = [output for output in outputs if output]
    result['works'] = result['network_went'] and result['network_came_back']
    return result


def prove_notification_read(device: AdbDevice) -> dict[str, Any]:
    """Posts a notification from the shell and reads it back through `dumpsys notification`, as the
    notification journeys will read the app's own (P6-OFFLINE-20)."""
    posted = device.adb('shell', f"cmd notification post -t '{PROOF_NOTIFICATION_TITLE}' {PROOF_NOTIFICATION_TAG} "
                                 f"'{PROOF_NOTIFICATION_TEXT}'", check=False).strip()
    listed = notifications_in_dumpsys(
        device.adb('shell', 'dumpsys', 'notification', '--noredact', check=False, timeout_seconds=60))
    found = [notification for notification in listed if notification.package_name == SHELL_PACKAGE
             and notification.title == PROOF_NOTIFICATION_TITLE and notification.text == PROOF_NOTIFICATION_TEXT]
    return {'posted_output': posted[:200], 'notifications_listed': len(listed), 'works': bool(found)}


def prove_notification_shade(device: AdbDevice, driver: Driver) -> dict[str, Any]:
    """Opens the notification shade and looks for SystemUI's shade on screen; closes it again."""
    try:
        device.adb('shell', 'cmd', 'statusbar', 'expand-notifications', check=False)
        driver.pause(2)
        screen = driver.read_screen()
        evidence = save_evidence_quietly(device, 'notification-shade', screen)
        return {
            'has_shade': has_notification_shade(screen),
            'system_ui_ids_seen': sorted({node.resource_id.split('/')[-1] for node in screen.nodes
                                          if node.package_name == SYSTEM_UI_PACKAGE and node.resource_id})[:15],
            'screen_problem': screen.problem,
            'evidence': evidence,
        }
    finally:
        device.adb('shell', 'cmd', 'statusbar', 'collapse', check=False)


def prove_emulator_commands(device: AdbDevice, driver: Driver) -> dict[str, Any]:
    """Each command of P6 design fact 8, tried on this image, with what it did. One proof that fails or breaks
    never stops the others."""
    proofs: dict[str, Callable[[], dict[str, Any]]] = {
        'airplane_mode': lambda: prove_network_switch(device, driver, AIRPLANE_MODE_OFF_COMMANDS,
                                                      AIRPLANE_MODE_ON_COMMANDS),
        'wifi_and_data_off': lambda: prove_network_switch(device, driver, RADIOS_OFF_COMMANDS, RADIOS_ON_COMMANDS),
        'dumpsys_notification': lambda: prove_notification_read(device),
        'notification_shade': lambda: prove_notification_shade(device, driver),
    }
    results: dict[str, Any] = {}
    for name, proof in proofs.items():
        try:
            results[name] = proof()
        except Exception as error:   # recorded, and the next proof runs
            results[name] = {'works': False, 'error': f'{type(error).__name__}: {error}'}
    return results


def describe_emulator_commands(results: dict[str, Any]) -> str:
    """One line for the run's output: what each command proved."""
    def verdict(name: str) -> str:
        result = results.get(name, {})
        if 'error' in result:
            return f"failed ({result['error']})"
        return 'works' if result.get('works') else 'does not work here'

    shade = results.get('notification_shade', {})
    shade_words = ('failed (' + shade['error'] + ')' if 'error' in shade
                   else 'present' if shade.get('has_shade') else 'none found')
    return (f"airplane mode: {verdict('airplane_mode')}; svc wifi and data: {verdict('wifi_and_data_off')}; "
            f"dumpsys notification: {verdict('dumpsys_notification')}; notification shade: {shade_words}")


def check_emulator_commands(device: AdbDevice, driver: Driver, record: RunRecord) -> str:
    """Proves the commands and writes the results in the run record. Fails only when no way to take the network
    away works, or a notification cannot be read: the journeys of later pieces depend on those."""
    results = prove_emulator_commands(device, driver)
    record.emulator_commands = results
    summary = describe_emulator_commands(results)
    can_go_offline = results['airplane_mode'].get('works') or results['wifi_and_data_off'].get('works')
    if not can_go_offline or not results['dumpsys_notification'].get('works'):
        raise StepFailed(summary)
    return summary


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
        # What each emulator command of P6 design fact 8 did on this image.
        self.emulator_commands: dict[str, Any] = {}

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
            'emulator_commands': self.emulator_commands,
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


def run(tools: Tools, record: RunRecord, skip_build: bool, *, proves_commands_only: bool = False) -> None:
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

    proof_name = ('the emulator commands of P6 fact 8: airplane mode, svc wifi and data, dumpsys notification, '
                  'the notification shade')
    try:
        if proves_commands_only:
            record.step(f'start the {AVD_NAME} virtual device', boot, is_required=True)
            record.step('prepare the device', prepare, is_required=True)
            device = require(resources.device)
            record.step(proof_name, lambda: check_emulator_commands(device, Driver(device, DEVELOPMENT_PACKAGE), record),
                        is_required=False, device=device)
            return
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
        record.step('the device log holds no install id, token, phone number, request body or audio (S4-PRIVACY-04)',
                    lambda: check_device_log_holds_no_private_values(device, fake_api), is_required=False)
        record.step('the clip the real recorder sent', lambda: check_received_clip(clip_path), is_required=False)
        production_driver = Driver(device, PRODUCTION_PACKAGE)
        record.step('a production build given an http address refuses to start',
                    lambda: production_build_refuses_cleartext(device, fake_api, resources.apks['production'],
                                                               production_driver),
                    is_required=False, device=device, driver=production_driver)
        # Last, so a network left off by a broken image cannot spoil a journey.
        record.step(proof_name, lambda: check_emulator_commands(device, Driver(device, DEVELOPMENT_PACKAGE), record),
                    is_required=False, device=device)
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
    parser.add_argument('--prove-emulator-commands', action='store_true',
                        help='only boot the emulator and prove the commands of P6 design fact 8 (no build, no fake)')
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
        run(tools, record, arguments.skip_build, proves_commands_only=arguments.prove_emulator_commands)
    finally:
        record.write()
        failed = sum(1 for step in record.steps if not step.is_passed)
        print(f'\n{len(record.steps) - failed} passed, {failed} failed. Run record: {record.path}', flush=True)
    return 0 if record.is_passed else 1


if __name__ == '__main__':
    sys.exit(main())
