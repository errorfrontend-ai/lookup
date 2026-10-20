/// Why the result held back for the listener could not be shown right after their account was made (ADR-005,
/// design §3.2). The account itself is made; only fetching the result failed, so the gate offers to try again.
enum AccountResultProblem {
  /// No answer came: no signal, a timeout, a dropped connection.
  noConnection,

  /// The server no longer has the result (an unknown or old recognition).
  notFound,

  /// The server could not give it just now, or this version of the app is too old.
  serverFailure,
}
