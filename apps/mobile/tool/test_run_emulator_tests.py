"""Tests the emulator runner's pure parts without a device (design §4.7): reading a uiautomator dump, finding
nodes by label, the values the checks expect, and the journeys themselves, driven against a scripted phone
and a scripted fake API with a fake clock. Standard library only:

    python -m unittest tool/test_run_emulator_tests.py
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parent))

import run_emulator_tests as runner  # noqa: E402  (the tool folder is put on the path first)
from run_emulator_tests import (  # noqa: E402
    LABELS, RECOGNIZE_PATH, CardExpectation, Driver, DumpedNotification, NoAnswer, RunContext, Screen, StepFailed,
    active_default_network, airplane_mode_setting, docker_process_names, emulator_serials, find_nodes,
    find_permission_allow_button, has_notification_shade, new_no_answers, no_answers_in_device_log, node_to_tap,
    notifications_in_dumpsys, parse_screen_dump, parse_window_size, phone_number_display, ping_reached,
    private_values_in_device_log, problems_with_request_sizes, problems_with_sends, process_names_from_tasklist,
    reference_code_for_request_id, refused_requests, requests_to, run_journeys)

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
        # The fixture's own call number, read here apart from the expectation, so the check follows the shared
        # fixture when its sample numbers change (P6-D29) and still fails if another action's number were taken.
        actions = json.loads(runner.MATCH_FIXTURE.read_text(encoding='utf-8'))['response']['result']['card']['actions']
        call_number = next(action['phone_number_e164'] for action in actions if action['type'] == 'CALL')
        other_numbers = {action.get('phone_number_e164') for action in actions if action['type'] != 'CALL'}

        self.assertEqual(card, CardExpectation('Summer service offer', 'Brand A', 'via Station A · 98.1 FM', 'Call us',
                                               phone_number_display(call_number)))
        self.assertNotIn(call_number, other_numbers)

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

    def test_the_device_keeps_the_window_size_until_told_to_forget_it(self) -> None:
        class SizedDevice(runner.AdbDevice):
            def __init__(self) -> None:
                super().__init__('adb', 'emulator-5584', Path('evidence'))
                self.wm_size_output = 'Physical size: 1080x2400\n'
                self.size_reads = 0

            def adb(self, *arguments: str, timeout_seconds: float = 60, check: bool = True) -> str:
                self.size_reads += 1
                return self.wm_size_output

        device = SizedDevice()
        self.assertEqual(device.screen_size(), (1080, 2400))
        device.wm_size_output = 'Physical size: 1080x2400\nOverride size: 720x1600\n'
        self.assertEqual(device.screen_size(), (1080, 2400))   # kept: wm size is not asked again
        self.assertEqual(device.size_reads, 1)

        device.forget_screen_size()

        self.assertEqual(device.screen_size(), (720, 1600))
        self.assertEqual(device.size_reads, 2)


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


class DeviceLogPrivacyTest(unittest.TestCase):
    """S4-PRIVACY-04: the device log after the journeys holds no install id, token, phone number, body or audio."""

    INSTALL_ID = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f'
    LOG = {'requests': [{'path': '/api/v1/installs', 'install_id': INSTALL_ID}]}
    QUIET_LOG = '10-08 21:46:22.761  2153  2174 I flutter : Using the Impeller rendering backend (OpenGLES).\n' * 40

    def test_an_ordinary_device_log_passes(self) -> None:
        self.assertEqual(private_values_in_device_log(self.QUIET_LOG, self.LOG), [])

    def test_each_private_value_is_found_and_named_never_repeated(self) -> None:
        cases = {
            'an install id': f'I flutter : registered {self.INSTALL_ID}',
            'an install token': 'I flutter : token fake.AbCdEfGhIjKlMnOpQrSt0123.token',
            'an Authorization header': 'I flutter : Authorization: Bearer x',
            'a phone number from a card': 'I flutter : calling +260977123456',
            'a safe test number from a card': 'I flutter : calling +447700900001',
            'a request body': 'I flutter : {"idempotency_key": "x"}',
            'audio bytes': 'I flutter : ....ftypM4A ....',
        }
        for name, line in cases.items():
            problems = private_values_in_device_log(self.QUIET_LOG + line, self.LOG)
            self.assertIn('a phone number from a card' if 'number' in name else name, problems, line)
            self.assertNotIn(self.INSTALL_ID, ' '.join(problems))

    def test_the_apps_no_answer_line_holds_nothing_private(self) -> None:
        line = ('10-11 09:00:01.250  2153  2174 I flutter : {"time":"2026-10-11T09:00:01.250Z","event":'
                '"api request without answer","method":"POST","path":"recognize","noAnswerReason":"connectionDropped",'
                '"durationMilliseconds":250,"requestId":"0b5c3f0e-2c1d-4e5f-8a9b-0c1d2e3f4a5b"}\n')
        self.assertEqual(private_values_in_device_log(self.QUIET_LOG + line, self.LOG), [])


class RequestSizeTest(unittest.TestCase):
    """S4-REQUEST-02: every recognize request at most 32,768 bytes, carrying at least 16,000 bytes of audio."""

    @staticmethod
    def log_of(*sizes: tuple[int, int]) -> dict[str, Any]:
        return {'requests': [{**recognize_request('match', 'key-1', f'id-{number}'), 'body_bytes': body_bytes,
                              'audio_bytes': audio_bytes}
                             for number, (body_bytes, audio_bytes) in enumerate(sizes, start=1)]}

    def test_requests_of_real_clips_inside_the_limit_pass(self) -> None:
        self.assertEqual(problems_with_request_sizes(self.log_of((26_310, 25_120), (32_768, 16_000))), [])

    def test_a_body_over_32_768_bytes_fails_with_its_size(self) -> None:
        problems = problems_with_request_sizes(self.log_of((26_310, 25_120), (32_769, 31_500)))

        self.assertEqual(len(problems), 1)
        self.assertIn('recognize request 2', problems[0])
        self.assertIn('a body of 32769 bytes, over 32,768', problems[0])

    def test_a_clip_under_16_000_bytes_fails_with_its_size(self) -> None:
        problems = problems_with_request_sizes(self.log_of((17_000, 15_999)))

        self.assertEqual(len(problems), 1)
        self.assertIn('15999 bytes of audio, under 16,000', problems[0])

    def test_a_request_cut_off_by_no_signal_or_the_update_gate_is_not_measured(self) -> None:
        log = {'requests': [
            {'path': runner.RECOGNIZE_PATH, 'body_bytes': 27_000, 'audio_bytes': 26_000, 'scenario': 'match'},
            {'path': runner.RECOGNIZE_PATH, 'dropped': 'offline'},
            {'path': runner.RECOGNIZE_PATH, 'request_id': 'id-2', 'update_required': True},
        ]}
        self.assertEqual(problems_with_request_sizes(log), [])
        fake_api = ScriptedFakeApi()
        fake_api.requests = log['requests']
        self.assertIn('1 recognize requests: bodies 27,000-27,000 bytes', runner.check_recognize_request_sizes(fake_api))

    def test_a_request_with_no_sizes_or_no_request_at_all_fails(self) -> None:
        self.assertIn('no recognize request', problems_with_request_sizes({'requests': []})[0])
        unmeasured = {'requests': [recognize_request('match', 'key-1', 'id-1')]}
        self.assertEqual(len(problems_with_request_sizes(unmeasured)), 2)

    def test_the_step_reports_the_sizes_it_measured_and_fails_with_the_numbers(self) -> None:
        fake_api = ScriptedFakeApi()
        fake_api.requests = self.log_of((26_310, 25_120), (27_002, 25_801))['requests']

        detail = runner.check_recognize_request_sizes(fake_api)

        self.assertIn('2 recognize requests: bodies 26,310-27,002 bytes', detail)
        self.assertIn('audio 25,120-25,801 bytes', detail)
        fake_api.requests[1]['body_bytes'] = 40_000
        with self.assertRaises(StepFailed) as failure:
            runner.check_recognize_request_sizes(fake_api)
        self.assertIn('a body of 40000 bytes', str(failure.exception))


def no_answer_line(reason: str, request_id: str, *, path: str = 'recognize', event: str = 'api request without answer',
                   fault: str | None = None, duration: int = 250) -> str:
    """One line of the app's development log as logcat prints it."""
    entry = {'time': '2026-10-11T09:00:01.250Z', 'event': event, 'method': 'POST', 'path': path,
             'noAnswerReason': reason, 'durationMilliseconds': duration, 'requestId': request_id}
    if fault:
        entry['faultTypeName'] = fault
    return f'10-11 09:00:01.250  2153  2174 I flutter : {json.dumps(entry)}\n'


class NoAnswerReasonTest(unittest.TestCase):
    """P6 design fact 21: every step's evidence carries the app's own reason when a request got no answer."""

    def test_the_apps_no_answer_lines_are_read_with_their_reason(self) -> None:
        log = ('10-11 09:00:00.000  2153  2174 I flutter : Using the Impeller rendering backend (OpenGLES).\n'
               + no_answer_line('connectionDropped', 'id-1')
               + no_answer_line('unexpectedFailure', 'id-2', path='installs', fault='StateError', duration=40)
               + no_answer_line('timedOut', 'id-3', event='api request'))

        self.assertEqual(no_answers_in_device_log(log), [
            NoAnswer('POST', 'recognize', 'connectionDropped', 'id-1', 250),
            NoAnswer('POST', 'installs', 'unexpectedFailure', 'id-2', 40, 'StateError'),
            NoAnswer('POST', 'recognize', 'timedOut', 'id-3', 250),
        ])
        self.assertEqual(no_answers_in_device_log(log)[1].describe(),
                         'POST installs: unexpectedFailure (StateError) after 40 ms (request id id-2)')

    def test_nothing_else_in_the_log_passes_for_a_reason(self) -> None:
        log = ('I flutter : {"event":"api request","method":"POST","path":"recognize","status":200}\n'
               + no_answer_line('networkIsSad', 'id-1')
               + no_answer_line('connectionDropped', 'id-2', event='uncaught error')
               + 'I flutter : {not json\n'
               + 'I flutter : {"noAnswerReason": "timedOut"}\n')

        self.assertEqual(no_answers_in_device_log(log), [])

    def test_only_the_journeys_own_no_answers_are_new(self) -> None:
        earlier = no_answers_in_device_log(no_answer_line('connectionDropped', 'id-1'))
        later = no_answers_in_device_log(no_answer_line('connectionDropped', 'id-1') + no_answer_line('timedOut', 'id-2'))

        self.assertEqual(new_no_answers(earlier, later), [NoAnswer('POST', 'recognize', 'timedOut', 'id-2', 250)])
        self.assertEqual(new_no_answers(later, later), [])

    def test_each_journey_records_the_no_answers_it_caused_pass_or_fail(self) -> None:
        phone = ScriptedPhone({'home': HOME}, {})
        phone.device_log = no_answer_line('noConnection', 'from-before')
        context, _ = context_for(phone, ScriptedFakeApi())

        def dropped(_: RunContext) -> str:
            phone.device_log += no_answer_line('connectionDropped', 'id-2')
            return 'No connection shown'

        def fails_after_a_timeout(_: RunContext) -> str:
            phone.device_log += no_answer_line('timedOut', 'id-3', duration=15_000)
            raise StepFailed('the result never came')

        outcomes = run_journeys(context, [('dropped', dropped), ('timed out', fails_after_a_timeout),
                                          ('answered', lambda _: 'fine')])

        self.assertEqual([outcome.no_answers for outcome in outcomes], [
            ['POST recognize: connectionDropped after 250 ms (request id id-2)'],
            ['POST recognize: timedOut after 15000 ms (request id id-3)'],
            [],
        ])
        self.assertTrue(all(outcome.are_no_answers_read for outcome in outcomes))

    def test_an_unreadable_device_log_is_noted_and_never_fails_the_journey(self) -> None:
        phone = ScriptedPhone({'home': HOME}, {})
        phone.is_device_log_readable = False
        context, _ = context_for(phone, ScriptedFakeApi())

        outcome = run_journeys(context, [('fine', lambda _: 'fine')])[0]

        self.assertTrue(outcome.is_passed)
        self.assertEqual((outcome.no_answers, outcome.are_no_answers_read), ([], False))

    def test_the_record_carries_the_no_answers_and_the_emulator_commands(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            record = runner.RunRecord(Path(folder) / 'run')
            record.steps.append(runner.StepOutcome('dropped', True, 'shown', 1.0,
                                                   no_answers=['POST recognize: connectionDropped']))
            record.emulator_commands = {'airplane_mode': {'works': True}}
            record.write()
            saved = json.loads(record.path.read_text(encoding='utf-8'))

        self.assertEqual(saved['steps'][0]['no_answers'], ['POST recognize: connectionDropped'])
        self.assertTrue(saved['steps'][0]['are_no_answers_read'])
        self.assertEqual(saved['emulator_commands'], {'airplane_mode': {'works': True}})


# What `dumpsys notification --noredact` prints for one notification (Android 13), trimmed.
DUMPSYS_NOTIFICATION = '''Current Notification Manager state:
  Notification List:
    NotificationRecord(0x0e6b3a5f: pkg=com.android.shell user=UserHandle{0} id=2020 tag=lookup-emulator-check importance=3 key=0|com.android.shell|2020|lookup-emulator-check|2000: Notification(channel=shell_cmd shortcut=null contentView=null vibrate=null sound=null defaults=0x0 flags=0x0 color=0x00000000 vis=PRIVATE))
      uid=2000 userId=0
      opPkg=com.android.shell
      extras={
        android.title=String (Look Up emulator check)
        android.reduced.images=Boolean (true)
        android.text=String (Proof that dumpsys reads notifications)
      }
    NotificationRecord(0x0a1b2c3d: pkg=zm.lookup.listener.development user=UserHandle{0} id=7 tag=null importance=3 key=0|zm.lookup.listener.development|7|null|10123: Notification(channel=results))
      extras={
        android.title=String (Look Up)
        android.text=String (Your saved clip has been checked. Tap to see the result.)
      }
'''


def shade_dump(resource_ids: list[str], package: str = runner.SYSTEM_UI_PACKAGE) -> str:
    nodes = ''.join(f'<node text="" resource-id="{package}:id/{resource_id}" class="android.view.View" '
                    f'package="{package}" content-desc="" clickable="false" bounds="[0,0][1080,{100 + index}]" />'
                    for index, resource_id in enumerate(resource_ids))
    return f'<hierarchy rotation="0">{nodes}</hierarchy>'


class SavedClipChecksTest(unittest.TestCase):
    """The full listener app's piece 3: the checks on a saved clip's sends and its notifications."""

    @staticmethod
    def send(is_deferred: str, sent_at: str, key: str = 'key-1', captured_at: str = '2026-10-13T10:00:00.000Z') -> dict:
        return {'idempotency_key': key, 'captured_at': captured_at, 'is_deferred': is_deferred, 'sent_at': sent_at}

    def test_the_live_send_then_deferred_resends_of_the_same_clip_pass(self) -> None:
        self.assertEqual(runner.deferred_send_problems([
            self.send('false', '2026-10-13T10:00:09.000Z'),
            self.send('true', '2026-10-13T10:01:00.000Z'),
            self.send('true', '2026-10-13T10:02:30.000Z'),
        ]), [])
        self.assertEqual(runner.deferred_send_problems([self.send('true', '2026-10-13T10:05:00.000Z')]), [])

    def test_another_key_another_capture_time_a_live_resend_or_a_stale_send_time_is_a_problem(self) -> None:
        live = self.send('false', '2026-10-13T10:00:09.000Z')
        self.assertIn('more than one idempotency key', runner.deferred_send_problems(
            [live, self.send('true', '2026-10-13T10:01:00.000Z', key='key-2')])[0])
        self.assertIn('more than one capture time', runner.deferred_send_problems(
            [live, self.send('true', '2026-10-13T10:01:00.000Z', captured_at='2026-10-13T10:00:01.000Z')])[0])
        self.assertIn('not marked deferred', runner.deferred_send_problems(
            [live, self.send('false', '2026-10-13T10:01:00.000Z')])[0])
        self.assertIn('send times do not move on', runner.deferred_send_problems(
            [live, self.send('true', '2026-10-13T10:00:09.000Z')])[0])
        self.assertEqual(runner.deferred_send_problems([]), ['the stand-in received no send of the clip'])

    def test_a_notification_with_the_generic_words_passes(self) -> None:
        good = DumpedNotification(APP, runner.NOTIFICATION_TITLE, runner.NOTIFICATION_TEXT)
        self.assertEqual(runner.notification_problems([good], 1), [])
        self.assertEqual(runner.notification_problems([good, good], 2), [])

    def test_a_notification_that_names_the_ad_or_says_other_words_or_a_wrong_count_is_a_problem(self) -> None:
        good = DumpedNotification(APP, runner.NOTIFICATION_TITLE, runner.NOTIFICATION_TEXT)
        naming = DumpedNotification(APP, 'Brand A', 'Summer service offer on Station A')
        problems = runner.notification_problems([naming], 1)
        self.assertEqual(len(problems), 2)
        self.assertIn("names ['Brand A', 'Summer service offer', 'Station A']", problems[1])
        self.assertIn('2 notifications of the app, not 1', runner.notification_problems([good, good], 1)[0])
        self.assertIn('0 notifications of the app, not 1', runner.notification_problems([], 1)[0])

    def test_the_notification_words_are_the_apps_own(self) -> None:
        words = json.loads((runner.APP_FOLDER / 'lib' / 'l10n' / 'app_en.arb').read_text(encoding='utf-8'))
        self.assertEqual(runner.NOTIFICATION_TITLE, words['savedClipNotificationTitle'])
        self.assertEqual(runner.NOTIFICATION_TEXT, words['savedClipNotificationText'])

    def test_the_saved_clip_labels_are_the_apps_own_words(self) -> None:
        words = json.loads((runner.APP_FOLDER / 'lib' / 'l10n' / 'app_en.arb').read_text(encoding='utf-8'))
        for label, key in [('saved no connection', 'savedOfflineHeadingNoConnection'),
                           ('saved busy', 'savedOfflineHeadingBusy'),
                           ('see it in history', 'savedOfflineSeeInHistoryButton'),
                           ('allow notifications', 'savedOfflineAllowNotificationsButton'),
                           ('notifications allowed', 'savedOfflineNotificationsAllowed'),
                           ('history waiting', 'historyWaitingHeading'),
                           ('pending', 'historyPendingBadge'),
                           ('history choose your station', 'historyAwaitingChoiceDetail')]:
            self.assertEqual(runner.LABELS[label], words[key], label)

    def test_the_waits_the_driver_checks_are_the_stand_ins(self) -> None:
        import fake_listener_api
        self.assertEqual(runner.DEFERRED_SHED_RETRY_AFTER_SECONDS, fake_listener_api.DEFERRED_SHED_RETRY_AFTER_SECONDS)
        self.assertEqual(runner.DEFERRED_LIMITED_RETRY_AFTER_SECONDS,
                         fake_listener_api.DEFERRED_LIMITED_RETRY_AFTER_SECONDS)


class EmulatorCommandOutputTest(unittest.TestCase):
    """P6 design fact 8: reading what the commands later journeys depend on print."""

    def test_notifications_are_read_with_their_title_and_text(self) -> None:
        self.assertEqual(notifications_in_dumpsys(DUMPSYS_NOTIFICATION), [
            DumpedNotification('com.android.shell', 'Look Up emulator check', 'Proof that dumpsys reads notifications'),
            DumpedNotification('zm.lookup.listener.development', 'Look Up',
                               'Your saved clip has been checked. Tap to see the result.'),
        ])
        self.assertEqual([notification.title for notification in
                          notifications_in_dumpsys(DUMPSYS_NOTIFICATION, 'zm.lookup.listener.development')], ['Look Up'])
        self.assertEqual(notifications_in_dumpsys('Current Notification Manager state:\n'), [])

    def test_the_shade_is_found_by_systemuis_own_views(self) -> None:
        self.assertTrue(has_notification_shade(parse_screen_dump(shade_dump(['clock', 'notification_stack_scroller']))))
        self.assertTrue(has_notification_shade(parse_screen_dump(shade_dump(['quick_settings_panel']))))
        self.assertFalse(has_notification_shade(parse_screen_dump(shade_dump(['clock', 'battery']))))
        self.assertFalse(has_notification_shade(parse_screen_dump(shade_dump(['notification_panel'], package=APP))))
        self.assertFalse(has_notification_shade(parse_screen_dump(RESULT_SCREEN_DUMP)))

    def test_airplane_mode_the_active_network_and_a_ping_are_read(self) -> None:
        self.assertEqual([airplane_mode_setting(output) for output in ('1\n', '0\n', 'null\n')], [True, False, None])
        self.assertEqual(active_default_network('NetworkProviders:\nActive default network: 100\n'), '100')
        self.assertEqual(active_default_network('Active default network: none\n'), 'none')
        self.assertIsNone(active_default_network('Current Networks:\n'))
        self.assertTrue(ping_reached('1 packets transmitted, 1 received, 0% packet loss, time 0ms\nexit=0'))
        self.assertFalse(ping_reached('1 packets transmitted, 0 received, 100% packet loss, time 0ms\nexit=1'))
        self.assertFalse(ping_reached('connect: Network is unreachable\nexit=2'))
        self.assertIsNone(ping_reached('/system/bin/sh: ping: not found\nexit=127'))


class ScriptedEmulator(runner.AdbDevice):
    """An emulator whose network follows the commands it is given, as the real one should; [ignores] lists the
    commands this image does not honour, and [stays_offline] an image whose network never comes back."""

    def __init__(self, *, ignores: tuple[str, ...] = (), stays_offline: bool = False) -> None:
        super().__init__('adb', 'emulator-5584', Path('evidence'))
        self.ignores = ignores
        self.stays_offline = stays_offline
        self.airplane_mode = False
        self.wifi = True
        self.data = True
        self.commands: list[str] = []
        self.notifications: list[tuple[str, str]] = []
        self.has_shade = True

    @property
    def is_online(self) -> bool:
        return not self.airplane_mode and (self.wifi or self.data)

    def adb(self, *arguments: str, timeout_seconds: float = 60, check: bool = True) -> str:
        command = ' '.join(arguments[1:]) if arguments and arguments[0] == 'shell' else ' '.join(arguments)
        self.commands.append(command)
        if any(command.startswith(ignored) for ignored in self.ignores):
            return "Unknown command"
        switches = {'cmd connectivity airplane-mode enable': ('airplane_mode', True),
                    'cmd connectivity airplane-mode disable': ('airplane_mode', False),
                    'svc wifi disable': ('wifi', False), 'svc wifi enable': ('wifi', True),
                    'svc data disable': ('data', False), 'svc data enable': ('data', True)}
        if command in switches:
            name, value = switches[command]
            brings_the_network_back = (not value) if name == 'airplane_mode' else value
            if not (self.stays_offline and brings_the_network_back):
                setattr(self, name, value)
            return ''
        if command == 'settings get global airplane_mode_on':
            return '1\n' if self.airplane_mode else '0\n'
        if command == 'dumpsys connectivity':
            return f"Active default network: {'100' if self.is_online else 'none'}\n"
        if command.startswith('ping'):
            return ('1 packets transmitted, 1 received\nexit=0' if self.is_online
                    else 'connect: Network is unreachable\nexit=2')
        if command.startswith('cmd notification post'):
            title, tag, text = re.match(r"cmd notification post -t '(.*)' (\S+) '(.*)'", command).groups()
            self.notifications.append((title, text))
            return 'Notification posted'
        if command == 'dumpsys notification --noredact':
            return ''.join(f'NotificationRecord(0x1: pkg=com.android.shell user=UserHandle{{0}} id=1)\n'
                           f'  extras={{\n    android.title=String ({title})\n    android.text=String ({text})\n  }}\n'
                           for title, text in self.notifications)
        return ''

    def read_screen(self) -> Screen:
        return parse_screen_dump(shade_dump(['notification_stack_scroller'] if self.has_shade else ['clock']))

    def save_evidence(self, name: str, screen: Screen | None) -> list[str]:
        return [f'{name}.xml']


def proof_driver(device: runner.AdbDevice) -> Driver:
    clock = FakeClock()
    return Driver(device, APP, monotonic=clock.monotonic, sleep=clock.sleep)


class EmulatorCommandProofTest(unittest.TestCase):
    def test_airplane_mode_is_proved_and_the_network_is_back_afterwards(self) -> None:
        emulator = ScriptedEmulator()
        result = runner.prove_network_switch(emulator, proof_driver(emulator), runner.AIRPLANE_MODE_OFF_COMMANDS,
                                             runner.AIRPLANE_MODE_ON_COMMANDS)

        self.assertTrue(result['works'])
        self.assertEqual(result['while_off'], {'airplane_mode': True, 'active_default_network': 'none',
                                               'reaches_the_pc': False})
        self.assertEqual(result['after']['active_default_network'], '100')
        self.assertTrue(emulator.is_online)
        self.assertEqual(result['commands_off'], ['cmd connectivity airplane-mode enable'])

    def test_a_command_the_image_ignores_is_recorded_as_not_working_and_the_switch_back_still_runs(self) -> None:
        emulator = ScriptedEmulator(ignores=('cmd connectivity airplane-mode',))
        result = runner.prove_network_switch(emulator, proof_driver(emulator), runner.AIRPLANE_MODE_OFF_COMMANDS,
                                             runner.AIRPLANE_MODE_ON_COMMANDS)

        self.assertEqual((result['works'], result['network_went']), (False, False))
        self.assertIn('cmd connectivity airplane-mode disable', emulator.commands)
        self.assertEqual(result['outputs'], ['Unknown command', 'Unknown command'])

    def test_svc_wifi_and_data_both_go_off_and_come_back(self) -> None:
        emulator = ScriptedEmulator()
        result = runner.prove_network_switch(emulator, proof_driver(emulator), runner.RADIOS_OFF_COMMANDS,
                                             runner.RADIOS_ON_COMMANDS)

        self.assertTrue(result['works'])
        self.assertEqual(result['commands_on'], ['svc wifi enable', 'svc data enable'])
        self.assertTrue(emulator.wifi and emulator.data)

    def test_a_network_that_does_not_come_back_is_recorded(self) -> None:
        emulator = ScriptedEmulator(stays_offline=True)
        result = runner.prove_network_switch(emulator, proof_driver(emulator), runner.RADIOS_OFF_COMMANDS,
                                             runner.RADIOS_ON_COMMANDS)

        self.assertEqual((result['network_went'], result['network_came_back'], result['works']), (True, False, False))

    def test_a_posted_notification_is_read_back_through_dumpsys(self) -> None:
        emulator = ScriptedEmulator()
        result = runner.prove_notification_read(emulator)

        self.assertEqual((result['works'], result['notifications_listed']), (True, 1))
        self.assertEqual(emulator.notifications, [(runner.PROOF_NOTIFICATION_TITLE, runner.PROOF_NOTIFICATION_TEXT)])

    def test_the_shade_is_looked_for_and_closed_again(self) -> None:
        for has_shade in (True, False):
            with self.subTest(has_shade):
                emulator = ScriptedEmulator()
                emulator.has_shade = has_shade
                result = runner.prove_notification_shade(emulator, proof_driver(emulator))
                self.assertEqual(result['has_shade'], has_shade)
                self.assertEqual(emulator.commands[0], 'cmd statusbar expand-notifications')
                self.assertEqual(emulator.commands[-1], 'cmd statusbar collapse')

    def test_the_step_writes_every_result_and_fails_only_without_a_way_offline_or_a_notification_read(self) -> None:
        record = runner.RunRecord(Path('run'))
        emulator = ScriptedEmulator(ignores=('cmd connectivity airplane-mode',))
        summary = runner.check_emulator_commands(emulator, proof_driver(emulator), record)

        self.assertIn('airplane mode: does not work here', summary)
        self.assertIn('svc wifi and data: works', summary)
        self.assertIn('notification shade: present', summary)
        self.assertEqual(set(record.emulator_commands), {'airplane_mode', 'wifi_and_data_off', 'dumpsys_notification',
                                                         'notification_shade'})

        emulator = ScriptedEmulator(ignores=('cmd connectivity airplane-mode', 'svc'))
        with self.assertRaises(StepFailed) as failure:
            runner.check_emulator_commands(emulator, proof_driver(emulator), runner.RunRecord(Path('run')))
        self.assertIn('svc wifi and data: does not work here', str(failure.exception))

    def test_a_proof_that_breaks_is_recorded_and_the_others_still_run(self) -> None:
        class BrokenShade(ScriptedEmulator):
            def read_screen(self) -> Screen:
                raise OSError('uiautomator is gone')

        emulator = BrokenShade()
        results = runner.prove_emulator_commands(emulator, proof_driver(emulator))

        self.assertEqual(results['notification_shade'], {'works': False, 'error': 'OSError: uiautomator is gone'})
        self.assertTrue(results['airplane_mode']['works'])
        self.assertIn('notification shade: failed (OSError: uiautomator is gone)',
                      runner.describe_emulator_commands(results))

    def test_the_command_line_can_ask_for_the_proofs_alone(self) -> None:
        calls: list[dict[str, Any]] = []
        originals = (runner.find_tools, runner.reasons_not_to_start, runner.run, runner.RunRecord.write)
        try:
            runner.find_tools = lambda: runner.Tools('adb', 'emulator', 'flutter')
            runner.reasons_not_to_start = lambda tools: []
            runner.run = lambda tools, record, skip_build, **keywords: calls.append(keywords)
            runner.RunRecord.write = lambda record: None
            with contextlib.redirect_stdout(io.StringIO()):
                runner.main(['--prove-emulator-commands'])
                runner.main([])
        finally:
            runner.find_tools, runner.reasons_not_to_start, runner.run, runner.RunRecord.write = originals
        self.assertEqual(calls, [{'proves_commands_only': True}, {'proves_commands_only': False}])


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
        self.cleared: list[str] = []
        self.evidence: list[str] = []
        self.device_log = ''
        self.is_device_log_readable = True

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

    def clear_app_data(self, package_name: str) -> None:
        self.cleared.append(package_name)

    def save_evidence(self, name: str, screen: Screen | None) -> list[str]:
        self.evidence.append(name)
        return [f'{name}.xml']

    def read_device_log(self) -> str:
        if not self.is_device_log_readable:
            raise StepFailed('adb logcat failed')
        return self.device_log


class ScriptedFakeApi:
    def __init__(self) -> None:
        self.queued: list[str] = []
        self.requests: list[dict[str, Any]] = []
        self.reports: list[dict[str, Any]] = []
        self.is_offline = False
        # Choices the scripted app has queued in its outbox; they reach the fake once "No signal" is off.
        self.outbox: list[dict[str, str]] = []
        # Reports the scripted app has queued in its outbox; they reach the fake once "No signal" is off.
        self.report_outbox: list[dict[str, str]] = []
        self.choices: list[dict[str, str]] = []
        self.station_list_requests = 0

    def queue(self, scenario_names: list[str]) -> None:
        self.queued.extend(scenario_names)

    def request_log(self) -> dict[str, Any]:
        self.deliver_outbox()
        return {'requests': [dict(request) for request in self.requests], 'client_error_reports': list(self.reports)}

    def reset(self) -> None:
        self.__init__()

    def set_offline(self, is_offline: bool) -> None:
        self.is_offline = is_offline

    def state(self) -> dict[str, Any]:
        self.deliver_outbox()
        return {'is_offline': self.is_offline, 'choices': [dict(choice) for choice in self.choices],
                'station_list_requests': self.station_list_requests,
                'recognitions': [{'scenario': request.get('scenario'), 'station_hint': request.get('station_hint')}
                                 for request in self.requests if request.get('path') == RECOGNIZE_PATH]}

    def deliver_outbox(self, *, even_offline: bool = False) -> None:
        """Sends what the scripted app's outbox holds, as the app does once the fake answers again: one request per
        item, and the first choice per recognition kept, as the real fake keeps it."""
        if self.is_offline and not even_offline:
            return
        for choice in self.outbox:
            self.requests.append({'method': 'POST', 'path': f"/api/v1/recognitions/{choice['recognition_id']}/choice",
                                  'request_id': f'choice-{len(self.requests)}', 'station_id': choice['station_id']})
            if all(kept['recognition_id'] != choice['recognition_id'] for kept in self.choices):
                self.choices.append(dict(choice))
        self.outbox = []
        for report in self.report_outbox:
            self.requests.append({'method': 'POST', 'path': f"/api/v1/recognitions/{report['recognition_id']}/report",
                                  'request_id': f'report-{len(self.requests)}', **report, 'scenario': 'report-recorded',
                                  'report': 'reported'})
        self.report_outbox = []

    def receive_recognize(self, idempotency_key: str = 'key-1',
                          request_id: str = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f', *,
                          station_hint: str | None = None) -> None:
        scenario = self.queued.pop(0) if self.queued else 'match'
        self.requests.append({**recognize_request(scenario, idempotency_key, f'{request_id}'),
                              'station_hint': station_hint})


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
        self.assertIn(CARD.call_number_display, detail)
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
                     'busy': [app('Close'), app(LABELS['busy heading']), app('6 s')], 'result': RESULT},
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

    def test_busy_then_retry_fails_when_busy_never_shows(self) -> None:
        fake_api = ScriptedFakeApi()

        def answer_busy_then_match() -> None:
            fake_api.receive_recognize('key-1', '11111111-0000-4000-8000-000000000000')
            fake_api.receive_recognize('key-1', '22222222-0000-4000-8000-000000000000')

        phone = ScriptedPhone(
            screens={'home': HOME, 'listening': [app(LABELS['listening heading'])], 'result': RESULT},
            taps={('home', LABELS['identify control']): 'listening', ('result', LABELS['result back']): 'home'},
            moves_after_reads={'listening': (1, 'result')},
            on_enter={'result': answer_busy_then_match})
        context, _ = context_for(phone, fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.identify_when_busy(context)

        self.assertIn('Busy never showed', str(failure.exception))
        self.assertIn(f'Retry-After {runner.BUSY_RETRY_AFTER_SECONDS} s', str(failure.exception))

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


# ---- The full listener app, pieces 1 and 2 (P6 design §4.8 steps 1-5 and 17) -------------------------------

STATION_A, STATION_B = runner.CHOOSER_STATIONS
CHOOSER_RECOGNITION_ID = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70'
TABS = [app(LABELS['tab identify']), app(LABELS['tab history']), app(LABELS['tab settings'])]
HOME_WITH_TABS = [*HOME, *TABS]
LISTENING = [app('Cancel listening'), app(LABELS['listening heading'])]
CHOOSER = [app(LABELS['chooser title']), app(LABELS['chooser lead']), app(STATION_A.spoken_label),
           app(STATION_B.spoken_label), app(LABELS['chooser remember']), app(LABELS['chooser cancel'])]
RESULT_OF_STATION_B = [app(LABELS['result back']), app(LABELS['result header']),
                       app(f'{CARD.client_name}\n{STATION_B.via_line}'), app(CARD.title), app(CARD.call_label),
                       app(LABELS['saved to history'])]
HISTORY_ROW = f'{CARD.history_title}\nvia Station A \u00b7 Today, 13:05'
MY_STATION_ROW = 'My station\nNot set \u2014 used when an ad is on more than one station'


def chooser_phone(fake_api: ScriptedFakeApi, *, choice_sends: int = 1, is_sent_with_no_signal: bool = False,
                  shows_result: str = 'result of station b') -> ScriptedPhone:
    """Identify gives "Which station?"; a tap on Station B shows its Result and queues the choice in the outbox."""
    def choose_station_b() -> None:
        fake_api.outbox.extend({'recognition_id': CHOOSER_RECOGNITION_ID, 'station_id': STATION_B.station_id}
                               for _ in range(choice_sends))
        if is_sent_with_no_signal:
            fake_api.deliver_outbox(even_offline=True)

    return ScriptedPhone(
        screens={'home': HOME_WITH_TABS, 'listening': LISTENING, 'chooser': CHOOSER,
                 'result of station b': RESULT_OF_STATION_B, 'result of station a': RESULT},
        taps={('home', LABELS['identify control']): 'listening',
              ('chooser', STATION_B.spoken_label): shows_result,
              ('chooser', LABELS['chooser cancel']): 'home',
              ('result of station b', LABELS['result back']): 'home',
              ('result of station a', LABELS['result back']): 'home'},
        moves_after_reads={'listening': (1, 'chooser')},
        on_enter={'chooser': fake_api.receive_recognize, 'result of station b': choose_station_b,
                  'result of station a': choose_station_b},
    )


class FullListenerAppJourneyTest(unittest.TestCase):
    def test_the_stations_come_from_the_fixtures_the_stand_in_answers_with(self) -> None:
        self.assertEqual([station.spoken_label for station in runner.CHOOSER_STATIONS],
                         ['Station A, 98.1 FM, Lusaka', 'Station B, 104.3 FM, Kitwe'])
        self.assertEqual(STATION_B.via_line, 'via Station B \u00b7 104.3 FM')
        self.assertEqual([station.station_id for station in runner.LISTED_STATIONS],
                         [station.station_id for station in runner.CHOOSER_STATIONS])
        self.assertEqual(CARD.history_title, 'Brand A \u2014 Summer service offer')

    def test_the_chooser_journey_taps_station_b_with_no_signal_and_sees_one_choice_after_it(self) -> None:
        fake_api = ScriptedFakeApi()
        phone = chooser_phone(fake_api)
        context, _ = context_for(phone, fake_api)

        detail = runner.choose_a_station_with_no_signal(context)

        self.assertEqual(phone.tapped, [LABELS['identify control'], STATION_B.spoken_label, LABELS['result back']])
        self.assertEqual(fake_api.choices, [{'recognition_id': CHOOSER_RECOGNITION_ID,
                                             'station_id': STATION_B.station_id}])
        self.assertFalse(fake_api.is_offline, '"No signal" is switched off again')
        self.assertIn('Station B shown at once with no signal', detail)

    def test_the_chooser_journey_fails_when_a_choice_arrives_with_no_signal(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(chooser_phone(fake_api, is_sent_with_no_signal=True), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.choose_a_station_with_no_signal(context)

        self.assertIn('while "No signal" was on', str(failure.exception))
        self.assertFalse(fake_api.is_offline, '"No signal" is switched off even when the journey fails')

    def test_the_chooser_journey_fails_when_the_choice_is_sent_twice(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(chooser_phone(fake_api, choice_sends=2), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.choose_a_station_with_no_signal(context)

        self.assertIn('after 2 answered choice requests', str(failure.exception))

    def test_the_chooser_journey_fails_when_the_result_is_another_stations(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(chooser_phone(fake_api, shows_result='result of station a'), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.choose_a_station_with_no_signal(context)

        self.assertIn(STATION_B.via_line, str(failure.exception))

    def test_the_chooser_journey_fails_when_no_choice_ever_arrives(self) -> None:
        fake_api = ScriptedFakeApi()
        context, clock = context_for(chooser_phone(fake_api, choice_sends=0), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.choose_a_station_with_no_signal(context)

        self.assertIn('the choice to reach the fake', str(failure.exception))
        self.assertGreaterEqual(clock.now, runner.SECONDS_FOR_AN_OUTBOX_RETRY)

    def remembered_phone(self, fake_api: ScriptedFakeApi, *, hint: str | None, shows_chooser: bool = False
                         ) -> ScriptedPhone:
        after_listening = 'chooser' if shows_chooser else 'result of station b'
        return ScriptedPhone(
            screens={'home': HOME_WITH_TABS, 'listening': LISTENING, 'chooser': CHOOSER,
                     'result of station b': RESULT_OF_STATION_B},
            taps={('home', LABELS['identify control']): 'listening',
                  ('result of station b', LABELS['result back']): 'home'},
            moves_after_reads={'listening': (1, after_listening)},
            on_enter={after_listening: lambda: fake_api.receive_recognize(station_hint=hint)},
        )

    def test_the_remember_journey_sees_the_hint_and_no_sheet(self) -> None:
        fake_api = ScriptedFakeApi()
        phone = self.remembered_phone(fake_api, hint=STATION_B.station_id)
        context, _ = context_for(phone, fake_api)

        detail = runner.remembered_station_skips_the_sheet(context)

        self.assertEqual(phone.current, 'home')
        self.assertIn('carried Station B as its hint', detail)

    def test_the_remember_journey_fails_without_the_hint(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(self.remembered_phone(fake_api, hint=None), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.remembered_station_skips_the_sheet(context)

        self.assertIn('carried the hint None', str(failure.exception))

    def test_the_remember_journey_fails_when_the_sheet_shows(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(self.remembered_phone(fake_api, hint=STATION_B.station_id, shows_chooser=True),
                                 fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.remembered_station_skips_the_sheet(context)

        self.assertIn('the sheet "Which station?" showed', str(failure.exception))

    def test_the_cancel_journey_goes_home_and_sees_no_choice(self) -> None:
        fake_api = ScriptedFakeApi()
        phone = chooser_phone(fake_api)
        context, _ = context_for(phone, fake_api)

        self.assertEqual(runner.cancel_on_the_sheet_chooses_nothing(context), 'Home, and no choice sent')
        self.assertEqual(phone.tapped, [LABELS['identify control'], LABELS['chooser cancel']])

    def test_the_cancel_journey_fails_when_a_choice_is_sent_after_cancel(self) -> None:
        fake_api = ScriptedFakeApi()
        phone = chooser_phone(fake_api)
        phone.on_enter['home'] = lambda: fake_api.outbox.append(
            {'recognition_id': CHOOSER_RECOGNITION_ID, 'station_id': STATION_A.station_id})
        context, _ = context_for(phone, fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.cancel_on_the_sheet_chooses_nothing(context)

        self.assertIn('1 choice request(s) reached the fake after Cancel', str(failure.exception))

    def history_phone(self, fake_api: ScriptedFakeApi, *, saved_result_asks: bool = False,
                      result_says_saved: bool = True, sends_the_tap: bool = False) -> ScriptedPhone:
        result = [*RESULT, app(LABELS['saved to history'])] if result_says_saved else RESULT
        on_enter: dict[str, Callable[[], None]] = {'result': lambda: fake_api.receive_recognize()}
        if saved_result_asks:
            on_enter['saved result'] = lambda: fake_api.requests.append({'method': 'GET', 'path': '/api/v1/stations'})
        elif sends_the_tap:
            # The Call tap queued for counting (piece 5): the outbox tries it, with "No signal" on.
            on_enter['saved result'] = lambda: fake_api.requests.append({'method': 'POST', 'path': runner.ENGAGEMENTS_PATH,
                                                                        'dropped': 'offline'})
        return ScriptedPhone(
            screens={'home': HOME_WITH_TABS, 'listening': LISTENING, 'result': result,
                     'history': [app(LABELS['history earlier']), app(HISTORY_ROW), *TABS],
                     'saved result': [app(LABELS['back']), app(LABELS['saved result heading']),
                                      app(f'{CARD.client_name}\n{CARD.via_line}'), app(CARD.title),
                                      app(CARD.call_label)],
                     'copy sheet': [app(LABELS['copy sheet heading']), app(CARD.call_number_display),
                                    app(LABELS['copy number']), app(LABELS['copy sheet close'])]},
            taps={('home', LABELS['identify control']): 'listening',
                  ('result', LABELS['result back']): 'home',
                  ('home', LABELS['tab history']): 'history',
                  ('history', HISTORY_ROW): 'saved result',
                  ('saved result', CARD.call_label): 'copy sheet',
                  ('copy sheet', LABELS['copy sheet close']): 'saved result',
                  ('saved result', LABELS['back']): 'history',
                  ('history', LABELS['tab identify']): 'home'},
            moves_after_reads={'listening': (1, 'result')},
            on_enter=on_enter,
        )

    def test_the_history_journey_opens_the_saved_result_with_no_signal_and_reaches_the_copy_sheet(self) -> None:
        fake_api = ScriptedFakeApi()
        phone = self.history_phone(fake_api)
        context, _ = context_for(phone, fake_api)

        detail = runner.history_keeps_a_result_that_works_with_no_data(context)

        self.assertEqual(phone.tapped, [LABELS['identify control'], LABELS['result back'], LABELS['tab history'],
                                        HISTORY_ROW, CARD.call_label, LABELS['copy sheet close'],
                                        LABELS['back'], LABELS['tab identify']])
        self.assertEqual(phone.current, 'home')
        self.assertFalse(fake_api.is_offline)
        self.assertIn(CARD.call_number_display, detail)

    def test_the_history_journey_fails_when_the_result_does_not_say_saved(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(self.history_phone(fake_api, result_says_saved=False), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.history_keeps_a_result_that_works_with_no_data(context)

        self.assertIn(LABELS['saved to history'], str(failure.exception))

    def test_the_history_journey_lets_the_outbox_try_the_call_tap(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(self.history_phone(fake_api, sends_the_tap=True), fake_api)

        runner.history_keeps_a_result_that_works_with_no_data(context)

        self.assertFalse(fake_api.is_offline)

    def test_the_history_journey_fails_when_the_saved_result_needs_a_request(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(self.history_phone(fake_api, saved_result_asks=True), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.history_keeps_a_result_that_works_with_no_data(context)

        self.assertRegex(str(failure.exception), r'opening the saved result sent \d+ request\(s\): it must need no data')
        self.assertFalse(fake_api.is_offline)

    def picker_phone(self, fake_api: ScriptedFakeApi, *, keeps_the_list: bool = True) -> ScriptedPhone:
        def open_picker() -> None:
            if not keeps_the_list or fake_api.station_list_requests == 0:
                fake_api.station_list_requests += 1

        return ScriptedPhone(
            screens={'home': HOME_WITH_TABS,
                     'settings': [app(LABELS['tab settings']), app(MY_STATION_ROW), *TABS],
                     'picker': [app(LABELS['back']), app(LABELS['settings my station']),
                                app('No station\nLook Up will ask each time'),
                                *[app(station.spoken_label) for station in runner.LISTED_STATIONS]]},
            taps={('home', LABELS['tab settings']): 'settings',
                  ('settings', MY_STATION_ROW): 'picker',
                  ('picker', LABELS['back']): 'settings',
                  ('settings', LABELS['tab identify']): 'home'},
            on_enter={'picker': open_picker},
        )

    def test_the_picker_journey_sees_one_station_list_request_for_two_opens(self) -> None:
        fake_api = ScriptedFakeApi()
        phone = self.picker_phone(fake_api)
        context, _ = context_for(phone, fake_api)

        detail = runner.station_list_is_asked_for_once(context)

        self.assertEqual(fake_api.station_list_requests, 1)
        self.assertEqual(phone.current, 'home')
        self.assertIn('Station A, Station B after one GET /stations', detail)

    def test_the_picker_journey_fails_when_the_list_is_asked_for_again(self) -> None:
        fake_api = ScriptedFakeApi()
        context, _ = context_for(self.picker_phone(fake_api, keeps_the_list=False), fake_api)

        with self.assertRaises(StepFailed) as failure:
            runner.station_list_is_asked_for_once(context)

        self.assertIn('2 requests in all', str(failure.exception))

    def note_phone(self, *, is_shown_every_start: bool = False) -> ScriptedPhone:
        class NotePhone(ScriptedPhone):
            is_first_start = False

            def clear_app_data(self, package_name: str) -> None:
                super().clear_app_data(package_name)
                self.is_first_start = True

            def launch_app(self, package_name: str) -> None:
                self.launches.append(package_name)
                self.move('home with note' if self.is_first_start else 'home')
                self.is_first_start = is_shown_every_start

        return NotePhone({'home': HOME_WITH_TABS,
                          'home with note': [*HOME_WITH_TABS, app(LABELS['how it works']), app('Got it')]}, {})

    def test_the_first_open_journey_sees_the_note_once(self) -> None:
        phone = self.note_phone()
        context, _ = context_for(phone, ScriptedFakeApi())

        detail = runner.first_open_shows_how_look_up_works_once(context)

        self.assertEqual(phone.cleared, [APP])
        self.assertEqual(phone.launches, [APP, APP])
        self.assertIn('not after a restart', detail)

    def test_the_first_open_journey_fails_when_the_note_shows_after_a_restart(self) -> None:
        context, _ = context_for(self.note_phone(is_shown_every_start=True), ScriptedFakeApi())

        with self.assertRaises(StepFailed) as failure:
            runner.first_open_shows_how_look_up_works_once(context)

        self.assertIn('showed again after a restart', str(failure.exception))

    def test_the_new_journeys_run_after_step_4s_and_the_first_open_one_last(self) -> None:
        names = [journey for _, journey in runner.JOURNEYS]
        self.assertEqual(names[-20:], [runner.choose_a_station_with_no_signal, runner.remembered_station_skips_the_sheet,
                                       runner.cancel_on_the_sheet_chooses_nothing,
                                       runner.history_keeps_a_result_that_works_with_no_data,
                                       runner.station_list_is_asked_for_once,
                                       # Piece 3; the two that send a test error have the long one between them.
                                       runner.saved_offline_then_the_result_and_its_notification,
                                       runner.a_saved_clip_survives_a_restart,
                                       runner.a_crash_report_waits_for_the_signal,
                                       runner.saved_clips_wait_as_the_server_asks,
                                       runner.airplane_mode_with_the_app_open,
                                       runner.two_notifications_open_their_own_results,
                                       runner.a_saved_clip_is_sent_with_the_app_closed,
                                       runner.the_update_gate_and_its_end,
                                       # Piece 4.
                                       runner.report_this_sends_one_report,
                                       runner.a_slow_answer_says_still_working,
                                       runner.data_use_and_the_pictures_switch,
                                       runner.pictures_follow_the_switch_on_mobile_data,
                                       # Piece 5.
                                       runner.taps_are_counted_once_and_wait_for_the_signal,
                                       runner.answers_lost_still_count_once,
                                       runner.first_open_shows_how_look_up_works_once])
        self.assertLess(names.index(runner.send_test_error), names.index(runner.a_crash_report_waits_for_the_signal))


REPORT_RECOGNITION_ID = '01a13703-171b-7993-99e0-71ec6c8d4b32'


def report_phone(fake_api: ScriptedFakeApi, *, report_sends: int = 1, does_link_stay: bool = False,
                 does_saved_result_offer_the_link: bool = False) -> ScriptedPhone:
    """Identify gives a Result; "Report this" → the sheet → "Send report" shows "Reported" and queues the report in the
    outbox; History's row opens the saved result."""
    def answer_the_identify() -> None:
        fake_api.receive_recognize()
        fake_api.requests[-1]['recognition_id'] = REPORT_RECOGNITION_ID

    def send_the_report() -> None:
        fake_api.report_outbox.extend({'recognition_id': REPORT_RECOGNITION_ID, 'station_id': runner.match_station_id(),
                                       'reason': 'LOOKS_LIKE_A_SCAM'} for _ in range(report_sends))

    saved = [app(LABELS['back']), app(LABELS['saved result heading']), app(CARD.title), app(LABELS['reported']),
             *([app(LABELS['report this'])] if does_saved_result_offer_the_link else [])]
    return ScriptedPhone(
        screens={'home': HOME_WITH_TABS, 'listening': LISTENING, 'result': [*RESULT, app(LABELS['report this'])],
                 'sheet': [app(LABELS['report sheet title']), app(LABELS['report reason scam']), app('Something else'),
                           app(LABELS['send report']), app('Cancel')],
                 'reported': [*RESULT, app(LABELS['report thanks']), app(LABELS['reported']),
                              *([app(LABELS['report this'])] if does_link_stay else [])],
                 'history': [app('History'), app(LABELS['history earlier']), app(HISTORY_ROW), *TABS],
                 'saved': saved},
        taps={('home', LABELS['identify control']): 'listening',
              ('result', LABELS['report this']): 'sheet',
              ('sheet', LABELS['send report']): 'reported',
              ('reported', LABELS['result back']): 'home',
              ('home', LABELS['tab history']): 'history',
              ('history', HISTORY_ROW): 'saved',
              ('saved', LABELS['back']): 'history',
              ('history', LABELS['tab identify']): 'home'},
        moves_after_reads={'listening': (1, 'result')},
        on_enter={'result': answer_the_identify, 'reported': send_the_report},
    )


def switch_dump(checkable: str | None, checked: str) -> str:
    attributes = '' if checkable is None else f' checkable="{checkable}" checked="{checked}"'
    return ("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">"
            f'<node index="0" text="" resource-id="" class="android.view.View" package="{APP}" '
            f'content-desc="Load ad pictures on mobile data&#10;Turn off to save data; buttons still work" '
            f'clickable="true"{attributes} bounds="[0,100][1080,300]" /></hierarchy>')


# `dumpsys connectivity` on Android 13, the lines the driver reads, with Wi-Fi (100) and mobile data (101) up.
CONNECTIVITY_DUMP = (
    'NetworkProviders for:\n'
    'Active default network: {default}\n'
    'Current Networks:\n'
    '  NetworkAgentInfo{{network{{100}}  handle{{432902426637}}  ni{{WIFI CONNECTED extra: }}  '
    'nc{{[ Transports: WIFI Capabilities: NOT_METERED&INTERNET&NOT_RESTRICTED&TRUSTED&NOT_VPN&VALIDATED&NOT_ROAMING'
    '&FOREGROUND&NOT_CONGESTED&NOT_SUSPENDED&NOT_VCN_MANAGED LinkUpBandwidth>=12000Kbps]}}  factorySerialNumber=3}}\n'
    '  NetworkAgentInfo{{network{{101}}  handle{{437197393933}}  ni{{MOBILE[LTE] CONNECTED extra: }}  '
    'nc{{[ Transports: CELLULAR Capabilities: INTERNET&NOT_RESTRICTED&TRUSTED&NOT_VPN&VALIDATED&NOT_ROAMING'
    '&FOREGROUND&NOT_CONGESTED&NOT_SUSPENDED&NOT_VCN_MANAGED LinkUpBandwidth>=51200Kbps]}}  factorySerialNumber=5}}\n'
)


class PieceFourTest(unittest.TestCase):
    """Piece 4's journeys (P6 design §4.8 steps 12, 19-21) and what they read from the screen and the device."""

    def test_a_switch_says_whether_it_is_on_and_other_nodes_say_nothing(self) -> None:
        for checkable, checked, expected in (('true', 'true', True), ('true', 'false', False), (None, 'true', None)):
            with self.subTest(checkable=checkable, checked=checked):
                node = find_nodes(parse_screen_dump(switch_dump(checkable, checked)).nodes, LABELS['load pictures'])[0]
                self.assertIs(node.checked, expected)

    def test_the_default_network_and_whether_it_is_metered_come_from_dumpsys(self) -> None:
        mobile = runner.default_network_of(CONNECTIVITY_DUMP.format(default='101'))
        self.assertEqual(mobile, runner.DefaultNetwork('101', ('CELLULAR',), True))
        self.assertEqual(mobile.describe(), 'CELLULAR, metered')
        wifi = runner.default_network_of(CONNECTIVITY_DUMP.format(default='100'))
        self.assertEqual(wifi, runner.DefaultNetwork('100', ('WIFI',), False))
        self.assertIsNone(runner.default_network_of(CONNECTIVITY_DUMP.format(default='none')))
        self.assertIsNone(runner.default_network_of(CONNECTIVITY_DUMP.format(default='102')))
        self.assertIsNone(runner.default_network_of('no such lines'))

    def test_amounts_read_as_settings_shows_them(self) -> None:
        self.assertEqual(runner.data_amount_bytes('312 KB'), 312_000)
        self.assertEqual(runner.data_amount_bytes('0 KB'), 0)
        self.assertEqual(runner.data_amount_bytes('1.4 MB'), 1_400_000)
        for not_an_amount in ('about 25 KB', 'KB', '25 kB', '1,000 KB', 'Used this month'):
            with self.subTest(not_an_amount):
                self.assertIsNone(runner.data_amount_bytes(not_an_amount))

    def test_used_this_month_is_the_one_amount_on_the_settings_screen(self) -> None:
        def screen(*labels: str) -> Screen:
            return parse_screen_dump(dump_of([app(label) for label in labels]))

        each = f"{LABELS['each identify uses']}\n{LABELS['about 25 KB']}"
        self.assertEqual(runner.used_this_month(screen(each, f"{LABELS['used this month']}\n87 KB"), APP), 87_000)
        with self.assertRaises(StepFailed):
            runner.used_this_month(screen(each, LABELS['used this month']), APP)
        with self.assertRaises(StepFailed):
            runner.used_this_month(screen(f"{LABELS['used this month']}\n87 KB", 'Something\n12 KB'), APP)

    def test_a_slow_send_needs_still_working_progress_and_the_result(self) -> None:
        def seen(**changes: Any) -> runner.SlowSendSeen:
            return runner.SlowSendSeen(**{'is_slow_seen': True, 'percents': (33, 80), 'is_clip_sent_seen': True,
                                          'is_result_seen': True, 'readable_count': 9, 'unreadable_count': 0, **changes})

        self.assertEqual(runner.slow_send_problems(seen()), [])
        self.assertEqual(runner.slow_send_problems(seen(percents=())), [], '"Clip sent" alone is progress')
        self.assertEqual(runner.slow_send_problems(seen(is_clip_sent_seen=False)), [], 'a share alone is progress')
        for changes, problem in (({'is_slow_seen': False}, 'Still working'),
                                 ({'percents': (), 'is_clip_sent_seen': False}, 'no progress'),
                                 ({'percents': (80, 33)}, 'went down'),
                                 ({'percents': (33, 140)}, 'over 100%'),
                                 ({'is_result_seen': False}, 'Result never showed')):
            with self.subTest(problem):
                self.assertIn(problem, ' '.join(runner.slow_send_problems(seen(**changes))))

    def test_a_slow_send_is_read_screen_by_screen_until_the_result(self) -> None:
        identifying = [app('Identifying\u2026')]
        phone = ScriptedPhone(
            screens={'identifying': identifying,
                     'slow at 33': [*identifying, app(LABELS['identifying slow']), app('Clip 33% sent')],
                     'slow at 80': [*identifying, app(LABELS['identifying slow']), app('Clip 80% sent')],
                     'clip sent': [*identifying, app(LABELS['identifying slow']), app(LABELS['clip sent'])],
                     'result': RESULT},
            taps={}, start='identifying',
            moves_after_reads={'identifying': (2, 'slow at 33'), 'slow at 33': (2, 'slow at 80'),
                               'slow at 80': (2, 'clip sent'), 'clip sent': (2, 'result')})
        context, _ = context_for(phone, ScriptedFakeApi())

        seen = runner.watch_a_slow_send(context.driver, 60)

        self.assertEqual((seen.is_slow_seen, seen.percents, seen.is_clip_sent_seen, seen.is_result_seen),
                         (True, (33, 80), True, True))
        self.assertEqual(runner.slow_send_problems(seen), [])

    def test_a_slow_send_that_never_reaches_the_result_stops_at_its_time(self) -> None:
        phone = ScriptedPhone(screens={'identifying': [app('Identifying\u2026')]}, taps={}, start='identifying')
        context, clock = context_for(phone, ScriptedFakeApi())

        seen = runner.watch_a_slow_send(context.driver, 30)

        self.assertFalse(seen.is_result_seen)
        self.assertGreaterEqual(clock.now, 30)

    def test_the_report_journey_sees_reported_at_once_and_one_report_once_the_signal_is_back(self) -> None:
        fake_api = ScriptedFakeApi()
        phone = report_phone(fake_api)
        context, _ = context_for(phone, fake_api)

        detail = runner.report_this_sends_one_report(context)

        self.assertEqual(phone.tapped[:4], [LABELS['identify control'], LABELS['report this'], LABELS['report reason scam'],
                                            LABELS['send report']])
        self.assertEqual(phone.current, 'home')
        self.assertFalse(fake_api.is_offline, '"No signal" is switched off again')
        self.assertIn('one report (LOOKS_LIKE_A_SCAM', detail)
        self.assertIn('the saved result in History says "Reported"', detail)

    def test_the_report_journey_fails_when_the_report_goes_twice_or_never_or_the_link_stays(self) -> None:
        for name, options, problem in (('twice', {'report_sends': 2}, 'not exactly one report'),
                                       ('never', {'report_sends': 0}, 'the report to reach the stand-in'),
                                       ('link stays', {'does_link_stay': True}, '"Report this" still shows'),
                                       ('saved result', {'does_saved_result_offer_the_link': True},
                                        'offers "Report this" again')):
            with self.subTest(name):
                fake_api = ScriptedFakeApi()
                context, _ = context_for(report_phone(fake_api, **options), fake_api)

                with self.assertRaises(StepFailed) as failure:
                    runner.report_this_sends_one_report(context)

                self.assertIn(problem, str(failure.exception))
                self.assertFalse(fake_api.is_offline)

    def test_piece_four_journeys_queue_only_answers_the_stand_in_knows(self) -> None:
        import fake_listener_api

        for name in ('match', 'slow-upload', 'match-with-images', 'match-answer-lost', 'choose-station',
                     'choice-answer-lost', 'engagement-answer-lost'):
            self.assertIn(name, fake_listener_api.SCENARIOS)
        self.assertEqual(runner.pictures_card_title(), CARD.title)
        self.assertEqual(runner.match_station_id(), runner.CHOOSER_STATIONS[0].station_id)

    def test_the_tap_journeys_read_their_buttons_from_the_fixtures_the_stand_in_answers_with(self) -> None:
        buttons = runner.match_buttons()
        self.assertEqual(runner.button(buttons, 'CALL').label, CARD.call_label)
        self.assertEqual(runner.button(buttons, 'MAP').label, 'Find our shop')
        station_b = runner.CHOOSER_STATIONS[1]
        call_of_b = runner.button(runner.chooser_buttons_of(station_b.station_id), 'CALL')
        self.assertRegex(call_of_b.action_id, r'^[0-9a-f-]{36}$')
        with self.assertRaises(StopIteration):
            runner.chooser_buttons_of('0192a6c4-1111-4000-8000-00000000ffff')

    def test_only_answered_taps_since_the_mark_are_read(self) -> None:
        fake_api = ScriptedFakeApi()
        fake_api.requests = [
            {'path': runner.ENGAGEMENTS_PATH, 'engagement': 'tapped', 'action_id': 'old'},
            {'path': runner.ENGAGEMENTS_PATH, 'dropped': 'offline'},
            {'path': runner.ENGAGEMENTS_PATH, 'refused': 'a tap body must be exactly'},
            {'path': runner.ENGAGEMENTS_PATH, 'engagement': 'already tapped', 'action_id': 'new'},
        ]
        context, _ = context_for(ScriptedPhone(screens={'home': HOME}, taps={}), fake_api)
        self.assertEqual([tap['action_id'] for tap in runner.tap_requests_since(context, 1)], ['new'])


class StandInControlTest(unittest.TestCase):
    """The control routes the journeys use, against the real stand-in (tool/fake_listener_api.py)."""

    def setUp(self) -> None:
        import threading

        import fake_listener_api

        self.server = fake_listener_api.make_server('127.0.0.1', 0, None)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.fake_api = runner.HttpFakeApi(f'http://127.0.0.1:{self.server.server_address[1]}')

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def test_no_signal_is_switched_on_and_off_and_the_state_holds_what_the_journeys_read(self) -> None:
        self.fake_api.set_offline(True)
        self.assertTrue(self.fake_api.state()['is_offline'])
        self.fake_api.set_offline(False)
        state = self.fake_api.state()
        self.assertFalse(state['is_offline'])
        self.assertEqual(state['choices'], [])
        self.assertEqual(state['station_list_requests'], 0)
        self.assertEqual(state['recognitions'], [])

    def test_the_scenarios_the_journeys_queue_are_known_to_the_stand_in(self) -> None:
        names = ['choose-station', 'match-by-hint', 'match', 'drop', 'no-match', 'busy-deferred-shed',
                 'rate-limited-deferred', 'match-station-b', 'slow-upload', 'match-with-images', 'match-answer-lost']
        self.fake_api.queue(names)
        self.assertEqual(self.fake_api.state()['queued']['recognize'], names)

    def test_the_update_gate_is_set_and_turned_off_and_the_state_holds_what_the_journeys_read(self) -> None:
        self.fake_api.set_minimum_app_version('0.2.0')
        state = self.fake_api.state()
        self.assertEqual((state['minimum_app_version'], state['update_required_answers']), ('0.2.0', 0))
        self.assertEqual(state['client_error_reports'], [])
        self.fake_api.set_minimum_app_version(None)
        self.assertIsNone(self.fake_api.state()['minimum_app_version'])


if __name__ == '__main__':
    unittest.main()
