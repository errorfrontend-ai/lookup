/// The API routes the app calls, by their paths relative to `LOOKUP_API_BASE_URL`, and which of them
/// carry the install token (design §3.12; contract §1.0, amendment A3).
///
/// - The listener routes carry it on every request: `recognize`, `stations`, `engagements`, a
///   recognition's `choice` and `report` and the result held back for it, and the listener's account
///   (`listener-account` and its `code`, `verify` and `sign-out`; ADR-005).
/// - `installs` carries it only on a re-registration, when the app still holds a token that has not
///   reached its expiry (amendment A3); a first registration, and one after the token was refused,
///   carry none. The install repository decides; the client only lets it through.
/// - `client-errors` never carries it: a crash report is public and must not tie an install to it.
///
/// Any other path never carries it, even when a caller passes one, so a token can never reach a
/// route the contract does not name.
abstract final class ListenerRoute {
  /// Registering the install, and registering it again (§1.1).
  static const String installs = 'installs';

  /// Sending a clip (§1.2).
  static const String recognize = 'recognize';

  /// The listed stations, for "My station" (§1.4).
  static const String stations = 'stations';

  /// A button tap on a result (§1.5).
  static const String engagements = 'engagements';

  /// A crash report (§1.7); public, and never carries the token.
  static const String clientErrors = 'client-errors';

  /// The listener's choice of station for a recognition that offered several (§1.3).
  static String choiceFor(String recognitionId) => 'recognitions/$recognitionId/choice';

  /// A report about a recognition's result (§1.6).
  static String reportFor(String recognitionId) => 'recognitions/$recognitionId/report';

  /// The result the server held back with `ACCOUNT_REQUIRED`, asked for once the listener has an account
  /// (ADR-005).
  static String revealFor(String recognitionId) => 'recognitions/$recognitionId';

  /// The listener's account: read it (GET), create it (POST) and delete it (DELETE).
  static const String listenerAccount = 'listener-account';

  /// Emails a 6-digit code to an address.
  static const String listenerAccountCode = 'listener-account/code';

  /// Checks the code that came to the email.
  static const String listenerAccountVerify = 'listener-account/verify';

  /// This phone leaves its account.
  static const String listenerAccountSignOut = 'listener-account/sign-out';

  static const Set<String> _routesWithToken = {
    recognize,
    stations,
    engagements,
    listenerAccount,
    listenerAccountCode,
    listenerAccountVerify,
    listenerAccountSignOut,
  };

  /// `recognitions/<lower-case UUID>`, with `/choice` or `/report` after it: nothing else under
  /// `recognitions/`.
  static final RegExp _recognitionFollowUp = RegExp(
    r'^recognitions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
    r'(?:/(?:choice|report))?$',
  );

  /// Whether [path] is one of the contract's listener routes, each of whose requests carries the
  /// install token.
  static bool carriesInstallToken(String path) =>
      _routesWithToken.contains(path) || _recognitionFollowUp.hasMatch(path);

  /// Whether a request to [path] may carry the install token a caller gives: every listener route,
  /// and `installs` for a re-registration (amendment A3). Never `client-errors` or anything else.
  static bool mayCarryInstallToken(String path) => carriesInstallToken(path) || path == installs;
}
