import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/error_reporting/isolate_error_listener.dart';

import '../../support/recording_client_error_reporter.dart';

/// Runs in a spawned isolate and fails there, uncaught.
void _failInIsolate(Object? message) => throw StateError('isolate failure while decoding');

void main() {
  group('decodeErrorMessage', () {
    test("reads Dart's [description, stack] pair", () {
      final decoded = IsolateErrorListener.decodeErrorMessage(['Bad state: x', '#0 main (a.dart)']);
      expect(decoded?.description, 'Bad state: x');
      expect(decoded?.stack, '#0 main (a.dart)');
    });

    test('a missing stack is allowed', () {
      final decoded = IsolateErrorListener.decodeErrorMessage(['Bad state: x', null]);
      expect(decoded?.description, 'Bad state: x');
      expect(decoded?.stack, isNull);
    });

    test('anything else is not an error message', () {
      for (final message in <Object?>[
        null,
        'text',
        <Object?>[],
        ['only one'],
        ['a', 'b', 'c'],
        [42, 'stack'],
        ['description', 42],
      ]) {
        expect(IsolateErrorListener.decodeErrorMessage(message), isNull, reason: '$message');
      }
    });

    test("a FormatException's or DioException's text is withheld, its type kept", () {
      expect(
        IsolateErrorListener.decodeErrorMessage([
          'FormatException: Unexpected character {"phone":"+260977123456"}',
          null,
        ])?.description,
        'FormatException (its text is not sent)',
      );
      expect(
        IsolateErrorListener.decodeErrorMessage([
          'DioException [connection timeout]: The request took longer than 0:00:15',
          null,
        ])?.description,
        'DioException (its text is not sent)',
      );
      expect(
        IsolateErrorListener.decodeErrorMessage(['FormatExceptionally odd', null])?.description,
        'FormatExceptionally odd',
      );
    });
  });

  test('an error raised in a spawned isolate wired to its port is decoded and reported', () async {
    final reporter = RecordingClientErrorReporter();
    final listener = IsolateErrorListener(
      reporter: reporter,
      readCurrentLocation: () => '/identifying',
    );
    addTearDown(listener.close);
    final nextReport = reporter.nextReport();

    await Isolate.spawn(_failInIsolate, null, onError: listener.sendPort);

    final report = await nextReport.timeout(const Duration(seconds: 20));
    expect(report.kind, ClientErrorKind.uncaught);
    expect(report.error, 'Bad state: isolate failure while decoding');
    expect(report.stackTrace.toString(), contains('_failInIsolate'));
    expect(report.location, '/identifying');
    expect(reporter.reports, hasLength(1));
  });

  test('listens to and stops listening to an isolate, such as the current one', () {
    final listener = IsolateErrorListener(reporter: RecordingClientErrorReporter());
    addTearDown(listener.close);
    expect(() => listener.listenTo(Isolate.current), returnsNormally);
    expect(() => listener.stopListeningTo(Isolate.current), returnsNormally);
  });

  test('a message that is not an error is ignored', () async {
    final reporter = RecordingClientErrorReporter();
    final listener = IsolateErrorListener(reporter: reporter);
    addTearDown(listener.close);
    listener.sendPort.send('not an error');
    await pumpEventQueue();
    expect(reporter.reports, isEmpty);
  });
}
