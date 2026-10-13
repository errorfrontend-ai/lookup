import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/history/domain/day_label.dart';

/// Which day a History row names, and its 24-hour time, in the phone's own time zone (P6 design
/// §2.9; P6-HISTORY-09). Times are made in the phone's time zone, as the rows read them.
void main() {
  // Tuesday 13 October 2026, 15:00 on the phone.
  final now = DateTime(2026, 10, 13, 15);

  test(
    'the same day is Today, the day before Yesterday, with the 24-hour time (P6-HISTORY-09)',
    () {
      expect(DayLabel.of(DateTime(2026, 10, 13, 9, 12), now: now), const TodayLabel(time: '09:12'));
      expect(DayLabel.of(DateTime(2026, 10, 13, 0, 1), now: now), const TodayLabel(time: '00:01'));
      expect(
        DayLabel.of(DateTime(2026, 10, 12, 18, 40), now: now),
        const YesterdayLabel(time: '18:40'),
      );
    },
  );

  test('two to six days ago is the weekday, a week or more the day and month (P6-HISTORY-09)', () {
    final twoDaysAgo = DayLabel.of(DateTime(2026, 10, 11, 7, 55), now: now);
    expect(twoDaysAgo, isA<WeekdayLabel>());
    expect((twoDaysAgo as WeekdayLabel).day.weekday, DateTime.sunday);
    expect(twoDaysAgo.time, '07:55');
    final sixDaysAgo = DayLabel.of(DateTime(2026, 10, 7, 6, 30), now: now);
    expect(sixDaysAgo, isA<WeekdayLabel>());
    expect((sixDaysAgo as WeekdayLabel).day.weekday, DateTime.wednesday);
    final sevenDaysAgo = DayLabel.of(DateTime(2026, 10, 6, 14, 32), now: now);
    expect(sevenDaysAgo, isA<DateLabel>());
    expect((sevenDaysAgo as DateLabel).day.day, 6);
    expect(sevenDaysAgo.day.month, DateTime.october);
    expect(sevenDaysAgo.time, '14:32');
  });

  test('days are counted on the calendar, not in 24-hour steps', () {
    final justAfterMidnight = DateTime(2026, 10, 13, 0, 10);
    expect(
      DayLabel.of(DateTime(2026, 10, 12, 23, 50), now: justAfterMidnight),
      const YesterdayLabel(time: '23:50'),
    );
    expect(
      DayLabel.of(DateTime(2026, 10, 11, 23, 59), now: justAfterMidnight),
      isA<WeekdayLabel>(),
    );
  });

  test('times are the 24-hour clock in two digits each', () {
    expect(DayLabel.timeOf(DateTime(2026, 10, 13, 9, 5)), '09:05');
    expect(DayLabel.timeOf(DateTime(2026, 10, 13, 23, 59)), '23:59');
    expect(DayLabel.timeOf(DateTime(2026, 10, 13)), '00:00');
  });

  test('a day after today (a clock moved back) is a date, never Today', () {
    final label = DayLabel.of(DateTime(2026, 10, 14, 8), now: now);
    expect(label, isA<DateLabel>());
    expect((label as DateLabel).day.day, 14);
  });

  test('a moment in UTC is read in the phone\'s time zone', () {
    final moment = DateTime(2026, 10, 13, 9, 12);
    expect(DayLabel.of(moment.toUtc(), now: now.toUtc()), const TodayLabel(time: '09:12'));
  });
}
