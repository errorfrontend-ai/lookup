import 'dart:convert';
import 'dart:io' show FileSystemException;

import 'package:dio/dio.dart' show DioException, DioExceptionType, RequestOptions;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/listener_install/listener_install_credentials.dart';
import 'package:lookup_listener/core/network/api_client.dart';

import '../../features/identify/data/contract_schema_checker.dart';
import '../../support/example_app_configurations.dart';
import '../../support/fake_clock.dart';
import '../../support/fake_http_client_adapter.dart';
import '../../support/repository_file_locator.dart';

final RegExp _versionFourUuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

const String _installId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
const String _installToken = 'abc.def.ghi-short-parts';
const String _relatedRequestId = '0192a6c4-7e1f-7a2b-8c3d-4e5f6a7b8c9d';

/// An error whose own description fails.
class _UndescribableError implements Exception {
  @override
  String toString() => throw StateError('cannot describe');
}

void main() {
  final schema =
      jsonDecode(
            RepositoryFileLocator.file(
              'packages/contracts/schemas/client-error-report.schema.json',
            ).readAsStringSync(),
          )
          as Map<String, Object?>;
  late FakeHttpClientAdapter adapter;
  late FakeClock clock;

  setUp(() {
    adapter = FakeHttpClientAdapter();
    clock = FakeClock();
  });

  ClientErrorReporter reporterWith({
    Future<ListenerInstallCredentials?> Function()? readInstallCredentials,
    String appVersion = '0.1.0+1',
  }) => ClientErrorReporter(
    apiClient: ApiClient(
      configuration: ExampleAppConfigurations.production(),
      randomUuid: RandomUuid(),
      clock: clock,
      httpClientAdapter: adapter,
    ),
    readInstallCredentials: readInstallCredentials,
    clock: clock,
    appVersion: appVersion,
  );

  Map<String, Object?> sentBody([int index = 0]) =>
      adapter.requests[index].jsonBody as Map<String, Object?>;

  group('the report', () {
    test('fits the contract, from the listener app, with every field filled', () async {
      adapter.answerText(202, '');
      await reporterWith().report(
        kind: ClientErrorKind.reported,
        error: StateError('the clip file was empty'),
        stackTrace: StackTrace.current,
        location: '/listening',
        relatedRequestId: _relatedRequestId,
      );
      final body = sentBody();
      expect(ContractSchemaChecker.problemsWith(body, schema), isEmpty);
      expect(body['source'], 'listener-app');
      expect(body['kind'], 'reported');
      expect(body['message'], 'Bad state: the clip file was empty');
      expect(body['stack'], isA<String>());
      expect(body['location'], '/listening');
      expect(body['relatedRequestId'], _relatedRequestId);
      expect(body['appVersion'], '0.1.0+1');
      expect(adapter.requests.single.address.path, '/api/v1/client-errors');
    });

    test('every kind is sent by its contract name', () async {
      final reporter = reporterWith();
      for (final kind in ClientErrorKind.values) {
        adapter.answerText(202, '');
        await reporter.report(kind: kind, error: 'kind ${kind.name}');
      }
      expect(
        [for (var index = 0; index < adapter.requests.length; index++) sentBody(index)['kind']],
        ['render', 'uncaught', 'unhandled-rejection', 'reported'],
      );
      for (var index = 0; index < adapter.requests.length; index++) {
        expect(ContractSchemaChecker.problemsWith(sentBody(index), schema), isEmpty);
      }
    });

    test('carries its own new request id and never the install token', () async {
      adapter
        ..answerText(202, '')
        ..answerText(202, '');
      final reporter = reporterWith(
        readInstallCredentials: () async => ListenerInstallCredentials(
          installId: _installId,
          installToken: _installToken,
          tokenExpiresAt: DateTime.utc(2026, 11, 7),
        ),
      );
      final first = await reporter.report(kind: ClientErrorKind.uncaught, error: 'first');
      final second = await reporter.report(kind: ClientErrorKind.uncaught, error: 'second');
      final sentIds = [for (final request in adapter.requests) request.header('X-Request-Id')];
      expect(sentIds, everyElement(matches(_versionFourUuid)));
      expect(sentIds.toSet(), hasLength(2));
      expect((first as ClientErrorReportAccepted).reportRequestId, sentIds.first);
      expect((second as ClientErrorReportAccepted).reportRequestId, sentIds.last);
      for (final request in adapter.requests) {
        expect(request.hasHeader('Authorization'), isFalse);
        expect(request.bodyText, isNot(contains(_installToken)));
      }
    });

    test("uses the caller's own report id, so a phone failure's code can be made first", () async {
      adapter.answerText(202, '');
      final reportRequestId = RandomUuid().generate();
      final outcome = await reporterWith().report(
        kind: ClientErrorKind.reported,
        error: 'phone failure',
        reportRequestId: reportRequestId,
      );
      expect(adapter.requests.single.header('X-Request-Id'), reportRequestId);
      expect((outcome as ClientErrorReportAccepted).reportRequestId, reportRequestId);
    });

    test('a related request id that is not a UUID is left out rather than refused', () async {
      adapter.answerText(202, '');
      await reporterWith().report(
        kind: ClientErrorKind.reported,
        error: 'x',
        relatedRequestId: 'not-an-id',
      );
      expect(sentBody().containsKey('relatedRequestId'), isFalse);
    });

    test('the app\'s description comes first', () async {
      adapter.answerText(202, '');
      await reporterWith().report(
        kind: ClientErrorKind.reported,
        error: StateError('no bytes'),
        description: 'The recorder could not finish',
      );
      expect(sentBody()['message'], 'The recorder could not finish: Bad state: no bytes');
    });
  });

  group('limits', () {
    test('text is cut to the contract\'s limits and still fits it', () async {
      adapter.answerText(202, '');
      await reporterWith(appVersion: 'v' * 50).report(
        kind: ClientErrorKind.uncaught,
        error: 'm.' * 300,
        stackTrace: StackTrace.fromString('s ' * 5000),
        location: '/${'l' * 400}',
      );
      final body = sentBody();
      expect(ContractSchemaChecker.problemsWith(body, schema), isEmpty);
      expect((body['message']! as String).length, 500);
      expect((body['stack']! as String).length, lessThanOrEqualTo(8000));
      expect((body['location']! as String).length, lessThanOrEqualTo(300));
      expect((body['appVersion']! as String).length, lessThanOrEqualTo(40));
      expect(body['message'], endsWith(String.fromCharCode(0x2026)));
    });

    test('cutting never splits a character in two', () async {
      adapter.answerText(202, '');
      // 498 units of text, then emoji (two UTF-16 units each): the cut falls inside one.
      final grinningFace = String.fromCharCodes([0xD83D, 0xDE00]);
      await reporterWith().report(
        kind: ClientErrorKind.uncaught,
        error: '${'m.' * 249}${grinningFace * 10}',
      );
      final message = sentBody()['message']! as String;
      expect(message.length, lessThanOrEqualTo(500));
      final lastBeforeEllipsis = message.codeUnitAt(message.length - 2);
      expect(lastBeforeEllipsis >= 0xD800 && lastBeforeEllipsis <= 0xDBFF, isFalse);
      expect(utf8.encode(message), isNotEmpty);
    });

    test('an empty message is replaced, because the contract needs one', () async {
      adapter.answerText(202, '');
      await reporterWith().report(kind: ClientErrorKind.uncaught, error: '   ');
      expect(sentBody()['message'], ClientErrorReporter.undescribedMessage);
    });
  });

  group('scrubbed on the phone first (S4-ERRORREPORTING-05)', () {
    test('phone numbers, emails, tokens and query strings, in every text field', () async {
      adapter.answerText(202, '');
      await reporterWith().report(
        kind: ClientErrorKind.uncaught,
        error: 'Cannot call +260 977 123 456 for owner@station.example',
        stackTrace: StackTrace.fromString(
          '#0 open (https://api.example/x?token=abcdefghijklmnopqrstuvwxyz0123456789)',
        ),
        location: '/result?phone=0977123456#top',
      );
      final text = adapter.requests.single.bodyText;
      for (final personal in [
        '977',
        'owner@station.example',
        'abcdefghijklmnopqrstuvwxyz0123456789',
        'phone=',
      ]) {
        expect(text, isNot(contains(personal)));
      }
      expect(sentBody()['location'], '/result');
    });

    test('the stored install id and token become [install] and [token]', () async {
      adapter.answerText(202, '');
      await reporterWith(
        readInstallCredentials: () async => ListenerInstallCredentials(
          installId: _installId,
          installToken: _installToken,
          tokenExpiresAt: DateTime.utc(2026, 11, 7),
        ),
      ).report(
        kind: ClientErrorKind.uncaught,
        error: 'install $_installId sent $_installToken',
        stackTrace: StackTrace.fromString('#0 send ($_installToken)'),
      );
      final body = sentBody();
      expect(body['message'], 'install [install] sent [token]');
      expect(body['stack'], '#0 send ([token])');
    });

    test('when the secrets cannot be read, the report is still scrubbed and sent', () async {
      adapter.answerText(202, '');
      final outcome = await reporterWith(
        readInstallCredentials: () async => throw StateError('storage is broken'),
      ).report(kind: ClientErrorKind.uncaught, error: 'id $_installId');
      expect(outcome.isAccepted, isTrue);
      expect(sentBody()['message'], 'id [token]');
    });

    test("a FormatException's text is never used, only its type", () async {
      adapter.answerText(202, '');
      await reporterWith().report(
        kind: ClientErrorKind.reported,
        error: const FormatException(
          'Unexpected character in {"title":"Pizza Palace","phone":"+260977123456"}',
        ),
        description: 'The answer could not be read',
      );
      expect(
        sentBody()['message'],
        'The answer could not be read: FormatException (its text is not sent)',
      );
      expect(adapter.requests.single.bodyText, isNot(contains('Pizza')));
    });

    test("a DioException's text is never used, only its type", () async {
      adapter.answerText(202, '');
      await reporterWith().report(
        kind: ClientErrorKind.uncaught,
        error: DioException(
          requestOptions: RequestOptions(path: 'https://api.lookup.invalid/api/v1/recognize'),
          type: DioExceptionType.connectionTimeout,
          message: 'The request connection took longer than 0:00:15 for api.lookup.invalid',
        ),
      );
      expect(sentBody()['message'], 'DioException (its text is not sent)');
      expect(adapter.requests.single.bodyText, isNot(contains('api.lookup.invalid')));
    });
  });

  group('the outcome', () {
    test('is accepted only on 202', () async {
      final reporter = reporterWith();
      for (final status in [200, 201, 204, 400, 403, 429, 500, 503]) {
        adapter.answerText(status, '');
        final outcome = await reporter.report(kind: ClientErrorKind.uncaught, error: 'e$status');
        expect(outcome, isA<ClientErrorReportNotAccepted>(), reason: '$status');
      }
      adapter.answerText(202, '');
      expect(
        await reporter.report(kind: ClientErrorKind.uncaught, error: 'e202'),
        isA<ClientErrorReportAccepted>(),
      );
    });

    test('no answer is not accepted; with no outbox attached, nothing is kept', () async {
      adapter.failWithDioType(DioExceptionType.connectionError);
      final outcome = await reporterWith().report(kind: ClientErrorKind.uncaught, error: 'e');
      expect(outcome, isA<ClientErrorReportNotAccepted>());
      expect(adapter.unusedAnswerCount, 0);
    });
  });

  group('a report that gets no answer is kept to send later (P6 design §3.20; '
      'P6-ERRORREPORTING-05)', () {
    late List<({String reportId, DateTime occurredAt, Map<String, String> fields})> queued;

    ClientErrorReporter reporterWithQueue({Object? queueFailure}) => reporterWith()
      ..attachUnsentReportQueue(({required reportId, required occurredAt, required fields}) async {
        if (queueFailure != null) throw queueFailure;
        queued.add((reportId: reportId, occurredAt: occurredAt, fields: fields));
      });

    setUp(() => queued = []);

    for (final type in [
      DioExceptionType.connectionError,
      DioExceptionType.connectionTimeout,
      DioExceptionType.receiveTimeout,
    ]) {
      test('${type.name}: kept under the id it was sent with, the time it happened and its '
          'scrubbed fields; still not accepted, so no code is shown', () async {
        adapter.failWithDioType(type);
        final occurredAt = clock.now();
        const reportId = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
        final outcome = await reporterWithQueue().report(
          kind: ClientErrorKind.reported,
          error: 'Saving the result to History failed for +44 7700 900123',
          reportRequestId: reportId,
          location: '/r/0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70?from=notification',
        );

        expect(outcome, isA<ClientErrorReportNotAccepted>());
        final kept = queued.single;
        expect(kept.reportId, reportId);
        expect(kept.occurredAt, occurredAt);
        expect(kept.fields['kind'], 'reported');
        expect(kept.fields['source'], 'listener-app');
        expect(kept.fields['message'], isNot(contains('7700 900123')));
        expect(kept.fields['location'], isNot(contains('from=notification')));
        expect(kept.fields.containsKey('occurredAt'), isFalse, reason: 'added when it is sent');
      });
    }

    test('an answer, even a refusal, is never kept for later', () async {
      final reporter = reporterWithQueue();
      for (final status in [400, 429, 500, 503]) {
        adapter.answerText(status, '');
        await reporter.report(kind: ClientErrorKind.uncaught, error: 'e$status');
      }
      expect(queued, isEmpty);
    });

    test('an outbox that cannot keep it loses it quietly: report() still never throws', () async {
      adapter.failWithDioType(DioExceptionType.connectionError);
      final outcome = await reporterWithQueue(
        queueFailure: const FileSystemException('The phone is full'),
      ).report(kind: ClientErrorKind.uncaught, error: 'e');
      expect(outcome, isA<ClientErrorReportNotAccepted>());
    });
  });

  group('never throws', () {
    test('when the error cannot even describe itself', () async {
      adapter.answerText(202, '');
      final outcome = await reporterWith().report(
        kind: ClientErrorKind.uncaught,
        error: _UndescribableError(),
      );
      expect(outcome.isAccepted, isTrue);
      expect(sentBody()['message'], '_UndescribableError');
    });

    test('when sending fails on the phone', () async {
      adapter.failWith(StateError('the transport is broken'));
      expect(
        await reporterWith().report(kind: ClientErrorKind.uncaught, error: 'e'),
        isA<ClientErrorReportNotAccepted>(),
      );
    });

    test('when the configuration would refuse every request', () async {
      final reporter = ClientErrorReporter(
        apiClient: ApiClient(
          configuration: MisbuiltAppConfiguration(
            flavour: ExampleAppConfigurations.production().flavour,
            apiBaseUrl: 'http://api.lookup.invalid/api/v1',
          ),
          randomUuid: RandomUuid(),
          httpClientAdapter: adapter,
        ),
      );
      expect(
        await reporter.report(kind: ClientErrorKind.uncaught, error: 'e'),
        isA<ClientErrorReportNotAccepted>(),
      );
      expect(adapter.requests, isEmpty);
    });
  });

  group('how often', () {
    test('the same error is sent once a minute at most', () async {
      final reporter = reporterWith();
      final stack = StackTrace.fromString('#0 record (recorder.dart:10)\n#1 main');
      adapter
        ..answerText(202, '')
        ..answerText(202, '');
      Future<ClientErrorReportOutcome> sameError() =>
          reporter.report(kind: ClientErrorKind.uncaught, error: 'boom', stackTrace: stack);

      expect(await sameError(), isA<ClientErrorReportAccepted>());
      expect(await sameError(), isA<ClientErrorReportHeldBack>());
      clock.advance(const Duration(seconds: 59));
      expect(await sameError(), isA<ClientErrorReportHeldBack>());
      clock.advance(const Duration(seconds: 1));
      expect(await sameError(), isA<ClientErrorReportAccepted>());
      expect(adapter.requests, hasLength(2));
    });

    test('the same message from another place counts as another error', () async {
      final reporter = reporterWith();
      adapter
        ..answerText(202, '')
        ..answerText(202, '');
      await reporter.report(
        kind: ClientErrorKind.uncaught,
        error: 'boom',
        stackTrace: StackTrace.fromString('#0 first (a.dart:1)'),
      );
      await reporter.report(
        kind: ClientErrorKind.uncaught,
        error: 'boom',
        stackTrace: StackTrace.fromString('#0 second (b.dart:2)'),
      );
      expect(adapter.requests, hasLength(2));
    });

    test(
      'at most 10 reports a minute leave the phone, even when made at the same moment',
      () async {
        final reporter = reporterWith();
        for (var answer = 0; answer < 11; answer++) {
          adapter.answerText(202, '');
        }
        final outcomes = await Future.wait([
          for (var error = 0; error < 12; error++)
            reporter.report(kind: ClientErrorKind.uncaught, error: 'error number $error'),
        ]);
        expect(outcomes.whereType<ClientErrorReportAccepted>(), hasLength(10));
        expect(outcomes.whereType<ClientErrorReportHeldBack>(), hasLength(2));
        expect(adapter.requests, hasLength(10));

        clock.advance(const Duration(minutes: 1));
        expect(
          await reporter.report(kind: ClientErrorKind.uncaught, error: 'a new minute'),
          isA<ClientErrorReportAccepted>(),
        );
      },
    );
  });
}
