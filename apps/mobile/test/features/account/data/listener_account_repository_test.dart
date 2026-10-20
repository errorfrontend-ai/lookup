import 'package:flutter_test/flutter_test.dart';
import 'dart:convert';

import 'package:dio/dio.dart' show DioExceptionType;
import 'package:lookup_listener/core/configuration/app_version.dart';
import 'package:lookup_listener/core/error_reporting/development_log.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/listener_install/listener_install_registration.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/listener_install/listener_install_store.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/features/account/domain/account_answer.dart';
import 'package:lookup_listener/features/account/data/listener_account_repository.dart';
import 'package:lookup_listener/features/account/domain/account_problem.dart';
import 'package:lookup_listener/features/account/domain/listener_gender.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/example_app_configurations.dart';
import '../../../support/fake_clock.dart';
import '../../../support/fake_http_client_adapter.dart';

const String _installId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
const String _storedToken = 'stored.install.token';
const String _newToken = 'new.install.token';

/// The calls to the listener-account routes (ADR-005; LA-APP-03 to -05, -10, -11): the token only in the header and
/// only on the account routes, one re-registration after a refused token, and no answer read as "no connection".
void main() {
  late FakeHttpClientAdapter adapter;
  late FakeClock clock;
  late ListenerAccountRepository repository;

  void storeInstall({String? token = _storedToken}) => SharedPreferences.setMockInitialValues({
    'listener_install_id': _installId,
    'listener_install_token': ?token,
    if (token != null) 'listener_install_token_expires_at': clock.now().add(const Duration(days: 30)).toIso8601String(),
    if (token != null) 'listener_install_registered_app_version': AppVersion.current,
  });

  ListenerAccountRepository build({List<String>? deviceLogLines}) {
    final randomUuid = RandomUuid();
    final configuration = deviceLogLines == null
        ? ExampleAppConfigurations.production()
        : ExampleAppConfigurations.development(writesVerboseLogs: true);
    final apiClient = ApiClient(
      configuration: configuration,
      randomUuid: randomUuid,
      clock: clock,
      developmentLog: deviceLogLines == null
          ? const DevelopmentLog.off()
          : DevelopmentLog(configuration: configuration, writeLine: deviceLogLines.add, clock: clock),
      httpClientAdapter: adapter,
    );
    return ListenerAccountRepository(
      apiClient: apiClient,
      listenerInstallRepository: ListenerInstallRepository(
        store: ListenerInstallStore(randomUuid: randomUuid),
        registration: ListenerInstallRegistration(apiClient: apiClient),
        randomUuid: randomUuid,
        clock: clock,
      ),
      clock: clock,
    );
  }

  Map<String, Object?> registrationAnswer(String token) => {
    'install_token': token,
    'expires_at': clock.now().add(const Duration(days: 30)).toIso8601String(),
  };

  setUp(() {
    adapter = FakeHttpClientAdapter();
    clock = FakeClock();
    storeInstall();
    repository = build();
  });

  test('asking for a code posts the email with the token in the header, and reads the 202', () async {
    adapter.answerJson(202, {'resend_after_seconds': 60});
    final answer = await repository.requestCode('listener@example.com');
    expect(answer, isA<AccountCodeSent>().having((sent) => sent.resendAfterSeconds, 'resendAfterSeconds', 60));
    final request = adapter.requests.single;
    expect(request.method, 'POST');
    expect(request.address.path, '/api/v1/listener-account/code');
    expect(request.jsonBody, {'email': 'listener@example.com'});
    expect(request.header('authorization'), 'Bearer $_storedToken');
  });

  test('checking a code posts the email and the code', () async {
    adapter.answerJson(200, {'status': 'DETAILS_NEEDED', 'ticket': 'T' * 54});
    final answer = await repository.verifyCode(email: 'listener@example.com', code: '042817');
    expect(answer, isA<AccountDetailsNeeded>());
    expect(adapter.requests.single.address.path, '/api/v1/listener-account/verify');
    expect(adapter.requests.single.jsonBody, {'email': 'listener@example.com', 'code': '042817'});
  });

  test('creating the account posts the contract\'s fields, the age as a number, and no other', () async {
    adapter.answerJson(201, {'status': 'SIGNED_IN', 'email_masked': 'l***@example.com'});
    final answer = await repository.createAccount(
      email: 'listener@example.com',
      ticket: 'T' * 54,
      gender: ListenerGender.preferNotToSay,
      age: 41,
      consentTextVersion: 'listener-consent-2026-10',
    );
    expect(answer, isA<AccountSignedIn>());
    expect(adapter.requests.single.address.path, '/api/v1/listener-account');
    expect(adapter.requests.single.jsonBody, {
      'email': 'listener@example.com',
      'ticket': 'T' * 54,
      'gender': 'PREFER_NOT_TO_SAY',
      'age': 41,
      'consent_text_version': 'listener-consent-2026-10',
    });
  });

  test('describing is a GET, signing out a POST with an empty body, and deleting a DELETE', () async {
    adapter.answerJson(200, {'is_signed_in': true, 'email_masked': 'l***@example.com'});
    adapter.answerText(204, '');
    adapter.answerText(204, '');
    expect(await repository.describe(), isA<AccountSummaryRead>());
    expect(await repository.signOut(), isA<AccountDone>());
    expect(await repository.deleteAccount(), isA<AccountDone>());
    expect([for (final request in adapter.requests) '${request.method} ${request.address.path}'], [
      'GET /api/v1/listener-account',
      'POST /api/v1/listener-account/sign-out',
      'DELETE /api/v1/listener-account',
    ]);
    for (final request in adapter.requests) {
      expect(request.header('authorization'), 'Bearer $_storedToken');
    }
  });

  test('with no token yet the install registers first, and the call carries the new token', () async {
    storeInstall(token: null);
    repository = build();
    adapter.answerJson(200, registrationAnswer(_newToken));
    adapter.answerJson(202, {'resend_after_seconds': 60});
    final answer = await repository.requestCode('listener@example.com');
    expect(answer, isA<AccountCodeSent>());
    expect([for (final request in adapter.requests) request.address.path], ['/api/v1/installs', '/api/v1/listener-account/code']);
    expect(adapter.requests.last.header('authorization'), 'Bearer $_newToken');
  });

  test('a refused token registers the install again, once, and asks again', () async {
    adapter.answerJson(401, _tokenRefusedBody());
    adapter.answerJson(200, registrationAnswer(_newToken));
    adapter.answerJson(202, {'resend_after_seconds': 60});
    final answer = await repository.requestCode('listener@example.com');
    expect(answer, isA<AccountCodeSent>());
    expect([for (final request in adapter.requests) request.address.path], [
      '/api/v1/listener-account/code',
      '/api/v1/installs',
      '/api/v1/listener-account/code',
    ]);
    expect(adapter.requests.last.header('authorization'), 'Bearer $_newToken');
  });

  test('a token refused again after registering is a failure, not a loop', () async {
    adapter.answerJson(401, _tokenRefusedBody());
    adapter.answerJson(200, registrationAnswer(_newToken));
    adapter.answerJson(401, _tokenRefusedBody());
    final answer = await repository.requestCode('listener@example.com');
    expect(answer, isA<AccountRefused>().having((refusal) => refusal.problem, 'problem', AccountProblem.serverFailure));
    expect(adapter.requests, hasLength(3));
  });

  test('LA-PRIVACY-04: with the device log on at its loudest, a whole account journey and its failures write no email, code, ticket, gender or age', () async {
    final lines = <String>[];
    repository = build(deviceLogLines: lines);
    adapter.answerJson(202, {'resend_after_seconds': 60});
    adapter.answerJson(200, {'status': 'DETAILS_NEEDED', 'ticket': 'T' * 54});
    adapter.answerJson(201, {'status': 'SIGNED_IN', 'email_masked': 'l***@example.com'});
    adapter.answerJson(400, {
      'error': {'code': 'VALIDATION_FAILED', 'message': 'x', 'request_id': '11111111-1111-4111-8111-111111111111'},
    });
    adapter.failWithDioType(DioExceptionType.receiveTimeout);
    adapter.answerJson(200, {'is_signed_in': true, 'email_masked': 'l***@example.com'});
    adapter.answerText(204, '');
    adapter.answerText(204, '');
    await repository.requestCode('listener@example.com');
    await repository.verifyCode(email: 'listener@example.com', code: '042817');
    await repository.createAccount(
      email: 'listener@example.com',
      ticket: 'T' * 54,
      gender: ListenerGender.preferNotToSay,
      age: 41,
      consentTextVersion: 'listener-consent-2026-10',
    );
    await repository.requestCode('another@example.com');
    await repository.verifyCode(email: 'listener@example.com', code: '999999');
    await repository.describe();
    await repository.signOut();
    await repository.deleteAccount();

    expect(lines, hasLength(8), reason: 'one line for each call, and the log really was on');
    for (final line in lines) {
      final decoded = jsonDecode(line) as Map<String, Object?>;
      expect(decoded.keys, everyElement(isIn({'time', 'event', 'method', 'path', 'status', 'durationMilliseconds', 'requestId', 'noAnswerReason'})));
      for (final personal in ['listener@example.com', 'another@example.com', '042817', '999999', 'T' * 54, 'PREFER_NOT_TO_SAY', 'gender', 'age', 'l***@example.com']) {
        expect(line, isNot(contains(personal)), reason: personal);
      }
    }
  });

  test('no answer is "no connection", and nothing is thrown', () async {
    adapter.failWithDioType(DioExceptionType.connectionError);
    final answer = await repository.describe();
    expect(answer, isA<AccountRefused>().having((refusal) => refusal.problem, 'problem', AccountProblem.noConnection));
  });

  test('a registration that finds no signal is "no connection" too', () async {
    storeInstall(token: null);
    repository = build();
    adapter.failWithDioType(DioExceptionType.connectionTimeout);
    final answer = await repository.requestCode('listener@example.com');
    expect(answer, isA<AccountRefused>().having((refusal) => refusal.problem, 'problem', AccountProblem.noConnection));
    expect(adapter.requests.map((request) => request.address.path), ['/api/v1/installs']);
  });
}

/// The API's answer to a token it does not accept, from the shared fixture.
Object? _tokenRefusedBody() => (ContractFixtures.readFile('errors/envelopes/install-token-invalid.json')! as Map<String, Object?>)['body'];
