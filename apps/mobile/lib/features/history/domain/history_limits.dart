/// How much History keeps (P6 design §3.14, Q7 as the user answered it on 11 October 2026): at
/// most [maximumEntries], none older than [longestKept] by the phone's capture time, the oldest
/// going first. History records which ads someone heard, and a withdrawn number should not stay
/// callable for ever (gap 20).
abstract final class HistoryLimits {
  /// The most entries kept.
  static const int maximumEntries = 50;

  /// How long an entry is kept after its clip was recorded.
  static const Duration longestKept = Duration(days: 30);

  /// Whether an entry recorded at [capturedAtOnPhone] is past [longestKept] at [now].
  static bool isExpired(DateTime capturedAtOnPhone, {required DateTime now}) =>
      now.difference(capturedAtOnPhone) > longestKept;
}
