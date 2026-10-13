import 'dart:io' show Directory;
import 'dart:math';

import 'package:device_services/device_services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:lookup_listener/app/deferred_result_handler.dart';
import 'package:lookup_listener/app/device_services_lock_take_over.dart';
import 'package:lookup_listener/app/engine_identity.dart';
import 'package:lookup_listener/app/history_answer_reader.dart';
import 'package:lookup_listener/app/outbox_run_scheduler.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/device/network_watcher.dart';
import 'package:lookup_listener/core/device/notification_permission.dart';
import 'package:lookup_listener/core/error_reporting/client_error_report_sender.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/error_reporting/development_log.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/listener_install/listener_install_registration.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/listener_install/listener_install_store.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/outbox/outbox_providers.dart';
import 'package:lookup_listener/core/outbox/outbox_sender.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/outbox/outbox_timing_rules.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/history/data/history_providers.dart';
import 'package:lookup_listener/features/history/data/history_repository.dart';
import 'package:lookup_listener/features/history/data/history_store.dart';
import 'package:lookup_listener/features/history/domain/history_waiting_clip.dart';
import 'package:lookup_listener/features/identify/data/deferred_clip_sender.dart';
import 'package:lookup_listener/features/identify/data/recognition_repository.dart';
import 'package:lookup_listener/features/identify/data/station_choice_sender.dart';
import 'package:lookup_listener/features/identify/domain/deferred_result_sink.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/settings/data/settings_providers.dart';
import 'package:lookup_listener/features/settings/data/station_list_cache.dart';
import 'package:lookup_listener/features/settings/data/station_list_repository.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';
import 'package:path_provider/path_provider.dart';

/// The app's one clock (design §3.5): wall-clock time for the API and a monotonic one for waits.
/// Tests override it with a fake clock.
final Provider<Clock> clockProvider = Provider<Clock>(
  (ref) => Clock(),
  retry: (retryCount, error) => null,
);

/// Where every request id, idempotency key and the install id come from: `Random.secure()`.
final Provider<RandomUuid> randomUuidProvider = Provider<RandomUuid>(
  (ref) => RandomUuid(),
  retry: (retryCount, error) => null,
);

/// The device log, silent unless the build is development with verbose logs (design §3.19).
final Provider<DevelopmentLog> developmentLogProvider = Provider<DevelopmentLog>(
  (ref) => DevelopmentLog(
    configuration: ref.watch(appConfigurationProvider),
    clock: ref.watch(clockProvider),
  ),
  retry: (retryCount, error) => null,
);

/// The one Dio-backed client every request goes through (design §3.8): registrations, recognize
/// requests and crash reports alike. Tests override it with one over a fake HTTP adapter.
final Provider<ApiClient> apiClientProvider = Provider<ApiClient>(
  (ref) => ApiClient(
    configuration: ref.watch(appConfigurationProvider),
    randomUuid: ref.watch(randomUuidProvider),
    clock: ref.watch(clockProvider),
    developmentLog: ref.watch(developmentLogProvider),
  ),
  retry: (retryCount, error) => null,
);

/// The listener install: its id, its token and when to register (design §3.9, S4-D14).
final Provider<ListenerInstallRepository> listenerInstallRepositoryProvider =
    Provider<ListenerInstallRepository>((ref) {
      final apiClient = ref.watch(apiClientProvider);
      final randomUuid = ref.watch(randomUuidProvider);
      return ListenerInstallRepository(
        store: ListenerInstallStore(randomUuid: randomUuid),
        registration: ListenerInstallRegistration(apiClient: apiClient),
        randomUuid: randomUuid,
        clock: ref.watch(clockProvider),
        developmentLog: ref.watch(developmentLogProvider),
      );
    }, retry: (retryCount, error) => null);

/// The crash reporter (design §3.19): the same one for the global handlers and the flow, so its
/// limits (once a minute per error, 10 a minute in all) count every report the phone sends. It
/// scrubs the stored install id and token out of every report.
final Provider<ClientErrorReporter> clientErrorReporterProvider = Provider<ClientErrorReporter>(
  (ref) => ClientErrorReporter(
    apiClient: ref.watch(apiClientProvider),
    readInstallCredentials: ref.watch(listenerInstallRepositoryProvider).readKnownCredentials,
    clock: ref.watch(clockProvider),
    developmentLog: ref.watch(developmentLogProvider),
  ),
  retry: (retryCount, error) => null,
);

/// This engine, as the outbox's lock files name it (P6 design §3.6, §3.8): made once, at start-up.
final Provider<EngineIdentity> engineIdentityProvider = Provider<EngineIdentity>(
  (ref) => EngineIdentity.forThisEngine(ref.watch(randomUuidProvider)),
  retry: (retryCount, error) => null,
);

/// The in-repo `device_services` plugin (P6 design §3.15): notifications, the network, attached
/// engines. Tests override it with `FakeDeviceServices`.
final Provider<DeviceServices> deviceServicesProvider = Provider<DeviceServices>(
  (ref) => const DeviceServices(),
  retry: (retryCount, error) => null,
);

/// How the lock files of the outbox and History judge a lock another engine of this process may
/// hold (P6 design §3.8): the plugin's one step for the whole process, or, where it keeps no record
/// of engines, this engine as the only one.
final Provider<LockTakeOver> lockTakeOverProvider = Provider<LockTakeOver>(
  (ref) => DeviceServicesLockTakeOver(
    deviceServices: ref.watch(deviceServicesProvider),
    fallback: LocalLockTakeOver(attachedEngineIds: {ref.watch(engineIdentityProvider).engineId}),
  ),
  retry: (retryCount, error) => null,
);

/// Whether Android reports a network, and when one comes back (P6 design §3.9). Started at start-up.
final Provider<NetworkWatcher> networkWatcherProvider = Provider<NetworkWatcher>((ref) {
  final watcher = NetworkWatcher(deviceServices: ref.watch(deviceServicesProvider));
  ref.onDispose(watcher.dispose);
  return watcher;
}, retry: (retryCount, error) => null);

/// The app's words outside any screen: the notification's (P6 design §2.16). The app is English
/// only (the user's decision, 13 October 2026).
final Provider<AppLocalizations> appWordsProvider = Provider<AppLocalizations>(
  (ref) => lookupAppLocalizations(AppLocalizations.supportedLocales.first),
  retry: (retryCount, error) => null,
);

/// Where a saved clip's outcome goes: History, then the notification (P6 design §3.11).
final Provider<DeferredResultHandler> deferredResultHandlerProvider =
    Provider<DeferredResultHandler>(
      (ref) => DeferredResultHandler(
        history: ref.watch(historyRepositoryProvider),
        deviceServices: ref.watch(deviceServicesProvider),
        words: ref.watch(appWordsProvider),
      ),
      retry: (retryCount, error) => null,
    );

/// Where the outbox lives: the `outbox` folder of the app's support folder (P6 design §3.8). Tests
/// point it at a temporary folder.
final Provider<Future<Directory> Function()> outboxFolderLocatorProvider =
    Provider<Future<Directory> Function()>(
      (ref) =>
          () async => OutboxStore.folderIn(await getApplicationSupportDirectory()),
      retry: (retryCount, error) => null,
    );

/// Where History lives: the `history` folder of the app's support folder (P6 design §3.14). Tests
/// point it at a temporary folder.
final Provider<Future<Directory> Function()> historyFolderLocatorProvider =
    Provider<Future<Directory> Function()>(
      (ref) =>
          () async => HistoryStore.folderIn(await getApplicationSupportDirectory()),
      retry: (retryCount, error) => null,
    );

/// Where the station list is kept: the `stations` folder of the app's support folder (P6 design
/// §3.13). Tests point it at a temporary folder.
final Provider<Future<Directory> Function()> stationListFolderLocatorProvider =
    Provider<Future<Directory> Function()>(
      (ref) =>
          () async => StationListCache.folderIn(await getApplicationSupportDirectory()),
      retry: (retryCount, error) => null,
    );

/// The outbox's numbers (`timing-rules.json`), with the build's sending delay and backoff base,
/// which only a development build may lower (amendment A1). Tests override it.
final Provider<OutboxTimingRules> outboxTimingRulesProvider = Provider<OutboxTimingRules>((ref) {
  final configuration = ref.watch(appConfigurationProvider);
  return OutboxTimingRules(
    sendingDelayMaximumSeconds: configuration.outboxSendingDelayMaximumSeconds,
    backoffFirstWaitSeconds: configuration.outboxBackoffFirstWaitSeconds,
  );
}, retry: (retryCount, error) => null);

/// Where the outbox draws its random waits: a run's wait, the backoff's factor, a deferred clip's
/// busy wait (P6 design §3.6). Tests give a seeded one.
final Provider<Random> outboxRandomProvider = Provider<Random>(
  (ref) => Random.secure(),
  retry: (retryCount, error) => null,
);

/// The outbox's sender, one run at a time per engine (P6 design §3.9), with the sender of each kind
/// the app queues: station choices (piece 1), saved clips and crash reports (piece 3).
final Provider<OutboxSender> outboxSenderProvider = Provider<OutboxSender>(
  (ref) => OutboxSender(
    store: ref.watch(outboxStoreProvider),
    itemSenders: {
      OutboxItemKind.stationChoice: StationChoiceSender(
        apiClient: ref.watch(apiClientProvider),
        clock: ref.watch(clockProvider),
      ),
      OutboxItemKind.deferredClip: DeferredClipSender(
        apiClient: ref.watch(apiClientProvider),
        store: ref.watch(outboxStoreProvider),
        resultSink: ref.watch(deferredResultHandlerProvider),
        clock: ref.watch(clockProvider),
      ),
      OutboxItemKind.clientErrorReport: ClientErrorReportSender(
        apiClient: ref.watch(apiClientProvider),
        clock: ref.watch(clockProvider),
      ),
    },
    listenerInstallRepository: ref.watch(listenerInstallRepositoryProvider),
    clientErrorReporter: ref.watch(clientErrorReporterProvider),
    timingRules: ref.watch(outboxTimingRulesProvider),
    random: ref.watch(outboxRandomProvider),
    clock: ref.watch(clockProvider),
    // No outbox send starts while the listener's own identify records, sends or waits (§3.9).
    isLiveIdentifyUnderWay: () => ref.read(recognitionFlowProvider).isLiveIdentifyUnderWay,
    // Nor while Android reports no network at all (§3.9 point 7).
    isNetworkAvailable: () => ref.read(networkWatcherProvider).isNetworkAvailable,
    onClipsExpired: ref.watch(deferredResultHandlerProvider).recordExpiredClips,
  ),
  retry: (retryCount, error) => null,
);

/// The interface the identify feature hands a saved clip's outcome to.
final Provider<DeferredResultSink> deferredResultSinkProvider = Provider<DeferredResultSink>(
  (ref) => ref.watch(deferredResultHandlerProvider),
  retry: (retryCount, error) => null,
);

/// Starts the outbox's runs: at start (bootstrap calls `start()` after the first frame), on resume,
/// for a new item, and by itself after a wait (P6 design §3.9 point 1, amendment A1).
final Provider<OutboxRunScheduler> outboxRunSchedulerProvider = Provider<OutboxRunScheduler>((ref) {
  final scheduler = OutboxRunScheduler(
    sender: ref.watch(outboxSenderProvider),
    itemsQueued: ref.watch(outboxStoreProvider).itemsQueued,
    networkBack: ref.watch(networkWatcherProvider).networkBack,
    clock: ref.watch(clockProvider),
  );
  ref.onDispose(scheduler.dispose);
  return scheduler;
}, retry: (retryCount, error) => null);

/// Connects the features to the app's services: the recognize repository made from the one API
/// client, install repository, crash reporter and clock, the flow's clock and ids from the app's
/// own, the outbox and History in the app's support folder for this engine (History reading its
/// answers with the recognize answer's reader), and the station list over the same API client.
/// `bootstrap()` adds these to the app's provider container; a test that wires the whole app adds
/// them too, after overriding the services above with fakes.
List<Override> get appServiceOverrides => [
  recognitionRepositoryProvider.overrideWith(
    (ref) => RecognitionRepository(
      apiClient: ref.watch(apiClientProvider),
      listenerInstallRepository: ref.watch(listenerInstallRepositoryProvider),
      clientErrorReporter: ref.watch(clientErrorReporterProvider),
      clock: ref.watch(clockProvider),
    ),
  ),
  recognitionClockProvider.overrideWith((ref) => ref.watch(clockProvider)),
  recognitionRandomUuidProvider.overrideWith((ref) => ref.watch(randomUuidProvider)),
  outboxStoreProvider.overrideWith((ref) {
    final clientErrorReporter = ref.watch(clientErrorReporterProvider);
    final store = OutboxStore(
      locateFolder: ref.watch(outboxFolderLocatorProvider),
      lockOwner: ref.watch(engineIdentityProvider).lockOwner,
      lockTakeOver: ref.watch(lockTakeOverProvider),
      clock: ref.watch(clockProvider),
      randomUuid: ref.watch(randomUuidProvider),
      clientErrorReporter: clientErrorReporter,
    );
    // A crash report that gets no answer waits here to be sent later (P6 design §3.20).
    clientErrorReporter.attachUnsentReportQueue(store.queueClientErrorReport);
    return store;
  }),
  historyRepositoryProvider.overrideWith((ref) {
    final clock = ref.watch(clockProvider);
    final clientErrorReporter = ref.watch(clientErrorReporterProvider);
    final outboxStore = ref.watch(outboxStoreProvider);
    return HistoryRepository(
      store: HistoryStore(
        locateFolder: ref.watch(historyFolderLocatorProvider),
        lockOwner: ref.watch(engineIdentityProvider).lockOwner,
        lockTakeOver: ref.watch(lockTakeOverProvider),
        clock: clock,
        clientErrorReporter: clientErrorReporter,
      ),
      answerReader: const HistoryAnswerReader(),
      clientErrorReporter: clientErrorReporter,
      clock: clock,
      readWaitingClips: () async => waitingClipsIn(await outboxStore.read()),
      waitingClipsChanged: outboxStore.changed,
    );
  }),
  historyClockProvider.overrideWith((ref) => ref.watch(clockProvider)),
  notificationPermissionProvider.overrideWith(
    (ref) => NotificationPermission(deviceServices: ref.watch(deviceServicesProvider)),
  ),
  stationListRepositoryProvider.overrideWith(
    (ref) => StationListRepository(
      apiClient: ref.watch(apiClientProvider),
      listenerInstallRepository: ref.watch(listenerInstallRepositoryProvider),
      cache: StationListCache(locateFolder: ref.watch(stationListFolderLocatorProvider)),
      clientErrorReporter: ref.watch(clientErrorReporterProvider),
      clock: ref.watch(clockProvider),
    ),
  ),
];

/// The clips [index] holds, as History's "Waiting for signal" rows show them (P6 design §2.9): why
/// each waits, from the last answer it got: the outbox's last problem, the update gate, or, before
/// the outbox has tried it, the live answer it was saved after.
List<HistoryWaitingClip> waitingClipsIn(OutboxIndex index) => [
  for (final clip in index.clips)
    HistoryWaitingClip(
      idempotencyKey: clip.idempotencyKey,
      capturedAtOnPhone: clip.capturedAt,
      status: index.updatePause != null
          ? HistoryWaitingClipStatus.waitingForUpdate
          : switch (clip.lastProblem) {
              OutboxItemProblem.busy || OutboxItemProblem.limited => HistoryWaitingClipStatus.busy,
              OutboxItemProblem.updateRequired => HistoryWaitingClipStatus.waitingForUpdate,
              OutboxItemProblem.noAnswer => HistoryWaitingClipStatus.waitingForSignal,
              null => switch (clip.savedReason) {
                DeferredClipSavedReason.noConnection => HistoryWaitingClipStatus.waitingForSignal,
                DeferredClipSavedReason.busy ||
                DeferredClipSavedReason.tooManyTries => HistoryWaitingClipStatus.busy,
              },
            },
    ),
];
