import 'dart:io';

import 'package:flutter/widgets.dart' show Locale;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/deferred_result_handler.dart';
import 'package:lookup_listener/app/history_answer_reader.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/outbox/outbox_index.dart';
import 'package:lookup_listener/core/outbox/outbox_item.dart';
import 'package:lookup_listener/features/history/data/history_repository.dart';
import 'package:lookup_listener/features/history/data/history_store.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/identify/domain/deferred_result_sink.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

import '../support/fake_clock.dart';
import '../support/fake_device_services.dart';
import '../support/history_fixtures.dart';
import '../support/recording_client_error_reporter.dart';

const LockFileOwner _owner = LockFileOwner(
  processId: 4242,
  engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
);
const String _recognitionId = HistoryFixtures.fixtureRecognitionId;
const String _clipKey = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c21';
final DateTime _capturedAt = DateTime.utc(2026, 10, 13, 11, 40);

/// A plugin that checks, as it posts, that History already holds the entry the notification opens.
final class _HistoryCheckingDeviceServices extends FakeDeviceServices {
  _HistoryCheckingDeviceServices();

  late HistoryRepository history;
  final List<bool> wasInHistoryWhenPosted = [];

  @override
  Future<void> showSavedClipNotification({
    required int notificationId,
    required String title,
    required String text,
    required String recognitionId,
    required String channelName,
    required String channelDescription,
  }) async {
    wasInHistoryWhenPosted.add(await history.wasNotified(recognitionId));
    await super.showSavedClipNotification(
      notificationId: notificationId,
      title: title,
      text: text,
      recognitionId: recognitionId,
      channelName: channelName,
      channelDescription: channelDescription,
    );
  }
}

/// Where a saved clip's outcome goes (P6 design §2.16, §3.11, §3.15; amendment A6; P6-OFFLINE-17 to
/// -21; P6-HISTORY-04 to -06): History first, then a notification with the same words for every
/// outcome, which opens the entry by its id.
void main() {
  late Directory folder;
  late HistoryRepository history;
  late _HistoryCheckingDeviceServices deviceServices;
  late DeferredResultHandler handler;
  final words = lookupAppLocalizations(const Locale('en'));

  setUp(() {
    folder = Directory.systemTemp.createTempSync('deferred_result_handler_test_');
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
    deviceServices = _HistoryCheckingDeviceServices()..history = history;
    handler = DeferredResultHandler(history: history, deviceServices: deviceServices, words: words);
  });

  Future<HistoryEntry> onlyEntry() async => (await history.readView()).entries.single;

  test('a match: kept in History as a result of this clip, then one notification that names '
      'nothing of the ad and opens it by its id', () async {
    await handler.record(
      DeferredClipMatched(
        idempotencyKey: _clipKey,
        capturedAtOnPhone: _capturedAt,
        recognitionId: _recognitionId,
        answerBody: HistoryFixtures.answer('valid/match-campaign'),
      ),
    );

    final entry = await onlyEntry() as HistoryResultEntry;
    expect(entry.entryId, _recognitionId);
    expect(entry.deferredIdempotencyKey, _clipKey);
    expect(entry.capturedAtOnPhone, _capturedAt);
    expect(await history.wasNotified(_recognitionId), isTrue);

    final posted = deviceServices.posted.single;
    expect(deviceServices.wasInHistoryWhenPosted, [isTrue], reason: 'History first');
    expect(posted.recognitionId, _recognitionId);
    expect(posted.notificationId, DeferredResultHandler.notificationIdFor(_recognitionId));
    expect(posted.title, 'Look Up');
    expect(posted.text, 'Your saved clip has been checked. Tap to see the result.');
    expect(posted.channelName, words.savedClipNotificationChannelName);
    expect(posted.channelDescription, words.savedClipNotificationChannelDescription);
    for (final adWord in ['Brand A', 'Summer', 'Station']) {
      expect('${posted.title} ${posted.text}', isNot(contains(adWord)));
    }
  });

  test('"Which station?": kept to choose later, and notified the same way', () async {
    await handler.record(
      DeferredClipAwaitingChoice(
        idempotencyKey: _clipKey,
        capturedAtOnPhone: _capturedAt,
        recognitionId: _recognitionId,
        answerBody: HistoryFixtures.answer('valid/choose-station'),
      ),
    );

    final entry = await onlyEntry() as HistoryAwaitingChoiceEntry;
    expect(entry.candidates, hasLength(2));
    expect(entry.deferredIdempotencyKey, _clipKey);
    expect(deviceServices.posted.single.text, words.savedClipNotificationText);
  });

  test('ACCOUNT_REQUIRED (LA-APP-09): kept as a scan waiting for an account, then the same notification, which opens it', () async {
    await handler.record(
      DeferredClipAwaitingAccount(
        idempotencyKey: _clipKey,
        capturedAtOnPhone: _capturedAt,
        recognitionId: _recognitionId,
        answerBody: HistoryFixtures.answer('valid/account-required'),
      ),
    );

    final entry = await onlyEntry() as HistoryAwaitingAccountEntry;
    expect(entry.entryId, _recognitionId);
    expect(entry.deferredIdempotencyKey, _clipKey);
    expect(entry.capturedAtOnPhone, _capturedAt);
    expect(await history.wasNotified(_recognitionId), isTrue);
    final posted = deviceServices.posted.single;
    expect(deviceServices.wasInHistoryWhenPosted, [isTrue], reason: 'History first');
    expect(posted.recognitionId, _recognitionId);
    expect(posted.text, words.savedClipNotificationText, reason: 'the words never name the ad, the station or the outcome');
  });

  test('a result already kept is never undone by a replay of the withheld answer', () async {
    await handler.record(
      DeferredClipMatched(
        idempotencyKey: _clipKey,
        capturedAtOnPhone: _capturedAt,
        recognitionId: _recognitionId,
        answerBody: HistoryFixtures.answer('valid/match-campaign'),
      ),
    );
    await handler.record(
      DeferredClipAwaitingAccount(
        idempotencyKey: _clipKey,
        capturedAtOnPhone: _capturedAt,
        recognitionId: _recognitionId,
        answerBody: HistoryFixtures.answer('valid/account-required'),
      ),
    );
    expect(await onlyEntry(), isA<HistoryResultEntry>());
  });

  test('not recognised: kept under the recognition id, and notified', () async {
    await handler.record(
      DeferredClipNotIdentified(
        idempotencyKey: _clipKey,
        capturedAtOnPhone: _capturedAt,
        reason: DeferredClipNotIdentifiedReason.notRecognised,
        recognitionId: _recognitionId,
      ),
    );

    final entry = await onlyEntry() as HistoryNotIdentifiedEntry;
    expect(entry.entryId, _recognitionId);
    expect(entry.reason, DeferredClipNotIdentifiedReason.notRecognised);
    expect(deviceServices.posted.single.recognitionId, _recognitionId);
  });

  for (final reason in [
    DeferredClipNotIdentifiedReason.notSentWithin24Hours,
    DeferredClipNotIdentifiedReason.couldNotBeChecked,
  ]) {
    test('${reason.name}: kept under the clip\'s own key, with no notification', () async {
      await handler.record(
        DeferredClipNotIdentified(
          idempotencyKey: _clipKey,
          capturedAtOnPhone: _capturedAt,
          reason: reason,
        ),
      );

      final entry = await onlyEntry() as HistoryNotIdentifiedEntry;
      expect(entry.entryId, _clipKey);
      expect(entry.reason, reason);
      expect(deviceServices.posted, isEmpty);
      expect(await history.wasNotified(_clipKey), isFalse);
    });
  }

  test(
    'notifications off: kept in History, nothing posted, and no launch id may open it',
    () async {
      deviceServices.areNotificationsOn = false;
      await handler.record(
        DeferredClipMatched(
          idempotencyKey: _clipKey,
          capturedAtOnPhone: _capturedAt,
          recognitionId: _recognitionId,
          answerBody: HistoryFixtures.answer('valid/match-campaign'),
        ),
      );

      expect(await onlyEntry(), isA<HistoryResultEntry>());
      expect(deviceServices.posted, isEmpty);
      expect(await history.wasNotified(_recognitionId), isFalse);
    },
  );

  test('clips deleted unsent are kept as rows with their reasons, never notified', () async {
    DeferredClipItem clip(String key) => DeferredClipItem(
      itemId: 'item-$key',
      queuedAt: _capturedAt,
      idempotencyKey: key,
      capturedAt: _capturedAt,
      clipDurationMilliseconds: 8000,
      codec: 'aac',
      audioFileName: '$key.m4a',
      audioSizeBytes: 10,
      savedReason: DeferredClipSavedReason.noConnection,
    );
    const otherKey = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c22';
    await handler.recordExpiredClips([
      OutboxExpiredClip(item: clip(_clipKey), reason: OutboxClipExpiry.notSentWithin24Hours),
      OutboxExpiredClip(item: clip(otherKey), reason: OutboxClipExpiry.captureTimeAheadOfTheClock),
    ]);

    final reasons = {
      for (final entry in (await history.readView()).entries.cast<HistoryNotIdentifiedEntry>())
        entry.entryId: entry.reason,
    };
    expect(reasons, {
      _clipKey: DeferredClipNotIdentifiedReason.notSentWithin24Hours,
      otherKey: DeferredClipNotIdentifiedReason.couldNotBeChecked,
    });
    expect(deviceServices.posted, isEmpty);
  });

  test('a notification id is the same for the same entry, positive, and differs between two '
      '(FNV-1a, 31 bits)', () {
    expect(DeferredResultHandler.notificationIdFor(_recognitionId), 1003864669);
    expect(
      DeferredResultHandler.notificationIdFor('0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f71'),
      987087050,
    );
    expect(DeferredResultHandler.notificationIdFor(''), 18652613);
  });
}
