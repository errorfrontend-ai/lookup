import 'package:lookup_listener/features/identify/domain/recognition_answer.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_outcome.dart';
import 'package:lookup_listener/features/identify/domain/recognition_problem_report.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// The rules of S4-D10 and S4-D11 for one clip: which answer leads to which state (§3.11), and how
/// many times the clip may be sent again before the app gives up, so waiting is always bounded and
/// a bad header can never freeze the screen (gap 11).
///
/// Immutable and pure: it holds the counts for one clip so far. The flow starts every capture with
/// `const SendPolicy()` and, after an outcome that sends the clip again, keeps that outcome's
/// `nextPolicy`. Ids are passed in, so nothing here makes one.
final class SendPolicy {
  const SendPolicy({
    this.busyAnswerCount = 0,
    this.inProgressWaitCount = 0,
    this.registrationRetryCount = 0,
  });

  /// One clip is sent at most this many times on busy answers ("Try now" included); the answer to
  /// the last is the end (T21).
  static const int maximumSendsOnBusyAnswers = 4;

  /// At most this many waits after 409, then the next 409 is the end (T22).
  static const int maximumWaitsAfterInProgress = 2;

  /// At most this many registrations after 401, then the next 401 is the end (T23). Keeps a broken
  /// install under the API's six registrations a minute.
  static const int maximumRegistrationsAfterRefusedToken = 1;

  /// `Retry-After` is clamped to this range, so a zero, negative or huge value cannot make the app
  /// hammer the API or wait for ever.
  static const int shortestRetryAfterSeconds = 1;
  static const int longestRetryAfterSeconds = 60;

  /// The wait when a busy answer (502–504) or a 429 has no readable `Retry-After`: the API's own
  /// `BUSY_RETRY_AFTER_SECONDS`.
  static const int defaultBusyRetryAfterSeconds = 10;

  /// The wait when a 409 has no readable `Retry-After`.
  static const int defaultInProgressRetryAfterSeconds = 3;

  /// A 429 whose `Retry-After` is at most this is a short wait: "Please wait a minute" is true.
  static const int longestShortWaitSeconds = 60;

  /// Sends of this clip answered busy so far.
  final int busyAnswerCount;

  /// Waits already made after a 409 for this clip.
  final int inProgressWaitCount;

  /// Registrations already made after a 401 for this clip.
  final int registrationRetryCount;

  /// The wait for a `Retry-After` of [retryAfterSeconds] (null when missing or unreadable): the
  /// value clamped to 1–60 seconds, or [defaultSeconds] when there is none.
  static int retryDelaySecondsFrom(int? retryAfterSeconds, {required int defaultSeconds}) =>
      (retryAfterSeconds ?? defaultSeconds).clamp(
        shortestRetryAfterSeconds,
        longestRetryAfterSeconds,
      );

  /// What [answer] leads to. [reportRequestId] is a fresh request id from the flow, used only when
  /// the outcome sends a crash report (it becomes the report's `X-Request-Id`, and the phone
  /// failure's, when that is the outcome).
  RecognitionOutcome decide(RecognitionAnswer answer, {required String reportRequestId}) =>
      switch (answer) {
        NoAnswer() => const ConnectionLostOutcome(),
        CancelledAnswer() => const FinishedOutcome(IdleState()),
        MatchAnswer(:final result) => FinishedOutcome(switch (result.kind) {
          RecognitionResultKind.campaign => MatchedState(result: result),
          RecognitionResultKind.clientDefault => FallbackState(result: result),
        }),
        NoMatchAnswer() => const FinishedOutcome(NoMatchState()),
        ChooseStationAnswer() => const FinishedOutcome(
          ErrorState(failure: NewerAppNeededFailure(isSeveralStations: true)),
        ),
        UnknownStatusAnswer() => const FinishedOutcome(
          ErrorState(failure: NewerAppNeededFailure(isSeveralStations: false)),
        ),
        UnreadableAnswer(:final problem) => _serverFailure(
          answer,
          reportRequestId,
          isReported: true,
          explanation: 'the body could not be read: $problem',
        ),
        ErrorStatusAnswer() => _decideErrorStatus(answer, reportRequestId),
      };

  RecognitionOutcome _decideErrorStatus(
    ErrorStatusAnswer answer,
    String reportRequestId,
  ) => switch (answer.httpStatus) {
    400 when answer.errorCode == _invalidAudioCode => _recordingUnusable(answer, reportRequestId),
    401 => _afterRefusedToken(answer, reportRequestId),
    409 => _afterInProgress(answer, reportRequestId),
    426 => const FinishedOutcome(
      ErrorState(failure: NewerAppNeededFailure(isSeveralStations: false)),
    ),
    429 => FinishedOutcome(
      ErrorState(
        failure: TooManyTriesFailure(
          isShortWait:
              (answer.retryAfterSeconds ?? defaultBusyRetryAfterSeconds) <= longestShortWaitSeconds,
        ),
      ),
    ),
    502 || 503 || 504 => _afterBusy(answer, reportRequestId),
    >= 500 && < 600 => _serverFailure(
      answer,
      reportRequestId,
      isReported: false,
      explanation: 'the API failed and logged it',
    ),
    >= 400 && < 500 => _serverFailure(
      answer,
      reportRequestId,
      isReported: true,
      explanation: 'the API refused what the app sent',
    ),
    _ => _serverFailure(
      answer,
      reportRequestId,
      isReported: true,
      explanation: 'a status this route never answers',
    ),
  };

  RecognitionOutcome _recordingUnusable(ErrorStatusAnswer answer, String reportRequestId) {
    final apiRequestId = answer.apiRequestId;
    final summary =
        'Recognize answer ${_describe(answer)}: the API could not use the recorded clip.';
    if (apiRequestId == null) return _unloggedFailure(reportRequestId, summary);
    return FinishedOutcome(
      ErrorState(failure: RecordingUnusableFailure(requestId: apiRequestId)),
      problemReport: RecognitionProblemReport(
        reportRequestId: reportRequestId,
        relatedRequestId: apiRequestId,
        summary: summary,
      ),
    );
  }

  RecognitionOutcome _afterRefusedToken(ErrorStatusAnswer answer, String reportRequestId) {
    if (registrationRetryCount >= maximumRegistrationsAfterRefusedToken) {
      return _serverFailure(
        answer,
        reportRequestId,
        isReported: true,
        explanation: 'the install token was refused again after registering again',
      );
    }
    return RegisterAgainOutcome(
      nextPolicy: _with(registrationRetryCount: registrationRetryCount + 1),
    );
  }

  RecognitionOutcome _afterInProgress(ErrorStatusAnswer answer, String reportRequestId) {
    if (inProgressWaitCount >= maximumWaitsAfterInProgress) {
      return _serverFailure(
        answer,
        reportRequestId,
        isReported: false,
        explanation: 'still in progress after $inProgressWaitCount waits',
      );
    }
    return WaitAndResendOutcome(
      waitSeconds: retryDelaySecondsFrom(
        answer.retryAfterSeconds,
        defaultSeconds: defaultInProgressRetryAfterSeconds,
      ),
      nextPolicy: _with(inProgressWaitCount: inProgressWaitCount + 1),
    );
  }

  RecognitionOutcome _afterBusy(ErrorStatusAnswer answer, String reportRequestId) {
    final busySendCount = busyAnswerCount + 1;
    if (busySendCount >= maximumSendsOnBusyAnswers) {
      return _serverFailure(
        answer,
        reportRequestId,
        isReported: false,
        explanation: 'still busy after $busySendCount sends of the clip',
      );
    }
    return BusyOutcome(
      retryDelaySeconds: retryDelaySecondsFrom(
        answer.retryAfterSeconds,
        defaultSeconds: defaultBusyRetryAfterSeconds,
      ),
      nextPolicy: _with(busyAnswerCount: busySendCount),
    );
  }

  /// "Something went wrong on our side". The screen shows a code only for an id the API logged, so
  /// an answer with no API id becomes a phone failure and is always reported: the accepted report's
  /// id is then the code support can find (T21, S4-D9).
  RecognitionOutcome _serverFailure(
    ReceivedAnswer answer,
    String reportRequestId, {
    required bool isReported,
    required String explanation,
  }) {
    final apiRequestId = answer.apiRequestId;
    final summary = 'Recognize answer ${_describe(answer)}: $explanation.';
    if (apiRequestId == null) {
      return _unloggedFailure(reportRequestId, summary);
    }
    return FinishedOutcome(
      ErrorState(failure: ServerFailure(requestId: apiRequestId)),
      problemReport: isReported
          ? RecognitionProblemReport(
              reportRequestId: reportRequestId,
              relatedRequestId: apiRequestId,
              summary: summary,
            )
          : null,
    );
  }

  /// An answer that should have carried an id the API logged but did not: a phone failure, always
  /// reported, so the accepted report's id is a code support can find.
  static RecognitionOutcome _unloggedFailure(String reportRequestId, String summary) =>
      FinishedOutcome(
        ErrorState(
          failure: PhoneFailure(
            reportRequestId: reportRequestId,
            reportDelivery: ReportDelivery.sending,
          ),
        ),
        problemReport: RecognitionProblemReport(
          reportRequestId: reportRequestId,
          relatedRequestId: null,
          summary: '$summary The answer carried no request id.',
        ),
      );

  /// The answer in developer words: status, code and refused fields, never the API's message.
  static String _describe(ReceivedAnswer answer) => switch (answer) {
    ErrorStatusAnswer(:final httpStatus, :final errorCode, :final fieldProblems) => [
      'HTTP $httpStatus',
      ?errorCode,
      if (fieldProblems.isNotEmpty)
        '(fields: ${fieldProblems.take(_largestFieldProblemsDescribed).join(', ')})',
    ].join(' '),
    _ => 'HTTP 200',
  };

  SendPolicy _with({int? busyAnswerCount, int? inProgressWaitCount, int? registrationRetryCount}) =>
      SendPolicy(
        busyAnswerCount: busyAnswerCount ?? this.busyAnswerCount,
        inProgressWaitCount: inProgressWaitCount ?? this.inProgressWaitCount,
        registrationRetryCount: registrationRetryCount ?? this.registrationRetryCount,
      );

  static const String _invalidAudioCode = 'INVALID_AUDIO';

  /// Keeps the report's summary well inside the report's 500-character message.
  static const int _largestFieldProblemsDescribed = 5;

  @override
  bool operator ==(Object other) =>
      other is SendPolicy &&
      other.busyAnswerCount == busyAnswerCount &&
      other.inProgressWaitCount == inProgressWaitCount &&
      other.registrationRetryCount == registrationRetryCount;

  @override
  int get hashCode => Object.hash(busyAnswerCount, inProgressWaitCount, registrationRetryCount);

  @override
  String toString() =>
      'SendPolicy(busyAnswerCount: $busyAnswerCount, inProgressWaitCount: $inProgressWaitCount, '
      'registrationRetryCount: $registrationRetryCount)';
}
