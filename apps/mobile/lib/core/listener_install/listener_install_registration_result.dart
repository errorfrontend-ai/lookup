import '../network/api_answer.dart';
import 'listener_install_credentials.dart';

/// Whether the phone has an install token it can use, after registering if it had to (design §3.9).
/// Sealed, so the identify flow handles both.
sealed class ListenerInstallRegistrationResult {
  const ListenerInstallRegistrationResult();
}

/// The phone has a token to send: a stored one still in date, or a new one from the API.
final class ListenerInstallRegistered extends ListenerInstallRegistrationResult {
  const ListenerInstallRegistered(this.credentials);

  /// The install id and a token that is not null.
  final ListenerInstallCredentials credentials;

  /// The token for `Authorization: Bearer`.
  String get installToken => credentials.installToken!;
}

/// The phone has no token it can use, because registering failed. The failure maps to a screen the
/// same way as a recognize answer (§3.9, §3.11): no answer gives "No connection", 429 "Too many
/// tries", 5xx Busy or the server failure, and a 200 the app could not read is a server failure
/// with a crash report.
final class ListenerInstallNotRegistered extends ListenerInstallRegistrationResult {
  const ListenerInstallNotRegistered({required this.answer, this.readingProblem});

  /// What `POST /installs` came to, as the API client reported it.
  final ApiAnswer answer;

  /// For a 200 that could not be read: which rule the body broke, in field names only, for the
  /// crash report (never shown, never the body's own text). Null otherwise.
  final String? readingProblem;

  /// The API answered 200, but not with a registration the app could read.
  bool get isAnswerUnreadable => readingProblem != null;
}
