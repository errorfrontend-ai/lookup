import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/background_work_scheduler.dart';
import 'package:workmanager/workmanager.dart';

/// One request WorkManager was given.
final class _Request {
  const _Request(this.method, this.uniqueName, this.details);

  final String method;
  final String uniqueName;
  final Map<String, Object?> details;
}

/// WorkManager in tests: records what it is asked, and fails the first initialisation on request.
final class _RecordingWorkmanager implements Workmanager {
  final List<_Request> requests = [];
  final List<Function> initializedWith = [];
  int initializeFailures = 0;

  @override
  Future<void> initialize(Function callbackDispatcher, {bool isInDebugMode = false}) async {
    if (initializeFailures > 0) {
      initializeFailures--;
      throw StateError('fake: WorkManager is not ready');
    }
    initializedWith.add(callbackDispatcher);
  }

  @override
  Future<void> registerOneOffTask(
    String uniqueName,
    String taskName, {
    Map<String, dynamic>? inputData,
    Duration? initialDelay,
    Constraints? constraints,
    ExistingWorkPolicy? existingWorkPolicy,
    BackoffPolicy? backoffPolicy,
    Duration? backoffPolicyDelay,
    String? tag,
    OutOfQuotaPolicy? outOfQuotaPolicy,
    ForegroundServiceConfig? foregroundServiceConfig,
    bool expedited = false,
  }) async => requests.add(
    _Request('oneOff', uniqueName, {
      'taskName': taskName,
      'networkType': constraints?.networkType,
      'existingWorkPolicy': existingWorkPolicy,
      'backoffPolicy': backoffPolicy,
      'backoffPolicyDelay': backoffPolicyDelay,
      'initialDelay': initialDelay,
      'expedited': expedited,
      'foregroundServiceConfig': foregroundServiceConfig,
      'inputData': inputData,
    }),
  );

  @override
  Future<void> registerPeriodicTask(
    String uniqueName,
    String taskName, {
    Duration? frequency,
    Duration? flexInterval,
    Map<String, dynamic>? inputData,
    Duration? initialDelay,
    Constraints? constraints,
    ExistingPeriodicWorkPolicy? existingWorkPolicy,
    BackoffPolicy? backoffPolicy,
    Duration? backoffPolicyDelay,
    String? tag,
    ForegroundServiceConfig? foregroundServiceConfig,
  }) async => requests.add(
    _Request('periodic', uniqueName, {
      'taskName': taskName,
      'frequency': frequency,
      'constraints': constraints,
      'existingWorkPolicy': existingWorkPolicy,
      'foregroundServiceConfig': foregroundServiceConfig,
      'inputData': inputData,
    }),
  );

  @override
  Future<void> cancelByUniqueName(String uniqueName) async =>
      requests.add(_Request('cancel', uniqueName, const {}));

  @override
  Object? noSuchMethod(Invocation invocation) => throw UnimplementedError('$invocation');
}

void _dispatcher() {}

/// What the app asks WorkManager for (P6 design §3.10; P6-OFFLINE-08).
void main() {
  late _RecordingWorkmanager workmanager;
  late WorkmanagerBackgroundWorkScheduler scheduler;

  setUp(() {
    workmanager = _RecordingWorkmanager();
    scheduler = WorkmanagerBackgroundWorkScheduler(
      callbackDispatcher: _dispatcher,
      workmanager: workmanager,
    );
  });

  test('the send: one-off "look-up-outbox-send", once a network is connected, a waiting one kept, '
      'retried on an exponential backoff from 30 seconds, never expedited, no input', () async {
    await scheduler.scheduleSend();
    final request = workmanager.requests.single;
    expect(request.method, 'oneOff');
    expect(request.uniqueName, 'look-up-outbox-send');
    expect(request.details, {
      'taskName': 'look-up-outbox-send',
      'networkType': NetworkType.connected,
      'existingWorkPolicy': ExistingWorkPolicy.keep,
      'backoffPolicy': BackoffPolicy.exponential,
      'backoffPolicyDelay': const Duration(seconds: 30),
      'initialDelay': null,
      'expedited': false,
      'foregroundServiceConfig': null,
      'inputData': null,
    });
  });

  test('the expiry checks: periodic "look-up-outbox-expiry" every 6 hours, with no network needed '
      'and no foreground service, one already scheduled kept', () async {
    await scheduler.scheduleExpiryChecks();
    final request = workmanager.requests.single;
    expect(request.method, 'periodic');
    expect(request.uniqueName, 'look-up-outbox-expiry');
    expect(request.details, {
      'taskName': 'look-up-outbox-expiry',
      'frequency': const Duration(hours: 6),
      'constraints': null,
      'existingWorkPolicy': ExistingPeriodicWorkPolicy.keep,
      'foregroundServiceConfig': null,
      'inputData': null,
    });
  });

  test('cancelling the expiry checks cancels exactly that work', () async {
    await scheduler.cancelExpiryChecks();
    expect(workmanager.requests.single.method, 'cancel');
    expect(workmanager.requests.single.uniqueName, 'look-up-outbox-expiry');
  });

  test('WorkManager learns the entry point once, before the first request', () async {
    await scheduler.scheduleSend();
    await scheduler.scheduleExpiryChecks();
    await scheduler.cancelExpiryChecks();
    expect(workmanager.initializedWith, [_dispatcher]);
  });

  test('an initialisation that failed is tried again at the next request', () async {
    workmanager.initializeFailures = 1;
    await expectLater(scheduler.scheduleSend(), throwsStateError);
    expect(workmanager.requests, isEmpty);
    await scheduler.scheduleSend();
    expect(workmanager.initializedWith, hasLength(1));
    expect(workmanager.requests, hasLength(1));
  });

  test(
    'where there is no background work, nothing is asked and nothing fails (P6-OFFLINE-09)',
    () async {
      const nothing = NoBackgroundWorkScheduler();
      await nothing.scheduleSend();
      await nothing.scheduleExpiryChecks();
      await nothing.cancelExpiryChecks();
    },
  );
}
