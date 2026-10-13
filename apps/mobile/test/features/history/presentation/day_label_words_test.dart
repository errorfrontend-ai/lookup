import 'dart:ui' show Locale;

import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:lookup_listener/features/history/domain/day_label.dart';
import 'package:lookup_listener/features/history/presentation/day_label_words.dart';
import 'package:lookup_listener/l10n/date_words.dart';

import '../../../support/english_words.dart';

/// A day label in words (P6 design §2.9; P6-HISTORY-09, P6-D47): "Today" and "Yesterday" from the
/// language file, the weekday and month from `intl`, and English names for a language `intl` has no
/// date names for (Bemba, Nyanja).
void main() {
  const english = Locale('en');
  const bemba = Locale('bem');
  const nyanja = Locale('ny');
  // Tuesday 13 October 2026, 15:00 on the phone.
  final now = DateTime(2026, 10, 13, 15);

  String words(DateTime moment, Locale locale) =>
      DayLabelWords.dayAndTimeOf(DayLabel.of(moment, now: now), englishWords, locale);

  group('before any date names are loaded', () {
    test('every language gets the built-in English names, never an exception', () {
      for (final locale in [english, bemba, nyanja]) {
        expect(DateWords.dateLocaleFor(locale), 'en_US', reason: '$locale');
        expect(words(DateTime(2026, 10, 12, 18, 40), locale), 'Yesterday, 18:40');
        expect(words(DateTime(2026, 10, 7, 6, 30), locale), 'Wed, 06:30');
        expect(words(DateTime(2026, 10, 3, 14, 32), locale), '3 Oct, 14:32');
      }
    });
  });

  group('with the date names loaded, as Flutter loads them in the app', () {
    setUpAll(initializeDateFormatting);

    test('"Today, 09:12", "Yesterday, 18:40", "Mon, 07:55", "3 Oct, 14:32" (P6-HISTORY-09)', () {
      expect(words(DateTime(2026, 10, 13, 9, 12), english), 'Today, 09:12');
      expect(words(DateTime(2026, 10, 12, 18, 40), english), 'Yesterday, 18:40');
      expect(words(DateTime(2026, 10, 6, 7, 55), english), '6 Oct, 07:55');
      expect(words(DateTime(2026, 10, 11, 7, 55), english), 'Sun, 07:55');
      expect(words(DateTime(2026, 10, 3, 14, 32), english), '3 Oct, 14:32');
      // Monday 12 October seen on Wednesday 14 October: two days ago, so its weekday.
      expect(
        DayLabelWords.dayAndTimeOf(
          DayLabel.of(DateTime(2026, 10, 12, 7, 55), now: DateTime(2026, 10, 14, 9)),
          englishWords,
          english,
        ),
        'Mon, 07:55',
      );
    });

    test('Bemba and Nyanja: no exception, the English "Mon" and "3 Oct" (P6-D47)', () {
      for (final locale in [bemba, nyanja]) {
        expect(DateWords.dateLocaleFor(locale), 'en', reason: '$locale');
        expect(
          DayLabelWords.dayAndTimeOf(
            DayLabel.of(DateTime(2026, 10, 12, 7, 55), now: DateTime(2026, 10, 14, 9)),
            englishWords,
            locale,
          ),
          'Mon, 07:55',
        );
        expect(words(DateTime(2026, 10, 3, 14, 32), locale), '3 Oct, 14:32');
      }
    });

    test('a language intl knows names its days itself', () {
      expect(DateWords.dateLocaleFor(const Locale('fr')), 'fr');
      expect(DateWords.shortWeekdayOf(DateTime(2026, 10, 12), const Locale('fr')), 'lun.');
    });
  });
}
