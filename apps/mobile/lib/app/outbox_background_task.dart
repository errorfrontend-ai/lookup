import 'dart:async';
import 'dart:isolate';
import 'dart:ui' show DartPluginRegistrant, IsolateNameServer, PlatformDispatcher;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/app/outbox_background_coordinator.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/outbox/outbox_providers.dart';
import 'package:lookup_listener/core/outbox/outbox_sender.dart';
import 'package:workmanager/workmanager.dart';

/// Where WorkManager starts the outbox's background job, in an engine of its own with no UI (P6
/// design §3.10; P6-OFFLINE-08). A top-level function kept by the compiler for the platform to call.
@pragma('vm:entry-point')
void outboxBackgroundDispatcher() {
  Workmanager().executeTask((taskName, inputData) => OutboxBackgroundTask().run());
}

/// One run of the background job (P6 design §3.10):
///
/// 1. checks the build's configuration as `bootstrap()` does, and does nothing if it is refused;
/// 2. asks the foreground engine, when the app is resumed, to run the sender, and ends;
/// 3. otherwise builds the app's services with no UI and runs the sender itself, starting no send
///    after [sendingTimeLimit], so its locks are released well inside WorkManager's 10 minutes;
/// 4. keeps the expiry job only while a clip waits or the 426 pause holds.
///
/// It answers WorkManager "try again" only when the run ended for want of a network or stopped at
/// its time limit with an item still due; any failure is reported (queued in the outbox if there is
/// no network) and counts as done, so a lasting fault does not retry for ever.
class OutboxBackgroundTask {
  /// The parameters exist for tests: [checkConfiguration] is the build's own check,
  /// [serviceOverrides] replace services with fakes, and [foregroundAnswerPatience] is how long the
  /// foreground engine has to answer before its port counts as left behind.
  OutboxBackgroundTask({
    AppConfigurationResult Function() checkConfiguration = AppConfiguration.fromEnvironment,
    List<Override> serviceOverrides = const [],
    Duration foregroundAnswerPatience = const Duration(seconds: 5),
  }) : _checkConfiguration = checkConfiguration,
       _serviceOverrides = serviceOverrides,
       _foregroundAnswerPatience = foregroundAnswerPatience;

  /// No send starts after this long (§3.9 point 11): a run's 120-second wait and five clips at up
  /// to 60 seconds each fit inside it.
  static const Duration sendingTimeLimit = Duration(minutes: 8);

  final AppConfigurationResult Function() _checkConfiguration;
  final List<Override> _serviceOverrides;
  final Duration _foregroundAnswerPatience;

  /// Runs the job; true tells WorkManager it is done, false to try again on its backoff.
  Future<bool> run() async {
    DartPluginRegistrant.ensureInitialized();
    final configuration = switch (_checkConfiguration()) {
      AppConfigurationAccepted(:final configuration) => configuration,
      // No setting can be trusted to say where anything should go (§2.11).
      AppConfigurationRefused() => null,
    };
    if (configuration == null) return true;
    if (await _askForegroundEngine()) return true;

    final container = ProviderContainer(
      overrides: [
        appConfigurationProvider.overrideWithValue(configuration),
        ...appServiceOverrides,
        // No listener's identify runs in this engine; one in the foreground engine would have
        // answered the port.
        liveIdentifyUnderWayProvider.overrideWithValue(() => false),
        ..._serviceOverrides,
      ],
      retry: (retryCount, error) => null,
    );
    final reporter = container.read(clientErrorReporterProvider);
    final previousErrorHandler = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = (error, stackTrace) {
      _report(reporter, error, stackTrace, 'The outbox background job failed');
      return true;
    };
    try {
      // So a lock this engine holds is never taken over while it runs, and it never takes over one
      // the foreground engine holds (§3.8).
      await container
          .read(deviceServicesProvider)
          .registerEngine(container.read(engineIdentityProvider).engineId);
      await container.read(networkWatcherProvider).readNow();
      final result = await container
          .read(outboxSenderProvider)
          .run(OutboxRunReason.backgroundJob, sendingTimeLimit: sendingTimeLimit);
      await _keepExpiryJobAsNeeded(container, reporter);
      return switch (result) {
        OutboxRunEnded(:final hasEndedForNoNetwork, :final hasStoppedAtTimeLimit) =>
          !hasEndedForNoNetwork && !hasStoppedAtTimeLimit,
        OutboxRunAlreadyUnderWay() => true,
      };
    } on Object catch (error, stackTrace) {
      _report(reporter, error, stackTrace, 'The outbox background job failed');
      return true;
    } finally {
      PlatformDispatcher.instance.onError = previousErrorHandler;
      container.dispose();
    }
  }

  /// Asks the foreground engine to run the sender. True when it answered; false when no engine is
  /// in the foreground, or its port was left behind by an engine that has closed (then removed).
  Future<bool> _askForegroundEngine() async {
    final foreground = IsolateNameServer.lookupPortByName(OutboxBackgroundCoordinator.portName);
    if (foreground == null) return false;
    final answers = ReceivePort();
    try {
      foreground.send(answers.sendPort);
      await answers.first.timeout(_foregroundAnswerPatience);
      return true;
    } on TimeoutException {
      if (IsolateNameServer.lookupPortByName(OutboxBackgroundCoordinator.portName) == foreground) {
        IsolateNameServer.removePortNameMapping(OutboxBackgroundCoordinator.portName);
      }
      return false;
    } finally {
      answers.close();
    }
  }

  /// After the run: the expiry job stays only while a clip waits or the 426 pause holds.
  Future<void> _keepExpiryJobAsNeeded(
    ProviderContainer container,
    ClientErrorReporter reporter,
  ) async {
    try {
      final index = await container.read(outboxStoreProvider).read();
      final scheduler = container.read(backgroundWorkSchedulerProvider);
      if (OutboxBackgroundCoordinator.isExpiryJobNeeded(index)) {
        await scheduler.scheduleExpiryChecks();
      } else {
        await scheduler.cancelExpiryChecks();
      }
    } on Object catch (error, stackTrace) {
      _report(reporter, error, stackTrace, 'Scheduling the outbox expiry job failed');
    }
  }

  static void _report(
    ClientErrorReporter reporter,
    Object error,
    StackTrace stackTrace,
    String description,
  ) {
    unawaited(
      reporter
          .report(
            kind: ClientErrorKind.reported,
            error: error,
            stackTrace: stackTrace,
            description: description,
          )
          .then<void>((_) {}, onError: (Object error) {}),
    );
  }
}
