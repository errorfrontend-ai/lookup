import 'package:lookup_listener/app/background_work_scheduler.dart';

/// The background job's scheduler in tests (P6 design §4.1): what the app asked WorkManager for, in
/// order, as `send`, `scheduleExpiry` and `cancelExpiry`; [failure] makes every request fail.
final class FakeBackgroundWorkScheduler implements BackgroundWorkScheduler {
  final List<String> requests = [];

  Object? failure;

  @override
  Future<void> scheduleSend() => _record('send');

  @override
  Future<void> scheduleExpiryChecks() => _record('scheduleExpiry');

  @override
  Future<void> cancelExpiryChecks() => _record('cancelExpiry');

  Future<void> _record(String request) async {
    final failure = this.failure;
    if (failure != null) throw failure;
    requests.add(request);
  }
}
