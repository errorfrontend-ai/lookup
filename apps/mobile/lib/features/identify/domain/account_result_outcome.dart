/// How asking for the result held back by the account gate came out (ADR-005, design §3.2), as the flow tells the
/// gate screen. Only [shown] leaves the gate: the flow has then moved on to the Result or "Which station?".
enum AccountResultOutcome {
  /// The result is showing.
  shown,

  /// No answer came: no signal, a timeout, a dropped connection.
  noConnection,

  /// The server no longer has the result.
  notFound,

  /// The server could not give it, or this version of the app is too old.
  problem,

  /// The flow is not at the gate any more (the listener left it).
  notWaiting,
}
