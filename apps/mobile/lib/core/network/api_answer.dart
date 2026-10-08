import 'api_answer_body.dart';
import 'api_no_answer_reason.dart';

export 'api_answer_body.dart';
export 'api_no_answer_reason.dart';

/// What one HTTP attempt came to: an answer with any status, or no answer at all. `ApiClient`
/// returns one of these for every request and never throws, so a caller cannot forget a failure
/// path and no exception text can travel towards the screen (design §3.8). Sealed, so callers
/// handle both.
///
/// It only reports what came back. Deciding what a status means (busy, too many tries, register
/// again) is the caller's job: the identify domain for recognitions, the install repository for
/// registrations.
sealed class ApiAnswer {
  const ApiAnswer({required this.sentRequestId});

  /// The `X-Request-Id` the app made for this attempt: a version-4 UUID, new for every attempt
  /// (S4-D9). Made before the request, so it is known even when no answer comes.
  final String sentRequestId;
}

/// An HTTP answer arrived, whatever its status.
final class ApiAnswerReceived extends ApiAnswer {
  const ApiAnswerReceived({
    required super.sentRequestId,
    required this.status,
    required this.body,
    this.echoedRequestId,
    this.retryAfter,
  });

  /// The HTTP status, e.g. 200, 401 or 503.
  final int status;

  /// The answer's `X-Request-Id` header exactly as it came (the API echoes the app's id or gives
  /// its own); null when missing or sent more than once. Not checked here: the reader decides
  /// whether it is an id the API logged (design §3.8).
  final String? echoedRequestId;

  /// The answer's `Retry-After` header exactly as it came; null when missing or sent more than
  /// once. `RetryAfter.parse` reads it; the identify domain clamps it.
  final String? retryAfter;

  /// The body, decoded as JSON or marked as not JSON.
  final ApiAnswerBody body;
}

/// No answer came: no network, a timeout, a dropped connection, a cancel, or a request the phone
/// itself stopped (a fault in the app, or plain `http` refused).
final class ApiAnswerNotReceived extends ApiAnswer {
  const ApiAnswerNotReceived({
    required super.sentRequestId,
    required this.reason,
    this.faultTypeName,
  });

  /// Why: the network, the listener's cancel, or the phone itself.
  final ApiNoAnswerReason reason;

  /// For [ApiNoAnswerReason.unexpectedFailure]: the type of the error that stopped the request on
  /// the phone, e.g. `StateError`, for the crash report. Its name only, never its text, which can
  /// quote addresses, headers or answers. Null when nothing was thrown (a refused path, an answer
  /// with no status) and for every other reason.
  final String? faultTypeName;
}
