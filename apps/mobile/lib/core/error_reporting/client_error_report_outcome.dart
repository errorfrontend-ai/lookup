/// What happened to one crash report (design §3.19). Sealed, so the identify flow handles each:
/// only an accepted report may give a phone failure its reference code, because only then can
/// support find the log line (S4-ERRORREPORTING-08).
sealed class ClientErrorReportOutcome {
  const ClientErrorReportOutcome();

  /// Whether the API accepted the report (202).
  bool get isAccepted => this is ClientErrorReportAccepted;
}

/// The API answered 202: the report is in its log under [reportRequestId].
final class ClientErrorReportAccepted extends ClientErrorReportOutcome {
  const ClientErrorReportAccepted(this.reportRequestId);

  /// The report's own `X-Request-Id`, which the API logged it under; a phone failure's reference
  /// code is made from it.
  final String reportRequestId;
}

/// The report was sent but not accepted: no answer (offline reports are dropped in Step 4), a
/// refusal, or a failure on the phone while sending.
final class ClientErrorReportNotAccepted extends ClientErrorReportOutcome {
  const ClientErrorReportNotAccepted();
}

/// The report was not sent: the same error was sent less than a minute ago, or ten reports were.
final class ClientErrorReportHeldBack extends ClientErrorReportOutcome {
  const ClientErrorReportHeldBack();
}
