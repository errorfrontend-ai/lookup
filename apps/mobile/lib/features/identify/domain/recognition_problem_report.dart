/// A crash report the flow sends to `/client-errors` after an answer the app caused or could not
/// read (the "Crash report" column of §3.11), so a developer learns about it without the listener
/// having to call anyone.
///
/// Private layer only: [summary] goes to the API's log, never to the screen. It holds HTTP
/// statuses, error codes and field names, never the API's `message`, a body, a token or anything
/// about the listener.
final class RecognitionProblemReport {
  const RecognitionProblemReport({
    required this.reportRequestId,
    required this.relatedRequestId,
    required this.summary,
  });

  /// The report's own `X-Request-Id`, made by the app. When the failure is a phone failure it
  /// carries the same id, so the code it shows once the report is accepted finds this report.
  final String reportRequestId;

  /// The API's id for the answer being reported (`relatedRequestId` in the report), so the two log
  /// lines can be read together; null when the answer had none.
  final String? relatedRequestId;

  /// What happened, for developers, e.g. "Recognize answer HTTP 400 VALIDATION_FAILED (fields:
  /// captured_at invalid_format): the API refused what the app sent." It names the request, so a
  /// failed install registration reads "Install registration answer …", and a request the phone
  /// itself stopped reads "Recognize request stopped on the phone: a fault in the app (StateError)."
  final String summary;
}
