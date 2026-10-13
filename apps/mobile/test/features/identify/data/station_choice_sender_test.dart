import 'dart:convert';

import 'package:dio/dio.dart' show DioExceptionType;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/outbox/outbox_send_answer.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/features/identify/data/station_choice_sender.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/example_app_configurations.dart';
import '../../../support/fake_clock.dart';
import '../../../support/fake_http_client_adapter.dart';
import '../../../support/repository_file_locator.dart';
import 'contract_schema_checker.dart';

const String _recognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';
const String _stationBId = '0192a6c4-1111-4000-8000-000000000002';
const String _apiRequestId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';

StationChoiceItem _choice({String stationId = _stationBId}) => StationChoiceItem(
  itemId: '0f1e2d3c-4b5a-4968-8776-655443322110',
  queuedAt: DateTime.utc(2026, 10, 8, 12),
  recognitionId: _recognitionId,
  stationId: stationId,
);

/// The station choice as the outbox sends it (contract §1.3; P6 design §3.9, §4.4).
void main() {
  final schema =
      jsonDecode(
            RepositoryFileLocator.file(
              'packages/contracts/schemas/recognition-station-choice-input.schema.json',
            ).readAsStringSync(),
          )
          as Map<String, Object?>;
  final validFixtures = ContractFixtures.readFolder('recognition/station-choice-input/valid');
  final invalidFixtures = ContractFixtures.readFolder('recognition/station-choice-input/invalid');
  Object? bodyOf(NamedFixture fixture) => (fixture.content as Map<String, Object?>)['body'];

  late FakeHttpClientAdapter adapter;
  late StationChoiceSender sender;

  setUp(() {
    adapter = FakeHttpClientAdapter();
    sender = StationChoiceSender(
      apiClient: ApiClient(
        configuration: ExampleAppConfigurations.production(),
        randomUuid: RandomUuid(),
        clock: FakeClock(),
        httpClientAdapter: adapter,
      ),
      clock: FakeClock(),
    );
  });

  test('the loader finds the one valid and four invalid choice bodies', () {
    expect(validFixtures.map((fixture) => fixture.name), ['choose-station-b']);
    expect(invalidFixtures.map((fixture) => fixture.name), [
      'missing-station-id',
      'recognition-id-in-body',
      'remember-flag-in-body',
      'station-id-not-a-uuid',
    ]);
  });

  test('the schema checker passes the valid body and refuses each invalid one, so it can fail', () {
    expect(ContractSchemaChecker.problemsWith(bodyOf(validFixtures.single), schema), isEmpty);
    for (final fixture in invalidFixtures) {
      expect(
        ContractSchemaChecker.problemsWith(bodyOf(fixture), schema),
        isNotEmpty,
        reason: fixture.name,
      );
    }
  });

  test('the body is exactly choose-station-b.json and passes the emitted schema: the station, and '
      'neither the recognition nor the "Remember" tick', () {
    final body = StationChoiceSender.bodyFor(_choice());
    expect(body, bodyOf(validFixtures.single));
    expect(ContractSchemaChecker.problemsWith(body, schema), isEmpty);
    expect(body.keys, ['station_id']);
  });

  test('it posts to recognitions/{id}/choice with the token, a new request id each time, and the '
      'same body each time', () async {
    adapter
      ..answerText(204, '')
      ..answerText(204, '');
    await sender.send(_choice(), installToken: 'stored.install.token');
    await sender.send(_choice(), installToken: 'stored.install.token');

    expect(adapter.requests.map((request) => request.address.toString()).toSet(), {
      'https://api.lookup.invalid/api/v1/recognitions/$_recognitionId/choice',
    });
    for (final request in adapter.requests) {
      expect(request.method, 'POST');
      expect(request.header('Authorization'), 'Bearer stored.install.token');
      expect(request.header('Content-Type'), startsWith('application/json'));
      expect(request.jsonBody, {'station_id': _stationBId});
    }
    expect(adapter.requests.map((request) => request.header('X-Request-Id')).toSet(), hasLength(2));
  });

  group('what came back', () {
    test('204: the status, with no code', () async {
      adapter.answerText(
        204,
        '',
        headers: {
          'x-request-id': [_apiRequestId],
        },
      );
      final answer = await sender.send(_choice(), installToken: 'token') as OutboxHttpAnswer;
      expect(answer.httpStatus, 204);
      expect(answer.errorCode, isNull);
      expect(answer.apiRequestId, _apiRequestId);
    });

    test('an error envelope: its status, code and request id, never its message', () async {
      final envelope =
          (ContractFixtures.readFile('errors/envelopes/station-already-chosen.json')!
              as Map<String, Object?>);
      adapter.answerJson(envelope['http_status']! as int, envelope['body']);
      final answer = await sender.send(_choice(), installToken: 'token') as OutboxHttpAnswer;
      final error = (envelope['body']! as Map<String, Object?>)['error']! as Map<String, Object?>;
      expect(answer.httpStatus, 422);
      expect(answer.errorCode, 'STATION_ALREADY_CHOSEN');
      expect(answer.apiRequestId, error['request_id']);
      expect(answer.toString(), isNot(contains(error['message']! as String)));
    });

    test('a busy answer: its Retry-After in seconds', () async {
      adapter.answerJson(
        503,
        {
          'error': {'code': 'SERVICE_UNAVAILABLE', 'message': 'x', 'request_id': _apiRequestId},
        },
        headers: {
          'retry-after': ['6'],
        },
      );
      final answer = await sender.send(_choice(), installToken: 'token') as OutboxHttpAnswer;
      expect(answer.retryAfterSeconds, 6);
    });

    test('no answer over the network is no answer', () async {
      adapter.failWithDioType(DioExceptionType.connectionTimeout);
      expect(await sender.send(_choice(), installToken: 'token'), isA<OutboxNoAnswer>());
    });

    test('a request the phone itself refuses (plain http outside development) is a phone fault, '
        'and nothing is sent', () async {
      final refusing = StationChoiceSender(
        apiClient: ApiClient(
          configuration: MisbuiltAppConfiguration(
            flavour: AppFlavour.production,
            apiBaseUrl: 'http://api.lookup.invalid/api/v1',
          ),
          randomUuid: RandomUuid(),
          httpClientAdapter: adapter,
        ),
      );
      expect(await refusing.send(_choice(), installToken: 'token'), isA<OutboxPhoneFault>());
      expect(adapter.requests, isEmpty);
    });
  });
}
