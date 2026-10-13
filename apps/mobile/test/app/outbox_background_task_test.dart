import 'dart:io';
import 'dart:isolate';
import 'dart:ui' show IsolateNameServer;

import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/app/outbox_background_task.dart';
import 'package:lookup_listener/app/outbox_background_coordinator.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/configuration/app_version.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/outbox/outbox_index_file.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/outbox/outbox_timing_rules.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/history/data/history_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/outbox/outbox_sender_harness.dart' show ScriptedRandom;
import '../support/contract_fixtures.dart';
import '../support/example_app_configurations.dart';
import '../support/fake_background_work_scheduler.dart';
import '../support/fake_device_services.dart';
import '../support/fake_http_client_adapter.dart';
import '../support/history_fixtures.dart';
import '../support/received_multipart_form.dart';
import '../support/recording_client_error_reporter.dart';

const String _clipKey = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c21';

/// The outbox's background job, one run as WorkManager starts it (P6 design §3.10; P6-OFFLINE-08):
/// it does nothing for a refused build, hands the run to the foreground engine when the app is
/// resumed, and otherwise sends what is due itself and tells WorkManager whether to try again.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory supportFolder;
  late FakeHttpClientAdapter adapter;
  late RecordingClientErrorReporter reporter;
  late FakeDeviceServices deviceServices;
  late FakeBackgroundWorkScheduler backgroundWork;

  Directory outboxFolder() => OutboxStore.folderIn(supportFolder);

  setUp(() {
    IsolateNameServer.removePortNameMapping(OutboxBackgroundCoordinator.portName);
    addTearDown(
      () => IsolateNameServer.removePortNameMapping(OutboxBackgroundCoordinator.portName),
    );
    supportFolder = Directory.systemTemp.createTempSync('outbox_background_task_test_');
    addTearDown(() => supportFolder.deleteSync(recursive: true));
    adapter = FakeHttpClientAdapter();
    reporter = RecordingClientErrorReporter();
    deviceServices = FakeDeviceServices();
    backgroundWork = FakeBackgroundWorkScheduler();
    SharedPreferences.setMockInitialValues({
      'listener_install_id': '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f',
      'listener_install_token': 'stored.install.token',
      'listener_install_token_expires_at': DateTime.now()
          .toUtc()
          .add(const Duration(days: 30))
          .toIso8601String(),
      'listener_install_registered_app_version': AppVersion.current,
    });
  });

  List<Override> fakes() => [
    apiClientProvider.overrideWith(
      (ref) => ApiClient(
        configuration: ExampleAppConfigurations.production(),
        randomUuid: ref.watch(randomUuidProvider),
        clock: ref.watch(clockProvider),
        httpClientAdapter: adapter,
      ),
    ),
    clientErrorReporterProvider.overrideWithValue(reporter),
    deviceServicesProvider.overrideWithValue(deviceServices),
    backgroundWorkSchedulerProvider.overrideWithValue(backgroundWork),
    outboxFolderLocatorProvider.overrideWithValue(() async => outboxFolder()),
    historyFolderLocatorProvider.overrideWithValue(
      () async => HistoryStore.folderIn(supportFolder),
    ),
    // No sending delay, so the run sends at once.
    outboxRandomProvider.overrideWithValue(ScriptedRandom(integers: [0])),
  ];

  OutboxBackgroundTask task({
    AppConfigurationResult? configuration,
    Duration foregroundAnswerPatience = const Duration(seconds: 5),
  }) => OutboxBackgroundTask(
    checkConfiguration: () =>
        configuration ?? AppConfigurationAccepted(ExampleAppConfigurations.production()),
    serviceOverrides: fakes(),
    foregroundAnswerPatience: foregroundAnswerPatience,
  );

  /// Saves a clip, as the live flow did before the app was closed.
  Future<void> saveClip({DateTime? capturedAt}) =>
      OutboxStore(
        locateFolder: () async => outboxFolder(),
        lockOwner: const LockFileOwner(
          processId: 4242,
          engineId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
        ),
        lockTakeOver: LocalLockTakeOver.everyEngineAttached(),
        clock: Clock(),
        randomUuid: RandomUuid(),
        clientErrorReporter: RecordingClientErrorReporter(),
      ).queueDeferredClip(
        idempotencyKey: _clipKey,
        capturedAt: capturedAt ?? DateTime.now().toUtc().subtract(const Duration(minutes: 5)),
        clipDurationMilliseconds: 8000,
        codec: 'aac',
        stationHintId: null,
        audioBytes: const [0, 0, 0, 24, 102, 116, 121, 112],
        savedReason: DeferredClipSavedReason.noConnection,
      );

  int waitingItemCount() => switch (OutboxIndexFile(outboxFolder()).read()) {
    OutboxIndexRead(:final index) => index.items.length,
    _ => 0,
  };

  void answerMatch() {
    final content =
        ContractFixtures.readFile('recognition/recognize-response/valid/match-campaign.json')!
            as Map<String, Object?>;
    adapter.answerJson(200, content['response']);
  }

  test('a refused build does nothing, and tells WorkManager it is done', () async {
    await saveClip();
    final isDone = await task(
      configuration: AppConfiguration.check({
        AppConfiguration.flavourDefine: 'production',
        AppConfiguration.apiBaseUrlDefine: 'http://api.lookup.invalid/api/v1',
      }, gradleFlavour: 'production'),
    ).run();
    expect(isDone, isTrue);
    expect(adapter.requests, isEmpty);
    expect(waitingItemCount(), 1);
    expect(deviceServices.attachedEngineIds, isEmpty);
  });

  test(
    'with the app resumed, the foreground engine is asked to run, and this job sends nothing',
    () async {
      await saveClip();
      final foreground = ReceivePort();
      addTearDown(foreground.close);
      var asked = 0;
      foreground.listen((message) {
        asked++;
        (message as SendPort).send(true);
      });
      IsolateNameServer.registerPortWithName(
        foreground.sendPort,
        OutboxBackgroundCoordinator.portName,
      );

      expect(await task().run(), isTrue);
      expect(asked, 1);
      expect(adapter.requests, isEmpty);
      expect(waitingItemCount(), 1);
    },
  );

  test(
    'a port a closed engine left behind gets no answer: it is removed, and the job sends',
    () async {
      await saveClip();
      final leftBehind = ReceivePort();
      addTearDown(leftBehind.close);
      IsolateNameServer.registerPortWithName(
        leftBehind.sendPort,
        OutboxBackgroundCoordinator.portName,
      );
      answerMatch();

      final isDone = await task(foregroundAnswerPatience: const Duration(milliseconds: 50)).run();
      expect(isDone, isTrue);
      expect(IsolateNameServer.lookupPortByName(OutboxBackgroundCoordinator.portName), isNull);
      expect(adapter.requests, hasLength(1));
    },
  );

  test('with the app closed, the job registers its engine, sends the clip as deferred, keeps the '
      'result in History, posts the notification, and drops the expiry job', () async {
    await saveClip();
    answerMatch();

    expect(await task().run(), isTrue);

    expect(deviceServices.attachedEngineIds, hasLength(1));
    final form = ReceivedMultipartForm.of(adapter.requests.single);
    expect(form.fieldValues['is_deferred'], 'true');
    expect(form.fieldValues['idempotency_key'], _clipKey);
    expect(waitingItemCount(), 0);
    final kept = HistoryFixtures.readIndexEntries(HistoryStore.folderIn(supportFolder)).single;
    expect(kept['entry_id'], HistoryFixtures.fixtureRecognitionId);
    expect(kept['deferred_idempotency_key'], _clipKey);
    expect(deviceServices.posted.single.recognitionId, HistoryFixtures.fixtureRecognitionId);
    expect(backgroundWork.requests, ['cancelExpiry']);
    expect(reporter.reports, isEmpty);
  });

  test('no network: nothing is tried, WorkManager is asked to try again, and the expiry job is '
      'kept while the clip waits', () async {
    deviceServices.setNetwork(isUp: false);
    await saveClip();

    expect(await task().run(), isFalse);
    expect(adapter.requests, isEmpty);
    expect(waitingItemCount(), 1);
    expect(backgroundWork.requests, ['scheduleExpiry']);
  });

  test('the expiry job with no network still deletes a clip past its 24 hours, and History keeps '
      'its row (gap 17)', () async {
    deviceServices.setNetwork(isUp: false);
    await saveClip(capturedAt: DateTime.now().toUtc().subtract(OutboxTimingRules.clipKeptFor));

    expect(await task().run(), isTrue, reason: 'nothing is left to try');
    expect(waitingItemCount(), 0);
    final kept = HistoryFixtures.readIndexEntries(HistoryStore.folderIn(supportFolder)).single;
    expect(kept['entry_id'], _clipKey);
    expect(kept['not_identified_reason'], 'NOT_SENT_WITHIN_24_HOURS');
    expect(deviceServices.posted, isEmpty);
    expect(backgroundWork.requests, ['cancelExpiry']);
  });

  test('the job\'s run is the sender\'s, limited to 8 minutes', () {
    expect(OutboxBackgroundTask.sendingTimeLimit, const Duration(minutes: 8));
  });
}
