import 'dart:ui' show Locale;

import 'package:lookup_listener/features/history/domain/day_label.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';
import 'package:lookup_listener/l10n/date_words.dart';

/// A [DayLabel] in words (P6 design §2.9; P6-HISTORY-09): "Today" and "Yesterday" from the language
/// file, the short weekday ("Mon") and the day and short month ("3 Oct") from `intl` in the
/// listener's language, or English when `intl` has no date names for it (P6-D47), each with the
/// time on the 24-hour clock: "Today, 09:12".
abstract final class DayLabelWords {
  /// The day and the time, e.g. "Today, 09:12", "Mon, 07:55" or "3 Oct, 14:32".
  static String dayAndTimeOf(DayLabel label, AppLocalizations words, Locale locale) =>
      words.dayAndTime(dayOf(label, words, locale), label.time);

  /// The day alone, e.g. "Yesterday" or "Mon".
  static String dayOf(DayLabel label, AppLocalizations words, Locale locale) => switch (label) {
    TodayLabel() => words.dayToday,
    YesterdayLabel() => words.dayYesterday,
    WeekdayLabel(:final day) => DateWords.shortWeekdayOf(day, locale),
    DateLabel(:final day) => DateWords.dayAndShortMonthOf(day, locale),
  };
}
