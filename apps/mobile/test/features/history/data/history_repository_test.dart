import 'dart:async';
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/history_answer_reader.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/features/history/data/history_repository.dart';
import 'package:lookup_listener/features/history/data/history_store.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/history/domain/history_view.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';
import 'package:lookup_listener/features/history/domain/history_waiting_clip.dart';
import 'package:lookup_listener/features/identify/domain/deferred_result_sink.dart';

import '../../../support/fake_clock.dart';
import '../../../support/history_fixtures.dart';
import '../../../support/recording_client_error_reporter.dart';

const LockFileOwner _owner = LockFileOwner(
  processId: 4242,
  engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
);
const String _stationBId = '0192a6c4-1111-4000-8000-000000000002';

/// History on the phone (P6 design §3.14; P6-HISTORY-01): results kept with their cards, exactly
/// as the API sent them, read again by the answer's reader, keyed by recognition id, at most 50 and
/// 30 days, and cleared on request.
void main() {
  late Directory folder;
  late FakeClock clock;
  late RecordingClientErrorReporter reporter;

  setUp(() {
    folder = Directory.systemTemp.createTempSync('history_repository_test_');
    addTearDown(() => folder.deleteSync(recursive: true));
    clock = FakeClock(startsAt: DateTime.utc(2026, 10, 13, 13));
    reporter = RecordingClientErrorReporter();
  });

  HistoryRepository repository() => HistoryRepository(
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

  Future<void> save(
    HistoryRepository history,
    String fixture, {
    String recognitionId = HistoryFixtures.fixtureRecognitionId,
    DateTime? capturedAtOnPhone,
    String? chosenStationId,
  }) => history.saveResult(
    recognitionId: recognitionId,
    answer: HistoryFixtures.answer(fixture, recognitionId: recognitionId),
    capturedAtOnPhone: capturedAtOnPhone ?? clock.now().subtract(const Duration(seconds: 12)),
    chosenStationId: chosenStationId,
  );

  group('a result is kept with its card (P6-HISTORY-01)', () {
    test(
      'a match: the campaign card, its buttons and numbers, read back after a restart',
      () async {
        final capturedAt = DateTime.utc(2026, 10, 13, 12, 59, 48);
        await save(repository(), 'valid/match-campaign', capturedAtOnPhone: capturedAt);

        // A new repository over the same folder: what a restart of the app reads.
        final view = await repository().readView();
        final entry = view.entries.single as HistoryResultEntry;
        expect(entry.entryId, HistoryFixtures.fixtureRecognitionId);
        expect(entry.capturedAtOnPhone, capturedAt);
        expect(entry.result.kind, RecognitionResultKind.campaign);
        expect(entry.result.clientName, 'Brand A');
        expect(entry.result.title, 'Summer service offer');
        expect(entry.result.stationName, 'Station A');
        final call = entry.result.card.shownActions.first as CallUiAction;
        expect(call.label, 'Call us');
        expect(call.phoneNumberE164, '+447700900001');
        expect(entry.result.card.shownActions, hasLength(4));
      },
    );

    test('the advertiser\'s usual card (a fallback) is kept as such', () async {
      await save(repository(), 'valid/match-client-default');
      final entry = (await repository().readView()).entries.single as HistoryResultEntry;
      expect(entry.result.kind, RecognitionResultKind.clientDefault);
    });

    test('a choice: the chosen station\'s own card, not the others\'', () async {
      await save(repository(), 'valid/choose-station', chosenStationId: _stationBId);
      final entry = (await repository().readView()).entries.single as HistoryResultEntry;
      expect(entry.result.stationId, _stationBId);
      expect(entry.result.stationName, 'Station B');
      expect(entry.result.stationFrequencyLabel, '104.3 FM');
      expect(entry.result.card.shownActions, isNotEmpty);
    });

    test('the answer is stored exactly as the API sent it, with the design\'s fields', () async {
      final answer = HistoryFixtures.answer('valid/match-campaign');
      final capturedAt = DateTime.utc(2026, 10, 13, 12, 59, 48);
      await repository().saveResult(
        recognitionId: HistoryFixtures.fixtureRecognitionId,
        answer: answer,
        capturedAtOnPhone: capturedAt,
      );
      final stored = HistoryFixtures.readIndexEntries(folder).single;
      expect(stored, {
        'entry_id': HistoryFixtures.fixtureRecognitionId,
        'kind': 'RESULT',
        'not_identified_reason': null,
        'captured_at_on_phone': '2026-10-13T12:59:48.000Z',
        'saved_at': '2026-10-13T13:00:00.000Z',
        'was_deferred': false,
        'deferred_idempotency_key': null,
        'was_notified': false,
        'answer': answer,
        'chosen_station_id': null,
        'is_reported': false,
      });
    });

    test('an answer that does not read as a result is not kept, and the save says so', () async {
      final history = repository();
      await expectLater(
        history.saveResult(
          recognitionId: HistoryFixtures.fixtureRecognitionId,
          answer: HistoryFixtures.answer('valid/no-match'),
          capturedAtOnPhone: clock.now(),
        ),
        throwsA(isA<HistoryAnswerUnreadable>()),
      );
      await expectLater(
        history.saveResult(
          recognitionId: HistoryFixtures.fixtureRecognitionId,
          answer: HistoryFixtures.answer('valid/choose-station'),
          capturedAtOnPhone: clock.now(),
          chosenStationId: '0192a6c4-1111-4000-8000-000000000009',
        ),
        throwsA(isA<HistoryAnswerUnreadable>()),
      );
      expect((await history.readView()).isEmpty, isTrue);
    });
  });

  group('keyed by recognition id (contract R13)', () {
    test('the same answer saved twice is one entry, with its first capture time', () async {
      final history = repository();
      final firstCapture = DateTime.utc(2026, 10, 13, 12, 59, 48);
      await save(history, 'valid/match-campaign', capturedAtOnPhone: firstCapture);
      clock.advance(const Duration(minutes: 1));
      await save(history, 'valid/match-campaign');
      final view = await history.readView();
      expect(view.entries, hasLength(1));
      expect(view.entries.single.capturedAtOnPhone, firstCapture);
    });

    test('different recognitions are different entries, newest first by capture time', () async {
      final history = repository();
      for (final (number, minutesAgo) in [(1, 30), (2, 10), (3, 20)]) {
        await save(
          history,
          'valid/match-campaign',
          recognitionId: HistoryFixtures.recognitionIdNumbered(number),
          capturedAtOnPhone: clock.now().subtract(Duration(minutes: minutesAgo)),
        );
      }
      final view = await history.readView();
      expect(view.entries.map((entry) => entry.entryId), [
        HistoryFixtures.recognitionIdNumbered(2),
        HistoryFixtures.recognitionIdNumbered(3),
        HistoryFixtures.recognitionIdNumbered(1),
      ]);
      expect(view.holdsResult(HistoryFixtures.recognitionIdNumbered(3)), isTrue);
      expect(view.holdsResult(HistoryFixtures.recognitionIdNumbered(4)), isFalse);
    });
  });

  group('limits (P6 design §3.14, Q7)', () {
    test('at most 50 entries: the 51st save drops the oldest', () async {
      final history = repository();
      for (var number = 1; number <= 51; number++) {
        await save(
          history,
          'valid/match-campaign',
          recognitionId: HistoryFixtures.recognitionIdNumbered(number),
          capturedAtOnPhone: clock.now().subtract(Duration(minutes: 100 - number)),
        );
      }
      final view = await history.readView();
      expect(view.entries, hasLength(50));
      expect(view.holdsResult(HistoryFixtures.recognitionIdNumbered(1)), isFalse);
      expect(view.holdsResult(HistoryFixtures.recognitionIdNumbered(2)), isTrue);
      expect(view.holdsResult(HistoryFixtures.recognitionIdNumbered(51)), isTrue);
      expect(HistoryFixtures.readIndexEntries(folder), hasLength(50));
    });

    test('30 days: an older entry is never shown, and is deleted at start', () async {
      HistoryFixtures.writeIndex(folder, [
        HistoryFixtures.storedResult(
          recognitionId: HistoryFixtures.recognitionIdNumbered(1),
          capturedAtOnPhone: clock.now().subtract(const Duration(days: 30, minutes: 1)),
        ),
        HistoryFixtures.storedResult(
          recognitionId: HistoryFixtures.recognitionIdNumbered(2),
          capturedAtOnPhone: clock.now().subtract(const Duration(days: 29, hours: 23)),
        ),
      ]);
      final history = repository();
      final view = await history.readView();
      expect(view.entries.map((entry) => entry.entryId), [
        HistoryFixtures.recognitionIdNumbered(2),
      ]);
      expect(
        HistoryFixtures.readIndexEntries(folder),
        hasLength(2),
        reason: 'reading writes nothing',
      );

      await history.removeExpiredEntries();
      expect(HistoryFixtures.readIndexEntries(folder).map((entry) => entry['entry_id']), [
        HistoryFixtures.recognitionIdNumbered(2),
      ]);
    });

    test('a save also deletes what is past its 30 days', () async {
      HistoryFixtures.writeIndex(folder, [
        HistoryFixtures.storedResult(
          recognitionId: HistoryFixtures.recognitionIdNumbered(1),
          capturedAtOnPhone: clock.now().subtract(const Duration(days: 31)),
        ),
      ]);
      await save(repository(), 'valid/match-campaign');
      expect(HistoryFixtures.readIndexEntries(folder).map((entry) => entry['entry_id']), [
        HistoryFixtures.fixtureRecognitionId,
      ]);
    });
  });

  group('read again by the answer\'s reader', () {
    test(
      'an entry the reader refuses is dropped from the file and reported, by count only',
      () async {
        final unreadable = HistoryFixtures.storedResult(
          recognitionId: HistoryFixtures.recognitionIdNumbered(1),
          capturedAtOnPhone: clock.now(),
          fixture: 'invalid/match-without-result',
        );
        HistoryFixtures.writeIndex(folder, [
          unreadable,
          HistoryFixtures.storedResult(
            recognitionId: HistoryFixtures.recognitionIdNumbered(2),
            capturedAtOnPhone: clock.now().subtract(const Duration(minutes: 1)),
          ),
        ]);
        final view = await repository().readView();
        expect(view.entries.map((entry) => entry.entryId), [
          HistoryFixtures.recognitionIdNumbered(2),
        ]);
        // The drop is written in the background.
        await pumpEventQueue();
        expect(HistoryFixtures.readIndexEntries(folder).map((entry) => entry['entry_id']), [
          HistoryFixtures.recognitionIdNumbered(2),
        ]);
        final report = reporter.reports.single;
        expect(report.error, 'History held 1 entries the answer reader refuses; they were dropped');
        expect('${report.error}', isNot(contains('Brand A')));
      },
    );

    test('an index that cannot be read is set aside, reported, and History starts empty', () async {
      folder.createSync(recursive: true);
      File('${folder.path}/index.json').writeAsStringSync('{"format_version": 1, "entries": ');
      final history = repository();
      expect((await history.readView()).isEmpty, isTrue);
      await save(history, 'valid/match-campaign');
      expect((await history.readView()).entries, hasLength(1));
      expect(reporter.reports.single.error, contains('could not be read'));
      final setAside = folder.listSync().where((entity) => entity.path.contains('.unreadable-'));
      expect(setAside, hasLength(1));
    });
  });

  group('"Clear history" (Q7)', () {
    test('empties History on the phone', () async {
      final history = repository();
      await save(history, 'valid/match-campaign');
      await save(
        history,
        'valid/match-client-default',
        recognitionId: HistoryFixtures.recognitionIdNumbered(2),
      );
      await history.clear();
      expect((await history.readView()).isEmpty, isTrue);
      expect(HistoryFixtures.readIndexEntries(folder), isEmpty);
    });
  });

  group('the view follows every change (P6-HISTORY-14)', () {
    test('a save and a clear each give the view again, at once', () async {
      final history = repository();
      final views = <HistoryView>[];
      final subscription = history.watchView().listen(views.add);
      addTearDown(subscription.cancel);
      await pumpEventQueue();
      expect(views.single.isEmpty, isTrue);

      await save(history, 'valid/match-campaign');
      await pumpEventQueue();
      expect(views.last.holdsResult(HistoryFixtures.fixtureRecognitionId), isTrue);

      await history.clear();
      await pumpEventQueue();
      expect(views.last.isEmpty, isTrue);
      expect(views, hasLength(3));
    });
  });

  test('a folder that could not be made (the storage full at start-up) is tried again at the next '
      'save, not only after a restart', () async {
    final historyFolder = Directory('${folder.path}/history');
    // A file where the folder should be: making the folder fails, as it does with no room left.
    final inTheWay = File(historyFolder.path)..writeAsStringSync('');
    final history = HistoryRepository(
      store: HistoryStore(
        locateFolder: () async => historyFolder,
        lockOwner: _owner,
        lockTakeOver: LocalLockTakeOver(attachedEngineIds: {_owner.engineId}),
        clock: clock,
        clientErrorReporter: reporter,
      ),
      answerReader: const HistoryAnswerReader(),
      clientErrorReporter: reporter,
      clock: clock,
    );
    await expectLater(save(history, 'valid/match-campaign'), throwsA(isA<FileSystemException>()));

    inTheWay.deleteSync();
    await save(history, 'valid/match-campaign');
    expect(HistoryFixtures.readIndexEntries(historyFolder), hasLength(1));
  });

  test('a write waits for a live engine\'s lock, and fails after 10 seconds without taking it', () {
    fakeAsync((fakeAsync) {
      // Another engine of this process, still attached, holds the lock (P6-D36).
      const otherEngine = LockFileOwner(
        processId: 4242,
        engineId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
      );
      folder.createSync(recursive: true);
      final heldLock = OwnedLockFile(
        file: File('${folder.path}/index.lock'),
        owner: otherEngine,
        lockTakeOver: LocalLockTakeOver.everyEngineAttached(),
        clock: clock,
      );
      var isTaken = false;
      unawaited(heldLock.tryTake().then((value) => isTaken = value));
      fakeAsync.flushMicrotasks();
      expect(isTaken, isTrue);
      final history = HistoryRepository(
        store: HistoryStore(
          locateFolder: () async => folder,
          lockOwner: _owner,
          lockTakeOver: LocalLockTakeOver.everyEngineAttached(),
          clock: clock,
          clientErrorReporter: reporter,
        ),
        answerReader: const HistoryAnswerReader(),
        clientErrorReporter: reporter,
        clock: clock,
      );
      Object? failure;
      var isSaved = false;
      unawaited(
        save(
          history,
          'valid/match-campaign',
        ).then((_) => isSaved = true, onError: (Object error) => failure = error),
      );
      fakeAsync.elapse(const Duration(seconds: 9));
      expect(failure, isNull, reason: 'still waiting for the live engine');
      expect(isSaved, isFalse);
      fakeAsync.elapse(const Duration(seconds: 2));
      expect(failure, isA<HistoryLockUnavailable>());
      expect(isSaved, isFalse);
      expect(heldLock.isHeld, isTrue);
      expect(File('${folder.path}/index.lock').readAsStringSync(), contains(otherEngine.engineId));
      expect(HistoryFixtures.readIndexEntries(folder), isEmpty);
    });
  });

  group('saved clips\' outcomes (P6 design §3.11; P6-HISTORY-04 to -06; T51)', () {
    const clipKey = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c21';
    final capturedAt = DateTime.utc(2026, 10, 13, 12, 40);

    test('a station still to choose is kept with its candidates and its answer', () async {
      final answer = HistoryFixtures.answer('valid/choose-station');
      await repository().saveAwaitingChoice(
        recognitionId: HistoryFixtures.fixtureRecognitionId,
        answer: answer,
        capturedAtOnPhone: capturedAt,
        deferredIdempotencyKey: clipKey,
        wasNotified: true,
      );
      final entry = (await repository().readView()).entries.single as HistoryAwaitingChoiceEntry;
      expect(entry.candidates.map((candidate) => candidate.stationName), [
        'Station A',
        'Station B',
      ]);
      expect(entry.answerBody, answer);
      expect(entry.deferredIdempotencyKey, clipKey);
      expect(entry.capturedAtOnPhone, capturedAt);
      expect(await repository().wasNotified(HistoryFixtures.fixtureRecognitionId), isTrue);
    });

    test('an answer that does not read as a chooser is refused, and nothing is kept', () async {
      await expectLater(
        repository().saveAwaitingChoice(
          recognitionId: HistoryFixtures.fixtureRecognitionId,
          answer: HistoryFixtures.answer('valid/match-campaign'),
          capturedAtOnPhone: capturedAt,
          deferredIdempotencyKey: clipKey,
          wasNotified: false,
        ),
        throwsA(isA<HistoryAnswerUnreadable>()),
      );
      expect(HistoryFixtures.readIndexEntries(folder), isEmpty);
    });

    test('a replay of the chooser after the listener chose never undoes the choice', () async {
      final history = repository();
      await save(history, 'valid/choose-station', chosenStationId: _stationBId);
      await history.saveAwaitingChoice(
        recognitionId: HistoryFixtures.fixtureRecognitionId,
        answer: HistoryFixtures.answer('valid/choose-station'),
        capturedAtOnPhone: capturedAt,
        deferredIdempotencyKey: clipKey,
        wasNotified: true,
      );
      final entry = (await history.readView()).entries.single as HistoryResultEntry;
      expect(entry.result.stationId, _stationBId);
    });

    test('choosing a station later turns the waiting entry into its result, keeping the clip\'s '
        'key and capture time', () async {
      final history = repository();
      await history.saveAwaitingChoice(
        recognitionId: HistoryFixtures.fixtureRecognitionId,
        answer: HistoryFixtures.answer('valid/choose-station'),
        capturedAtOnPhone: capturedAt,
        deferredIdempotencyKey: clipKey,
        wasNotified: true,
      );
      await save(history, 'valid/choose-station', chosenStationId: _stationBId);
      final entry = (await history.readView()).entries.single as HistoryResultEntry;
      expect(entry.result.stationId, _stationBId);
      expect(entry.deferredIdempotencyKey, clipKey);
      expect(entry.capturedAtOnPhone, capturedAt);
      expect(await history.wasNotified(HistoryFixtures.fixtureRecognitionId), isTrue);
    });

    for (final reason in DeferredClipNotIdentifiedReason.values) {
      test('not identified (${reason.name}) is kept with why, and read back', () async {
        await repository().saveNotIdentified(
          entryId: clipKey,
          capturedAtOnPhone: capturedAt,
          reason: reason,
          deferredIdempotencyKey: clipKey,
          wasNotified: false,
        );
        final entry = (await repository().readView()).entries.single as HistoryNotIdentifiedEntry;
        expect(entry.entryId, clipKey);
        expect(entry.reason, reason);
        expect(
          HistoryFixtures.readIndexEntries(folder).single['not_identified_reason'],
          reason.storedName,
        );
      });
    }

    test('a live result was never notified; a launch id may not open it', () async {
      await save(repository(), 'valid/match-campaign');
      expect(await repository().wasNotified(HistoryFixtures.fixtureRecognitionId), isFalse);
      expect(await repository().wasNotified('0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f99'), isFalse);
    });
  });

  group('the clips still waiting (P6 design §2.9, §3.9)', () {
    const clipKey = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c21';

    test('come with the view, and a change to them gives the view again', () async {
      var waiting = [
        HistoryWaitingClip(
          idempotencyKey: clipKey,
          capturedAtOnPhone: DateTime.utc(2026, 10, 13, 12, 40),
          status: HistoryWaitingClipStatus.waitingForSignal,
        ),
      ];
      final changes = StreamController<void>.broadcast();
      addTearDown(changes.close);
      final history = HistoryRepository(
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
        readWaitingClips: () async => waiting,
        waitingClipsChanged: changes.stream,
      );

      final views = <HistoryView>[];
      final subscription = history.watchView().listen(views.add);
      addTearDown(subscription.cancel);
      await pumpEventQueue();
      expect(views.last.waitingClips.single.idempotencyKey, clipKey);

      waiting = [];
      changes.add(null);
      await pumpEventQueue();
      expect(views.last.waitingClips, isEmpty);
    });
  });

  group('a reported result ("Report this", P6 design §2.14)', () {
    test('is remembered as reported, and stays so when it is saved again', () async {
      final history = repository();
      await save(history, 'valid/choose-station', chosenStationId: _stationBId);
      expect(((await history.readView()).entries.single as HistoryResultEntry).isReported, isFalse);
      await history.markReported(HistoryFixtures.fixtureRecognitionId);
      expect(
        ((await repository().readView()).entries.single as HistoryResultEntry).isReported,
        isTrue,
      );
      await save(history, 'valid/choose-station', chosenStationId: _stationBId);
      expect(
        ((await history.readView()).entries.single as HistoryResultEntry).isReported,
        isTrue,
        reason: 'a replay never forgets the report',
      );
    });

    test('a recognition History does not hold changes nothing', () async {
      final history = repository();
      await history.markReported(HistoryFixtures.fixtureRecognitionId);
      expect((await history.readView()).entries, isEmpty);
    });
  });
}
