import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/app/app_router.dart';
import 'package:lookup_listener/app/look_up_app.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/configuration/app_version.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/history/data/history_store.dart';
import 'package:lookup_listener/features/identify/data/clip_recorder_provider.dart';
import 'package:lookup_listener/features/identify/data/how_it_works_note_store.dart';
import 'package:lookup_listener/features/identify/data/microphone_permission_provider.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/result/data/action_launcher.dart';
import 'package:lookup_listener/features/result/data/clipboard_writer.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../features/result/support/fake_action_launcher.dart';
import '../features/result/support/fake_clipboard_writer.dart';
import '../support/contract_fixtures.dart';
import '../support/example_app_configurations.dart';
import '../support/fake_clip_recorder.dart';
import '../support/fake_device_services.dart';
import '../support/fake_http_client_adapter.dart';
import '../support/fake_microphone_permission.dart';
import '../support/phone_screen.dart';
import '../support/received_multipart_form.dart';
import '../support/recording_client_error_reporter.dart';

/// The whole listener app — `LookUpApp`, its router, the real recognition flow and the app's own
/// service wiring (`appServiceOverrides`) — with only the edges replaced by fakes (design §4.1):
/// the HTTP transport, the microphone, its permission, the crash reporter, the launcher, the
/// clipboard and the `device_services` plugin; the outbox, History and the station list live in
/// temporary folders of their own. Journey, router
/// and transition tests drive it by tapping, as a listener would.
///
/// The app starts as on a later launch, with Home's first-open note already shown, unless
/// [isFirstLaunch]; [storedPreferences] adds to what `shared_preferences` holds (e.g. "My station").
final class ListenerAppHarness {
  ListenerAppHarness({
    AppConfiguration? configuration,
    MicrophoneAccess microphoneAccess = MicrophoneAccess.granted,
    MicrophoneAccess answerToPrompt = MicrophoneAccess.granted,
    this.hasStoredToken = true,
    this.isFirstLaunch = false,
    this.storedPreferences = const {},
  }) : configuration = configuration ?? ExampleAppConfigurations.production(),
       permission = FakeMicrophonePermission(
         access: microphoneAccess,
         answerToPrompt: answerToPrompt,
       );

  final AppConfiguration configuration;
  final bool hasStoredToken;
  final bool isFirstLaunch;
  final Map<String, Object> storedPreferences;
  final FakeHttpClientAdapter adapter = FakeHttpClientAdapter();
  final FakeClipRecorder recorder = FakeClipRecorder();
  final FakeMicrophonePermission permission;
  final RecordingClientErrorReporter reporter = RecordingClientErrorReporter();
  final FakeActionLauncher launcher = FakeActionLauncher();
  final FakeClipboardWriter clipboard = FakeClipboardWriter();
  final FakeDeviceServices deviceServices = FakeDeviceServices();

  /// The install every send uses: stored, with a token good for 30 days unless [hasStoredToken]
  /// is false.
  static const String installId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';

  /// The app's support folder in this test: History's and the station list's folders are made in
  /// it. A new temporary one per started app, deleted when the test ends.
  late final Directory supportFolder = _makeSupportFolder();

  /// The outbox's folder (`outbox/` of [supportFolder]).
  Directory get outboxFolder => OutboxStore.folderIn(supportFolder);

  /// History's folder (`history/` of [supportFolder]).
  Directory get historyFolder => HistoryStore.folderIn(supportFolder);

  /// The station list's folder (`stations/` of [supportFolder]).
  Directory get stationListFolder => Directory('${supportFolder.path}/stations');

  static Directory _makeSupportFolder() {
    final folder = Directory.systemTemp.createTempSync('listener_app_support_');
    addTearDown(() {
      if (folder.existsSync()) folder.deleteSync(recursive: true);
    });
    return folder;
  }

  /// The fakes in place of the services, then the app's own wiring of the features.
  List<Override> get overrides => [
    appConfigurationProvider.overrideWithValue(configuration),
    apiClientProvider.overrideWith(
      (ref) => ApiClient(
        configuration: configuration,
        randomUuid: ref.watch(randomUuidProvider),
        clock: ref.watch(clockProvider),
        httpClientAdapter: adapter,
        // As the app counts "Used this month" (P6 design §3.16).
        onBytesUsed: (bytes) => unawaited(ref.read(dataUseMeterProvider).add(bytes)),
      ),
    ),
    clientErrorReporterProvider.overrideWithValue(reporter),
    clipRecorderProvider.overrideWithValue(recorder),
    microphonePermissionProvider.overrideWithValue(permission),
    actionLauncherProvider.overrideWithValue(launcher),
    clipboardWriterProvider.overrideWithValue(clipboard),
    deviceServicesProvider.overrideWithValue(deviceServices),
    outboxFolderLocatorProvider.overrideWithValue(() async => outboxFolder),
    historyFolderLocatorProvider.overrideWithValue(() async => historyFolder),
    stationListFolderLocatorProvider.overrideWithValue(() async => stationListFolder),
    dataUseFolderLocatorProvider.overrideWithValue(
      () async => Directory('${supportFolder.path}/data_use'),
    ),
    ...appServiceOverrides,
  ];

  /// Starts the app on [phoneScreen] at Home. [extraOverrides] replace more, e.g. the flow itself
  /// for router tests.
  Future<void> pumpApp(
    WidgetTester tester, {
    PhoneScreen phoneScreen = PhoneScreen.standard,
    List<Override> extraOverrides = const [],
  }) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    final tokenExpiry = DateTime.now().toUtc().add(const Duration(days: 30));
    SharedPreferences.setMockInitialValues({
      if (!isFirstLaunch) HowItWorksNoteStore.shownKey: true,
      ...storedPreferences,
      'listener_install_id': installId,
      if (hasStoredToken) 'listener_install_token': 'stored.install.token',
      if (hasStoredToken) 'listener_install_token_expires_at': tokenExpiry.toIso8601String(),
      // Registered with the running version, as after any launch of this app (contract §1.1).
      if (hasStoredToken) 'listener_install_registered_app_version': AppVersion.current,
    });
    phoneScreen.applyTo(tester);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [...overrides, ...extraOverrides],
        retry: (retryCount, error) => null,
        child: const LookUpApp(),
      ),
    );
    await pumpTransition(tester);
  }

  /// Lets the router follow a change of state: the new page is built and its fade (motion.base)
  /// finishes, even when the state changed only part-way through these frames (an answer that
  /// arrives a moment later), and the leaving page is gone.
  ///
  /// With animations off (see [disableAnimations]) pages change at once, so no time passes here:
  /// tests of countdowns use that to keep the fake clock where they expect it.
  Future<void> pumpTransition(WidgetTester tester) async {
    final fadeDuration = tester.platformDispatcher.accessibilityFeatures.disableAnimations
        ? Duration.zero
        : LookUpTokens.light.motion.base;
    await tester.pump();
    for (var fade = 0; fade < 3; fade++) {
      await tester.pump(fadeDuration);
    }
  }

  /// Records the whole 8-second clip, a second at a time, then lets the router follow.
  Future<void> recordWholeClip(WidgetTester tester) async {
    for (var second = 0; second < RecognitionFlow.clipSettings.clipDurationSeconds; second++) {
      await tester.pump(const Duration(seconds: 1));
    }
    await pumpTransition(tester);
  }

  ProviderContainer container(WidgetTester tester) => tester.container();

  RecognitionState state(WidgetTester tester) => container(tester).read(recognitionFlowProvider);

  RecognitionFlow flow(WidgetTester tester) =>
      container(tester).read(recognitionFlowProvider.notifier);

  GoRouter router(WidgetTester tester) => container(tester).read(appRouterProvider);

  /// The router's current location, e.g. `/listening`: the top page's, a pushed one included (a
  /// saved result opened from History).
  String location(WidgetTester tester) => router(tester).state.uri.path;

  /// The recognize requests received, in order.
  List<FakeHttpRequest> get recognizeRequests => [
    for (final request in adapter.requests)
      if (request.address.path.endsWith('/recognize')) request,
  ];

  /// The idempotency key of each recognize request, in order.
  List<String?> get sentIdempotencyKeys => [
    for (final request in recognizeRequests)
      ReceivedMultipartForm.of(request).fieldValues['idempotency_key'],
  ];

  /// Answers the next request with a shared recognize-response fixture, e.g. `valid/no-match`,
  /// once [release] completes when given (so a test can see Identifying first).
  void answerWithResponseFixture(String name, {Future<void>? release}) {
    final content =
        ContractFixtures.readFile('recognition/recognize-response/$name.json')!
            as Map<String, Object?>;
    final body = jsonEncode(content['response']);
    adapter.answerWith((request, cancelFuture) async {
      if (release != null) await release;
      return ResponseBody.fromString(
        body,
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );
    });
  }

  /// Answers the next request with a shared error envelope, e.g. `internal`, with its status and
  /// its `Retry-After` unless [retryAfter] replaces it.
  void answerWithEnvelopeFixture(String name, {String? retryAfter}) {
    final content =
        ContractFixtures.readFile('errors/envelopes/$name.json')! as Map<String, Object?>;
    final retryAfterValue = retryAfter ?? content['retry_after_seconds']?.toString();
    adapter.answerJson(
      content['http_status']! as int,
      content['body'],
      headers: {
        if (retryAfterValue != null) 'retry-after': [retryAfterValue],
      },
    );
  }

  /// The API's `message` in an envelope fixture, which the screen must never show (S4-D13).
  static String envelopeMessage(String name) => _envelopeError(name)['message']! as String;

  /// The request id in an envelope fixture, which the API logged.
  static String envelopeRequestId(String name) => _envelopeError(name)['request_id']! as String;

  static Map<String, Object?> _envelopeError(String name) {
    final content =
        ContractFixtures.readFile('errors/envelopes/$name.json')! as Map<String, Object?>;
    return (content['body']! as Map<String, Object?>)['error']! as Map<String, Object?>;
  }
}
