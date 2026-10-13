/// The outbox's three groups, by the server allowance their items use (P6 design §3.9, P6-D38). A
/// `Retry-After` pauses only the group whose allowance ran out, so a deferred clip's long 429 never
/// holds back a listener's choice, a tap or a crash report.
enum OutboxItemGroup {
  /// Saved clips: the recognize route's deferred allowance.
  clips('CLIPS'),

  /// Station choices, button taps and reports, which share the server's follow-up allowance.
  followUps('FOLLOW_UPS'),

  /// Crash reports: the public `/client-errors` route.
  crashReports('CRASH_REPORTS');

  const OutboxItemGroup(this.storedName);

  /// The name written in the outbox's index file.
  final String storedName;

  /// The group stored as [storedName], or null for a name this version does not know.
  static OutboxItemGroup? fromStoredName(Object? storedName) {
    for (final group in values) {
      if (group.storedName == storedName) return group;
    }
    return null;
  }
}
