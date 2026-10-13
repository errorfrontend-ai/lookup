import 'outbox_action.dart';
import 'outbox_item_kind.dart';
import 'outbox_send_answer.dart';
import 'outbox_timing_rules.dart';

/// Which [OutboxAction] an answer leads to, per item kind (P6 design §3.9 point 8; contract §3 R9,
/// with the default rows of P6-D39). Pure: the same kind and answer always give the same action.
///
/// Every row of `fixtures/listener-outbox/acknowledgement-rules.json` is a test, and so is every
/// status from 200 to 599 for every kind: an unknown code is handled by its status, and an unknown
/// status by its class. In short:
/// - the route's success deletes; any other 2xx deletes too, except for a clip, whose recognize
///   route answers only 200 (deleted with a report); a 3xx is never followed, so it deletes with a
///   report, except for a crash report;
/// - a clip's `INVALID_AUDIO` and its `CAPTURE_EXPIRED` or `CAPTURE_TIME_INVALID` delete without a
///   report (the server could never use it); any other 4xx deletes with a report, because the phone
///   sent something wrong; a crash report is never reported about;
/// - 401 registers again and resends (a crash report carries no token, so it is deleted);
/// - 409 waits its `Retry-After`, 3 s without one;
/// - 426 pauses everything until the app version changes; a crash report, whose route never answers
///   426, backs off;
/// - 429 pauses the item's group for its `Retry-After`, 60 s without one;
/// - 502, 503 and 504 pause the group for a `Retry-After`; without one a clip's group waits a random
///   60 to 300 s (P6-D38) and any other item backs off;
/// - 500 and every other 5xx back off; no answer backs off and ends the run (amendment A1);
/// - a fault on the phone deletes with a report (never one about a crash report).
abstract final class OutboxAcknowledgementPolicy {
  /// The action for an item of [kind] answered [answer].
  static OutboxAction decide(OutboxItemKind kind, OutboxSendAnswer answer) => switch (answer) {
    OutboxNoAnswer() => const OutboxItemBacksOff(endsRun: true),
    OutboxPhoneFault() => OutboxDelete(isReported: kind != OutboxItemKind.clientErrorReport),
    OutboxHttpAnswer() => _decideHttp(kind, answer),
  };

  static OutboxAction _decideHttp(OutboxItemKind kind, OutboxHttpAnswer answer) {
    final isClip = kind == OutboxItemKind.deferredClip;
    final isCrashReport = kind == OutboxItemKind.clientErrorReport;
    final code = answer.errorCode;
    final retryAfterSeconds = answer.retryAfterSeconds;
    final honouredRetryAfterSeconds = retryAfterSeconds == null
        ? null
        : OutboxTimingRules.honouredRetryAfterSeconds(retryAfterSeconds);
    return switch (answer.httpStatus) {
      final status when status == _successStatusOf(kind) =>
        isClip && answer.isBodyUnreadable
            ? const OutboxDelete(isReported: true)
            : const OutboxDelete(isReported: false),
      >= 200 && < 300 => OutboxDelete(isReported: isClip),
      >= 300 && < 400 => OutboxDelete(isReported: !isCrashReport),
      400 when isClip && code == _invalidAudio => const OutboxDelete(isReported: false),
      401 =>
        isCrashReport
            ? const OutboxDelete(isReported: false)
            : const OutboxRegisterAgainAndResend(),
      409 => OutboxItemWaits(
        seconds: honouredRetryAfterSeconds ?? OutboxTimingRules.defaultInProgressRetryAfterSeconds,
      ),
      422 when isClip && _permanentCaptureRefusals.contains(code) => const OutboxDelete(
        isReported: false,
      ),
      426 =>
        isCrashReport
            ? const OutboxItemBacksOff(endsRun: false)
            : const OutboxPauseAllUntilAppVersionChanges(),
      429 => OutboxPauseGroup(
        wait: OutboxWaitSeconds(
          honouredRetryAfterSeconds ?? OutboxTimingRules.defaultLimitedRetryAfterSeconds,
        ),
      ),
      >= 400 && < 500 => OutboxDelete(isReported: !isCrashReport),
      502 || 503 || 504 => switch (honouredRetryAfterSeconds) {
        final seconds? => OutboxPauseGroup(wait: OutboxWaitSeconds(seconds)),
        null when isClip => const OutboxPauseGroup(
          wait: OutboxWaitRandomSeconds(
            minimumSeconds: OutboxTimingRules.deferredShedRetryAfterMinimumSeconds,
            maximumSeconds: OutboxTimingRules.deferredShedRetryAfterMaximumSeconds,
          ),
        ),
        null => const OutboxItemBacksOff(endsRun: false),
      },
      // 500 and every other 5xx; and a status outside 200 to 599, which no route answers: the item
      // is kept, so nothing the listener did is lost, and it expires in time if it never settles.
      _ => const OutboxItemBacksOff(endsRun: false),
    };
  }

  /// The status each kind's route answers on success: 200 for a clip's recognize, 202 for a crash
  /// report, 204 for a choice, a tap and a report (contract §1.2 to §1.7).
  static int _successStatusOf(OutboxItemKind kind) => switch (kind) {
    OutboxItemKind.deferredClip => 200,
    OutboxItemKind.clientErrorReport => 202,
    OutboxItemKind.stationChoice ||
    OutboxItemKind.engagement ||
    OutboxItemKind.recognitionReport => 204,
  };

  static const String _invalidAudio = 'INVALID_AUDIO';
  static const Set<String> _permanentCaptureRefusals = {'CAPTURE_EXPIRED', 'CAPTURE_TIME_INVALID'};
}
