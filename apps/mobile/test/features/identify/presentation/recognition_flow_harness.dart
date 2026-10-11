import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/configuration/app_version.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/listener_install/listener_install_registration.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/listener_install/listener_install_store.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/features/identify/data/clip_recorder_provider.dart';
import 'package:lookup_listener/features/identify/data/microphone_permission_provider.dart';
import 'package:lookup_listener/features/identify/data/recognition_repository.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/example_app_configurations.dart';
import '../../../support/fake_async_clock.dart';
import '../../../support/fake_clip_recorder.dart';
import '../../../support/fake_http_client_adapter.dart';
import '../../../support/fake_microphone_permission.dart';
import '../../../support/received_multipart_form.dart';
import '../../../support/recording_client_error_reporter.dart';

/// The stored install, with a token good for 30 days, so a send needs no registration unless a
/// test removes it.
const String flowTestInstallId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
const String flowTestStoredToken = 'stored.install.token';

/// The recognition flow wired as the app wires it, in fake time: the real repository, API client
/// and install repository over a fake HTTP adapter, a fake recorder and permission, a clock that
/// follows the fake time, and a recording crash reporter. Every state the flow passes through is
/// kept in [states]. The API client uses the production configuration unless [configuration]
/// replaces it.
class RecognitionFlowHarness {
  RecognitionFlowHarness(
    this.fakeAsync, {
    bool hasStoredToken = true,
    MicrophoneAccess? microphoneAccess,
    RecordingClientErrorReporter? reporter,
    AppConfiguration? configuration,
  }) : reporter = reporter ?? RecordingClientErrorReporter() {
    final storedTokenExpiry = DateTime.utc(2026, 11, 7, 12);
    SharedPreferences.setMockInitialValues({
      'listener_install_id': flowTestInstallId,
      if (hasStoredToken) 'listener_install_token': flowTestStoredToken,
      if (hasStoredToken) 'listener_install_token_expires_at': storedTokenExpiry.toIso8601String(),
      // Registered with the running version, as after any launch of this app (contract §1.1).
      if (hasStoredToken) 'listener_install_registered_app_version': AppVersion.current,
    });
    if (microphoneAccess != null) permission.access = microphoneAccess;
    final randomUuid = RandomUuid();
    final apiClient = ApiClient(
      configuration: configuration ?? ExampleAppConfigurations.production(),
      randomUuid: randomUuid,
      clock: clock,
      httpClientAdapter: adapter,
    );
    final repository = RecognitionRepository(
      apiClient: apiClient,
      listenerInstallRepository: ListenerInstallRepository(
        store: ListenerInstallStore(randomUuid: randomUuid),
        registration: ListenerInstallRegistration(apiClient: apiClient),
        randomUuid: randomUuid,
        clock: clock,
      ),
      clientErrorReporter: this.reporter,
      clock: clock,
    );
    container = ProviderContainer(
      overrides: [
        clipRecorderProvider.overrideWithValue(recorder),
        microphonePermissionProvider.overrideWithValue(permission),
        recognitionRepositoryProvider.overrideWithValue(repository),
        recognitionClockProvider.overrideWithValue(clock),
      ],
      retry: (retryCount, error) => null,
    );
    _subscription = container.listen<RecognitionState>(
      recognitionFlowProvider,
      (previous, next) => states.add(next),
      fireImmediately: true,
    );
    settle();
  }

  final FakeAsync fakeAsync;
  late final FakeAsyncClock clock = FakeAsyncClock(fakeAsync);
  final FakeHttpClientAdapter adapter = FakeHttpClientAdapter();
  final FakeClipRecorder recorder = FakeClipRecorder();
  final FakeMicrophonePermission permission = FakeMicrophonePermission();
  final RecordingClientErrorReporter reporter;
  late final ProviderContainer container;
  late final ProviderSubscription<RecognitionState> _subscription;

  /// Every state the flow showed, the first being the one it started with.
  final List<RecognitionState> states = [];

  RecognitionFlow get flow => container.read(recognitionFlowProvider.notifier);

  RecognitionState get state => container.read(recognitionFlowProvider);

  /// Runs everything that is ready now, without moving the fake time.
  void settle() => fakeAsync.elapse(Duration.zero);

  /// Moves the fake time on by [duration], running every timer due.
  void wait(Duration duration) => fakeAsync.elapse(duration);

  /// Calls a flow method the way a tap does: not awaited, then everything ready is run.
  void tap(FutureOr<void> Function(RecognitionFlow flow) action) {
    final result = action(flow);
    if (result is Future<void>) unawaited(result);
    settle();
  }

  /// Taps "Tap to identify" and records the whole clip; the send starts at once.
  void identifyAndRecord() {
    tap((flow) => flow.identify());
    wait(const Duration(seconds: 8));
  }

  /// The recognize requests received, in order.
  List<FakeHttpRequest> get recognizeRequests => [
    for (final request in adapter.requests)
      if (request.address.path.endsWith('/recognize')) request,
  ];

  /// The request ids the app sent on every request, in order.
  List<String?> get sentRequestIds => [
    for (final request in adapter.requests) request.header('X-Request-Id'),
  ];

  /// The idempotency key of each recognize request, in order.
  List<String?> get sentIdempotencyKeys => [
    for (final request in recognizeRequests)
      ReceivedMultipartForm.of(request).fieldValues['idempotency_key'],
  ];

  /// Answers the next request with a shared recognize-response fixture, e.g. `valid/no-match`.
  void answerWithResponseFixture(String name, {Map<String, List<String>> headers = const {}}) {
    final content =
        ContractFixtures.readFile('recognition/recognize-response/$name.json')!
            as Map<String, Object?>;
    adapter.answerJson(200, content['response'], headers: headers);
  }

  /// Answers the next request with a shared error envelope, e.g. `recognition-busy`, with its
  /// status, and its `Retry-After` unless [retryAfter] replaces it.
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

  /// The request id the fixture's envelope carries, which the API logged.
  static String envelopeRequestId(String name) {
    final content =
        ContractFixtures.readFile('errors/envelopes/$name.json')! as Map<String, Object?>;
    return ((content['body']! as Map)['error']! as Map)['request_id']! as String;
  }

  /// Moves the app through the lifecycle, one allowed step at a time, to [target].
  void moveAppTo(AppLifecycleState target) {
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
    settle();
  }

  /// Ends the test: the provider is disposed, which stops everything the flow started.
  void dispose() {
    _subscription.close();
    container.dispose();
    settle();
  }
}

/// Runs [body] in fake time with a new harness, starting from a resumed app.
void runFlowTest(
  void Function(RecognitionFlowHarness harness) body, {
  bool hasStoredToken = true,
  MicrophoneAccess? microphoneAccess,
  RecordingClientErrorReporter? reporter,
  AppConfiguration? configuration,
}) {
  TestWidgetsFlutterBinding.instance.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  fakeAsync((fakeAsync) {
    final harness = RecognitionFlowHarness(
      fakeAsync,
      hasStoredToken: hasStoredToken,
      microphoneAccess: microphoneAccess,
      reporter: reporter,
      configuration: configuration,
    );
    try {
      body(harness);
    } finally {
      harness.dispose();
    }
  });
}
