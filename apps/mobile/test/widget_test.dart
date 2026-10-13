import 'dart:io';
import 'dart:isolate';
import 'dart:math';
import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/app/bootstrap.dart';
import 'package:lookup_listener/app/look_up_app.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/error_reporting/isolate_error_listener.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/outbox/outbox_index_file.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/set_up_problem_screen.dart';
import 'package:lookup_listener/features/identify/data/clip_recorder_provider.dart';
import 'package:lookup_listener/features/identify/data/microphone_permission_provider.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/send_test_error_button.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fake_clip_recorder.dart';
import 'support/fake_http_client_adapter.dart';
import 'support/fake_microphone_permission.dart';
import 'support/recording_client_error_reporter.dart';
import 'support/english_words.dart';
import 'support/fake_device_services.dart';

/// The start-up test (design §2.11, §3.7, §3.19): `bootstrap()` as `main()` runs it, with its
/// services replaced by fakes through the provider container only.
void main() {
  late FakeHttpClientAdapter adapter;
  late FakeClipRecorder recorder;
  late RecordingClientErrorReporter reporter;
  late Widget? startedApp;
  late Directory outboxFolder;
  late FakeDeviceServices deviceServices;

  setUp(() {
    deviceServices = FakeDeviceServices();
    SharedPreferences.setMockInitialValues({});
    adapter = FakeHttpClientAdapter();
    recorder = FakeClipRecorder()..leaveClipFileBehind('left-by-a-crash.m4a');
    reporter = RecordingClientErrorReporter();
    startedApp = null;
    outboxFolder = Directory.systemTemp.createTempSync('bootstrap_outbox_test_');
    addTearDown(() => outboxFolder.deleteSync(recursive: true));
  });

  /// Starts the app with [configuration] as the build's check gives it; true when it started.
  /// What it started is stopped when the test ends.
  bool start(
    AppConfigurationResult configuration, {
    IsolateErrorListener Function({
          required ClientErrorReporter reporter,
          String Function()? readCurrentLocation,
        })
        createIsolateErrorListener =
        IsolateErrorListener.new,
  }) {
    final started = bootstrap(
      checkConfiguration: () => configuration,
      serviceOverrides: [
        apiClientProvider.overrideWith(
          (ref) => ApiClient(
            configuration: switch (configuration) {
              AppConfigurationAccepted(:final configuration) => configuration,
              AppConfigurationRefused() => throw StateError('Nothing may start.'),
            },
            randomUuid: ref.watch(randomUuidProvider),
            httpClientAdapter: adapter,
          ),
        ),
        clientErrorReporterProvider.overrideWithValue(reporter),
        clipRecorderProvider.overrideWithValue(recorder),
        microphonePermissionProvider.overrideWithValue(FakeMicrophonePermission()),
        deviceServicesProvider.overrideWithValue(deviceServices),
        // The app's outbox, History and station list, in temporary folders in place of the
        // phone's support folder.
        outboxFolderLocatorProvider.overrideWithValue(() async => outboxFolder),
        historyFolderLocatorProvider.overrideWithValue(
          () async => Directory('${outboxFolder.path}/history'),
        ),
        stationListFolderLocatorProvider.overrideWithValue(
          () async => Directory('${outboxFolder.path}/stations'),
        ),
        outboxRandomProvider.overrideWithValue(Random(5)),
      ],
      startApp: (app) => startedApp = app,
      createIsolateErrorListener: createIsolateErrorListener,
    );
    if (started == null) return false;
    addTearDown(() {
      started.isolateErrorListener
        ..stopListeningTo(Isolate.current)
        ..close();
      started.container.dispose();
    });
    return true;
  }

  testWidgets('a refused configuration shows only the set-up screen and starts nothing', (
    tester,
  ) async {
    final flutterErrorHandler = FlutterError.onError;
    final platformErrorHandler = PlatformDispatcher.instance.onError;
    final errorWidgetBuilder = ErrorWidget.builder;

    // Production over plain http: a mis-built app (S4-SECURITY-02).
    final started = start(
      AppConfiguration.check({
        AppConfiguration.flavourDefine: 'production',
        AppConfiguration.apiBaseUrlDefine: 'http://api.lookup.invalid/api/v1',
      }, gradleFlavour: 'production'),
    );
    expect(started, isFalse);
    await tester.pumpWidget(startedApp!);
    await tester.pump();

    expect(find.text("This copy of Look Up isn't set up correctly."), findsOneWidget);
    expect(find.text(englishWords.developmentOnlyDetails), findsNothing);
    expect(find.byType(HomeScreen), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
    // No request, no sweep, no handler: nothing started.
    expect(adapter.requests, isEmpty);
    expect(recorder.leftoverSweepCount, 0);
    expect(recorder.clipFileNames, {'left-by-a-crash.m4a'});
    expect(reporter.reports, isEmpty);
    expect(FlutterError.onError, same(flutterErrorHandler));
    expect(PlatformDispatcher.instance.onError, same(platformErrorHandler));
    expect(ErrorWidget.builder, same(errorWidgetBuilder));
  });

  testWidgets('on a phone set to dark, a refused configuration shows the set-up screen in the dark '
      'theme, as the app builds it (P6-THEME-01)', (tester) async {
    final semantics = tester.ensureSemantics();
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    final started = start(
      AppConfiguration.check({
        AppConfiguration.flavourDefine: 'production',
        AppConfiguration.apiBaseUrlDefine: 'http://api.lookup.invalid/api/v1',
      }, gradleFlavour: 'production'),
    );
    expect(started, isFalse);
    await tester.pumpWidget(startedApp!);
    await tester.pump();

    final darkTheme = LookUpTheme.dark();
    final theme = Theme.of(tester.element(find.byType(SetUpProblemScreen)));
    // Theme.of gives the app's theme with the text geometry of the language's script applied.
    expect(
      theme,
      ThemeData.localize(
        darkTheme,
        darkTheme.typography.geometryThemeFor(ScriptCategory.englishLike),
      ),
    );
    expect(theme.brightness, Brightness.dark);
    expect(theme.extension<LookUpTokens>(), LookUpTokens.dark);
    await expectLater(tester, meetsGuideline(textContrastGuideline));
    semantics.dispose();
  });

  testWidgets('a refused development build lists its problems for the developer', (tester) async {
    start(
      AppConfiguration.check({AppConfiguration.flavourDefine: 'development'}, gradleFlavour: null),
    );
    await tester.pumpWidget(startedApp!);
    expect(find.text(englishWords.developmentOnlyDetails), findsOneWidget);
    expect(find.text('LOOKUP_API_BASE_URL is missing.'), findsOneWidget);
  });

  testWidgets(
    'an accepted configuration installs the handlers, sweeps old clips, shows Home and registers',
    (tester) async {
      final flutterErrorHandler = FlutterError.onError;
      final platformErrorHandler = PlatformDispatcher.instance.onError;
      final errorWidgetBuilder = ErrorWidget.builder;
      try {
        adapter.answerJson(200, {
          'install_token': 'fake.install.token',
          'expires_at': '2026-11-07T12:00:00Z',
        });
        final started = start(
          AppConfiguration.check({
            AppConfiguration.flavourDefine: 'production',
            AppConfiguration.apiBaseUrlDefine: 'https://api.lookup.invalid/api/v1',
            AppConfiguration.supportWhatsAppNumberDefine: '+447700900100',
          }, gradleFlavour: 'production'),
        );
        expect(started, isTrue);
        expect(FlutterError.onError, isNot(same(flutterErrorHandler)));
        expect(PlatformDispatcher.instance.onError, isNot(same(platformErrorHandler)));
        expect(ErrorWidget.builder, isNot(same(errorWidgetBuilder)));
        // The clip a crash left behind is gone before the first frame (S4-D7).
        expect(recorder.leftoverSweepCount, greaterThanOrEqualTo(1));
        expect(recorder.clipFileNames, isEmpty);

        await tester.pumpWidget(startedApp!);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        expect(find.byType(HomeScreen), findsOneWidget);
        expect(find.text('Heard an ad on the radio?'), findsOneWidget);
        // Registered in the background after the first frame (S4-D14).
        expect(adapter.requests, hasLength(1));
        expect(adapter.requests.single.address.path, '/api/v1/installs');

        // The handlers report to the app's one reporter, with the current route.
        FlutterError.onError!(FlutterErrorDetails(exception: StateError('a test failure')));
        expect(reporter.reports, hasLength(1));
        expect(reporter.reports.single.kind, ClientErrorKind.render);
        expect(reporter.reports.single.location, '/');
      } finally {
        FlutterError.onError = flutterErrorHandler;
        PlatformDispatcher.instance.onError = platformErrorHandler;
        ErrorWidget.builder = errorWidgetBuilder;
      }
    },
  );

  testWidgets('an accepted configuration listens to Isolate.current with the app reporter '
      '(S4-ERRORHANDLING-07)', (tester) async {
    final flutterErrorHandler = FlutterError.onError;
    final platformErrorHandler = PlatformDispatcher.instance.onError;
    final errorWidgetBuilder = ErrorWidget.builder;
    _RecordingIsolateErrorListener? isolateErrorListener;
    try {
      adapter.answerJson(200, {
        'install_token': 'fake.install.token',
        'expires_at': '2026-11-07T12:00:00Z',
      });
      start(
        AppConfiguration.check({
          AppConfiguration.flavourDefine: 'production',
          AppConfiguration.apiBaseUrlDefine: 'https://api.lookup.invalid/api/v1',
          AppConfiguration.supportWhatsAppNumberDefine: '+447700900100',
        }, gradleFlavour: 'production'),
        createIsolateErrorListener: ({required reporter, readCurrentLocation}) =>
            isolateErrorListener = _RecordingIsolateErrorListener(
              reporter: reporter,
              readCurrentLocation: readCurrentLocation,
            ),
      );

      final listener = isolateErrorListener!;
      expect(listener.listenedTo, hasLength(1));
      expect(listener.listenedTo.single.controlPort, Isolate.current.controlPort);
      await tester.pumpWidget(startedApp!);
      await tester.pump();
      // The background registration finishes.
      await tester.pump(const Duration(milliseconds: 300));

      // What the Dart VM sends the port for an error this isolate did not catch.
      listener.sendPort.send(['Bad state: uncaught on the main isolate', '#0 main (main.dart)']);
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      expect(reporter.reports, hasLength(1));
      expect(reporter.reports.single.kind, ClientErrorKind.uncaught);
      expect(reporter.reports.single.location, '/');
    } finally {
      FlutterError.onError = flutterErrorHandler;
      PlatformDispatcher.instance.onError = platformErrorHandler;
      ErrorWidget.builder = errorWidgetBuilder;
    }
  });

  testWidgets('after the first frame the outbox starts its runs: a choice left from the last '
      'launch is sent (P6 design §3.9 point 1, P6-OFFLINE-07)', (tester) async {
    final flutterErrorHandler = FlutterError.onError;
    final platformErrorHandler = PlatformDispatcher.instance.onError;
    final errorWidgetBuilder = ErrorWidget.builder;
    try {
      // What the last launch left: one choice, queued with no signal.
      OutboxIndexFile(outboxFolder).write(
        OutboxIndex(
          items: [
            StationChoiceItem(
              itemId: '0f1e2d3c-4b5a-4968-8776-655443322110',
              queuedAt: DateTime.now().toUtc(),
              recognitionId: '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70',
              stationId: '0192a6c4-1111-4000-8000-000000000002',
            ),
          ],
        ),
      );
      adapter
        ..answerJson(200, {
          'install_token': 'fake.install.token',
          'expires_at': DateTime.now().toUtc().add(const Duration(days: 30)).toIso8601String(),
        })
        ..answerText(204, '');
      start(
        AppConfiguration.check({
          AppConfiguration.flavourDefine: 'production',
          AppConfiguration.apiBaseUrlDefine: 'https://api.lookup.invalid/api/v1',
          AppConfiguration.supportWhatsAppNumberDefine: '+447700900100',
        }, gradleFlavour: 'production'),
      );
      await tester.pumpWidget(startedApp!);
      await tester.pump();
      // The run's one wait is at most 120 seconds.
      await tester.pump(const Duration(seconds: 121));

      expect(adapter.requests.map((request) => request.address.path), [
        '/api/v1/installs',
        '/api/v1/recognitions/0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70/choice',
      ]);
      expect(switch (OutboxIndexFile(outboxFolder).read()) {
        OutboxIndexRead(:final index) => index.items,
        _ => null,
      }, isEmpty);
      expect(reporter.reports, isEmpty);
    } finally {
      FlutterError.onError = flutterErrorHandler;
      PlatformDispatcher.instance.onError = platformErrorHandler;
      ErrorWidget.builder = errorWidgetBuilder;
    }
  });

  testWidgets('start-up tells the device plugin about this engine and follows the network '
      '(P6 design §3.8, §3.9 point 7)', (tester) async {
    final flutterErrorHandler = FlutterError.onError;
    final platformErrorHandler = PlatformDispatcher.instance.onError;
    final errorWidgetBuilder = ErrorWidget.builder;
    try {
      deviceServices.setNetwork(isUp: false);
      adapter.answerJson(200, {
        'install_token': 'fake.install.token',
        'expires_at': DateTime.now().toUtc().add(const Duration(days: 30)).toIso8601String(),
      });
      start(
        AppConfiguration.check({
          AppConfiguration.flavourDefine: 'production',
          AppConfiguration.apiBaseUrlDefine: 'https://api.lookup.invalid/api/v1',
          AppConfiguration.supportWhatsAppNumberDefine: '+447700900100',
        }, gradleFlavour: 'production'),
      );
      await tester.pumpWidget(startedApp!);
      await tester.pump();

      expect(deviceServices.attachedEngineIds, hasLength(1));
      expect(
        deviceServices.attachedEngineIds.single,
        matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')),
      );
      final container = ProviderScope.containerOf(tester.element(find.byType(LookUpApp)));
      expect(container.read(networkWatcherProvider).isNetworkAvailable, isFalse);
      deviceServices.setNetwork(isUp: true);
      await tester.pump();
      expect(container.read(networkWatcherProvider).isNetworkAvailable, isTrue);
      // The run the network's return started ends after its wait, with nothing to send.
      await tester.pump(const Duration(seconds: 121));
      expect(reporter.reports, isEmpty);
    } finally {
      FlutterError.onError = flutterErrorHandler;
      PlatformDispatcher.instance.onError = platformErrorHandler;
      ErrorWidget.builder = errorWidgetBuilder;
    }
  });

  testWidgets('"Send a test error" in a development build reaches the reporter once', (
    tester,
  ) async {
    final flutterErrorHandler = FlutterError.onError;
    final platformErrorHandler = PlatformDispatcher.instance.onError;
    final errorWidgetBuilder = ErrorWidget.builder;
    try {
      adapter.answerJson(200, {
        'install_token': 'fake.install.token',
        'expires_at': '2026-11-07T12:00:00Z',
      });
      start(
        AppConfiguration.check({
          AppConfiguration.flavourDefine: 'development',
          AppConfiguration.apiBaseUrlDefine: 'http://10.0.2.2:3999/api/v1',
          AppConfiguration.showDeveloperToolsDefine: 'true',
        }, gradleFlavour: 'development'),
      );
      await tester.pumpWidget(startedApp!);
      await tester.pump();
      // The background registration finishes.
      await tester.pump(const Duration(milliseconds: 300));
      expect(adapter.requests, hasLength(1));

      await tester.tap(find.text(englishWords.sendTestErrorButton));
      await tester.pump();
      expect(reporter.reports, hasLength(1));
      expect(reporter.reports.single.kind, ClientErrorKind.render);
      expect('${reporter.reports.single.error}', contains(SendTestErrorButton.errorDescription));
      expect(find.byType(HomeScreen), findsOneWidget);
    } finally {
      FlutterError.onError = flutterErrorHandler;
      PlatformDispatcher.instance.onError = platformErrorHandler;
      ErrorWidget.builder = errorWidgetBuilder;
    }
  });
}

/// The app's isolate error listener, recording the isolates it is told to listen to.
class _RecordingIsolateErrorListener extends IsolateErrorListener {
  _RecordingIsolateErrorListener({required super.reporter, super.readCurrentLocation});

  final List<Isolate> listenedTo = [];

  @override
  void listenTo(Isolate isolate) {
    listenedTo.add(isolate);
    super.listenTo(isolate);
  }
}
