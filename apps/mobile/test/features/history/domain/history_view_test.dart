import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/history/domain/history_view.dart';
import 'package:lookup_listener/features/history/domain/history_waiting_clip.dart';
import 'package:lookup_listener/features/identify/domain/deferred_result_sink.dart';

const String _keyOne = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c21';
const String _keyTwo = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c22';

HistoryWaitingClip _waiting(String key, {required DateTime capturedAt}) => HistoryWaitingClip(
  idempotencyKey: key,
  capturedAtOnPhone: capturedAt,
  status: HistoryWaitingClipStatus.waitingForSignal,
);

/// What History shows (P6 design §2.9, §3.9; P6-HISTORY-04, -06, -07): the clips still waiting,
/// oldest first, and the entries, newest first by the phone's capture time.
void main() {
  final now = DateTime.utc(2026, 10, 13, 12);

  test('a clip whose outcome History already holds is no longer shown as waiting', () {
    final view = HistoryView(
      [
        HistoryNotIdentifiedEntry(
          entryId: _keyOne,
          capturedAtOnPhone: now,
          reason: DeferredClipNotIdentifiedReason.notRecognised,
          deferredIdempotencyKey: _keyOne,
        ),
      ],
      waitingClips: [
        _waiting(_keyOne, capturedAt: now),
        _waiting(_keyTwo, capturedAt: now),
      ],
    );
    expect(view.waitingClips.map((clip) => clip.idempotencyKey), [_keyTwo]);
  });

  test('waiting clips are listed oldest capture first; entries newest first', () {
    final view = HistoryView(
      [
        HistoryNotIdentifiedEntry(
          entryId: 'a',
          capturedAtOnPhone: now.subtract(const Duration(hours: 2)),
          reason: DeferredClipNotIdentifiedReason.notRecognised,
        ),
        HistoryNotIdentifiedEntry(
          entryId: 'b',
          capturedAtOnPhone: now,
          reason: DeferredClipNotIdentifiedReason.notRecognised,
        ),
      ],
      waitingClips: [
        _waiting(_keyTwo, capturedAt: now),
        _waiting(_keyOne, capturedAt: now.subtract(const Duration(minutes: 5))),
      ],
    );
    expect(view.waitingClips.map((clip) => clip.idempotencyKey), [_keyOne, _keyTwo]);
    expect(view.entries.map((entry) => entry.entryId), ['b', 'a']);
  });

  test('empty only with no entry and no waiting clip (P6-HISTORY-13)', () {
    expect(HistoryView.empty.isEmpty, isTrue);
    expect(
      HistoryView(const [], waitingClips: [_waiting(_keyOne, capturedAt: now)]).isEmpty,
      isFalse,
    );
  });
}
