"""The fake API's listener account routes, gate and reveal (ADR-005; LA-APP-15): each refuses what the real API would
refuse, answers with the shared fixtures' words, holds an ad's result back from an install with no account, and never
shows an email, a gender or an age. Standard library only:

    python -m unittest tool/test_fake_listener_api_accounts.py
"""

from __future__ import annotations

import json
import re
import unittest
import uuid
from pathlib import Path
from typing import Any

from fake_listener_api import (ACCOUNT_CODE_ATTEMPT_LIMIT, ACCOUNT_CODE_LIFETIME_SECONDS, ACCOUNT_CODE_RESEND_SECONDS,
                               ACCOUNT_CONSENT_TEXT_VERSION, ACCOUNT_GENDERS, ACCOUNT_MAXIMUM_AGE, ACCOUNT_MINIMUM_AGE,
                               FAKE_EMAIL_CODE, FIXTURES, mask_email, new_recognition_id, read_fixture)
from test_fake_listener_api import NO_ANSWER, FakeServerHelpers, live_fields

CONTRACT_SOURCE = FIXTURES.parent / 'src' / 'listener-accounts' / 'listener-account-schemas.ts'
SCHEMAS = FIXTURES.parent / 'schemas'
EMAIL = 'listener@example.com'
ANOTHER_EMAIL = 'someone.else@example.com'


def envelope_of(name: str, request_id: str | None = None) -> dict[str, Any]:
    """The shared error envelope [name], as the fake answers it for [request_id]."""
    body = read_fixture(f'errors/envelopes/{name}.json')['body']
    if request_id is not None:
        body['error']['request_id'] = request_id
    return body


class FakeAccountRoutesTest(FakeServerHelpers, unittest.TestCase):
    # ---- helpers ----------------------------------------------------------------------------------------

    def account(self, token: str | None, action: str, body: Any = None, request_id: str | None = None,
                content_type: str | None = 'application/json') -> tuple[int, dict[str, str], Any]:
        """An account call as the app makes it: JSON, its own request id, the install token."""
        headers = {'X-Request-Id': request_id or str(uuid.uuid4())}
        if token:
            headers['Authorization'] = f'Bearer {token}'
        path = '/api/v1/listener-account' + {'create': '', 'describe': '', 'delete': ''}.get(action, f'/{action}')
        if action == 'describe':
            return self.get(path, headers)
        if action == 'delete':
            return self.send(path, b'', headers, method='DELETE')
        if content_type:
            headers['Content-Type'] = content_type
        return self.send(path, json.dumps(body if body is not None else {}).encode(), headers)

    def creation(self, ticket: str, **changes: Any) -> dict[str, Any]:
        body = {'email': EMAIL, 'ticket': ticket, 'gender': 'FEMALE', 'age': 34,
                'consent_text_version': ACCOUNT_CONSENT_TEXT_VERSION}
        body.update(changes)
        return body

    def ask_and_check(self, token: str, email: str = EMAIL) -> tuple[int, dict[str, str], Any]:
        """Asks for a code and types the right one."""
        self.assertEqual(self.account(token, 'code', {'email': email})[0], 202)
        return self.account(token, 'verify', {'email': email, 'code': FAKE_EMAIL_CODE})

    def sign_up(self, token: str, email: str = EMAIL, **changes: Any) -> None:
        """A whole new account for this install."""
        status, _, answered = self.ask_and_check(token, email)
        self.assertEqual((status, answered['status']), (200, 'DETAILS_NEEDED'))
        status, _, created = self.account(token, 'create', self.creation(answered['ticket'], email=email, **changes))
        self.assertEqual((status, created['status']), (201, 'SIGNED_IN'))

    def set_gate(self, is_required: bool) -> None:
        self.assertEqual(self.control('/__fake/account-gate', {'is_required': is_required})[0], 200)

    def identify(self, token: str, scenario: str | None = None, **fields: str) -> tuple[int, dict[str, str], Any]:
        if scenario:
            self.queue(scenario)
        return self.recognize(token, live_fields(**fields))

    def reveal(self, token: str | None, recognition_id: str) -> tuple[int, dict[str, str], Any]:
        headers = {'X-Request-Id': str(uuid.uuid4())}
        if token:
            headers['Authorization'] = f'Bearer {token}'
        return self.get(f'/api/v1/recognitions/{recognition_id}', headers)

    # ---- the account's own routes -------------------------------------------------------------------------

    def test_a_new_email_asks_for_a_code_checks_it_and_makes_the_account(self) -> None:
        token = self.registered_token()
        request_id = str(uuid.uuid4())
        status, headers, body = self.account(token, 'code', {'email': EMAIL}, request_id)
        self.assertEqual((status, body, headers['X-Request-Id']), (202, {'resend_after_seconds': 60}, request_id))
        self.assertEqual(self.account(token, 'describe')[2], {'is_signed_in': False, 'email_masked': None})

        wrong_request_id = str(uuid.uuid4())
        status, _, refused = self.account(token, 'verify', {'email': EMAIL, 'code': '000000'}, wrong_request_id)
        self.assertEqual((status, refused), (400, envelope_of('listener-code-incorrect', wrong_request_id)))

        status, _, answered = self.account(token, 'verify', {'email': EMAIL, 'code': FAKE_EMAIL_CODE})
        self.assertEqual((status, set(answered), answered['status']), (200, {'status', 'ticket'}, 'DETAILS_NEEDED'))
        status, _, created = self.account(token, 'create', self.creation(answered['ticket']))
        self.assertEqual((status, created), (201, {'status': 'SIGNED_IN', 'email_masked': 'l***@example.com'}))
        self.assertEqual(self.account(token, 'describe')[2], {'is_signed_in': True, 'email_masked': 'l***@example.com'})
        self.assertEqual(self.state()['accounts'], 1)
        self.assertEqual(self.state()['signed_in_installs'], 1)

    def test_an_email_that_has_an_account_signs_in_at_the_code_with_no_details_asked(self) -> None:
        self.sign_up(self.registered_token())
        second_phone = self.registered_token()
        status, _, answered = self.ask_and_check(second_phone)
        self.assertEqual((status, answered), (200, {'status': 'SIGNED_IN', 'email_masked': 'l***@example.com'}))
        self.assertEqual(self.state()['signed_in_installs'], 2)
        self.assertEqual(self.state()['accounts'], 1)

    def test_another_code_within_a_minute_is_asked_to_wait_and_after_it_goes_out(self) -> None:
        token = self.registered_token()
        self.assertEqual(self.account(token, 'code', {'email': EMAIL})[0], 202)
        self.clock.seconds += 22
        request_id = str(uuid.uuid4())
        status, headers, refused = self.account(token, 'code', {'email': EMAIL}, request_id)
        self.assertEqual((status, refused), (429, envelope_of('resend-too-soon', request_id)))
        self.assertEqual(headers['Retry-After'], str(ACCOUNT_CODE_RESEND_SECONDS - 22))
        self.clock.seconds += ACCOUNT_CODE_RESEND_SECONDS
        self.assertEqual(self.account(token, 'code', {'email': EMAIL})[0], 202)

    def test_five_wrong_codes_lock_the_email_and_an_old_or_unasked_code_is_expired(self) -> None:
        token = self.registered_token()
        request_id = str(uuid.uuid4())
        self.assertEqual(self.account(token, 'verify', {'email': EMAIL, 'code': FAKE_EMAIL_CODE}, request_id)[2],
                         envelope_of('listener-code-expired', request_id))
        self.account(token, 'code', {'email': EMAIL})
        for _ in range(ACCOUNT_CODE_ATTEMPT_LIMIT - 1):
            self.assertEqual(self.account(token, 'verify', {'email': EMAIL, 'code': '111111'})[2]['error']['code'],
                             'LISTENER_CODE_INCORRECT')
        self.assertEqual(self.account(token, 'verify', {'email': EMAIL, 'code': '111111'})[2]['error']['code'],
                         'LISTENER_CODE_LOCKED')
        self.assertEqual(self.account(token, 'verify', {'email': EMAIL, 'code': FAKE_EMAIL_CODE})[2]['error']['code'],
                         'LISTENER_CODE_LOCKED', msg='the right code does not unlock it')
        self.clock.seconds += ACCOUNT_CODE_RESEND_SECONDS
        self.account(token, 'code', {'email': ANOTHER_EMAIL})
        self.clock.seconds += ACCOUNT_CODE_LIFETIME_SECONDS + 1
        self.assertEqual(self.account(token, 'verify', {'email': ANOTHER_EMAIL, 'code': FAKE_EMAIL_CODE})[2]['error']['code'],
                         'LISTENER_CODE_EXPIRED')

    def test_the_details_are_refused_without_a_good_ticket_and_a_child_is_told_so(self) -> None:
        token = self.registered_token()
        _, _, answered = self.ask_and_check(token)
        ticket = answered['ticket']
        other_phone = self.registered_token()
        request_id = str(uuid.uuid4())
        not_valid = read_fixture('errors/envelopes/account-ticket-not-valid.json')
        status, _, refused = self.account(other_phone, 'create', self.creation(ticket), request_id)
        self.assertEqual((status, refused), (not_valid['http_status'], envelope_of('account-ticket-not-valid', request_id)),
                         msg="another phone's ticket")
        too_young = read_fixture('errors/envelopes/account-age-too-young.json')
        status, _, refused = self.account(token, 'create', self.creation(ticket, age=12))
        self.assertEqual((status, refused['error']['code']), (too_young['http_status'], too_young['body']['error']['code']))
        self.assertEqual(self.state()['accounts'], 0, msg='a child creates nothing, and the ticket is not spent')
        self.assertEqual(self.account(token, 'create', self.creation(ticket))[0], 201)
        status, _, refused = self.account(token, 'create', self.creation(ticket))
        self.assertEqual(refused['error']['code'], 'ACCOUNT_TICKET_NOT_VALID', msg='a ticket is spent once')

    def test_every_mistake_the_real_api_would_refuse_is_refused_so_the_run_fails(self) -> None:
        token = self.registered_token()
        _, _, answered = self.ask_and_check(token)
        ticket = answered['ticket']
        for why, action, body in [
            ('an email in capitals', 'code', {'email': 'Listener@Example.com'}),
            ('an email with spaces round it', 'code', {'email': ' listener@example.com '}),
            ('not an email', 'code', {'email': 'listener'}),
            ('a field it does not know', 'code', {'email': EMAIL, 'gender': 'FEMALE'}),
            ('a code with a letter', 'verify', {'email': EMAIL, 'code': '12345a'}),
            ('a code of five digits', 'verify', {'email': EMAIL, 'code': '12345'}),
            ('a code that is a number', 'verify', {'email': EMAIL, 'code': 123456}),
            ('an age as text', 'create', self.creation(ticket, age='34')),
            ('an age of 100', 'create', self.creation(ticket, age=100)),
            ('an age of true', 'create', self.creation(ticket, age=True)),
            ('a gender that is not offered', 'create', self.creation(ticket, gender='X')),
            ('the old consent wording', 'create', self.creation(ticket, consent_text_version='listener-consent-2020-01')),
            ('no consent wording', 'create', {k: v for k, v in self.creation(ticket).items() if k != 'consent_text_version'}),
            ('a ticket that is too short', 'create', self.creation('short')),
            ('a body on sign-out', 'sign-out', {'email': EMAIL}),
        ]:
            with self.subTest(why):
                before = self.state()['refused']
                self.assertEqual(self.account(token, action, body)[0], 400)
                self.assertEqual(self.state()['refused'], before + 1)
        for why, kwargs in [('no token', {'token': None}), ('a body that is not JSON', {'content_type': 'text/plain'})]:
            with self.subTest(why):
                before = self.state()['refused']
                status = self.account(kwargs.get('token', token), 'code', {'email': EMAIL},
                                      content_type=kwargs.get('content_type', 'application/json'))[0]
                self.assertEqual(status, 400)
                self.assertEqual(self.state()['refused'], before + 1)

    def test_a_token_the_stand_in_did_not_issue_gets_401_so_the_app_registers_again(self) -> None:
        request_id = str(uuid.uuid4())
        status, _, refused = self.account('fake.never-issued-token-0123456789.token', 'code', {'email': EMAIL}, request_id)
        self.assertEqual((status, refused), (401, envelope_of('install-token-invalid', request_id)))
        self.assertEqual(self.state()['refused'], 0)

    def test_the_update_gate_answers_every_account_route_before_anything_else(self) -> None:
        token = self.registered_token()
        self.assertEqual(self.control('/__fake/minimum-app-version', {'minimum_app_version': '9.0.0'})[0], 200)
        for action in ('code', 'describe', 'sign-out', 'delete'):
            with self.subTest(action):
                self.assertEqual(self.account(token, action, {'email': EMAIL} if action == 'code' else None)[0], 426)

    def test_signing_out_leaves_the_account_and_deleting_erases_it_for_every_phone(self) -> None:
        first = self.registered_token()
        self.sign_up(first)
        second = self.registered_token()
        self.assertEqual(self.ask_and_check(second)[2]['status'], 'SIGNED_IN')
        status, headers, body = self.account(second, 'sign-out', {})
        self.assertEqual((status, body, headers['Cache-Control']), (204, b'', 'no-store'))
        self.assertEqual(self.account(second, 'describe')[2]['is_signed_in'], False)
        self.assertEqual((self.state()['accounts'], self.state()['signed_in_installs']), (1, 1))
        self.assertEqual(self.account(first, 'delete')[0], 204)
        self.assertEqual((self.state()['accounts'], self.state()['signed_in_installs']), (0, 0))
        self.assertEqual(self.account(first, 'describe')[2]['is_signed_in'], False)
        self.clock.seconds += ACCOUNT_CODE_RESEND_SECONDS
        self.assertEqual(self.ask_and_check(second)[2]['status'], 'DETAILS_NEEDED', msg='the email has no account now')

    def test_a_phone_signed_in_to_one_account_is_told_to_sign_out_before_another(self) -> None:
        token = self.registered_token()
        self.sign_up(token)
        self.account(token, 'code', {'email': ANOTHER_EMAIL})
        request_id = str(uuid.uuid4())
        status, _, refused = self.account(token, 'verify', {'email': ANOTHER_EMAIL, 'code': FAKE_EMAIL_CODE}, request_id)
        self.assertEqual((status, refused), (409, envelope_of('already-signed-in', request_id)))

    def test_no_signal_cuts_an_account_call_off_before_it_is_answered(self) -> None:
        token = self.registered_token()
        self.assertEqual(self.control('/__fake/offline', {'is_offline': True})[0], 200)
        with self.assertRaises(NO_ANSWER):
            self.account(token, 'code', {'email': EMAIL})
        self.assertEqual(self.state()['dropped_while_offline'], 1)

    # ---- the gate and the reveal ------------------------------------------------------------------------------

    def test_with_the_gate_off_every_identify_is_answered_as_before(self) -> None:
        token = self.registered_token()
        status, _, body = self.identify(token, 'match')
        self.assertEqual((status, body['status']), (200, 'MATCH'))

    def test_with_the_gate_on_an_ad_is_held_back_with_five_fields_and_nothing_of_the_ad(self) -> None:
        token = self.registered_token()
        self.set_gate(True)
        for scenario in ('match', 'choose-station', 'fallback', 'match-by-hint'):
            with self.subTest(scenario):
                fields = {'station_hint': '0192a6c4-1111-4000-8000-000000000001'} if scenario == 'match-by-hint' else {}
                request_id = str(uuid.uuid4())
                self.queue(scenario)
                status, headers, answered = self.recognize(token, live_fields(is_deferred='true', **fields), request_id=request_id)
                self.assertEqual(status, 200)
                self.assertEqual(set(answered), {'status', 'recognition_id', 'request_id', 'is_deferred', 'captured_at'})
                self.assertEqual((answered['status'], answered['request_id'], answered['is_deferred']),
                                 ('ACCOUNT_REQUIRED', request_id, True))
                self.assertEqual(answered['captured_at'], '2026-10-08T06:30:00.000Z')
                self.assertEqual(headers['X-Request-Id'], request_id)
                self.assertNotIn('Station', json.dumps(answered))
        self.assertEqual(self.state()['refused'], 0)
        self.assertTrue(all(entry['account_required'] for entry in self.state()['recognitions']))

    def test_an_answer_that_holds_no_ad_is_not_held_back_and_the_switch_is_per_install(self) -> None:
        token = self.registered_token()
        self.set_gate(True)
        self.assertEqual(self.identify(token, 'no-match')[2]['status'], 'NO_MATCH')
        self.assertEqual(self.identify(token, 'busy')[0], 503)
        signed_up = self.registered_token()
        self.sign_up(signed_up)
        self.assertEqual(self.identify(signed_up, 'match')[2]['status'], 'MATCH')

    def test_the_same_clip_sent_again_is_held_back_again_with_the_same_recognition_and_the_new_request_id(self) -> None:
        token = self.registered_token()
        self.set_gate(True)
        fields = live_fields()
        _, _, first = self.recognize(token, fields)
        request_id = str(uuid.uuid4())
        _, _, again = self.recognize(token, fields, request_id=request_id)
        self.assertEqual((again['status'], again['recognition_id'], again['request_id']),
                         ('ACCOUNT_REQUIRED', first['recognition_id'], request_id))

    def test_after_the_account_the_reveal_gives_the_result_the_scan_would_have_had(self) -> None:
        token = self.registered_token()
        self.set_gate(True)
        _, _, held = self.identify(token, 'match')
        request_id = str(uuid.uuid4())
        status, _, still = self.reveal(token, held['recognition_id'])
        self.assertEqual((status, still['status']), (200, 'ACCOUNT_REQUIRED'))
        self.sign_up(token)
        status, headers, revealed = self.get(f"/api/v1/recognitions/{held['recognition_id']}",
                                             {'X-Request-Id': request_id, 'Authorization': f'Bearer {token}'})
        expected = read_fixture('recognition/recognize-response/valid/match-campaign.json')['response']
        self.assertEqual((status, headers['X-Request-Id']), (200, request_id))
        self.assertEqual(revealed, {**expected, 'recognition_id': held['recognition_id'], 'request_id': request_id})
        # The same clip sent again now gets the result too.
        self.assertEqual(self.recognize(token, live_fields())[2]['status'], 'MATCH')

    def test_a_chooser_is_revealed_with_its_candidates_and_the_choice_then_works(self) -> None:
        token = self.registered_token()
        self.set_gate(True)
        _, _, held = self.identify(token, 'choose-station')
        self.assertEqual(held['status'], 'ACCOUNT_REQUIRED')
        self.sign_up(token)
        _, _, revealed = self.reveal(token, held['recognition_id'])
        self.assertEqual(revealed['status'], 'CHOOSE_STATION')
        station = revealed['candidates'][0]['station']['id']
        self.assertEqual(self.choose(token, held['recognition_id'], {'station_id': station})[0], 204)

    def test_the_reveal_is_for_the_owning_install_and_an_ad_only(self) -> None:
        token = self.registered_token()
        self.set_gate(True)
        _, _, held = self.identify(token, 'match')
        _, _, nothing = self.identify(token, 'no-match')
        self.sign_up(token)
        other = self.registered_token()
        self.sign_up(other, ANOTHER_EMAIL)
        for why, who, recognition_id in [('another phone', other, held['recognition_id']),
                                         ('an invented id', token, new_recognition_id()),
                                         ('a no-match', token, nothing['recognition_id'])]:
            with self.subTest(why):
                request_id = str(uuid.uuid4())
                status, _, refused = self.get(f'/api/v1/recognitions/{recognition_id}',
                                              {'X-Request-Id': request_id, 'Authorization': f'Bearer {who}'})
                self.assertEqual((status, refused), (404, envelope_of('not-found', request_id)))
        self.assertEqual(self.reveal(token, held['recognition_id'])[0], 200)

    def test_the_reveal_refuses_what_the_real_api_would(self) -> None:
        token = self.registered_token()
        for why, who, path in [('no token', None, new_recognition_id()), ('an id that is not a version 7 UUID', token, str(uuid.uuid4())),
                               ('an id that is not an id', token, 'not-an-id')]:
            with self.subTest(why):
                before = self.state()['refused']
                self.assertEqual(self.reveal(who, path)[0], 400)
                self.assertEqual(self.state()['refused'], before + 1)

    def test_with_the_gate_on_a_phone_with_no_account_may_not_follow_up_a_result_it_never_saw(self) -> None:
        token = self.registered_token()
        chooser = self.chooser(token)
        station = chooser['candidates'][0]['station']['id']
        self.set_gate(True)
        self.assertEqual(self.choose(token, chooser['recognition_id'], {'station_id': station})[0], 400)
        self.assertEqual(self.report(token, chooser['recognition_id'], {'station_id': station, 'reason': 'SOMETHING_ELSE'})[0], 400)
        self.assertEqual(self.state()['refused'], 2)

    # ---- privacy and drift --------------------------------------------------------------------------------------------

    def test_nothing_of_the_listener_is_ever_in_the_logs_the_state_or_an_answer_to_another_call(self) -> None:
        token = self.registered_token()
        self.sign_up(token, EMAIL, gender='ANOTHER', age=57)
        everything = json.dumps([self.state(), self.request_log()])
        for private in (EMAIL, 'example.com', 'ANOTHER', '"age"', '"gender"', FAKE_EMAIL_CODE):
            self.assertNotIn(private, everything, msg=private)

    def test_the_masked_email_is_the_first_letter_three_stars_and_the_domain(self) -> None:
        self.assertEqual(mask_email('listener@example.com'), 'l***@example.com')
        self.assertEqual(mask_email('x@y.zm'), 'x***@y.zm')
        self.assertEqual(mask_email('no-at-sign'), '***')

    def test_the_gate_switch_takes_only_a_true_or_false(self) -> None:
        for body in ({'is_required': 'yes'}, {'is_required': None}, {}, {'is_required': True, 'x': 1}, [True]):
            with self.subTest(body):
                self.assertEqual(self.control('/__fake/account-gate', body)[0], 400)
        self.set_gate(True)
        self.assertEqual(self.state()['is_account_required'], True)
        self.assertEqual(self.control('/__fake/reset', {})[0], 200)
        self.assertEqual(self.state()['is_account_required'], False, msg='a reset turns the gate off')

    def test_the_rules_agree_with_the_contract(self) -> None:
        source = CONTRACT_SOURCE.read_text(encoding='utf8')

        def number(name: str) -> int:
            found = re.search(rf'export const {name} = ([0-9_ *]+);', source)
            self.assertIsNotNone(found, msg=name)
            product = 1
            for factor in found.group(1).replace('_', '').split('*'):
                product *= int(factor)
            return product

        def text(name: str) -> str:
            found = re.search(rf"export const {name} = '([^']+)';", source)
            self.assertIsNotNone(found, msg=name)
            return found.group(1)

        self.assertEqual(ACCOUNT_MINIMUM_AGE, number('MINIMUM_LISTENER_AGE'))
        self.assertEqual(ACCOUNT_MAXIMUM_AGE, number('MAXIMUM_LISTENER_AGE'))
        self.assertEqual(ACCOUNT_CONSENT_TEXT_VERSION, text('LISTENER_CONSENT_TEXT_VERSION'))
        self.assertEqual(ACCOUNT_CODE_LIFETIME_SECONDS, number('LISTENER_EMAIL_CODE_LIFETIME_SECONDS'))
        self.assertEqual(ACCOUNT_CODE_RESEND_SECONDS, number('LISTENER_EMAIL_CODE_RESEND_COOLDOWN_SECONDS'))
        self.assertEqual(ACCOUNT_CODE_ATTEMPT_LIMIT, number('LISTENER_EMAIL_CODE_ATTEMPT_LIMIT'))
        self.assertEqual(len(FAKE_EMAIL_CODE), number('LISTENER_EMAIL_CODE_LENGTH'))
        genders = re.search(r"LISTENER_GENDERS = \[([^\]]+)\]", source)
        self.assertIsNotNone(genders)
        self.assertEqual(tuple(re.findall(r"'([A-Z_]+)'", genders.group(1))), ACCOUNT_GENDERS)

    def test_the_answers_have_exactly_the_fields_of_the_committed_json_schemas(self) -> None:
        def properties(file_name: str, definition: str) -> set[str]:
            schema = json.loads((SCHEMAS / file_name).read_text(encoding='utf8'))
            return set(schema['$defs'][definition]['properties'])

        token = self.registered_token()
        _, _, sent = self.account(token, 'code', {'email': EMAIL})
        self.assertEqual(set(sent), properties('listener-account-code-sent.schema.json', 'ListenerAccountCodeSent'))
        self.clock.seconds += ACCOUNT_CODE_RESEND_SECONDS
        _, _, answered = self.ask_and_check(token)
        self.assertEqual(set(answered), properties('verify-listener-account-code-answer.schema.json', 'ListenerAccountDetailsNeeded'))
        _, _, created = self.account(token, 'create', self.creation(answered['ticket']))
        self.assertEqual(set(created), properties('listener-account-signed-in.schema.json', 'ListenerAccountSignedIn'))
        _, _, summary = self.account(token, 'describe')
        self.assertEqual(set(summary), properties('listener-account-summary.schema.json', 'ListenerAccountSummary'))


if __name__ == '__main__':
    unittest.main()
