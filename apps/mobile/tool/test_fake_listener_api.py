"""The fake API refuses every request the real API would refuse (design §4.6), so a passing emulator run
means the app's requests were right; and its control routes work only from this machine's own page (P6 design
§4.7, P6-D30, P6-D50). Standard library only:

    python -m unittest tool/test_fake_listener_api.py
"""

from __future__ import annotations

import contextlib
import http.client
import io
import json
import re
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from http.client import RemoteDisconnected
from typing import Any

from fake_listener_api import (DEFAULT_SCENARIOS, PHONE_CHECK_ANSWERS, PHONE_CHECK_LIFETIME_SECONDS,
                               RECENT_REGISTRATIONS_KEPT, ROUTES, SCENARIOS, make_server, read_fixture)

CLIP = b'\x00\x00\x00\x20ftypM4A ' + bytes(4_000)
JSON = {'Content-Type': 'application/json'}
NO_ANSWER = (RemoteDisconnected, ConnectionError, urllib.error.URLError, http.client.HTTPException)
# The header ngrok adds, with an address from the documentation range: a request that came through the tunnel.
THROUGH_THE_TUNNEL = {'X-Forwarded-For': '203.0.113.7'}


class FakeClock:
    """Seconds that move only when a test moves them, for how long the phone check's number is kept."""

    def __init__(self) -> None:
        self.seconds = 1_000.0

    def __call__(self) -> float:
        return self.seconds


def live_fields(**changes: str | None) -> dict[str, str]:
    fields = {
        'clip_duration_milliseconds': '8000',
        'codec': 'aac',
        'idempotency_key': str(uuid.uuid4()),
        'captured_at': '2026-10-08T06:30:00.000Z',
        'sent_at': '2026-10-08T06:30:09.250Z',
        'is_deferred': 'false',
    }
    fields.update(changes)
    return {name: value for name, value in fields.items() if value is not None}


def multipart(fields: dict[str, str], clip: bytes | None = CLIP, file_name: str = 'clip.m4a', content_type: str = 'audio/mp4', audio_first: bool = False) -> tuple[bytes, str]:
    boundary = 'fake-test-boundary'
    text_parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode() for name, value in fields.items()]
    audio_part = b'' if clip is None else (
        f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="{file_name}"\r\nContent-Type: {content_type}\r\n\r\n'.encode() + clip + b'\r\n')
    parts = [audio_part, *text_parts] if audio_first else [*text_parts, audio_part]
    return b''.join(parts) + f'--{boundary}--\r\n'.encode(), f'multipart/form-data; boundary={boundary}'


def phone_numbers_in(value: Any) -> list[str]:
    """Every `phone_number_e164` in an answer, at any depth."""
    if isinstance(value, dict):
        return [number for key, item in value.items()
                for number in ([item] if key == 'phone_number_e164' else phone_numbers_in(item))]
    if isinstance(value, list):
        return [number for item in value for number in phone_numbers_in(item)]
    return []


class FakeListenerApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        self.server = make_server('127.0.0.1', 0, None, self.clock)
        self.port = self.server.server_port
        self.base = f'http://127.0.0.1:{self.port}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    # ---- helpers -----------------------------------------------------------------------------------

    def send(self, path: str, body: bytes = b'', headers: dict[str, str] | None = None, method: str = 'POST') -> tuple[int, dict[str, str], Any]:
        request = urllib.request.Request(self.base + path, data=body if method != 'GET' else None, headers=headers or {}, method=method)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=10) as response:
                raw = response.read()
                return response.status, dict(response.headers), json.loads(raw) if raw and 'json' in (response.headers.get('Content-Type') or '') else raw
        except urllib.error.HTTPError as error:
            with error:
                raw = error.read()
                is_json = 'json' in (error.headers.get('Content-Type') or '')
                return error.code, dict(error.headers), json.loads(raw) if raw and is_json else raw

    def control(self, path: str, body: Any, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], Any]:
        """A control request as the control page sends it: JSON, from this machine."""
        return self.send(path, json.dumps(body).encode(), {**JSON, **(headers or {})})

    def get(self, path: str, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], Any]:
        return self.send(path, headers=headers, method='GET')

    def raw_request(self, method: str, path: str, headers: dict[str, str], body: bytes = b'') -> tuple[int, dict[str, str], bytes]:
        """A request with exactly these headers, Host included, as a browser or another machine might send it."""
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            for name, value in headers.items():
                connection.putheader(name, value)
            connection.putheader('Content-Length', str(len(body)))
            connection.endheaders(body)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def register(self, install_id: str | None = None, token: str | None = None, app_version: str = '0.1.0+1',
                 through_tunnel: bool = False) -> tuple[int, Any]:
        headers = {'Content-Type': 'application/json', 'X-Request-Id': str(uuid.uuid4()),
                   **(THROUGH_THE_TUNNEL if through_tunnel else {})}
        if token:
            headers['Authorization'] = f'Bearer {token}'
        status, _, body = self.send('/api/v1/installs', json.dumps({'install_id': install_id or str(uuid.uuid4()), 'platform': 'ANDROID', 'app_version': app_version}).encode(), headers)
        return status, body

    def registered_token(self, install_id: str | None = None, through_tunnel: bool = False) -> str:
        status, body = self.register(install_id, through_tunnel=through_tunnel)
        self.assertEqual(status, 200)
        return body['install_token']

    def recognize(self, token: str | None, fields: dict[str, str] | None = None, request_id: str | None = None,
                  authorization: str | None = None, **multipart_options: Any) -> tuple[int, dict[str, str], Any]:
        """An identify; [authorization] replaces the `Bearer <token>` header with exactly that value."""
        body, content_type = multipart(fields or live_fields(), **multipart_options)
        headers = {'Content-Type': content_type, 'X-Request-Id': request_id or str(uuid.uuid4())}
        if authorization is not None:
            headers['Authorization'] = authorization
        elif token:
            headers['Authorization'] = f'Bearer {token}'
        return self.send('/api/v1/recognize', body, headers)

    def start_phone_check(self, phone_number: Any, install_id: Any) -> tuple[int, dict[str, str], Any]:
        """What the control page sends for "Use this number" with an install chosen."""
        return self.control('/__fake/phone-number', {'phone_number': phone_number, 'install_id': install_id})

    def queue(self, *names: str) -> None:
        self.assertEqual(self.control('/__fake/scenarios', list(names))[0], 200)

    def request_log(self) -> dict[str, Any]:
        status, _, body = self.get('/__fake/requests')
        self.assertEqual(status, 200)
        return body

    def state(self) -> dict[str, Any]:
        status, _, body = self.get('/__fake/state')
        self.assertEqual(status, 200)
        return body

    # ---- what the app must get right ---------------------------------------------------------------

    def test_a_correct_identify_gets_the_shared_match_answer_with_the_echoed_request_id(self) -> None:
        token = self.registered_token()
        request_id = str(uuid.uuid4())
        status, headers, body = self.recognize(token, request_id=request_id)
        self.assertEqual(status, 200)
        self.assertEqual(headers['X-Request-Id'], request_id)
        self.assertEqual(body['status'], 'MATCH')
        self.assertEqual(body['request_id'], request_id)
        logged = self.request_log()['requests'][-1]
        self.assertEqual(logged['field_names'], sorted(live_fields()))
        self.assertEqual(logged['audio_bytes'], len(CLIP))

    def test_registration_refuses_a_body_that_is_not_exactly_the_contract(self) -> None:
        good = {'install_id': str(uuid.uuid4()), 'platform': 'ANDROID', 'app_version': '0.1.0+1'}
        for bad in ({**good, 'push_token': 'x'}, {**good, 'platform': 'android'}, {**good, 'install_id': 'phone-1'}, {**good, 'app_version': ''},
                    {key: value for key, value in good.items() if key != 'platform'}):
            status, _, _ = self.send('/api/v1/installs', json.dumps(bad).encode(), {'Content-Type': 'application/json', 'X-Request-Id': str(uuid.uuid4())})
            self.assertEqual(status, 400, bad)

    def test_recognize_refuses_every_mistake_the_real_api_refuses(self) -> None:
        token = self.registered_token()
        mistakes = {
            'no token': dict(token=None),
            'an Authorization that is not a bearer token': dict(authorization='Basic dXNlcjpwYXNz'),
            'an empty bearer token': dict(authorization='Bearer '),
            'a bearer token with a space in it': dict(authorization='Bearer two words'),
            'a lower-case bearer': dict(authorization=f'bearer {token}'),
            'no request id': dict(request_id='not-a-uuid'),
            'a missing field': dict(fields=live_fields(codec=None)),
            'an extra field': dict(fields={**live_fields(), 'fingerprint_hashes': '1,2'}),
            'a duration out of range': dict(fields=live_fields(clip_duration_milliseconds='1999')),
            'a time without an offset': dict(fields=live_fields(captured_at='2026-10-08T06:30:00')),
            'an idempotency key that is not a UUID': dict(fields=live_fields(idempotency_key='retry-1')),
            'is_deferred not true or false': dict(fields=live_fields(is_deferred='no')),
            'no audio': dict(clip=None),
            'audio that is not M4A': dict(clip=b'not a recording at all'),
            'audio over 256 KiB': dict(clip=b'\x00\x00\x00\x20ftypM4A ' + bytes(262_200)),
            'the wrong file name': dict(file_name='recording.mp3'),
            'the wrong type': dict(content_type='application/octet-stream'),
            'audio before the text fields': dict(audio_first=True),
        }
        for description, options in mistakes.items():
            arguments = {'token': token, **options}
            status, _, _ = self.recognize(**arguments)
            self.assertEqual(status, 400, description)

    def test_scenarios_answer_with_the_shared_fixtures_and_their_status_codes(self) -> None:
        token = self.registered_token()
        self.queue('busy', 'timeout', 'no-match', 'fallback', 'error', 'rate-limited', 'invalid-audio', 'choose-station')
        # 6 s, so Busy stays on screen across two or more uiautomator reads and the emulator run can require it.
        status, headers, body = self.recognize(token)
        self.assertEqual((status, body['error']['code'], headers['Retry-After']), (503, 'RECOGNITION_BUSY', '6'))
        status, headers, body = self.recognize(token)
        self.assertEqual((status, body['error']['code'], headers['Retry-After']), (503, 'RECOGNITION_TIMEOUT', '6'))
        self.assertEqual(self.recognize(token)[2]['status'], 'NO_MATCH')
        self.assertEqual(self.recognize(token)[2]['result']['kind'], 'CLIENT_DEFAULT')
        request_id = str(uuid.uuid4())
        status, _, body = self.recognize(token, request_id=request_id)
        self.assertEqual((status, body['error']['code'], body['error']['request_id']), (500, 'INTERNAL', request_id))
        self.assertEqual(self.recognize(token)[0], 429)
        self.assertEqual(self.recognize(token)[2]['error']['code'], 'INVALID_AUDIO')
        self.assertEqual(self.recognize(token)[2]['status'], 'CHOOSE_STATION')
        self.assertEqual(self.recognize(token)[2]['status'], 'MATCH')  # the queue is empty: the default

    def test_more_options_serves_the_campaign_card_with_six_actions_from_the_shared_fixtures(self) -> None:
        token = self.registered_token()
        self.queue('match-more-options')
        request_id = str(uuid.uuid4())
        status, headers, body = self.recognize(token, request_id=request_id)

        self.assertEqual((status, body['status'], body['request_id'], headers['X-Request-Id']),
                         (200, 'MATCH', request_id, request_id))
        actions = body['result']['card']['actions']
        campaign = read_fixture('recognition/recognize-response/valid/match-campaign.json')['response']['result']
        six_actions = read_fixture('action-card/valid/six-actions.json')['card']['actions']
        # Five or six buttons reach "More options"; here the six a card may hold, every one a shared fixture's own.
        self.assertEqual(len(actions), 6)
        self.assertEqual(actions[:4], campaign['card']['actions'])
        self.assertEqual(actions[4:], [action for action in six_actions if action['id'].endswith(('05', '06'))])
        self.assertEqual(len({action['id'] for action in actions}), 6, 'action ids must be unique on a card')
        self.assertEqual({key: value for key, value in body['result'].items() if key != 'card'},
                         {key: value for key, value in campaign.items() if key != 'card'})
        self.assertEqual(self.recognize(token)[2]['result']['card']['actions'], campaign['card']['actions'])

    def test_busy_without_a_request_id_carries_no_id_in_its_header_or_its_body(self) -> None:
        token = self.registered_token()
        self.queue(*['busy-without-request-id'] * 4)
        for send in range(1, 5):
            status, headers, body = self.recognize(token)
            self.assertEqual((status, body['error']['code'], headers['Retry-After']), (503, 'RECOGNITION_BUSY', '6'), send)
            self.assertNotIn('X-Request-Id', headers, send)
            self.assertNotIn('request_id', body['error'], send)
        status, headers, body = self.recognize(token)   # the queue is empty again: the default, with its id
        self.assertEqual((status, body['status']), (200, 'MATCH'))
        self.assertIn('X-Request-Id', headers)

    def test_an_invalid_token_answer_withdraws_the_token_so_the_app_must_register_again(self) -> None:
        token = self.registered_token()
        self.queue('token-invalid-once')
        self.assertEqual(self.recognize(token)[0], 401)
        status, _, body = self.recognize(token)   # the old token is no longer known: refused again, as by the real guard
        self.assertEqual((status, body['error']['code']), (401, 'INSTALL_TOKEN_INVALID'))
        self.assertEqual(self.recognize(self.registered_token())[0], 200)

    def test_a_token_the_stand_in_did_not_issue_gets_the_install_token_invalid_answer_so_the_app_registers_again(self) -> None:
        install_id = str(uuid.uuid4())
        token = self.registered_token(install_id)
        self.assertEqual(self.control('/__fake/reset', {})[0], 200)   # "Reset everything", as after a restart
        request_id = str(uuid.uuid4())
        status, headers, body = self.recognize(token, request_id=request_id)
        envelope = read_fixture('errors/envelopes/install-token-invalid.json')
        self.assertEqual((status, headers['X-Request-Id']), (envelope['http_status'], request_id))
        self.assertEqual(body, {'error': {**envelope['body']['error'], 'request_id': request_id}})
        self.assertEqual(self.recognize('made.up.token')[2]['error']['code'], 'INSTALL_TOKEN_INVALID')   # never issued
        state = self.state()
        self.assertEqual(state['refused'], 0, 'a correct request the real API answers 401 is not a refusal')
        self.assertEqual(state['recent_requests'][-1]['outcome'], 'token not issued here: answered 401')
        self.assertEqual(state['recognitions'], [], 'no answer was taken from the queue')

        status, registration = self.register(install_id, token=token)   # the app registers again (amendment A3)
        self.assertEqual(status, 200)
        self.assertEqual(self.request_log()['requests'][-1]['carried_token'], 'a token the fake never issued')
        status, _, body = self.recognize(registration['install_token'])
        self.assertEqual((status, body['status']), (200, 'MATCH'))

    def test_drop_closes_the_connection_with_no_answer_and_unreadable_answers_with_html(self) -> None:
        token = self.registered_token()
        self.queue('drop', 'unreadable')
        with self.assertRaises(NO_ANSWER):
            self.recognize(token)
        status, headers, body = self.recognize(token)
        self.assertEqual(status, 200)
        self.assertIn('text/html', headers['Content-Type'])

    def test_crash_reports_are_checked_and_kept_without_a_token(self) -> None:
        good = {'source': 'listener-app', 'kind': 'reported', 'message': 'Test error from the developer tools'}
        request_id = str(uuid.uuid4())
        status, headers, _ = self.send('/api/v1/client-errors', json.dumps(good).encode(), {'Content-Type': 'application/json', 'X-Request-Id': request_id})
        self.assertEqual((status, headers['X-Request-Id']), (202, request_id))
        for bad in ({**good, 'source': 'portal'}, {**good, 'kind': 'crash'}, {**good, 'message': ''}, {**good, 'secret': 'x'},
                    {**good, 'occurredAt': '2026-10-08 06:30'}, {**good, 'occurredAt': 1728369000}):
            self.assertEqual(self.send('/api/v1/client-errors', json.dumps(bad).encode(), {'Content-Type': 'application/json', 'X-Request-Id': str(uuid.uuid4())})[0], 400, bad)
        with_token = self.send('/api/v1/client-errors', json.dumps(good).encode(), {'Content-Type': 'application/json', 'X-Request-Id': str(uuid.uuid4()), 'Authorization': 'Bearer x'})
        self.assertEqual(with_token[0], 400)
        self.assertEqual([report['request_id'] for report in self.request_log()['client_error_reports']], [request_id])

    def test_a_crash_report_queued_offline_carries_when_it_happened(self) -> None:
        report = {'source': 'listener-app', 'kind': 'reported', 'message': 'Test error from the developer tools',
                  'occurredAt': '2026-10-08T06:30:00.000Z'}
        status, _, _ = self.send('/api/v1/client-errors', json.dumps(report).encode(), {'Content-Type': 'application/json', 'X-Request-Id': str(uuid.uuid4())})
        self.assertEqual(status, 202)
        self.assertEqual(self.request_log()['client_error_reports'][-1]['occurredAt'], '2026-10-08T06:30:00.000Z')

    def test_an_unknown_scenario_is_refused_rather_than_silently_answered(self) -> None:
        self.assertEqual(self.control('/__fake/scenarios', ['matched'])[0], 400)
        self.assertEqual(self.control('/__fake/scenarios', {'name': 'match'})[0], 400)
        self.assertEqual(self.state()['queued'], {route: [] for route in ROUTES})

    # ---- one queue per route -----------------------------------------------------------------------

    def test_every_scenario_belongs_to_one_known_route_and_has_words_for_its_button(self) -> None:
        self.assertEqual(set(ROUTES), set(DEFAULT_SCENARIOS))
        for name, plan in SCENARIOS.items():
            with self.subTest(name):
                self.assertIn(plan['route'], ROUTES)
                self.assertTrue(plan['label'].strip())
        self.assertEqual(SCENARIOS['choose-station']['label'], 'Which station?')
        self.assertEqual(SCENARIOS['match']['label'], 'Match')

    def test_a_queued_answer_joins_its_own_route_queue_and_the_state_shows_it(self) -> None:
        self.queue('busy', 'no-match')
        self.assertEqual(self.state()['queued'], {'recognize': ['busy', 'no-match']})
        token = self.registered_token()   # a registration takes nothing from the recognize queue
        self.assertEqual(self.state()['queued']['recognize'], ['busy', 'no-match'])
        self.assertEqual(self.recognize(token)[0], 503)
        self.assertEqual(self.state()['queued']['recognize'], ['no-match'])

    # ---- the control page and its checks (P6-D30, P6-D50) -----------------------------------------

    def test_the_control_page_offers_every_answer_the_signal_switch_a_number_and_reset(self) -> None:
        status, headers, page = self.get('/__fake/panel')
        self.assertEqual(status, 200)
        self.assertIn('text/html', headers['Content-Type'])
        text = page.decode('utf-8')
        for label in [*(plan['label'] for plan in SCENARIOS.values()), 'No signal', 'Signal back', 'Use this number',
                      'Stop replacing', 'Reset everything', 'What the app sent']:
            self.assertIn(label.replace("'", '&#x27;'), text, label)
        self.assertIn('Next answer: Match<', text)
        self.assertIn('Next answer: Which station?<', text)

    def test_the_control_page_runs_only_its_own_script_and_cannot_be_framed(self) -> None:
        _, headers, page = self.get('/__fake/panel')
        policy = headers['Content-Security-Policy']
        nonce = re.search(r"script-src 'nonce-([A-Za-z0-9_-]+)'", policy).group(1)
        self.assertIn("default-src 'none'", policy)
        self.assertIn("frame-ancestors 'none'", policy)
        self.assertEqual(headers['X-Frame-Options'], 'DENY')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        scripts = re.findall(r'<script([^>]*)>', page.decode('utf-8'))
        self.assertEqual(scripts, [f' nonce="{nonce}"'])
        self.assertNotEqual(nonce, re.search(r"'nonce-([^']+)'", self.get('/__fake/panel')[1]['Content-Security-Policy']).group(1))

    def test_the_control_page_at_localhost_is_sent_to_the_address_its_controls_accept(self) -> None:
        status, headers, _ = self.raw_request('GET', '/__fake/panel', {'Host': f'localhost:{self.port}'})
        self.assertEqual(status, 302)
        self.assertEqual(headers['Location'], f'http://127.0.0.1:{self.port}/__fake/panel')

    def test_a_forwarded_control_request_is_refused_as_if_there_were_no_such_route(self) -> None:
        for header in ('X-Forwarded-For', 'Forwarded', 'X-Forwarded-Host'):
            with self.subTest(header):
                self.assertEqual(self.get('/__fake/state', {header: '203.0.113.7'})[0], 404)
                self.assertEqual(self.get('/__fake/panel', {header: '203.0.113.7'})[0], 404)
                self.assertEqual(self.get('/__fake/requests', {header: '203.0.113.7'})[0], 404)
                self.assertEqual(self.control('/__fake/scenarios', ['busy'], {header: '203.0.113.7'})[0], 404)
                self.assertEqual(self.control('/__fake/offline', {'is_offline': True}, {header: '203.0.113.7'})[0], 404)
                self.assertEqual(self.control('/__fake/reset', {}, {header: '203.0.113.7'})[0], 404)
        state = self.state()
        self.assertEqual((state['queued']['recognize'], state['is_offline']), ([], False))

    def test_a_control_request_that_is_not_json_is_refused(self) -> None:
        for content_type in ('text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', None):
            with self.subTest(content_type):
                # Exactly these headers: with None, no Content-Type at all (urllib would add a form one to a POST), as a
                # cross-site fetch of a Blob sends with no preflight.
                headers = {'Host': f'127.0.0.1:{self.port}'}
                if content_type is not None:
                    headers['Content-Type'] = content_type
                status, _, _ = self.raw_request('POST', '/__fake/offline', headers, b'{"is_offline": true}')
                self.assertEqual(status, 415)
                self.assertFalse(self.state()['is_offline'])
        self.assertEqual(self.control('/__fake/offline', {'is_offline': True}, {'Content-Type': 'application/json; charset=utf-8'})[0], 200)
        self.assertTrue(self.state()['is_offline'])

    def test_a_control_request_from_another_page_is_refused_and_this_page_is_accepted(self) -> None:
        for origin in ('http://evil.example', f'http://localhost:{self.port}', 'null', f'https://127.0.0.1:{self.port}'):
            with self.subTest(origin):
                self.assertEqual(self.control('/__fake/scenarios', ['busy'], {'Origin': origin})[0], 403)
        self.assertEqual(self.state()['queued']['recognize'], [])
        self.assertEqual(self.control('/__fake/scenarios', ['busy'], {'Origin': f'http://127.0.0.1:{self.port}'})[0], 200)
        self.assertEqual(self.control('/__fake/scenarios', ['no-match'])[0], 200)   # the emulator driver sends no Origin
        self.assertEqual(self.state()['queued']['recognize'], ['busy', 'no-match'])

    def test_a_control_request_for_another_host_name_is_refused(self) -> None:
        body = json.dumps({'is_offline': True}).encode()
        for host in ('evil.example', f'evil.example:{self.port}', f'127.0.0.1:{self.port + 1}', f'192.168.1.5:{self.port}', ''):
            with self.subTest(host):
                headers = {'Content-Type': 'application/json'}
                if host:
                    headers['Host'] = host
                self.assertEqual(self.raw_request('POST', '/__fake/offline', headers, body)[0], 403)
                self.assertEqual(self.raw_request('GET', '/__fake/state', {'Host': host} if host else {})[0], 403)
        self.assertFalse(self.state()['is_offline'])
        status, _, _ = self.raw_request('POST', '/__fake/offline', {'Host': f'localhost:{self.port}', 'Content-Type': 'application/json'}, body)
        self.assertEqual(status, 200)

    def test_a_cross_site_preflight_is_never_answered_with_permission(self) -> None:
        status, headers, _ = self.raw_request('OPTIONS', '/__fake/offline', {
            'Host': f'127.0.0.1:{self.port}', 'Origin': 'http://evil.example',
            'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'})
        self.assertNotIn(status, range(200, 300))
        self.assertNotIn('Access-Control-Allow-Origin', headers)

    # ---- "No signal" acts before any queued answer is taken ---------------------------------------

    def test_no_signal_drops_the_request_before_its_queued_answer_is_taken(self) -> None:
        token = self.registered_token()
        self.queue('busy')
        self.assertEqual(self.control('/__fake/offline', {'is_offline': True})[0], 200)
        with self.assertRaises(NO_ANSWER):
            self.recognize(token)
        self.assertEqual(self.state()['queued']['recognize'], ['busy'], 'the dropped request took no answer')
        self.assertEqual(self.control('/__fake/offline', {'is_offline': False})[0], 200)

        status, _, body = self.recognize(token)
        self.assertEqual((status, body['error']['code']), (503, 'RECOGNITION_BUSY'))
        self.assertEqual(self.recognize(token)[2]['status'], 'MATCH')
        state = self.state()
        self.assertEqual(state['dropped_while_offline'], 1)
        self.assertEqual([recognition['scenario'] for recognition in state['recognitions']], ['busy', 'match'])

    def test_no_signal_cuts_off_every_listener_route_and_never_the_controls(self) -> None:
        self.assertEqual(self.control('/__fake/offline', {'is_offline': True})[0], 200)
        with self.assertRaises(NO_ANSWER):
            self.register()
        with self.assertRaises(NO_ANSWER):
            self.send('/api/v1/client-errors', b'{}', {'Content-Type': 'application/json', 'X-Request-Id': str(uuid.uuid4())})
        with self.assertRaises(NO_ANSWER):
            self.get('/api/v1/stations')
        dropped = [request for request in self.request_log()['requests'] if request.get('dropped') == 'offline']
        self.assertEqual([request['path'] for request in dropped], ['/api/v1/installs', '/api/v1/client-errors', '/api/v1/stations'])
        self.assertEqual(self.state()['registrations'], 0)

    def test_reset_clears_the_switches_too(self) -> None:
        install_id = str(uuid.uuid4())
        self.registered_token(install_id)
        self.control('/__fake/offline', {'is_offline': True})
        self.assertEqual(self.start_phone_check('+447700900777', install_id)[0], 200)
        self.queue('busy')
        self.assertEqual(self.control('/__fake/reset', {})[0], 200)
        state = self.state()
        self.assertEqual((state['is_offline'], state['replaces_phone_numbers'], state['phone_check'], state['queued']['recognize']),
                         (False, False, None, []))
        self.assertEqual(state['recent_registrations'], [])

    def test_the_offline_switch_takes_only_true_or_false(self) -> None:
        for bad in ({'is_offline': 'yes'}, {'offline': True}, [True], {'is_offline': True, 'extra': 1}):
            with self.subTest(bad):
                self.assertEqual(self.control('/__fake/offline', bad)[0], 400)
        self.assertFalse(self.state()['is_offline'])

    # ---- registering again after an update (amendment A3) -----------------------------------------

    def test_a_registration_with_the_installs_own_token_is_a_re_registration(self) -> None:
        install_id = str(uuid.uuid4())
        first_token = self.registered_token(install_id)
        status, body = self.register(install_id, token=first_token, app_version='0.2.0+2')
        self.assertEqual(status, 200)
        new_token = body['install_token']
        self.assertNotEqual(new_token, first_token)
        logged = self.request_log()['requests'][-1]
        self.assertEqual((logged['registration'], logged['carried_token'], logged['app_version']),
                         ('re-registration', 'its own token', '0.2.0+2'))
        self.assertNotIn(first_token, json.dumps(self.request_log()))
        state = self.state()
        self.assertEqual((state['registrations'], state['re_registrations']), (1, 1))
        self.assertEqual(self.recognize(new_token)[0], 200)

    def test_any_other_token_makes_it_a_first_registration_as_on_the_real_api(self) -> None:
        other_install_token = self.registered_token()
        status, _ = self.register(str(uuid.uuid4()), token=other_install_token)
        self.assertEqual(status, 200)
        self.assertEqual(self.request_log()['requests'][-1]['carried_token'], "another install's token")
        status, _ = self.register(str(uuid.uuid4()), token='never.issued.token')
        self.assertEqual(status, 200)
        logged = self.request_log()['requests'][-1]
        self.assertEqual((logged['registration'], logged['carried_token']), ('registration', 'a token the fake never issued'))
        self.assertEqual(self.state()['re_registrations'], 0)

    def test_a_registration_with_an_authorization_that_is_not_a_bearer_token_is_refused(self) -> None:
        for authorization in ('Basic dXNlcjpwYXNz', 'Bearer ', 'Bearer two words', 'bearer token'):
            with self.subTest(authorization):
                headers = {'Content-Type': 'application/json', 'X-Request-Id': str(uuid.uuid4()), 'Authorization': authorization}
                body = json.dumps({'install_id': str(uuid.uuid4()), 'platform': 'ANDROID', 'app_version': '0.1.0+1'}).encode()
                self.assertEqual(self.send('/api/v1/installs', body, headers)[0], 400)

    # ---- the phone number for a phone check (P6-D50, correction 12) -------------------------------

    def match_campaign_numbers(self) -> list[str]:
        """The numbers of the default answer as the shared fixture holds them."""
        numbers = phone_numbers_in(read_fixture('recognition/recognize-response/valid/match-campaign.json')['response'])
        self.assertTrue(numbers)
        return numbers

    def test_the_number_from_the_control_page_replaces_every_number_in_answers_to_the_chosen_install(self) -> None:
        number = '+447700900777'
        install_id = str(uuid.uuid4())
        token = self.registered_token(install_id, through_tunnel=True)
        status, _, body = self.start_phone_check(number, install_id)
        self.assertEqual((status, body), (200, {'replaces_phone_numbers': True}))
        self.queue('match', 'match-more-options', 'fallback')
        for _ in range(3):
            answer = self.recognize(token)[2]
            numbers = phone_numbers_in(answer)
            self.assertTrue(numbers)
            self.assertEqual(set(numbers), {number})
        self.assertEqual(self.control('/__fake/phone-number', {'phone_number': None})[2], {'replaces_phone_numbers': False})
        self.assertEqual(phone_numbers_in(self.recognize(token)[2]), self.match_campaign_numbers())

    def test_answers_to_any_other_install_keep_the_fixtures_numbers(self) -> None:
        number = '+447700900777'
        phone_install = str(uuid.uuid4())
        phone_token = self.registered_token(phone_install, through_tunnel=True)
        stranger_token = self.registered_token(through_tunnel=True)   # anyone else who reaches the tunnel's address
        self.assertEqual(self.start_phone_check(number, phone_install)[0], 200)
        self.assertEqual(phone_numbers_in(self.recognize(stranger_token)[2]), self.match_campaign_numbers())
        self.assertEqual(set(phone_numbers_in(self.recognize(phone_token)[2])), {number})
        # A registration again with the install's own token (amendment A3) is still the chosen install.
        status, registration = self.register(phone_install, token=phone_token, through_tunnel=True)
        self.assertEqual(status, 200)
        self.assertEqual(set(phone_numbers_in(self.recognize(registration['install_token'])[2])), {number})
        self.assertEqual(phone_numbers_in(self.recognize(stranger_token)[2]), self.match_campaign_numbers())

    def test_the_number_is_forgotten_after_the_answers_that_carry_it(self) -> None:
        number = '+447700900777'
        install_id = str(uuid.uuid4())
        token = self.registered_token(install_id)
        self.assertEqual(self.start_phone_check(number, install_id)[0], 200)
        self.queue('no-match')
        self.assertEqual(self.recognize(token)[2]['status'], 'NO_MATCH')   # an answer with no number does not count
        for answer in range(1, PHONE_CHECK_ANSWERS + 1):
            with self.subTest(answer):
                self.assertEqual(self.state()['phone_check']['answers_left'], PHONE_CHECK_ANSWERS - answer + 1)
                self.assertEqual(set(phone_numbers_in(self.recognize(token)[2])), {number})
        state = self.state()
        self.assertEqual((state['replaces_phone_numbers'], state['phone_check']), (False, None))
        self.assertEqual(phone_numbers_in(self.recognize(token)[2]), self.match_campaign_numbers())

    def test_the_number_is_forgotten_minutes_after_it_was_set(self) -> None:
        number = '+447700900777'
        install_id = str(uuid.uuid4())
        token = self.registered_token(install_id)
        self.assertEqual(self.start_phone_check(number, install_id)[0], 200)
        self.assertEqual(self.state()['phone_check'],
                         {'install_label': install_id[:8], 'answers_left': PHONE_CHECK_ANSWERS,
                          'seconds_left': PHONE_CHECK_LIFETIME_SECONDS})
        self.clock.seconds += PHONE_CHECK_LIFETIME_SECONDS - 1
        self.assertEqual(set(phone_numbers_in(self.recognize(token)[2])), {number})
        self.assertEqual(self.state()['phone_check']['seconds_left'], 1)
        self.clock.seconds += 1
        self.assertFalse(self.state()['replaces_phone_numbers'])
        self.assertEqual(phone_numbers_in(self.recognize(token)[2]), self.match_campaign_numbers())

    def test_a_number_is_refused_unless_it_names_an_install_that_registered_lately(self) -> None:
        number = '+447700900777'
        for body in ({'phone_number': number}, {'phone_number': number, 'install_id': str(uuid.uuid4())},
                     {'phone_number': number, 'install_id': None}, {'phone_number': number, 'install_id': 7},
                     {'phone_number': None, 'install_id': str(uuid.uuid4())}):
            with self.subTest(body):
                status, _, answer = self.control('/__fake/phone-number', body)
                self.assertEqual(status, 400)
                self.assertNotIn(number[1:], json.dumps(answer))
        oldest_install = str(uuid.uuid4())
        self.registered_token(oldest_install)
        for _ in range(RECENT_REGISTRATIONS_KEPT):
            self.registered_token()
        self.assertEqual(len(self.state()['recent_registrations']), RECENT_REGISTRATIONS_KEPT)
        self.assertEqual(self.start_phone_check(number, oldest_install)[0], 400, 'no longer listed on the page')
        self.assertFalse(self.state()['replaces_phone_numbers'])

    def test_the_state_lists_recent_installs_by_a_short_label_time_and_route_never_the_address(self) -> None:
        emulator_install = str(uuid.uuid4())
        phone_install = str(uuid.uuid4())
        emulator_token = self.registered_token(emulator_install)
        self.registered_token(phone_install, through_tunnel=True)
        self.register(emulator_install, token=emulator_token)   # registering again moves it up, listed once
        registrations = self.state()['recent_registrations']
        self.assertEqual([(entry['install_id'], entry['install_label'], entry['is_through_tunnel']) for entry in registrations],
                         [(emulator_install, emulator_install[:8], False), (phone_install, phone_install[:8], True)])
        for entry in registrations:
            self.assertRegex(entry['registered_at'], r'^\d{2}:\d{2}:\d{2}$')
            self.assertEqual(entry['app_version'], '0.1.0+1')
        self.assertNotIn(THROUGH_THE_TUNNEL['X-Forwarded-For'], json.dumps(self.state()))

    def test_the_control_page_says_which_answers_carry_the_number_and_when_it_is_forgotten(self) -> None:
        words = ' '.join(self.get('/__fake/panel')[2].decode('utf-8').split())
        for expected in ("Choose your phone's install",
                         'only answers to that install carry it on their buttons',
                         "go to whatever sends that install's requests, through the tunnel too",
                         f'forgotten after {PHONE_CHECK_ANSWERS} answers that carry it or '
                         f'{PHONE_CHECK_LIFETIME_SECONDS // 60} minutes, whichever comes first',
                         'Install that gets the number, newest registration first',
                         'it is never saved, logged or shown again'):
            self.assertIn(expected, words)

    def test_the_number_is_never_echoed_logged_shown_or_written(self) -> None:
        number = '+447700900777'
        install_id = str(uuid.uuid4())
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed), contextlib.redirect_stderr(printed):
            token = self.registered_token(install_id)
            self.start_phone_check(number, install_id)
            self.recognize(token)
            places = {
                'the state': json.dumps(self.state()),
                'the request log': json.dumps(self.request_log()),
                'the control page': self.get('/__fake/panel')[2].decode('utf-8'),
            }
        places['the console'] = printed.getvalue()
        for place, text in places.items():
            with self.subTest(place):
                self.assertNotIn(number, text)
                self.assertNotIn(number[1:], text)
        self.assertTrue(self.state()['replaces_phone_numbers'])

    def test_a_number_that_is_not_e164_is_refused_without_repeating_it(self) -> None:
        install_id = str(uuid.uuid4())
        self.registered_token(install_id)
        for bad in ('07700900777', '+0123456789', '+44 7700 900777', 'call me', 12345678, ''):
            with self.subTest(bad):
                status, _, body = self.start_phone_check(bad, install_id)
                self.assertEqual(status, 400)
                if bad:
                    self.assertNotIn(str(bad), json.dumps(body))
        self.assertFalse(self.state()['replaces_phone_numbers'])
        self.assertEqual(self.control('/__fake/phone-number', {'number': '+447700900777', 'install_id': install_id})[0], 400)

    def test_the_state_holds_counts_and_ids_never_an_answer(self) -> None:
        token = self.registered_token()
        self.queue('choose-station')
        self.recognize(token)
        state_text = json.dumps(self.state())
        for answer_word in ('Brand A', 'Station A', 'Summer service offer', 'phone_number_e164', 'actions'):
            self.assertNotIn(answer_word, state_text)
        self.assertEqual(self.state()['recognitions'][0]['scenario'], 'choose-station')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Lets a test see a redirect instead of following it."""

    def redirect_request(self, *arguments: Any, **keywords: Any) -> None:
        return None


if __name__ == '__main__':
    unittest.main()
