import 'package:lookup_listener/features/history/domain/history_entry.dart';

/// What the History tab shows (P6 design §2.9): the saved entries, newest first by the phone's
/// capture time (P6-HISTORY-07). The clips still waiting for a signal join it in piece 3.
final class HistoryView {
  HistoryView(Iterable<HistoryEntry> entries)
    : entries = List.unmodifiable(
        <HistoryEntry>[...entries]
          ..sort((first, second) => second.capturedAtOnPhone.compareTo(first.capturedAtOnPhone)),
      );

  /// A History with nothing in it.
  static final HistoryView empty = HistoryView(const []);

  /// Newest first.
  final List<HistoryEntry> entries;

  /// Whether there is nothing to show: the designed empty state (P6-HISTORY-13).
  bool get isEmpty => entries.isEmpty;

  /// The results among [entries], newest first.
  List<HistoryResultEntry> get results => entries.whereType<HistoryResultEntry>().toList();

  /// The saved result of [recognitionId], or null when History does not hold one.
  HistoryResultEntry? resultFor(String recognitionId) =>
      results.where((entry) => entry.entryId == recognitionId).firstOrNull;

  /// Whether History holds the result of [recognitionId]: the Result's "Saved to History"
  /// (P6-HISTORY-14).
  bool holdsResult(String recognitionId) => resultFor(recognitionId) != null;
}
