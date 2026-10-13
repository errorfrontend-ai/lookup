/// What the outbox does with an item after one answer (P6 design §3.9 point 8; contract §3 R9): the
/// `action` of a row of `fixtures/listener-outbox/acknowledgement-rules.json`, with its `wait`.
///
/// Sealed, so the sender applies every action with no default branch.
sealed class OutboxAction {
  const OutboxAction();
}

/// The item is settled, or can never be: it is deleted. With [isReported] a crash report says why,
/// because the phone sent something the server refused or could not read its answer.
final class OutboxDelete extends OutboxAction {
  const OutboxDelete({required this.isReported});

  final bool isReported;

  @override
  bool operator ==(Object other) => other is OutboxDelete && other.isReported == isReported;

  @override
  int get hashCode => Object.hash(OutboxDelete, isReported);

  @override
  String toString() => isReported ? 'DELETE_AND_REPORT' : 'DELETE';
}

/// The item is kept and waits exactly [seconds] (a 409's `Retry-After`, or 3); the others go on.
final class OutboxItemWaits extends OutboxAction {
  const OutboxItemWaits({required this.seconds});

  final int seconds;

  @override
  bool operator ==(Object other) => other is OutboxItemWaits && other.seconds == seconds;

  @override
  int get hashCode => Object.hash(OutboxItemWaits, seconds);

  @override
  String toString() => 'ITEM_WAITS $seconds s';
}

/// The item is kept and counts a failure: it waits the growing backoff. With [endsRun] (no answer)
/// the run ends too, and the wake-up after the wait starts the next one (amendment A1).
final class OutboxItemBacksOff extends OutboxAction {
  const OutboxItemBacksOff({required this.endsRun});

  final bool endsRun;

  @override
  bool operator ==(Object other) => other is OutboxItemBacksOff && other.endsRun == endsRun;

  @override
  int get hashCode => Object.hash(OutboxItemBacksOff, endsRun);

  @override
  String toString() => endsRun ? 'ITEM_BACKS_OFF_AND_RUN_ENDS' : 'ITEM_BACKS_OFF';
}

/// The item is kept and its whole group pauses for [wait]; the other groups go on (P6-D38).
final class OutboxPauseGroup extends OutboxAction {
  const OutboxPauseGroup({required this.wait});

  final OutboxWait wait;

  @override
  bool operator ==(Object other) => other is OutboxPauseGroup && other.wait == wait;

  @override
  int get hashCode => Object.hash(OutboxPauseGroup, wait);

  @override
  String toString() => 'PAUSE_GROUP $wait';
}

/// The item is kept and every group pauses until the app's version changes, or a probe gets any
/// answer but 426 (426 `APP_UPDATE_REQUIRED`; contract R11, amendment A2).
final class OutboxPauseAllUntilAppVersionChanges extends OutboxAction {
  const OutboxPauseAllUntilAppVersionChanges();

  @override
  bool operator ==(Object other) => other is OutboxPauseAllUntilAppVersionChanges;

  @override
  int get hashCode => (OutboxPauseAllUntilAppVersionChanges).hashCode;

  @override
  String toString() => 'PAUSE_ALL_UNTIL_APP_VERSION_CHANGES';
}

/// The token was refused (401): register again with the same install id, once per run, and send
/// the item again (contract R10).
final class OutboxRegisterAgainAndResend extends OutboxAction {
  const OutboxRegisterAgainAndResend();

  @override
  bool operator ==(Object other) => other is OutboxRegisterAgainAndResend;

  @override
  int get hashCode => (OutboxRegisterAgainAndResend).hashCode;

  @override
  String toString() => 'REGISTER_AGAIN_AND_RESEND';
}

/// How long a group pause lasts: a number of seconds, or a random number drawn from a range.
sealed class OutboxWait {
  const OutboxWait();
}

/// Exactly [seconds]: a `Retry-After` clamped to 1 to 3,600, or the table's default.
final class OutboxWaitSeconds extends OutboxWait {
  const OutboxWaitSeconds(this.seconds);

  final int seconds;

  @override
  bool operator ==(Object other) => other is OutboxWaitSeconds && other.seconds == seconds;

  @override
  int get hashCode => Object.hash(OutboxWaitSeconds, seconds);

  @override
  String toString() => '$seconds s';
}

/// A random whole number of seconds from [minimumSeconds] to [maximumSeconds], drawn when the pause
/// starts: a deferred clip's 502, 503 or 504 with no `Retry-After` (P6-D38).
final class OutboxWaitRandomSeconds extends OutboxWait {
  const OutboxWaitRandomSeconds({required this.minimumSeconds, required this.maximumSeconds});

  final int minimumSeconds;
  final int maximumSeconds;

  @override
  bool operator ==(Object other) =>
      other is OutboxWaitRandomSeconds &&
      other.minimumSeconds == minimumSeconds &&
      other.maximumSeconds == maximumSeconds;

  @override
  int get hashCode => Object.hash(OutboxWaitRandomSeconds, minimumSeconds, maximumSeconds);

  @override
  String toString() => '$minimumSeconds to $maximumSeconds s';
}
