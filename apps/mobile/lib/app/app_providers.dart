import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/error_reporting/development_log.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/listener_install/listener_install_registration.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/listener_install/listener_install_store.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/identify/data/recognition_repository.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';

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

/// Connects the identify feature to the app's services: the recognize repository made from the
/// one API client, install repository, crash reporter and clock, and the flow's clock and ids from
/// the app's own. `bootstrap()` adds these to the app's provider container; a test that wires the
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
];
