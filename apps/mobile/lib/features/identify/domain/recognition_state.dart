import 'package:lookup_listener/features/identify/domain/account_gate_origin.dart';
import 'package:lookup_listener/features/identify/domain/chooser_origin.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/saved_clip_reason.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// Where one identify stands: the nine top-level states of §2.12 (S4-STATE-03, S4-D4), and from
/// Phase 6 "Which station?" and "Saved offline" (P6-STATE-01: eleven).
///
/// Sealed, with every subclass in this one library, so the router's redirect and every screen
/// selector are exhaustive switches with no default branch: a new state cannot compile without
/// its route and screen (S4-STATE-09). Each state carries only its own data, every field non-null
/// (S4-STATE-07); the clip itself is never part of a state, so a state can be logged or compared
/// without touching the recording.
sealed class RecognitionState {
  const RecognitionState();

  /// Whether the listener's own identify is recording, sending or waiting to send again: the
  /// outbox starts no send then, so it never competes with it (P6 design §3.9 point 7).
  bool get isLiveIdentifyUnderWay => switch (this) {
    RecordingState() || UploadingState() || BusyState() => true,
    IdleState() ||
    PermissionNeededState() ||
    ChooseStationState() ||
    AccountRequiredState() ||
    SavedOfflineState() ||
    MatchedState() ||
    FallbackState() ||
    NoMatchState() ||
    ErrorState() => false,
  };
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
  /// [isSlow] once a send has had no answer for 5 seconds (P6 design §2.5, P6-LISTENING-01), with
  /// [sentPercent] of the clip sent so far: the screen then says the connection is slow and shows
  /// how much has gone.
  const UploadingState({this.isSlow = false, this.sentPercent = 0})
    : assert(sentPercent >= 0 && sentPercent <= 100);

  /// No answer within 5 seconds of the send starting.
  final bool isSlow;

  /// How much of the request has been sent, in whole percent; 100 once it has all gone.
  final int sentPercent;

  @override
  bool operator ==(Object other) =>
      other is UploadingState && other.isSlow == isSlow && other.sentPercent == sentPercent;

  @override
  int get hashCode => Object.hash(UploadingState, isSlow, sentPercent);

  @override
  String toString() => isSlow ? 'UploadingState(slow, $sentPercent% sent)' : 'UploadingState()';
}

/// "Which station?": the ad is on more than one station, so the listener picks theirs from the
/// candidates, each with its own card (P6 design §2.6, §3.4; P6-STATE-02, T19′). A row shows that
/// candidate's result at once, from these cards, with no request (T44, P6-CHOOSER-09).
final class ChooseStationState extends RecognitionState {
  ChooseStationState({
    required this.recognitionId,
    required List<RecognitionResult> candidates,
    required this.origin,
  }) : assert(
         candidates.length >= minimumCandidates && candidates.length <= maximumCandidates,
         'A chooser offers 2 to 4 stations.',
       ),
       assert(
         candidates.map((candidate) => candidate.stationId).toSet().length == candidates.length,
         'Each candidate is a different station.',
       ),
       candidates = List.unmodifiable(candidates);

  /// A chooser offers 2 to 4 stations (contract §1.2, P6-CHOOSER-02).
  static const int minimumCandidates = 2;
  static const int maximumCandidates = 4;

  /// The recognition the choice is sent for: a lower-case UUID version 7, from the answer.
  final String recognitionId;

  /// 2 to 4 candidates, each a different station, in the answer's order, which the app never
  /// changes.
  final List<RecognitionResult> candidates;

  /// Where the sheet came from, which decides where Cancel leads.
  final ChooserOrigin origin;

  /// Whether every candidate is the advertiser's default card, so the sheet must not say "right
  /// now": named for what the app can know, since the answer does not say why a card is a default
  /// card (out of its slots, or every campaign at its limit or paused after the capture; P6-D42).
  bool get areAllCandidatesDefaultCards =>
      candidates.every((candidate) => candidate.kind == RecognitionResultKind.clientDefault);

  @override
  bool operator ==(Object other) =>
      other is ChooseStationState &&
      other.recognitionId == recognitionId &&
      other.origin == origin &&
      identical(other.candidates, candidates);

  @override
  int get hashCode => Object.hash(ChooseStationState, recognitionId, origin, candidates);

  @override
  String toString() =>
      'ChooseStationState(recognitionId: $recognitionId, '
      'stations: ${candidates.map((candidate) => candidate.stationName).join(', ')}, '
      'origin: ${origin.name})';
}

/// The account gate (ADR-005): the ad was recognised, but the result waits until the listener creates an
/// account, which the server enforces. The screen shows nothing of the ad: it never reached the phone. Once
/// the listener has an account the flow asks for the result and moves on to the usual Result or chooser.
final class AccountRequiredState extends RecognitionState {
  const AccountRequiredState({required this.recognitionId, required this.origin});

  /// The recognition the result is asked for: a lower-case UUID version 7, from the answer.
  final String recognitionId;

  /// Where the gate came from, which decides where "Not now" leads.
  final AccountGateOrigin origin;

  @override
  bool operator ==(Object other) =>
      other is AccountRequiredState && other.recognitionId == recognitionId && other.origin == origin;

  @override
  int get hashCode => Object.hash(AccountRequiredState, recognitionId, origin);

  @override
  String toString() => 'AccountRequiredState(recognitionId: $recognitionId, origin: ${origin.name})';
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

/// Saved offline (P6 design §2.8; T21′, T24′, T27′, T31′): the clip is in the outbox, written and
/// flushed before this state shows, so "Saved" is always true; the outbox sends it later.
final class SavedOfflineState extends RecognitionState {
  const SavedOfflineState({required this.reason, required this.wasOldestClipDeleted});

  /// Why it was kept: the screen's icon, heading and text.
  final SavedClipReason reason;

  /// Whether a sixth clip pushed out the oldest waiting one, which the screen says (P6-D6).
  final bool wasOldestClipDeleted;

  @override
  bool operator ==(Object other) =>
      other is SavedOfflineState &&
      other.reason == reason &&
      other.wasOldestClipDeleted == wasOldestClipDeleted;

  @override
  int get hashCode => Object.hash(SavedOfflineState, reason, wasOldestClipDeleted);

  @override
  String toString() =>
      'SavedOfflineState(reason: ${reason.name}, wasOldestClipDeleted: $wasOldestClipDeleted)';
}
