import 'package:lookup_listener/core/time/clock.dart';

/// A clock tests move by hand (design §4.1). [advance] moves both clocks, as time passing does;
/// [setWallClock] moves only the wall clock, as a listener changing the phone's time does, which is
/// how tests prove durations are measured on the monotonic clock.
class FakeClock implements Clock {
  /// Starts at [startsAt] (UTC), or at noon UTC on 8 October 2026, with zero monotonic time.
  FakeClock({DateTime? startsAt})
    : _wallClock = (startsAt ?? DateTime.utc(2026, 10, 8, 12)).toUtc();

  DateTime _wallClock;
  Duration _monotonicElapsed = Duration.zero;

  @override
  DateTime now() => _wallClock;

  @override
  Duration monotonicElapsed() => _monotonicElapsed;

  /// Moves both clocks forward by [duration].
  void advance(Duration duration) {
    if (duration.isNegative) {
      throw ArgumentError.value(duration, 'duration', 'time only moves forward');
    }
    _wallClock = _wallClock.add(duration);
    _monotonicElapsed += duration;
  }

  /// Sets the wall clock to [time]; the monotonic clock does not move.
  void setWallClock(DateTime time) => _wallClock = time.toUtc();
}
