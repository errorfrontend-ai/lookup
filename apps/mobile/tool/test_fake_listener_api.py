"""The fake API refuses every request the real API would refuse (design §4.6), so a passing emulator run
means the app's requests were right. Standard library only:

    python -m unittest tool/test_fake_listener_api.py
"""

from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from http.client import RemoteDisconnected
from typing import Any

from fake_listener_api import make_server

CLIP = b'\x00\x00\x00\x20ftypM4A ' + bytes(4_000)


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


class FakeListenerApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = make_server('127.0.0.1', 0, None)
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    # ---- helpers -----------------------------------------------------------------------------------

    def send(self, path: str, body: bytes = b'', headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], Any]:
        request = urllib.request.Request(self.base + path, data=body, headers=headers or {}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                raw = response.read()
                return response.status, dict(response.headers), json.loads(raw) if raw and 'json' in (response.headers.get('Content-Type') or '') else raw
        except urllib.error.HTTPError as error:
            with error:
                raw = error.read()
                return error.code, dict(error.headers), json.loads(raw) if raw else None

    def register(self) -> str:
        status, _, body = self.send('/api/v1/installs', json.dumps({'install_id': str(uuid.uuid4()), 'platform': 'ANDROID', 'app_version': '0.1.0+1'}).encode(),
                                    {'Content-Type': 'application/json', 'X-Request-Id': str(uuid.uuid4())})
        self.assertEqual(status, 200)
        return body['install_token']

    def recognize(self, token: str | None, fields: dict[str, str] | None = None, request_id: str | None = None, **multipart_options: Any) -> tuple[int, dict[str, str], Any]:
        body, content_type = multipart(fields or live_fields(), **multipart_options)
        headers = {'Content-Type': content_type, 'X-Request-Id': request_id or str(uuid.uuid4())}
        if token:
            headers['Authorization'] = f'Bearer {token}'
        return self.send('/api/v1/recognize', body, headers)

    def queue(self, *names: str) -> None:
        self.assertEqual(self.send('/__fake/scenarios', json.dumps(list(names)).encode())[0], 200)

    def request_log(self) -> dict[str, Any]:
        with urllib.request.urlopen(self.base + '/__fake/requests', timeout=10) as response:
            return json.loads(response.read())

    # ---- what the app must get right ---------------------------------------------------------------

    def test_a_correct_identify_gets_the_shared_match_answer_with_the_echoed_request_id(self) -> None:
        token = self.register()
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
        token = self.register()
        mistakes = {
            'no token': dict(token=None),
            'a token it never issued': dict(token='made.up.token'),
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
        token = self.register()
        self.queue('busy', 'no-match', 'fallback', 'error', 'rate-limited', 'invalid-audio', 'choose-station')
        status, headers, body = self.recognize(token)
        self.assertEqual((status, body['error']['code'], headers['Retry-After']), (503, 'RECOGNITION_BUSY', '2'))
        self.assertEqual(self.recognize(token)[2]['status'], 'NO_MATCH')
        self.assertEqual(self.recognize(token)[2]['result']['kind'], 'CLIENT_DEFAULT')
        request_id = str(uuid.uuid4())
        status, _, body = self.recognize(token, request_id=request_id)
        self.assertEqual((status, body['error']['code'], body['error']['request_id']), (500, 'INTERNAL', request_id))
        self.assertEqual(self.recognize(token)[0], 429)
        self.assertEqual(self.recognize(token)[2]['error']['code'], 'INVALID_AUDIO')
        self.assertEqual(self.recognize(token)[2]['status'], 'CHOOSE_STATION')
        self.assertEqual(self.recognize(token)[2]['status'], 'MATCH')  # the queue is empty: the default

    def test_an_invalid_token_answer_withdraws_the_token_so_the_app_must_register_again(self) -> None:
        token = self.register()
        self.queue('token-invalid-once')
        self.assertEqual(self.recognize(token)[0], 401)
        self.assertEqual(self.recognize(token)[0], 400)  # the old token is no longer known
        self.assertEqual(self.recognize(self.register())[0], 200)

    def test_drop_closes_the_connection_with_no_answer_and_unreadable_answers_with_html(self) -> None:
        token = self.register()
        self.queue('drop', 'unreadable')
        with self.assertRaises((RemoteDisconnected, ConnectionError, urllib.error.URLError)):
            self.recognize(token)
        status, headers, body = self.recognize(token)
        self.assertEqual(status, 200)
        self.assertIn('text/html', headers['Content-Type'])

    def test_crash_reports_are_checked_and_kept_without_a_token(self) -> None:
        good = {'source': 'listener-app', 'kind': 'reported', 'message': 'Test error from the developer tools'}
        request_id = str(uuid.uuid4())
        status, headers, _ = self.send('/api/v1/client-errors', json.dumps(good).encode(), {'Content-Type': 'application/json', 'X-Request-Id': request_id})
        self.assertEqual((status, headers['X-Request-Id']), (202, request_id))
        for bad in ({**good, 'source': 'portal'}, {**good, 'kind': 'crash'}, {**good, 'message': ''}, {**good, 'secret': 'x'}):
            self.assertEqual(self.send('/api/v1/client-errors', json.dumps(bad).encode(), {'Content-Type': 'application/json', 'X-Request-Id': str(uuid.uuid4())})[0], 400, bad)
        with_token = self.send('/api/v1/client-errors', json.dumps(good).encode(), {'Content-Type': 'application/json', 'X-Request-Id': str(uuid.uuid4()), 'Authorization': 'Bearer x'})
        self.assertEqual(with_token[0], 400)
        self.assertEqual([report['request_id'] for report in self.request_log()['client_error_reports']], [request_id])

    def test_an_unknown_scenario_is_refused_rather_than_silently_answered(self) -> None:
        self.assertEqual(self.send('/__fake/scenarios', json.dumps(['matched']).encode())[0], 400)


if __name__ == '__main__':
    unittest.main()
