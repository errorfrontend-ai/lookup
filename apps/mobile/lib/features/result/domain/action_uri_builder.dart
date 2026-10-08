import 'package:lookup_listener/features/result/domain/canonical_https_link.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';

/// Where WhatsApp chats start: followed by the number's digits without the `+`.
const String whatsAppAddressPrefix = 'https://wa.me/';

/// Google Maps directions (S4-D16: a listener wants to get there, not to see a search), followed by
/// `<latitude>%2C<longitude>`.
const String mapDirectionsAddressPrefix = 'https://www.google.com/maps/dir/?api=1&destination=';

final RegExp _phoneNumberE164 = RegExp(r'^\+[1-9][0-9]{6,14}$');

/// The address a button opens, or null when the action cannot be opened safely (the button then
/// opens nothing). Mirrors `buildActionUri` in `packages/contracts/src/action-card/action-uris.ts`.
///
/// The app builds call, WhatsApp and map addresses itself from the checked fields and never opens one
/// a server supplied, so a card cannot make the phone open `javascript:`, `data:` or any other
/// scheme: every address starts with `tel:+`, [whatsAppAddressPrefix], [mapDirectionsAddressPrefix],
/// or is a canonical https link. Pure: no platform or input/output calls, so it runs without Flutter.
String? buildActionUri(UiAction action) {
  switch (action) {
    case CallUiAction(:final phoneNumberE164):
      return _phoneNumberE164.hasMatch(phoneNumberE164) ? 'tel:$phoneNumberE164' : null;
    case WhatsAppUiAction(:final phoneNumberE164, :final prefilledText):
      if (!_phoneNumberE164.hasMatch(phoneNumberE164)) return null;
      final address = '$whatsAppAddressPrefix${phoneNumberE164.substring(1)}';
      if (prefilledText == null || prefilledText.isEmpty) return address;
      final encodedText = _encodeComponentOrNull(prefilledText);
      return encodedText == null ? null : '$address?text=$encodedText';
    case MapUiAction(:final latitude, :final longitude):
      final coordinates = _formatCoordinates(latitude, longitude);
      return coordinates == null ? null : '$mapDirectionsAddressPrefix$coordinates';
    case LinkUiAction(:final link):
      return isCanonicalHttpsLink(link) ? link : null;
  }
}

/// `latitude%2Clongitude`, each with six fixed decimals (about 10 cm), so the app prints exactly what
/// the TypeScript builder prints; null when either is not a finite number in range.
String? _formatCoordinates(double latitude, double longitude) {
  final isInRange =
      latitude.isFinite && longitude.isFinite && latitude.abs() <= 90 && longitude.abs() <= 180;
  return isInRange ? '${_withSixDecimals(latitude)}%2C${_withSixDecimals(longitude)}' : null;
}

/// JavaScript's `toFixed(6)`. Dart's `toStringAsFixed` gives the same digits, with the same rounding,
/// except for minus zero, which Dart prints as `-0.000000` and JavaScript as `0.000000`. A tiny
/// negative number that rounds to zero keeps its sign in both.
String _withSixDecimals(double value) => (value == 0 ? 0.0 : value).toStringAsFixed(6);

/// JavaScript's `encodeURIComponent`, but null where that would throw: on a lone surrogate, which
/// cannot be written as UTF-8. Dart's `Uri.encodeComponent` keeps the same characters unencoded
/// (letters, digits and `-_.!~*'()`), but would quietly turn a lone surrogate into U+FFFD instead.
String? _encodeComponentOrNull(String text) =>
    _hasLoneSurrogate(text) ? null : Uri.encodeComponent(text);

bool _hasLoneSurrogate(String text) {
  for (var index = 0; index < text.length; index++) {
    final codeUnit = text.codeUnitAt(index);
    final isHighSurrogate = codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
    final isLowSurrogate = codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;
    if (isLowSurrogate) return true;
    if (!isHighSurrogate) continue;
    final nextCodeUnit = index + 1 < text.length ? text.codeUnitAt(index + 1) : 0;
    if (nextCodeUnit < 0xDC00 || nextCodeUnit > 0xDFFF) return true;
    index++; // The pair's low half is part of this character.
  }
  return false;
}
