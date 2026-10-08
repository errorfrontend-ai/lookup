import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_problem_report.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/domain/send_policy.dart';

/// What the flow does after one send, as `SendPolicy` decided it from the answer (§3.11, S4-D10).
///
/// Sealed, so the flow handles every kind with no default branch. Each kind says the state to show
/// next and whether the clip stays in memory; the kinds that send the clip again also carry the
/// policy for that next send, with its counts moved on.
sealed class RecognitionOutcome {
  const RecognitionOutcome();

  /// The state the flow moves to now.
  RecognitionState get nextState;

  /// Whether the clip stays in memory for another send of it. When false the flow drops it at once
  /// (S4-D7).
  bool get isClipKept;
}

/// The identify is over for this clip: show [nextState] (matched, fallback, no match, idle after a
/// cancel, or an error other than "no connection") and drop the clip.
final class FinishedOutcome extends RecognitionOutcome {
  const FinishedOutcome(this.nextState, {this.problemReport});

  @override
  final RecognitionState nextState;

  /// The crash report to send, when the answer is one a developer must hear about; null otherwise.
  final RecognitionProblemReport? problemReport;

  @override
  bool get isClipKept => false;
}

/// No answer came back: show "No connection" and keep the clip, so "Send again" resends it with
/// the same key, which the server answers as a replay if it had it (S4-D12). The counts do not
/// move: nothing was answered.
final class ConnectionLostOutcome extends RecognitionOutcome {
  const ConnectionLostOutcome();

  @override
  RecognitionState get nextState => const ErrorState(failure: ConnectionFailure());

  @override
  bool get isClipKept => true;
}

/// The API had no room (502, 503, 504): show Busy counting down [retryDelaySeconds], keep the
/// clip, and send it again when the countdown ends or on "Try now".
final class BusyOutcome extends RecognitionOutcome {
  const BusyOutcome({required this.retryDelaySeconds, required this.nextPolicy});

  /// From `Retry-After`, clamped to 1–60 seconds; 10 when missing or unreadable.
  final int retryDelaySeconds;

  final SendPolicy nextPolicy;

  @override
  RecognitionState get nextState =>
      BusyState(retryDelaySeconds: retryDelaySeconds, secondsUntilRetry: retryDelaySeconds);

  @override
  bool get isClipKept => true;
}

/// The API is still identifying this clip (409): stay on Identifying, wait [waitSeconds], then send
/// the same clip with the same key again (T22).
final class WaitAndResendOutcome extends RecognitionOutcome {
  const WaitAndResendOutcome({required this.waitSeconds, required this.nextPolicy});

  /// From `Retry-After`, clamped to 1–60 seconds; 3 when missing or unreadable.
  final int waitSeconds;

  final SendPolicy nextPolicy;

  @override
  RecognitionState get nextState => const UploadingState();

  @override
  bool get isClipKept => true;
}

/// The install token was refused (401): stay on Identifying, register again with the same install
/// id, then send the same clip again (T23).
final class RegisterAgainOutcome extends RecognitionOutcome {
  const RegisterAgainOutcome({required this.nextPolicy});

  final SendPolicy nextPolicy;

  @override
  RecognitionState get nextState => const UploadingState();

  @override
  bool get isClipKept => true;
}
