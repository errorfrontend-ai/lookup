import 'dart:io';

import 'package:dio/dio.dart' show DioExceptionType;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/history/presentation/history_entry_row.dart';
import 'package:lookup_listener/features/history/presentation/history_screen.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';

import '../features/identify/presentation/identify_screen_harness.dart' show pressSystemBack;
import '../support/history_fixtures.dart';
import 'listener_app_harness.dart';

const String _recognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';
const String _stationBId = '0192a6c4-1111-4000-8000-000000000002';

/// History through the whole app (P6 design §2.7, §2.9, §2.10, §3.14): a result shows "Saved to
/// History" once History holds it, History lists it, and it opens again with no data, its buttons
/// working (P6-HISTORY-01, -02 in widget form, -11, -14; walkthrough (a) steps 3 to 5 of piece 2).
void main() {
  Future<ListenerAppHarness> identifyWith(WidgetTester tester, String fixture) async {
    final harness = ListenerAppHarness();
    harness.answerWithResponseFixture(fixture);
    await harness.pumpApp(tester);
    await tester.tap(find.text('Tap to identify'));
    await harness.pumpTransition(tester);
    await harness.recordWholeClip(tester);
    await harness.pumpTransition(tester);
    return harness;
  }

  testWidgets(
    'after a match the Result says "Saved to History", and History holds the result with its card (P6-HISTORY-14, -01)',
    (tester) async {
      final harness = await identifyWith(tester, 'valid/match-campaign');
      expect(harness.location(tester), '/result');
      expect(find.byType(ResultScreen), findsOneWidget);
      await tester.ensureVisible(find.text('Saved to History'));
      expect(find.text('Saved to History'), findsOneWidget);

      final stored = HistoryFixtures.readIndexEntries(harness.historyFolder).single;
      expect(stored['entry_id'], _recognitionId);
      expect(stored['kind'], 'RESULT');
      expect(stored['answer'], HistoryFixtures.answer('valid/match-campaign'));
      expect(stored['chosen_station_id'], isNull);
      expect(harness.reporter.reports, isEmpty);
    },
  );

  testWidgets(
    'History lists it under "Earlier", and it opens again with no data: its Call button opens the dialler\'s address, the Back arrow returns to History (P6-HISTORY-02, -11)',
    (tester) async {
      final harness = await identifyWith(tester, 'valid/match-campaign');
      harness.flow(tester).backToHome();
      await harness.pumpTransition(tester);
      await tester.tap(find.text('History'));
      await harness.pumpTransition(tester);
      expect(find.byType(HistoryScreen), findsOneWidget);
      expect(find.text('EARLIER'), findsOneWidget);
      expect(find.text('Brand A — Summer service offer'), findsOneWidget);
      expect(find.textContaining('via Station A · Today, '), findsOneWidget);
      expect(
        find.text(
          'Saved results keep working without data — call, chat or get directions any time.',
        ),
        findsOneWidget,
      );

      // From here on there is no data at all, as in airplane mode.
      for (var attempt = 0; attempt < 3; attempt++) {
        harness.adapter.failWithDioType(DioExceptionType.connectionError);
      }
      final requestsBefore = harness.adapter.requests.length;
      await tester.tap(find.byType(HistoryEntryRow));
      await harness.pumpTransition(tester);
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/r/$_recognitionId');
      expect(find.text('Saved result'), findsOneWidget);
      expect(find.text('Brand A'), findsOneWidget);

      await tester.tap(find.text('Call us'));
      await tester.pump();
      expect(harness.launcher.openedAddresses, ['tel:+447700900001']);
      expect(harness.adapter.requests, hasLength(requestsBefore), reason: 'no request needed');

      await tester.tap(find.bySemanticsLabel('Back'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/history');
    },
  );

  testWidgets('a station chosen in "Which station?" is kept with its own card (P6-HISTORY-01)', (
    tester,
  ) async {
    final harness = await identifyWith(tester, 'valid/choose-station');
    expect(harness.location(tester), '/choose-station');
    expect(HistoryFixtures.readIndexEntries(harness.historyFolder), isEmpty, reason: 'not yet');
    // The choice itself has no answer to wait for.
    harness.adapter.failWithDioType(DioExceptionType.connectionError);

    await tester.tap(find.text('Station B'));
    await harness.pumpTransition(tester);
    expect(find.text('via Station B · 104.3 FM'), findsOneWidget);
    await tester.ensureVisible(find.text('Saved to History'));
    expect(find.text('Saved to History'), findsOneWidget);
    final stored = HistoryFixtures.readIndexEntries(harness.historyFolder).single;
    expect(stored['entry_id'], _recognitionId);
    expect(stored['chosen_station_id'], _stationBId);
    expect(stored['answer'], HistoryFixtures.answer('valid/choose-station'));

    harness.flow(tester).backToHome();
    await harness.pumpTransition(tester);
    await tester.tap(find.text('History'));
    await harness.pumpTransition(tester);
    expect(find.textContaining('via Station B · Today, '), findsOneWidget);
  });

  testWidgets('a cancelled "Which station?" is not saved (gap 28)', (tester) async {
    final harness = await identifyWith(tester, 'valid/choose-station');
    await tester.tap(find.descendant(of: find.byType(BottomSheet), matching: find.text('Cancel')));
    await harness.pumpTransition(tester);
    expect(harness.location(tester), '/');
    expect(HistoryFixtures.readIndexEntries(harness.historyFolder), isEmpty);
  });

  testWidgets('a save that fails is reported, and the Result says nothing of History', (
    tester,
  ) async {
    final harness = ListenerAppHarness();
    // A file where History's folder should be: the phone cannot write History.
    harness.supportFolder.createSync(recursive: true);
    File(harness.historyFolder.path).writeAsStringSync('in the way');
    harness.answerWithResponseFixture('valid/match-campaign');
    await harness.pumpApp(tester);
    await tester.tap(find.text('Tap to identify'));
    await harness.pumpTransition(tester);
    await harness.recordWholeClip(tester);
    await harness.pumpTransition(tester);

    expect(find.byType(ResultScreen), findsOneWidget);
    expect(find.text('Saved to History'), findsNothing);
    expect(
      harness.reporter.reports.map((report) => report.description),
      contains('Saving the result to History failed'),
    );
    await pressSystemBack(tester);
    await harness.pumpTransition(tester);
    expect(harness.location(tester), '/');
  });
}
