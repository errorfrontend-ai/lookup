"""A stand-in for the Look Up API that the listener app talks to on the emulator (design §4.6, S4-D29; P6 design §4.7).

Python standard library only, no Docker (the emulator and Docker never run together on the build
machine). It is strict about every request, exactly as the contract in packages/contracts says, and it
answers only with the shared fixtures, so a passing emulator run means the app's requests were right
and the fake cannot drift from the contract.

    python tool/fake_listener_api.py [--port 3999] [--save-audio-to clip.m4a]

The emulator reaches it as http://10.0.2.2:3999/api/v1. Open the control page in the PC's browser:

    http://127.0.0.1:3999/__fake/panel

Control routes (fake only; refused when forwarded, as through ngrok, and from any other web page):
    GET  /__fake/panel            the control page: next answers, "No signal", a phone number, what the app sent
    GET  /__fake/state            what the fake holds: switches, queued answers, counts and ids (never an answer)
    GET  /__fake/requests         what the app sent: method, path, header names, ids, field names, sizes
    POST /__fake/scenarios        a JSON list of scenario names, each queued for its own route (default: match)
    POST /__fake/offline          {"is_offline": true|false}: "No signal" closes every /api/v1 connection unanswered
    POST /__fake/phone-number     {"phone_number": "+E.164" or null}: numbers in answers become this one, in memory
    POST /__fake/reset            empties the queues, the logs, the issued tokens and the switches

Every control POST must be JSON, carry no Origin or this page's own, and name this machine as its Host
(P6-D50). The phone number is never written, logged, echoed or shown: the state and the page say only
whether one is set.
"""

from __future__ import annotations

import argparse
import base64
import html
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
MAXIMUM_CONTROL_BODY_BYTES = 8_192
MAXIMUM_ACTIONS_PER_CARD = 6   # the contract's MAXIMUM_ACTIONS_PER_CARD (packages/contracts/src/action-card)

# The contract's rules (packages/contracts/src/recognition/*.ts), written out for the standard library.
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.IGNORECASE)
APP_VERSION = re.compile(r'^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$')
TIMESTAMP_WITH_OFFSET = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$')
BEARER_TOKEN = re.compile(r'^[A-Za-z0-9\-._~+/]+=*$')
E164 = re.compile(r'^\+[1-9][0-9]{7,14}$')
INSTALL_FIELDS = {'install_id', 'platform', 'app_version'}
RECOGNIZE_FIELDS = {'clip_duration_milliseconds', 'codec', 'idempotency_key', 'captured_at', 'sent_at', 'is_deferred'}
CLIENT_ERROR_FIELDS = {'source', 'kind', 'message', 'stack', 'location', 'relatedRequestId', 'appVersion', 'occurredAt'}

# How long busy and timeout answers ask the app to wait. Long enough that Busy stays on screen across two or more
# uiautomator reads (about 2-3 s each), so the emulator run can require seeing it; short enough to keep the run
# quick. The app accepts 1-60 s (design S4-D11).
BUSY_RETRY_AFTER_SECONDS = 6

RECOGNIZE_ROUTE = 'recognize'

# Each scenario's answer, from the shared fixtures, the route whose queue it joins, and the words the control page
# shows on its button ("Next answer: Which station?").
SCENARIOS: dict[str, dict[str, Any]] = {
    'match': {'route': RECOGNIZE_ROUTE, 'label': 'Match',
              'response': 'recognition/recognize-response/valid/match-campaign.json'},
    'fallback': {'route': RECOGNIZE_ROUTE, 'label': "The advertiser's usual card",
                 'response': 'recognition/recognize-response/valid/match-client-default.json'},
    'no-match': {'route': RECOGNIZE_ROUTE, 'label': 'No match',
                 'response': 'recognition/recognize-response/valid/no-match.json'},
    'choose-station': {'route': RECOGNIZE_ROUTE, 'label': 'Which station?',
                       'response': 'recognition/recognize-response/valid/choose-station.json'},
    # match-campaign.json's card with the buttons of six-actions.json it does not already hold (by id), up to the six
    # a card may have: four buttons, then "More options" for the rest (design §2.6, S4-D18).
    'match-more-options': {'route': RECOGNIZE_ROUTE, 'label': 'Match with six buttons',
                           'response': 'recognition/recognize-response/valid/match-campaign.json',
                           'extra_actions_from': 'action-card/valid/six-actions.json'},
    'busy': {'route': RECOGNIZE_ROUTE, 'label': 'Busy', 'envelope': 'errors/envelopes/recognition-busy.json',
             'retry_after_seconds': BUSY_RETRY_AFTER_SECONDS},
    # A busy answer with no X-Request-Id header and no request_id in the body, as a proxy in front of the API might
    # send. The app waits as for busy; the 4th such answer to one clip is a phone failure, reported, because the
    # screen shows a code only for an id the API logged (T21; SendPolicy._serverFailure in send_policy.dart).
    'busy-without-request-id': {'route': RECOGNIZE_ROUTE, 'label': 'Busy, with no request id',
                                'envelope': 'errors/envelopes/recognition-busy.json',
                                'retry_after_seconds': BUSY_RETRY_AFTER_SECONDS, 'without_request_id': True},
    'timeout': {'route': RECOGNIZE_ROUTE, 'label': 'Busy (the check timed out)',
                'envelope': 'errors/envelopes/recognition-timeout.json',
                'retry_after_seconds': BUSY_RETRY_AFTER_SECONDS},
    'error': {'route': RECOGNIZE_ROUTE, 'label': 'Server error', 'envelope': 'errors/envelopes/internal.json'},
    'rate-limited': {'route': RECOGNIZE_ROUTE, 'label': 'Too many tries',
                     'envelope': 'errors/envelopes/rate-limited.json'},
    'token-invalid-once': {'route': RECOGNIZE_ROUTE, 'label': 'Token refused, once',
                           'envelope': 'errors/envelopes/install-token-invalid.json'},
    'invalid-audio': {'route': RECOGNIZE_ROUTE, 'label': 'Recording unusable',
                      'envelope': 'errors/envelopes/invalid-audio.json'},
    'unreadable': {'route': RECOGNIZE_ROUTE, 'label': 'An answer the app cannot read', 'unreadable': True},
    'drop': {'route': RECOGNIZE_ROUTE, 'label': 'Connection dropped after the clip', 'drop': True},
}

# What each route answers when its queue is empty.
DEFAULT_SCENARIOS: dict[str, str] = {RECOGNIZE_ROUTE: 'match'}
ROUTES = tuple(DEFAULT_SCENARIOS)

# The headers a tunnel or proxy adds: a control request that carries one came from outside this machine (P6-D30).
FORWARDING_HEADERS = ('X-Forwarded-For', 'X-Forwarded-Host', 'Forwarded')


class RequestRefused(Exception):
    """A request the real API would refuse: the fake answers 400 and logs why, so the test fails."""


class ControlRefused(Exception):
    """A control request from somewhere it must not come from (P6-D30, P6-D50): answered with [status], never acted
    on."""

    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.status = status


class FakeState:
    def __init__(self, save_audio_to: Path | None) -> None:
        self.lock = threading.Lock()
        self.save_audio_to = save_audio_to
        self.reset()

    def reset(self) -> None:
        with self.lock:
            self.scenarios: dict[str, list[str]] = {route: [] for route in ROUTES}
            self.requests: list[dict[str, Any]] = []
            # Each token the fake issued, and the install it was issued to.
            self.issued_tokens: dict[str, str] = {}
            self.client_error_reports: list[dict[str, Any]] = []
            self.is_offline = False
            # Kept in memory only; never written, logged, echoed or shown (P6-D50, correction 12).
            self.replacement_phone_number: str | None = None

    def queue(self, names: list[str]) -> None:
        with self.lock:
            for name in names:
                self.scenarios[SCENARIOS[name]['route']].append(name)

    def next_scenario(self, route: str) -> str:
        with self.lock:
            queue = self.scenarios[route]
            return queue.pop(0) if queue else DEFAULT_SCENARIOS[route]

    def snapshot(self) -> dict[str, Any]:
        """What the fake holds, as counts and ids only: never an answer, a body or the phone number."""
        with self.lock:
            requests = list(self.requests)
            return {
                'is_offline': self.is_offline,
                'replaces_phone_numbers': self.replacement_phone_number is not None,
                'queued': {route: list(names) for route, names in self.scenarios.items()},
                'request_counts': {
                    path: sum(1 for request in requests if request.get('path') == path)
                    for path in sorted({str(request.get('path')) for request in requests})
                },
                'registrations': sum(1 for request in requests if request.get('registration') == 'registration'),
                're_registrations': sum(1 for request in requests if request.get('registration') == 're-registration'),
                'dropped_while_offline': sum(1 for request in requests if request.get('dropped') == 'offline'),
                'refused': sum(1 for request in requests if 'refused' in request),
                'recognitions': [
                    {'request_id': request.get('request_id'), 'idempotency_key': request.get('idempotency_key'),
                     'scenario': request.get('scenario')}
                    for request in requests if 'scenario' in request
                ],
                'client_error_report_ids': [report.get('request_id') for report in self.client_error_reports],
                'recent_requests': [
                    {'method': request.get('method'), 'path': request.get('path'),
                     'request_id': request.get('request_id'), 'outcome': outcome_of(request)}
                    for request in requests[-20:]
                ],
            }


def outcome_of(request: dict[str, Any]) -> str:
    """What became of one logged request, in a few words for the control page."""
    if 'refused' in request:
        return f"refused: {request['refused']}"
    if 'dropped' in request:
        return f"dropped: {request['dropped']}"
    for key in ('scenario', 'registration', 'client_error_kind'):
        if key in request:
            return str(request[key])
    return 'answered'


def read_fixture(relative_path: str) -> dict[str, Any]:
    return json.loads((FIXTURES / relative_path).read_text(encoding='utf-8'))


def add_actions(card: dict[str, Any], extra_actions: list[dict[str, Any]]) -> None:
    """Adds to [card] the [extra_actions] whose ids it does not hold yet, in order, up to MAXIMUM_ACTIONS_PER_CARD:
    the buttons stay the shared fixtures' own, and every id on the card stays unique, as the contract requires."""
    held_ids = {action['id'] for action in card['actions']}
    new_actions = [action for action in extra_actions if action['id'] not in held_ids]
    card['actions'] = (card['actions'] + new_actions)[:MAXIMUM_ACTIONS_PER_CARD]


def replace_phone_numbers(value: Any, phone_number: str) -> Any:
    """[value] with every `phone_number_e164` in it, at any depth, set to [phone_number]: the fixture's buttons, then
    reaching the user's own phone in a phone check. A copy; the fixture as read is not changed."""
    if isinstance(value, dict):
        return {key: (phone_number if key == 'phone_number_e164' and isinstance(item, str)
                      else replace_phone_numbers(item, phone_number))
                for key, item in value.items()}
    if isinstance(value, list):
        return [replace_phone_numbers(item, phone_number) for item in value]
    return value


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
        self.send_header('Cache-Control', 'no-store')
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

    def read_body(self, limit: int = MAXIMUM_BODY_BYTES) -> bytes:
        length = int(self.headers.get('Content-Length') or 0)
        if length > limit:
            raise RequestRefused(f'body of {length} bytes is over {limit}')
        return self.rfile.read(length)

    def close_unanswered(self) -> None:
        self.close_connection = True
        self.connection.close()

    # ---- the control routes (P6-D30, P6-D50) -------------------------------------------------------

    @property
    def own_port(self) -> int:
        return int(self.server.server_address[1])

    def check_control_request(self, *, changes_state: bool) -> None:
        """Refuses a control request that came through a tunnel, from another web page, or for another host name.

        - Forwarded (ngrok adds X-Forwarded-For): 404, as if there were no such route.
        - A Host other than this machine's own name and port (DNS rebinding): 403.
        - For a request that changes something: not JSON (a cross-site form or text/plain POST needs no preflight),
          or an Origin other than this page's own: 415 and 403. A cross-site JSON POST needs a preflight, which the
          fake never answers."""
        if any(self.headers.get(name) is not None for name in FORWARDING_HEADERS):
            raise ControlRefused(404, 'forwarded')
        allowed_hosts = {f'127.0.0.1:{self.own_port}', f'localhost:{self.own_port}'}
        if (self.headers.get('Host') or '').lower() not in allowed_hosts:
            raise ControlRefused(403, 'host')
        if not changes_state:
            return
        media_type = (self.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        if media_type != 'application/json':
            raise ControlRefused(415, 'content type')
        origin = self.headers.get('Origin')
        if origin is not None and origin != f'http://127.0.0.1:{self.own_port}':
            raise ControlRefused(403, 'origin')

    def answer_control_refusal(self, refusal: ControlRefused) -> None:
        # The refusal says only which rule, never what the request carried; nothing is acted on or recorded.
        if refusal.status == 404:
            self.answer_json(404, {'error': {'code': 'NOT_FOUND', 'message': 'Not found.', 'request_id': '00000000-0000-4000-8000-000000000000'}})
        else:
            self.answer_json(refusal.status, {'refused': str(refusal)})

    def read_control_json(self) -> Any:
        try:
            return json.loads(self.read_body(MAXIMUM_CONTROL_BODY_BYTES) or b'null')
        except json.JSONDecodeError as error:
            raise ControlRefused(400, 'the body is not JSON') from error

    def answer_panel(self) -> None:
        if (self.headers.get('Host') or '').lower() == f'localhost:{self.own_port}':
            # The control routes accept only this page's own origin, which is the 127.0.0.1 one.
            self.send_response(302)
            self.send_header('Location', f'http://127.0.0.1:{self.own_port}/__fake/panel')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        nonce = secrets.token_urlsafe(16)
        encoded = render_panel(nonce, self.own_port).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy',
                         f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; "
                         "connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(encoded)

    def handle_control_get(self) -> None:
        try:
            self.check_control_request(changes_state=False)
        except ControlRefused as refusal:
            self.answer_control_refusal(refusal)
            return
        if self.path == '/__fake/requests':
            with self.state.lock:
                self.answer_json(200, {'requests': self.state.requests, 'client_error_reports': self.state.client_error_reports})
        elif self.path == '/__fake/state':
            self.answer_json(200, self.state.snapshot())
        elif self.path == '/__fake/panel':
            self.answer_panel()
        else:
            self.answer_control_refusal(ControlRefused(404, 'no route'))

    def handle_control_post(self) -> None:
        try:
            self.check_control_request(changes_state=True)
            body = self.read_control_json()
            if self.path == '/__fake/scenarios':
                if not isinstance(body, list) or not all(isinstance(name, str) for name in body):
                    raise ControlRefused(400, 'scenarios must be a list of names')
                unknown = [name for name in body if name not in SCENARIOS]
                if unknown:
                    raise ControlRefused(400, f'unknown scenarios {unknown}')
                self.state.queue(body)
                self.answer_json(200, {'queued': body})
            elif self.path == '/__fake/offline':
                if not isinstance(body, dict) or set(body) != {'is_offline'} or not isinstance(body['is_offline'], bool):
                    raise ControlRefused(400, 'the body must be {"is_offline": true or false}')
                with self.state.lock:
                    self.state.is_offline = body['is_offline']
                self.answer_json(200, {'is_offline': body['is_offline']})
            elif self.path == '/__fake/phone-number':
                if not isinstance(body, dict) or set(body) != {'phone_number'}:
                    raise ControlRefused(400, 'the body must be {"phone_number": "+E.164" or null}')
                phone_number = body['phone_number']
                if phone_number is not None and (not isinstance(phone_number, str) or not E164.match(phone_number)):
                    # The refusal never repeats the value it refused.
                    raise ControlRefused(400, 'the phone number is not an E.164 number such as +447700900123')
                with self.state.lock:
                    self.state.replacement_phone_number = phone_number
                self.answer_json(200, {'replaces_phone_numbers': phone_number is not None})
            elif self.path == '/__fake/reset':
                self.state.reset()
                self.answer_json(200, {'reset': True})
            else:
                raise ControlRefused(404, 'no route')
        except ControlRefused as refusal:
            self.answer_control_refusal(refusal)
        except RequestRefused as refused:   # a control body over its size limit
            self.answer_json(413, {'refused': str(refused)})

    # ---- routes ------------------------------------------------------------------------------------

    def drops_while_offline(self) -> bool:
        """With "No signal" on, a listener request's connection is closed before anything else happens, so no queued
        answer is spent on it (P6-D50). The body is read first, so the app sees a closed connection, as after a drop."""
        with self.state.lock:
            is_offline = self.state.is_offline
        if not is_offline:
            return False
        self.record({'dropped': 'offline'})
        try:
            self.read_body()
        except (RequestRefused, OSError, ValueError):
            pass
        self.close_unanswered()
        return True

    def do_GET(self) -> None:
        if self.path.startswith('/__fake/'):
            self.handle_control_get()
            return
        if self.path.startswith('/api/v1/') and self.drops_while_offline():
            return
        self.answer_json(404, {'error': {'code': 'NOT_FOUND', 'message': 'Not found.', 'request_id': '00000000-0000-4000-8000-000000000000'}})

    def do_POST(self) -> None:
        if self.path.startswith('/__fake/'):
            self.handle_control_post()
            return
        if self.path.startswith('/api/v1/') and self.drops_while_offline():
            return
        request_id = self.headers.get('X-Request-Id')
        try:
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
        """A registration, or, with the install's own token as a bearer header, a re-registration (amendment A3). As
        on the real API, any other token (one the fake never issued, or another install's) makes it a first
        registration; a header that is not `Bearer <token>` is refused, because the app never sends one."""
        authorization = self.headers.get('Authorization')
        carried_token: str | None = None
        if authorization is not None:
            token = authorization.removeprefix('Bearer ')
            if not authorization.startswith('Bearer ') or not BEARER_TOKEN.match(token) or len(token) > 1024:
                raise RequestRefused('a registration may carry only Authorization: Bearer <install token>')
            carried_token = token
        body = json.loads(self.read_body())
        check_install_input(body)
        with self.state.lock:
            issued_to = self.state.issued_tokens.get(carried_token) if carried_token else None
        if carried_token is None:
            carried = 'none'
        elif issued_to is None:
            carried = 'a token the fake never issued'
        elif issued_to != body['install_id']:
            carried = "another install's token"
        else:
            carried = 'its own token'
        registration = 're-registration' if carried == 'its own token' else 'registration'
        token = 'fake.' + base64.urlsafe_b64encode(secrets.token_bytes(24)).decode('ascii').rstrip('=') + '.token'
        with self.state.lock:
            self.state.issued_tokens[token] = body['install_id']
        self.record({'request_id': request_id, 'install_id': body['install_id'], 'app_version': body['app_version'],
                     'registration': registration, 'carried_token': carried})
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
        scenario = self.state.next_scenario(RECOGNIZE_ROUTE)
        self.record({'request_id': request_id, 'idempotency_key': fields['idempotency_key'], 'field_names': sorted(fields),
                     'audio_bytes': len(clip), 'body_bytes': len(body), 'scenario': scenario})
        self.answer_with_scenario(scenario, request_id, token)

    def answer_with_scenario(self, scenario: str, request_id: str, token: str) -> None:
        plan = SCENARIOS[scenario]
        if plan.get('drop'):
            self.close_unanswered()
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
            if 'extra_actions_from' in plan:
                add_actions(response['result']['card'], read_fixture(plan['extra_actions_from'])['card']['actions'])
            with self.state.lock:
                replacement = self.state.replacement_phone_number
            if replacement is not None:
                response = replace_phone_numbers(response, replacement)
            self.answer_json(200, response, request_id)
            return
        envelope = read_fixture(plan['envelope'])
        body = envelope['body']
        answered_request_id: str | None = request_id
        if plan.get('without_request_id'):
            del body['error']['request_id']
            answered_request_id = None
        else:
            body['error']['request_id'] = request_id
        if scenario == 'token-invalid-once':
            with self.state.lock:
                self.state.issued_tokens.pop(token, None)
        retry_after = plan.get('retry_after_seconds', envelope.get('retry_after_seconds'))
        self.answer_json(envelope['http_status'], body, answered_request_id, retry_after)

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
        # A report queued offline carries the phone's time of the error (contract §1.7, P6-ERRORREPORTING-05).
        if 'occurredAt' in report and (not isinstance(report['occurredAt'], str) or not TIMESTAMP_WITH_OFFSET.match(report['occurredAt'])):
            raise RequestRefused('occurredAt is not a timestamp with an offset')
        with self.state.lock:
            self.state.client_error_reports.append({'request_id': request_id, **report})
        self.record({'request_id': request_id, 'client_error_kind': report['kind']})
        self.send_response(202)
        self.send_header('X-Request-Id', request_id)
        self.send_header('Content-Length', '0')
        self.end_headers()


# ---- The control page ----------------------------------------------------------------------------------------

def render_panel(nonce: str, port: int) -> str:
    """The control page (P6 design §4.7, §5.0 (a)): a button per answer, "No signal" on and off, a phone number for a
    phone check, reset, and a live view of what the app sent. Standard-library HTML with one inline script, allowed by
    its nonce; every control is a JSON POST from this page's own origin."""
    by_route: dict[str, list[tuple[str, str]]] = {route: [] for route in ROUTES}
    for name, plan in SCENARIOS.items():
        by_route[plan['route']].append((name, plan['label']))
    scenario_buttons = '\n'.join(
        f'<button type="button" class="answer" data-scenario="{html.escape(name)}">'
        f'Next answer: {html.escape(label)}</button>'
        for route in ROUTES for name, label in by_route[route])
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Look Up stand-in API</title>
<style nonce="{nonce}">
  :root {{ color-scheme: light dark; --ground: #f5f2ee; --surface: #ffffff; --ink: #1c1917; --muted: #57534e;
          --line: #d6d3d1; --accent: #a8431a; --on-accent: #ffffff; --warning: #92400e; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --ground: #171412; --surface: #211d1a; --ink: #f5f2ee;
          --muted: #b8b1aa; --line: #3a3431; --accent: #e07a4f; --on-accent: #1c1917; --warning: #f2b45a; }} }}
  body {{ margin: 0; padding: 16px; background: var(--ground); color: var(--ink);
         font: 16px/1.5 system-ui, sans-serif; }}
  main {{ max-width: 960px; margin: 0 auto; }}
  h1 {{ font-size: 24px; margin: 0 0 4px; }}
  h2 {{ font-size: 18px; margin: 0 0 8px; }}
  p {{ margin: 0 0 12px; color: var(--muted); }}
  section {{ background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px;
             margin: 0 0 16px; }}
  .buttons {{ display: flex; flex-wrap: wrap; gap: 8px; }}
  button {{ min-height: 44px; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--line);
            background: var(--surface); color: var(--ink); font: inherit; cursor: pointer; }}
  button.primary, button.answer {{ background: var(--accent); color: var(--on-accent); border-color: var(--accent); }}
  button:focus-visible, input:focus-visible {{ outline: 3px solid var(--accent); outline-offset: 2px; }}
  input {{ min-height: 44px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line);
           background: var(--ground); color: var(--ink); font: inherit; width: min(100%, 260px); }}
  #status {{ font-weight: 600; }}
  .signal-off {{ color: var(--warning); }}
  table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
  th, td {{ text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top;
            overflow-wrap: anywhere; }}
  .table-scroll {{ overflow-x: auto; }}
</style>
</head>
<body>
<main>
  <h1>Look Up stand-in API</h1>
  <p>The emulator's app talks to this stand-in at http://10.0.2.2:{port}/api/v1. Choose its next answer, cut its
     signal, then use the app. This page only works from this PC: requests through a tunnel are refused.</p>

  <section aria-labelledby="answers-heading">
    <h2 id="answers-heading">Next answer to "Tap to identify"</h2>
    <p>Each button queues one answer; with none queued, the app gets "Match".</p>
    <div class="buttons">
{scenario_buttons}
    </div>
    <p id="queued" aria-live="polite"></p>
  </section>

  <section aria-labelledby="signal-heading">
    <h2 id="signal-heading">Signal</h2>
    <p>"No signal" closes every request from the app without an answer, as a network that looks connected but
       carries nothing. Queued answers wait for the first request that gets through.</p>
    <p id="signal" aria-live="polite"></p>
    <div class="buttons">
      <button type="button" id="signal-off">No signal</button>
      <button type="button" id="signal-on" class="primary">Signal back</button>
    </div>
  </section>

  <section aria-labelledby="number-heading">
    <h2 id="number-heading">Phone number for a phone check</h2>
    <p>Answers then carry this number on their buttons, so a call reaches your own phone. It stays in this
       stand-in's memory only: it is never saved, logged or shown again. Reset or "Stop replacing" forgets it.</p>
    <label for="phone-number">Number in international form, for example +447700900123</label><br>
    <input id="phone-number" type="tel" inputmode="tel" autocomplete="off" spellcheck="false"
           placeholder="+447700900123">
    <div class="buttons">
      <button type="button" id="use-number" class="primary">Use this number</button>
      <button type="button" id="stop-number">Stop replacing</button>
    </div>
    <p id="number-status" aria-live="polite"></p>
  </section>

  <section aria-labelledby="sent-heading">
    <h2 id="sent-heading">What the app sent</h2>
    <p id="counts"></p>
    <div class="table-scroll">
      <table>
        <thead><tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Outcome</th>
                   <th scope="col">Request id</th></tr></thead>
        <tbody id="recent"></tbody>
      </table>
    </div>
    <div class="buttons"><button type="button" id="reset">Reset everything</button></div>
  </section>
  <p id="status" role="status" aria-live="polite"></p>
</main>
<script nonce="{nonce}">
  'use strict';
  const statusLine = document.getElementById('status');
  async function control(path, body, done) {{
    try {{
      const answer = await fetch(path, {{ method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
                                          body: JSON.stringify(body) }});
      const text = answer.ok ? done : 'The stand-in refused that (' + answer.status + ').';
      statusLine.textContent = text;
    }} catch (error) {{
      statusLine.textContent = 'The stand-in did not answer. Is it still running?';
    }}
    await refresh();
  }}
  function cell(row, text) {{ const td = document.createElement('td'); td.textContent = text ?? ''; row.appendChild(td); }}
  async function refresh() {{
    try {{
      const state = await (await fetch('/__fake/state')).json();
      const queued = state.queued.recognize;
      document.getElementById('queued').textContent = queued.length
        ? 'Queued: ' + queued.join(', ') : 'Nothing queued: the next answer is "match".';
      const signal = document.getElementById('signal');
      signal.textContent = state.is_offline ? 'No signal: requests are cut off.' : 'Signal: requests are answered.';
      signal.className = state.is_offline ? 'signal-off' : '';
      document.getElementById('number-status').textContent = state.replaces_phone_numbers
        ? 'Numbers in answers are being replaced.' : 'Numbers in answers are the fixtures\\' own.';
      document.getElementById('counts').textContent = 'Registrations: ' + state.registrations
        + ' · re-registrations: ' + state.re_registrations + ' · identifies: ' + state.recognitions.length
        + ' · crash reports: ' + state.client_error_report_ids.length + ' · cut off: ' + state.dropped_while_offline
        + ' · refused: ' + state.refused;
      const body = document.getElementById('recent');
      body.replaceChildren();
      for (const request of state.recent_requests.slice().reverse()) {{
        const row = document.createElement('tr');
        cell(row, request.method); cell(row, request.path); cell(row, request.outcome); cell(row, request.request_id);
        body.appendChild(row);
      }}
    }} catch (error) {{
      statusLine.textContent = 'The stand-in did not answer. Is it still running?';
    }}
  }}
  for (const button of document.querySelectorAll('button[data-scenario]')) {{
    button.addEventListener('click', () => control('/__fake/scenarios', [button.dataset.scenario],
      'Queued: ' + button.textContent.replace('Next answer: ', '') + '.'));
  }}
  document.getElementById('signal-off').addEventListener('click',
    () => control('/__fake/offline', {{ is_offline: true }}, 'No signal: requests are now cut off.'));
  document.getElementById('signal-on').addEventListener('click',
    () => control('/__fake/offline', {{ is_offline: false }}, 'Signal back: requests are answered again.'));
  document.getElementById('use-number').addEventListener('click', () => {{
    const field = document.getElementById('phone-number');
    const number = field.value.replace(/[\\s-]/g, '');
    field.value = '';
    control('/__fake/phone-number', {{ phone_number: number }}, 'Numbers in answers now reach that number.');
  }});
  document.getElementById('stop-number').addEventListener('click',
    () => control('/__fake/phone-number', {{ phone_number: null }}, 'Numbers in answers are the fixtures\\' own again.'));
  document.getElementById('reset').addEventListener('click',
    () => control('/__fake/reset', {{}}, 'Everything was reset.'));
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>
'''


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
    print(f'control page: http://127.0.0.1:{server.server_port}/__fake/panel', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
