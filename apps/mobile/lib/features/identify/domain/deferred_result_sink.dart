/// What a clip sent from the outbox came to (P6 design §3.11; contract R13), handed to History and
/// the notification through [DeferredResultSink].
///
/// Each carries the clip's idempotency key, so History can hide the clip's waiting row once its
/// entry exists, and the phone's capture time, which orders History (contract §5.14).
sealed class DeferredClipOutcome {
  const DeferredClipOutcome({required this.idempotencyKey, required this.capturedAtOnPhone});

  /// The saved clip's key (lower-case UUID).
  final String idempotencyKey;

  /// When the phone recorded the clip, by its own clock, in UTC.
  final DateTime capturedAtOnPhone;
}

/// A `MATCH`: the campaign's card or the advertiser's usual one, kept with the answer exactly as it
/// came, and opened by its notification (P6-OFFLINE-21).
final class DeferredClipMatched extends DeferredClipOutcome {
  const DeferredClipMatched({
    required super.idempotencyKey,
    required super.capturedAtOnPhone,
    required this.recognitionId,
    required this.answerBody,
  });

  /// The recognition id: a lower-case UUID version 7, which keys the History entry.
  final String recognitionId;

  /// The API's 200 answer as it came.
  final Map<String, Object?> answerBody;
}

/// A `CHOOSE_STATION`: History keeps it waiting for the listener's choice, and its notification opens
/// the chooser (T51).
final class DeferredClipAwaitingChoice extends DeferredClipOutcome {
  const DeferredClipAwaitingChoice({
    required super.idempotencyKey,
    required super.capturedAtOnPhone,
    required this.recognitionId,
    required this.answerBody,
  });

  final String recognitionId;
  final Map<String, Object?> answerBody;
}

/// An `ACCOUNT_REQUIRED` (ADR-005): the saved clip was recognised as an ad, but its result waits for the listener's
/// account. History keeps a row that opens the account gate, and the notification (which says nothing of the ad)
/// brings the listener to it.
final class DeferredClipAwaitingAccount extends DeferredClipOutcome {
  const DeferredClipAwaitingAccount({
    required super.idempotencyKey,
    required super.capturedAtOnPhone,
    required this.recognitionId,
    required this.answerBody,
  });

  final String recognitionId;
  final Map<String, Object?> answerBody;
}

/// A clip that will never be identified: not recognised, or deleted unsent (P6 design §3.11).
final class DeferredClipNotIdentified extends DeferredClipOutcome {
  const DeferredClipNotIdentified({
    required super.idempotencyKey,
    required super.capturedAtOnPhone,
    required this.reason,
    this.recognitionId,
  });

  /// The recognition id when the server made one (a `NO_MATCH`); null otherwise, when History keys
  /// the entry by the idempotency key.
  final String? recognitionId;

  final DeferredClipNotIdentifiedReason reason;
}

/// Why a saved clip was not identified: History's words for it (P6 design §2.9, §3.11).
enum DeferredClipNotIdentifiedReason {
  /// `NO_MATCH` or `INVALID_AUDIO`: "Not recognised". The listener is told by a notification.
  notRecognised('NOT_RECOGNISED', isNotified: true),

  /// Deleted unsent at 24 hours, or refused as `CAPTURE_EXPIRED`: "Not sent within 24 hours —
  /// deleted". No notification.
  notSentWithin24Hours('NOT_SENT_WITHIN_24_HOURS', isNotified: false),

  /// Refused as `CAPTURE_TIME_INVALID`, an answer that could not be read, or a capture time more
  /// than 2 minutes ahead of the phone's clock: "Couldn't be checked — deleted". No notification.
  couldNotBeChecked('COULD_NOT_BE_CHECKED', isNotified: false);

  const DeferredClipNotIdentifiedReason(this.storedName, {required this.isNotified});

  /// The name History's file keeps (`not_identified_reason`).
  final String storedName;

  /// Whether the listener gets a notification for it (P6 design §2.16).
  final bool isNotified;

  /// The reason stored as [storedName], or null.
  static DeferredClipNotIdentifiedReason? fromStoredName(Object? storedName) {
    for (final reason in values) {
      if (reason.storedName == storedName) return reason;
    }
    return null;
  }
}

/// Where a saved clip's outcome goes (P6 design §3.2, §3.11): History first, then the notification.
/// An interface, because the identify feature's data never imports History's (P6-D46); `lib/app`
/// implements it.
abstract interface class DeferredResultSink {
  /// Keeps [outcome] in History, keyed so that a replay of the same answer adds nothing (contract
  /// R13), then posts its notification when it has one. Throws when History cannot keep it.
  Future<void> record(DeferredClipOutcome outcome);
}
