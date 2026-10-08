import 'package:fake_async/fake_async.dart';
import 'package:lookup_listener/core/time/clock.dart';

/// A clock that follows `fake_async` time, for tests where timers and the clock must agree: the
/// Listening countdown, Busy waits, and `sent_at` moving on with each delayed send.
class FakeAsyncClock implements Clock {
  /// Starts at [startsAt] (UTC), or at noon UTC on 8 October 2026, when the fake time is zero.
  FakeAsyncClock(this._fakeAsync, {DateTime? startsAt})
    : _startsAt = (startsAt ?? DateTime.utc(2026, 10, 8, 12)).toUtc();

  final FakeAsync _fakeAsync;
  final DateTime _startsAt;

  @override
  DateTime now() => _startsAt.add(_fakeAsync.elapsed);

  @override
  Duration monotonicElapsed() => _fakeAsync.elapsed;
}
