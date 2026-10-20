/// The rules of the sign-up form that the app checks before it asks the server, so a typing slip is told at once
/// and not after a round trip. The server checks again and is the authority (ADR-005, design §4).
abstract final class AccountRules {
  /// Younger than this cannot create an account; older than [maximumAge] is not accepted as an age.
  static const int minimumAge = 13;
  static const int maximumAge = 99;

  /// The email code's length.
  static const int codeLength = 6;

  /// The longest email the contract accepts.
  static const int longestEmailLength = 254;

  /// The consent wording this version of the app shows (`LISTENER_CONSENT_TEXT_VERSION` in the contracts); the
  /// server stores which wording was agreed and accepts only the current one.
  static const String consentTextVersion = 'listener-consent-2026-10';

  /// A local part, one `@`, and a domain with a dot, no spaces: enough to catch a slip. Whether the address is real
  /// is proved by the code that is sent to it.
  static final RegExp _looksLikeEmail = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$');

  static final RegExp _completeCode = RegExp(r'^[0-9]{6}$');

  static final RegExp _oneOrTwoDigits = RegExp(r'^[0-9]{1,2}$');

  /// [text] as the server will read it: trimmed and lower-cased, so one address is one account.
  static String normaliseEmail(String text) => text.trim().toLowerCase();

  /// Whether [text] could be an email address.
  static bool looksLikeEmail(String text) {
    final email = normaliseEmail(text);
    return email.length <= longestEmailLength && _looksLikeEmail.hasMatch(email);
  }

  /// Whether [text] is the right number of digits for an email code.
  static bool isCompleteCode(String text) => _completeCode.hasMatch(text);

  /// The age [text] says: a whole number from 1 to [maximumAge]; null for anything else. An age under
  /// [minimumAge] is read as typed, so the form can say why it cannot be used.
  static int? readAge(String text) {
    final trimmed = text.trim();
    if (!_oneOrTwoDigits.hasMatch(trimmed)) return null;
    final age = int.parse(trimmed);
    return age >= 1 && age <= maximumAge ? age : null;
  }

  /// Whether [age] may create an account.
  static bool isOldEnough(int age) => age >= minimumAge;
}
