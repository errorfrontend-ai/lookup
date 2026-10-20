/// Why an account step did not go through, in the app's own words (never the server's): each is one message on the
/// step the listener is on (ADR-005, design §3.1). Nothing technical is ever shown.
enum AccountProblem {
  /// The email is not one the server will take.
  notAnEmail,

  /// No answer came: no signal, a timeout, a dropped connection.
  noConnection,

  /// Too many requests from this phone; wait a moment.
  tooManyTries,

  /// A new code was asked for within a minute of the last one.
  resendTooSoon,

  /// The code typed is wrong.
  codeIncorrect,

  /// The code typed is too old, or none was waiting.
  codeExpired,

  /// Five wrong tries locked the code.
  codeLocked,

  /// The step timed out or does not belong to this phone and email: start again from the email.
  startAgain,

  /// The age given is under 13.
  tooYoung,

  /// This phone already has a different account.
  alreadySignedIn,

  /// This version of the app is too old.
  updateRequired,

  /// The server could not do it just now (busy, a failure on its side, an answer the app cannot read).
  serverFailure,
}
