import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// Where one identify stands: the nine top-level states of §2.12 (S4-STATE-03, S4-D4).
///
/// Sealed, with every subclass in this one library, so the router's redirect and every screen
/// selector are exhaustive switches with no default branch: a new state cannot compile without
/// its route and screen (S4-STATE-09). Each state carries only its own data, every field non-null
/// (S4-STATE-07); the clip itself is never part of a state, so a state can be logged or compared
/// without touching the recording.
sealed class RecognitionState {
  const RecognitionState();
}

/// Home: nothing under way. The only state that accepts a new identify (T41).
final class IdleState extends RecognitionState {
  const IdleState();

  @override
  bool operator ==(Object other) => other is IdleState;

  @override
  int get hashCode => (IdleState).hashCode;

  @override
  String toString() => 'IdleState()';
}

/// The Permission screen, in the variant [microphoneAccess] names (S4-D22).
final class PermissionNeededState extends RecognitionState {
  const PermissionNeededState({required this.microphoneAccess})
    : assert(
        microphoneAccess != MicrophoneAccess.granted,
        'With the microphone allowed, the flow records instead.',
      );

  /// Never [MicrophoneAccess.granted].
  final MicrophoneAccess microphoneAccess;

  @override
  bool operator ==(Object other) =>
      other is PermissionNeededState && other.microphoneAccess == microphoneAccess;

  @override
  int get hashCode => Object.hash(PermissionNeededState, microphoneAccess);

  @override
  String toString() => 'PermissionNeededState(microphoneAccess: ${microphoneAccess.name})';
}

/// Listening: the recorder is running.
final class RecordingState extends RecognitionState {
  const RecordingState({required this.levelFraction, required this.secondsLeft})
    : assert(levelFraction >= 0 && levelFraction <= 1, 'The level is a fraction from 0 to 1.'),
      assert(secondsLeft >= 0, 'The countdown never goes below zero.');

  /// The live input level, 0 (silence) to 1, which the ring and the level bars follow.
  final double levelFraction;

  /// The countdown: from the clip length in seconds down to 0 when the file is finished.
  final int secondsLeft;

  @override
  bool operator ==(Object other) =>
      other is RecordingState &&
      other.levelFraction == levelFraction &&
      other.secondsLeft == secondsLeft;

  @override
  int get hashCode => Object.hash(RecordingState, levelFraction, secondsLeft);

  @override
  String toString() => 'RecordingState(levelFraction: $levelFraction, secondsLeft: $secondsLeft)';
}

/// Identifying: registering when needed, sending, and the silent resends after a 409 or a 401.
final class UploadingState extends RecognitionState {
  const UploadingState();

  @override
  bool operator ==(Object other) => other is UploadingState;

  @override
  int get hashCode => (UploadingState).hashCode;

  @override
  String toString() => 'UploadingState()';
}

/// Result: the ad was on air, so the station's campaign card is shown.
final class MatchedState extends RecognitionState {
  const MatchedState({required this.result});

  final RecognitionResult result;

  @override
  bool operator ==(Object other) => other is MatchedState && identical(other.result, result);

  @override
  int get hashCode => Object.hash(MatchedState, result);

  @override
  String toString() => 'MatchedState(${result.clientName}: ${result.title})';
}

/// Result with the advertiser's default card: the ad was recognised but not on air then (S4-D21).
final class FallbackState extends RecognitionState {
  const FallbackState({required this.result});

  final RecognitionResult result;

  @override
  bool operator ==(Object other) => other is FallbackState && identical(other.result, result);

  @override
  int get hashCode => Object.hash(FallbackState, result);

  @override
  String toString() => 'FallbackState(${result.clientName}: ${result.title})';
}

/// No match: "We couldn't recognise that".
final class NoMatchState extends RecognitionState {
  const NoMatchState();

  @override
  bool operator ==(Object other) => other is NoMatchState;

  @override
  int get hashCode => (NoMatchState).hashCode;

  @override
  String toString() => 'NoMatchState()';
}

/// Busy: the API had no room, so the kept clip is sent again when the countdown ends.
final class BusyState extends RecognitionState {
  const BusyState({required this.retryDelaySeconds, required this.secondsUntilRetry})
    : assert(retryDelaySeconds >= 1, 'A wait is at least one second.'),
      assert(
        secondsUntilRetry >= 0 && secondsUntilRetry <= retryDelaySeconds,
        'The countdown runs from the whole wait down to zero.',
      );

  /// The whole wait, from `Retry-After` (1 to 60 seconds), against which the bar shows progress.
  final int retryDelaySeconds;

  /// The countdown, e.g. 12 for "12 s".
  final int secondsUntilRetry;

  @override
  bool operator ==(Object other) =>
      other is BusyState &&
      other.retryDelaySeconds == retryDelaySeconds &&
      other.secondsUntilRetry == secondsUntilRetry;

  @override
  int get hashCode => Object.hash(BusyState, retryDelaySeconds, secondsUntilRetry);

  @override
  String toString() =>
      'BusyState(retryDelaySeconds: $retryDelaySeconds, secondsUntilRetry: $secondsUntilRetry)';
}

/// Error, in the variant [failure] names (§2.10).
final class ErrorState extends RecognitionState {
  const ErrorState({required this.failure});

  final RecognitionFailure failure;

  @override
  bool operator ==(Object other) => other is ErrorState && other.failure == failure;

  @override
  int get hashCode => Object.hash(ErrorState, failure);

  @override
  String toString() => 'ErrorState($failure)';
}
