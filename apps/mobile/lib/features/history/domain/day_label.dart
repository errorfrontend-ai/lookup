/// Which day a moment fell on, as History and the station list name it (P6 design §2.9;
/// P6-HISTORY-09), with its time on the 24-hour clock, both in the phone's own time zone.
///
/// - [TodayLabel] and [YesterdayLabel] for the last two calendar days;
/// - [WeekdayLabel] ("Mon") for two to six days ago;
/// - [DateLabel] ("3 Oct") for anything older, and for a day after today, which only a clock moved
///   back can give.
///
/// Calendar days are counted on the phone's dates, not in 24-hour steps, so 23:50 yesterday is
/// "Yesterday" at 00:10 today, and a change to or from summer time moves nothing. The words come
/// from the language file and the weekday and month names from `intl`, in the presentation layer:
/// this layer holds no words (§3.2).
sealed class DayLabel {
  const DayLabel({required this.time});

  /// The label of [moment] seen at [now], both read in the phone's time zone.
  factory DayLabel.of(DateTime moment, {required DateTime now}) {
    final local = moment.toLocal();
    final time = timeOf(local);
    return switch (_calendarDaysBetween(local, now.toLocal())) {
      0 => TodayLabel(time: time),
      1 => YesterdayLabel(time: time),
      >= 2 && <= 6 => WeekdayLabel(day: local, time: time),
      _ => DateLabel(day: local, time: time),
    };
  }

  /// The time on the 24-hour clock, e.g. "09:12" or "18:40".
  final String time;

  /// [moment]'s time as `HH:mm`, in its own time zone.
  static String timeOf(DateTime moment) =>
      '${_twoDigits(moment.hour)}:${_twoDigits(moment.minute)}';

  /// How many calendar days [earlier] comes before [later], by their dates alone: 0 on the same
  /// date, negative when [earlier] is the later date.
  static int _calendarDaysBetween(DateTime earlier, DateTime later) {
    final earlierDate = DateTime.utc(earlier.year, earlier.month, earlier.day);
    final laterDate = DateTime.utc(later.year, later.month, later.day);
    return laterDate.difference(earlierDate).inDays;
  }

  static String _twoDigits(int number) => number.toString().padLeft(2, '0');
}

/// The same calendar day as now: "Today, 09:12".
final class TodayLabel extends DayLabel {
  const TodayLabel({required super.time});

  @override
  bool operator ==(Object other) => other is TodayLabel && other.time == time;

  @override
  int get hashCode => Object.hash(TodayLabel, time);

  @override
  String toString() => 'TodayLabel($time)';
}

/// The calendar day before today: "Yesterday, 18:40".
final class YesterdayLabel extends DayLabel {
  const YesterdayLabel({required super.time});

  @override
  bool operator ==(Object other) => other is YesterdayLabel && other.time == time;

  @override
  int get hashCode => Object.hash(YesterdayLabel, time);

  @override
  String toString() => 'YesterdayLabel($time)';
}

/// Two to six days ago: the short weekday, "Mon, 07:55".
final class WeekdayLabel extends DayLabel {
  const WeekdayLabel({required this.day, required super.time});

  /// The moment, in the phone's time zone; only its weekday is shown.
  final DateTime day;

  @override
  bool operator ==(Object other) =>
      other is WeekdayLabel && other.day.weekday == day.weekday && other.time == time;

  @override
  int get hashCode => Object.hash(WeekdayLabel, day.weekday, time);

  @override
  String toString() => 'WeekdayLabel(weekday ${day.weekday}, $time)';
}

/// A week ago or more, or a day after today: the day and short month, "3 Oct, 14:32".
final class DateLabel extends DayLabel {
  const DateLabel({required this.day, required super.time});

  /// The moment, in the phone's time zone; its day and month are shown.
  final DateTime day;

  @override
  bool operator ==(Object other) =>
      other is DateLabel &&
      other.day.month == day.month &&
      other.day.day == day.day &&
      other.time == time;

  @override
  int get hashCode => Object.hash(DateLabel, day.month, day.day, time);

  @override
  String toString() => 'DateLabel(${day.day}/${day.month}, $time)';
}
