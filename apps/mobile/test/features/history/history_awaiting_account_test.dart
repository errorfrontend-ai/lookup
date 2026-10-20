import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/history_answer_reader.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/features/history/data/history_repository.dart';
import 'package:lookup_listener/features/history/data/history_store.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/history/presentation/history_screen.dart';

import '../../support/fake_clock.dart';
import '../../support/history_fixtures.dart';
import '../../support/recording_client_error_reporter.dart';
import '../../support/tab_screen_harness.dart';

const LockFileOwner _owner = LockFileOwner(processId: 4242, engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d');
const String _recognitionId = HistoryFixtures.fixtureRecognitionId;
const String _clipKey = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c21';
final DateTime _capturedAt = DateTime.utc(2026, 10, 13, 11, 40);

/// A scan whose ad result waits for the listener's account, in History (ADR-005; LA-APP-08, -09): kept with the
/// withheld answer, shown as a row that reopens the gate, and replaced by the result once there is one.
void main() {
  group('the repository keeps it', () {
    late Directory folder;
    late HistoryRepository history;

    setUp(() {
      folder = Directory.systemTemp.createTempSync('history_awaiting_account_test_');
      addTearDown(() => folder.deleteSync(recursive: true));
      final clock = FakeClock(startsAt: DateTime.utc(2026, 10, 13, 12));
      final reporter = RecordingClientErrorReporter();
      history = HistoryRepository(
        store: HistoryStore(
          locateFolder: () async => folder,
          lockOwner: _owner,
          lockTakeOver: LocalLockTakeOver(attachedEngineIds: {_owner.engineId}),
          clock: clock,
          clientErrorReporter: reporter,
        ),
        answerReader: const HistoryAnswerReader(),
        clientErrorReporter: reporter,
        clock: clock,
      );
    });

    Future<void> saveWaiting({String? deferredKey, bool wasNotified = false}) => history.saveAwaitingAccount(
      recognitionId: _recognitionId,
      answer: HistoryFixtures.answer('valid/account-required'),
      capturedAtOnPhone: _capturedAt,
      deferredIdempotencyKey: deferredKey,
      wasNotified: wasNotified,
    );

    test('as a row with the phone\'s capture time, and nothing of the ad', () async {
      await saveWaiting();
      final entry = (await history.readView()).entries.single as HistoryAwaitingAccountEntry;
      expect(entry.entryId, _recognitionId);
      expect(entry.capturedAtOnPhone, _capturedAt);
      expect(entry.deferredIdempotencyKey, isNull);
      final stored = File('${folder.path}/index.json').readAsStringSync();
      for (final fromTheAd in ['Station A', 'Brand A', 'Summer service offer', 'phone_number_e164', '+4477']) {
        expect(stored, isNot(contains(fromTheAd)), reason: fromTheAd);
      }
    });

    test('with the saved clip\'s key and the notification, when it came from the outbox', () async {
      await saveWaiting(deferredKey: _clipKey, wasNotified: true);
      final entry = (await history.readView()).entries.single as HistoryAwaitingAccountEntry;
      expect(entry.deferredIdempotencyKey, _clipKey);
      expect(await history.wasNotified(_recognitionId), isTrue);
    });

    test('saved again it is still one row, keeping its first capture time', () async {
      await saveWaiting();
      await history.saveAwaitingAccount(
        recognitionId: _recognitionId,
        answer: HistoryFixtures.answer('valid/account-required'),
        capturedAtOnPhone: _capturedAt.add(const Duration(minutes: 5)),
      );
      final entries = (await history.readView()).entries;
      expect(entries, hasLength(1));
      expect(entries.single.capturedAtOnPhone, _capturedAt);
    });

    test('a body that is not a withheld result for this recognition is refused, and nothing is kept', () async {
      for (final answer in <Object?>[
        HistoryFixtures.answer('valid/match-campaign'),
        HistoryFixtures.answer('valid/no-match'),
        HistoryFixtures.answer('valid/account-required', recognitionId: HistoryFixtures.recognitionIdNumbered(9)),
        'not an answer',
        null,
      ]) {
        await expectLater(
          history.saveAwaitingAccount(recognitionId: _recognitionId, answer: answer, capturedAtOnPhone: _capturedAt),
          throwsA(isA<HistoryAnswerUnreadable>()),
          reason: '$answer',
        );
      }
      expect((await history.readView()).entries, isEmpty);
    });

    test('the result replaces the waiting row, which keeps its capture time; a replay of the withheld answer never undoes a result', () async {
      await saveWaiting(deferredKey: _clipKey);
      await history.saveResult(
        recognitionId: _recognitionId,
        answer: HistoryFixtures.answer('valid/match-campaign'),
        capturedAtOnPhone: _capturedAt.add(const Duration(minutes: 9)),
      );
      var entry = (await history.readView()).entries.single as HistoryResultEntry;
      expect(entry.capturedAtOnPhone, _capturedAt, reason: 'the row never jumps when its answer arrives');
      expect(entry.deferredIdempotencyKey, _clipKey);

      await saveWaiting();
      entry = (await history.readView()).entries.single as HistoryResultEntry;
      expect(entry.entryId, _recognitionId);
    });

    test('an entry whose stored answer is no longer a withheld result is dropped and reported, not shown', () async {
      await saveWaiting();
      final index = File('${folder.path}/index.json');
      index.writeAsStringSync(index.readAsStringSync().replaceAll('ACCOUNT_REQUIRED', 'SOMETHING_ELSE'));
      expect((await history.readView()).entries, isEmpty);
    });
  });

  group('the row', () {
    final waiting = HistoryFixtures.storedAwaitingAccount(
      recognitionId: _recognitionId,
      capturedAtOnPhone: DateTime(2026, 10, 13, 14, 32).toUtc(),
    );

    testWidgets('says when the clip was heard and "Create an account to see this result", and opens the gate when tapped', (tester) async {
      final harness = TabScreenHarness();
      harness.keepInHistory(const [], outcomes: [waiting]);
      final opened = <HistoryAwaitingAccountEntry>[];
      await harness.pump(tester, HistoryScreen(onOpenResult: (_) {}, onOpenSavedChooser: (_) {}, onOpenSavedAccountGate: opened.add));
      expect(find.text('Clip from today, 14:32'), findsOneWidget);
      expect(find.text('Create an account to see this result'), findsOneWidget);
      expect(find.byIcon(Icons.lock_outline), findsOneWidget);
      await tester.tap(find.text('Create an account to see this result'));
      await tester.pump();
      expect(opened.single.entryId, _recognitionId);
    });

    testWidgets('is a button for screen readers, with both lines', (tester) async {
      final harness = TabScreenHarness();
      harness.keepInHistory(const [], outcomes: [waiting]);
      await harness.pump(tester, HistoryScreen(onOpenResult: (_) {}, onOpenSavedChooser: (_) {}, onOpenSavedAccountGate: (_) {}));
      final data = tester.getSemantics(find.text('Create an account to see this result')).getSemanticsData();
      expect(data.label, contains('Clip from today, 14:32'));
      expect(data.label, contains('Create an account to see this result'));
    });

    testWidgets('sits among results, newest first, with the other saved outcomes', (tester) async {
      final harness = TabScreenHarness();
      harness.keepInHistory(
        [
          StoredHistoryEntryData(
            recognitionId: HistoryFixtures.recognitionIdNumbered(1),
            capturedAtOnPhone: DateTime(2026, 10, 13, 9).toUtc(),
          ),
        ],
        outcomes: [waiting],
      );
      await harness.pump(tester, HistoryScreen(onOpenResult: (_) {}, onOpenSavedChooser: (_) {}, onOpenSavedAccountGate: (_) {}));
      final waitingTop = tester.getTopLeft(find.text('Create an account to see this result')).dy;
      final resultTop = tester.getTopLeft(find.textContaining('Brand A')).dy;
      expect(waitingTop, lessThan(resultTop));
    });
  });
}
