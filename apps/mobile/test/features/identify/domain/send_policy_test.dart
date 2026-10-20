import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/account_gate_origin.dart';
import 'package:lookup_listener/features/identify/domain/recognition_answer.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_outcome.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/domain/send_policy.dart';
import 'package:lookup_listener/features/identify/domain/saved_clip_reason.dart';

const String _apiRequestId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
const String _reportRequestId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

ErrorStatusAnswer _answer(
  int httpStatus, {
  String? errorCode,
  int? retryAfterSeconds,
  String? apiRequestId = _apiRequestId,
}) => ErrorStatusAnswer(
  httpStatus: httpStatus,
  errorCode: errorCode,
  retryAfterSeconds: retryAfterSeconds,
  apiRequestId: apiRequestId,
);

final ErrorStatusAnswer _busy = _answer(503, errorCode: 'RECOGNITION_BUSY', retryAfterSeconds: 10);
final ErrorStatusAnswer _inProgress = _answer(
  409,
  errorCode: 'RECOGNITION_IN_PROGRESS',
  retryAfterSeconds: 3,
);
final ErrorStatusAnswer _tokenRefused = _answer(401, errorCode: 'INSTALL_TOKEN_INVALID');

/// Sends [answers] one after another for one clip, as the flow does: each next send uses the policy
/// the previous outcome handed on. Returns every outcome.
List<RecognitionOutcome> _sendClip(List<RecognitionAnswer> answers) {
  var policy = const SendPolicy();
  final outcomes = <RecognitionOutcome>[];
  for (final answer in answers) {
    final outcome = policy.decide(answer, reportRequestId: _reportRequestId);
    outcomes.add(outcome);
    policy = switch (outcome) {
      BusyOutcome(:final nextPolicy) => nextPolicy,
      WaitAndResendOutcome(:final nextPolicy) => nextPolicy,
      RegisterAgainOutcome(:final nextPolicy) => nextPolicy,
      SaveForLaterOutcome() => policy,
      FinishedOutcome() => policy,
    };
  }
  return outcomes;
}

void main() {
  group('at most 4 sends of one clip on busy answers (S4-D11, T20, T21′)', () {
    test(
      'the first three busy answers show Busy and keep the clip; the fourth keeps it for later',
      () {
        final outcomes = _sendClip([_busy, _busy, _busy, _busy]);
        for (final outcome in outcomes.take(3)) {
          expect(outcome, isA<BusyOutcome>());
          expect(outcome.isClipKept, isTrue);
        }
        expect(
          [
            for (final outcome in outcomes.take(3))
              (outcome as BusyOutcome).nextPolicy.busyAnswerCount,
          ],
          [1, 2, 3],
        );
        // T21′: the clip goes to the outbox, which sends it once Look Up is less busy; no report.
        expect(outcomes.last, const SaveForLaterOutcome(reason: SavedClipReason.busy));
        expect(outcomes.last.isClipKept, isTrue);
      },
    );

    test('502, 503 and 504 all count as busy, whatever their code', () {
      final outcomes = _sendClip([
        _answer(502),
        _answer(503, errorCode: 'RECOGNITION_TIMEOUT'),
        _answer(504, errorCode: 'SOMETHING_NEWER'),
        _answer(503, errorCode: 'SERVICE_UNAVAILABLE'),
      ]);
      expect(outcomes.take(3), everyElement(isA<BusyOutcome>()));
      expect(outcomes.last, const SaveForLaterOutcome(reason: SavedClipReason.busy));
    });

    test(
      'the fourth busy answer with no API id is kept for later too: nothing went wrong on the phone',
      () {
        final outcomes = _sendClip([_busy, _busy, _busy, _answer(502, apiRequestId: null)]);
        expect(outcomes.last, const SaveForLaterOutcome(reason: SavedClipReason.busy));
      },
    );

    test('other answers in between do not reset the busy count', () {
      final outcomes = _sendClip([
        _busy,
        _inProgress,
        _busy,
        _tokenRefused,
        _busy,
        const NoAnswer(),
        _busy,
      ]);
      expect(outcomes.last, const SaveForLaterOutcome(reason: SavedClipReason.busy));
    });
  });

  group('at most 2 waits after 409 (S4-D11, T22)', () {
    test(
      'the first two 409s wait and resend the same clip; the third ends in Error, unreported',
      () {
        final outcomes = _sendClip([_inProgress, _inProgress, _inProgress]);
        for (final outcome in outcomes.take(2)) {
          expect(outcome, isA<WaitAndResendOutcome>());
          expect(outcome.nextState, const UploadingState());
          expect(outcome.isClipKept, isTrue);
          expect((outcome as WaitAndResendOutcome).waitSeconds, 3);
        }
        final last = outcomes.last as FinishedOutcome;
        expect(last.nextState, const ErrorState(failure: ServerFailure(requestId: _apiRequestId)));
        expect(last.problemReport, isNull);
      },
    );
  });

  group('at most 1 re-registration after 401 (S4-D11, T23)', () {
    test('the first 401 registers again and resends; the second ends in Error and is reported', () {
      final outcomes = _sendClip([_tokenRefused, _tokenRefused]);
      expect(outcomes.first, isA<RegisterAgainOutcome>());
      expect(outcomes.first.nextState, const UploadingState());
      expect(outcomes.first.isClipKept, isTrue);
      expect((outcomes.first as RegisterAgainOutcome).nextPolicy.registrationRetryCount, 1);
      final last = outcomes.last as FinishedOutcome;
      expect(last.nextState, const ErrorState(failure: ServerFailure(requestId: _apiRequestId)));
      expect(last.problemReport!.relatedRequestId, _apiRequestId);
    });
  });

  test('each limit counts only its own answers', () {
    final outcomes = _sendClip([_busy, _busy, _busy, _inProgress, _inProgress, _tokenRefused]);
    expect(outcomes.take(3), everyElement(isA<BusyOutcome>()));
    expect(outcomes.skip(3).take(2), everyElement(isA<WaitAndResendOutcome>()));
    expect(outcomes.last, isA<RegisterAgainOutcome>());
    expect(
      (outcomes.last as RegisterAgainOutcome).nextPolicy,
      const SendPolicy(busyAnswerCount: 3, inProgressWaitCount: 2, registrationRetryCount: 1),
    );
  });

  test('no answer changes no count, since nothing was answered', () {
    const policy = SendPolicy(
      busyAnswerCount: 3,
      inProgressWaitCount: 2,
      registrationRetryCount: 1,
    );
    expect(
      policy.decide(const NoAnswer(), reportRequestId: _reportRequestId),
      const SaveForLaterOutcome(reason: SavedClipReason.noConnection),
    );
    expect(
      policy,
      const SendPolicy(busyAnswerCount: 3, inProgressWaitCount: 2, registrationRetryCount: 1),
    );
  });

  test('a request the phone itself stopped ends the clip, whatever the counts', () {
    const policy = SendPolicy(busyAnswerCount: 1, inProgressWaitCount: 1);
    final outcome = policy.decide(
      const PhoneFaultAnswer(problem: 'a fault in the app'),
      reportRequestId: _reportRequestId,
    );
    expect(outcome, isA<FinishedOutcome>());
    expect(outcome.isClipKept, isFalse);
    expect(
      outcome.nextState,
      const ErrorState(
        failure: PhoneFailure(
          reportRequestId: _reportRequestId,
          reportDelivery: ReportDelivery.sending,
        ),
      ),
    );
  });

  test('deciding never changes the policy it was asked', () {
    const policy = SendPolicy();
    policy.decide(_busy, reportRequestId: _reportRequestId);
    expect(policy.busyAnswerCount, 0);
  });

  group(
    'Retry-After is clamped to 1–60 seconds, with 10 s (busy, 429) and 3 s (409) by default',
    () {
      for (final (retryAfterSeconds, expectedSeconds) in [
        (12, 12),
        (1, 1),
        (0, 1),
        (-30, 1),
        (60, 60),
        (61, 60),
        (999, 60),
        (999999, 60),
      ]) {
        test('$retryAfterSeconds → $expectedSeconds', () {
          expect(
            SendPolicy.retryDelaySecondsFrom(retryAfterSeconds, defaultSeconds: 10),
            expectedSeconds,
          );
          final busy = const SendPolicy().decide(
            _answer(503, retryAfterSeconds: retryAfterSeconds),
            reportRequestId: _reportRequestId,
          );
          expect((busy as BusyOutcome).retryDelaySeconds, expectedSeconds);
          final inProgress = const SendPolicy().decide(
            _answer(409, retryAfterSeconds: retryAfterSeconds),
            reportRequestId: _reportRequestId,
          );
          expect((inProgress as WaitAndResendOutcome).waitSeconds, expectedSeconds);
        });
      }

      test('missing or unreadable: 10 seconds for busy, 3 seconds for 409', () {
        expect(SendPolicy.defaultBusyRetryAfterSeconds, 10);
        expect(SendPolicy.defaultInProgressRetryAfterSeconds, 3);
        final busy = const SendPolicy().decide(_answer(503), reportRequestId: _reportRequestId);
        expect(busy.nextState, const BusyState(retryDelaySeconds: 10, secondsUntilRetry: 10));
        final inProgress = const SendPolicy().decide(
          _answer(409),
          reportRequestId: _reportRequestId,
        );
        expect((inProgress as WaitAndResendOutcome).waitSeconds, 3);
      });

      test('Busy starts its countdown at the whole wait', () {
        final outcome = const SendPolicy().decide(
          _answer(503, retryAfterSeconds: 12),
          reportRequestId: _reportRequestId,
        );
        expect(outcome.nextState, const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 12));
      });
    },
  );

  test('T24′: a 429 keeps the clip for later whatever its wait: the outbox honours the wait', () {
    for (final retryAfterSeconds in [42, 60, 61, 3600, null]) {
      final outcome = const SendPolicy().decide(
        _answer(429, errorCode: 'RATE_LIMITED', retryAfterSeconds: retryAfterSeconds),
        reportRequestId: _reportRequestId,
      );
      expect(
        outcome,
        const SaveForLaterOutcome(reason: SavedClipReason.tooManyTries),
        reason: '$retryAfterSeconds',
      );
    }
  });

  test('ACCOUNT_REQUIRED (ADR-005; LA-APP-01) opens the account gate for that recognition, drops the clip and reports nothing', () {
    const recognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';
    final outcome = const SendPolicy().decide(
      const AccountRequiredAnswer(
        recognitionId: recognitionId,
        answerBody: {'status': 'ACCOUNT_REQUIRED'},
        apiRequestId: _apiRequestId,
      ),
      reportRequestId: _reportRequestId,
    );
    expect(outcome, isA<FinishedOutcome>());
    final finished = outcome as FinishedOutcome;
    expect(
      finished.nextState,
      const AccountRequiredState(recognitionId: recognitionId, origin: AccountGateOrigin.liveIdentify),
    );
    expect(finished.problemReport, isNull);
    expect(finished.isClipKept, isFalse);
  });

  test('the limits are the ones the design states', () {
    expect(SendPolicy.maximumSendsOnBusyAnswers, 4);
    expect(SendPolicy.maximumWaitsAfterInProgress, 2);
    expect(SendPolicy.maximumRegistrationsAfterRefusedToken, 1);
    expect(SendPolicy.shortestRetryAfterSeconds, 1);
    expect(SendPolicy.longestRetryAfterSeconds, 60);
  });
}
