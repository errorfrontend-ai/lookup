import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/history_answer_reader.dart';
import 'package:lookup_listener/app/notification_launch_handler.dart';
import 'package:lookup_listener/app/pending_destination.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/features/history/data/history_repository.dart';
import 'package:lookup_listener/features/history/data/history_store.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/identify/domain/deferred_result_sink.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';

import '../support/fake_clock.dart';
import '../support/fake_device_services.dart';
import '../support/history_fixtures.dart';
import '../support/recording_client_error_reporter.dart';

const LockFileOwner _owner = LockFileOwner(
  processId: 4242,
  engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
);
const String _resultId = HistoryFixtures.fixtureRecognitionId;
const String _clipKey = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c21';
final DateTime _capturedAt = DateTime.utc(2026, 10, 13, 11, 40);

/// A saved clip's notification, tapped (P6 design §2.16, §3.15; P6-OFFLINE-21, P6-STRUCTURE-02):
/// what its recognition id opens, and that nothing else can be opened through it.
void main() {
  late Directory folder;
  late HistoryRepository history;
  late FakeDeviceServices deviceServices;
  late PendingDestination pendingDestination;
  late RecognitionState flowState;
  late List<String> wentTo;
  late List<HistoryAwaitingChoiceEntry> openedChoosers;
  late NotificationLaunchHandler handler;

  setUp(() {
    folder = Directory.systemTemp.createTempSync('notification_launch_handler_test_');
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
    deviceServices = FakeDeviceServices();
    pendingDestination = PendingDestination();
    flowState = const IdleState();
    wentTo = [];
    openedChoosers = [];
    handler = NotificationLaunchHandler(
      deviceServices: deviceServices,
      history: history,
      pendingDestination: pendingDestination,
      readFlowState: () => flowState,
      go: wentTo.add,
      openSavedChooser: openedChoosers.add,
    );
    addTearDown(handler.dispose);
  });

  Future<void> saveResult({required bool wasNotified}) => history.saveResult(
    recognitionId: _resultId,
    answer: HistoryFixtures.answer('valid/match-campaign'),
    capturedAtOnPhone: _capturedAt,
    deferredIdempotencyKey: _clipKey,
    wasNotified: wasNotified,
  );

  group('opens what History holds for a notified id', () {
    test('a result opens at /r/<id> (P6-STRUCTURE-02)', () async {
      await saveResult(wasNotified: true);
      await handler.open(_resultId);
      expect(wentTo, ['/r/$_resultId']);
      expect(pendingDestination.value, isNull);
    });

    test(
      'a station still to choose opens "Which station?" from the saved candidates (T51)',
      () async {
        await history.saveAwaitingChoice(
          recognitionId: _resultId,
          answer: HistoryFixtures.answer('valid/choose-station'),
          capturedAtOnPhone: _capturedAt,
          deferredIdempotencyKey: _clipKey,
          wasNotified: true,
        );
        await handler.open(_resultId);
        expect(openedChoosers.single.entryId, _resultId);
        expect(openedChoosers.single.candidates, hasLength(2));
        expect(wentTo, isEmpty);
      },
    );

    test('a clip not recognised opens the History tab', () async {
      await history.saveNotIdentified(
        entryId: _resultId,
        capturedAtOnPhone: _capturedAt,
        reason: DeferredClipNotIdentifiedReason.notRecognised,
        deferredIdempotencyKey: _clipKey,
        wasNotified: true,
      );
      await handler.open(_resultId);
      expect(wentTo, ['/history']);
    });
  });

  group('during an identify nothing is interrupted: the place is kept for later', () {
    setUp(() => flowState = const UploadingState());

    test('a result', () async {
      await saveResult(wasNotified: true);
      await handler.open(_resultId);
      expect(wentTo, isEmpty);
      expect(pendingDestination.value, '/r/$_resultId');
    });

    test('a chooser is reached from its History row', () async {
      await history.saveAwaitingChoice(
        recognitionId: _resultId,
        answer: HistoryFixtures.answer('valid/choose-station'),
        capturedAtOnPhone: _capturedAt,
        deferredIdempotencyKey: _clipKey,
        wasNotified: true,
      );
      await handler.open(_resultId);
      expect(openedChoosers, isEmpty);
      expect(pendingDestination.value, '/history');
    });
  });

  group('anything else is ignored (fact 26: MainActivity is exported)', () {
    test('an id History holds with no notification posted for it', () async {
      await saveResult(wasNotified: false);
      await handler.open(_resultId);
      expect(wentTo, isEmpty);
    });

    test('an id History does not hold', () async {
      await handler.open(_resultId);
      expect(wentTo, isEmpty);
    });

    for (final notAnId in [
      _resultId.toUpperCase(),
      '../../settings',
      '/settings/privacy',
      '$_resultId/extra',
      '',
    ]) {
      test('"$notAnId", which is not a lower-case UUID, is never looked up', () async {
        await saveResult(wasNotified: true);
        await handler.open(notAnId);
        expect(wentTo, isEmpty);
        expect(openedChoosers, isEmpty);
        expect(pendingDestination.value, isNull);
      });
    }

    test('History that cannot be read: the app opens as it was, and nothing is thrown', () async {
      await saveResult(wasNotified: true);
      File('${folder.path}/index.json').writeAsStringSync('not json');
      await handler.open(_resultId);
      expect(wentTo, isEmpty);
    });
  });

  group('start', () {
    test('opens the id the app was started with, once', () async {
      await saveResult(wasNotified: true);
      deviceServices.pendingLaunchRecognitionId = _resultId;
      await handler.start();
      expect(wentTo, ['/r/$_resultId']);
      await handler.start();
      expect(wentTo, hasLength(1));
    });

    test('then each tap while the app runs', () async {
      await saveResult(wasNotified: true);
      await handler.start();
      expect(wentTo, isEmpty);
      deviceServices.tapNotification(_resultId);
      await pumpEventQueue();
      expect(wentTo, ['/r/$_resultId']);
    });
  });
}
