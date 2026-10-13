import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// What one send of a clip came back as, read from the HTTP answer or its absence (§3.11).
///
/// The response parser makes it from the status, the body and the headers; `SendPolicy` decides
/// what it leads to. Sealed, so the policy handles every kind with no default branch. Nothing here
/// keeps the API's `message`, so it cannot reach the screen (S4-D13), and nothing internal from a
/// match survives the reading into what a screen shows (S4-D15); a 200 answer's body is kept beside
/// its reading only for History, which reads it again the same way (P6 design §3.14).
sealed class RecognitionAnswer {
  const RecognitionAnswer();
}

/// No HTTP answer at all: no network, a DNS failure, a timeout or a dropped connection.
final class NoAnswer extends RecognitionAnswer {
  const NoAnswer();
}

/// No HTTP answer, because the phone itself stopped the request: a fault in the app (an error while
/// building or reading it), or a plain `http` address outside the development flavour (S4-D25).
/// Not the network, so not "No connection": the listener sees the phone failure, and a developer
/// gets a crash report (§3.11).
final class PhoneFaultAnswer extends RecognitionAnswer {
  const PhoneFaultAnswer({required this.problem, this.answeredRequest = AnsweredRequest.recognize});

  /// What stopped the request, in the app's own words and type names only (never an exception's
  /// text), for the crash report; never shown.
  final String problem;

  /// The request the phone stopped: the clip's own, or the registration before it.
  final AnsweredRequest answeredRequest;
}

/// The listener cancelled the send on the Identifying screen (T28); whatever the server does with
/// it no longer matters.
final class CancelledAnswer extends RecognitionAnswer {
  const CancelledAnswer();
}

/// An HTTP answer arrived.
sealed class ReceivedAnswer extends RecognitionAnswer {
  const ReceivedAnswer({required this.apiRequestId});

  /// The API's id for the request, a UUID it logged: the `X-Request-Id` header when it is a UUID,
  /// else the body's request id when that is one (§3.8). Null when the answer had neither (a
  /// proxy's error page), so no reference code can be made from it (S4-ERROR-08).
  final String? apiRequestId;
}

/// 200 `MATCH` with a readable result. Its kind decides between the campaign card and the
/// advertiser's default card; a kind the app does not know has already been read as a campaign.
/// The recognition id is the result's own.
final class MatchAnswer extends ReceivedAnswer {
  const MatchAnswer({
    required this.result,
    required this.answerBody,
    required super.apiRequestId,
    this.capturedAt,
  });

  final RecognitionResult result;

  /// The 200 answer exactly as it came, kept only so History can store it as received and read it
  /// again with this same reader each time it is shown (P6 design §3.14). No screen reads it: the
  /// screen shows [result], which holds nothing internal (S4-D15).
  final Map<String, Object?> answerBody;

  /// The answer's `captured_at`, the capture time as the server corrected it; null when missing or
  /// unreadable. Kept, never shown: History shows the phone's own capture time (contract §5.14).
  final DateTime? capturedAt;
}

/// 200 `NO_MATCH`.
final class NoMatchAnswer extends ReceivedAnswer {
  const NoMatchAnswer({required super.apiRequestId, this.recognitionId, this.capturedAt});

  /// The answer's `recognition_id` when it is a lower-case UUID version 7; null otherwise, which
  /// changes nothing on screen.
  final String? recognitionId;

  /// As [MatchAnswer.capturedAt].
  final DateTime? capturedAt;
}

/// 200 `CHOOSE_STATION` with 2 to 4 readable candidates, each a different station: the ad is on
/// more than one station, and the listener picks theirs (P6 design §2.6, T19′).
final class ChooseStationAnswer extends ReceivedAnswer {
  ChooseStationAnswer({
    required this.recognitionId,
    required List<RecognitionResult> candidates,
    required this.answerBody,
    required super.apiRequestId,
    this.capturedAt,
  }) : candidates = List.unmodifiable(candidates);

  /// The recognition the choice is sent for: a lower-case UUID version 7.
  final String recognitionId;

  /// Each candidate with its own card, in the answer's order, which the app never changes.
  final List<RecognitionResult> candidates;

  /// As [MatchAnswer.answerBody]: History keeps it with the station the listener chose (T44).
  final Map<String, Object?> answerBody;

  /// As [MatchAnswer.capturedAt].
  final DateTime? capturedAt;
}

/// 200 with a status this version of the app does not know, from a newer server.
final class UnknownStatusAnswer extends ReceivedAnswer {
  const UnknownStatusAnswer({required super.apiRequestId});
}

/// 200 whose body cannot be read: not a JSON object, no status, `MATCH` without a readable result,
/// or a `CHOOSE_STATION` the chooser cannot show (T19″); or a 200 to the install registration
/// without a token the app can use.
final class UnreadableAnswer extends ReceivedAnswer {
  const UnreadableAnswer({
    required this.problem,
    required super.apiRequestId,
    this.answeredRequest = AnsweredRequest.recognize,
  });

  /// What could not be read, in field names only, for the crash report (never shown, never the
  /// body's own text).
  final String problem;

  /// The request this answers: the clip's own, or the registration before it.
  final AnsweredRequest answeredRequest;
}

/// An answer with any status other than 200, which this route never uses for success, read as the
/// API's error envelope where the body is one.
final class ErrorStatusAnswer extends ReceivedAnswer {
  const ErrorStatusAnswer({
    required this.httpStatus,
    required super.apiRequestId,
    this.errorCode,
    this.retryAfterSeconds,
    this.fieldProblems = const [],
    this.answeredRequest = AnsweredRequest.recognize,
  });

  final int httpStatus;

  /// The request this answers: the clip's own, or the registration before it.
  final AnsweredRequest answeredRequest;

  /// The envelope's `error.code` when it is well formed (`^[A-Z][A-Z0-9_]{1,63}$`); null when the
  /// body has no envelope or a malformed code. Only steers the decision, never shown: an unknown
  /// code is handled by its HTTP status.
  final String? errorCode;

  /// The `Retry-After` header as read, in whole seconds (an HTTP date already turned into
  /// seconds), before any clamping; null when missing or unreadable. Kept raw because "Too many
  /// tries" needs to know whether the server asked for more than a minute.
  final int? retryAfterSeconds;

  /// The envelope's `error.fields`: which request fields the API refused. For the crash report
  /// only, so a developer sees what the app sent wrong; never shown.
  final List<FieldProblem> fieldProblems;
}

/// Which request an answer is to: the clip's own `POST /recognize`, or the install registration
/// that must come before it (T15, T23). A failed registration leads where the same answer to the
/// clip would (§3.9); only the crash report's summary names which request it was.
enum AnsweredRequest { recognize, installRegistration }

/// One refused request field from an error envelope, e.g. `captured_at` / `invalid_format`.
final class FieldProblem {
  const FieldProblem({required this.path, required this.code});

  final String path;

  final String code;

  @override
  bool operator ==(Object other) =>
      other is FieldProblem && other.path == path && other.code == code;

  @override
  int get hashCode => Object.hash(path, code);

  @override
  String toString() => '$path $code';
}
