/// A clip still waiting in the outbox, as History's "Waiting for signal" section shows it (P6 design
/// §2.9; P6-HISTORY-04, -05): "Clip from today, 14:32", a subtitle that says why it waits, and
/// "Pending". Not a button: there is nothing to open yet.
final class HistoryWaitingClip {
  const HistoryWaitingClip({
    required this.idempotencyKey,
    required this.capturedAtOnPhone,
    required this.status,
  });

  /// The clip's key, which hides the row once the clip's outcome has an entry.
  final String idempotencyKey;

  /// When the phone recorded it, by its own clock, in UTC.
  final DateTime capturedAtOnPhone;

  final HistoryWaitingClipStatus status;
}

/// Why a clip still waits: the row's subtitle (P6 design §2.9).
enum HistoryWaitingClipStatus {
  /// No answer yet, or not tried yet: "Will identify when you're back online".
  waitingForSignal,

  /// The server was busy or limited the phone: "Look Up is busy — will try again soon".
  busy,

  /// The update gate holds the outbox: "Waiting for a newer version of Look Up".
  waitingForUpdate,
}
