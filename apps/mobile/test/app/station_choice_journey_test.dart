import 'dart:io';
import 'dart:math';

import 'package:dio/dio.dart' show DioExceptionType;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/core/outbox/outbox_index_file.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';

import '../support/received_multipart_form.dart';
import 'listener_app_harness.dart';

const String _recognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';
const String _stationBId = '0192a6c4-1111-4000-8000-000000000002';

/// "Which station?" through the whole app (P6 design §2.6, §2.17, §3.9): the chooser after an
/// identify, the result of the tapped station at once with no request, and the choice reaching the
/// API through the outbox once the network answers again (P6-CHOOSER-09, -10; P6-TESTS-07 part 1
/// in widget form; the emulator run is its other half).
void main() {
  late Directory outboxFolder;

  setUp(() {
    outboxFolder = Directory.systemTemp.createTempSync('station_choice_journey_');
    addTearDown(() => outboxFolder.deleteSync(recursive: true));
  });

  List<OutboxItem> outboxItems() => switch (OutboxIndexFile(outboxFolder).read()) {
    OutboxIndexRead(:final index) => index.items,
    _ => const [],
  };

  /// Starts the app with its outbox in a temporary folder and its runs started, as `bootstrap()`
  /// does after the first frame, then identifies and gets the chooser of `choose-station.json`.
  Future<ListenerAppHarness> showChooser(WidgetTester tester) async {
    final harness = ListenerAppHarness();
    harness.answerWithResponseFixture('valid/choose-station');
    await harness.pumpApp(
      tester,
      extraOverrides: [
        // The outbox's waits are wall-clock times: the clock follows the test's fake time.
        clockProvider.overrideWithValue(_TestTimeClock(tester)),
        outboxFolderLocatorProvider.overrideWithValue(() async => outboxFolder),
        outboxRandomProvider.overrideWithValue(Random(11)),
      ],
    );
    harness.container(tester).read(outboxRunSchedulerProvider).start();
    await tester.pump();
    await tester.tap(find.text('Tap to identify'));
    await harness.pumpTransition(tester);
    await harness.recordWholeClip(tester);
    expect(harness.location(tester), '/choose-station');
    expect(find.text('Which station are you listening to?'), findsOneWidget);
    return harness;
  }

  List<String> pathsOf(ListenerAppHarness harness) => [
    for (final request in harness.adapter.requests) request.address.path,
  ];

  testWidgets(
    'no signal after the answer: Station B shows at once, its choice reaches the API later',
    (tester) async {
      final harness = await showChooser(tester);
      // From now on the network gives no answer, as in airplane mode.
      for (var attempt = 0; attempt < 3; attempt++) {
        harness.adapter.failWithDioType(DioExceptionType.connectionError);
      }

      await tester.tap(find.text('Station B'));
      await tester.pump();
      final state = harness.state(tester);
      expect(state, isA<MatchedState>());
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/result');
      expect(find.byType(ResultScreen), findsOneWidget);
      expect(find.text('via Station B · 104.3 FM'), findsOneWidget);
      expect(find.text('Found it'), findsOneWidget);
      expect(pathsOf(harness), ['/api/v1/recognize'], reason: 'the card needed no request');

      // The choice is on disk before any send.
      final queued = outboxItems().single as StationChoiceItem;
      expect(queued.recognitionId, _recognitionId);
      expect(queued.stationId, _stationBId);

      // The app's own wake-ups try again while it stays open, and meet no answer.
      await tester.pump(const Duration(seconds: 11));
      await tester.pump(const Duration(seconds: 31));
      await tester.pump(const Duration(seconds: 61));
      expect(pathsOf(harness).where((path) => path.endsWith('/choice')), hasLength(3));
      expect(outboxItems(), hasLength(1));

      // The signal returns: the next wake-up sends it, and it is cleared.
      harness.adapter.answerText(204, '');
      await tester.pump(const Duration(seconds: 121));
      final choices = [
        for (final request in harness.adapter.requests)
          if (request.address.path.endsWith('/choice')) request,
      ];
      expect(choices, hasLength(4));
      expect(choices.map((request) => request.address.path).toSet(), {
        '/api/v1/recognitions/$_recognitionId/choice',
      });
      for (final request in choices) {
        expect(request.jsonBody, {'station_id': _stationBId});
      }
      expect(outboxItems(), isEmpty);
      await tester.pump(const Duration(minutes: 30));
      expect(
        harness.adapter.requests,
        hasLength(5),
        reason: 'sent once it was answered, never again',
      );
      expect(harness.reporter.reports, isEmpty);
    },
  );

  testWidgets('Cancel goes Home, and nothing is queued or sent (P6-CHOOSER-14)', (tester) async {
    final harness = await showChooser(tester);
    await tester.ensureVisible(find.widgetWithText(TextButton, 'Cancel'));
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await harness.pumpTransition(tester);
    expect(harness.location(tester), '/');
    expect(harness.state(tester), const IdleState());
    await tester.pump(const Duration(minutes: 5));
    expect(outboxItems(), isEmpty);
    expect(pathsOf(harness), ['/api/v1/recognize']);
  });

  testWidgets('"Remember" ticked: the next identify carries Station B as its hint '
      '(P6-CHOOSER-07)', (tester) async {
    final harness = await showChooser(tester);
    harness.adapter.answerText(204, '');
    await tester.tap(find.text('Station B'));
    await harness.pumpTransition(tester);
    await tester.pump(const Duration(seconds: 11));
    expect(outboxItems(), isEmpty, reason: 'the choice was sent');

    // Back from the Result, as its Back arrow does.
    harness.flow(tester).backToHome();
    await harness.pumpTransition(tester);
    expect(harness.location(tester), '/');
    harness.answerWithResponseFixture('valid/match-campaign-station-b');
    await tester.tap(find.text('Tap to identify'));
    await harness.pumpTransition(tester);
    await harness.recordWholeClip(tester);

    final hints = [
      for (final request in harness.recognizeRequests)
        ReceivedMultipartForm.of(request).fieldValues['station_hint'],
    ];
    expect(hints, [null, _stationBId]);
    expect(find.text('via Station B · 104.3 FM'), findsOneWidget);
    expect(find.text('Which station are you listening to?'), findsNothing);
  });
}

/// The wall clock and the monotonic clock of the widget test's fake time, so a wait the outbox
/// stores as a time of day falls due when the test's timers say it has passed.
class _TestTimeClock implements Clock {
  _TestTimeClock(this._tester) : _startedAt = _tester.binding.clock.now();

  final WidgetTester _tester;
  final DateTime _startedAt;

  @override
  DateTime now() => _tester.binding.clock.now().toUtc();

  @override
  Duration monotonicElapsed() => _tester.binding.clock.now().difference(_startedAt);
}
