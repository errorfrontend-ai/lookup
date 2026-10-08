import 'dart:async';
import 'dart:isolate';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/app/app_router.dart';
import 'package:lookup_listener/app/look_up_app.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/error_reporting/global_error_handlers.dart';
import 'package:lookup_listener/core/error_reporting/isolate_error_listener.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/widgets/set_up_problem_screen.dart';
import 'package:lookup_listener/features/identify/data/clip_recorder_provider.dart';

/// Starts the app (design §3.1, §3.7, §3.19), in this order:
///
/// 1. Checks the build's configuration. A refused one shows only the set-up screen ("This copy of
///    Look Up isn't set up correctly."): no handler, no provider, no request and no report starts,
///    because no setting can be trusted to say where anything should go (§2.11).
/// 2. Builds the app's provider container with the real services and Riverpod's automatic retry
///    switched off for every provider, so nothing is ever resent silently (S4-D4).
/// 3. Installs the global error handlers and the isolate error listener before anything runs, so
///    no failure goes unreported and no listener sees Flutter's red screen (S4-D26).
/// 4. Deletes any clip file a crash left behind (S4-D7), runs the app, and registers the install
///    in the background after the first frame (S4-D14).
///
/// The parameters exist for the start-up test: [checkConfiguration] is the build's own check,
/// [serviceOverrides] replace services with fakes through the container (never a test branch in
/// the app), and [startApp] is Flutter's `runApp`. Returns what was started, so it can be stopped,
/// or null for a refused configuration.
({ProviderContainer container, IsolateErrorListener isolateErrorListener})? bootstrap({
  AppConfigurationResult Function() checkConfiguration = AppConfiguration.fromEnvironment,
  List<Override> serviceOverrides = const [],
  void Function(Widget app) startApp = runApp,
}) {
  WidgetsFlutterBinding.ensureInitialized();
  switch (checkConfiguration()) {
    case AppConfigurationRefused(:final problems, :final isDevelopmentBuild):
      startApp(
        MaterialApp(
          title: LookUpApp.title,
          theme: LookUpTheme.light(),
          themeMode: ThemeMode.light,
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

      // The route the listener is on, e.g. `/listening`, for each report's `location`.
      String readCurrentLocation() =>
          container.read(appRouterProvider).routerDelegate.currentConfiguration.uri.path;

      GlobalErrorHandlers(
        reporter: reporter,
        configuration: configuration,
        readCurrentLocation: readCurrentLocation,
        developmentLog: container.read(developmentLogProvider),
      ).install();
      final isolateErrorListener = IsolateErrorListener(
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
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => container.read(listenerInstallRepositoryProvider).registerInBackground(),
      );
      return (container: container, isolateErrorListener: isolateErrorListener);
  }
}
