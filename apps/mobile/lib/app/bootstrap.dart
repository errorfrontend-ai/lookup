import 'dart:async';
import 'dart:isolate';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/app/app_router.dart';
import 'package:lookup_listener/app/look_up_app.dart';
import 'package:lookup_listener/app/notification_launch_handler.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/error_reporting/global_error_handlers.dart';
import 'package:lookup_listener/core/error_reporting/isolate_error_listener.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/widgets/set_up_problem_screen.dart';
import 'package:lookup_listener/features/history/data/history_providers.dart';
import 'package:lookup_listener/features/identify/data/clip_recorder_provider.dart';
import 'package:lookup_listener/features/result/data/https_image_provider.dart';
import 'package:lookup_listener/l10n/fallback_localizations.dart';

/// Starts the app (design §3.1, §3.7, §3.19), in this order:
///
/// 1. Checks the build's configuration. A refused one shows only the set-up screen ("This copy of
///    Look Up isn't set up correctly."): no handler, no provider, no request and no report starts,
///    because no setting can be trusted to say where anything should go (§2.11).
/// 2. Builds the app's provider container with the real services and Riverpod's automatic retry
///    switched off for every provider, so nothing is ever resent silently (S4-D4).
/// 3. Installs the global error handlers and the isolate error listener before anything runs, so
///    no failure goes unreported and no listener sees Flutter's red screen (S4-D26).
/// 4. Deletes any clip file a crash left behind (S4-D7), runs the app, and after the first frame
///    registers the install in the background (S4-D14), starts the outbox's runs (P6 design §3.9
///    point 1) and deletes History's entries past their 30 days (§3.14).
///
/// The parameters exist for the start-up test: [checkConfiguration] is the build's own check,
/// [serviceOverrides] replace services with fakes through the container (never a test branch in
/// the app), [startApp] is Flutter's `runApp`, and [createIsolateErrorListener] makes the isolate
/// error listener, so the test can see which isolate it is told to listen to
/// (S4-ERRORHANDLING-07). Returns what was started, so it can be stopped, or null for a refused
/// configuration.
({ProviderContainer container, IsolateErrorListener isolateErrorListener})? bootstrap({
  AppConfigurationResult Function() checkConfiguration = AppConfiguration.fromEnvironment,
  List<Override> serviceOverrides = const [],
  void Function(Widget app) startApp = runApp,
  IsolateErrorListener Function({
        required ClientErrorReporter reporter,
        String Function()? readCurrentLocation,
      })
      createIsolateErrorListener =
      IsolateErrorListener.new,
}) {
  WidgetsFlutterBinding.ensureInitialized();
  switch (checkConfiguration()) {
    case AppConfigurationRefused(:final problems, :final isDevelopmentBuild):
      startApp(
        MaterialApp(
          onGenerateTitle: LookUpApp.titleOf,
          theme: LookUpTheme.light(),
          darkTheme: LookUpTheme.dark(),
          themeMode: ThemeMode.system,
          localizationsDelegates: FallbackLocalizations.delegates,
          supportedLocales: FallbackLocalizations.supportedLocales,
          debugShowCheckedModeBanner: false,
          home: SetUpProblemScreen(problems: problems, showsProblems: isDevelopmentBuild),
        ),
      );
      return null;
    case AppConfigurationAccepted(:final configuration):
      final container = ProviderContainer(
        overrides: [
          appConfigurationProvider.overrideWithValue(configuration),
          ...appServiceOverrides,
          ...serviceOverrides,
        ],
        retry: (retryCount, error) => null,
      );
      final reporter = container.read(clientErrorReporterProvider);
      // Sent before the app starts, so the plugin counts this engine as attached before it takes any
      // lock file (P6 design §3.8): its first lock comes after the first frame, and the platform reads
      // this engine's messages in order.
      unawaited(
        container
            .read(deviceServicesProvider)
            .registerEngine(container.read(engineIdentityProvider).engineId),
      );
      container.read(networkWatcherProvider).start();
      // Pictures count towards "Used this month" too (P6 design §3.16).
      final dataUseMeter = container.read(dataUseMeterProvider);
      HttpsImageProvider.onBytesDownloaded = (bytes) => unawaited(dataUseMeter.add(bytes));

      // The route the listener is on, e.g. `/listening`, for each report's `location`: the top
      // page's route as declared, so a saved result reports `/r/:recognitionId`, never its id.
      String readCurrentLocation() =>
          container.read(appRouterProvider).state.fullPath ?? AppRoute.home.path;

      GlobalErrorHandlers(
        reporter: reporter,
        configuration: configuration,
        readCurrentLocation: readCurrentLocation,
        developmentLog: container.read(developmentLogProvider),
      ).install();
      final isolateErrorListener = createIsolateErrorListener(
        reporter: reporter,
        readCurrentLocation: readCurrentLocation,
      )..listenTo(Isolate.current);

      unawaited(
        container
            .read(clipRecorderProvider)
            .deleteLeftoverClips()
            // A sweep that fails is tried again on the next return to Home.
            .then<void>((_) {}, onError: (Object error) {}),
      );
      startApp(UncontrolledProviderScope(container: container, child: const LookUpApp()));
      WidgetsBinding.instance.addPostFrameCallback((_) {
        container.read(listenerInstallRepositoryProvider).registerInBackground();
        container.read(outboxRunSchedulerProvider).start();
        // The background job: asked for when items wait, answered while the app is resumed (§3.10).
        container.read(outboxBackgroundCoordinatorProvider).start();
        // A saved clip's notification tapped to start the app, or while it runs (P6 design §3.15).
        unawaited(container.read(notificationLaunchHandlerProvider).start());
        unawaited(
          container
              .read(historyRepositoryProvider)
              .removeExpiredEntries()
              .then<void>(
                (_) {},
                onError: (Object error, StackTrace stackTrace) => reporter.report(
                  kind: ClientErrorKind.reported,
                  error: error,
                  stackTrace: stackTrace,
                  description: 'Deleting old History entries at start failed',
                ),
              ),
        );
      });
      return (container: container, isolateErrorListener: isolateErrorListener);
  }
}
