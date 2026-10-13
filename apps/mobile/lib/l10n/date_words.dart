import 'dart:ui' show Locale;

import 'package:intl/intl.dart';

import 'fallback_localizations.dart';

/// Weekday and month names in the listener's language (P6 design §2.9, §3.17; P6-HISTORY-09,
/// P6-D47): from `intl`'s date symbols when it has them for the language, and in English otherwise.
///
/// `intl` 0.20.2 has no date symbols for Bemba (`bem`) or Nyanja (`ny`), and `DateFormat` throws for
/// a language it has none for, so without this fallback History could not open in either once their
/// ARB files are added. English names in a Bemba screen are a known limit until `intl` or the app
/// carries Bemba and Nyanja date names. The numbers (the day of the month, the time) are written the
/// same in every language.
abstract final class DateWords {
  /// The short weekday, e.g. "Mon".
  static String shortWeekdayOf(DateTime day, Locale locale) =>
      DateFormat.E(dateLocaleFor(locale)).format(day);

  /// The day of the month and the short month, e.g. "3 Oct".
  static String dayAndShortMonthOf(DateTime day, Locale locale) =>
      '${day.day} ${DateFormat.MMM(dateLocaleFor(locale)).format(day)}';

  /// The locale `intl` writes dates in for [locale]: the language itself when `intl` has date
  /// symbols for it, otherwise English (the fallback language), or `intl`'s built-in American
  /// English when no symbols have been loaded at all.
  static String dateLocaleFor(Locale locale) {
    final english = FallbackLocalizations.fallbackLocale.toString();
    return Intl.verifiedLocale(
      locale.toString(),
      _hasDateSymbols,
      onFailure: (_) => _hasDateSymbols(english) ? english : _builtInLocale,
    )!;
  }

  /// The one locale `intl` always has date symbols for, loaded or not.
  static const String _builtInLocale = 'en_US';

  /// Whether `intl` has date symbols for [localeName]. Before any are loaded it knows only
  /// [_builtInLocale] and throws for every other name, which counts as not having them.
  static bool _hasDateSymbols(String localeName) {
    try {
      return DateFormat.localeExists(localeName);
    } on Object {
      return false;
    }
  }
}
