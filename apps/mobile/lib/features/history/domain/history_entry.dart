import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// One thing History keeps on the phone (P6 design §2.9, §3.14), read again from the answer the API
/// sent each time it is shown.
///
/// Sealed, so every row selector is an exhaustive switch. Piece 2 keeps the results the listener
/// saw; the entries of a clip saved with no signal (a station still to choose, or a clip that was
/// never identified) join them with the outbox's clips in piece 3, in the same file format.
sealed class HistoryEntry {
  const HistoryEntry({required this.entryId, required this.capturedAtOnPhone});

  /// The recognition id: a lower-case UUID version 7, which keys the entry, so a replay of the same
  /// answer never adds a second one (contract R13).
  final String entryId;

  /// When the phone recorded the clip, by its own clock, in UTC: what the row shows and what orders
  /// History, so a row never jumps when its answer arrives (contract §5.14, P6-D33).
  final DateTime capturedAtOnPhone;
}

/// A result the listener saw: the campaign's card, the advertiser's usual card, or the card of the
/// station they chose in "Which station?" (P6-HISTORY-01). It opens again at `/r/<recognition id>`
/// with no request, so its buttons work without data (P6-HISTORY-02, -11).
final class HistoryResultEntry extends HistoryEntry {
  const HistoryResultEntry({
    required super.entryId,
    required super.capturedAtOnPhone,
    required this.result,
  });

  /// The result, as the answer's reader reads the stored answer today.
  final RecognitionResult result;

  @override
  String toString() => 'HistoryResultEntry($entryId: ${result.clientName}, ${result.title})';
}
