import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/history/domain/history_waiting_clip.dart';

/// What the History tab shows (P6 design §2.9): the clips still waiting for a signal, oldest first
/// (P6-HISTORY-04), and the saved entries, newest first by the phone's capture time
/// (P6-HISTORY-07). A waiting clip whose outcome already has an entry is left out, so the listener
/// never sees both while the outbox deletes the item (§3.9).
final class HistoryView {
  HistoryView(
    Iterable<HistoryEntry> entries, {
    Iterable<HistoryWaitingClip> waitingClips = const [],
  }) : entries = List.unmodifiable(
         <HistoryEntry>[...entries]
           ..sort((first, second) => second.capturedAtOnPhone.compareTo(first.capturedAtOnPhone)),
       ),
       waitingClips = List.unmodifiable(_withoutAnswered(waitingClips, entries));

  /// A History with nothing in it.
  static final HistoryView empty = HistoryView(const []);

  /// Newest first.
  final List<HistoryEntry> entries;

  /// The clips still waiting, oldest capture first.
  final List<HistoryWaitingClip> waitingClips;

  /// Whether there is nothing to show: the designed empty state (P6-HISTORY-13).
  bool get isEmpty => entries.isEmpty && waitingClips.isEmpty;

  /// The results among [entries], newest first.
  List<HistoryResultEntry> get results => entries.whereType<HistoryResultEntry>().toList();

  /// The saved result of [recognitionId], or null when History does not hold one.
  HistoryResultEntry? resultFor(String recognitionId) =>
      results.where((entry) => entry.entryId == recognitionId).firstOrNull;

  /// The saved chooser of [recognitionId], or null when History holds none.
  HistoryAwaitingChoiceEntry? awaitingChoiceFor(String recognitionId) => entries
      .whereType<HistoryAwaitingChoiceEntry>()
      .where((entry) => entry.entryId == recognitionId)
      .firstOrNull;

  /// Whether History holds the result of [recognitionId]: the Result's "Saved to History"
  /// (P6-HISTORY-14).
  bool holdsResult(String recognitionId) => resultFor(recognitionId) != null;

  static List<HistoryWaitingClip> _withoutAnswered(
    Iterable<HistoryWaitingClip> waitingClips,
    Iterable<HistoryEntry> entries,
  ) {
    final answered = {for (final entry in entries) ?entry.deferredIdempotencyKey};
    return [
      for (final clip in waitingClips)
        if (!answered.contains(clip.idempotencyKey)) clip,
    ]..sort((first, second) => first.capturedAtOnPhone.compareTo(second.capturedAtOnPhone));
  }
}
