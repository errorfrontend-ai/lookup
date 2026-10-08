import 'package:lookup_listener/features/result/domain/punycode_decoder.dart';

/// The contract's pattern for a link, copied character for character from `HTTPS_LINK` in
/// `packages/contracts/src/action-card/action-card-reader.ts`: lower-case https, a host of letters,
/// digits and hyphens with at least one dot and a top-level label starting with a letter, no port, no
/// user name, and printable ASCII after it. Dart's RegExp follows JavaScript's rules, so it matches
/// the same strings.
final RegExp _httpsLinkPattern = RegExp(
  r'^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9](?:[\/?#][\x21-\x7E]*)?$',
);

/// Splits a link that passed the pattern into host, path, query (with its `?`) and fragment (with its `#`).
final RegExp _linkParts = RegExp(r'^https:\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$');

/// Characters the WHATWG parser percent-encodes in each part, as Node 24 does (pinned case by case in
/// `fixtures/action-card/canonical-links.json`). Spaces and control characters are not listed: the
/// pattern refuses them already.
const Set<String> _encodedInPath = {'"', '<', '>', '`', '{', '}', '^'};
const Set<String> _encodedInQuery = {'"', '<', '>', "'"};
const Set<String> _encodedInFragment = {'"', '<', '>', '`'};

/// Whether [link] is an https link that Node's URL parser would leave exactly as written.
///
/// The TypeScript reader asks `new URL(link).href === link`. Dart has no WHATWG URL parser, and
/// `Uri.parse` refuses or rewrites links Node keeps (`100%off`, `%c3%a9`), so the parser's rewrites are
/// written out here instead: a lower-case host whose `xn--` labels decode, a slash after the host, no
/// dot segment and no backslash in the path, and no character the parser would percent-encode in the
/// part it sits in. A link that is not canonical gives the button nothing to open, so a card can never
/// lead the browser somewhere other than the address the station saved.
bool isCanonicalHttpsLink(String link) {
  if (!_httpsLinkPattern.hasMatch(link)) return false;
  final parts = _linkParts.firstMatch(link);
  if (parts == null) return false;
  return _isCanonicalHost(parts.group(1) ?? '') &&
      _isCanonicalPath(parts.group(2) ?? '') &&
      !_containsAny(parts.group(3) ?? '', _encodedInQuery) &&
      !_containsAny(parts.group(4) ?? '', _encodedInFragment);
}

/// The parser lower-cases a host, and refuses an `xn--` label that does not decode to a label it
/// accepts. The pattern has already limited the host to ASCII letters, digits, hyphens and dots.
bool _isCanonicalHost(String host) {
  if (host != host.toLowerCase()) return false;
  for (final label in host.split('.')) {
    if (!label.startsWith('xn--')) continue;
    final codePoints = decodePunycode(label.substring(4));
    if (codePoints == null || !_isAcceptedInternationalLabel(codePoints)) return false;
  }
  return true;
}

/// The parser adds a slash when nothing follows the host (or puts one before a query or fragment),
/// turns `\` into `/`, removes `.` and `..` segments, and percent-encodes [_encodedInPath].
bool _isCanonicalPath(String path) {
  if (!path.startsWith('/')) return false;
  if (path.contains(r'\') || _containsAny(path, _encodedInPath)) return false;
  return !path.split('/').any(_isDotSegment);
}

/// `.` or `..`, where a dot may also be written `%2e` in either case: `%2E%2e` and `.%2E` are `..`,
/// but `offer%2eterms` is an ordinary segment.
bool _isDotSegment(String segment) {
  final decodedDots = segment.toLowerCase().replaceAll('%2e', '.');
  return decodedDots == '.' || decodedDots == '..';
}

bool _containsAny(String text, Set<String> characters) => characters.any(text.contains);

/// Whether the decoded label is one Node's parser accepts as it stands.
///
/// Node applies the whole Unicode IDNA table (UTS #46), Unicode normalisation and the bidirectional
/// and joiner rules. The app checks the parts a pasted link plausibly breaks: a label that decodes to
/// nothing but ASCII, one starting with a combining accent, a code point that is never allowed (control
/// characters, spaces, invisible formatting, private use, non-characters), and a code point the table
/// would change (capital letters, full-width forms, other full stops). Links have already passed the
/// whole rule when the station saved the card and when the API answered, so this is the second line;
/// where the two differ, the app shows fewer buttons, never more.
bool _isAcceptedInternationalLabel(List<int> codePoints) {
  // Punycode for a label with no non-ASCII character is refused (WHATWG URL issue 760).
  if (codePoints.every((codePoint) => codePoint < 0x80)) return false;
  if (_isCombiningAccent(codePoints.first)) return false;
  for (final codePoint in codePoints) {
    if (_isNeverAllowedInHost(codePoint) || _changesWhenLowerCased(codePoint)) return false;
  }
  return true;
}

bool _isCombiningAccent(int codePoint) =>
    _isBetween(codePoint, 0x0300, 0x036F) ||
    _isBetween(codePoint, 0x1AB0, 0x1AFF) ||
    _isBetween(codePoint, 0x1DC0, 0x1DFF) ||
    _isBetween(codePoint, 0x20D0, 0x20FF) ||
    _isBetween(codePoint, 0xFE20, 0xFE2F);

bool _isNeverAllowedInHost(int codePoint) =>
    _isBetween(codePoint, 0x0080, 0x00A0) || // C1 controls and the no-break space
    codePoint == 0x00AD || // soft hyphen
    codePoint == 0x034F || // combining grapheme joiner
    codePoint == 0x1680 || // ogham space
    _isBetween(codePoint, 0x180B, 0x180F) || // Mongolian variation selectors and vowel separator
    _isBetween(
      codePoint,
      0x2000,
      0x200F,
    ) || // spaces, zero-width characters, joiners, direction marks
    _isBetween(
      codePoint,
      0x2028,
      0x202F,
    ) || // line and paragraph separators, embeddings, narrow space
    _isBetween(codePoint, 0x205F, 0x206F) || // word joiner, invisible operators, isolates
    codePoint == 0x3000 || // ideographic space
    codePoint == 0x3002 || // ideographic full stop (read as a dot)
    _isBetween(codePoint, 0xD800, 0xDFFF) || // surrogates
    _isBetween(codePoint, 0xE000, 0xF8FF) || // private use
    _isBetween(codePoint, 0xFDD0, 0xFDEF) || // non-characters
    _isBetween(codePoint, 0xFE00, 0xFE0F) || // variation selectors
    codePoint == 0xFEFF || // byte order mark
    _isBetween(codePoint, 0xFF01, 0xFF5E) || // full-width forms of ASCII
    codePoint == 0xFF61 || // half-width ideographic full stop
    _isBetween(codePoint, 0xFFF0, 0xFFFF) || // specials
    _isBetween(codePoint, 0xE0000, 0xE0FFF) || // tags and more variation selectors
    codePoint >= 0xF0000 || // private use planes
    (codePoint & 0xFFFE) == 0xFFFE; // the last two code points of every plane

bool _changesWhenLowerCased(int codePoint) {
  final character = String.fromCharCode(codePoint);
  return character.toLowerCase() != character;
}

bool _isBetween(int codePoint, int first, int last) => codePoint >= first && codePoint <= last;
