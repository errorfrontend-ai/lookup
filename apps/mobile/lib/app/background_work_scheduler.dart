import 'package:workmanager/workmanager.dart';

/// Asks the phone to run the outbox's background job (P6 design §3.10; P6-OFFLINE-08): one place
/// that knows WorkManager's names and settings, behind an interface so tests can see what was asked.
abstract interface class BackgroundWorkScheduler {
  /// The one-off send `look-up-outbox-send`, once a network is connected; a send already waiting is
  /// kept, not replaced.
  Future<void> scheduleSend();

  /// The six-hourly `look-up-outbox-expiry`, with no network needed, so a clip is deleted on time and
  /// the 426 pause probes even if the app is never opened again; one already scheduled is kept.
  Future<void> scheduleExpiryChecks();

  /// Cancels `look-up-outbox-expiry`: nothing it would do is waiting.
  Future<void> cancelExpiryChecks();
}

/// WorkManager, through the `workmanager` package, on Android.
final class WorkmanagerBackgroundWorkScheduler implements BackgroundWorkScheduler {
  /// [callbackDispatcher] is the background engine's entry point, given to WorkManager before the
  /// first request (it must be a top-level function marked `@pragma('vm:entry-point')`).
  WorkmanagerBackgroundWorkScheduler({
    required void Function() callbackDispatcher,
    Workmanager? workmanager,
  }) : _callbackDispatcher = callbackDispatcher,
       _workmanager = workmanager ?? Workmanager();

  /// The unique work names (§3.10).
  static const String sendWorkName = 'look-up-outbox-send';
  static const String expiryWorkName = 'look-up-outbox-expiry';

  /// The one-off send's first retry wait; WorkManager doubles it after each retry.
  static const Duration sendBackoffFirstWait = Duration(seconds: 30);

  /// How often the expiry job runs.
  static const Duration expiryCheckInterval = Duration(hours: 6);

  final void Function() _callbackDispatcher;
  final Workmanager _workmanager;
  Future<void>? _initialized;

  @override
  Future<void> scheduleSend() async {
    await _initialize();
    await _workmanager.registerOneOffTask(
      sendWorkName,
      sendWorkName,
      constraints: Constraints(networkType: NetworkType.connected),
      existingWorkPolicy: ExistingWorkPolicy.keep,
      backoffPolicy: BackoffPolicy.exponential,
      backoffPolicyDelay: sendBackoffFirstWait,
    );
  }

  @override
  Future<void> scheduleExpiryChecks() async {
    await _initialize();
    await _workmanager.registerPeriodicTask(
      expiryWorkName,
      expiryWorkName,
      frequency: expiryCheckInterval,
      existingWorkPolicy: ExistingPeriodicWorkPolicy.keep,
    );
  }

  @override
  Future<void> cancelExpiryChecks() async {
    await _initialize();
    await _workmanager.cancelByUniqueName(expiryWorkName);
  }

  /// WorkManager learns the entry point once per engine, before the first request. A failed attempt
  /// is tried again at the next request.
  Future<void> _initialize() {
    final initializing = _initialized ??= _workmanager.initialize(_callbackDispatcher);
    return initializing.catchError((Object error) {
      _initialized = null;
      throw error;
    });
  }
}

/// Where the outbox has no background job (iOS in this version, P6-OFFLINE-09): clips wait for the
/// next start or resume, and expiry runs then.
final class NoBackgroundWorkScheduler implements BackgroundWorkScheduler {
  const NoBackgroundWorkScheduler();

  @override
  Future<void> scheduleSend() async {}

  @override
  Future<void> scheduleExpiryChecks() async {}

  @override
  Future<void> cancelExpiryChecks() async {}
}
