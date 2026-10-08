import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/network/retry_after.dart';

void main() {
  final now = DateTime.utc(2026, 10, 8, 12);

  group('whole seconds are read exactly as sent, never clamped (the identify domain clamps)', () {
    for (final (header, seconds) in [
      ('12', 12),
      ('0', 0),
      ('1', 1),
      ('60', 60),
      ('999', 999),
      ('999999', 999999),
      (' 12 ', 12),
      ('007', 7),
    ]) {
      test('"$header" is $seconds seconds', () {
        expect(RetryAfter.parse(header, now: now), Duration(seconds: seconds));
      });
    }
  });

  group('an HTTP date is measured from now', () {
    test('the preferred form (IMF-fixdate)', () {
      expect(
        RetryAfter.parse('Thu, 08 Oct 2026 12:00:30 GMT', now: now),
        const Duration(seconds: 30),
      );
    });

    test("the C library's asctime form", () {
      expect(RetryAfter.parse('Thu Oct  8 12:01:00 2026', now: now), const Duration(minutes: 1));
    });

    test('part of a second is rounded up, so the app never sends early', () {
      final nowWithMilliseconds = DateTime.utc(2026, 10, 8, 12, 0, 0, 250);
      expect(
        RetryAfter.parse('Thu, 08 Oct 2026 12:00:30 GMT', now: nowWithMilliseconds),
        const Duration(seconds: 30),
      );
    });

    test('a date already passed is zero or less, not clamped', () {
      expect(RetryAfter.parse('Thu, 08 Oct 2026 12:00:00 GMT', now: now), Duration.zero);
      expect(
        RetryAfter.parse('Thu, 08 Oct 2026 11:59:30 GMT', now: now),
        const Duration(seconds: -30),
      );
    });

    test('a local "now" is compared in UTC', () {
      expect(
        RetryAfter.parse('Thu, 08 Oct 2026 12:00:30 GMT', now: now.toLocal()),
        const Duration(seconds: 30),
      );
    });
  });

  group('missing or unreadable gives nothing, so the caller uses its default', () {
    for (final header in <String?>[
      null,
      '',
      '   ',
      '-1',
      '1.5',
      '12s',
      '1000000',
      'soon',
      '0x10',
      'Thu, 08 Oct 2026 12:00:30',
      'Thu, 08 Oct 2026 12:00:30 GMT trailing',
      '<html>Service Unavailable</html>',
    ]) {
      test('${header == null ? 'no header' : '"$header"'} gives null', () {
        expect(RetryAfter.parse(header, now: now), isNull);
      });
    }
  });
}
