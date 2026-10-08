import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/result/domain/read_action_card.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';

void main() {
  final result = RecognitionResult(
    kind: RecognitionResultKind.campaign,
    stationId: '0192a6c4-1111-4000-8000-000000000001',
    stationName: 'Station A',
    stationFrequencyLabel: '98.1 FM',
    clientName: 'Brand A',
    title: 'Summer service offer',
    card: const ReadActionCard.empty(showsUpdateAppHint: false),
  );

  final oneOfEachState = <RecognitionState>[
    const IdleState(),
    const PermissionNeededState(microphoneAccess: MicrophoneAccess.notAskedYet),
    const RecordingState(levelFraction: 0, secondsLeft: 8),
    const UploadingState(),
    MatchedState(result: result),
    FallbackState(result: result),
    const NoMatchState(),
    const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 12),
    const ErrorState(failure: ConnectionFailure()),
  ];

  test('there are exactly nine states, each a different one of the sealed subclasses', () {
    // The switch below has no default branch: a tenth state would not compile until it is added.
    expect(oneOfEachState.map(_nameOf).toSet(), {
      'idle',
      'permissionNeeded',
      'recording',
      'uploading',
      'matched',
      'fallback',
      'noMatch',
      'busy',
      'error',
    });
  });

  test('each state carries only its own data, non-null, as given', () {
    const permission = PermissionNeededState(microphoneAccess: MicrophoneAccess.refusedForGood);
    expect(permission.microphoneAccess, MicrophoneAccess.refusedForGood);

    const recording = RecordingState(levelFraction: 0.25, secondsLeft: 3);
    expect(recording.levelFraction, 0.25);
    expect(recording.secondsLeft, 3);

    expect(MatchedState(result: result).result, same(result));
    expect(FallbackState(result: result).result, same(result));

    const busy = BusyState(retryDelaySeconds: 12, secondsUntilRetry: 11);
    expect(busy.retryDelaySeconds, 12);
    expect(busy.secondsUntilRetry, 11);

    const error = ErrorState(failure: ServerFailure(requestId: 'x'));
    expect(error.failure, const ServerFailure(requestId: 'x'));
  });

  test('states compare by value, so the flow can tell a real change from a repeat', () {
    expect(
      const RecordingState(levelFraction: 0.5, secondsLeft: 4),
      const RecordingState(levelFraction: 0.5, secondsLeft: 4),
    );
    expect(
      const RecordingState(levelFraction: 0.5, secondsLeft: 4),
      isNot(const RecordingState(levelFraction: 0.5, secondsLeft: 3)),
    );
    expect(
      const BusyState(retryDelaySeconds: 10, secondsUntilRetry: 10),
      isNot(const BusyState(retryDelaySeconds: 10, secondsUntilRetry: 9)),
    );
    expect(
      const ErrorState(failure: TooManyTriesFailure(isShortWait: true)),
      const ErrorState(failure: TooManyTriesFailure(isShortWait: true)),
    );
    expect(
      const ErrorState(failure: TooManyTriesFailure(isShortWait: true)),
      isNot(const ErrorState(failure: TooManyTriesFailure(isShortWait: false))),
    );
    expect(MatchedState(result: result), MatchedState(result: result));
    expect(MatchedState(result: result), isNot(FallbackState(result: result)));
    expect(const IdleState(), isNot(const UploadingState()));
  });

  group('a state cannot be made with values the screens cannot show', () {
    test('the Permission screen has no "granted" variant', () {
      var access = MicrophoneAccess.granted;
      expect(() => PermissionNeededState(microphoneAccess: access), throwsA(isA<AssertionError>()));
      access = MicrophoneAccess.refusedOnce;
      expect(PermissionNeededState(microphoneAccess: access).microphoneAccess, access);
    });

    test('the level is a fraction from 0 to 1 and the countdown never goes below zero', () {
      for (final level in [-0.01, 1.01, double.nan]) {
        expect(
          () => RecordingState(levelFraction: level, secondsLeft: 8),
          throwsA(isA<AssertionError>()),
          reason: '$level',
        );
      }
      var secondsLeft = -1;
      expect(
        () => RecordingState(levelFraction: 0, secondsLeft: secondsLeft),
        throwsA(isA<AssertionError>()),
      );
      secondsLeft = 0;
      expect(RecordingState(levelFraction: 1, secondsLeft: secondsLeft).secondsLeft, 0);
    });

    test('a Busy wait is at least a second and its countdown stays inside the wait', () {
      var retryDelaySeconds = 0;
      expect(
        () => BusyState(retryDelaySeconds: retryDelaySeconds, secondsUntilRetry: 0),
        throwsA(isA<AssertionError>()),
      );
      retryDelaySeconds = 10;
      expect(
        () => BusyState(retryDelaySeconds: retryDelaySeconds, secondsUntilRetry: 11),
        throwsA(isA<AssertionError>()),
      );
      expect(
        () => BusyState(retryDelaySeconds: retryDelaySeconds, secondsUntilRetry: -1),
        throwsA(isA<AssertionError>()),
      );
      expect(
        BusyState(retryDelaySeconds: retryDelaySeconds, secondsUntilRetry: 0).secondsUntilRetry,
        0,
      );
    });
  });

  test('the microphone is not asked, refused once, refused for good, or granted', () {
    expect(MicrophoneAccess.values, [
      MicrophoneAccess.notAskedYet,
      MicrophoneAccess.refusedOnce,
      MicrophoneAccess.refusedForGood,
      MicrophoneAccess.granted,
    ]);
  });
}

/// The route-style name of a state, through an exhaustive switch with no default branch.
String _nameOf(RecognitionState state) => switch (state) {
  IdleState() => 'idle',
  PermissionNeededState() => 'permissionNeeded',
  RecordingState() => 'recording',
  UploadingState() => 'uploading',
  MatchedState() => 'matched',
  FallbackState() => 'fallback',
  NoMatchState() => 'noMatch',
  BusyState() => 'busy',
  ErrorState() => 'error',
};
