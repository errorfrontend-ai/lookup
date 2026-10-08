import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/error_reporting/development_log.dart';

import '../../support/example_app_configurations.dart';
import '../../support/fake_clock.dart';

void main() {
  late List<String> lines;

  setUp(() => lines = []);

  DevelopmentLog logFor(AppConfiguration configuration) =>
      DevelopmentLog(configuration: configuration, writeLine: lines.add, clock: FakeClock());

  void writeOneOfEach(DevelopmentLog log) {
    log
      ..recordRequest(
        method: 'POST',
        path: 'recognize',
        requestId: '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f',
        duration: const Duration(milliseconds: 300),
        status: 200,
      )
      ..recordEvent('something happened', detail: 'detail');
  }

  group('writes nothing', () {
    test('in staging or production, even with the verbose flag forced on', () {
      for (final flavour in [AppFlavour.staging, AppFlavour.production]) {
        final log = logFor(
          MisbuiltAppConfiguration(
            flavour: flavour,
            apiBaseUrl: 'https://api.lookup.invalid/api/v1',
          ),
        );
        expect(log.isOn, isFalse);
        writeOneOfEach(log);
      }
      writeOneOfEach(logFor(ExampleAppConfigurations.production()));
      expect(lines, isEmpty);
    });

    test('in development without the verbose flag', () {
      final log = logFor(ExampleAppConfigurations.development());
      expect(log.isOn, isFalse);
      writeOneOfEach(log);
      expect(lines, isEmpty);
    });

    test('when made off', () {
      const log = DevelopmentLog.off();
      expect(log.isOn, isFalse);
      writeOneOfEach(log);
      expect(lines, isEmpty);
    });
  });

  group('in development with the verbose flag', () {
    late DevelopmentLog log;

    setUp(() => log = logFor(ExampleAppConfigurations.development(writesVerboseLogs: true)));

    test('writes one JSON object per line, with the time', () {
      writeOneOfEach(log);
      expect(lines, hasLength(2));
      final request = jsonDecode(lines.first) as Map<String, Object?>;
      expect(request, {
        'time': '2026-10-08T12:00:00.000Z',
        'event': 'api request',
        'method': 'POST',
        'path': 'recognize',
        'status': 200,
        'durationMilliseconds': 300,
        'requestId': '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f',
      });
    });

    test('scrubs free text and stacks of personal data', () {
      log.recordEvent(
        'failed for owner@station.example',
        detail: 'call +260 977 123 456 at https://api.example/x?token=secret',
        stackTrace: StackTrace.fromString('#0 main (file:///x.dart?install=owner@station.example)'),
      );
      expect(lines.single, isNot(contains('owner@station.example')));
      expect(lines.single, isNot(contains('977')));
      expect(lines.single, isNot(contains('secret')));
    });

    test('a line break in a value cannot forge a second line', () {
      log.recordEvent('event', detail: 'first\n{"event":"forged"}');
      expect(lines, hasLength(1));
      expect(lines.single.split('\n'), hasLength(1));
    });

    test('a failing writer never breaks what it describes', () {
      final failing = DevelopmentLog(
        configuration: ExampleAppConfigurations.development(writesVerboseLogs: true),
        writeLine: (line) => throw StateError('the console is gone'),
      );
      expect(() => failing.recordEvent('event'), returnsNormally);
    });
  });
}
