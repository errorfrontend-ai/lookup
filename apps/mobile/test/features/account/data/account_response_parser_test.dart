import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/features/account/domain/account_answer.dart';
import 'package:lookup_listener/features/account/data/account_response_parser.dart';
import 'package:lookup_listener/features/account/domain/account_problem.dart';

import '../../../support/contract_fixtures.dart';

final DateTime _now = DateTime.utc(2026, 10, 20, 12);
const AccountResponseParser _parser = AccountResponseParser();

ApiAnswer _answer(int status, Object? body, {String? retryAfter}) => ApiAnswerReceived(
  sentRequestId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  status: status,
  body: body == null ? const NotJsonAnswerBody() : JsonAnswerBody(body),
  retryAfter: retryAfter,
);

ApiAnswer _fixtureAnswer(String name, {String? retryAfter}) {
  final content = ContractFixtures.readFile('errors/envelopes/$name.json')! as Map<String, Object?>;
  return _answer(content['http_status']! as int, content['body'], retryAfter: retryAfter ?? content['retry_after_seconds']?.toString());
}

AccountProblem _problemOf(AccountAnswer answer) => (answer as AccountRefused).problem;

/// How the account routes' answers are read (ADR-005, design §4): success shapes strictly, errors by their code and
/// never by the API's message (LA-APP-03 to -05, -10).
void main() {
  group('asking for a code', () {
    test('202 with the wait before another', () {
      final answer = _parser.readCodeSent(_answer(202, {'resend_after_seconds': 60}), now: _now);
      expect(answer, isA<AccountCodeSent>().having((sent) => sent.resendAfterSeconds, 'resendAfterSeconds', 60));
    });

    for (final body in [<String, Object?>{}, {'resend_after_seconds': 0}, {'resend_after_seconds': 'sixty'}, {'resend_after_seconds': 100000}, 'x']) {
      test('a 202 body of $body is a server failure', () {
        expect(_problemOf(_parser.readCodeSent(_answer(202, body), now: _now)), AccountProblem.serverFailure);
      });
    }

    test('a 200 where 202 is promised is a server failure', () {
      expect(_problemOf(_parser.readCodeSent(_answer(200, {'resend_after_seconds': 60}), now: _now)), AccountProblem.serverFailure);
    });
  });

  group('checking a code', () {
    test('SIGNED_IN gives the masked email', () {
      final answer = _parser.readVerified(_answer(200, {'status': 'SIGNED_IN', 'email_masked': 'l***@example.com'}), now: _now);
      expect(answer, isA<AccountSignedIn>().having((signedIn) => signedIn.emailMasked, 'emailMasked', 'l***@example.com'));
    });

    test('DETAILS_NEEDED gives the ticket', () {
      final answer = _parser.readVerified(_answer(200, {'status': 'DETAILS_NEEDED', 'ticket': 'T' * 54}), now: _now);
      expect(answer, isA<AccountDetailsNeeded>().having((needed) => needed.ticket, 'ticket', 'T' * 54));
    });

    for (final body in [
      {'status': 'DETAILS_NEEDED'},
      {'status': 'DETAILS_NEEDED', 'ticket': ''},
      {'status': 'DETAILS_NEEDED', 'ticket': 'T' * 301},
      {'status': 'SIGNED_IN'},
      {'status': 'SOMETHING_NEW'},
      <String, Object?>{},
    ]) {
      test('$body cannot be read: a server failure', () {
        expect(_problemOf(_parser.readVerified(_answer(200, body), now: _now)), AccountProblem.serverFailure);
      });
    }
  });

  group('creating the account', () {
    test('201 SIGNED_IN', () {
      expect(_parser.readCreated(_answer(201, {'status': 'SIGNED_IN', 'email_masked': 'l***@example.com'}), now: _now), isA<AccountSignedIn>());
    });

    test('any other success is not read as one', () {
      expect(_problemOf(_parser.readCreated(_answer(200, {'status': 'SIGNED_IN', 'email_masked': 'l***@example.com'}), now: _now)), AccountProblem.serverFailure);
      expect(_problemOf(_parser.readCreated(_answer(201, {'status': 'DETAILS_NEEDED', 'ticket': 'T' * 54}), now: _now)), AccountProblem.serverFailure);
    });
  });

  group('the account of this phone', () {
    test('signed in, with the masked email', () {
      final answer = _parser.readSummary(_answer(200, {'is_signed_in': true, 'email_masked': 'l***@example.com'}), now: _now);
      expect(answer, isA<AccountSummaryRead>().having((read) => read.summary.emailMasked, 'emailMasked', 'l***@example.com'));
    });

    test('signed out', () {
      final answer = _parser.readSummary(_answer(200, {'is_signed_in': false, 'email_masked': null}), now: _now);
      expect(answer, isA<AccountSummaryRead>().having((read) => read.summary.isSignedIn, 'isSignedIn', isFalse));
    });

    test('signed in with no email, or a flag that is not a flag, is a server failure', () {
      expect(_problemOf(_parser.readSummary(_answer(200, {'is_signed_in': true, 'email_masked': null}), now: _now)), AccountProblem.serverFailure);
      expect(_problemOf(_parser.readSummary(_answer(200, {'is_signed_in': 'yes'}), now: _now)), AccountProblem.serverFailure);
    });

    test('sign-out and deletion answer 204', () {
      expect(_parser.readNoContent(_answer(204, null), now: _now), isA<AccountDone>());
      expect(_problemOf(_parser.readNoContent(_answer(200, {'a': 1}), now: _now)), AccountProblem.serverFailure);
    });
  });

  group('the shared error envelopes, read by their code and never by their message', () {
    final cases = <String, AccountProblem>{
      'listener-code-incorrect': AccountProblem.codeIncorrect,
      'listener-code-expired': AccountProblem.codeExpired,
      'listener-code-locked': AccountProblem.codeLocked,
      'account-ticket-not-valid': AccountProblem.startAgain,
      'account-age-too-young': AccountProblem.tooYoung,
      'already-signed-in': AccountProblem.alreadySignedIn,
      'resend-too-soon': AccountProblem.resendTooSoon,
      'rate-limited': AccountProblem.tooManyTries,
      'app-update-required': AccountProblem.updateRequired,
      'internal': AccountProblem.serverFailure,
      'service-unavailable': AccountProblem.serverFailure,
      'install-token-invalid': AccountProblem.serverFailure,
      'not-found': AccountProblem.serverFailure,
    };
    for (final MapEntry(key: name, value: problem) in cases.entries) {
      test('$name → $problem', () {
        expect(_problemOf(_parser.readVerified(_fixtureAnswer(name), now: _now)), problem);
      });
    }

    test('the wait the server asks for comes with the refusal', () {
      final answer = _parser.readCodeSent(_fixtureAnswer('resend-too-soon'), now: _now) as AccountRefused;
      expect(answer.retryAfterSeconds, 37);
    });

    test('a validation failure that names the email field is "not an email"; one naming another field is a failure', () {
      Object? envelope(String path) => {
        'error': {
          'code': 'VALIDATION_FAILED',
          'message': 'x',
          'request_id': '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
          'fields': [
            {'path': path, 'code': 'invalid_format'},
          ],
        },
      };
      expect(_problemOf(_parser.readCodeSent(_answer(400, envelope('email')), now: _now)), AccountProblem.notAnEmail);
      expect(_problemOf(_parser.readCodeSent(_answer(400, envelope('age')), now: _now)), AccountProblem.serverFailure);
    });

    test('a body that is not an envelope, or has a malformed code, is a server failure', () {
      expect(_problemOf(_parser.readVerified(_answer(400, null), now: _now)), AccountProblem.serverFailure);
      expect(_problemOf(_parser.readVerified(_answer(400, {'error': {'code': 'lower case'}}), now: _now)), AccountProblem.serverFailure);
    });
  });

  group('no answer', () {
    ApiAnswer noAnswer(ApiNoAnswerReason reason) => ApiAnswerNotReceived(sentRequestId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', reason: reason);

    test('the network failing is "no connection"', () {
      for (final reason in [ApiNoAnswerReason.noConnection, ApiNoAnswerReason.timedOut, ApiNoAnswerReason.connectionDropped]) {
        expect(_problemOf(_parser.readCodeSent(noAnswer(reason), now: _now)), AccountProblem.noConnection, reason: reason.name);
      }
    });

    test('the phone stopping the request is a failure, not a missing signal', () {
      for (final reason in [ApiNoAnswerReason.plainHttpRefused, ApiNoAnswerReason.unexpectedFailure, ApiNoAnswerReason.cancelled]) {
        expect(_problemOf(_parser.readCodeSent(noAnswer(reason), now: _now)), AccountProblem.serverFailure, reason: reason.name);
      }
    });

    test('a registration that failed is read the same way', () {
      expect(_problemOf(_parser.readNotRegistered(noAnswer(ApiNoAnswerReason.noConnection), now: _now)), AccountProblem.noConnection);
      expect(_problemOf(_parser.readNotRegistered(_answer(503, null), now: _now)), AccountProblem.serverFailure);
    });
  });
}
