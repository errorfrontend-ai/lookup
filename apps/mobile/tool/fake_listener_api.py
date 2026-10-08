"""A stand-in for the Look Up API that the listener app talks to on the emulator (design §4.6, S4-D29).

Python standard library only, no Docker (the emulator and Docker never run together on the build
machine). It is strict about every request, exactly as the contract in packages/contracts says, and it
answers only with the shared fixtures, so a passing emulator run means the app's requests were right
and the fake cannot drift from the contract.

    python tool/fake_listener_api.py [--port 3999] [--save-audio-to clip.m4a]

The emulator reaches it as http://10.0.2.2:3999/api/v1. Control routes (fake only):
    POST /__fake/scenarios   a JSON list of scenario names, queued in order (default: match)
    GET  /__fake/requests    what the app sent: method, path, header names, ids, field names, sizes
    POST /__fake/reset       empties the queue, the request log and the issued tokens
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).resolve().parents[3] / 'packages' / 'contracts' / 'fixtures'
MAXIMUM_CLIP_BYTES = 262_144
MAXIMUM_BODY_BYTES = 278_528

# The contract's rules (packages/contracts/src/recognition/*.ts), written out for the standard library.
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.IGNORECASE)
APP_VERSION = re.compile(r'^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$')
TIMESTAMP_WITH_OFFSET = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$')
INSTALL_FIELDS = {'install_id', 'platform', 'app_version'}
RECOGNIZE_FIELDS = {'clip_duration_milliseconds', 'codec', 'idempotency_key', 'captured_at', 'sent_at', 'is_deferred'}
CLIENT_ERROR_FIELDS = {'source', 'kind', 'message', 'stack', 'location', 'relatedRequestId', 'appVersion'}

# Each scenario's answer, from the shared fixtures. Retry-After is shortened for busy so the run is quick.
SCENARIOS: dict[str, dict[str, Any]] = {
    'match': {'response': 'recognition/recognize-response/valid/match-campaign.json'},
    'fallback': {'response': 'recognition/recognize-response/valid/match-client-default.json'},
    'no-match': {'response': 'recognition/recognize-response/valid/no-match.json'},
    'choose-station': {'response': 'recognition/recognize-response/valid/choose-station.json'},
    'busy': {'envelope': 'errors/envelopes/recognition-busy.json', 'retry_after_seconds': 2},
    'timeout': {'envelope': 'errors/envelopes/recognition-timeout.json', 'retry_after_seconds': 2},
    'error': {'envelope': 'errors/envelopes/internal.json'},
    'rate-limited': {'envelope': 'errors/envelopes/rate-limited.json'},
    'token-invalid-once': {'envelope': 'errors/envelopes/install-token-invalid.json'},
    'invalid-audio': {'envelope': 'errors/envelopes/invalid-audio.json'},
    'unreadable': {'unreadable': True},
    'drop': {'drop': True},
}


class RequestRefused(Exception):
    """A request the real API would refuse: the fake answers 400 and logs why, so the test fails."""


class FakeState:
    def __init__(self, save_audio_to: Path | None) -> None:
        self.lock = threading.Lock()
        self.save_audio_to = save_audio_to
        self.reset()

    def reset(self) -> None:
        with self.lock:
            self.scenarios: list[str] = []
            self.requests: list[dict[str, Any]] = []
            self.issued_tokens: set[str] = set()
            self.client_error_reports: list[dict[str, Any]] = []

    def next_scenario(self) -> str:
        with self.lock:
            return self.scenarios.pop(0) if self.scenarios else 'match'


def read_fixture(relative_path: str) -> dict[str, Any]:
    return json.loads((FIXTURES / relative_path).read_text(encoding='utf-8'))


def check_uuid(value: Any, name: str) -> None:
    if not isinstance(value, str) or not UUID.match(value):
        raise RequestRefused(f'{name} is not a UUID')


def check_install_input(body: Any) -> None:
    if not isinstance(body, dict) or set(body) != INSTALL_FIELDS:
        raise RequestRefused(f'install body must have exactly {sorted(INSTALL_FIELDS)}')
    check_uuid(body['install_id'], 'install_id')
    if body['platform'] not in ('ANDROID', 'IOS'):
        raise RequestRefused('platform must be ANDROID or IOS')
    if not isinstance(body['app_version'], str) or not APP_VERSION.match(body['app_version']):
        raise RequestRefused('app_version does not match the contract')


def check_recognize_fields(fields: dict[str, str]) -> None:
    extra = set(fields) - RECOGNIZE_FIELDS - {'station_hint'}
    missing = RECOGNIZE_FIELDS - set(fields)
    if extra or missing:
        raise RequestRefused(f'recognize fields: missing {sorted(missing)}, unexpected {sorted(extra)}')
    duration = fields['clip_duration_milliseconds']
    if not re.fullmatch(r'[0-9]{1,6}', duration) or not 2_000 <= int(duration) <= 15_000:
        raise RequestRefused('clip_duration_milliseconds out of range')
    if fields['codec'] not in ('aac', 'opus'):
        raise RequestRefused('codec must be aac or opus')
    check_uuid(fields['idempotency_key'], 'idempotency_key')
    for name in ('captured_at', 'sent_at'):
        if not TIMESTAMP_WITH_OFFSET.match(fields[name]):
            raise RequestRefused(f'{name} is not a timestamp with an offset')
    if fields['is_deferred'] not in ('true', 'false'):
        raise RequestRefused('is_deferred must be true or false')
    if 'station_hint' in fields:
        check_uuid(fields['station_hint'], 'station_hint')


def read_multipart(content_type: str, body: bytes) -> tuple[dict[str, str], dict[str, Any] | None]:
    """The text fields, and the one file part `audio` (its bytes, file name and type)."""
    if not content_type.startswith('multipart/form-data'):
        raise RequestRefused('recognize must be multipart/form-data')
    message = BytesParser(policy=HTTP).parsebytes(b'Content-Type: ' + content_type.encode('latin-1') + b'\r\n\r\n' + body)
    if not message.is_multipart():
        raise RequestRefused('the multipart body could not be read')
    fields: dict[str, str] = {}
    audio: dict[str, Any] | None = None
    order: list[str] = []
    for part in message.iter_parts():
        name = part.get_param('name', header='content-disposition')
        file_name = part.get_param('filename', header='content-disposition')
        order.append(name)
        if file_name is not None:
            if name != 'audio' or audio is not None:
                raise RequestRefused(f'unexpected file part {name}')
            audio = {'bytes': part.get_payload(decode=True) or b'', 'file_name': file_name, 'content_type': part.get_content_type()}
        else:
            if name in fields:
                raise RequestRefused(f'field {name} sent twice')
            fields[name] = (part.get_payload(decode=True) or b'').decode('utf-8')
    if order and order[-1] != 'audio':
        raise RequestRefused('the audio part must come last')
    return fields, audio


class FakeListenerApi(BaseHTTPRequestHandler):
    server_version = 'FakeLookUpApi'
    state: FakeState

    def log_message(self, format: str, *arguments: Any) -> None:  # quiet: the request log is the record
        pass

    # ---- answering ---------------------------------------------------------------------------------

    def answer_json(self, status: int, body: Any, request_id: str | None = None, retry_after: int | None = None) -> None:
        encoded = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(encoded)))
        if request_id:
            self.send_header('X-Request-Id', request_id)
        if retry_after is not None:
            self.send_header('Retry-After', str(retry_after))
        self.end_headers()
        self.wfile.write(encoded)

    def refuse(self, reason: str, request_id: str | None) -> None:
        self.record({'refused': reason})
        self.answer_json(400, {'error': {'code': 'VALIDATION_FAILED', 'message': 'Fake API refused the request.', 'request_id': request_id or '00000000-0000-4000-8000-000000000000'}}, request_id)

    def record(self, details: dict[str, Any]) -> None:
        with self.state.lock:
            self.state.requests.append({'method': self.command, 'path': self.path, 'header_names': sorted(name.lower() for name in self.headers.keys()), **details})

    def read_body(self) -> bytes:
        length = int(self.headers.get('Content-Length') or 0)
        if length > MAXIMUM_BODY_BYTES:
            raise RequestRefused(f'body of {length} bytes is over {MAXIMUM_BODY_BYTES}')
        return self.rfile.read(length)

    # ---- routes ------------------------------------------------------------------------------------

    def do_GET(self) -> None:
        if self.path == '/__fake/requests':
            with self.state.lock:
                self.answer_json(200, {'requests': self.state.requests, 'client_error_reports': self.state.client_error_reports})
            return
        self.answer_json(404, {'error': {'code': 'NOT_FOUND', 'message': 'Not found.', 'request_id': '00000000-0000-4000-8000-000000000000'}})

    def do_POST(self) -> None:
        request_id = self.headers.get('X-Request-Id')
        try:
            if self.path == '/__fake/scenarios':
                names = json.loads(self.read_body() or b'[]')
                unknown = [name for name in names if name not in SCENARIOS]
                if unknown:
                    raise RequestRefused(f'unknown scenarios {unknown}')
                with self.state.lock:
                    self.state.scenarios.extend(names)
                self.answer_json(200, {'queued': names})
                return
            if self.path == '/__fake/reset':
                self.state.reset()
                self.answer_json(200, {'reset': True})
                return
            check_uuid(request_id, 'X-Request-Id')
            if self.path == '/api/v1/installs':
                self.handle_install(request_id)
            elif self.path == '/api/v1/recognize':
                self.handle_recognize(request_id)
            elif self.path == '/api/v1/client-errors':
                self.handle_client_error(request_id)
            else:
                raise RequestRefused(f'no route {self.path}')
        except RequestRefused as refused:
            self.refuse(str(refused), request_id if request_id and UUID.match(request_id) else None)
        except json.JSONDecodeError:
            self.refuse('the body is not JSON', request_id if request_id and UUID.match(request_id) else None)

    def handle_install(self, request_id: str) -> None:
        if self.headers.get('Authorization'):
            raise RequestRefused('registration must not carry a token')
        body = json.loads(self.read_body())
        check_install_input(body)
        token = 'fake.' + base64.urlsafe_b64encode(secrets.token_bytes(24)).decode('ascii').rstrip('=') + '.token'
        with self.state.lock:
            self.state.issued_tokens.add(token)
        self.record({'request_id': request_id, 'install_id': body['install_id']})
        expires_at = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(timespec='seconds').replace('+00:00', 'Z')
        self.answer_json(200, {'install_token': token, 'expires_at': expires_at}, request_id)

    def handle_recognize(self, request_id: str) -> None:
        authorization = self.headers.get('Authorization') or ''
        token = authorization.removeprefix('Bearer ')
        with self.state.lock:
            is_known_token = authorization.startswith('Bearer ') and token in self.state.issued_tokens
        if not is_known_token:
            raise RequestRefused('recognize needs a bearer token this fake issued')
        body = self.read_body()
        fields, audio = read_multipart(self.headers.get('Content-Type') or '', body)
        check_recognize_fields(fields)
        if audio is None:
            raise RequestRefused('the audio part is missing')
        clip = audio['bytes']
        if len(clip) > MAXIMUM_CLIP_BYTES or clip[4:8] != b'ftyp':
            raise RequestRefused('the clip is too large or not an MP4/M4A')
        if audio['file_name'] != 'clip.m4a' or audio['content_type'] != 'audio/mp4':
            raise RequestRefused('the audio part must be clip.m4a of type audio/mp4')
        if self.state.save_audio_to:
            self.state.save_audio_to.write_bytes(clip)
        scenario = self.state.next_scenario()
        self.record({'request_id': request_id, 'idempotency_key': fields['idempotency_key'], 'field_names': sorted(fields),
                     'audio_bytes': len(clip), 'body_bytes': len(body), 'scenario': scenario})
        self.answer_with_scenario(scenario, request_id, token)

    def answer_with_scenario(self, scenario: str, request_id: str, token: str) -> None:
        plan = SCENARIOS[scenario]
        if plan.get('drop'):
            self.close_connection = True
            self.connection.close()
            return
        if plan.get('unreadable'):
            encoded = b'<html>Bad gateway</html>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(encoded)))
            self.send_header('X-Request-Id', request_id)
            self.end_headers()
            self.wfile.write(encoded)
            return
        if 'response' in plan:
            response = read_fixture(plan['response'])['response']
            response['request_id'] = request_id
            self.answer_json(200, response, request_id)
            return
        envelope = read_fixture(plan['envelope'])
        body = envelope['body']
        body['error']['request_id'] = request_id
        if scenario == 'token-invalid-once':
            with self.state.lock:
                self.state.issued_tokens.discard(token)
        retry_after = plan.get('retry_after_seconds', envelope.get('retry_after_seconds'))
        self.answer_json(envelope['http_status'], body, request_id, retry_after)

    def handle_client_error(self, request_id: str) -> None:
        if self.headers.get('Authorization'):
            raise RequestRefused('a crash report must not carry the install token')
        report = json.loads(self.read_body())
        if not isinstance(report, dict) or not set(report) <= CLIENT_ERROR_FIELDS or not {'source', 'kind', 'message'} <= set(report):
            raise RequestRefused('the report does not match ClientErrorReport')
        if report['source'] != 'listener-app' or report['kind'] not in ('render', 'uncaught', 'unhandled-rejection', 'reported'):
            raise RequestRefused('the report source or kind is wrong')
        if not isinstance(report['message'], str) or not 1 <= len(report['message']) <= 500:
            raise RequestRefused('the report message is empty or too long')
        if 'relatedRequestId' in report:
            check_uuid(report['relatedRequestId'], 'relatedRequestId')
        with self.state.lock:
            self.state.client_error_reports.append({'request_id': request_id, **report})
        self.record({'request_id': request_id, 'client_error_kind': report['kind']})
        self.send_response(202)
        self.send_header('X-Request-Id', request_id)
        self.send_header('Content-Length', '0')
        self.end_headers()


def make_server(host: str, port: int, save_audio_to: Path | None) -> ThreadingHTTPServer:
    handler = type('BoundFakeListenerApi', (FakeListenerApi,), {'state': FakeState(save_audio_to)})
    return ThreadingHTTPServer((host, port), handler)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=3999)
    parser.add_argument('--save-audio-to', type=Path)
    arguments = parser.parse_args()
    server = make_server(arguments.host, arguments.port, arguments.save_audio_to)
    print(f'fake Look Up API on http://{arguments.host}:{server.server_port}/api/v1', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
