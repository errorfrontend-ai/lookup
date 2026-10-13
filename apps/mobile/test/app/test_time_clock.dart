import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/time/clock.dart';

/// The wall clock and the monotonic clock of the widget test's fake time, so a wait the outbox
/// stores as a time of day falls due when the test's timers say it has passed.
class TestTimeClock implements Clock {
  TestTimeClock(this._tester) : _startedAt = _tester.binding.clock.now();

  final WidgetTester _tester;
  final DateTime _startedAt;

  @override
  DateTime now() => _tester.binding.clock.now().toUtc();

  @override
  Duration monotonicElapsed() => _tester.binding.clock.now().difference(_startedAt);
}
