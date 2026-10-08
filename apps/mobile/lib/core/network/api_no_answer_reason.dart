/// Why an HTTP attempt brought no answer. To the identify flow every reason but [cancelled] means
/// the same thing, "no answer" (design §3.11: "No connection", the clip kept); the reasons are kept
/// apart only for the development log and for tests. None of them carries exception text.
enum ApiNoAnswerReason {
  /// No network, a DNS failure, a refused connection, or a secure connection that could not be
  /// made.
  noConnection,

  /// Connecting, sending or waiting for the answer took longer than the client allows (S4-D12).
  timedOut,

  /// The connection closed before the whole answer arrived.
  connectionDropped,

  /// The caller cancelled the request (the listener tapped Cancel on Identifying, T28).
  cancelled,

  /// The address was plain `http` outside the development flavour, so nothing was sent (S4-D25).
  plainHttpRefused,

  /// Something else on the phone stopped the request: a fault in the app, not the network.
  unexpectedFailure,
}
