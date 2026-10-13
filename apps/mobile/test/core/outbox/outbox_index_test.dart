import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/outbox/outbox_index.dart';
import 'package:lookup_listener/core/outbox/outbox_item.dart';
import 'package:lookup_listener/core/outbox/outbox_timing_rules.dart';

const String _keyOne = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const String _keyTwo = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2e';
const String _keyThree = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2f';
const String _stationHint = '0192a6c4-1111-4000-8000-000000000001';
final DateTime _now = DateTime.utc(2026, 10, 13, 12);

DeferredClipItem _clip(
  String key, {
  required DateTime capturedAt,
  String? stationHintId,
  DateTime? nextAttemptAt,
  OutboxItemProblem? lastProblem,
}) => DeferredClipItem(
  itemId: 'item-$key',
  queuedAt: capturedAt,
  idempotencyKey: key,
  capturedAt: capturedAt,
  clipDurationMilliseconds: 8000,
  codec: 'aac',
  stationHintId: stationHintId,
  audioFileName: '$key.m4a',
  audioSizeBytes: 24000,
  savedReason: DeferredClipSavedReason.noConnection,
  attemptCount: lastProblem == null ? 0 : 1,
  nextAttemptAt: nextAttemptAt,
  lastProblem: lastProblem,
);

ClientErrorReportItem _report(String reportId, {required DateTime queuedAt}) =>
    ClientErrorReportItem(
      itemId: 'report-$reportId',
      queuedAt: queuedAt,
      reportId: reportId,
      occurredAt: queuedAt.subtract(const Duration(seconds: 3)),
      fields: const {'kind': 'reported', 'message': 'Saving the result to History failed'},
    );

/// Reads [index] back the way the store does: written as JSON, then read.
({OutboxIndex index, int unreadableItemCount}) _roundTrip(OutboxIndex index) =>
    OutboxIndex.fromJson(jsonDecode(jsonEncode(index.toJson())));

/// The outbox index's saved clips and queued crash reports (P6 design §3.8, §3.20; P6-OFFLINE-03,
/// -04, -05; P6-D37): what is written for them, when they run out, and the network's return.
void main() {
  group('on disk', () {
    test('a saved clip keeps its key, capture time, hint, file, size and reason', () {
      final clip = _clip(
        _keyOne,
        capturedAt: DateTime.utc(2026, 10, 13, 11, 58, 30, 250),
        stationHintId: _stationHint,
      );
      final read = _roundTrip(OutboxIndex(items: [clip]));

      expect(read.unreadableItemCount, 0);
      final back = read.index.items.single as DeferredClipItem;
      expect(back.kind.group.name, 'clips');
      expect(back.idempotencyKey, _keyOne);
      expect(back.capturedAt, DateTime.utc(2026, 10, 13, 11, 58, 30, 250));
      expect(back.clipDurationMilliseconds, 8000);
      expect(back.codec, 'aac');
      expect(back.stationHintId, _stationHint);
      expect(back.audioFileName, '$_keyOne.m4a');
      expect(back.audioSizeBytes, 24000);
      expect(back.savedReason, DeferredClipSavedReason.noConnection);
    });

    test('a clip with no hint is read back with none', () {
      final read = _roundTrip(OutboxIndex(items: [_clip(_keyOne, capturedAt: _now)]));
      expect((read.index.items.single as DeferredClipItem).stationHintId, isNull);
    });

    test('each saved reason is written by name and read back', () {
      for (final reason in DeferredClipSavedReason.values) {
        final clip = _clip(_keyOne, capturedAt: _now);
        final withReason = DeferredClipItem(
          itemId: clip.itemId,
          queuedAt: clip.queuedAt,
          idempotencyKey: clip.idempotencyKey,
          capturedAt: clip.capturedAt,
          clipDurationMilliseconds: clip.clipDurationMilliseconds,
          codec: clip.codec,
          audioFileName: clip.audioFileName,
          audioSizeBytes: clip.audioSizeBytes,
          savedReason: reason,
        );
        final json = OutboxIndex(items: [withReason]).toJson();
        expect(jsonEncode(json), contains('"saved_reason":"${reason.storedName}"'));
        expect(
          (_roundTrip(OutboxIndex(items: [withReason])).index.items.single as DeferredClipItem)
              .savedReason,
          reason,
        );
      }
    });

    test('a clip whose file name is a path, or not a key, is left out and counted', () {
      final good = OutboxIndex(items: [_clip(_keyOne, capturedAt: _now)]).toJson();
      for (final badName in [
        '../$_keyOne.m4a',
        'clips/$_keyOne.m4a',
        'audio.m4a',
        '$_keyOne.mp3',
      ]) {
        final tampered = jsonDecode(jsonEncode(good)) as Map<String, Object?>;
        ((tampered['items']! as List<Object?>).single! as Map<String, Object?>)['audio_file'] =
            badName;
        final read = OutboxIndex.fromJson(tampered);
        expect(read.index.items, isEmpty, reason: badName);
        expect(read.unreadableItemCount, 1, reason: badName);
      }
    });

    test('a queued crash report keeps its report id, time and fields', () {
      final report = _report('5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a', queuedAt: _now);
      final back =
          _roundTrip(OutboxIndex(items: [report])).index.items.single as ClientErrorReportItem;
      expect(back.kind.group.name, 'crashReports');
      expect(back.reportId, '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a');
      expect(back.occurredAt, _now.subtract(const Duration(seconds: 3)));
      expect(back.fields, {'kind': 'reported', 'message': 'Saving the result to History failed'});
    });

    test('a crash report whose fields are not all text is left out', () {
      final json = OutboxIndex(
        items: [_report('5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a', queuedAt: _now)],
      ).toJson();
      final tampered = jsonDecode(jsonEncode(json)) as Map<String, Object?>;
      ((tampered['items']! as List<Object?>).single! as Map<String, Object?>)['fields'] = {
        'kind': 'reported',
        'count': 3,
      };
      final read = OutboxIndex.fromJson(tampered);
      expect(read.index.items, isEmpty);
      expect(read.unreadableItemCount, 1);
    });
  });

  test('clips are listed oldest capture first, whatever the order they were added in', () {
    final index = OutboxIndex(
      items: [
        _clip(_keyTwo, capturedAt: _now.subtract(const Duration(minutes: 5))),
        _clip(_keyThree, capturedAt: _now.subtract(const Duration(minutes: 1))),
        _clip(_keyOne, capturedAt: _now.subtract(const Duration(minutes: 9))),
      ],
    );
    expect(index.clips.map((clip) => clip.idempotencyKey), [_keyOne, _keyTwo, _keyThree]);
  });

  group('a clip runs out (P6-OFFLINE-05, P6-D37)', () {
    test('23 hours 58 minutes after its capture, not a moment before', () {
      final capturedAt = _now.subtract(OutboxTimingRules.clipKeptFor);
      final justInTime = _clip(_keyOne, capturedAt: capturedAt.add(const Duration(seconds: 1)));
      final due = _clip(_keyTwo, capturedAt: capturedAt);
      final index = OutboxIndex(items: [justInTime, due]);

      final expired = index.expiredClips(_now);
      expect(expired.map((clip) => clip.item.idempotencyKey), [_keyTwo]);
      expect(expired.single.reason, OutboxClipExpiry.notSentWithin24Hours);
      expect(
        index.withoutExpired(now: _now, appVersion: '0.3.0').items.map((item) => item.itemId),
        [justInTime.itemId],
      );
      expect(OutboxTimingRules.clipKeptFor, const Duration(hours: 23, minutes: 58));
    });

    test('at once when its capture time is more than 2 minutes ahead of the clock', () {
      final allowed = _clip(_keyOne, capturedAt: _now.add(const Duration(minutes: 2)));
      final ahead = _clip(_keyTwo, capturedAt: _now.add(const Duration(minutes: 2, seconds: 1)));
      final index = OutboxIndex(items: [allowed, ahead]);

      final expired = index.expiredClips(_now);
      expect(expired.map((clip) => clip.item.idempotencyKey), [_keyTwo]);
      expect(expired.single.reason, OutboxClipExpiry.captureTimeAheadOfTheClock);
      expect(index.withoutExpired(now: _now, appVersion: '0.3.0').items, [allowed]);
    });

    test('a crash report runs out 7 days after it was queued, as a follow-up does', () {
      final lifetime = const Duration(seconds: OutboxTimingRules.followUpItemLifetimeSeconds);
      final kept = _report('a', queuedAt: _now.subtract(lifetime).add(const Duration(seconds: 1)));
      final due = _report('b', queuedAt: _now.subtract(lifetime));
      final index = OutboxIndex(items: [kept, due]);
      expect(index.withoutExpired(now: _now, appVersion: '0.3.0').items, [kept]);
      expect(index.expiredClips(_now), isEmpty, reason: 'History keeps rows for clips only');
    });

    test('nothing to cut leaves the very same index', () {
      final index = OutboxIndex(items: [_clip(_keyOne, capturedAt: _now)]);
      expect(identical(index.withoutExpired(now: _now, appVersion: '0.3.0'), index), isTrue);
    });
  });

  group('the network comes back (P6 design §3.9 point 9)', () {
    test('waits that came from no answer are cleared; waits the server asked for stay', () {
      final later = _now.add(const Duration(minutes: 4));
      final noAnswer = _clip(
        _keyOne,
        capturedAt: _now,
        nextAttemptAt: later,
        lastProblem: OutboxItemProblem.noAnswer,
      );
      final busy = _clip(
        _keyTwo,
        capturedAt: _now,
        nextAttemptAt: later,
        lastProblem: OutboxItemProblem.busy,
      );
      final cleared = OutboxIndex(items: [noAnswer, busy]).withNoAnswerWaitsCleared();

      final clearedClip = cleared.itemWithId(noAnswer.itemId)!;
      expect(clearedClip.nextAttemptAt, isNull);
      expect(clearedClip.attemptCount, noAnswer.attemptCount, reason: 'no attempt counted');
      expect(clearedClip.lastProblem, OutboxItemProblem.noAnswer);
      expect(cleared.itemWithId(busy.itemId)!.nextAttemptAt, later);
    });

    test('with no such wait, the very same index', () {
      final index = OutboxIndex(
        items: [
          _clip(
            _keyOne,
            capturedAt: _now,
            nextAttemptAt: _now.add(const Duration(minutes: 1)),
            lastProblem: OutboxItemProblem.limited,
          ),
        ],
      );
      expect(identical(index.withNoAnswerWaitsCleared(), index), isTrue);
    });
  });
}
