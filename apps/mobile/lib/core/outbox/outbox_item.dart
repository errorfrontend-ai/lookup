import 'outbox_item_kind.dart';

/// One thing the phone must still send (P6 design §3.8): what it is, when it was queued, how often
/// it was tried, when it may be tried again, and why the last try failed.
///
/// Immutable: the store replaces an item with [retried] after a failed send. No item holds a phone
/// number, a label, a link, free text, the install id or the token (§3.8).
///
/// Sealed, so the sender and the index file handle every kind with no default branch. Piece 1 has
/// station choices; the other kinds of [OutboxItemKind] arrive with the pieces that queue them.
sealed class OutboxItem {
  const OutboxItem({
    required this.itemId,
    required this.queuedAt,
    this.attemptCount = 0,
    this.nextAttemptAt,
    this.lastProblem,
  });

  /// A lower-case version-4 UUID made when the item was queued: which item, for the store.
  final String itemId;

  /// When it was queued, on the phone's clock, in UTC. Follow-up items are deleted unsent 7 days
  /// after it (§3.8), and are sent oldest first (P6-OFFLINE-11).
  final DateTime queuedAt;

  /// How many times it was sent and not settled; the n of the backoff (§3.9 point 9).
  final int attemptCount;

  /// Not sent before this time (UTC); null when it may be sent now.
  final DateTime? nextAttemptAt;

  /// Why the last send did not settle it, for History's subtitle; null before any failure.
  final OutboxItemProblem? lastProblem;

  OutboxItemKind get kind;

  /// The key the server deduplicates retries by (contract R12): the same on every send of this
  /// item, different for two items (P6-OUTBOX-03).
  String get idempotencyKey;

  /// This item after a send that did not settle it: one attempt more, and when it may go again.
  OutboxItem retried({required DateTime? nextAttemptAt, required OutboxItemProblem? lastProblem});
}

/// The listener's choice in "Which station?" (T44): `POST /recognitions/{recognition_id}/choice`
/// with `{"station_id": …}` (contract §1.3). One per recognition: the first choice wins, here as on
/// the server. The "Remember" tick never leaves the phone.
final class StationChoiceItem extends OutboxItem {
  const StationChoiceItem({
    required super.itemId,
    required super.queuedAt,
    required this.recognitionId,
    required this.stationId,
    super.attemptCount,
    super.nextAttemptAt,
    super.lastProblem,
  });

  /// The chooser's recognition: a lower-case UUID version 7, named by the route's path.
  final String recognitionId;

  /// The tapped station's id, the body's only field.
  final String stationId;

  @override
  OutboxItemKind get kind => OutboxItemKind.stationChoice;

  /// The recognition: the server keeps one choice per recognition (contract R12).
  @override
  String get idempotencyKey => recognitionId;

  @override
  StationChoiceItem retried({
    required DateTime? nextAttemptAt,
    required OutboxItemProblem? lastProblem,
  }) => StationChoiceItem(
    itemId: itemId,
    queuedAt: queuedAt,
    recognitionId: recognitionId,
    stationId: stationId,
    attemptCount: attemptCount + 1,
    nextAttemptAt: nextAttemptAt,
    lastProblem: lastProblem,
  );

  @override
  String toString() =>
      'StationChoiceItem($itemId, recognition $recognitionId, station $stationId, '
      'attempts $attemptCount)';
}

/// Why the last send of an item did not settle it (P6 design §3.8 `last_problem`), which History's
/// waiting row turns into words from piece 3.
enum OutboxItemProblem {
  /// No answer came: no signal, a timeout or a dropped connection.
  noAnswer('NO_ANSWER'),

  /// The server was busy or failed (5xx, a 409's wait).
  busy('BUSY'),

  /// The server limited the phone (429).
  limited('LIMITED'),

  /// The server needs a newer app (426).
  updateRequired('UPDATE_REQUIRED');

  const OutboxItemProblem(this.storedName);

  /// The name written in the index file.
  final String storedName;

  /// The problem stored as [storedName], or null.
  static OutboxItemProblem? fromStoredName(Object? storedName) {
    for (final problem in values) {
      if (problem.storedName == storedName) return problem;
    }
    return null;
  }
}
