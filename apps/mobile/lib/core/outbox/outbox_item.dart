import 'outbox_item_kind.dart';

/// One thing the phone must still send (P6 design §3.8): what it is, when it was queued, how often
/// it was tried, when it may be tried again, and why the last try failed.
///
/// Immutable: the store replaces an item with [retried] after a failed send. No item holds a phone
/// number, a label, a link, free text, the install id or the token (§3.8).
///
/// Sealed, so the sender and the index file handle every kind with no default branch. Piece 1 has
/// station choices, piece 3 clips and crash reports; taps and reports arrive with the pieces that
/// queue them.
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

  /// This item waiting until [nextAttemptAt] instead, with no attempt counted: a wait the phone's
  /// clock stretched, cut back (§3.9 point 9).
  OutboxItem withNextAttemptAt(DateTime nextAttemptAt);

  /// This item with no wait of its own and no attempt counted: the network came back, so a wait
  /// that came from "no answer" has lost its reason (§3.9 point 9).
  OutboxItem withoutWait();
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
  StationChoiceItem withNextAttemptAt(DateTime nextAttemptAt) => StationChoiceItem(
    itemId: itemId,
    queuedAt: queuedAt,
    recognitionId: recognitionId,
    stationId: stationId,
    attemptCount: attemptCount,
    nextAttemptAt: nextAttemptAt,
    lastProblem: lastProblem,
  );

  @override
  StationChoiceItem withoutWait() => StationChoiceItem(
    itemId: itemId,
    queuedAt: queuedAt,
    recognitionId: recognitionId,
    stationId: stationId,
    attemptCount: attemptCount,
    lastProblem: lastProblem,
  );

  @override
  String toString() =>
      'StationChoiceItem($itemId, recognition $recognitionId, station $stationId, '
      'attempts $attemptCount)';
}

/// "Report this" (P6 design §2.14; Q6): `POST /recognitions/{recognition_id}/report` with
/// `{"station_id": …, "reason": …}` (contract §1.6). One per recognition: the first report wins, here
/// as on the server; no free text is ever kept or sent.
/// A button tap on a result (P6 design §3.8, T54; P6-OUTBOX-06): `POST /engagements` with the ids and
/// the time of the first tap. One per recognition and button: a second tap of the same button
/// changes nothing, here as on the server. The button's type, label, number or link never travel.
final class EngagementItem extends OutboxItem {
  const EngagementItem({
    required super.itemId,
    required super.queuedAt,
    required this.recognitionId,
    required this.stationId,
    required this.actionId,
    required this.occurredAt,
    super.attemptCount,
    super.nextAttemptAt,
    super.lastProblem,
  });

  /// The recognition whose card was shown (lower-case UUID).
  final String recognitionId;

  /// The station whose card was shown (the chosen one after "Which station?").
  final String stationId;

  /// The button's `id` on that card.
  final String actionId;

  /// When the button was first tapped, by the phone's clock (UTC); each send adds when it left, so
  /// the server can correct a wrong clock (Q16).
  final DateTime occurredAt;

  @override
  OutboxItemKind get kind => OutboxItemKind.engagement;

  /// One tap per recognition and button (contract R12).
  @override
  String get idempotencyKey => '$recognitionId/$actionId';

  @override
  EngagementItem retried({
    required DateTime? nextAttemptAt,
    required OutboxItemProblem? lastProblem,
  }) => EngagementItem(
    itemId: itemId,
    queuedAt: queuedAt,
    recognitionId: recognitionId,
    stationId: stationId,
    actionId: actionId,
    occurredAt: occurredAt,
    attemptCount: attemptCount + 1,
    nextAttemptAt: nextAttemptAt,
    lastProblem: lastProblem,
  );

  @override
  EngagementItem withNextAttemptAt(DateTime nextAttemptAt) => EngagementItem(
    itemId: itemId,
    queuedAt: queuedAt,
    recognitionId: recognitionId,
    stationId: stationId,
    actionId: actionId,
    occurredAt: occurredAt,
    attemptCount: attemptCount,
    nextAttemptAt: nextAttemptAt,
    lastProblem: lastProblem,
  );

  @override
  EngagementItem withoutWait() => EngagementItem(
    itemId: itemId,
    queuedAt: queuedAt,
    recognitionId: recognitionId,
    stationId: stationId,
    actionId: actionId,
    occurredAt: occurredAt,
    attemptCount: attemptCount,
    lastProblem: lastProblem,
  );

  @override
  String toString() =>
      'EngagementItem($itemId, recognition $recognitionId, action $actionId, '
      'attempts $attemptCount)';
}

final class RecognitionReportItem extends OutboxItem {
  const RecognitionReportItem({
    required super.itemId,
    required super.queuedAt,
    required this.recognitionId,
    required this.stationId,
    required this.reason,
    super.attemptCount,
    super.nextAttemptAt,
    super.lastProblem,
  });

  /// The recognition reported (lower-case UUID).
  final String recognitionId;

  /// The station whose result was shown (the chosen one after "Which station?").
  final String stationId;

  /// The contract's reason, e.g. `LOOKS_LIKE_A_SCAM`.
  final String reason;

  /// The contract's four reasons (`RECOGNITION_REPORT_REASONS`).
  static const Set<String> reasons = {
    'WRONG_OR_MISLEADING_BUTTONS',
    'NUMBER_OR_LINK_DOES_NOT_WORK',
    'LOOKS_LIKE_A_SCAM',
    'SOMETHING_ELSE',
  };

  @override
  OutboxItemKind get kind => OutboxItemKind.recognitionReport;

  /// One report per recognition: the server keeps the first.
  @override
  String get idempotencyKey => recognitionId;

  @override
  RecognitionReportItem retried({
    required DateTime? nextAttemptAt,
    required OutboxItemProblem? lastProblem,
  }) => RecognitionReportItem(
    itemId: itemId,
    queuedAt: queuedAt,
    recognitionId: recognitionId,
    stationId: stationId,
    reason: reason,
    attemptCount: attemptCount + 1,
    nextAttemptAt: nextAttemptAt,
    lastProblem: lastProblem,
  );

  @override
  RecognitionReportItem withNextAttemptAt(DateTime nextAttemptAt) => RecognitionReportItem(
    itemId: itemId,
    queuedAt: queuedAt,
    recognitionId: recognitionId,
    stationId: stationId,
    reason: reason,
    attemptCount: attemptCount,
    nextAttemptAt: nextAttemptAt,
    lastProblem: lastProblem,
  );

  @override
  RecognitionReportItem withoutWait() => RecognitionReportItem(
    itemId: itemId,
    queuedAt: queuedAt,
    recognitionId: recognitionId,
    stationId: stationId,
    reason: reason,
    attemptCount: attemptCount,
    lastProblem: lastProblem,
  );

  @override
  String toString() =>
      'RecognitionReportItem($itemId, recognition $recognitionId, attempts $attemptCount)';
}

/// A clip kept on the phone because the live send got no answer, stayed busy or was limited (T21′,
/// T24′, T27′, T31′), sent later with `is_deferred` "true" (contract R1, R2). The recording itself
/// is the file [audioFileName] in the outbox's `clips/` folder, written and flushed before the item
/// was added; the item never holds the audio.
///
/// It keeps the live send's [idempotencyKey], [capturedAt] and [stationHintId], so a resend is the
/// same clip to the server, whose recognition is replayed rather than made twice (P6-OUTBOX-03).
/// Deleted unsent 23 hours 58 minutes after [capturedAt] by the phone's clock, or at once when
/// [capturedAt] is more than 2 minutes ahead of the clock (P6-D37).
final class DeferredClipItem extends OutboxItem {
  const DeferredClipItem({
    required super.itemId,
    required super.queuedAt,
    required this.idempotencyKey,
    required this.capturedAt,
    required this.clipDurationMilliseconds,
    required this.codec,
    required this.audioFileName,
    required this.audioSizeBytes,
    required this.savedReason,
    this.stationHintId,
    super.attemptCount,
    super.nextAttemptAt,
    super.lastProblem,
  });

  /// The key made when the clip was captured (lower-case UUID), sent on every attempt.
  @override
  final String idempotencyKey;

  /// When the phone recorded the clip, by its own clock, in UTC: the `captured_at` of every send,
  /// and what orders the clips (contract R7).
  final DateTime capturedAt;

  /// The clip's length, as the live send gave it.
  final int clipDurationMilliseconds;

  /// The contract's codec name, e.g. `aac`.
  final String codec;

  /// "My station" when the clip was captured, or null; never read again at send time (contract
  /// §1.2).
  final String? stationHintId;

  /// The recording's file name inside `outbox/clips/`, e.g. `<idempotency key>.m4a`.
  final String audioFileName;

  /// The recording's size in bytes, as written.
  final int audioSizeBytes;

  /// Why the live flow kept it, for the Saved screen's words.
  final DeferredClipSavedReason savedReason;

  @override
  OutboxItemKind get kind => OutboxItemKind.deferredClip;

  @override
  DeferredClipItem retried({
    required DateTime? nextAttemptAt,
    required OutboxItemProblem? lastProblem,
  }) =>
      _copy(attemptCount: attemptCount + 1, nextAttemptAt: nextAttemptAt, lastProblem: lastProblem);

  @override
  DeferredClipItem withNextAttemptAt(DateTime nextAttemptAt) =>
      _copy(attemptCount: attemptCount, nextAttemptAt: nextAttemptAt, lastProblem: lastProblem);

  @override
  DeferredClipItem withoutWait() =>
      _copy(attemptCount: attemptCount, nextAttemptAt: null, lastProblem: lastProblem);

  DeferredClipItem _copy({
    required int attemptCount,
    required DateTime? nextAttemptAt,
    required OutboxItemProblem? lastProblem,
  }) => DeferredClipItem(
    itemId: itemId,
    queuedAt: queuedAt,
    idempotencyKey: idempotencyKey,
    capturedAt: capturedAt,
    clipDurationMilliseconds: clipDurationMilliseconds,
    codec: codec,
    stationHintId: stationHintId,
    audioFileName: audioFileName,
    audioSizeBytes: audioSizeBytes,
    savedReason: savedReason,
    attemptCount: attemptCount,
    nextAttemptAt: nextAttemptAt,
    lastProblem: lastProblem,
  );

  @override
  String toString() =>
      'DeferredClipItem($itemId, key $idempotencyKey, captured $capturedAt, attempts $attemptCount)';
}

/// Why the live flow kept a clip for later (P6 design §2.8): the Saved screen's three reasons.
enum DeferredClipSavedReason {
  /// No answer to the live send (T27′).
  noConnection('NO_CONNECTION'),

  /// Busy on the fourth send, or the app hidden during Busy (T21′, T31′).
  busy('BUSY'),

  /// A 429 to the live send (T24′).
  tooManyTries('TOO_MANY_TRIES');

  const DeferredClipSavedReason(this.storedName);

  /// The name written in the index file.
  final String storedName;

  /// The reason stored as [storedName], or null.
  static DeferredClipSavedReason? fromStoredName(Object? storedName) {
    for (final reason in values) {
      if (reason.storedName == storedName) return reason;
    }
    return null;
  }
}

/// A crash report that got no answer (P6 design §3.20; P6-ERRORREPORTING-05): the fields the
/// reporter had already scrubbed, with [occurredAt], sent to `POST /client-errors` with [reportId]
/// as its `X-Request-Id` on every attempt (P6-D43). It never carries the install token.
final class ClientErrorReportItem extends OutboxItem {
  ClientErrorReportItem({
    required super.itemId,
    required super.queuedAt,
    required this.reportId,
    required this.occurredAt,
    required Map<String, String> fields,
    super.attemptCount,
    super.nextAttemptAt,
    super.lastProblem,
  }) : fields = Map.unmodifiable(fields);

  /// A lower-case version-4 UUID made when the report was queued.
  final String reportId;

  /// When the error happened, by the phone's clock, in UTC: the body's `occurredAt`.
  final DateTime occurredAt;

  /// The report's body as the reporter built it (`source`, `kind`, `message`, and `stack`,
  /// `location`, `relatedRequestId`, `appVersion` when present), already scrubbed.
  final Map<String, String> fields;

  @override
  OutboxItemKind get kind => OutboxItemKind.clientErrorReport;

  /// The report's id: the same `X-Request-Id` on every send, so the API's log shows one report
  /// even when an answer was lost (P6-OUTBOX-03 for crash reports).
  @override
  String get idempotencyKey => reportId;

  @override
  ClientErrorReportItem retried({
    required DateTime? nextAttemptAt,
    required OutboxItemProblem? lastProblem,
  }) => ClientErrorReportItem(
    itemId: itemId,
    queuedAt: queuedAt,
    reportId: reportId,
    occurredAt: occurredAt,
    fields: fields,
    attemptCount: attemptCount + 1,
    nextAttemptAt: nextAttemptAt,
    lastProblem: lastProblem,
  );

  @override
  ClientErrorReportItem withNextAttemptAt(DateTime nextAttemptAt) => ClientErrorReportItem(
    itemId: itemId,
    queuedAt: queuedAt,
    reportId: reportId,
    occurredAt: occurredAt,
    fields: fields,
    attemptCount: attemptCount,
    nextAttemptAt: nextAttemptAt,
    lastProblem: lastProblem,
  );

  @override
  ClientErrorReportItem withoutWait() => ClientErrorReportItem(
    itemId: itemId,
    queuedAt: queuedAt,
    reportId: reportId,
    occurredAt: occurredAt,
    fields: fields,
    attemptCount: attemptCount,
    lastProblem: lastProblem,
  );

  @override
  String toString() => 'ClientErrorReportItem($itemId, report $reportId, attempts $attemptCount)';
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
