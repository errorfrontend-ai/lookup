import 'dart:async';
import 'dart:convert';
import 'dart:io' show HandshakeException, HttpException, SocketException;
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/error_reporting/development_log.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/features/identify/data/recognize_request_builder.dart';
import 'package:lookup_listener/features/identify/domain/captured_clip.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';

import '../../support/example_app_configurations.dart';
import '../../support/fake_clock.dart';
import '../../support/fake_http_client_adapter.dart';

/// A version-4 UUID exactly, as the app makes request ids (S4-D9).
final RegExp _versionFourUuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

const String _installToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

/// The multipart line break, carriage return and line feed, by code.
final String _lineBreak = String.fromCharCodes(const [13, 10]);

/// Text that must never travel out of the client in an answer.
const String _technicalDetail = 'SocketException: secret detail at package:dio/src/x.dart';

ApiClient _clientFor(
  FakeHttpClientAdapter adapter, {
  AppConfiguration? configuration,
  DevelopmentLog developmentLog = const DevelopmentLog.off(),
  FakeClock? clock,
}) => ApiClient(
  configuration: configuration ?? ExampleAppConfigurations.production(),
  randomUuid: RandomUuid(),
  clock: clock ?? FakeClock(),
  developmentLog: developmentLog,
  httpClientAdapter: adapter,
);

ApiMultipartFile _audio(List<int> bytes) => ApiMultipartFile(
  fieldName: 'audio',
  fileName: 'clip.m4a',
  contentType: 'audio/mp4',
  bytes: bytes,
);

void main() {
  late FakeHttpClientAdapter adapter;

  setUp(() => adapter = FakeHttpClientAdapter());

  group('every request', () {
    test('goes to the configured base address with the relative path, as POST', () async {
      adapter.answerJson(200, {'ok': true});
      await _clientFor(adapter).postJson('installs', {'a': 'b'});
      final request = adapter.requests.single;
      expect(request.method, 'POST');
      expect(request.address.toString(), 'https://api.lookup.invalid/api/v1/installs');
    });

    test('carries a version-4 X-Request-Id, and the answer says which', () async {
      adapter.answerJson(200, {'ok': true});
      final answer = await _clientFor(adapter).postJson('installs', {'a': 'b'});
      final sentId = adapter.requests.single.header('X-Request-Id');
      expect(sentId, matches(_versionFourUuid));
      expect(answer.sentRequestId, sentId);
    });

    test('gets a new request id on every attempt, retries included', () async {
      final client = _clientFor(adapter);
      for (var attempt = 0; attempt < 5; attempt++) {
        adapter.answerJson(503, {'error': <String, Object?>{}});
      }
      final answers = [
        for (var attempt = 0; attempt < 5; attempt++) await client.postJson('recognize', {}),
      ];
      final sentIds = adapter.requests.map((request) => request.header('X-Request-Id')).toSet();
      expect(sentIds, hasLength(5));
      expect(answers.map((answer) => answer.sentRequestId).toSet(), sentIds);
    });

    test('knows its request id even when no answer comes', () async {
      adapter.failWithDioType(DioExceptionType.connectionError);
      final answer = await _clientFor(adapter).postJson('installs', {});
      expect(answer, isA<ApiAnswerNotReceived>());
      expect(answer.sentRequestId, adapter.requests.single.header('X-Request-Id'));
      expect(answer.sentRequestId, matches(_versionFourUuid));
    });

    test("uses a caller's own fresh version-4 id, and replaces anything else", () async {
      final client = _clientFor(adapter);
      const ownId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
      for (var attempt = 0; attempt < 4; attempt++) {
        adapter.answerText(202, '');
      }
      expect((await client.postJson('client-errors', {}, requestId: ownId)).sentRequestId, ownId);
      for (final unusable in [
        'not-a-uuid',
        '6F1C2D3E-4B5A-4C7D-9E8F-0A1B2C3D4E5F',
        '0192a6c4-7e1f-7a2b-8c3d-4e5f6a7b8c9d',
      ]) {
        final answer = await client.postJson('client-errors', {}, requestId: unusable);
        expect(answer.sentRequestId, isNot(unusable));
        expect(answer.sentRequestId, matches(_versionFourUuid));
      }
      expect(adapter.requests.map((request) => request.header('X-Request-Id')).first, ownId);
    });

    test('asks for JSON and sends JSON bodies as JSON', () async {
      adapter.answerJson(200, {});
      await _clientFor(
        adapter,
      ).postJson('installs', {'install_id': 'x', 'platform': 'ANDROID', 'app_version': '0.1.0+1'});
      final request = adapter.requests.single;
      expect(request.header('Accept'), 'application/json');
      expect(request.header('Content-Type'), startsWith('application/json'));
      expect(request.jsonBody, {
        'install_id': 'x',
        'platform': 'ANDROID',
        'app_version': '0.1.0+1',
      });
    });

    test('does not follow redirects, so https can never be led to http', () async {
      adapter.answerText(
        302,
        '',
        headers: {
          'location': ['http://api.lookup.invalid/api/v1/installs'],
        },
      );
      final answer = await _clientFor(adapter).postJson('installs', {});
      expect(adapter.requests.single.options.followRedirects, isFalse);
      expect(answer, isA<ApiAnswerReceived>().having((answer) => answer.status, 'status', 302));
    });

    test('sets the timeouts: connect 15 s, send 30 s, receive 15 s (S4-D12)', () async {
      adapter.answerJson(200, {});
      await _clientFor(adapter).postJson('installs', {});
      final options = adapter.requests.single.options;
      expect(options.connectTimeout, const Duration(seconds: 15));
      expect(options.sendTimeout, const Duration(seconds: 30));
      expect(options.receiveTimeout, const Duration(seconds: 15));
      expect(ApiClient.connectTimeout, const Duration(seconds: 15));
      expect(ApiClient.sendTimeout, const Duration(seconds: 30));
      expect(ApiClient.receiveTimeout, const Duration(seconds: 15));
    });
  });

  group('the install token', () {
    test('goes to the recognize route as a bearer header', () async {
      adapter.answerJson(200, {});
      await _clientFor(adapter).postMultipart(
        'recognize',
        fields: const [MapEntry('codec', 'aac')],
        file: _audio([1, 2, 3]),
        installToken: _installToken,
      );
      final request = adapter.requests.single;
      expect(request.header('Authorization'), 'Bearer $_installToken');
      expect(request.address.toString(), isNot(contains(_installToken)));
      expect(latin1.decode(request.bodyBytes), isNot(contains(_installToken)));
    });

    test('never goes to /installs or /client-errors, even when a caller passes it', () async {
      final client = _clientFor(adapter);
      for (final path in ['installs', 'client-errors']) {
        adapter.answerJson(200, {});
        await client.postJson(path, {'a': 'b'}, installToken: _installToken);
      }
      for (final request in adapter.requests) {
        expect(request.hasHeader('Authorization'), isFalse, reason: '${request.address}');
        expect(request.bodyText, isNot(contains(_installToken)));
      }
    });

    test('is not sent when none is given', () async {
      adapter.answerJson(200, {});
      await _clientFor(adapter).postMultipart('recognize', fields: const [], file: _audio([1]));
      expect(adapter.requests.single.hasHeader('Authorization'), isFalse);
    });
  });

  group('plain http (S4-D25)', () {
    test('is sent in the development flavour, to the emulator address', () async {
      adapter.answerJson(200, {});
      final answer = await _clientFor(
        adapter,
        configuration: ExampleAppConfigurations.development(),
      ).postJson('installs', {});
      expect(answer, isA<ApiAnswerReceived>());
      expect(adapter.requests.single.address.toString(), 'http://10.0.2.2:3100/api/v1/installs');
    });

    test('https is sent in every flavour', () async {
      for (final configuration in [
        ExampleAppConfigurations.developmentOverHttps(),
        ExampleAppConfigurations.staging(),
        ExampleAppConfigurations.production(),
      ]) {
        adapter.answerJson(200, {});
        final answer = await _clientFor(
          adapter,
          configuration: configuration,
        ).postJson('installs', {});
        expect(answer, isA<ApiAnswerReceived>(), reason: configuration.flavour.name);
      }
      expect(adapter.requests, hasLength(3));
    });

    for (final flavour in [AppFlavour.staging, AppFlavour.production]) {
      test('is refused in ${flavour.name}, and nothing at all is sent', () async {
        adapter.answerJson(200, {});
        final client = _clientFor(
          adapter,
          configuration: MisbuiltAppConfiguration(
            flavour: flavour,
            apiBaseUrl: 'http://api.lookup.invalid/api/v1',
          ),
        );
        final json = await client.postJson('installs', {'install_id': 'x'});
        final multipart = await client.postMultipart(
          'recognize',
          fields: const [MapEntry('codec', 'aac')],
          file: _audio([1, 2, 3]),
          installToken: _installToken,
        );
        for (final answer in [json, multipart]) {
          expect(
            answer,
            isA<ApiAnswerNotReceived>().having(
              (answer) => answer.reason,
              'reason',
              ApiNoAnswerReason.plainHttpRefused,
            ),
          );
        }
        expect(adapter.requests, isEmpty);
      });
    }

    test('no other scheme is ever sent, even in development', () async {
      final answer = await _clientFor(
        adapter,
        configuration: MisbuiltAppConfiguration(
          flavour: AppFlavour.development,
          apiBaseUrl: 'ftp://10.0.2.2/api/v1',
        ),
      ).postJson('installs', {});
      expect(answer, isA<ApiAnswerNotReceived>());
      expect(adapter.requests, isEmpty);
    });
  });

  test('a path that is not a plain relative path is never sent', () async {
    final client = _clientFor(adapter);
    for (final path in [
      '/installs',
      'https://other.example/steal',
      '//other.example/steal',
      '../admin',
      'installs?token=x',
      'installs#x',
      '',
    ]) {
      final answer = await client.postJson(path, {});
      expect(
        answer,
        isA<ApiAnswerNotReceived>().having(
          (answer) => answer.reason,
          'reason',
          ApiNoAnswerReason.unexpectedFailure,
        ),
        reason: path,
      );
    }
    expect(adapter.requests, isEmpty);
  });

  group('multipart sending', () {
    test(
      'sends the text fields first, in order, then the file part with its name and type',
      () async {
        final audioBytes = Uint8List.fromList([
          0x00,
          0x00,
          0x00,
          0x18,
          0x66,
          0x74,
          0x79,
          0x70,
          0xff,
        ]);
        adapter.answerJson(200, {});
        await _clientFor(adapter).postMultipart(
          'recognize',
          fields: const [
            MapEntry('clip_duration_milliseconds', '8000'),
            MapEntry('codec', 'aac'),
            MapEntry('is_deferred', 'false'),
          ],
          file: _audio(audioBytes),
        );
        final request = adapter.requests.single;
        expect(request.header('Content-Type'), startsWith('multipart/form-data; boundary='));
        final body = latin1.decode(request.bodyBytes);
        final positions = [
          for (final name in ['clip_duration_milliseconds', 'codec', 'is_deferred', 'audio'])
            body.indexOf('name="$name"'),
        ];
        expect(positions, everyElement(greaterThanOrEqualTo(0)));
        expect(positions, orderedEquals([...positions]..sort()));
        final audioHeader = body.substring(positions.last);
        expect(audioHeader, startsWith('name="audio"; filename="clip.m4a"'));
        expect(audioHeader, contains('content-type: audio/mp4'));
        expect(
          body,
          contains(
            'name="clip_duration_milliseconds"$_lineBreak$_lineBreak'
            '8000',
          ),
        );
        expect(_indexOfBytes(request.bodyBytes, audioBytes), greaterThan(positions.last));
      },
    );

    test('a whole 8-second recognize request stays within 32,768 bytes (S4-REQUEST-02)', () async {
      // 24 kbit/s for 8 s is 24,000 bytes of audio; 26,000 allows for the MP4 header and more.
      final clip = CapturedClip(
        audioBytes: List<int>.generate(26000, (index) => index % 251),
        idempotencyKey: RandomUuid().generate(),
        capturedAt: DateTime.utc(2026, 10, 8, 9, 15, 2, 123),
        settings: ClipSettings.standard,
      );
      final parts = const RecognizeRequestBuilder().build(
        clip,
        sentAt: DateTime.utc(2026, 10, 8, 9, 15, 11, 456),
      );
      adapter.answerJson(200, {});
      await _clientFor(adapter).postMultipart(
        'recognize',
        fields: parts.textFields,
        file: ApiMultipartFile(
          fieldName: parts.audioPart.fieldName,
          fileName: parts.audioPart.fileName,
          contentType: parts.audioPart.contentType,
          bytes: parts.audioPart.bytes,
        ),
        installToken: _installToken,
      );
      final request = adapter.requests.single;
      expect(request.bodyBytes.length, lessThanOrEqualTo(32768));
      expect(request.bodyBytes.length, greaterThan(26000));
      expect(request.header('content-length'), '${request.bodyBytes.length}');
    });

    test('a file type that cannot be read is a fault on the phone, and nothing is sent', () async {
      final answer = await _clientFor(adapter).postMultipart(
        'recognize',
        fields: const [],
        file: const ApiMultipartFile(
          fieldName: 'audio',
          fileName: 'clip.m4a',
          contentType: 'not a type',
          bytes: [1],
        ),
      );
      expect(
        answer,
        isA<ApiAnswerNotReceived>().having(
          (answer) => answer.reason,
          'reason',
          ApiNoAnswerReason.unexpectedFailure,
        ),
      );
      expect(adapter.requests, isEmpty);
    });
  });

  group('answers are read by the app, never by Dio', () {
    test('every status comes back as an answer, never as an exception', () async {
      final client = _clientFor(adapter);
      for (final status in [200, 202, 301, 400, 401, 403, 404, 409, 413, 422, 426, 429, 500, 503]) {
        adapter.answerJson(status, {'status': 'x'});
        final answer = await client.postJson('recognize', {});
        expect(
          answer,
          isA<ApiAnswerReceived>().having((answer) => answer.status, 'status', status),
        );
      }
    });

    test('a JSON body is decoded, with the echoed request id and the raw Retry-After', () async {
      const echoedId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
      final envelope = {
        'error': {'code': 'RECOGNITION_BUSY', 'message': 'Busy.', 'request_id': echoedId},
      };
      adapter.answerJson(
        503,
        envelope,
        headers: {
          'x-request-id': [echoedId],
          'retry-after': ['12'],
        },
      );
      final answer = await _clientFor(adapter).postJson('recognize', {}) as ApiAnswerReceived;
      expect(answer.status, 503);
      expect(answer.echoedRequestId, echoedId);
      expect(answer.retryAfter, '12');
      expect(answer.body, isA<JsonAnswerBody>().having((body) => body.value, 'value', envelope));
    });

    test('headers it does not get, or gets twice, are null', () async {
      adapter
        ..answerJson(200, {})
        ..answerJson(
          503,
          {},
          headers: {
            'x-request-id': ['a', 'b'],
            'retry-after': ['1', '2'],
          },
        );
      final client = _clientFor(adapter);
      for (var attempt = 0; attempt < 2; attempt++) {
        final answer = await client.postJson('recognize', {}) as ApiAnswerReceived;
        expect(answer.echoedRequestId, isNull);
        expect(answer.retryAfter, isNull);
      }
    });

    test('a body that is not JSON is marked so, whatever it holds', () async {
      adapter
        ..answerText(
          502,
          '<html><body>502 Bad Gateway</body></html>',
          headers: {
            'content-type': ['text/html'],
          },
        )
        ..answerText(200, '')
        ..answerText(
          200,
          '{"status": "MATCH", "result":',
          headers: {
            'content-type': ['application/json'],
          },
        )
        ..answerBytes(200, [0xff, 0xfe, 0x7b, 0x7d, 0xc3]);
      final client = _clientFor(adapter);
      for (var attempt = 0; attempt < 4; attempt++) {
        final answer = await client.postJson('recognize', {});
        expect(
          answer,
          isA<ApiAnswerReceived>().having(
            (answer) => answer.body,
            'body',
            isA<NotJsonAnswerBody>(),
          ),
        );
      }
    });

    test('JSON is read from the text whatever the content type says', () async {
      adapter.answerText(
        200,
        '{"status":"NO_MATCH"}',
        headers: {
          'content-type': ['text/plain'],
        },
      );
      final answer = await _clientFor(adapter).postJson('recognize', {}) as ApiAnswerReceived;
      expect(answer.body, isA<JsonAnswerBody>());
    });
  });

  group('no answer: every failure to get one is "no answer", and nothing is thrown', () {
    final cases = <String, (void Function(FakeHttpClientAdapter), ApiNoAnswerReason)>{
      'a connect timeout': (
        (adapter) => adapter.failWithDioType(DioExceptionType.connectionTimeout),
        ApiNoAnswerReason.timedOut,
      ),
      'a send timeout': (
        (adapter) => adapter.failWithDioType(DioExceptionType.sendTimeout),
        ApiNoAnswerReason.timedOut,
      ),
      'a receive timeout': (
        (adapter) => adapter.failWithDioType(DioExceptionType.receiveTimeout),
        ApiNoAnswerReason.timedOut,
      ),
      'no network (connection error)': (
        (adapter) => adapter.failWithDioType(DioExceptionType.connectionError),
        ApiNoAnswerReason.noConnection,
      ),
      'a refused connection (raw socket error)': (
        (adapter) =>
            adapter.failWith(const SocketException('Connection refused: $_technicalDetail')),
        ApiNoAnswerReason.noConnection,
      ),
      'a secure connection that cannot be made': (
        (adapter) => adapter.failWith(const HandshakeException(_technicalDetail)),
        ApiNoAnswerReason.noConnection,
      ),
      'a bad certificate': (
        (adapter) => adapter.failWithDioType(DioExceptionType.badCertificate),
        ApiNoAnswerReason.noConnection,
      ),
      'a connection dropped before the answer': (
        (adapter) => adapter.failWith(const HttpException(_technicalDetail)),
        ApiNoAnswerReason.connectionDropped,
      ),
      'a connection dropped in the middle of the body': (
        (adapter) => adapter.answerWith(
          (request, cancelFuture) async => ResponseBody(
            Stream<Uint8List>.fromIterable([
              Uint8List.fromList(utf8.encode('{"status":')),
            ]).followedBy(const HttpException(_technicalDetail)),
            200,
          ),
        ),
        ApiNoAnswerReason.connectionDropped,
      ),
      'a fault in the transport': (
        (adapter) => adapter.failWith(StateError(_technicalDetail)),
        ApiNoAnswerReason.unexpectedFailure,
      ),
    };

    for (final MapEntry(key: description, value: (script, reason)) in cases.entries) {
      test('$description gives ${reason.name}, with no exception text', () async {
        script(adapter);
        final answer = await _clientFor(adapter).postJson('recognize', {});
        expect(
          answer,
          isA<ApiAnswerNotReceived>().having((answer) => answer.reason, 'reason', reason),
        );
        expect(answer.toString(), isNot(contains('secret detail')));
      });
    }

    test('a cancel while waiting for the answer gives cancelled', () async {
      adapter.waitUntilCancelled();
      final cancelToken = CancelToken();
      final pending = _clientFor(adapter).postJson('recognize', {}, cancelToken: cancelToken);
      await pumpEventQueue();
      cancelToken.cancel();
      final answer = await pending;
      expect(
        answer,
        isA<ApiAnswerNotReceived>().having(
          (answer) => answer.reason,
          'reason',
          ApiNoAnswerReason.cancelled,
        ),
      );
    });

    test('a request cancelled before it starts is not sent', () async {
      final cancelToken = CancelToken()..cancel();
      final answer = await _clientFor(
        adapter,
      ).postMultipart('recognize', fields: const [], file: _audio([1]), cancelToken: cancelToken);
      expect(
        answer,
        isA<ApiAnswerNotReceived>().having(
          (answer) => answer.reason,
          'reason',
          ApiNoAnswerReason.cancelled,
        ),
      );
      expect(adapter.requests, isEmpty);
    });
  });

  group('the development log', () {
    test('writes nothing outside development, even with the verbose flag forced on', () async {
      final lines = <String>[];
      final configurations = [
        ExampleAppConfigurations.production(),
        ExampleAppConfigurations.staging(),
        ExampleAppConfigurations.development(),
        MisbuiltAppConfiguration(
          flavour: AppFlavour.production,
          apiBaseUrl: 'https://api.lookup.invalid/api/v1',
        ),
      ];
      for (final configuration in configurations) {
        adapter.answerJson(200, {});
        await _clientFor(
          adapter,
          configuration: configuration,
          developmentLog: DevelopmentLog(configuration: configuration, writeLine: lines.add),
        ).postJson('installs', {'install_id': 'x'}, installToken: _installToken);
      }
      expect(lines, isEmpty);
    });

    test(
      'in development with verbose logs: one line per request, with no header or body',
      () async {
        final lines = <String>[];
        final configuration = ExampleAppConfigurations.development(writesVerboseLogs: true);
        final clock = FakeClock();
        adapter
          ..answerWith((request, cancelFuture) async {
            clock.advance(const Duration(milliseconds: 420));
            return ResponseBody.fromString('{"install_token":"secret"}', 200);
          })
          ..failWithDioType(DioExceptionType.receiveTimeout);
        final client = _clientFor(
          adapter,
          configuration: configuration,
          clock: clock,
          developmentLog: DevelopmentLog(
            configuration: configuration,
            writeLine: lines.add,
            clock: clock,
          ),
        );
        final first = await client.postMultipart(
          'recognize',
          fields: const [MapEntry('idempotency_key', 'body-value')],
          file: _audio([1, 2, 3]),
          installToken: _installToken,
        );
        final second = await client.postJson('installs', {'install_id': 'body-value'});

        expect(lines, hasLength(2));
        final firstLine = jsonDecode(lines.first) as Map<String, Object?>;
        expect(firstLine.keys.toSet(), {
          'time',
          'event',
          'method',
          'path',
          'status',
          'durationMilliseconds',
          'requestId',
        });
        expect(firstLine['method'], 'POST');
        expect(firstLine['path'], 'recognize');
        expect(firstLine['status'], 200);
        expect(firstLine['durationMilliseconds'], 420);
        expect(firstLine['requestId'], first.sentRequestId);
        final secondLine = jsonDecode(lines.last) as Map<String, Object?>;
        expect(secondLine['noAnswerReason'], 'timedOut');
        expect(secondLine['requestId'], second.sentRequestId);
        for (final line in lines) {
          expect(line, isNot(contains(_installToken)));
          expect(line, isNot(contains('body-value')));
          expect(line, isNot(contains('secret')));
        }
      },
    );
  });
}

int _indexOfBytes(List<int> haystack, List<int> needle) {
  for (var start = 0; start + needle.length <= haystack.length; start++) {
    var matches = true;
    for (var offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] != needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -1;
}

extension on Stream<Uint8List> {
  /// This stream, then [error], as a connection that drops part-way through.
  Stream<Uint8List> followedBy(Object error) async* {
    yield* this;
    throw error;
  }
}
