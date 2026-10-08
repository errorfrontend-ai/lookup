"""Tests the emulator runner's pure parts without a device (design §4.7): reading a uiautomator dump, finding
nodes by label, the values the checks expect, and the journeys themselves, driven against a scripted phone
and a scripted fake API with a fake clock. Standard library only:

    python -m unittest tool/test_run_emulator_tests.py
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any, Callable
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parent))

import run_emulator_tests as runner  # noqa: E402  (the tool folder is put on the path first)
from run_emulator_tests import (  # noqa: E402
    LABELS, RECOGNIZE_PATH, CardExpectation, Driver, RunContext, Screen, StepFailed, docker_process_names,
    emulator_serials, find_nodes, find_permission_allow_button, node_to_tap, parse_screen_dump, parse_window_size,
    phone_number_display, problems_with_sends, process_names_from_tasklist, reference_code_for_request_id,
    refused_requests, requests_to, run_journeys)

APP = 'zm.lookup.listener.development'
SYSTEM_DIALOG = 'com.android.permissioncontroller'
REFERENCE_CODES = runner.REPOSITORY_FOLDER / 'packages' / 'contracts' / 'fixtures' / 'errors' / 'reference-codes.json'

# A Result screen as `adb exec-out uiautomator dump /dev/tty` prints it, written by hand after Flutter's
# accessibility bridge: labels in content-desc, merged labels on separate lines, and uiautomator's own line
# after the XML.
RESULT_SCREEN_DUMP = (
    "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>"
    '<hierarchy rotation="0">'
    '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="zm.lookup.listener.development" '
    'content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,1920]">'
    '<node index="0" text="" resource-id="" class="android.view.View" package="zm.lookup.listener.development" '
    'content-desc="" clickable="false" enabled="true" bounds="[0,63][1080,1794]">'
    '<node index="0" text="" resource-id="" class="android.widget.Button" package="zm.lookup.listener.development" '
    'content-desc="Back to home" clickable="true" enabled="true" bounds="[21,84][147,210]" />'
    '<node index="1" text="" resource-id="" class="android.view.View" package="zm.lookup.listener.development" '
    'content-desc="Found it" clickable="false" enabled="true" bounds="[168,115][337,178]" />'
    '<node index="2" text="" resource-id="" class="android.view.View" package="zm.lookup.listener.development" '
    'content-desc="Brand A&#10;via Station A · 98.1 FM" clickable="false" enabled="true" bounds="[63,252][1017,388]" />'
    '<node index="3" text="" resource-id="" class="android.view.View" package="zm.lookup.listener.development" '
    'content-desc="Summer service offer" clickable="false" enabled="true" bounds="[63,409][1017,486]" />'
    '<node index="4" text="" resource-id="" class="android.widget.Button" package="zm.lookup.listener.development" '
    'content-desc="Call us" clickable="true" enabled="true" bounds="[63,560][1017,716]" />'
    '<node index="5" text="" resource-id="" class="android.widget.Button" package="zm.lookup.listener.development" '
    'content-desc="WhatsApp us" clickable="true" enabled="true" bounds="[63,737][1017,893]" />'
    '</node></node>'
    '<node index="1" text="12:30" resource-id="com.android.systemui:id/clock" class="android.widget.TextView" '
    'package="com.android.systemui" content-desc="" clickable="false" enabled="true" bounds="[42,0][147,63]" />'
    '</hierarchy>UI hierchary dumped to: /dev/tty\n'
)

# Android 13's microphone dialog, as the permission controller draws it.
PERMISSION_DIALOG_DUMP = (
    "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">"
    '<node index="0" text="Allow Look Up (dev) to record audio?" '
    'resource-id="com.android.permissioncontroller:id/permission_message" class="android.widget.TextView" '
    'package="com.android.permissioncontroller" content-desc="" clickable="false" bounds="[147,800][933,900]" />'
    '<node index="1" text="Only this time" resource-id="com.android.permissioncontroller:id/permission_allow_one_time_button" '
    'class="android.widget.Button" package="com.android.permissioncontroller" content-desc="" clickable="true" '
    'bounds="[105,1000][975,1120]" />'
    '<node index="2" text="While using the app" '
    'resource-id="com.android.permissioncontroller:id/permission_allow_foreground_only_button" '
    'class="android.widget.Button" package="com.android.permissioncontroller" content-desc="" clickable="true" '
    'bounds="[105,1130][975,1250]" />'
    '<node index="3" text="Don’t allow" resource-id="com.android.permissioncontroller:id/permission_deny_button" '
    'class="android.widget.Button" package="com.android.permissioncontroller" content-desc="" clickable="true" '
    'bounds="[105,1260][975,1380]" />'
    '</hierarchy>'
)


class ScreenDumpTest(unittest.TestCase):
    def test_reads_every_node_of_a_saved_dump(self) -> None:
        screen = parse_screen_dump(RESULT_SCREEN_DUMP)

        self.assertIsNone(screen.problem)
        self.assertEqual(len(screen.nodes), 9)
        call = find_nodes(screen.nodes, 'Call us')[0]
        self.assertEqual(call.center, (540, 638))
        self.assertTrue(call.is_clickable)
        self.assertEqual(call.package_name, APP)

    def test_a_dump_without_a_hierarchy_is_a_screen_with_a_problem(self) -> None:
        screen = parse_screen_dump('ERROR: could not get idle state.\n')

        self.assertEqual(screen.nodes, ())
        self.assertIn('could not get idle state', screen.problem or '')

    def test_broken_xml_is_a_screen_with_a_problem(self) -> None:
        screen = parse_screen_dump('<hierarchy><node bounds="[0,0][1,1]"></hierarchy>')

        self.assertIn('not XML', screen.problem or '')


class FindNodesTest(unittest.TestCase):
    nodes = parse_screen_dump(RESULT_SCREEN_DUMP).nodes

    def test_a_label_matches_one_line_of_a_merged_description(self) -> None:
        self.assertEqual(len(find_nodes(self.nodes, 'via Station A · 98.1 FM')), 1)
        self.assertEqual(len(find_nodes(self.nodes, 'Brand A')), 1)

    def test_a_label_must_match_a_whole_line_unless_told_otherwise(self) -> None:
        self.assertEqual(find_nodes(self.nodes, 'Call'), [])
        self.assertEqual(len(find_nodes(self.nodes, 'Call', exact=False)), 1)

    def test_spaces_are_collapsed_and_no_break_spaces_read_as_spaces(self) -> None:
        self.assertEqual(len(find_nodes(self.nodes, '  Summer service   offer ')), 1)

    def test_a_package_keeps_other_apps_out(self) -> None:
        self.assertEqual(len(find_nodes(self.nodes, '12:30')), 1)
        self.assertEqual(find_nodes(self.nodes, '12:30', package_name=APP), [])

    def test_the_clickable_node_is_tapped_when_several_show_a_label(self) -> None:
        nodes = parse_screen_dump(
            '<hierarchy>'
            '<node text="" content-desc="Allow microphone" package="p" clickable="false" bounds="[0,0][1080,1920]" />'
            '<node text="" content-desc="Allow microphone" package="p" clickable="true" bounds="[24,1600][1056,1756]" />'
            '</hierarchy>').nodes

        self.assertEqual(node_to_tap(find_nodes(nodes, 'Allow microphone')).center, (540, 1678))


class PermissionDialogTest(unittest.TestCase):
    def test_the_foreground_only_button_is_chosen_by_its_resource_id(self) -> None:
        button = find_permission_allow_button(parse_screen_dump(PERMISSION_DIALOG_DUMP).nodes)

        self.assertIsNotNone(button)
        self.assertEqual(button.text if button else None, 'While using the app')

    def test_the_button_is_found_by_its_text_when_the_ids_differ(self) -> None:
        dump = PERMISSION_DIALOG_DUMP.replace('permission_allow_foreground_only_button', 'renamed_button')

        button = find_permission_allow_button(parse_screen_dump(dump).nodes)

        self.assertEqual(button.text if button else None, 'While using the app')

    def test_no_dialog_no_button(self) -> None:
        self.assertIsNone(find_permission_allow_button(parse_screen_dump(RESULT_SCREEN_DUMP).nodes))


class ExpectedValuesTest(unittest.TestCase):
    def test_reference_codes_agree_with_the_shared_fixture(self) -> None:
        cases = json.loads(REFERENCE_CODES.read_text(encoding='utf-8'))

        self.assertGreater(len(cases), 10)
        for case in cases:
            with self.subTest(case['description']):
                self.assertEqual(reference_code_for_request_id(case['request_id']), case['reference_code'])

    def test_phone_numbers_are_shown_as_the_copy_sheet_shows_them(self) -> None:
        self.assertEqual(phone_number_display('+260977123456'), '+260 97 712 3456')
        self.assertEqual(phone_number_display('+447700900123'), '+447700900123')

    def test_the_card_expectation_comes_from_the_fixture_the_fake_sends(self) -> None:
        card = CardExpectation.from_fixture(runner.MATCH_FIXTURE)

        self.assertEqual(card, CardExpectation('Summer service offer', 'Brand A', 'via Station A · 98.1 FM', 'Call us',
                                               '+260 97 712 3456'))

    def test_every_label_is_filled_in(self) -> None:
        for key, label in LABELS.items():
            with self.subTest(key):
                self.assertEqual(label, label.strip())
                self.assertTrue(label)

    def test_the_production_apk_is_set_up_wrongly_only_in_its_plain_http_address(self) -> None:
        defines = runner.production_cleartext_defines()

        self.assertEqual(set(defines), {'LOOKUP_FLAVOUR', 'LOOKUP_API_BASE_URL', 'LOOKUP_SUPPORT_WHATSAPP_NUMBER'})
        self.assertEqual(defines['LOOKUP_FLAVOUR'], 'production')
        self.assertEqual(defines['LOOKUP_API_BASE_URL'], 'http://10.0.2.2:3999/api/v1')
        # The app's own rule (AppConfiguration): E.164, and a Zambian number has 9 digits after +260. Without a
        # valid number, production would refuse to start for that reason too, and the http check would prove less.
        self.assertRegex(defines['LOOKUP_SUPPORT_WHATSAPP_NUMBER'], r'^\+260[1-9][0-9]{8}$')


class MachineChecksTest(unittest.TestCase):
    def test_docker_desktop_is_found_in_the_process_list(self) -> None:
        tasklist = ('"System Idle Process","0","Services","0","8 K"\n'
                    '"Docker Desktop.exe","4120","Console","1","120,000 K"\n'
                    '"com.docker.backend.exe","5120","Console","1","80,000 K"\n'
                    '"dockerd-helper.exe","6120","Console","1","1,000 K"\n')

        self.assertEqual(docker_process_names(process_names_from_tasklist(tasklist)),
                         ['Docker Desktop.exe', 'com.docker.backend.exe'])
        self.assertEqual(docker_process_names(['/Applications/Docker.app/Contents/MacOS/com.docker.backend']),
                         ['/Applications/Docker.app/Contents/MacOS/com.docker.backend'])
        self.assertEqual(docker_process_names(['explorer.exe', 'qemu-system-x86_64.exe']), [])

    def test_running_emulators_are_read_from_adb_devices(self) -> None:
        output = 'List of devices attached\nemulator-5554\tdevice\nR58M1234\tdevice\n\n'

        self.assertEqual(emulator_serials(output), ['emulator-5554'])
        self.assertEqual(emulator_serials('List of devices attached\n\n'), [])

    def test_the_window_size_in_force_is_the_override(self) -> None:
        self.assertEqual(parse_window_size('Physical size: 1080x1920\n'), (1080, 1920))
        self.assertEqual(parse_window_size('Physical size: 1080x1920\nOverride size: 720x1280\n'), (720, 1280))
        self.assertIsNone(parse_window_size('error: no devices'))


class RequestLogTest(unittest.TestCase):
    def test_refused_requests_are_kept_apart_with_their_reasons(self) -> None:
        log = {'requests': [{'method': 'POST', 'path': RECOGNIZE_PATH, 'scenario': 'match'},
                            {'method': 'POST', 'path': RECOGNIZE_PATH, 'refused': 'the audio part is missing'}]}

        self.assertEqual(len(requests_to(log, RECOGNIZE_PATH)), 1)
        self.assertEqual(refused_requests(log), [f'POST {RECOGNIZE_PATH}: the audio part is missing'])

    def test_a_resend_keeps_its_key_and_gets_a_new_request_id(self) -> None:
        sends = [recognize_request('busy', 'key-1', 'id-1'), recognize_request('match', 'key-1', 'id-2')]

        self.assertEqual(problems_with_sends(sends, ['busy', 'match']), [])

    def test_a_resend_with_another_key_or_the_same_request_id_is_a_problem(self) -> None:
        self.assertIn('2 idempotency keys',
                      problems_with_sends([recognize_request('busy', 'key-1', 'id-1'),
                                           recognize_request('match', 'key-2', 'id-2')], ['busy', 'match'])[0])
        self.assertIn('same request id',
                      problems_with_sends([recognize_request('busy', 'key-1', 'id-1'),
                                           recognize_request('match', 'key-1', 'id-1')], ['busy', 'match'])[0])

    def test_answers_in_another_order_are_a_problem(self) -> None:
        self.assertIn("not ['busy', 'match']", problems_with_sends([recognize_request('match', 'key-1', 'id-1')],
                                                                   ['busy', 'match'])[0])


# ---- A scripted phone, a scripted fake API and a fake clock ----------------------------------------------

def recognize_request(scenario: str, idempotency_key: str, request_id: str) -> dict[str, Any]:
    return {'method': 'POST', 'path': RECOGNIZE_PATH, 'scenario': scenario, 'idempotency_key': idempotency_key,
            'request_id': request_id}


Node = tuple[str, str, str]   # label, package, resource id


def app(label: str) -> Node:
    return label, APP, ''


def dump_of(nodes: list[Node]) -> str:
    """One node per row, 120 px apart; the app's labels in content-desc, the system's in text, as on Android."""
    rows = []
    for index, (label, package, resource_id) in enumerate(nodes):
        top = 100 + index * 120
        text, description = (label, '') if package != APP else ('', label)
        rows.append(f'<node index="{index}" text={quote(text)} resource-id="{resource_id}" class="android.view.View" '
                    f'package="{package}" content-desc={quote(description)} clickable="true" '
                    f'bounds="[0,{top}][1080,{top + 100}]" />')
    return f"<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">{''.join(rows)}</hierarchy>"


def quote(text: str) -> str:
    return '"' + escape(text, {'"': '&quot;', '\n': '&#10;'}) + '"'


class ScriptedPhone:
    """A phone whose screens follow a script: a tap on a label moves to the screen [taps] names for it, and a
    screen listed in [moves_after_reads] moves on by itself after that many reads, as the app does after 8 s."""

    def __init__(self, screens: dict[str, list[Node]], taps: dict[tuple[str, str], str], *,
                 moves_after_reads: dict[str, tuple[int, str]] | None = None,
                 on_enter: dict[str, Callable[[], None]] | None = None, start: str = 'home') -> None:
        self.screens = screens
        self.tap_script = taps
        self.moves_after_reads = moves_after_reads or {}
        self.on_enter = on_enter or {}
        self.current = start
        self.reads_here = 0
        self.tapped: list[str] = []
        self.swipes = 0
        self.launches: list[str] = []
        self.stops: list[str] = []
        self.evidence: list[str] = []

    def move(self, screen_name: str) -> None:
        self.current = screen_name
        self.reads_here = 0
        if screen_name in self.on_enter:
            self.on_enter[screen_name]()

    def read_screen(self) -> Screen:
        move = self.moves_after_reads.get(self.current)
        if move and self.reads_here >= move[0]:
            self.move(move[1])
        self.reads_here += 1
        return parse_screen_dump(dump_of(self.screens[self.current]))

    def tap(self, x: int, y: int) -> None:
        label = self.screens[self.current][(y - 100) // 120][0]
        self.tapped.append(label)
        next_screen = self.tap_script.get((self.current, label))
        if next_screen:
            self.move(next_screen)

    def swipe(self, start: tuple[int, int], end: tuple[int, int]) -> None:
        self.swipes += 1

    def screen_size(self) -> tuple[int, int]:
        return 1080, 1920

    def launch_app(self, package_name: str) -> None:
        self.launches.append(package_name)
        self.move('home')

    def stop_app(self, package_name: str) -> None:
        self.stops.append(package_name)

    def save_evidence(self, name: str, screen: Screen | None) -> list[str]:
        self.evidence.append(name)
        return [f'{name}.xml']


class ScriptedFakeApi:
    def __init__(self) -> None:
        self.queued: list[str] = []
        self.requests: list[dict[str, Any]] = []
        self.reports: list[dict[str, Any]] = []

    def queue(self, scenario_names: list[str]) -> None:
        self.queued.extend(scenario_names)

    def request_log(self) -> dict[str, Any]:
        return {'requests': [dict(request) for request in self.requests], 'client_error_reports': list(self.reports)}

    def reset(self) -> None:
        self.__init__()

    def receive_recognize(self, idempotency_key: str = 'key-1',
                          request_id: str = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f') -> None:
        scenario = self.queued.pop(0) if self.queued else 'match'
        self.requests.append(recognize_request(scenario, idempotency_key, f'{request_id}'))


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


HOME = [app(LABELS['home heading']), app(LABELS['identify control']), app(LABELS['send test error'])]
CARD = CardExpectation.from_fixture(runner.MATCH_FIXTURE)
RESULT = [app(LABELS['result back']), app(LABELS['result header']), app(f'{CARD.client_name}\n{CARD.via_line}'),
          app(CARD.title), app(CARD.call_label), app('WhatsApp us')]


def context_for(phone: ScriptedPhone, fake_api: ScriptedFakeApi) -> tuple[RunContext, FakeClock]:
    clock = FakeClock()
    driver = Driver(phone, APP, monotonic=clock.monotonic, sleep=clock.sleep)
    return RunContext(driver, phone, fake_api, CARD), clock


def match_journey_phone(fake_api: ScriptedFakeApi, *, does_dialler_open: bool = False) -> ScriptedPhone:
    return ScriptedPhone(
        screens={
            'home': HOME,
            'permission': [app('Back'), app(LABELS['permission heading']), app(LABELS['allow microphone']),
                           app('Not now')],
            'system dialog': [('Allow Look Up (dev) to record audio?', SYSTEM_DIALOG, ''),
                              ('While using the app', SYSTEM_DIALOG,
                               f'{SYSTEM_DIALOG}:id/permission_allow_foreground_only_button'),
                              ("Don't allow", SYSTEM_DIALOG, f'{SYSTEM_DIALOG}:id/permission_deny_button')],
            'listening': [app('Cancel listening'), app(LABELS['listening heading']), app('8 seconds left')],
            'result': RESULT,
            'copy sheet': [app(LABELS['copy sheet heading']), app(CARD.call_number_display),
                           app(LABELS['copy number']), app(LABELS['copy sheet close'])],
            'dialler': [('Phone', 'com.android.dialer', '')],
        },
        taps={('home', LABELS['identify control']): 'permission',
              ('permission', LABELS['allow microphone']): 'system dialog',
              ('system dialog', 'While using the app'): 'listening',
              ('result', CARD.call_label): 'dialler' if does_dialler_open else 'copy sheet',
              ('copy sheet', LABELS['copy sheet close']): 'result',
              ('result', LABELS['result back']): 'home'},
        moves_after_reads={'listening': (2, 'result')},
        on_enter={'result': lambda: fake_api.receive_recognize() if not fake_api.requests else None},
    )


class JourneyTest(unittest.TestCase):
    def test_the_match_journey_allows_the_microphone_and_reaches_the_copy_sheet(self) -> None:
        fake_api = ScriptedFakeApi()
        phone = match_journey_phone(fake_api)
        context, _ = context_for(phone, fake_api)

        detail = runner.identify_after_allowing_microphone(context)

        self.assertEqual(phone.tapped, [LABELS['identify control'], LABELS['allow microphone'], 'While using the app',
                                        CARD.call_label, LABELS['copy sheet close'], LABELS['result back']])
        self.assertEqual(phone.current, 'home')
        self.assertIn('+260 97 712 3456', detail)
        self.assertIn('Listening seen', detail)

    def test_the_match_journey_fails_when_the_call_button_opens_a_dialler(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(match_journey_phone(fake_api, does_dialler_open=True), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.identify_after_allowing_microphone(context)

        self.assertIn(repr(LABELS['copy sheet heading']), str(failure.exception))
        self.assertIn('nothing of zm.lookup.listener.development', str(failure.exception))

    def test_the_match_journey_fails_when_the_fake_answered_something_else(self) -> None:
        fake_api = ScriptedFakeApi()
        fake_api.queued = ['no-match']   # left over from an earlier journey
        context, _ = context_for(match_journey_phone(fake_api), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.identify_after_allowing_microphone(context)

        self.assertIn("the fake answered ['no-match'], not ['match']", str(failure.exception))

    def busy_phone(self, fake_api: ScriptedFakeApi, second_key: str) -> ScriptedPhone:
        return ScriptedPhone(
            screens={'home': HOME, 'listening': [app(LABELS['listening heading'])],
                     'busy': [app('Close'), app(LABELS['busy heading']), app('2 s')], 'result': RESULT},
            taps={('home', LABELS['identify control']): 'listening', ('result', LABELS['result back']): 'home'},
            moves_after_reads={'listening': (1, 'busy'), 'busy': (1, 'result')},
            on_enter={'busy': lambda: fake_api.receive_recognize('key-1', '11111111-0000-4000-8000-000000000000'),
                      'result': lambda: fake_api.receive_recognize(second_key, '22222222-0000-4000-8000-000000000000')})

    def test_busy_then_retry_passes_with_one_key(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(self.busy_phone(fake_api, 'key-1'), fake_api)

        detail = runner.identify_when_busy(context)

        self.assertEqual(fake_api.queued, [])
        self.assertIn('Busy seen', detail)
        self.assertIn('key-1', detail)

    def test_busy_then_retry_fails_when_the_resend_carries_another_key(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(self.busy_phone(fake_api, 'key-2'), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.identify_when_busy(context)

        self.assertIn('2 idempotency keys', str(failure.exception))

    def error_phone(self, fake_api: ScriptedFakeApi, shown_code: str) -> ScriptedPhone:
        return ScriptedPhone(
            screens={'home': HOME, 'listening': [app(LABELS['listening heading'])],
                     'error': [app('Close'), app(LABELS['error heading']),
                               app(f"{LABELS['reference code label']}\n{shown_code}"), app('Copy'),
                               app('Try again'), app(LABELS['back to home'])]},
            taps={('home', LABELS['identify control']): 'listening', ('error', LABELS['back to home']): 'home'},
            moves_after_reads={'listening': (1, 'error')},
            on_enter={'error': fake_api.receive_recognize})

    def test_the_error_screen_shows_the_code_of_the_echoed_request_id(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(self.error_phone(fake_api, '6F1C-2D3E'), fake_api)

        self.assertIn('reference code 6F1C-2D3E', runner.identify_with_server_error(context))

    def test_the_error_journey_fails_on_another_code(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(self.error_phone(fake_api, '0000-0001'), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.identify_with_server_error(context)

        self.assertIn("does not show ['6F1C-2D3E']", str(failure.exception))

    def test_a_restart_that_registers_again_fails(self) -> None:
        fake_api = ScriptedFakeApi()
        phone = ScriptedPhone({'home': HOME}, {},
                              on_enter={'home': lambda: fake_api.requests.append(
                                  {'method': 'POST', 'path': runner.INSTALLS_PATH, 'request_id': 'id'})})
        context, _ = context_for(phone, fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.restart_makes_no_new_registration(context)

        self.assertIn('1 new /installs calls', str(failure.exception))
        self.assertEqual((phone.stops, phone.launches), ([APP], [APP]))


class DriverTest(unittest.TestCase):
    def test_a_wait_that_times_out_says_what_the_screen_showed(self) -> None:
        context, clock = context_for(ScriptedPhone({'home': HOME}, {}), ScriptedFakeApi())

        with self.assertRaises(StepFailed) as failure:
            context.driver.wait_for('Found it', 10)

        self.assertIn("waited 10 s for 'Found it'", str(failure.exception))
        self.assertIn(LABELS['home heading'], str(failure.exception))
        self.assertGreaterEqual(clock.now, 10)

    def test_a_screen_that_cannot_be_read_is_counted_not_failed(self) -> None:
        class BusyScreenPhone(ScriptedPhone):
            def read_screen(self) -> Screen:
                return parse_screen_dump('ERROR: could not get idle state.')

        context, _ = context_for(BusyScreenPhone({'home': HOME}, {}), ScriptedFakeApi())

        observation = context.driver.observe(LABELS['listening heading'], 2)

        self.assertFalse(observation.is_seen)
        self.assertEqual(observation.readable_count, 0)
        self.assertGreater(observation.unreadable_count, 0)

    def test_expect_all_scrolls_for_what_is_out_of_view_and_scrolls_back(self) -> None:
        phone = ScriptedPhone({'top': [app('Found it')], 'lower': [app('Call us')]}, {}, start='top')
        original_swipe = phone.swipe

        def swipe(start: tuple[int, int], end: tuple[int, int]) -> None:
            original_swipe(start, end)
            phone.move('lower' if start[1] > end[1] else 'top')

        phone.swipe = swipe   # type: ignore[method-assign]
        context, _ = context_for(phone, ScriptedFakeApi())

        with self.assertRaises(StepFailed):
            context.driver.expect_all(['Found it', 'Missing label'], swipes=2)
        context.driver.expect_all(['Call us'], swipes=2)

        self.assertEqual(phone.current, 'top')


class RunJourneysTest(unittest.TestCase):
    def test_a_failed_journey_saves_the_screen_restarts_the_app_and_the_next_one_runs(self) -> None:
        phone = ScriptedPhone({'home': HOME}, {})
        context, _ = context_for(phone, ScriptedFakeApi())

        def failing(_: RunContext) -> str:
            raise StepFailed('the result never came')

        outcomes = run_journeys(context, [('first', failing), ('second', lambda _: 'fine')], first_number=6)

        self.assertEqual([(outcome.name, outcome.is_passed) for outcome in outcomes], [('first', False),
                                                                                         ('second', True)])
        self.assertEqual(outcomes[0].detail, 'the result never came. The fake API saw: nothing')
        self.assertEqual(phone.evidence, ['06-first'])
        self.assertEqual(outcomes[0].evidence, ['06-first.xml'])
        self.assertEqual((phone.stops, phone.launches), ([APP], [APP]))

    def test_a_request_the_fake_refused_fails_the_journey_that_sent_it(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(ScriptedPhone({'home': HOME}, {}), fake_api)

        def sends_a_bad_request(_: RunContext) -> str:
            fake_api.requests.append({'method': 'POST', 'path': RECOGNIZE_PATH, 'refused': 'codec must be aac or opus'})
            return 'looked fine on screen'

        outcomes = run_journeys(context, [('bad request', sends_a_bad_request)])

        self.assertFalse(outcomes[0].is_passed)
        self.assertIn('codec must be aac or opus', outcomes[0].detail)

    def test_when_the_app_cannot_come_back_the_remaining_journeys_are_marked_not_run(self) -> None:
        phone = ScriptedPhone({'home': [app('Something else')]}, {})
        context, _ = context_for(phone, ScriptedFakeApi())

        def failing(_: RunContext) -> str:
            raise StepFailed('broken')

        outcomes = run_journeys(context, [('first', failing), ('second', lambda _: 'fine')])

        self.assertEqual([outcome.is_passed for outcome in outcomes], [False, False])
        self.assertTrue(outcomes[1].detail.startswith('not run: the app could not be brought back to Home'))


if __name__ == '__main__':
    unittest.main()
