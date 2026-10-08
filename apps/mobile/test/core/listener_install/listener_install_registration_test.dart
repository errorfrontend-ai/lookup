import 'dart:convert';

import 'package:dio/dio.dart' show DioExceptionType;
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_version.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/listener_install/listener_install_registration.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/network/api_client.dart';

import '../../features/identify/data/contract_schema_checker.dart';
import '../../support/example_app_configurations.dart';
import '../../support/fake_clock.dart';
import '../../support/fake_http_client_adapter.dart';
import '../../support/repository_file_locator.dart';

Map<String, Object?> _schema(String fileName) =>
    jsonDecode(
          RepositoryFileLocator.file('packages/contracts/schemas/$fileName').readAsStringSync(),
        )
        as Map<String, Object?>;

const String _installId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
const String _token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

void main() {
  final registerInstallInput = _schema('register-install-input.schema.json');
  final installRegistration = _schema('install-registration.schema.json');
  late FakeHttpClientAdapter adapter;

  setUp(() => adapter = FakeHttpClientAdapter());

  ListenerInstallRegistration registrationWith({TargetPlatform Function()? readPlatform}) =>
      ListenerInstallRegistration(
        apiClient: ApiClient(
          configuration: ExampleAppConfigurations.production(),
          randomUuid: RandomUuid(),
          clock: FakeClock(),
          httpClientAdapter: adapter,
        ),
        readPlatform: readPlatform,
      );

  Future<ListenerInstallRegistrationResult> registerAnswering(Object? body, {int status = 200}) {
    adapter.answerJson(status, body);
    return registrationWith().register(const ListenerInstallCredentials(installId: _installId));
  }

  group('the request', () {
    test('is exactly the contract: install id, platform and app version, nothing else', () async {
      adapter.answerJson(200, {'install_token': _token, 'expires_at': '2026-11-07T12:00:00.000Z'});
      await registrationWith().register(const ListenerInstallCredentials(installId: _installId));
      final request = adapter.requests.single;
      expect(request.address.path, '/api/v1/installs');
      expect(request.jsonBody, {
        'install_id': _installId,
        'platform': 'ANDROID',
        'app_version': AppVersion.current,
      });
      expect(ContractSchemaChecker.problemsWith(request.jsonBody, registerInstallInput), isEmpty);
    });

    test('carries no install token, even when one is stored', () async {
      adapter.answerJson(200, {'install_token': _token, 'expires_at': '2026-11-07T12:00:00.000Z'});
      await registrationWith().register(
        ListenerInstallCredentials(
          installId: _installId,
          installToken: 'old.token.value',
          tokenExpiresAt: DateTime.utc(2026, 10, 9),
        ),
      );
      final request = adapter.requests.single;
      expect(request.hasHeader('Authorization'), isFalse);
      expect(request.bodyText, isNot(contains('old.token.value')));
    });

    test('names the platform the app runs on: ANDROID or IOS', () {
      final onAndroid = registrationWith(readPlatform: () => TargetPlatform.android);
      final oniOS = registrationWith(readPlatform: () => TargetPlatform.iOS);
      expect(onAndroid.requestBodyFor(_installId)['platform'], 'ANDROID');
      expect(oniOS.requestBodyFor(_installId)['platform'], 'IOS');
      for (final body in [onAndroid.requestBodyFor(_installId), oniOS.requestBodyFor(_installId)]) {
        expect(ContractSchemaChecker.problemsWith(body, registerInstallInput), isEmpty);
      }
    });

    test("reads Flutter's own platform by default", () {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      expect(registrationWith().requestBodyFor(_installId)['platform'], 'IOS');
    });

    test('an install id the app made passes the contract', () {
      final body = registrationWith().requestBodyFor(RandomUuid().generate());
      expect(ContractSchemaChecker.problemsWith(body, registerInstallInput), isEmpty);
    });
  });

  group('every answer the contract allows is read', () {
    final validAnswers = <String, (Map<String, Object?>, DateTime)>{
      'UTC with milliseconds': (
        {'install_token': _token, 'expires_at': '2026-11-07T12:00:00.000Z'},
        DateTime.utc(2026, 11, 7, 12),
      ),
      'UTC without a fraction': (
        {'install_token': _token, 'expires_at': '2026-11-07T12:00:00Z'},
        DateTime.utc(2026, 11, 7, 12),
      ),
      'an offset instead of Z': (
        {'install_token': _token, 'expires_at': '2026-11-07T14:00:00+02:00'},
        DateTime.utc(2026, 11, 7, 12),
      ),
      'nine decimal places': (
        {'install_token': _token, 'expires_at': '2026-11-07T12:00:00.123456789Z'},
        DateTime.utc(2026, 11, 7, 12, 0, 0, 123, 456),
      ),
      'a one-character token': (
        {'install_token': 'x', 'expires_at': '2026-11-07T12:00:00Z'},
        DateTime.utc(2026, 11, 7, 12),
      ),
      'a 1,024-character token': (
        {'install_token': 'a' * 1024, 'expires_at': '2026-11-07T12:00:00Z'},
        DateTime.utc(2026, 11, 7, 12),
      ),
    };

    for (final MapEntry(key: description, value: (answer, expiresAt)) in validAnswers.entries) {
      test(description, () async {
        expect(ContractSchemaChecker.problemsWith(answer, installRegistration), isEmpty);
        final result = await registerAnswering(answer);
        expect(result, isA<ListenerInstallRegistered>());
        final credentials = (result as ListenerInstallRegistered).credentials;
        expect(credentials.installId, _installId);
        expect(credentials.installToken, answer['install_token']);
        expect(credentials.tokenExpiresAt, expiresAt);
      });
    }

    test('an unknown field is ignored rather than refused (S4-D15)', () async {
      final answer = {
        'install_token': _token,
        'expires_at': '2026-11-07T12:00:00Z',
        'refresh_after': '2026-11-01T00:00:00Z',
      };
      // The schema forbids it today; a newer API that adds a field must not stop older apps.
      expect(ContractSchemaChecker.problemsWith(answer, installRegistration), isNotEmpty);
      expect(await registerAnswering(answer), isA<ListenerInstallRegistered>());
    });
  });

  group('an answer that breaks the contract is unreadable, never a token', () {
    final brokenAnswers = <String, Object?>{
      'no install_token': {'expires_at': '2026-11-07T12:00:00Z'},
      'install_token not text': {'install_token': 12345, 'expires_at': '2026-11-07T12:00:00Z'},
      'install_token empty': {'install_token': '', 'expires_at': '2026-11-07T12:00:00Z'},
      'install_token of 1,025 characters': {
        'install_token': 'a' * 1025,
        'expires_at': '2026-11-07T12:00:00Z',
      },
      'no expires_at': {'install_token': _token},
      'expires_at not text': {'install_token': _token, 'expires_at': 1786104000},
      'expires_at without a time zone': {
        'install_token': _token,
        'expires_at': '2026-11-07T12:00:00',
      },
      'expires_at a date only': {'install_token': _token, 'expires_at': '2026-11-07'},
      'expires_at on 30 February': {'install_token': _token, 'expires_at': '2026-02-30T12:00:00Z'},
      'a list instead of an object': [
        {'install_token': _token, 'expires_at': '2026-11-07T12:00:00Z'},
      ],
      'null': null,
    };

    for (final MapEntry(key: description, value: answer) in brokenAnswers.entries) {
      test(description, () async {
        expect(ContractSchemaChecker.problemsWith(answer, installRegistration), isNotEmpty);
        final result = await registerAnswering(answer);
        expect(
          result,
          isA<ListenerInstallNotRegistered>()
              .having((result) => result.isAnswerUnreadable, 'isAnswerUnreadable', isTrue)
              .having((result) => result.readingProblem, 'readingProblem', isNot(contains(_token))),
        );
      });
    }

    for (final unsendable in ['two words', 'line\r\nX-Forged: yes', 'tab\there', 'café']) {
      test('a token a bearer header cannot carry (${jsonEncode(unsendable)})', () async {
        // Allowed by the contract's length rule, refused because it would break the header.
        final answer = {'install_token': unsendable, 'expires_at': '2026-11-07T12:00:00Z'};
        expect(ContractSchemaChecker.problemsWith(answer, installRegistration), isEmpty);
        final result = await registerAnswering(answer);
        expect(
          result,
          isA<ListenerInstallNotRegistered>().having(
            (result) => result.isAnswerUnreadable,
            'isAnswerUnreadable',
            isTrue,
          ),
        );
      });
    }

    test('a body that is not JSON', () async {
      adapter.answerText(200, '<html>OK</html>');
      final result = await registrationWith().register(
        const ListenerInstallCredentials(installId: _installId),
      );
      expect(
        result,
        isA<ListenerInstallNotRegistered>().having(
          (result) => result.readingProblem,
          'readingProblem',
          'the body is not JSON',
        ),
      );
    });
  });

  group('a refusal or no answer is handed back for the same mapping as recognize answers', () {
    for (final status in [400, 403, 429, 500, 503]) {
      test('HTTP $status', () async {
        final result = await registerAnswering({
          'error': {'code': 'X', 'message': 'm', 'request_id': _installId},
        }, status: status);
        expect(result, isA<ListenerInstallNotRegistered>());
        final notRegistered = result as ListenerInstallNotRegistered;
        expect(notRegistered.isAnswerUnreadable, isFalse);
        expect(
          notRegistered.answer,
          isA<ApiAnswerReceived>().having((answer) => answer.status, 'status', status),
        );
      });
    }

    test('no answer', () async {
      adapter.failWithDioType(DioExceptionType.connectionTimeout);
      final result = await registrationWith().register(
        const ListenerInstallCredentials(installId: _installId),
      );
      expect(
        result,
        isA<ListenerInstallNotRegistered>().having(
          (result) => result.answer,
          'answer',
          isA<ApiAnswerNotReceived>(),
        ),
      );
    });
  });
}
