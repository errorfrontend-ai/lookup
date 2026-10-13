import 'dart:math';

/// The outbox's numbers (P6 design §3.8, §3.9; contract §3): limits on the phone, how long items
/// live, the waits and the backoff. The constants equal `fixtures/listener-outbox/timing-rules.json`
/// in `packages/contracts`, which the API and the contracts mirror too; a test compares them.
///
/// Two of them can be lowered in a development build, so emulator walkthroughs do not wait two
/// minutes (amendment A1; `AppConfiguration`): the sending delay's maximum and the backoff's first
/// wait. Staging and production refuse any other value at start-up, so they always use 120 and 30.
final class OutboxTimingRules {
  const OutboxTimingRules({
    this.sendingDelayMaximumSeconds = standardSendingDelayMaximumSeconds,
    this.backoffFirstWaitSeconds = standardBackoffFirstWaitSeconds,
  }) : assert(
         sendingDelayMaximumSeconds >= 0 &&
             sendingDelayMaximumSeconds <= standardSendingDelayMaximumSeconds,
         'The sending delay is at most the standard 120 seconds.',
       ),
       assert(
         backoffFirstWaitSeconds >= 1 && backoffFirstWaitSeconds <= standardBackoffFirstWaitSeconds,
         'The backoff starts at 1 to 30 seconds.',
       );

  /// The rules of every staging and production build.
  static const OutboxTimingRules standard = OutboxTimingRules();

  // The values of timing-rules.json, by its own names.
  static const int maximumStoredClips = 5;
  static const int storedClipLifetimeSeconds = 86400;
  static const int followUpItemLifetimeSeconds = 604800;
  static const int maximumFollowUpItems = 200;
  static const int maximumQueuedClientErrorReports = 20;
  static const int standardSendingDelayMaximumSeconds = 120;
  static const int sendingDelayForNewItemWhileOnlineMaximumSeconds = 10;
  static const int deferredShedRetryAfterMinimumSeconds = 60;
  static const int deferredShedRetryAfterMaximumSeconds = 300;
  static const int longestHonouredRetryAfterSeconds = 3600;
  static const int standardBackoffFirstWaitSeconds = 30;
  static const int backoffLongestWaitSeconds = 1800;
  static const double backoffLowestJitterFactor = 0.5;
  static const int registrationsAfterRefusedTokenPerRun = 1;
  static const int deferredAllowancePerHour = 10;
  static const int liveServerWaitMilliseconds = 2500;
  static const int deferredServerWaitMilliseconds = 5000;

  /// The shortest `Retry-After` honoured: a zero or a negative one waits a second (contract R8).
  static const int shortestHonouredRetryAfterSeconds = 1;

  /// The waits the acknowledgement table gives when the header is missing: 3 s after a 409, 60 s
  /// after a 429 (`acknowledgement-rules.json`).
  static const int defaultInProgressRetryAfterSeconds = 3;
  static const int defaultLimitedRetryAfterSeconds = 60;

  /// While a 426 holds the outbox, one item is sent at each app start and every 6 hours to see
  /// whether the gate has gone (amendment A2).
  static const Duration updatePauseProbeInterval = Duration(hours: 6);

  /// A stored wait further away than this is cut to it: the phone's clock went back after the wait
  /// was set (P6 design §3.9 point 9).
  static const Duration longestStoredWait = Duration(hours: 1);

  /// How often a run looks again while the listener's own identify is under way (§3.9 point 7).
  static const Duration liveIdentifyCheckInterval = Duration(seconds: 1);

  /// The largest random wait a run draws before its first send: 0 to this many whole seconds
  /// (P6-OFFLINE-12).
  final int sendingDelayMaximumSeconds;

  /// The backoff's first wait, before the random factor (§3.9 point 9).
  final int backoffFirstWaitSeconds;

  /// The largest random wait for a run started by an item queued after the last run had emptied
  /// the queue: 10 seconds, or less when the sending delay is lower still.
  int get newItemSendingDelayMaximumSeconds =>
      min(sendingDelayForNewItemWhileOnlineMaximumSeconds, sendingDelayMaximumSeconds);

  /// A `Retry-After` of [seconds], clamped to 1 to 3,600 (contract R8).
  static int honouredRetryAfterSeconds(int seconds) =>
      seconds.clamp(shortestHonouredRetryAfterSeconds, longestHonouredRetryAfterSeconds);

  /// The wait after an item's [failureCount]-th failure: `min(first × 2^(n−1), 1800)` seconds times
  /// a random factor from 0.5 to 1.0, drawn from [random] (P6-OUTBOX-04).
  Duration backoffAfter({required int failureCount, required Random random}) {
    final doublings = (failureCount < 1 ? 1 : failureCount) - 1;
    // 2^11 × 1 s already passes the 1,800-second ceiling, so larger exponents change nothing.
    final baseSeconds = min(
      backoffFirstWaitSeconds * pow(2, min(doublings, 11)).toInt(),
      backoffLongestWaitSeconds,
    );
    final factor =
        backoffLowestJitterFactor + random.nextDouble() * (1 - backoffLowestJitterFactor);
    return Duration(milliseconds: (baseSeconds * Duration.millisecondsPerSecond * factor).round());
  }

  @override
  bool operator ==(Object other) =>
      other is OutboxTimingRules &&
      other.sendingDelayMaximumSeconds == sendingDelayMaximumSeconds &&
      other.backoffFirstWaitSeconds == backoffFirstWaitSeconds;

  @override
  int get hashCode => Object.hash(sendingDelayMaximumSeconds, backoffFirstWaitSeconds);

  @override
  String toString() =>
      'OutboxTimingRules(sendingDelayMaximumSeconds: $sendingDelayMaximumSeconds, '
      'backoffFirstWaitSeconds: $backoffFirstWaitSeconds)';
}
