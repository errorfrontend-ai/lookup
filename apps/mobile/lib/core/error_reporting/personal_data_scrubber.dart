/// Removes what could identify a listener or unlock their install from text before it leaves the
/// phone in a crash report or reaches the development log (S4-ERRORREPORTING-05, S4-PRIVACY-04).
///
/// The Dart mirror of `scrubPersonalData` and `pathOnly` in
/// apps/api/src/common/privacy/scrub-personal-data.ts, pattern for pattern and in the same order,
/// so the phone removes at least what the server would; the tests use the server test's inputs.
/// Dart's regular expressions follow JavaScript's, so the patterns are copied unchanged. Before
/// them, the phone also replaces the two secrets it knows exactly: its stored install token and
/// install id.
abstract final class PersonalDataScrubber {
  /// What replaces the stored install id.
  static const String installIdReplacement = '[install]';

  /// What replaces the stored install token, and any other long token-like text.
  static const String tokenReplacement = '[token]';

  /// Known secrets shorter than this are not replaced by value: replacing a one- or two-character
  /// "secret" everywhere would wreck the text, and no real token or install id is that short.
  static const int _shortestKnownSecretLength = 8;

  static final RegExp _emailAddress = RegExp(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}');
  static final RegExp _phoneNumberLikeDigits = RegExp(r'\+?\d[\d\s-]{6,}\d');
  static final RegExp _longTokenLikeText = RegExp(r'[A-Za-z0-9_-]{32,}');
  static final RegExp _addressQueryOrFragment = RegExp(r'(https?:\/\/[^\s?#]*)[?#][^\s]*');
  static final RegExp _queryOrFragmentStart = RegExp('[?#]');

  /// [text] with the install token, the install id, email addresses, phone-number-like digit runs,
  /// long token-like strings and address query strings and fragments removed.
  static String scrub(String text, {String? installId, String? installToken}) {
    var scrubbed = text;
    if (installToken != null && installToken.length >= _shortestKnownSecretLength) {
      scrubbed = scrubbed.replaceAll(installToken, tokenReplacement);
    }
    if (installId != null && installId.length >= _shortestKnownSecretLength) {
      // A UUID means the same in upper and lower case.
      scrubbed = scrubbed.replaceAll(
        RegExp(RegExp.escape(installId), caseSensitive: false),
        installIdReplacement,
      );
    }
    return scrubbed
        .replaceAll(_emailAddress, '[email]')
        .replaceAll(_phoneNumberLikeDigits, '[number]')
        .replaceAll(_longTokenLikeText, tokenReplacement)
        .replaceAllMapped(_addressQueryOrFragment, (match) => match.group(1) ?? '');
  }

  /// A location reduced to its path: no query string, no fragment.
  static String pathOnly(String location) => location.split(_queryOrFragmentStart).first;
}
