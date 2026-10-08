/// The app's two clocks, behind one class so tests can replace both (design §4.1, `FakeClock`).
///
/// [now] is the phone's wall clock, which the listener can set wrong or which can jump; it is used
/// only for times the API reads (`captured_at`, `sent_at`, which the server corrects with
/// `sent_at`, S3-D15). [monotonicElapsed] never jumps, so it measures durations: the 8 seconds of
/// listening, the Busy countdown, how long a request took.
class Clock {
  /// A clock whose monotonic time starts at zero now.
  Clock() : _stopwatch = Stopwatch()..start();

  final Stopwatch _stopwatch;

  /// The wall-clock time, in UTC so it is written with no time-zone guesswork.
  DateTime now() => DateTime.now().toUtc();

  /// Time since this clock was made, from a monotonic source that changing the phone's clock does
  /// not move.
  Duration monotonicElapsed() => _stopwatch.elapsed;
}
