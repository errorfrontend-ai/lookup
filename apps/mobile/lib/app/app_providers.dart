import 'dart:io' show Directory;
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:lookup_listener/app/engine_identity.dart';
import 'package:lookup_listener/app/outbox_run_scheduler.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/error_reporting/development_log.dart';
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
import 'package:lookup_listener/features/identify/data/recognition_repository.dart';
import 'package:lookup_listener/features/identify/data/station_choice_sender.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
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

/// Where the outbox lives: the `outbox` folder of the app's support folder (P6 design §3.8). Tests
/// point it at a temporary folder.
final Provider<Future<Directory> Function()> outboxFolderLocatorProvider =
    Provider<Future<Directory> Function()>(
      (ref) =>
          () async => OutboxStore.folderIn(await getApplicationSupportDirectory()),
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
/// the app queues: station choices so far (piece 1).
final Provider<OutboxSender> outboxSenderProvider = Provider<OutboxSender>(
  (ref) => OutboxSender(
    store: ref.watch(outboxStoreProvider),
    itemSenders: {
      OutboxItemKind.stationChoice: StationChoiceSender(
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
  ),
  retry: (retryCount, error) => null,
);

/// Starts the outbox's runs: at start (bootstrap calls `start()` after the first frame), on resume,
/// for a new item, and by itself after a wait (P6 design §3.9 point 1, amendment A1).
final Provider<OutboxRunScheduler> outboxRunSchedulerProvider = Provider<OutboxRunScheduler>((ref) {
  final scheduler = OutboxRunScheduler(
    sender: ref.watch(outboxSenderProvider),
    itemsQueued: ref.watch(outboxStoreProvider).itemsQueued,
    clock: ref.watch(clockProvider),
  );
  ref.onDispose(scheduler.dispose);
  return scheduler;
}, retry: (retryCount, error) => null);

/// Connects the identify feature to the app's services: the recognize repository made from the
/// one API client, install repository, crash reporter and clock, the flow's clock and ids from the
/// app's own, and the outbox in the app's support folder for this engine. `bootstrap()` adds these to the app's provider container; a test that wires the
/// whole app adds them too, after overriding the services above with fakes.
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
    final engineIdentity = ref.watch(engineIdentityProvider);
    return OutboxStore(
      locateFolder: ref.watch(outboxFolderLocatorProvider),
      lockOwner: engineIdentity.lockOwner,
      isEngineAttached: engineIdentity.isEngineAttached,
      clock: ref.watch(clockProvider),
      randomUuid: ref.watch(randomUuidProvider),
      clientErrorReporter: ref.watch(clientErrorReporterProvider),
    );
  }),
];
