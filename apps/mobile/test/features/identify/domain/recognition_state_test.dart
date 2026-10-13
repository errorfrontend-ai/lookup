import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/chooser_origin.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/result/domain/read_action_card.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/identify/domain/saved_clip_reason.dart';

void main() {
  const recognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';
  RecognitionResult candidate({
    String stationId = '0192a6c4-1111-4000-8000-000000000001',
    String stationName = 'Station A',
    RecognitionResultKind kind = RecognitionResultKind.campaign,
  }) => RecognitionResult(
    recognitionId: recognitionId,
    kind: kind,
    stationId: stationId,
    stationName: stationName,
    stationFrequencyLabel: '98.1 FM',
    clientName: 'Brand A',
    title: 'Summer service offer',
    card: const ReadActionCard.empty(showsUpdateAppHint: false),
  );
  final result = candidate();
  final stationB = candidate(
    stationId: '0192a6c4-1111-4000-8000-000000000002',
    stationName: 'Station B',
  );
  final chooser = ChooseStationState(
    recognitionId: recognitionId,
    candidates: [result, stationB],
    origin: ChooserOrigin.liveIdentify,
  );

  final oneOfEachState = <RecognitionState>[
    const IdleState(),
    const PermissionNeededState(microphoneAccess: MicrophoneAccess.notAskedYet),
    const RecordingState(levelFraction: 0, secondsLeft: 8),
    const UploadingState(),
    chooser,
    MatchedState(result: result),
    FallbackState(result: result),
    const NoMatchState(),
    const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 12),
    const SavedOfflineState(reason: SavedClipReason.noConnection, wasOldestClipDeleted: false),
    const ErrorState(failure: AppUpdateRequiredFailure()),
  ];

  test(
    "there are exactly eleven states: Step 4's nine, chooseStation and savedOffline (P6-STATE-01)",
    () {
      // The switch below has no default branch: another state would not compile until it is added.
      expect(oneOfEachState.map(_nameOf).toSet(), {
        'idle',
        'permissionNeeded',
        'recording',
        'uploading',
        'chooseStation',
        'matched',
        'fallback',
        'noMatch',
        'busy',
        'savedOffline',
        'error',
      });
    },
  );

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

    const saved = SavedOfflineState(
      reason: SavedClipReason.tooManyTries,
      wasOldestClipDeleted: true,
    );
    expect(saved.reason, SavedClipReason.tooManyTries);
    expect(saved.wasOldestClipDeleted, isTrue);
  });

  group('chooseStation (P6-STATE-02)', () {
    test('holds the recognition id, every candidate with its card, in order, and its origin', () {
      expect(chooser.recognitionId, recognitionId);
      expect(chooser.candidates, [same(result), same(stationB)]);
      expect(chooser.candidates.map((candidate) => candidate.card), [
        same(result.card),
        same(stationB.card),
      ]);
      expect(chooser.origin, ChooserOrigin.liveIdentify);
      expect(() => chooser.candidates.add(result), throwsUnsupportedError);
    });

    test('says when every candidate is a default card, and only then (P6-D42)', () {
      expect(chooser.areAllCandidatesDefaultCards, isFalse);
      final oneDefault = ChooseStationState(
        recognitionId: recognitionId,
        candidates: [
          result,
          candidate(stationId: stationB.stationId, kind: RecognitionResultKind.clientDefault),
        ],
        origin: ChooserOrigin.liveIdentify,
      );
      expect(oneDefault.areAllCandidatesDefaultCards, isFalse);
      final allDefault = ChooseStationState(
        recognitionId: recognitionId,
        candidates: [
          candidate(kind: RecognitionResultKind.clientDefault),
          candidate(stationId: stationB.stationId, kind: RecognitionResultKind.clientDefault),
        ],
        origin: ChooserOrigin.liveIdentify,
      );
      expect(allDefault.areAllCandidatesDefaultCards, isTrue);
    });

    test('offers 2 to 4 stations, each once', () {
      List<RecognitionResult> stations(int count) => [
        for (var index = 1; index <= count; index++)
          candidate(stationId: '0192a6c4-1111-4000-8000-00000000000$index'),
      ];
      for (final count in [1, 5]) {
        expect(
          () => ChooseStationState(
            recognitionId: recognitionId,
            candidates: stations(count),
            origin: ChooserOrigin.liveIdentify,
          ),
          throwsA(isA<AssertionError>()),
          reason: '$count candidates',
        );
      }
      for (final count in [2, 3, 4]) {
        expect(
          ChooseStationState(
            recognitionId: recognitionId,
            candidates: stations(count),
            origin: ChooserOrigin.liveIdentify,
          ).candidates,
          hasLength(count),
        );
      }
      expect(
        () => ChooseStationState(
          recognitionId: recognitionId,
          candidates: [result, candidate()],
          origin: ChooserOrigin.liveIdentify,
        ),
        throwsA(isA<AssertionError>()),
        reason: 'the same station twice',
      );
    });
  });

  test('a live identify is under way only while recording, sending or busy (P6 design §3.9)', () {
    expect(
      {for (final state in oneOfEachState) _nameOf(state): state.isLiveIdentifyUnderWay},
      {
        'idle': false,
        'permissionNeeded': false,
        'recording': true,
        'uploading': true,
        'chooseStation': false,
        'matched': false,
        'fallback': false,
        'noMatch': false,
        'busy': true,
        'savedOffline': false,
        'error': false,
      },
    );
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
      const SavedOfflineState(reason: SavedClipReason.busy, wasOldestClipDeleted: false),
      const SavedOfflineState(reason: SavedClipReason.busy, wasOldestClipDeleted: false),
    );
    expect(
      const SavedOfflineState(reason: SavedClipReason.busy, wasOldestClipDeleted: false),
      isNot(const SavedOfflineState(reason: SavedClipReason.busy, wasOldestClipDeleted: true)),
    );
    expect(
      const SavedOfflineState(reason: SavedClipReason.busy, wasOldestClipDeleted: false),
      isNot(
        const SavedOfflineState(reason: SavedClipReason.noConnection, wasOldestClipDeleted: false),
      ),
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
  ChooseStationState() => 'chooseStation',
  MatchedState() => 'matched',
  FallbackState() => 'fallback',
  NoMatchState() => 'noMatch',
  BusyState() => 'busy',
  SavedOfflineState() => 'savedOffline',
  ErrorState() => 'error',
};
