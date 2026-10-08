import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/time/clock.dart';

import '../../support/fake_clock.dart';

void main() {
  group('Clock', () {
    test('gives the wall-clock time in UTC', () {
      final before = DateTime.now().toUtc();
      final now = Clock().now();
      final after = DateTime.now().toUtc();
      expect(now.isUtc, isTrue);
      expect(now.isBefore(before), isFalse);
      expect(now.isAfter(after), isFalse);
    });

    test('measures monotonic time from zero, and it only moves forward', () async {
      final clock = Clock();
      final first = clock.monotonicElapsed();
      expect(first, lessThan(const Duration(seconds: 1)));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      final second = clock.monotonicElapsed();
      expect(second - first, greaterThanOrEqualTo(const Duration(milliseconds: 20)));
    });
  });

  group('FakeClock', () {
    test('starts at the given time, in UTC, with zero monotonic time', () {
      final clock = FakeClock(startsAt: DateTime.utc(2026, 10, 8, 9, 30));
      expect(clock.now(), DateTime.utc(2026, 10, 8, 9, 30));
      expect(clock.now().isUtc, isTrue);
      expect(clock.monotonicElapsed(), Duration.zero);
    });

    test('advance moves both clocks together', () {
      final clock = FakeClock()..advance(const Duration(seconds: 8));
      expect(clock.now(), DateTime.utc(2026, 10, 8, 12, 0, 8));
      expect(clock.monotonicElapsed(), const Duration(seconds: 8));
    });

    test('setting the wall clock (a listener changing the time) leaves monotonic time alone', () {
      final clock = FakeClock()
        ..advance(const Duration(seconds: 3))
        ..setWallClock(DateTime.utc(2020));
      expect(clock.now(), DateTime.utc(2020));
      expect(clock.monotonicElapsed(), const Duration(seconds: 3));
    });

    test('refuses to move backwards', () {
      expect(() => FakeClock().advance(const Duration(seconds: -1)), throwsArgumentError);
    });

    test('stands in for the real clock', () {
      final Clock clock = FakeClock();
      expect(clock.now(), DateTime.utc(2026, 10, 8, 12));
    });
  });
}
