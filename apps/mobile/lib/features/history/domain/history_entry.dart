import 'package:lookup_listener/features/identify/domain/deferred_result_sink.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// One thing History keeps on the phone (P6 design §2.9, §3.14), read again from the answer the API
/// sent each time it is shown.
///
/// Sealed, so every row selector is an exhaustive switch: the results the listener saw, and from
/// piece 3 the outcomes of clips saved with no signal: a station still to choose, or a clip that
/// will never be identified.
sealed class HistoryEntry {
  const HistoryEntry({
    required this.entryId,
    required this.capturedAtOnPhone,
    this.deferredIdempotencyKey,
  });

  /// The recognition id: a lower-case UUID version 7, which keys the entry, so a replay of the same
  /// answer never adds a second one (contract R13). A clip that never got one (deleted unsent) is
  /// keyed by its idempotency key instead.
  final String entryId;

  /// The key of the saved clip this entry is the outcome of; null for an identify made live. The
  /// clip's waiting row is hidden once its entry exists (P6 design §3.9).
  final String? deferredIdempotencyKey;

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
    super.deferredIdempotencyKey,
    this.isReported = false,
  });

  /// The result, as the answer's reader reads the stored answer today.
  final RecognitionResult result;

  /// Whether the listener reported it ("Report this", P6 design §2.14).
  final bool isReported;

  @override
  String toString() => 'HistoryResultEntry($entryId: ${result.clientName}, ${result.title})';
}

/// A saved clip answered `CHOOSE_STATION` while the app was away (P6 design §2.9, §3.11): the row says
/// "Choose your station to see the buttons" and opens the chooser from the stored candidates, with no
/// request (T51). Once a station is chosen it becomes a [HistoryResultEntry].
final class HistoryAwaitingChoiceEntry extends HistoryEntry {
  HistoryAwaitingChoiceEntry({
    required super.entryId,
    required super.capturedAtOnPhone,
    required List<RecognitionResult> candidates,
    required Map<String, Object?> answerBody,
    super.deferredIdempotencyKey,
  }) : candidates = List.unmodifiable(candidates),
       answerBody = Map.unmodifiable(answerBody);

  /// The stations the server offered, in its order, each with its card.
  final List<RecognitionResult> candidates;

  /// The answer exactly as it came, kept again with the station the listener chooses (T44).
  final Map<String, Object?> answerBody;

  @override
  String toString() => 'HistoryAwaitingChoiceEntry($entryId: ${candidates.length} stations)';
}

/// A saved clip that will never be identified (P6 design §2.9, §3.11): not recognised, deleted
/// unsent at 24 hours, or one that could not be checked. Not a button: there is nothing to open.
final class HistoryNotIdentifiedEntry extends HistoryEntry {
  const HistoryNotIdentifiedEntry({
    required super.entryId,
    required super.capturedAtOnPhone,
    required this.reason,
    super.deferredIdempotencyKey,
  });

  final DeferredClipNotIdentifiedReason reason;

  @override
  String toString() => 'HistoryNotIdentifiedEntry($entryId: ${reason.name})';
}
