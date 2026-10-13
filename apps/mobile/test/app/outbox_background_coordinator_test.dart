import 'dart:io';
import 'dart:isolate';
import 'dart:ui' show IsolateNameServer;

import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/outbox_background_coordinator.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';

import '../support/fake_background_work_scheduler.dart';
import '../support/fake_clock.dart';
import '../support/recording_client_error_reporter.dart';

const LockFileOwner _engine = LockFileOwner(
  processId: 4242,
  engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
);
const String _clipKey = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c21';

/// Moves the app through the lifecycle, one allowed step at a time, to [target].
void _moveAppTo(AppLifecycleState target) {
  const order = [
    AppLifecycleState.resumed,
    AppLifecycleState.inactive,
    AppLifecycleState.hidden,
    AppLifecycleState.paused,
  ];
  final binding = TestWidgetsFlutterBinding.instance;
  var index = order.indexOf(binding.lifecycleState ?? AppLifecycleState.resumed);
  final targetIndex = order.indexOf(target);
  while (index != targetIndex) {
    index += index < targetIndex ? 1 : -1;
    binding.handleAppLifecycleStateChanged(order[index]);
  }
}

/// The foreground engine's side of the background job (P6 design §3.10; P6-OFFLINE-08): what it
/// asks WorkManager for, and how the job reaches it while the app is resumed.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory folder;
  late OutboxStore store;
  late FakeBackgroundWorkScheduler scheduler;
  late RecordingClientErrorReporter reporter;
  late int runRequests;
  late OutboxBackgroundCoordinator coordinator;

  setUp(() {
    TestWidgetsFlutterBinding.instance.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    IsolateNameServer.removePortNameMapping(OutboxBackgroundCoordinator.portName);
    folder = Directory.systemTemp.createTempSync('outbox_background_coordinator_test_');
    addTearDown(() => folder.deleteSync(recursive: true));
    reporter = RecordingClientErrorReporter();
    store = OutboxStore(
      locateFolder: () async => folder,
      lockOwner: _engine,
      lockTakeOver: LocalLockTakeOver(attachedEngineIds: {_engine.engineId}),
      clock: FakeClock(),
      randomUuid: RandomUuid(),
      clientErrorReporter: reporter,
    );
    scheduler = FakeBackgroundWorkScheduler();
    runRequests = 0;
    coordinator = OutboxBackgroundCoordinator(
      store: store,
      scheduler: scheduler,
      clientErrorReporter: reporter,
      onRunRequested: () => runRequests++,
    );
    addTearDown(coordinator.dispose);
    addTearDown(
      () => IsolateNameServer.removePortNameMapping(OutboxBackgroundCoordinator.portName),
    );
  });

  Future<void> queueClip() => store.queueDeferredClip(
    idempotencyKey: _clipKey,
    capturedAt: DateTime.utc(2026, 10, 8, 11, 59),
    clipDurationMilliseconds: 8000,
    codec: 'aac',
    stationHintId: null,
    audioBytes: const [1, 2, 3],
    savedReason: DeferredClipSavedReason.noConnection,
  );

  group('the send job', () {
    test('is asked for when an item is queued', () async {
      coordinator.start();
      await pumpEventQueue();
      scheduler.requests.clear();
      await store.queueStationChoice(
        recognitionId: '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70',
        stationId: '0192a6c4-1111-4000-8000-000000000002',
      );
      await pumpEventQueue();
      expect(scheduler.requests, ['send']);
    });

    test(
      'is asked for when the app is hidden with items waiting, and not when none waits',
      () async {
        coordinator.start();
        await pumpEventQueue();
        _moveAppTo(AppLifecycleState.hidden);
        await pumpEventQueue();
        expect(scheduler.requests, isNot(contains('send')), reason: 'nothing waits');

        _moveAppTo(AppLifecycleState.resumed);
        await queueClip();
        await pumpEventQueue();
        scheduler.requests.clear();
        _moveAppTo(AppLifecycleState.hidden);
        await pumpEventQueue();
        expect(scheduler.requests, ['send']);
      },
    );
  });

  group('the expiry job (gap 17)', () {
    test('is kept while a clip waits, and cancelled once the outbox has none', () async {
      coordinator.start();
      await pumpEventQueue();
      expect(scheduler.requests, ['cancelExpiry'], reason: 'nothing waits at start');

      await queueClip();
      await pumpEventQueue();
      expect(scheduler.requests, ['cancelExpiry', 'send', 'scheduleExpiry']);

      final clip = (await store.read()).clips.single;
      await store.modify((index) => index.withItemRemoved(clip.itemId));
      await pumpEventQueue();
      expect(scheduler.requests.last, 'cancelExpiry');
    });

    test('a station choice alone does not need it', () async {
      coordinator.start();
      await pumpEventQueue();
      await store.queueStationChoice(
        recognitionId: '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70',
        stationId: '0192a6c4-1111-4000-8000-000000000002',
      );
      await pumpEventQueue();
      expect(scheduler.requests, isNot(contains('scheduleExpiry')));
    });

    test('WorkManager is asked again only when the answer changes', () async {
      coordinator.start();
      await queueClip();
      await pumpEventQueue();
      await coordinator.syncExpiryJob();
      await coordinator.syncExpiryJob();
      expect(scheduler.requests.where((request) => request == 'scheduleExpiry'), hasLength(1));
    });
  });

  test('a request WorkManager refuses is reported, never thrown', () async {
    scheduler.failure = StateError('fake: WorkManager refused');
    coordinator.start();
    await queueClip();
    await pumpEventQueue();
    expect(reporter.reports.map((report) => report.description), [
      'Scheduling the outbox expiry job failed',
      'Scheduling the outbox send job failed',
      'Scheduling the outbox expiry job failed',
    ]);
  });

  group('the port the background job asks (P6 design §3.10)', () {
    Future<bool?> askThroughThePort() async {
      final foreground = IsolateNameServer.lookupPortByName(OutboxBackgroundCoordinator.portName);
      if (foreground == null) return null;
      final answers = ReceivePort();
      foreground.send(answers.sendPort);
      final answer = await answers.first.timeout(const Duration(seconds: 2));
      answers.close();
      return answer as bool;
    }

    test('while resumed, a request runs the sender here and is answered', () async {
      coordinator.start();
      expect(await askThroughThePort(), isTrue);
      expect(runRequests, 1);
    });

    test('hidden, the port is gone, so the job runs the sender itself', () async {
      coordinator.start();
      _moveAppTo(AppLifecycleState.hidden);
      expect(IsolateNameServer.lookupPortByName(OutboxBackgroundCoordinator.portName), isNull);

      _moveAppTo(AppLifecycleState.resumed);
      expect(await askThroughThePort(), isTrue, reason: 'open again once resumed');
    });

    test('a port a closed engine left behind is replaced', () async {
      final leftBehind = ReceivePort();
      addTearDown(leftBehind.close);
      IsolateNameServer.registerPortWithName(
        leftBehind.sendPort,
        OutboxBackgroundCoordinator.portName,
      );
      coordinator.start();
      expect(await askThroughThePort(), isTrue);
      expect(runRequests, 1);
    });

    test('disposed, the port is removed', () async {
      coordinator
        ..start()
        ..dispose();
      expect(IsolateNameServer.lookupPortByName(OutboxBackgroundCoordinator.portName), isNull);
    });
  });
}
