"""A stand-in for the Look Up API that the listener app talks to on the emulator (design §4.6, S4-D29; P6 design §4.7).

Python standard library only, no Docker (the emulator and Docker never run together on the build
machine). It is strict about every request, exactly as the contract in packages/contracts says, and it
answers only with the shared fixtures, so a passing emulator run means the app's requests were right
and the fake cannot drift from the contract.

    python tool/fake_listener_api.py [--port 3999] [--save-audio-to clip.m4a] [--public-origin https://…]

The emulator reaches it as http://10.0.2.2:3999/api/v1. Open the control page in the PC's browser:

    http://127.0.0.1:3999/__fake/panel

Control routes (fake only; refused when forwarded, as through ngrok, and from any other web page):
    GET  /__fake/panel            the control page: next answers, "No signal", a phone number, what the app sent
    GET  /__fake/state            what the fake holds: switches, queued answers, counts and ids (never an answer)
    GET  /__fake/requests         what the app sent: method, path, header names, ids, field names, sizes
    POST /__fake/scenarios        a JSON list of scenario names, each queued for its own route (default: match)
    POST /__fake/offline          {"is_offline": true|false}: "No signal" closes every /api/v1 connection unanswered
    POST /__fake/minimum-app-version
                                  {"minimum_app_version": "0.2.0"}: the update gate, as LISTENER_MINIMUM_APP_VERSION on
                                  the real API: an install registered with an older version gets 426 on every route
                                  that takes a token; "0.0.0" or null turns it off
    POST /__fake/phone-number     {"phone_number": "+E.164", "install_id": "<an install that registered lately>"}:
                                  numbers in answers to that install alone become this one, in memory, for its next
                                  3 answers that hold a number or 5 minutes; {"phone_number": null} forgets it
    POST /__fake/account-gate     {"is_required": true|false}: the account gate, as LISTENER_ACCOUNT_REQUIRED on the real
                                  API: an identify from an install with no account is answered ACCOUNT_REQUIRED, not a
                                  MATCH or a "Which station?" (ADR-005)
    POST /__fake/reset            empties the queues, the logs, the issued tokens and the switches (the gate too)

Every control POST must be JSON, carry no Origin or this page's own, and name this machine as its Host
(P6-D50). The phone number is never written, logged, echoed or shown: the state and the page say only
whether one is set, for which install and for how long.

A bearer token the fake did not issue (one from before a reset or a restart, or from the real API) gets 401
INSTALL_TOKEN_INVALID, as from the real guard, so the app registers again; a missing or malformed
Authorization header is refused with 400, because the app never sends one.

Listener routes (contract §1 and §4), each with its own queue of answers:
    POST /api/v1/installs                           a registration, or a re-registration with the install's token
    POST /api/v1/recognize                          an identify: a new UUID version 7 per new idempotency key, and the
                                                    same answer again for a key it already answered ("replay")
    POST /api/v1/recognitions/{id}/choice           the station chosen in a "Which station?" answer it gave this
                                                    install: 204, the first choice wins (P4 design §5.5)
    POST /api/v1/engagements                        a button tap on a card an answer it gave this install showed: 204;
                                                    one per recognition and button; on an unanswered "Which station?"
                                                    the tap is the choice (amendment A4)
    POST /api/v1/recognitions/{id}/report           "Report this" for an answer it gave this install, naming a station
                                                    that answer showed and one of the contract's four reasons: 204, the
                                                    first report wins and a repeat gets 204 too (P6 design §2.14)
    GET  /api/v1/stations                           the "My station" list with ETag "fake-stations-1", kept a day;
                                                    304 when the app sends that ETag back (P4 design §5.6)
    POST /api/v1/client-errors                      a crash report, with no token

Listener account routes (ADR-005; contract listener-account-schemas.ts). Each is refused unless it is exactly what the
contract allows, and answers with the shared fixtures' words. The sign-in code the real API would email is always 042817:
    POST   /api/v1/listener-account/code      {email}: 202; one code a minute for an email
    POST   /api/v1/listener-account/verify    {email, code}: SIGNED_IN for an email with an account, else DETAILS_NEEDED
                                              with a ticket; a wrong code is refused, the fifth locks the email
    POST   /api/v1/listener-account           {email, ticket, gender, age, consent_text_version}: 201, the account made
    GET    /api/v1/listener-account           {is_signed_in, email_masked}
    POST   /api/v1/listener-account/sign-out  204 (the account stays)
    DELETE /api/v1/listener-account           204 (the account is erased, and every install leaves it)
    GET    /api/v1/recognitions/{id}          the result the gate held back, once this install has an account
The gender and age are kept in memory so a deletion can be proved, and are never logged, shown or answered. With the gate
on, a follow-up (a choice, a tap, a report) from an install with no account is refused: it has no result to follow up.

Pictures (P6 design §3.16): "Match with pictures" answers with the shared fixture whose card has a banner
and a station logo. Started with --public-origin, the https address the phone reaches the stand-in by (an ngrok
tunnel), their addresses become drawn pictures it serves itself, so the app can load them; without it they keep the
fixture's addresses, which never load.
    GET  /fake-pictures/{width}x{height}.png        a drawn picture of that size, with no token; cut off by "No signal"
"""

from __future__ import annotations

import argparse
import base64
import functools
import html
import json
import re
import math
import secrets
import struct
import threading
import time
import uuid
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).resolve().parents[3] / 'packages' / 'contracts' / 'fixtures'
MAXIMUM_CLIP_BYTES = 262_144
MAXIMUM_BODY_BYTES = 278_528
MAXIMUM_JSON_BODY_BYTES = 102_400   # the API's JSON body limit (100 KB, configure-http-application.ts)
MAXIMUM_CONTROL_BODY_BYTES = 8_192
MAXIMUM_ACTIONS_PER_CARD = 6   # the contract's MAXIMUM_ACTIONS_PER_CARD (packages/contracts/src/action-card)

# The contract's rules (packages/contracts/src/recognition/*.ts), written out for the standard library.
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.IGNORECASE)
# A recognition id as the API makes it: a lower-case UUID version 7 (the contract's RecognitionId).
RECOGNITION_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
APP_VERSION = re.compile(r'^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$')
TIMESTAMP_WITH_OFFSET = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$')
BEARER_TOKEN = re.compile(r'^[A-Za-z0-9\-._~+/]+=*$')
E164 = re.compile(r'^\+[1-9][0-9]{7,14}$')
INSTALL_FIELDS = {'install_id', 'platform', 'app_version'}
RECOGNIZE_FIELDS = {'clip_duration_milliseconds', 'codec', 'idempotency_key', 'captured_at', 'sent_at', 'is_deferred'}
CLIENT_ERROR_FIELDS = {'source', 'kind', 'message', 'stack', 'location', 'relatedRequestId', 'appVersion', 'occurredAt'}

# What a saved clip's busy and limited answers ask (P4 design §5.2): the real API sheds a deferred send with a random
# 60-300 s Retry-After; the stand-in gives the shortest, so the run stays quick. A deferred 429 asks 90 s.
DEFERRED_SHED_RETRY_AFTER_SECONDS = 60
DEFERRED_LIMITED_RETRY_AFTER_SECONDS = 90

# The update gate's minimum, as LISTENER_MINIMUM_APP_VERSION accepts it, and the one that turns it off (contract
# listener-app-versions.ts).
LISTENER_APP_VERSION = re.compile(r'^([0-9]{1,4})\.([0-9]{1,4})\.([0-9]{1,4})(?:\+([0-9]{1,9}))?$')
NO_MINIMUM_APP_VERSION = '0.0.0'

# How long busy and timeout answers ask the app to wait. Long enough that Busy stays on screen across two or more
# uiautomator reads (about 2-3 s each), so the emulator run can require seeing it; short enough to keep the run
# quick. The app accepts 1-60 s (design S4-D11).
BUSY_RETRY_AFTER_SECONDS = 6

RECOGNIZE_ROUTE = 'recognize'
CHOICE_ROUTE = 'choice'
STATIONS_ROUTE = 'stations'
REPORT_ROUTE = 'report'
ENGAGEMENT_ROUTE = 'engagement'
ENGAGEMENTS_PATH = '/api/v1/engagements'
ENGAGEMENT_FIELDS = {'recognition_id', 'station_id', 'action_id', 'occurred_at', 'sent_at'}

RECOGNIZE_PATH = '/api/v1/recognize'
ACCOUNT_PATH = '/api/v1/listener-account'
ACCOUNT_POST_ACTIONS = {f'{ACCOUNT_PATH}/code': 'code', f'{ACCOUNT_PATH}/verify': 'verify', ACCOUNT_PATH: 'create',
                        f'{ACCOUNT_PATH}/sign-out': 'sign-out'}
RECOGNITION_PATH = re.compile(r'^/api/v1/recognitions/([^/?#]*)$')
STATIONS_PATH = '/api/v1/stations'
CHOICE_PATH = re.compile(r'^/api/v1/recognitions/([^/?#]*)/choice$')
REPORT_PATH = re.compile(r'^/api/v1/recognitions/([^/?#]*)/report$')
# The contract's RECOGNITION_REPORT_REASONS (packages/contracts/src/recognition/recognition-report-schemas.ts).
RECOGNITION_REPORT_REASONS = ('WRONG_OR_MISLEADING_BUTTONS', 'NUMBER_OR_LINK_DOES_NOT_WORK', 'LOOKS_LIKE_A_SCAM',
                              'SOMETHING_ELSE')
# The listener account's rules (packages/contracts/src/listener-accounts/listener-account-schemas.ts; a test keeps the two
# agreeing). The code is always the same, so a run can type it.
FAKE_EMAIL_CODE = '042817'
ACCOUNT_CODE_RESEND_SECONDS = 60
ACCOUNT_CODE_LIFETIME_SECONDS = 600
ACCOUNT_CODE_ATTEMPT_LIMIT = 5
ACCOUNT_GENDERS = ('FEMALE', 'MALE', 'ANOTHER', 'PREFER_NOT_TO_SAY')
ACCOUNT_MINIMUM_AGE = 13
ACCOUNT_MAXIMUM_AGE = 99
ACCOUNT_CONSENT_TEXT_VERSION = 'listener-consent-2026-10'
MAXIMUM_ACCOUNT_EMAIL_LENGTH = 254
ACCOUNT_EMAIL = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
ACCOUNT_CODE = re.compile(r'^[0-9]{6}$')
ACCOUNT_TICKET = re.compile(r'^[A-Za-z0-9_-]{20,300}$')
# Drawn pictures: their address, and the largest side drawn, so no request can ask for a huge one.
PICTURE_PATH = re.compile(r'^/fake-pictures/([0-9]{1,4})x([0-9]{1,4})\.png$')
LARGEST_PICTURE_SIDE = 1600
PUBLIC_ORIGIN = re.compile(r'^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$')
# "Slow answer" (P6 design §4.7): the clip is read at once and the answer waits 8 seconds, past the app's 5 seconds
# before "Still working" (§2.5) and inside its 15 seconds of waiting for an answer.
SLOW_ANSWER_SECONDS = 8

# The "My station" list: one fixed ETag, and the one listener answer that may be kept (contract §1.4).
STATION_LIST_FIXTURE = 'recognition/listener-station-list/valid/two-stations.json'
STATION_LIST_ENTITY_TAG = '"fake-stations-1"'
STATION_LIST_CACHE_CONTROL = 'private, max-age=86400'

# "Match by my station" answers the MATCH of the station the app sent as its hint: the shared fixture of that station's
# own campaign when there is one, otherwise that station's result in a "Which station?" fixture (Station C).
RESPONSES = 'recognition/recognize-response/valid'
HINTED_MATCHES = (f'{RESPONSES}/match-campaign.json', f'{RESPONSES}/match-campaign-station-b.json',
                  f'{RESPONSES}/match-station-without-city.json')
CHOOSERS_WITH_EVERY_STATION = (f'{RESPONSES}/choose-station.json', f'{RESPONSES}/choose-station-three-candidates.json',
                               f'{RESPONSES}/choose-station-four-candidates.json')

# Each scenario's answer, from the shared fixtures, the route whose queue it joins, and the words the control page
# shows on its button ("Next answer: Which station?").
SCENARIOS: dict[str, dict[str, Any]] = {
    'match': {'route': RECOGNIZE_ROUTE, 'label': 'Match',
              'response': f'{RESPONSES}/match-campaign.json'},
    'fallback': {'route': RECOGNIZE_ROUTE, 'label': "The advertiser's usual card",
                 'response': f'{RESPONSES}/match-client-default.json'},
    'no-match': {'route': RECOGNIZE_ROUTE, 'label': 'No match',
                 'response': f'{RESPONSES}/no-match.json'},
    'choose-station': {'route': RECOGNIZE_ROUTE, 'label': 'Which station?',
                       'response': f'{RESPONSES}/choose-station.json'},
    'choose-station-three': {'route': RECOGNIZE_ROUTE, 'label': 'Which station? (three stations)',
                             'response': f'{RESPONSES}/choose-station-three-candidates.json'},
    'choose-station-four': {'route': RECOGNIZE_ROUTE, 'label': 'Which station? (four stations)',
                            'response': f'{RESPONSES}/choose-station-four-candidates.json'},
    # None of the stations has the ad on air: every row carries its client's usual card (P4-FALLBACK-02).
    'choose-station-out-of-window': {'route': RECOGNIZE_ROUTE, 'label': 'Which station, off air',
                                     'response': f'{RESPONSES}/choose-station-out-of-window.json'},
    # The app sends "My station" as station_hint; the server then answers that station's MATCH (P6-CHOOSER-07, -15).
    # A send without a hint is refused, so the run fails.
    'match-by-hint': {'route': RECOGNIZE_ROUTE, 'label': 'Match by my station', 'by_hint': True},
    # match-campaign.json's card with the buttons of six-actions.json it does not already hold (by id), up to the six
    # a card may have: four buttons, then "More options" for the rest (design §2.6, S4-D18).
    'match-more-options': {'route': RECOGNIZE_ROUTE, 'label': 'Match with six buttons',
                           'response': 'recognition/recognize-response/valid/match-campaign.json',
                           'extra_actions_from': 'action-card/valid/six-actions.json'},
    'busy': {'route': RECOGNIZE_ROUTE, 'label': 'Busy', 'envelope': 'errors/envelopes/recognition-busy.json',
             'retry_after_seconds': BUSY_RETRY_AFTER_SECONDS},
    # Station B's own campaign, for two saved clips with two results (P6 design §4.8 step 18).
    'match-station-b': {'route': RECOGNIZE_ROUTE, 'label': 'Match on Station B',
                        'response': f'{RESPONSES}/match-campaign-station-b.json'},
    # A saved clip's send shed by a busy server, and one over the deferred allowance (P6-OFFLINE-17, -18): the app's
    # outbox pauses its clips for the Retry-After, while follow-ups still go.
    'busy-deferred-shed': {'route': RECOGNIZE_ROUTE, 'label': 'Busy (shed)',
                           'envelope': 'errors/envelopes/recognition-busy.json',
                           'retry_after_seconds': DEFERRED_SHED_RETRY_AFTER_SECONDS},
    'rate-limited-deferred': {'route': RECOGNIZE_ROUTE, 'label': 'Too many saved clips',
                              'envelope': 'errors/envelopes/rate-limited.json',
                              'retry_after_seconds': DEFERRED_LIMITED_RETRY_AFTER_SECONDS},
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
    # The answer is kept, then lost on the way (P6-OUTBOX-05): the app saves the clip, sends it again, and gets the
    # same answer as a replay; one recognition however often it is sent.
    'match-answer-lost': {'route': RECOGNIZE_ROUTE, 'label': 'Match, answer lost',
                          'response': f'{RESPONSES}/match-campaign.json', 'drop_after_keeping': True},
    # A slow connection (P6 design §2.5, §4.7): "Match", answered 8 seconds after the clip arrived. The emulator and a
    # tunnel take the whole clip at once, so the app says "Still working" with "Clip sent — waiting for the answer";
    # the growing share is proved by the widget test. (Run 5: reading the clip slowly instead made the emulator's
    # network drop the connection as the answer went out.)
    'slow-answer': {'route': RECOGNIZE_ROUTE, 'label': 'Slow answer', 'response': f'{RESPONSES}/match-campaign.json',
                    'answers_after_seconds': SLOW_ANSWER_SECONDS},
    # A card with a banner and a station logo (P6 design §3.16): drawn pictures with --public-origin.
    'match-with-images': {'route': RECOGNIZE_ROUTE, 'label': 'Match with pictures',
                            'response': f'{RESPONSES}/match-with-images.json', 'pictures': True},
    # A station choice (contract §1.3). Every choice is checked first: a "Which station?" answer this install was
    # given, and one of its stations; anything else is refused, so the run fails.
    'choice-recorded': {'route': CHOICE_ROUTE, 'label': 'Choice accepted'},
    'choice-answer-lost': {'route': CHOICE_ROUTE, 'label': 'Choice kept, answer lost', 'drop': True},
    'choice-busy': {'route': CHOICE_ROUTE, 'label': 'Choice: busy', 'envelope': 'errors/envelopes/service-unavailable.json',
                    'retry_after_seconds': BUSY_RETRY_AFTER_SECONDS},
    'choice-not-a-candidate': {'route': CHOICE_ROUTE, 'label': 'Choice: not one of the stations shown',
                               'envelope': 'errors/envelopes/station-not-a-candidate.json'},
    # A button tap (contract §1.5). Every tap is checked first: an answer this install was given, a station it showed
    # and a button on that station's card; anything else is refused, so the run fails.
    'engagement-recorded': {'route': ENGAGEMENT_ROUTE, 'label': 'Tap accepted'},
    'engagement-answer-lost': {'route': ENGAGEMENT_ROUTE, 'label': 'Tap kept, answer lost', 'drop': True},
    'engagement-busy': {'route': ENGAGEMENT_ROUTE, 'label': 'Tap: busy', 'envelope': 'errors/envelopes/service-unavailable.json',
                        'retry_after_seconds': BUSY_RETRY_AFTER_SECONDS},
    # "Report this" (P6 design §2.14). Every report is checked first: an answer this install was given, a station it
    # showed and one of the four reasons; anything else is refused, so the run fails.
    'report-recorded': {'route': REPORT_ROUTE, 'label': 'Report accepted'},
    'report-answer-lost': {'route': REPORT_ROUTE, 'label': 'Report kept, answer lost', 'drop': True},
    'report-busy': {'route': REPORT_ROUTE, 'label': 'Report: busy', 'envelope': 'errors/envelopes/service-unavailable.json',
                    'retry_after_seconds': BUSY_RETRY_AFTER_SECONDS},
    # The "My station" list (contract §1.4).
    'stations-list': {'route': STATIONS_ROUTE, 'label': 'The station list'},
    'stations-unavailable': {'route': STATIONS_ROUTE, 'label': 'Station list: unavailable',
                             'envelope': 'errors/envelopes/service-unavailable.json',
                             'retry_after_seconds': BUSY_RETRY_AFTER_SECONDS},
}

# What each route answers when its queue is empty, and the heading of its buttons on the control page.
DEFAULT_SCENARIOS: dict[str, str] = {RECOGNIZE_ROUTE: 'match', CHOICE_ROUTE: 'choice-recorded',
                                     STATIONS_ROUTE: 'stations-list', REPORT_ROUTE: 'report-recorded',
                                     ENGAGEMENT_ROUTE: 'engagement-recorded'}
ROUTES = tuple(DEFAULT_SCENARIOS)
ROUTE_HEADINGS: dict[str, str] = {
    RECOGNIZE_ROUTE: 'Next answer to "Tap to identify"',
    CHOICE_ROUTE: 'Next answer to a station choice',
    STATIONS_ROUTE: 'Next answer to the "My station" list',
    REPORT_ROUTE: 'Next answer to "Report this"',
    ENGAGEMENT_ROUTE: 'Next answer to a button tap',
}
ROUTE_DEFAULT_WORDS: dict[str, str] = {
    RECOGNIZE_ROUTE: 'with none queued, the app gets "Match".',
    CHOICE_ROUTE: 'with none queued, a choice is accepted; the first choice of a recording wins.',
    STATIONS_ROUTE: 'with none queued, the app gets Station A and Station B, or "not changed" when it already has them.',
    REPORT_ROUTE: 'with none queued, a report is accepted; the first report of a recording wins, and a repeat is '
                  'accepted too.',
    ENGAGEMENT_ROUTE: 'with none queued, a tap is accepted; one per recording and button, and a repeat is accepted '
                      'too.',
}

# The headers a tunnel or proxy adds: a control request that carries one came from outside this machine (P6-D30).
FORWARDING_HEADERS = ('X-Forwarded-For', 'X-Forwarded-Host', 'Forwarded')

# The number for a phone check goes only into answers to the install chosen on the control page, and is forgotten
# after this many answers that hold a number, or this long after it was set, whichever comes first. Through the tunnel
# the listener routes are public, so the number must not stay in answers longer than the check needs.
PHONE_CHECK_ANSWERS = 3
PHONE_CHECK_LIFETIME_SECONDS = 300
# How many of the installs that registered lately the control page offers to choose from, newest first.
RECENT_REGISTRATIONS_KEPT = 6
# The first characters of an install id, enough for a person to tell installs apart on the control page.
INSTALL_LABEL_LENGTH = 8


class RequestRefused(Exception):
    """A request the real API would refuse: the fake answers 400 and logs why, so the test fails."""


class ControlRefused(Exception):
    """A control request from somewhere it must not come from (P6-D30, P6-D50): answered with [status], never acted
    on."""

    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.status = status


@dataclass
class PhoneCheck:
    """The number for a phone check, kept in memory only and never written, logged, echoed or shown (P6-D50,
    correction 12). It goes only into answers to [install_id], the install chosen on the control page, and is
    forgotten after [answers_left] more answers that hold a number or at [forget_at] by the state's clock."""
    phone_number: str
    install_id: str
    forget_at: float
    answers_left: int


def install_label(install_id: str) -> str:
    """A short label a person can tell installs apart by on the control page."""
    return install_id[:INSTALL_LABEL_LENGTH]


class FakeState:
    def __init__(self, save_audio_to: Path | None, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep, public_origin: str | None = None) -> None:
        self.lock = threading.Lock()
        self.save_audio_to = save_audio_to
        # Seconds, for how long the phone check's number is kept; a test passes its own clock.
        self.clock = clock
        # How a slow answer waits; a test passes its own, so it never really waits.
        self.sleep = sleep
        # The https address the phone reaches the stand-in by, for the drawn pictures' addresses; None without one.
        self.public_origin = public_origin
        self.reset()

    def reset(self) -> None:
        with self.lock:
            self.scenarios: dict[str, list[str]] = {route: [] for route in ROUTES}
            self.requests: list[dict[str, Any]] = []
            # Each token the fake issued, and the install it was issued to.
            self.issued_tokens: dict[str, str] = {}
            self.client_error_reports: list[dict[str, Any]] = []
            self.is_offline = False
            # The installs that registered lately, oldest first, for choosing the phone's install on the control page.
            self.recent_registrations: list[dict[str, Any]] = []
            self.phone_check: PhoneCheck | None = None
            # Each 200 answer to an identify, by (install, idempotency key), for a send of the same key again.
            self.answers_by_key: dict[tuple[str, str], dict[str, Any]] = {}
            # Each recognition the fake answered: the install, the status and the stations it showed.
            self.answered_recognitions: dict[str, dict[str, Any]] = {}
            # The first choice of each recognition, in the order they came: ids only.
            self.choices: list[dict[str, str]] = []
            # The first report of each recognition, in the order they came: ids and the reason.
            self.reports: list[dict[str, str]] = []
            # The first tap of each recognition and button, in the order they came: ids only.
            self.engagements: list[dict[str, str]] = []
            # The update gate: None (off) or a minimum version; and each install's registered version.
            self.minimum_app_version: str | None = None
            self.install_app_versions: dict[str, str] = {}
            # The listener account gate (ADR-005): off until a run turns it on, as LISTENER_ACCOUNT_REQUIRED is on the
            # real API. The accounts are kept in memory by email, with the gender and age so a deletion can be proved;
            # nothing of them is ever logged, shown or answered.
            self.is_account_required = False
            self.accounts: dict[str, dict[str, Any]] = {}
            # The email each signed-in install is signed in with.
            self.install_accounts: dict[str, str] = {}
            # A code asked for, by email: when (by the clock), and how many wrong tries it has had.
            self.pending_codes: dict[str, dict[str, Any]] = {}
            # A sign-up ticket, given at a right code for a new email, and the install and email it is for.
            self.account_tickets: dict[str, dict[str, str]] = {}

    def answer_held_for(self, install_id: str, idempotency_key: str) -> dict[str, Any] | None:
        """The 200 answer already given to this install for this key, as first built, or None for a new key."""
        with self.lock:
            held = self.answers_by_key.get((install_id, idempotency_key))
            return json.loads(json.dumps(held)) if held is not None else None

    def remember_answer(self, install_id: str, idempotency_key: str, response: dict[str, Any],
                        fields: dict[str, str]) -> None:
        """Keeps a 200 answer for a send of the same key again, and what it showed, for the choices that follow it, and
        the full answer with the send's own fields, for the reveal of what the account gate held back."""
        shown = response.get('candidates') or ([response['result']] if 'result' in response else [])
        with self.lock:
            self.answers_by_key[(install_id, idempotency_key)] = json.loads(json.dumps(response))
            self.answered_recognitions[response['recognition_id']] = {
                'install_id': install_id, 'status': response['status'],
                'answer': json.loads(json.dumps(response)),
                'is_deferred': fields['is_deferred'], 'captured_at': fields['captured_at'],
                'station_ids': [result['station']['id'] for result in shown],
                # The buttons each shown station's card had, for the taps that follow.
                'action_ids_by_station': {result['station']['id']: [action['id'].lower() for action in result['card']['actions']]
                                          for result in shown}}

    def answered_recognition(self, recognition_id: str) -> dict[str, Any] | None:
        with self.lock:
            return self.answered_recognitions.get(recognition_id)

    def record_choice(self, recognition_id: str, station_id: str, request_id: str) -> str:
        """The first choice of a recognition wins, as on the real API: 'chosen', 'already chosen' (the same station
        again) or 'another station was chosen first'."""
        with self.lock:
            first = next((choice for choice in self.choices if choice['recognition_id'] == recognition_id), None)
            if first is None:
                self.choices.append({'recognition_id': recognition_id, 'station_id': station_id, 'request_id': request_id})
                return 'chosen'
            return 'already chosen' if first['station_id'] == station_id else 'another station was chosen first'

    def chosen_station_of(self, recognition_id: str) -> str | None:
        with self.lock:
            return next((choice['station_id'] for choice in self.choices if choice['recognition_id'] == recognition_id),
                        None)

    def record_engagement(self, recognition_id: str, station_id: str, action_id: str, request_id: str) -> str:
        """One tap per recognition and button, as on the real API: 'tapped', or 'already tapped' for a repeat. On a
        "Which station?" answer with no choice yet, the tap is the choice (A4)."""
        with self.lock:
            if self.answered_recognitions[recognition_id]['status'] == 'CHOOSE_STATION' and not any(
                    choice['recognition_id'] == recognition_id for choice in self.choices):
                self.choices.append({'recognition_id': recognition_id, 'station_id': station_id, 'request_id': request_id})
            if any(tap['recognition_id'] == recognition_id and tap['action_id'] == action_id for tap in self.engagements):
                return 'already tapped'
            self.engagements.append({'recognition_id': recognition_id, 'station_id': station_id, 'action_id': action_id,
                                     'request_id': request_id})
            return 'tapped'

    def record_report(self, recognition_id: str, station_id: str, reason: str, request_id: str) -> str:
        """The first report of a recognition wins, as on the real API: 'reported', or 'already reported' for a repeat,
        whatever its reason."""
        with self.lock:
            if any(report['recognition_id'] == recognition_id for report in self.reports):
                return 'already reported'
            self.reports.append({'recognition_id': recognition_id, 'station_id': station_id, 'reason': reason,
                                 'request_id': request_id})
            return 'reported'

    # ---- the listener account (ADR-005) ------------------------------------------------------------------

    def has_account(self, install_id: str) -> bool:
        with self.lock:
            return install_id in self.install_accounts

    def email_of(self, install_id: str) -> str | None:
        with self.lock:
            return self.install_accounts.get(install_id)

    def has_account_for_email(self, email: str) -> bool:
        with self.lock:
            return email in self.accounts

    def holds_back_for(self, install_id: str) -> bool:
        """Whether an ad's result must be held back from this install: the gate is on and it has no account."""
        with self.lock:
            return self.is_account_required and install_id not in self.install_accounts

    def ask_for_code(self, email: str) -> int | None:
        """Notes a code asked for [email]: None when it goes out, or the seconds to wait when the last one went less than
        a minute ago."""
        with self.lock:
            now = self.clock()
            held = self.pending_codes.get(email)
            if held is not None and now - held['asked_at'] < ACCOUNT_CODE_RESEND_SECONDS:
                return max(1, math.ceil(ACCOUNT_CODE_RESEND_SECONDS - (now - held['asked_at'])))
            self.pending_codes[email] = {'asked_at': now, 'wrong_tries': 0}
            return None

    def check_code(self, email: str, code: str) -> str:
        """'right', 'incorrect', 'expired' (none asked for, or one over ten minutes old) or 'locked' (the fifth wrong try
        and every try after it), as the real API's code store answers."""
        with self.lock:
            held = self.pending_codes.get(email)
            if held is None:
                return 'expired'
            if self.clock() - held['asked_at'] > ACCOUNT_CODE_LIFETIME_SECONDS:
                del self.pending_codes[email]
                return 'expired'
            if held['wrong_tries'] >= ACCOUNT_CODE_ATTEMPT_LIMIT:
                return 'locked'
            if code != FAKE_EMAIL_CODE:
                held['wrong_tries'] += 1
                return 'locked' if held['wrong_tries'] >= ACCOUNT_CODE_ATTEMPT_LIMIT else 'incorrect'
            del self.pending_codes[email]
            return 'right'

    def sign_in(self, install_id: str, email: str) -> None:
        with self.lock:
            self.install_accounts[install_id] = email

    def issue_ticket(self, install_id: str, email: str) -> str:
        ticket = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode('ascii').rstrip('=')
        with self.lock:
            self.account_tickets[ticket] = {'install_id': install_id, 'email': email}
        return ticket

    def use_ticket(self, ticket: str, install_id: str, email: str) -> bool:
        """Spends a ticket: true only for the install and email it was given for, once."""
        with self.lock:
            held = self.account_tickets.get(ticket)
            if held is None or held['install_id'] != install_id or held['email'] != email:
                return False
            del self.account_tickets[ticket]
            return True

    def create_account(self, install_id: str, email: str, gender: str, age: int) -> None:
        with self.lock:
            self.accounts[email] = {'gender': gender, 'age': age}
            self.install_accounts[install_id] = email

    def sign_out(self, install_id: str) -> None:
        with self.lock:
            self.install_accounts.pop(install_id, None)

    def delete_account(self, install_id: str) -> None:
        """Erases the account this install is signed in to, and every install leaves it."""
        with self.lock:
            email = self.install_accounts.get(install_id)
            if email is None:
                return
            self.accounts.pop(email, None)
            for install in [install for install, signed_in_as in self.install_accounts.items() if signed_in_as == email]:
                del self.install_accounts[install]

    def queue(self, names: list[str]) -> None:
        with self.lock:
            for name in names:
                self.scenarios[SCENARIOS[name]['route']].append(name)

    def next_scenario(self, route: str) -> str:
        with self.lock:
            queue = self.scenarios[route]
            return queue.pop(0) if queue else DEFAULT_SCENARIOS[route]

    def note_registration(self, install_id: str, app_version: str, is_through_tunnel: bool) -> None:
        """Lists [install_id] as the newest registration, with its time and whether it came through a tunnel (never
        the address it came from)."""
        with self.lock:
            self.install_app_versions[install_id] = app_version
            kept = [entry for entry in self.recent_registrations if entry['install_id'] != install_id]
            kept.append({'install_id': install_id, 'install_label': install_label(install_id),
                         'registered_at': datetime.now().astimezone().strftime('%H:%M:%S'),
                         'app_version': app_version, 'is_through_tunnel': is_through_tunnel})
            self.recent_registrations = kept[-RECENT_REGISTRATIONS_KEPT:]

    def start_phone_check(self, phone_number: str, install_id: str) -> bool:
        """Puts [phone_number] into the next answers to [install_id]; false when that install did not register lately,
        so the page can only choose an install it lists."""
        with self.lock:
            if not any(entry['install_id'] == install_id for entry in self.recent_registrations):
                return False
            self.phone_check = PhoneCheck(phone_number=phone_number, install_id=install_id,
                                          forget_at=self.clock() + PHONE_CHECK_LIFETIME_SECONDS,
                                          answers_left=PHONE_CHECK_ANSWERS)
            return True

    def stop_phone_check(self) -> None:
        with self.lock:
            self.phone_check = None

    def take_phone_number_for(self, install_id: str | None) -> str | None:
        """The number for one answer that holds a number, when the answer goes to the chosen install; that answer
        counts towards PHONE_CHECK_ANSWERS. None for every other install, and once the check is over."""
        with self.lock:
            check = self.current_phone_check()
            if check is None or install_id != check.install_id:
                return None
            check.answers_left -= 1
            if check.answers_left <= 0:
                self.phone_check = None
            return check.phone_number

    def current_phone_check(self) -> PhoneCheck | None:
        """The phone check still under way, forgetting one whose time is up. The caller holds the lock."""
        if self.phone_check is not None and self.clock() >= self.phone_check.forget_at:
            self.phone_check = None
        return self.phone_check

    def snapshot(self) -> dict[str, Any]:
        """What the fake holds, as counts and ids only: never an answer, a body or the phone number."""
        with self.lock:
            requests = list(self.requests)
            check = self.current_phone_check()
            return {
                'is_offline': self.is_offline,
                'minimum_app_version': self.minimum_app_version,
                'update_required_answers': sum(1 for request in requests if request.get('update_required')),
                # Counts only: never an email, a gender or an age.
                'is_account_required': self.is_account_required,
                'accounts': len(self.accounts),
                'signed_in_installs': len(self.install_accounts),
                'replaces_phone_numbers': check is not None,
                'phone_check': None if check is None else {
                    'install_label': install_label(check.install_id),
                    'answers_left': check.answers_left,
                    'seconds_left': max(0, math.ceil(check.forget_at - self.clock())),
                },
                'recent_registrations': [dict(entry) for entry in reversed(self.recent_registrations)],
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
                     'scenario': request.get('scenario'), 'recognition_id': request.get('recognition_id'),
                     'is_deferred': request.get('is_deferred'), 'station_hint': request.get('station_hint'),
                     'captured_at': request.get('captured_at'), 'sent_at': request.get('sent_at'),
                     'account_required': request.get('account_required', False)}
                    for request in requests if request.get('path') == RECOGNIZE_PATH and 'scenario' in request
                ],
                # One per recognition, the first: what the real API would hold however often the app sent it.
                'choices': [dict(choice) for choice in self.choices],
                'reports': [dict(report) for report in self.reports],
                'engagements': [dict(tap) for tap in self.engagements],
                # Every drawn picture the app loaded, by its size: none while pictures are held back.
                'pictures_served': [request['picture'] for request in requests if 'picture' in request],
                # Every station-list request the fake answered (200, 304 or an error), for the 24-hour cache check.
                'station_list_requests': sum(1 for request in requests
                                             if request.get('path') == STATIONS_PATH and 'scenario' in request),
                'client_error_report_ids': [report.get('request_id') for report in self.client_error_reports],
                # When each report says its error happened: only a report queued with no signal carries it.
                'client_error_reports': [
                    {'request_id': report.get('request_id'), 'kind': report.get('kind'),
                     'occurred_at': report.get('occurredAt')}
                    for report in self.client_error_reports
                ],
                'recent_requests': [
                    {'method': request.get('method'), 'path': request.get('path'),
                     'request_id': request.get('request_id'), 'outcome': outcome_of(request),
                     'station_hint': request.get('station_hint'), 'station_id': request.get('station_id')}
                    for request in requests[-20:]
                ],
            }


def outcome_of(request: dict[str, Any]) -> str:
    """What became of one logged request, in a few words for the control page."""
    if 'refused' in request:
        return f"refused: {request['refused']}"
    if 'dropped' in request:
        return f"dropped: {request['dropped']}"
    if 'token_not_issued' in request:
        return 'token not issued here: answered 401'
    if request.get('update_required'):
        return 'below the minimum app version: answered 426'
    if 'picture' in request:
        return f"picture {request['picture']}"
    if 'account' in request:
        return f"account {request['account']}: {request.get('result', 'answered')}"
    if 'reveal' in request:
        return f"reveal: {request['reveal']}"
    for key in ('choice', 'engagement', 'report', 'station_list'):
        if key in request:
            return f"{request.get('scenario')}: {request[key]}"
    for key in ('scenario', 'registration', 'client_error_kind'):
        if key in request:
            return str(request[key])
    return 'answered'


def read_listener_app_version(version: str) -> tuple[int, int, int, int] | None:
    """Major, minor, patch and build (0 when missing), or None when the version cannot be read: the contract's
    readListenerAppVersion."""
    parts = LISTENER_APP_VERSION.match(version)
    if parts is None:
        return None
    return int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4] or '0')


def compare_listener_app_versions(first: str, second: str) -> int | None:
    """-1, 0 or 1 as [first] is older, the same or newer; None when either cannot be read (compareListenerAppVersions,
    checked against fixtures/recognition/listener-app-versions/comparisons.json)."""
    first_numbers = read_listener_app_version(first)
    second_numbers = read_listener_app_version(second)
    if first_numbers is None or second_numbers is None:
        return None
    return (first_numbers > second_numbers) - (first_numbers < second_numbers)


def is_below_minimum_app_version(registered_version: str, minimum_version: str) -> bool:
    """The update gate (isBelowMinimumAppVersion): older than the minimum, or unreadable while a minimum is set."""
    comparison = compare_listener_app_versions(registered_version, minimum_version)
    if comparison is None:
        return minimum_version != NO_MINIMUM_APP_VERSION
    return comparison == -1


def new_recognition_id(now_milliseconds: int | None = None) -> str:
    """A recognition id as the API makes one (RFC 9562 UUID version 7): 48 bits of Unix milliseconds, the version, 12
    random bits, the variant and 62 random bits, written in lower case."""
    milliseconds = time.time_ns() // 1_000_000 if now_milliseconds is None else now_milliseconds
    random_bits = secrets.randbits(74)
    value = ((milliseconds & 0xFFFF_FFFF_FFFF) << 80) | (0x7 << 76) | ((random_bits >> 62) << 64) | (0b10 << 62) \
        | (random_bits & ((1 << 62) - 1))
    return str(uuid.UUID(int=value))


def match_for_hinted_station(station_id: str) -> dict[str, Any] | None:
    """The MATCH the real API gives a clip whose hint names [station_id] when that station airs the ad, from the shared
    fixtures; None for a station the fixtures do not hold."""
    for path in HINTED_MATCHES:
        response = read_fixture(path)['response']
        if response['result']['station']['id'] == station_id:
            return response
    for path in CHOOSERS_WITH_EVERY_STATION:
        for candidate in read_fixture(path)['response']['candidates']:
            if candidate['station']['id'] == station_id:
                return {**read_fixture(HINTED_MATCHES[0])['response'], 'result': candidate}
    return None


def station_names_from_fixtures() -> dict[str, str]:
    """Every station the fixtures the fake serves hold, by id, so the control page can name a hint or a choice while
    the state holds only ids."""
    names: dict[str, str] = {}
    for path in sorted((FIXTURES / RESPONSES).glob('*.json')):
        response = json.loads(path.read_text(encoding='utf-8'))['response']
        for result in ([response['result']] if 'result' in response else []) + response.get('candidates', []):
            names.setdefault(result['station']['id'], result['station']['name'])
    for station in read_fixture(STATION_LIST_FIXTURE)['response']['stations']:
        names.setdefault(station['id'], station['name'])
    return names


@functools.lru_cache(maxsize=8)
def draw_picture(width: int, height: int) -> bytes:
    """A PNG of [width] by [height] pixels: warm diagonal stripes with a white ring in the middle, plain to see on the
    phone. Standard library only."""
    centre_x, centre_y, radius = width / 2, height / 2, min(width, height) * 0.3
    ring = max(2.0, radius * 0.12)
    stripe = max(8, width // 24)
    rows = []
    for y in range(height):
        row = bytearray(b'\x00')   # each row starts with its filter type: none
        for x in range(width):
            if abs(math.hypot(x - centre_x, y - centre_y) - radius) < ring:
                row += b'\xff\xff\xff'
            elif ((x + y) // stripe) % 2:
                row += b'\xc8\x46\x1e'
            else:
                row += b'\xf0\xa0\x3c'
        rows.append(bytes(row))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)   # 8 bits, RGB, no interlace
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9))
            + chunk(b'IEND', b''))


def with_drawn_pictures(value: Any, public_origin: str) -> Any:
    """[value] with every picture of the contract's shape ({address, width_pixels, height_pixels, size_bytes}) pointing
    at a drawn picture of its size under [public_origin], with that picture's real size."""
    if isinstance(value, list):
        return [with_drawn_pictures(item, public_origin) for item in value]
    if not isinstance(value, dict):
        return value
    if set(value) == {'address', 'width_pixels', 'height_pixels', 'size_bytes'}:
        width, height = value['width_pixels'], value['height_pixels']
        return {**value, 'address': f'{public_origin}/fake-pictures/{width}x{height}.png',
                'size_bytes': len(draw_picture(width, height))}
    return {key: with_drawn_pictures(item, public_origin) for key, item in value.items()}


def read_fixture(relative_path: str) -> dict[str, Any]:
    return json.loads((FIXTURES / relative_path).read_text(encoding='utf-8'))


def add_actions(card: dict[str, Any], extra_actions: list[dict[str, Any]]) -> None:
    """Adds to [card] the [extra_actions] whose ids it does not hold yet, in order, up to MAXIMUM_ACTIONS_PER_CARD:
    the buttons stay the shared fixtures' own, and every id on the card stays unique, as the contract requires."""
    held_ids = {action['id'] for action in card['actions']}
    new_actions = [action for action in extra_actions if action['id'] not in held_ids]
    card['actions'] = (card['actions'] + new_actions)[:MAXIMUM_ACTIONS_PER_CARD]


def holds_phone_numbers(value: Any) -> bool:
    """Whether [value] holds a `phone_number_e164` at any depth."""
    if isinstance(value, dict):
        return any((key == 'phone_number_e164' and isinstance(item, str)) or holds_phone_numbers(item)
                   for key, item in value.items())
    if isinstance(value, list):
        return any(holds_phone_numbers(item) for item in value)
    return False


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


def withheld_answer(response: dict[str, Any], request_id: str, is_deferred: bool, captured_at: str) -> dict[str, Any]:
    """What the account gate answers instead of a result: the shared fixture's five fields, for this recognition."""
    answer = read_fixture(f'{RESPONSES}/account-required.json')['response']
    return {**answer, 'recognition_id': response['recognition_id'], 'request_id': request_id,
            'is_deferred': is_deferred, 'captured_at': captured_at}


def check_account_email(value: Any) -> str:
    """The email of an account call: an address, as the app sends it, trimmed and in lower case."""
    if (not isinstance(value, str) or len(value) > MAXIMUM_ACCOUNT_EMAIL_LENGTH or not ACCOUNT_EMAIL.match(value)
            or value != value.strip().lower()):
        raise RequestRefused('the email must be an address, trimmed and in lower case')
    return value


def mask_email(email: str) -> str:
    """The first letter, three stars and the domain, as the real API masks it (maskEmailAddress)."""
    at_sign = email.rfind('@')
    return '***' if at_sign < 1 else f'{email[:1]}***{email[at_sign:]}'


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
        self.drain_unread_body()
        self.record({'refused': reason})
        self.answer_json(400, {'error': {'code': 'VALIDATION_FAILED', 'message': 'Fake API refused the request.', 'request_id': request_id or '00000000-0000-4000-8000-000000000000'}}, request_id)

    def record(self, details: dict[str, Any]) -> None:
        # When it arrived, in seconds of the stand-in's own steady clock: only differences mean anything (the waits a
        # saved clip's sends keep, P6 design §4.8 step 9).
        with self.state.lock:
            self.state.requests.append({'method': self.command, 'path': self.path,
                                        'header_names': sorted(name.lower() for name in self.headers.keys()),
                                        'received_at_seconds': round(self.state.clock(), 3), **details})

    def read_body(self, limit: int = MAXIMUM_BODY_BYTES) -> bytes:
        length = int(self.headers.get('Content-Length') or 0)
        if length > limit:
            raise RequestRefused(f'body of {length} bytes is over {limit}')
        self.is_body_read = True
        return self.rfile.read(length)

    def drain_unread_body(self) -> None:
        """Reads a body no one has read (one the stand-in would have taken), before a refusal: Windows answers bytes
        left unread when the connection closes with a reset, which the caller would see instead of the refusal (a
        listener request refused for its token before its clip was read, for one)."""
        if getattr(self, 'is_body_read', False):
            return
        self.is_body_read = True
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if 0 < length <= MAXIMUM_BODY_BYTES:
                self.rfile.read(length)
        except (ValueError, OSError):
            pass

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
        self.drain_unread_body()
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
            elif self.path == '/__fake/account-gate':
                if not isinstance(body, dict) or set(body) != {'is_required'} or not isinstance(body['is_required'], bool):
                    raise ControlRefused(400, 'the body must be {"is_required": true or false}')
                with self.state.lock:
                    self.state.is_account_required = body['is_required']
                self.answer_json(200, {'is_account_required': body['is_required']})
            elif self.path == '/__fake/minimum-app-version':
                self.handle_minimum_app_version(body)
            elif self.path == '/__fake/phone-number':
                self.handle_phone_number(body)
            elif self.path == '/__fake/reset':
                self.state.reset()
                self.answer_json(200, {'reset': True})
            else:
                raise ControlRefused(404, 'no route')
        except ControlRefused as refusal:
            self.answer_control_refusal(refusal)
        except RequestRefused as refused:   # a control body over its size limit
            self.answer_json(413, {'refused': str(refused)})

    def handle_minimum_app_version(self, body: Any) -> None:
        """Sets the update gate's minimum, or turns it off with null or "0.0.0"."""
        if not isinstance(body, dict) or set(body) != {'minimum_app_version'}:
            raise ControlRefused(400, 'the body must be {"minimum_app_version": "0.2.0" or null}')
        minimum = body['minimum_app_version']
        if minimum is not None and (not isinstance(minimum, str) or read_listener_app_version(minimum) is None):
            raise ControlRefused(400, 'the minimum is not a version such as 0.2.0')
        if minimum == NO_MINIMUM_APP_VERSION:
            minimum = None
        with self.state.lock:
            self.state.minimum_app_version = minimum
        self.answer_json(200, {'minimum_app_version': minimum})

    def handle_phone_number(self, body: Any) -> None:
        """Starts a phone check for one install chosen on the control page, or stops it. A refusal never repeats the
        value it refused."""
        if isinstance(body, dict) and set(body) == {'phone_number'} and body['phone_number'] is None:
            self.state.stop_phone_check()
            self.answer_json(200, {'replaces_phone_numbers': False})
            return
        if not isinstance(body, dict) or set(body) != {'phone_number', 'install_id'}:
            raise ControlRefused(400, 'the body must be {"phone_number": "+E.164", "install_id": "<install>"}'
                                      ' or {"phone_number": null}')
        phone_number = body['phone_number']
        if not isinstance(phone_number, str) or not E164.match(phone_number):
            raise ControlRefused(400, 'the phone number is not an E.164 number such as +447700900123')
        install_id = body['install_id']
        if not isinstance(install_id, str) or not self.state.start_phone_check(phone_number, install_id):
            raise ControlRefused(400, 'choose one of the installs that registered lately')
        self.answer_json(200, {'replaces_phone_numbers': True})

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
        if (self.path.startswith('/api/v1/') or self.path.startswith('/fake-pictures/')) and self.drops_while_offline():
            return
        picture_path = PICTURE_PATH.match(self.path)
        if picture_path is not None:
            self.answer_picture(int(picture_path.group(1)), int(picture_path.group(2)))
            return
        reveal_path = RECOGNITION_PATH.match(self.path)
        if self.path in (STATIONS_PATH, ACCOUNT_PATH) or reveal_path is not None:
            request_id = self.headers.get('X-Request-Id')
            try:
                check_uuid(request_id, 'X-Request-Id')
                if self.path == STATIONS_PATH:
                    self.handle_stations(request_id)
                elif reveal_path is not None:
                    self.handle_reveal(request_id, reveal_path.group(1))
                else:
                    self.handle_account(request_id, 'describe')
            except RequestRefused as refused:
                self.refuse(str(refused), request_id if request_id and UUID.match(request_id) else None)
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
            choice_path = CHOICE_PATH.match(self.path)
            report_path = REPORT_PATH.match(self.path)
            if self.path == '/api/v1/installs':
                self.handle_install(request_id)
            elif self.path == RECOGNIZE_PATH:
                self.handle_recognize(request_id)
            elif self.path == ENGAGEMENTS_PATH:
                self.handle_engagement(request_id)
            elif choice_path is not None:
                self.handle_choice(request_id, choice_path.group(1))
            elif report_path is not None:
                self.handle_report(request_id, report_path.group(1))
            elif self.path == '/api/v1/client-errors':
                self.handle_client_error(request_id)
            elif self.path in ACCOUNT_POST_ACTIONS:
                self.handle_account(request_id, ACCOUNT_POST_ACTIONS[self.path])
            else:
                raise RequestRefused(f'no route {self.path}')
        except RequestRefused as refused:
            self.refuse(str(refused), request_id if request_id and UUID.match(request_id) else None)
        except json.JSONDecodeError:
            self.refuse('the body is not JSON', request_id if request_id and UUID.match(request_id) else None)

    def do_DELETE(self) -> None:
        if self.path.startswith('/api/v1/') and self.drops_while_offline():
            return
        request_id = self.headers.get('X-Request-Id')
        try:
            check_uuid(request_id, 'X-Request-Id')
            if self.path != ACCOUNT_PATH:
                raise RequestRefused(f'no route {self.path}')
            self.handle_account(request_id, 'delete')
        except RequestRefused as refused:
            self.refuse(str(refused), request_id if request_id and UUID.match(request_id) else None)

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
        is_through_tunnel = any(self.headers.get(name) is not None for name in FORWARDING_HEADERS)
        self.state.note_registration(body['install_id'], body['app_version'], is_through_tunnel)
        self.record({'request_id': request_id, 'install_id': body['install_id'], 'app_version': body['app_version'],
                     'registration': registration, 'carried_token': carried})
        expires_at = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(timespec='seconds').replace('+00:00', 'Z')
        self.answer_json(200, {'install_token': token, 'expires_at': expires_at}, request_id)

    def handle_recognize(self, request_id: str) -> None:
        token = self.bearer_token()
        with self.state.lock:
            install_id = self.state.issued_tokens.get(token)
        body = self.read_body()
        if install_id is None:
            self.answer_token_not_issued(request_id)
            return
        if self.answers_update_required(install_id, request_id):
            return
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
        # What the request carried, for the log (contract §4): field values that hold no personal data.
        sent = {'request_id': request_id, 'idempotency_key': fields['idempotency_key'], 'field_names': sorted(fields),
                'audio_bytes': len(clip), 'body_bytes': len(body), 'is_deferred': fields['is_deferred'],
                'captured_at': fields['captured_at'], 'sent_at': fields['sent_at'],
                'station_hint': fields.get('station_hint')}
        held = self.state.answer_held_for(install_id, fields['idempotency_key'])
        if held is not None:
            # The same key again after a 200 (a lost answer, a resend from the outbox): the same answer and recognition
            # id, as the real API replays it, and no queued answer is spent.
            self.record({**sent, 'scenario': 'replay', 'recognition_id': held['recognition_id'],
                         'account_required': self.is_held_back(install_id, held)})
            self.answer_recognition(held, request_id, install_id, fields)
            return
        scenario = self.state.next_scenario(RECOGNIZE_ROUTE)
        response = self.fixture_answer(SCENARIOS[scenario], fields)
        if response is None:
            self.record({**sent, 'scenario': scenario})
            self.answer_with_scenario(scenario, request_id, token)
            return
        # A new id for each new key, so each answer (and each chooser's choice) is told apart, as on the real API.
        response['recognition_id'] = new_recognition_id()
        self.state.remember_answer(install_id, fields['idempotency_key'], response, fields)
        self.record({**sent, 'scenario': scenario, 'recognition_id': response['recognition_id'],
                     'account_required': self.is_held_back(install_id, response)})
        if SCENARIOS[scenario].get('drop_after_keeping'):
            self.close_unanswered()   # kept: the same key again gets this answer as a replay
            return
        if SCENARIOS[scenario].get('answers_after_seconds'):
            self.state.sleep(SCENARIOS[scenario]['answers_after_seconds'])
        self.answer_recognition(response, request_id, install_id, fields)

    def fixture_answer(self, plan: dict[str, Any], fields: dict[str, str]) -> dict[str, Any] | None:
        """The 200 answer a scenario gives, from the shared fixtures, or None for one that answers otherwise."""
        if plan.get('by_hint'):
            hint = fields.get('station_hint')
            if hint is None:
                raise RequestRefused('"Match by my station" needs the station_hint field, and the app sent none')
            response = match_for_hinted_station(hint.lower())
            if response is None:
                raise RequestRefused('the station_hint names none of the stand-in\'s stations')
            return response
        if 'response' not in plan:
            return None
        response = read_fixture(plan['response'])['response']
        if 'extra_actions_from' in plan:
            add_actions(response['result']['card'], read_fixture(plan['extra_actions_from'])['card']['actions'])
        if plan.get('pictures') and self.state.public_origin:
            response = with_drawn_pictures(response, self.state.public_origin)
        return response

    def is_held_back(self, install_id: str, response: dict[str, Any]) -> bool:
        """Whether the gate holds [response] back from this install: an ad's result (a match or a "Which station?") while
        the install has no account."""
        return response['status'] in ('MATCH', 'CHOOSE_STATION') and self.state.holds_back_for(install_id)

    def answer_recognition(self, response: dict[str, Any], request_id: str, install_id: str,
                           fields: dict[str, str]) -> None:
        """A 200 answer to an identify, with this request's id; numbers become the phone check's for its install. With
        the account gate on and no account, the answer holds nothing of the ad (ADR-005)."""
        if self.is_held_back(install_id, response):
            self.answer_json(200, withheld_answer(response, request_id, fields['is_deferred'] == 'true',
                                                  fields['captured_at']), request_id)
            return
        answer = {**response, 'request_id': request_id}
        if holds_phone_numbers(answer):
            replacement = self.state.take_phone_number_for(install_id)
            if replacement is not None:
                answer = replace_phone_numbers(answer, replacement)
        self.answer_json(200, answer, request_id)

    def handle_choice(self, request_id: str, recognition_id: str) -> None:
        """A station choice (contract §1.3). Refused, so the run fails, unless it names a "Which station?" answer this
        install was given, by its lower-case version 7 id, and exactly {"station_id": one of its stations}."""
        token = self.bearer_token()
        with self.state.lock:
            install_id = self.state.issued_tokens.get(token)
        body = self.read_body(MAXIMUM_JSON_BODY_BYTES)
        if install_id is None:
            self.answer_token_not_issued(request_id)
            return
        if self.answers_update_required(install_id, request_id):
            return
        self.refuse_when_no_account(install_id, 'a choice')
        if not RECOGNITION_ID.match(recognition_id):
            raise RequestRefused('the recognition id in the path is not a lower-case UUID version 7')
        if (self.headers.get('Content-Type') or '').split(';')[0].strip().lower() != 'application/json':
            raise RequestRefused('a choice must be sent as application/json')
        choice = json.loads(body)
        if not isinstance(choice, dict) or set(choice) != {'station_id'}:
            raise RequestRefused('a choice body must be exactly {"station_id": "<uuid>"}')
        check_uuid(choice['station_id'], 'station_id')
        station_id = choice['station_id'].lower()
        answered = self.state.answered_recognition(recognition_id)
        if answered is None or answered['status'] != 'CHOOSE_STATION':
            raise RequestRefused('the recognition is not a "Which station?" answer the stand-in gave')
        if answered['install_id'] != install_id:
            raise RequestRefused("the recognition was answered to another install")
        if station_id not in answered['station_ids']:
            raise RequestRefused('the station is not one of the stations that answer showed')
        scenario = self.state.next_scenario(CHOICE_ROUTE)
        plan = SCENARIOS[scenario]
        details = {'request_id': request_id, 'recognition_id': recognition_id, 'station_id': station_id}
        if 'envelope' in plan:
            self.record({**details, 'scenario': scenario})
            self.answer_envelope(plan, request_id)
            return
        outcome = self.state.record_choice(recognition_id, station_id, request_id)
        self.record({**details, 'scenario': scenario, 'choice': outcome})
        if outcome == 'another station was chosen first':
            self.answer_envelope({'envelope': 'errors/envelopes/station-already-chosen.json'}, request_id)
        elif plan.get('drop'):
            self.close_unanswered()   # kept, but the app never hears so: its outbox sends it again
        else:
            self.answer_no_content(request_id)

    def handle_engagement(self, request_id: str) -> None:
        """A button tap (contract §1.5, P4 design §5.8). Refused, so the run fails, unless it is exactly the five fields,
        names an answer this install was given by its lower-case version 7 id, a station that answer showed, and a
        button on that station's card, with both times carrying a time zone. One tap per recognition and button: a
        repeat answers 204 too. On a "Which station?" answer a tap naming another station than the one chosen gets 422
        STATION_ALREADY_CHOSEN; with no choice yet, the tap is the choice (A4)."""
        token = self.bearer_token()
        with self.state.lock:
            install_id = self.state.issued_tokens.get(token)
        body = self.read_body(MAXIMUM_JSON_BODY_BYTES)
        if install_id is None:
            self.answer_token_not_issued(request_id)
            return
        if self.answers_update_required(install_id, request_id):
            return
        self.refuse_when_no_account(install_id, 'a tap')
        if (self.headers.get('Content-Type') or '').split(';')[0].strip().lower() != 'application/json':
            raise RequestRefused('a tap must be sent as application/json')
        tap = json.loads(body)
        if not isinstance(tap, dict) or set(tap) != ENGAGEMENT_FIELDS:
            raise RequestRefused(f'a tap body must be exactly {sorted(ENGAGEMENT_FIELDS)}')
        recognition_id = tap['recognition_id']
        if not isinstance(recognition_id, str) or not RECOGNITION_ID.match(recognition_id):
            raise RequestRefused('recognition_id is not a lower-case UUID version 7')
        check_uuid(tap['station_id'], 'station_id')
        check_uuid(tap['action_id'], 'action_id')
        for name in ('occurred_at', 'sent_at'):
            if not isinstance(tap[name], str) or not TIMESTAMP_WITH_OFFSET.match(tap[name]):
                raise RequestRefused(f'{name} is not a time with a time zone')
        station_id, action_id = tap['station_id'].lower(), tap['action_id'].lower()
        answered = self.state.answered_recognition(recognition_id)
        if answered is None:
            raise RequestRefused('the recognition is not an answer the stand-in gave')
        if answered['install_id'] != install_id:
            raise RequestRefused('the recognition was answered to another install')
        if station_id not in answered['station_ids']:
            raise RequestRefused('the station is not one of the stations that answer showed')
        if action_id not in answered['action_ids_by_station'].get(station_id, []):
            raise RequestRefused("the button is not on that station's card")
        scenario = self.state.next_scenario(ENGAGEMENT_ROUTE)
        plan = SCENARIOS[scenario]
        details = {'request_id': request_id, 'recognition_id': recognition_id, 'station_id': station_id,
                   'action_id': action_id}
        if 'envelope' in plan:
            self.record({**details, 'scenario': scenario})
            self.answer_envelope(plan, request_id)
            return
        chosen = self.state.chosen_station_of(recognition_id)
        if chosen is not None and chosen != station_id:
            self.record({**details, 'scenario': scenario, 'engagement': 'another station was chosen'})
            self.answer_envelope({'envelope': 'errors/envelopes/station-already-chosen.json'}, request_id)
            return
        outcome = self.state.record_engagement(recognition_id, station_id, action_id, request_id)
        self.record({**details, 'scenario': scenario, 'engagement': outcome})
        if plan.get('drop'):
            self.close_unanswered()   # kept, but the app never hears so: its outbox sends it again
        else:
            self.answer_no_content(request_id)

    def handle_report(self, request_id: str, recognition_id: str) -> None:
        """"Report this" (recognition-report-schemas.ts; P6 design §2.14). Refused, so the run fails, unless it names an
        answer this install was given, by its lower-case version 7 id, and exactly {"station_id": a station that answer
        showed, "reason": one of the four}. The first report wins; a repeat is answered 204 like the first, even with
        another reason. A station other than the one chosen for a "Which station?" answer gets 422
        STATION_ALREADY_CHOSEN, as on the real API."""
        token = self.bearer_token()
        with self.state.lock:
            install_id = self.state.issued_tokens.get(token)
        body = self.read_body(MAXIMUM_JSON_BODY_BYTES)
        if install_id is None:
            self.answer_token_not_issued(request_id)
            return
        if self.answers_update_required(install_id, request_id):
            return
        self.refuse_when_no_account(install_id, 'a report')
        if not RECOGNITION_ID.match(recognition_id):
            raise RequestRefused('the recognition id in the path is not a lower-case UUID version 7')
        if (self.headers.get('Content-Type') or '').split(';')[0].strip().lower() != 'application/json':
            raise RequestRefused('a report must be sent as application/json')
        report = json.loads(body)
        if not isinstance(report, dict) or set(report) != {'station_id', 'reason'}:
            raise RequestRefused('a report body must be exactly {"station_id": "<uuid>", "reason": "<reason>"}')
        check_uuid(report['station_id'], 'station_id')
        if report['reason'] not in RECOGNITION_REPORT_REASONS:
            raise RequestRefused("the reason is not one of the contract's four")
        station_id = report['station_id'].lower()
        answered = self.state.answered_recognition(recognition_id)
        if answered is None:
            raise RequestRefused('the recognition is not an answer the stand-in gave')
        if answered['install_id'] != install_id:
            raise RequestRefused('the recognition was answered to another install')
        if station_id not in answered['station_ids']:
            raise RequestRefused('the station is not one of the stations that answer showed')
        scenario = self.state.next_scenario(REPORT_ROUTE)
        plan = SCENARIOS[scenario]
        details = {'request_id': request_id, 'recognition_id': recognition_id, 'station_id': station_id,
                   'reason': report['reason']}
        if 'envelope' in plan:
            self.record({**details, 'scenario': scenario})
            self.answer_envelope(plan, request_id)
            return
        chosen = self.state.chosen_station_of(recognition_id)
        if chosen is not None and chosen != station_id:
            self.record({**details, 'scenario': scenario, 'report': 'another station was chosen'})
            self.answer_envelope({'envelope': 'errors/envelopes/station-already-chosen.json'}, request_id)
            return
        outcome = self.state.record_report(recognition_id, station_id, report['reason'], request_id)
        self.record({**details, 'scenario': scenario, 'report': outcome})
        if plan.get('drop'):
            self.close_unanswered()   # kept, but the app never hears so: its outbox sends it again
        else:
            self.answer_no_content(request_id)

    def answer_picture(self, width: int, height: int) -> None:
        """A drawn picture, as a CDN would serve the banner or a logo: no token, kept an hour."""
        if not (1 <= width <= LARGEST_PICTURE_SIDE and 1 <= height <= LARGEST_PICTURE_SIDE):
            self.record({'refused': f'a picture of {width}x{height}'})
            self.send_response(404)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        encoded = draw_picture(width, height)
        self.record({'picture': f'{width}x{height}', 'picture_bytes': len(encoded)})
        self.send_response(200)
        self.send_header('Content-Type', 'image/png')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'public, max-age=3600')
        self.end_headers()
        self.wfile.write(encoded)

    def handle_stations(self, request_id: str) -> None:
        """The "My station" list (contract §1.4): the shared fixture's two stations with a fixed ETag, kept for a day,
        and 304 with no body when the app sends that ETag back. Every request is counted, for the 24-hour cache check."""
        token = self.bearer_token()
        with self.state.lock:
            install_id = self.state.issued_tokens.get(token)
        if int(self.headers.get('Content-Length') or 0) > 0:
            raise RequestRefused('a GET of the station list carries no body')
        if install_id is None:
            self.answer_token_not_issued(request_id)
            return
        if self.answers_update_required(install_id, request_id):
            return
        scenario = self.state.next_scenario(STATIONS_ROUTE)
        plan = SCENARIOS[scenario]
        if 'envelope' in plan:
            self.record({'request_id': request_id, 'scenario': scenario})
            self.answer_envelope(plan, request_id)
            return
        listed_tags = [tag.strip() for tag in (self.headers.get('If-None-Match') or '').split(',')]
        is_not_modified = STATION_LIST_ENTITY_TAG in listed_tags
        self.record({'request_id': request_id, 'scenario': scenario,
                     'station_list': 'not changed (304)' if is_not_modified else 'listed (200)'})
        encoded = b'' if is_not_modified else json.dumps(read_fixture(STATION_LIST_FIXTURE)['response']).encode('utf-8')
        self.send_response(304 if is_not_modified else 200)
        if not is_not_modified:
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(encoded)))
        self.send_header('ETag', STATION_LIST_ENTITY_TAG)
        self.send_header('Cache-Control', STATION_LIST_CACHE_CONTROL)
        self.send_header('X-Request-Id', request_id)
        self.end_headers()
        self.wfile.write(encoded)

    def handle_account(self, request_id: str, action: str) -> None:
        """A listener-account call (ADR-005; contract listener-account-schemas.ts). Refused, so the run fails, unless it
        is exactly what the contract allows: the install token, and for a call with a body, JSON with exactly its
        fields. A wrong code, a code asked for too soon and a ticket that is no good get the shared error envelopes."""
        token = self.bearer_token()
        with self.state.lock:
            install_id = self.state.issued_tokens.get(token)
        body = self.read_body(MAXIMUM_JSON_BODY_BYTES)
        if install_id is None:
            self.answer_token_not_issued(request_id)
            return
        if self.answers_update_required(install_id, request_id):
            return
        sent: dict[str, Any] = {}
        if action in ('describe', 'delete'):
            if body:
                raise RequestRefused(f'the {action} call carries no body')
        else:
            if (self.headers.get('Content-Type') or '').split(';')[0].strip().lower() != 'application/json':
                raise RequestRefused('an account call must be sent as application/json')
            decoded = json.loads(body)
            if not isinstance(decoded, dict):
                raise RequestRefused('the body must be a JSON object')
            sent = decoded
        details = {'request_id': request_id, 'account': action}
        if action == 'code':
            self.account_code(sent, request_id, details)
        elif action == 'verify':
            self.account_verify(sent, install_id, request_id, details)
        elif action == 'create':
            self.account_create(sent, install_id, request_id, details)
        elif action == 'describe':
            email = self.state.email_of(install_id)
            self.record({**details, 'result': 'signed in' if email else 'signed out'})
            self.answer_json(200, {'is_signed_in': email is not None,
                                   'email_masked': mask_email(email) if email else None}, request_id)
        elif action == 'sign-out':
            if sent:
                raise RequestRefused('signing out carries an empty body')
            self.state.sign_out(install_id)
            self.record({**details, 'result': 'signed out'})
            self.answer_no_content(request_id)
        else:
            self.state.delete_account(install_id)
            self.record({**details, 'result': 'erased'})
            self.answer_no_content(request_id)

    def account_code(self, sent: dict[str, Any], request_id: str, details: dict[str, Any]) -> None:
        if set(sent) != {'email'}:
            raise RequestRefused('asking for a code sends exactly {"email"}')
        email = check_account_email(sent['email'])
        wait = self.state.ask_for_code(email)
        if wait is not None:
            self.record({**details, 'result': 'asked too soon'})
            self.answer_envelope({'envelope': 'errors/envelopes/resend-too-soon.json', 'retry_after_seconds': wait}, request_id)
            return
        self.record({**details, 'result': 'code sent'})
        self.answer_json(202, {'resend_after_seconds': ACCOUNT_CODE_RESEND_SECONDS}, request_id)

    def account_verify(self, sent: dict[str, Any], install_id: str, request_id: str, details: dict[str, Any]) -> None:
        if set(sent) != {'email', 'code'}:
            raise RequestRefused('checking a code sends exactly {"email", "code"}')
        email = check_account_email(sent['email'])
        if not isinstance(sent['code'], str) or not ACCOUNT_CODE.match(sent['code']):
            raise RequestRefused('the code must be six digits, as a string')
        outcome = self.state.check_code(email, sent['code'])
        if outcome != 'right':
            self.record({**details, 'result': f'code {outcome}'})
            envelope = {'incorrect': 'listener-code-incorrect', 'expired': 'listener-code-expired',
                        'locked': 'listener-code-locked'}[outcome]
            self.answer_envelope({'envelope': f'errors/envelopes/{envelope}.json'}, request_id)
            return
        signed_in_as = self.state.email_of(install_id)
        if signed_in_as is not None and signed_in_as != email:
            self.record({**details, 'result': 'already signed in'})
            self.answer_envelope({'envelope': 'errors/envelopes/already-signed-in.json'}, request_id)
        elif self.state.has_account_for_email(email):
            self.state.sign_in(install_id, email)
            self.record({**details, 'result': 'signed in'})
            self.answer_json(200, {'status': 'SIGNED_IN', 'email_masked': mask_email(email)}, request_id)
        else:
            self.record({**details, 'result': 'details needed'})
            self.answer_json(200, {'status': 'DETAILS_NEEDED', 'ticket': self.state.issue_ticket(install_id, email)}, request_id)

    def account_create(self, sent: dict[str, Any], install_id: str, request_id: str, details: dict[str, Any]) -> None:
        if set(sent) != {'email', 'ticket', 'gender', 'age', 'consent_text_version'}:
            raise RequestRefused('creating the account sends exactly {email, ticket, gender, age, consent_text_version}')
        email = check_account_email(sent['email'])
        if not isinstance(sent['ticket'], str) or not ACCOUNT_TICKET.match(sent['ticket']):
            raise RequestRefused('the ticket is not one the API gives')
        if sent['gender'] not in ACCOUNT_GENDERS:
            raise RequestRefused('the gender is not one of the four the contract names')
        age = sent['age']
        if not isinstance(age, int) or isinstance(age, bool) or age > ACCOUNT_MAXIMUM_AGE or age < 1:
            raise RequestRefused('the age must be a whole number the contract allows')
        if sent['consent_text_version'] != ACCOUNT_CONSENT_TEXT_VERSION:
            raise RequestRefused('the consent wording is not the current version')
        if age < ACCOUNT_MINIMUM_AGE:
            self.record({**details, 'result': 'too young'})
            self.answer_envelope({'envelope': 'errors/envelopes/account-age-too-young.json'}, request_id)
            return
        if not self.state.use_ticket(sent['ticket'], install_id, email):
            self.record({**details, 'result': 'ticket not valid'})
            self.answer_envelope({'envelope': 'errors/envelopes/account-ticket-not-valid.json'}, request_id)
            return
        self.state.create_account(install_id, email, sent['gender'], age)
        self.record({**details, 'result': 'created'})
        self.answer_json(201, {'status': 'SIGNED_IN', 'email_masked': mask_email(email)}, request_id)

    def handle_reveal(self, request_id: str, recognition_id: str) -> None:
        """The result an account gate held back (ADR-005). Refused unless the id is a lower-case version 7 one. A recognition
        this install was not given, or one that was no ad's result, is "not found"; with no account the answer is the
        withheld one again; with an account, the full answer the scan would have had."""
        token = self.bearer_token()
        with self.state.lock:
            install_id = self.state.issued_tokens.get(token)
        if install_id is None:
            self.answer_token_not_issued(request_id)
            return
        if self.answers_update_required(install_id, request_id):
            return
        if not RECOGNITION_ID.match(recognition_id):
            raise RequestRefused('the recognition id in the path is not a lower-case UUID version 7')
        answered = self.state.answered_recognition(recognition_id)
        if answered is None or answered['install_id'] != install_id or answered['status'] not in ('MATCH', 'CHOOSE_STATION'):
            self.record({'request_id': request_id, 'recognition_id': recognition_id, 'reveal': 'not found'})
            self.answer_envelope({'envelope': 'errors/envelopes/not-found.json'}, request_id)
            return
        full = json.loads(json.dumps(answered['answer']))
        if self.state.holds_back_for(install_id):
            self.record({'request_id': request_id, 'recognition_id': recognition_id, 'reveal': 'held back'})
            self.answer_json(200, withheld_answer(full, request_id, answered['is_deferred'] == 'true',
                                                  answered['captured_at']), request_id)
            return
        self.record({'request_id': request_id, 'recognition_id': recognition_id, 'reveal': 'revealed'})
        self.answer_recognition(full, request_id, install_id, {'is_deferred': answered['is_deferred'],
                                                               'captured_at': answered['captured_at']})

    def answer_envelope(self, plan: dict[str, Any], request_id: str) -> None:
        """A shared error envelope with this request's id, and the plan's Retry-After or the envelope's own."""
        envelope = read_fixture(plan['envelope'])
        body = envelope['body']
        body['error']['request_id'] = request_id
        self.answer_json(envelope['http_status'], body, request_id, plan.get('retry_after_seconds', envelope.get('retry_after_seconds')))

    def answer_no_content(self, request_id: str) -> None:
        self.send_response(204)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Request-Id', request_id)
        self.end_headers()

    def bearer_token(self) -> str:
        """The install token of `Authorization: Bearer <token>`. A missing or malformed header is refused (400), so the
        run fails: the app always sends one on a listener route."""
        authorization = self.headers.get('Authorization')
        token = (authorization or '').removeprefix('Bearer ')
        if authorization is None or not authorization.startswith('Bearer ') or not BEARER_TOKEN.match(token) \
                or len(token) > 1024:
            raise RequestRefused('a listener route needs Authorization: Bearer <install token>')
        return token

    def refuse_when_no_account(self, install_id: str, what: str) -> None:
        """With the gate on, an install with no account has seen no result, so the real API answers a follow-up as it
        answers an unknown recognition, and the app must never send one: refused, so the run fails."""
        if self.state.holds_back_for(install_id):
            raise RequestRefused(f'{what} from an install with no account: the app never showed it a result')

    def answers_update_required(self, install_id: str, request_id: str) -> bool:
        """The update gate, after the token as on the real guard: with a minimum set, an install registered with an
        older version gets 426 APP_UPDATE_REQUIRED, and no queued answer is spent. True when it answered."""
        with self.state.lock:
            minimum = self.state.minimum_app_version
            registered = self.state.install_app_versions.get(install_id, '')
        if minimum is None or not is_below_minimum_app_version(registered, minimum):
            return False
        self.record({'request_id': request_id, 'update_required': True})
        self.answer_envelope({'envelope': 'errors/envelopes/app-update-required.json'}, request_id)
        return True

    def answer_token_not_issued(self, request_id: str) -> None:
        """A well-formed token the fake did not issue: one from before a reset or a restart, a withdrawn one, or one
        from the real API. The real guard answers 401 INSTALL_TOKEN_INVALID (contract §1.0), and the app registers
        again and resends; it is a correct request, so it is not logged as refused."""
        self.record({'request_id': request_id, 'token_not_issued': True})
        envelope = read_fixture('errors/envelopes/install-token-invalid.json')
        body = envelope['body']
        body['error']['request_id'] = request_id
        self.answer_json(envelope['http_status'], body, request_id)

    def answer_with_scenario(self, scenario: str, request_id: str, token: str) -> None:
        """An identify's answer other than a 200 from the fixtures: a dropped connection, an unreadable page, or an
        error envelope."""
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

def render_answer_section(route: str, scenarios: list[tuple[str, str]]) -> str:
    """One route's buttons on the control page: a heading, what it answers with nothing queued, a button per answer
    ("Next answer: …") and a line the page fills with that route's queue."""
    buttons = '\n'.join(f'      <button type="button" class="answer" data-scenario="{html.escape(name)}">'
                        f'Next answer: {html.escape(label)}</button>' for name, label in scenarios)
    return f'''  <section aria-labelledby="answers-{route}-heading">
    <h2 id="answers-{route}-heading">{html.escape(ROUTE_HEADINGS[route])}</h2>
    <p>Each button queues one answer; {html.escape(ROUTE_DEFAULT_WORDS[route])}</p>
    <div class="buttons">
{buttons}
    </div>
    <p id="queued-{route}" aria-live="polite"></p>
  </section>'''


def render_panel(nonce: str, port: int) -> str:
    """The control page (P6 design §4.7, §5.0 (a)): a button per answer, "No signal" on and off, a phone number for a
    phone check, reset, and a live view of what the app sent. Standard-library HTML with one inline script, allowed by
    its nonce; every control is a JSON POST from this page's own origin."""
    by_route: dict[str, list[tuple[str, str]]] = {route: [] for route in ROUTES}
    for name, plan in SCENARIOS.items():
        by_route[plan['route']].append((name, plan['label']))
    # One section per route, each with its own queue: an identify, a station choice, the station list.
    answer_sections = '\n'.join(render_answer_section(route, by_route[route]) for route in ROUTES)
    # Station names for the hints and choices the state lists by id only; "<" written as an escape, inside a script.
    station_names = json.dumps(station_names_from_fixtures()).replace('<', '\\u003c')
    default_answers = json.dumps(DEFAULT_SCENARIOS).replace('<', '\\u003c')
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
  fieldset {{ border: 1px solid var(--line); border-radius: 10px; margin: 0 0 12px; padding: 8px 12px; }}
  .install {{ display: flex; align-items: center; gap: 8px; min-height: 44px; }}
  .install input {{ width: auto; min-height: 0; }}
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

{answer_sections}

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

  <section aria-labelledby="account-heading">
    <h2 id="account-heading">Listener accounts</h2>
    <p>With the account gate on, an identify answers "One more step to see your result" and holds the ad back until the
       phone has an account. The sign-in code the app asks for is always {FAKE_EMAIL_CODE}.</p>
    <p id="account-status" aria-live="polite"></p>
    <div class="buttons">
      <button type="button" id="account-gate-on">Account gate on</button>
      <button type="button" id="account-gate-off" class="primary">Account gate off</button>
    </div>
  </section>

  <section aria-labelledby="gate-heading">
    <h2 id="gate-heading">Minimum app version</h2>
    <p>Set a version newer than the app's, such as 0.2.0, and every request with a token gets "Please update the
       app" (426), as the real API's update gate gives it. Turn it off to let the app through again.</p>
    <p id="gate" aria-live="polite"></p>
    <label for="minimum-app-version">Minimum version</label><br>
    <input id="minimum-app-version" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
           placeholder="0.2.0">
    <div class="buttons">
      <button type="button" id="gate-on" class="primary">Set the minimum</button>
      <button type="button" id="gate-off">Turn the gate off</button>
    </div>
  </section>

  <section aria-labelledby="number-heading">
    <h2 id="number-heading">Phone number for a phone check</h2>
    <p>Choose your phone's install, then give your number: only answers to that install carry it on their buttons,
       so a call reaches your own phone. Those answers go to whatever sends that install's requests, through the
       tunnel too. The number is forgotten after {PHONE_CHECK_ANSWERS} answers that carry it or
       {PHONE_CHECK_LIFETIME_SECONDS // 60} minutes, whichever comes first; "Stop replacing" or reset forgets it
       sooner. It stays in this stand-in's memory only: it is never saved, logged or shown again.</p>
    <fieldset>
      <legend>Install that gets the number, newest registration first</legend>
      <div id="installs"></div>
    </fieldset>
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
    <p id="choices"></p>
    <p id="station-list-requests"></p>
    <p id="reports"></p>
    <p id="engagements"></p>
    <p id="pictures"></p>
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
  const stationNames = {station_names};
  const defaultAnswers = {default_answers};
  function stationName(stationId) {{ return stationNames[stationId] || ('station ' + String(stationId).slice(0, 8)); }}
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
  let chosenInstallId = null;
  let shownRegistrations = '';
  function showInstalls(registrations) {{
    const key = JSON.stringify(registrations);
    if (key === shownRegistrations) return;
    shownRegistrations = key;
    if (!registrations.some((registration) => registration.install_id === chosenInstallId)) chosenInstallId = null;
    const focused = document.activeElement;
    const focusedInstallId = focused && focused.name === 'install' ? focused.value : null;
    const list = document.getElementById('installs');
    list.replaceChildren();
    if (!registrations.length) {{
      const none = document.createElement('p');
      none.textContent = 'No install has registered yet: open the app on your phone first.';
      list.appendChild(none);
      return;
    }}
    for (const registration of registrations) {{
      const choice = document.createElement('label');
      choice.className = 'install';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'install';
      radio.value = registration.install_id;
      radio.checked = registration.install_id === chosenInstallId;
      radio.addEventListener('change', () => {{ chosenInstallId = radio.value; }});
      choice.appendChild(radio);
      choice.appendChild(document.createTextNode('Install ' + registration.install_label + ', registered at '
        + registration.registered_at + (registration.is_through_tunnel ? ', through the tunnel' : ', from this PC or the emulator')
        + ', app ' + registration.app_version));
      list.appendChild(choice);
      if (registration.install_id === focusedInstallId) radio.focus();
    }}
  }}
  async function refresh() {{
    try {{
      const state = await (await fetch('/__fake/state')).json();
      for (const [route, queued] of Object.entries(state.queued)) {{
        const line = document.getElementById('queued-' + route);
        if (line) line.textContent = queued.length
          ? 'Queued: ' + queued.join(', ') : 'Nothing queued: the next answer is "' + defaultAnswers[route] + '".';
      }}
      document.getElementById('gate').textContent = state.minimum_app_version
        ? 'Apps older than ' + state.minimum_app_version + ' get "Please update the app" ('
          + state.update_required_answers + ' so far).'
        : 'Off: every version is answered.';
      const signal = document.getElementById('signal');
      signal.textContent = state.is_offline ? 'No signal: requests are cut off.' : 'Signal: requests are answered.';
      signal.className = state.is_offline ? 'signal-off' : '';
      document.getElementById('account-status').textContent = (state.is_account_required
        ? 'Gate on: results are held back until the phone has an account.' : 'Gate off: results are answered as before.')
        + ' Accounts: ' + state.accounts + ' · signed-in phones: ' + state.signed_in_installs + '.';
      showInstalls(state.recent_registrations);
      const check = state.phone_check;
      document.getElementById('number-status').textContent = check
        ? 'Answers to install ' + check.install_label + ' carry your number: at most ' + check.answers_left
          + ' more, within ' + Math.ceil(check.seconds_left / 60) + ' minutes.'
        : 'Numbers in answers are the fixtures\\' own.';
      document.getElementById('counts').textContent = 'Registrations: ' + state.registrations
        + ' · re-registrations: ' + state.re_registrations + ' · identifies: ' + state.recognitions.length
        + ' · crash reports: ' + state.client_error_report_ids.length + ' · cut off: ' + state.dropped_while_offline
        + ' · refused: ' + state.refused;
      document.getElementById('choices').textContent = 'Choices: ' + state.choices.length
        + (state.choices.length ? ' — ' + state.choices.map((choice) => stationName(choice.station_id)).join(', ') : '');
      document.getElementById('station-list-requests').textContent = 'Station list requests: ' + state.station_list_requests;
      document.getElementById('reports').textContent = 'Reports: ' + state.reports.length
        + (state.reports.length ? ' — ' + state.reports.map((report) => report.reason).join(', ') : '');
      document.getElementById('pictures').textContent = 'Pictures loaded: ' + state.pictures_served.length;
      document.getElementById('engagements').textContent = 'Taps: ' + state.engagements.length
        + (state.engagements.length ? ' — ' + state.engagements.map((tap) => stationName(tap.station_id)).join(', ') : '');
      const body = document.getElementById('recent');
      body.replaceChildren();
      for (const request of state.recent_requests.slice().reverse()) {{
        const row = document.createElement('tr');
        let outcome = request.outcome;
        if (request.station_hint) outcome += ' · hint: ' + stationName(request.station_hint);
        if (request.station_id) outcome += ' · station: ' + stationName(request.station_id);
        cell(row, request.method); cell(row, request.path); cell(row, outcome); cell(row, request.request_id);
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
  document.getElementById('account-gate-on').addEventListener('click',
    () => control('/__fake/account-gate', {{ is_required: true }}, 'The account gate is on.'));
  document.getElementById('account-gate-off').addEventListener('click',
    () => control('/__fake/account-gate', {{ is_required: false }}, 'The account gate is off.'));
  document.getElementById('use-number').addEventListener('click', () => {{
    if (chosenInstallId === null) {{
      statusLine.textContent = 'Choose your phone\\'s install first.';
      return;
    }}
    const field = document.getElementById('phone-number');
    const number = field.value.replace(/[\\s-]/g, '');
    field.value = '';
    control('/__fake/phone-number', {{ phone_number: number, install_id: chosenInstallId }},
      'Answers to that install now carry that number.');
  }});
  document.getElementById('stop-number').addEventListener('click',
    () => control('/__fake/phone-number', {{ phone_number: null }}, 'Numbers in answers are the fixtures\\' own again.'));
  document.getElementById('gate-on').addEventListener('click', () => {{
    const minimum = document.getElementById('minimum-app-version').value.trim();
    control('/__fake/minimum-app-version', {{ minimum_app_version: minimum }},
      'Apps older than ' + minimum + ' now get "Please update the app".');
  }});
  document.getElementById('gate-off').addEventListener('click',
    () => control('/__fake/minimum-app-version', {{ minimum_app_version: null }}, 'The gate is off.'));
  document.getElementById('reset').addEventListener('click',
    () => control('/__fake/reset', {{}}, 'Everything was reset.'));
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>
'''


def make_server(host: str, port: int, save_audio_to: Path | None,
                clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep,
                public_origin: str | None = None) -> ThreadingHTTPServer:
    if public_origin is not None and not PUBLIC_ORIGIN.match(public_origin):
        raise ValueError('the public origin must be https://<host>[:port], with no path: the app loads https pictures only')
    state = FakeState(save_audio_to, clock, sleep, public_origin)
    handler = type('BoundFakeListenerApi', (FakeListenerApi,), {'state': state})
    return ThreadingHTTPServer((host, port), handler)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=3999)
    parser.add_argument('--save-audio-to', type=Path)
    parser.add_argument('--public-origin', help='the https address the phone reaches this stand-in by (an ngrok '
                                                'tunnel), for the drawn pictures of "Match with pictures"')
    arguments = parser.parse_args()
    try:
        server = make_server(arguments.host, arguments.port, arguments.save_audio_to,
                             public_origin=arguments.public_origin)
    except ValueError as refused:
        parser.error(str(refused))
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
