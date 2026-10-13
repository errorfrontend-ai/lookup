import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/chooser_origin.dart';
import 'package:lookup_listener/features/identify/domain/recognition_answer.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_outcome.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/domain/send_policy.dart';
import 'package:lookup_listener/features/result/domain/read_action_card.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/identify/domain/saved_clip_reason.dart';

const String _apiRequestId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
const String _reportRequestId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const ErrorState _serverFailure = ErrorState(failure: ServerFailure(requestId: _apiRequestId));
const ErrorState _phoneFailure = ErrorState(
  failure: PhoneFailure(reportRequestId: _reportRequestId, reportDelivery: ReportDelivery.sending),
);

const String _recognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';

RecognitionResult _result(
  RecognitionResultKind kind, {
  String stationId = '0192a6c4-1111-4000-8000-000000000001',
  String stationName = 'Station A',
}) => RecognitionResult(
  recognitionId: _recognitionId,
  kind: kind,
  stationId: stationId,
  stationName: stationName,
  stationFrequencyLabel: '98.1 FM',
  clientName: 'Brand A',
  title: 'Summer service offer',
  card: const ReadActionCard.empty(showsUpdateAppHint: false),
);

RecognitionOutcome _decide(RecognitionAnswer answer, {SendPolicy policy = const SendPolicy()}) =>
    policy.decide(answer, reportRequestId: _reportRequestId);

ErrorStatusAnswer _status(
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

/// The outcome ends the identify on [state], drops the clip and sends a crash report exactly when
/// [isReported], tied to [relatedRequestId].
void _expectFinished(
  RecognitionOutcome outcome,
  RecognitionState state, {
  required bool isReported,
  String? relatedRequestId = _apiRequestId,
}) {
  expect(outcome, isA<FinishedOutcome>());
  expect(outcome.nextState, state);
  expect(outcome.isClipKept, isFalse, reason: 'the clip is dropped');
  final problemReport = (outcome as FinishedOutcome).problemReport;
  if (!isReported) {
    expect(problemReport, isNull, reason: 'no crash report');
    return;
  }
  expect(problemReport, isNotNull, reason: 'a crash report');
  expect(problemReport!.reportRequestId, _reportRequestId);
  expect(problemReport.relatedRequestId, relatedRequestId);
  expect(problemReport.summary.length, lessThanOrEqualTo(500));
}

void main() {
  group('§3.11, row by row', () {
    test('200 MATCH, kind CAMPAIGN → matched; clip deleted', () {
      final result = _result(RecognitionResultKind.campaign);
      _expectFinished(
        _decide(MatchAnswer(result: result, answerBody: const {}, apiRequestId: _apiRequestId)),
        MatchedState(result: result),
        isReported: false,
      );
    });

    test('200 MATCH, kind CLIENT_DEFAULT → fallback; clip deleted', () {
      final result = _result(RecognitionResultKind.clientDefault);
      _expectFinished(
        _decide(MatchAnswer(result: result, answerBody: const {}, apiRequestId: _apiRequestId)),
        FallbackState(result: result),
        isReported: false,
      );
    });

    test(
      '200 MATCH, a kind the app does not know → matched (the parser reads it as a campaign)',
      () {
        // The parser test proves an unknown kind arrives here as a campaign (unknown-result-kind).
        final result = _result(RecognitionResultKind.campaign);
        expect(
          _decide(MatchAnswer(result: result, answerBody: const {}, apiRequestId: null)).nextState,
          MatchedState(result: result),
        );
      },
    );

    test('200 NO_MATCH → noMatch; clip deleted', () {
      _expectFinished(
        _decide(const NoMatchAnswer(apiRequestId: _apiRequestId)),
        const NoMatchState(),
        isReported: false,
      );
    });

    test('T19′ 200 CHOOSE_STATION → chooseStation with its candidates, live; clip deleted', () {
      final stationA = _result(RecognitionResultKind.campaign);
      final stationB = _result(
        RecognitionResultKind.campaign,
        stationId: '0192a6c4-1111-4000-8000-000000000002',
        stationName: 'Station B',
      );
      final outcome = _decide(
        ChooseStationAnswer(
          recognitionId: _recognitionId,
          candidates: [stationA, stationB],
          answerBody: const {},
          apiRequestId: _apiRequestId,
        ),
      );
      expect(outcome, isA<FinishedOutcome>());
      expect(outcome.isClipKept, isFalse, reason: 'the clip is dropped');
      expect((outcome as FinishedOutcome).problemReport, isNull);
      final chooser = outcome.nextState as ChooseStationState;
      expect(chooser.recognitionId, _recognitionId);
      expect(chooser.candidates, [same(stationA), same(stationB)]);
      expect(chooser.origin, ChooserOrigin.liveIdentify);
    });

    test('200 with a status the app does not know → newer app needed; clip deleted', () {
      _expectFinished(
        _decide(const UnknownStatusAnswer(apiRequestId: _apiRequestId)),
        const ErrorState(failure: NewerAppNeededFailure()),
        isReported: false,
      );
    });

    test('200 that cannot be read → server failure, reported with the API id, code shown', () {
      final outcome = _decide(
        const UnreadableAnswer(
          problem: 'the body is not a JSON object',
          apiRequestId: _apiRequestId,
        ),
      );
      _expectFinished(outcome, _serverFailure, isReported: true);
      expect((outcome as FinishedOutcome).problemReport!.summary, contains('not a JSON object'));
    });

    test('400 INVALID_AUDIO → recording unusable, reported, code shown', () {
      _expectFinished(
        _decide(_status(400, errorCode: 'INVALID_AUDIO')),
        const ErrorState(failure: RecordingUnusableFailure(requestId: _apiRequestId)),
        isReported: true,
      );
    });

    for (final (httpStatus, errorCode) in [
      (400, 'BAD_REQUEST'),
      (400, 'VALIDATION_FAILED'),
      (400, 'INVALID_JSON'),
      (413, 'PAYLOAD_TOO_LARGE'),
      (415, 'UNSUPPORTED_MEDIA_TYPE'),
    ]) {
      test('$httpStatus $errorCode → server failure, reported (the app sent something wrong)', () {
        _expectFinished(
          _decide(_status(httpStatus, errorCode: errorCode)),
          _serverFailure,
          isReported: true,
        );
      });
    }

    test(
      '401 INSTALL_TOKEN_INVALID, first time for this clip → register again and resend; clip kept',
      () {
        final outcome = _decide(_status(401, errorCode: 'INSTALL_TOKEN_INVALID'));
        expect(outcome, isA<RegisterAgainOutcome>());
        expect(outcome.nextState, const UploadingState());
        expect(outcome.isClipKept, isTrue);
      },
    );

    test('401 again → server failure, reported', () {
      _expectFinished(
        _decide(
          _status(401, errorCode: 'INSTALL_TOKEN_INVALID'),
          policy: const SendPolicy(registrationRetryCount: 1),
        ),
        _serverFailure,
        isReported: true,
      );
    });

    test(
      '409 RECOGNITION_IN_PROGRESS, first two → wait Retry-After and resend the same key; clip kept',
      () {
        for (final policy in const [SendPolicy(), SendPolicy(inProgressWaitCount: 1)]) {
          final outcome = _decide(
            _status(409, errorCode: 'RECOGNITION_IN_PROGRESS', retryAfterSeconds: 3),
            policy: policy,
          );
          expect(outcome, isA<WaitAndResendOutcome>());
          expect((outcome as WaitAndResendOutcome).waitSeconds, 3);
          expect(outcome.nextState, const UploadingState());
          expect(outcome.isClipKept, isTrue);
        }
      },
    );

    test('409 a third time → server failure, not reported, code shown', () {
      _expectFinished(
        _decide(
          _status(409, errorCode: 'RECOGNITION_IN_PROGRESS'),
          policy: const SendPolicy(inProgressWaitCount: 2),
        ),
        _serverFailure,
        isReported: false,
      );
    });

    for (final errorCode in ['CAPTURE_EXPIRED', 'CAPTURE_TIME_INVALID']) {
      test(
        '422 $errorCode → server failure, reported (a live clip should never be refused for its time)',
        () {
          _expectFinished(
            _decide(_status(422, errorCode: errorCode)),
            _serverFailure,
            isReported: true,
          );
        },
      );
    }

    test('T26′: 426 → please update the app; clip deleted (P6-COMPATIBILITY-02)', () {
      _expectFinished(
        _decide(_status(426, errorCode: 'APP_UPDATE_REQUIRED')),
        const ErrorState(failure: AppUpdateRequiredFailure()),
        isReported: false,
      );
    });

    test('T24′: 429 RATE_LIMITED → kept for later as "too many tries", whatever the wait', () {
      for (final retryAfterSeconds in [42, 3600, null]) {
        final outcome = _decide(
          _status(429, errorCode: 'RATE_LIMITED', retryAfterSeconds: retryAfterSeconds),
        );
        expect(
          outcome,
          const SaveForLaterOutcome(reason: SavedClipReason.tooManyTries),
          reason: '$retryAfterSeconds',
        );
        expect(outcome.isClipKept, isTrue);
      }
    });

    for (final httpStatus in [500, 501, 505, 507, 599]) {
      test('$httpStatus → server failure, not reported (the API logged it with its stack)', () {
        _expectFinished(
          _decide(_status(httpStatus, errorCode: 'INTERNAL')),
          _serverFailure,
          isReported: false,
        );
      });
    }

    for (final (httpStatus, errorCode) in [
      (502, null),
      (503, 'RECOGNITION_BUSY'),
      (503, 'RECOGNITION_TIMEOUT'),
      (503, 'SERVICE_UNAVAILABLE'),
      (503, 'A_CODE_FROM_LATER'),
      (504, null),
    ]) {
      test('$httpStatus $errorCode, sends < 4 → busy with the Retry-After delay; clip kept', () {
        final outcome = _decide(_status(httpStatus, errorCode: errorCode, retryAfterSeconds: 12));
        expect(outcome.nextState, const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 12));
        expect(outcome.isClipKept, isTrue);
      });
    }

    test('T21′: the same on the 4th send → kept for later as "busy", with no report', () {
      const policy = SendPolicy(busyAnswerCount: 3);
      for (final answer in [
        _status(503),
        _status(503, apiRequestId: null),
        _status(502),
        _status(504),
      ]) {
        final outcome = _decide(answer, policy: policy);
        expect(outcome, const SaveForLaterOutcome(reason: SavedClipReason.busy));
        expect(outcome.isClipKept, isTrue);
      }
    });

    for (final httpStatus in [100, 201, 204, 301, 302, 304, 403, 404, 405, 408, 418, 451]) {
      test(
        '$httpStatus (a status with no screen) → server failure, reported, code from the API id',
        () {
          _expectFinished(_decide(_status(httpStatus)), _serverFailure, isReported: true);
          _expectFinished(
            _decide(_status(httpStatus, apiRequestId: null)),
            _phoneFailure,
            isReported: true,
            relatedRequestId: null,
          );
        },
      );
    }

    test('an error code the app does not know is handled by its HTTP status', () {
      const unknownCode = 'A_CODE_FROM_LATER';
      _expectFinished(
        _decide(_status(400, errorCode: unknownCode)),
        _serverFailure,
        isReported: true,
      );
      expect(_decide(_status(401, errorCode: unknownCode)), isA<RegisterAgainOutcome>());
      expect(_decide(_status(409, errorCode: unknownCode)), isA<WaitAndResendOutcome>());
      _expectFinished(
        _decide(_status(422, errorCode: unknownCode)),
        _serverFailure,
        isReported: true,
      );
      expect(
        _decide(_status(429, errorCode: unknownCode)),
        const SaveForLaterOutcome(reason: SavedClipReason.tooManyTries),
      );
      _expectFinished(
        _decide(_status(500, errorCode: unknownCode)),
        _serverFailure,
        isReported: false,
      );
      expect(_decide(_status(503, errorCode: unknownCode)), isA<BusyOutcome>());
      // INVALID_AUDIO only counts on a 400.
      _expectFinished(
        _decide(_status(422, errorCode: 'INVALID_AUDIO')),
        _serverFailure,
        isReported: true,
      );
    });

    test(
      'T27′: no answer (no connection, DNS failure, timeout, dropped) → kept for later; Saved offline',
      () {
        final outcome = _decide(const NoAnswer());
        expect(outcome, const SaveForLaterOutcome(reason: SavedClipReason.noConnection));
        expect(
          outcome.nextState,
          const SavedOfflineState(
            reason: SavedClipReason.noConnection,
            wasOldestClipDeleted: false,
          ),
        );
        expect(outcome.isClipKept, isTrue);
      },
    );

    test('no answer because the phone itself stopped the request → phone failure, reported', () {
      final outcome = _decide(const PhoneFaultAnswer(problem: 'a fault in the app (StateError)'));
      _expectFinished(outcome, _phoneFailure, isReported: true, relatedRequestId: null);
      expect(
        (outcome as FinishedOutcome).problemReport!.summary,
        'Recognize request stopped on the phone: a fault in the app (StateError).',
      );
    });

    test('the listener cancels → idle; clip deleted', () {
      _expectFinished(_decide(const CancelledAnswer()), const IdleState(), isReported: false);
    });
  });

  group(
    'a server failure needs an id the API logged; with none it is a reported phone failure',
    () {
      test(
        'an unreadable 200, a 500, a third 409, a second 401 and an INVALID_AUDIO with no API id',
        () {
          for (final (answer, policy) in <(RecognitionAnswer, SendPolicy)>[
            (const UnreadableAnswer(problem: 'not JSON', apiRequestId: null), const SendPolicy()),
            (_status(500, apiRequestId: null), const SendPolicy()),
            (_status(409, apiRequestId: null), const SendPolicy(inProgressWaitCount: 2)),
            (_status(401, apiRequestId: null), const SendPolicy(registrationRetryCount: 1)),
            (_status(400, errorCode: 'INVALID_AUDIO', apiRequestId: null), const SendPolicy()),
          ]) {
            final outcome = _decide(answer, policy: policy);
            _expectFinished(outcome, _phoneFailure, isReported: true, relatedRequestId: null);
            expect((outcome as FinishedOutcome).problemReport!.summary, contains('no request id'));
          }
        },
      );
    },
  );

  test(
    '"code shown" in §3.11 is exactly the failures whose code comes from an id support can find',
    () {
      final codeShown = {
        _status(500): _apiRequestId,
        _status(400, errorCode: 'INVALID_AUDIO'): _apiRequestId,
        _status(422, errorCode: 'CAPTURE_EXPIRED'): _apiRequestId,
        _status(404): _apiRequestId,
        _status(426): null,
        _status(404, apiRequestId: null): null, // until the report is accepted
      };
      for (final MapEntry(key: answer, value: expectedRequestId) in codeShown.entries) {
        final failure = (_decide(answer).nextState as ErrorState).failure;
        expect(
          failure.referenceCodeRequestId,
          expectedRequestId,
          reason: 'HTTP ${answer.httpStatus}',
        );
      }
    },
  );

  test('a crash report says what happened in statuses, codes and field names', () {
    final outcome = _decide(
      const ErrorStatusAnswer(
        httpStatus: 400,
        errorCode: 'VALIDATION_FAILED',
        apiRequestId: _apiRequestId,
        fieldProblems: [
          FieldProblem(path: 'captured_at', code: 'invalid_format'),
          FieldProblem(path: 'sent_at', code: 'invalid_format'),
        ],
      ),
    );
    expect(
      (outcome as FinishedOutcome).problemReport!.summary,
      'Recognize answer HTTP 400 VALIDATION_FAILED (fields: captured_at invalid_format, '
      'sent_at invalid_format): the API refused what the app sent.',
    );
  });

  test('a report about the install registration names the registration, not the clip', () {
    String summaryOf(RecognitionAnswer answer) =>
        (_decide(answer) as FinishedOutcome).problemReport!.summary;
    expect(
      summaryOf(
        const ErrorStatusAnswer(
          httpStatus: 400,
          errorCode: 'VALIDATION_FAILED',
          apiRequestId: _apiRequestId,
          answeredRequest: AnsweredRequest.installRegistration,
        ),
      ),
      'Install registration answer HTTP 400 VALIDATION_FAILED: the API refused what the app sent.',
    );
    expect(
      summaryOf(
        const UnreadableAnswer(
          problem: 'install_token is missing or not text',
          apiRequestId: _apiRequestId,
          answeredRequest: AnsweredRequest.installRegistration,
        ),
      ),
      'Install registration answer HTTP 200: the body could not be read: '
      'install_token is missing or not text.',
    );
    expect(
      summaryOf(
        const PhoneFaultAnswer(
          problem: 'a fault in the app (StateError)',
          answeredRequest: AnsweredRequest.installRegistration,
        ),
      ),
      'Install registration request stopped on the phone: a fault in the app (StateError).',
    );
  });

  test('a report names at most five refused fields, so it stays short', () {
    final outcome = _decide(
      ErrorStatusAnswer(
        httpStatus: 400,
        errorCode: 'VALIDATION_FAILED',
        apiRequestId: _apiRequestId,
        fieldProblems: [
          for (var index = 0; index < 20; index++)
            FieldProblem(path: 'field_number_$index', code: 'invalid_format'),
        ],
      ),
    );
    final summary = (outcome as FinishedOutcome).problemReport!.summary;
    expect(summary, contains('field_number_4 '));
    expect(summary, isNot(contains('field_number_5 ')));
    expect(summary.length, lessThanOrEqualTo(500));
  });
}
