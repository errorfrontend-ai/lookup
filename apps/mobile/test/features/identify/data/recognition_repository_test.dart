import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate, SocketException;

import 'package:dio/dio.dart' show DioExceptionType, ResponseBody;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/configuration/app_version.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/listener_install/listener_install_registration.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/listener_install/listener_install_store.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/features/identify/data/recognition_repository.dart';
import 'package:lookup_listener/features/identify/data/recognize_request_builder.dart';
import 'package:lookup_listener/features/identify/data/recognize_response_parser.dart';
import 'package:lookup_listener/features/identify/domain/captured_clip.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';
import 'package:lookup_listener/features/identify/domain/recognition_answer.dart';
import 'package:lookup_listener/features/identify/domain/recognition_problem_report.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/example_app_configurations.dart';
import '../../../support/fake_clip_recorder.dart';
import '../../../support/fake_clock.dart';
import '../../../support/fake_http_client_adapter.dart';
import '../../../support/received_multipart_form.dart';
import '../../../support/recording_client_error_reporter.dart';

const String _installId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
const String _storedToken = 'stored.install.token';
const String _newToken = 'new.install.token';
const String _idempotencyKey = '3b9e7c1a-5d2f-4e8b-9a6c-1f0d2e3c4b5a';
const String _headerRequestId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const String _bodyRequestId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';

final RegExp _versionFourUuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

void main() {
  late FakeHttpClientAdapter adapter;
  late FakeClock clock;
  late RecordingClientErrorReporter reporter;
  late RecognitionRepository repository;

  final responseFixtures = ContractFixtures.readFolder('recognition/recognize-response/valid');
  final envelopeFixtures = ContractFixtures.readFolder('errors/envelopes');

  /// The repository as the app builds it, over the fake HTTP adapter and stored install values;
  /// production unless [configuration] replaces it.
  RecognitionRepository buildRepository({AppConfiguration? configuration}) {
    final randomUuid = RandomUuid();
    final apiClient = ApiClient(
      configuration: configuration ?? ExampleAppConfigurations.production(),
      randomUuid: randomUuid,
      clock: clock,
      httpClientAdapter: adapter,
    );
    return RecognitionRepository(
      apiClient: apiClient,
      listenerInstallRepository: ListenerInstallRepository(
        store: ListenerInstallStore(randomUuid: randomUuid),
        registration: ListenerInstallRegistration(apiClient: apiClient),
        randomUuid: randomUuid,
        clock: clock,
      ),
      clientErrorReporter: reporter,
      clock: clock,
    );
  }

  void storeInstall({String? token = _storedToken}) => SharedPreferences.setMockInitialValues({
    'listener_install_id': _installId,
    'listener_install_token': ?token,
    if (token != null)
      'listener_install_token_expires_at': clock
          .now()
          .add(const Duration(days: 30))
          .toIso8601String(),
    // Registered with the running version, as after any launch of this app (contract §1.1).
    if (token != null) 'listener_install_registered_app_version': AppVersion.current,
  });

  CapturedClip clip() => CapturedClip(
    audioBytes: FakeClipRecorder.m4aShapedClip(),
    idempotencyKey: _idempotencyKey,
    capturedAt: clock.now(),
    settings: ClipSettings.standard,
  );

  Future<RecognitionAnswer> sendOnce({bool registersAgainFirst = false}) => repository.send(
    clip(),
    cancellation: RecognitionCancellation(),
    registersAgainFirst: registersAgainFirst,
  );

  Map<String, Object?> registrationAnswer(String token) => {
    'install_token': token,
    'expires_at': clock.now().add(const Duration(days: 30)).toIso8601String(),
  };

  setUp(() {
    adapter = FakeHttpClientAdapter();
    clock = FakeClock();
    reporter = RecordingClientErrorReporter();
    storeInstall();
    repository = buildRepository();
  });

  test('the shared fixtures are found', () {
    expect(responseFixtures, isNotEmpty);
    expect(envelopeFixtures, hasLength(14));
  });

  group('one send', () {
    test(
      'posts the clip to recognize with the token as a bearer header and a new request id',
      () async {
        adapter.answerJson(200, (responseFixtures.first.content! as Map)['response']);
        await sendOnce();
        final request = adapter.requests.single;
        expect(request.method, 'POST');
        expect(request.address.toString(), 'https://api.lookup.invalid/api/v1/recognize');
        expect(request.header('Authorization'), 'Bearer $_storedToken');
        expect(request.header('X-Request-Id'), matches(_versionFourUuid));
        expect(request.address.query, isEmpty, reason: 'the token never goes in the address');
      },
    );

    test('the body is the request builder\'s, with sent_at taken at the send', () async {
      adapter.answerJson(200, (responseFixtures.first.content! as Map)['response']);
      final sentClip = clip();
      clock.advance(const Duration(seconds: 9));
      await repository.send(sentClip, cancellation: RecognitionCancellation());
      final form = ReceivedMultipartForm.of(adapter.requests.single);
      final expected = const RecognizeRequestBuilder().build(sentClip, sentAt: clock.now());
      expect(form.textFields.map((field) => '${field.key}=${field.value}'), [
        for (final field in expected.textFields) '${field.key}=${field.value}',
      ]);
      expect(form.fieldValues['sent_at'], '2026-10-08T12:00:09.000Z');
      expect(form.fieldValues['captured_at'], '2026-10-08T12:00:00.000Z');
      final audio = form.fileParts.single;
      expect(audio.fieldName, 'audio');
      expect(audio.fileName, 'clip.m4a');
      expect(audio.contentType, 'audio/mp4');
      expect(audio.bytes, sentClip.audioBytes);
      expect(
        adapter.requests.single.bodyBytes.length,
        lessThanOrEqualTo(32768),
        reason: 'an 8 s clip stays within 32 KB (S4-REQUEST-02)',
      );
    });

    test('two sends of one clip keep its idempotency key and get new request ids', () async {
      final busy = envelopeFixtures.firstWhere((fixture) => fixture.name == 'recognition-busy');
      adapter
        ..answerJson(503, (busy.content! as Map)['body'])
        ..answerJson(503, (busy.content! as Map)['body']);
      final sentClip = clip();
      await repository.send(sentClip, cancellation: RecognitionCancellation());
      clock.advance(const Duration(seconds: 10));
      await repository.send(sentClip, cancellation: RecognitionCancellation());
      final forms = adapter.requests.map(ReceivedMultipartForm.of).toList();
      expect(forms.map((form) => form.fieldValues['idempotency_key']).toSet(), {_idempotencyKey});
      expect(forms.map((form) => form.fieldValues['sent_at']).toSet(), hasLength(2));
      expect(
        adapter.requests.map((request) => request.header('X-Request-Id')).toSet(),
        hasLength(2),
      );
    });
  });

  group('answers, from the shared fixtures', () {
    for (final fixture in responseFixtures) {
      test('200 ${fixture.name} reads as the response parser reads it', () async {
        final body = (fixture.content! as Map<String, Object?>)['response'];
        adapter.answerJson(200, body);
        final answer = await sendOnce();
        final expected = const RecognizeResponseParser().read(httpStatus: 200, body: body);
        expect(answer.runtimeType, expected.runtimeType);
        expect((answer as ReceivedAnswer).apiRequestId, (expected as ReceivedAnswer).apiRequestId);
      });
    }

    for (final fixture in envelopeFixtures) {
      test('${fixture.name}: the status, code, Retry-After and API id pass through', () async {
        final content = fixture.content! as Map<String, Object?>;
        final httpStatus = content['http_status']! as int;
        final retryAfterSeconds = content['retry_after_seconds'] as int?;
        final envelope = (content['body']! as Map<String, Object?>)['error']! as Map;
        adapter.answerJson(
          httpStatus,
          content['body'],
          headers: {
            if (retryAfterSeconds != null) 'retry-after': ['$retryAfterSeconds'],
          },
        );
        final answer = await sendOnce();
        expect(answer, isA<ErrorStatusAnswer>());
        answer as ErrorStatusAnswer;
        expect(answer.httpStatus, httpStatus);
        expect(answer.errorCode, envelope['code']);
        expect(answer.retryAfterSeconds, retryAfterSeconds);
        expect(answer.apiRequestId, envelope['request_id']);
      });
    }
  });

  group('the API id of an answer (§3.8)', () {
    Map<String, Object?> internalEnvelope() =>
        (envelopeFixtures.firstWhere((fixture) => fixture.name == 'internal').content!
                as Map<String, Object?>)['body']!
            as Map<String, Object?>;

    test('is the X-Request-Id header when it is a UUID', () async {
      adapter.answerJson(
        500,
        internalEnvelope(),
        headers: {
          'x-request-id': [_headerRequestId],
        },
      );
      expect(((await sendOnce()) as ErrorStatusAnswer).apiRequestId, _headerRequestId);
    });

    test('is the body\'s request id when the header is missing or not a UUID', () async {
      adapter.answerJson(
        500,
        internalEnvelope(),
        headers: {
          'x-request-id': ['not-a-uuid'],
        },
      );
      expect(((await sendOnce()) as ErrorStatusAnswer).apiRequestId, _bodyRequestId);
    });

    test('is none for a proxy\'s error page, which has neither', () async {
      adapter.answerText(502, '<html><body>Bad gateway</body></html>');
      final answer = await sendOnce();
      expect(answer, isA<ErrorStatusAnswer>());
      expect((answer as ErrorStatusAnswer).httpStatus, 502);
      expect(answer.apiRequestId, isNull);
      expect(answer.errorCode, isNull);
    });

    test('a Retry-After date is turned into seconds from now', () async {
      adapter.answerJson(
        503,
        internalEnvelope(),
        headers: {
          'retry-after': [HttpDate.format(clock.now().add(const Duration(seconds: 20)))],
        },
      );
      expect(((await sendOnce()) as ErrorStatusAnswer).retryAfterSeconds, 20);
    });
  });

  group('no answer (S4-D12)', () {
    for (final type in [
      DioExceptionType.connectionTimeout,
      DioExceptionType.sendTimeout,
      DioExceptionType.receiveTimeout,
      DioExceptionType.connectionError,
      DioExceptionType.badCertificate,
    ]) {
      test('${type.name} is "no answer"', () async {
        adapter.failWithDioType(type);
        expect(await sendOnce(), isA<NoAnswer>());
      });
    }

    test('a socket failure is "no answer"', () async {
      adapter.failWith(const SocketException('network unreachable'));
      expect(await sendOnce(), isA<NoAnswer>());
    });

    test('a fault on the phone is a phone fault, not "no answer", by its type only', () async {
      adapter.failWith(StateError('secret detail'));
      final answer = await sendOnce();
      expect(answer, isA<PhoneFaultAnswer>());
      answer as PhoneFaultAnswer;
      expect(answer.problem, 'a fault in the app (StateError)');
      expect(answer.answeredRequest, AnsweredRequest.recognize);
    });

    test('plain http outside development is a phone fault, and nothing is sent', () async {
      repository = buildRepository(
        configuration: MisbuiltAppConfiguration(
          flavour: AppFlavour.production,
          apiBaseUrl: 'http://api.lookup.invalid/api/v1',
        ),
      );
      final answer = await sendOnce();
      expect(
        answer,
        isA<PhoneFaultAnswer>().having(
          (answer) => answer.problem,
          'problem',
          'the address is plain http outside the development flavour',
        ),
      );
      expect(adapter.requests, isEmpty);
    });

    test('cancelling a send in flight gives the cancelled answer (T28)', () async {
      adapter.waitUntilCancelled();
      final cancellation = RecognitionCancellation();
      final answer = repository.send(clip(), cancellation: cancellation);
      await pumpEventQueue();
      cancellation.cancel();
      expect(await answer, isA<CancelledAnswer>());
      cancellation.cancel();
      expect(cancellation.isCancelled, isTrue);
    });

    test('a send cancelled while registering never posts the clip', () async {
      storeInstall(token: null);
      repository = buildRepository();
      final release = Completer<void>();
      adapter.answerWith((request, cancelFuture) async {
        await release.future;
        return ResponseBody.fromString(jsonEncode(registrationAnswer(_newToken)), 200);
      });
      final cancellation = RecognitionCancellation();
      final answer = repository.send(clip(), cancellation: cancellation);
      await pumpEventQueue();
      cancellation.cancel();
      release.complete();
      expect(await answer, isA<CancelledAnswer>());
      expect(adapter.requests.map((request) => request.address.path), ['/api/v1/installs']);
    });
  });

  group('the install token (§3.9)', () {
    test('with no token stored, the install registers first, then sends with it (T15)', () async {
      storeInstall(token: null);
      repository = buildRepository();
      adapter
        ..answerJson(200, registrationAnswer(_newToken))
        ..answerJson(200, (responseFixtures.first.content! as Map)['response']);
      await sendOnce();
      expect(adapter.requests.map((request) => request.address.path), [
        '/api/v1/installs',
        '/api/v1/recognize',
      ]);
      expect((adapter.requests.first.jsonBody! as Map)['install_id'], _installId);
      expect(adapter.requests.last.header('Authorization'), 'Bearer $_newToken');
    });

    test('after a 401, the next send registers again with the same install id (T23)', () async {
      final refused = envelopeFixtures.firstWhere(
        (fixture) => fixture.name == 'install-token-invalid',
      );
      adapter
        ..answerJson(401, (refused.content! as Map)['body'])
        ..answerJson(200, registrationAnswer(_newToken))
        ..answerJson(200, (responseFixtures.first.content! as Map)['response']);
      expect(await sendOnce(), isA<ErrorStatusAnswer>());
      await sendOnce(registersAgainFirst: true);
      expect(adapter.requests.map((request) => request.address.path), [
        '/api/v1/recognize',
        '/api/v1/installs',
        '/api/v1/recognize',
      ]);
      expect((adapter.requests[1].jsonBody! as Map)['install_id'], _installId);
      expect(adapter.requests[0].header('Authorization'), 'Bearer $_storedToken');
      expect(adapter.requests[2].header('Authorization'), 'Bearer $_newToken');
      final keys = adapter.requests
          .where((request) => request.address.path.endsWith('recognize'))
          .map((request) => ReceivedMultipartForm.of(request).fieldValues['idempotency_key']);
      expect(keys.toSet(), {_idempotencyKey});
    });

    test('a registration with no answer is "no answer", and no clip is sent', () async {
      storeInstall(token: null);
      repository = buildRepository();
      adapter.failWithDioType(DioExceptionType.connectionError);
      expect(await sendOnce(), isA<NoAnswer>());
      expect(adapter.requests, hasLength(1));
    });

    test(
      'a registration stopped by a fault on the phone is a phone fault of the registration',
      () async {
        storeInstall(token: null);
        repository = buildRepository();
        adapter.failWith(StateError('secret detail'));
        final answer = await sendOnce();
        expect(answer, isA<PhoneFaultAnswer>());
        answer as PhoneFaultAnswer;
        expect(answer.answeredRequest, AnsweredRequest.installRegistration);
        expect(answer.problem, 'a fault in the app (StateError)');
        expect(adapter.requests, hasLength(1), reason: 'no clip is sent');
      },
    );

    test('a refused registration is marked as an answer to the registration', () async {
      storeInstall(token: null);
      repository = buildRepository();
      final refused = envelopeFixtures.firstWhere((fixture) => fixture.name == 'validation-failed');
      adapter.answerJson(400, (refused.content! as Map)['body']);
      final answer = await sendOnce();
      expect(answer, isA<ErrorStatusAnswer>());
      expect((answer as ErrorStatusAnswer).answeredRequest, AnsweredRequest.installRegistration);
      expect(answer.errorCode, 'VALIDATION_FAILED');
    });

    test('a registration refused for too many tries reads as 429 with its Retry-After', () async {
      storeInstall(token: null);
      repository = buildRepository();
      final rateLimited = envelopeFixtures.firstWhere((fixture) => fixture.name == 'rate-limited');
      adapter.answerJson(
        429,
        (rateLimited.content! as Map)['body'],
        headers: {
          'retry-after': ['42'],
        },
      );
      final answer = await sendOnce();
      expect(answer, isA<ErrorStatusAnswer>());
      expect((answer as ErrorStatusAnswer).httpStatus, 429);
      expect(answer.retryAfterSeconds, 42);
      expect(adapter.requests, hasLength(1));
    });

    test('a busy registration reads as busy', () async {
      storeInstall(token: null);
      repository = buildRepository();
      final busy = envelopeFixtures.firstWhere((fixture) => fixture.name == 'recognition-busy');
      adapter.answerJson(503, (busy.content! as Map)['body']);
      final answer = await sendOnce();
      expect((answer as ErrorStatusAnswer).httpStatus, 503);
    });

    test(
      'a 200 registration the app cannot read is an unreadable answer with its API id',
      () async {
        storeInstall(token: null);
        repository = buildRepository();
        adapter.answerJson(
          200,
          {'install_token': 7},
          headers: {
            'x-request-id': [_headerRequestId],
          },
        );
        final answer = await sendOnce();
        expect(answer, isA<UnreadableAnswer>());
        expect((answer as UnreadableAnswer).apiRequestId, _headerRequestId);
        expect(answer.answeredRequest, AnsweredRequest.installRegistration);
        expect(answer.problem, 'install_token is missing or not text');
      },
    );
  });

  group('crash reports', () {
    test('an answer problem is reported with its summary, related id and report id', () async {
      const report = RecognitionProblemReport(
        reportRequestId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        relatedRequestId: _bodyRequestId,
        summary: 'Recognize answer HTTP 400 VALIDATION_FAILED: the API refused what the app sent.',
      );
      await repository.reportAnswerProblem(report, location: '/identifying');
      final sent = reporter.reports.single;
      expect(sent.kind, ClientErrorKind.reported);
      expect(sent.error, report.summary);
      expect(sent.relatedRequestId, _bodyRequestId);
      expect(sent.reportRequestId, report.reportRequestId);
      expect(sent.location, '/identifying');
    });

    test('a phone failure is reported with the error, its stack and the report id', () async {
      reporter.outcome = const ClientErrorReportAccepted('1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d');
      final error = StateError('recorder failed');
      final stackTrace = StackTrace.current;
      final outcome = await repository.reportPhoneFailure(
        error: error,
        stackTrace: stackTrace,
        description: 'The recorder could not start',
        reportRequestId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        location: '/listening',
      );
      expect(outcome.isAccepted, isTrue);
      final sent = reporter.reports.single;
      expect(sent.kind, ClientErrorKind.reported);
      expect(sent.error, same(error));
      expect(sent.stackTrace, same(stackTrace));
      expect(sent.description, 'The recorder could not start');
      expect(sent.location, '/listening');
    });
  });
}
