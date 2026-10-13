import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:fake_async/fake_async.dart';
import 'package:lookup_listener/core/configuration/app_version.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/listener_install/listener_install_registration.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/listener_install/listener_install_store.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/outbox/outbox_index_file.dart';
import 'package:lookup_listener/core/outbox/outbox_sender.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/outbox/outbox_timing_rules.dart';
import 'package:lookup_listener/features/identify/data/station_choice_sender.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/example_app_configurations.dart';
import '../../support/fake_async_clock.dart';
import '../../support/fake_http_client_adapter.dart';
import '../../support/recording_client_error_reporter.dart';

/// This engine, as the sender tests' lock files name it.
const LockFileOwner senderTestEngine = LockFileOwner(
  processId: 4242,
  engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
);

/// The chooser fixture's recognition, and a second one.
const String recognitionOne = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';
const String recognitionTwo = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f71';
const String recognitionThree = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f72';
const String stationA = '0192a6c4-1111-4000-8000-000000000001';
const String stationB = '0192a6c4-1111-4000-8000-000000000002';

/// The request id the fake API's error envelopes carry.
const String apiRequestId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';

/// One request the fake API received, with the fake time it arrived.
final class SentChoice {
  const SentChoice(this.request, this.at);

  final FakeHttpRequest request;

  /// Fake time since the test started.
  final Duration at;

  String get path => request.address.path;

  Object? get body => request.jsonBody;

  String? get requestId => request.header('X-Request-Id');
}

/// The outbox sender wired as the app wires it, in fake time: the real store over a temporary
/// folder, the real station choice sender, API client and install repository over a fake HTTP
/// adapter, a clock that follows the fake time, a recording crash reporter, and a random source
/// the test chooses (P6 design §4.1).
final class OutboxSenderHarness {
  OutboxSenderHarness(
    this.fakeAsync, {
    Random? random,
    this.timingRules = OutboxTimingRules.standard,
    this.appVersion = AppVersion.current,
    DateTime? startsAt,
    bool hasStoredToken = true,
  }) : clock = FakeAsyncClock(fakeAsync, startsAt: startsAt) {
    SharedPreferences.setMockInitialValues({
      'listener_install_id': '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f',
      if (hasStoredToken) 'listener_install_token': 'stored.install.token',
      if (hasStoredToken)
        'listener_install_token_expires_at': clock
            .now()
            .add(const Duration(days: 30))
            .toIso8601String(),
      if (hasStoredToken) 'listener_install_registered_app_version': AppVersion.current,
    });
    final randomUuid = RandomUuid();
    final apiClient = ApiClient(
      configuration: ExampleAppConfigurations.production(),
      randomUuid: randomUuid,
      clock: clock,
      httpClientAdapter: adapter,
    );
    store = OutboxStore(
      locateFolder: () async => folder,
      lockOwner: senderTestEngine,
      isEngineAttached: attachedEngines.contains,
      clock: clock,
      randomUuid: randomUuid,
      clientErrorReporter: reporter,
    );
    sender = OutboxSender(
      store: store,
      itemSenders: {
        OutboxItemKind.stationChoice: StationChoiceSender(apiClient: apiClient, clock: clock),
      },
      listenerInstallRepository: ListenerInstallRepository(
        store: ListenerInstallStore(randomUuid: randomUuid),
        registration: ListenerInstallRegistration(apiClient: apiClient),
        randomUuid: randomUuid,
        clock: clock,
      ),
      clientErrorReporter: reporter,
      timingRules: timingRules,
      random: random ?? Random(1),
      clock: clock,
      isLiveIdentifyUnderWay: () => isLiveIdentifyUnderWay,
      appVersion: appVersion,
    );
  }

  final FakeAsync fakeAsync;
  final FakeAsyncClock clock;
  final OutboxTimingRules timingRules;
  final String appVersion;
  final FakeHttpClientAdapter adapter = FakeHttpClientAdapter();
  final RecordingClientErrorReporter reporter = RecordingClientErrorReporter();
  final Directory folder = Directory.systemTemp.createTempSync('outbox_sender_test_');
  final Set<String> attachedEngines = {senderTestEngine.engineId};
  late final OutboxStore store;
  late final OutboxSender sender;

  /// Whether the listener's own identify is recording, sending or busy now.
  bool isLiveIdentifyUnderWay = false;

  /// Every choice request, with the fake time it arrived.
  final List<SentChoice> sentChoices = [];

  /// Every registration request.
  List<FakeHttpRequest> get registrations => [
    for (final request in adapter.requests)
      if (request.address.path.endsWith('/installs')) request,
  ];

  /// The results of the runs started with [startRun], in order.
  final List<OutboxRunResult> runResults = [];

  /// Runs everything ready now.
  void settle() => fakeAsync.elapse(Duration.zero);

  void wait(Duration duration) => fakeAsync.elapse(duration);

  /// Queues a choice, as a chooser row does.
  void queueChoice(String recognitionId, String stationId) {
    unawaited(store.queueStationChoice(recognitionId: recognitionId, stationId: stationId));
    settle();
  }

  /// Starts a run for [reason], without waiting for it; its result lands in [runResults].
  void startRun(OutboxRunReason reason) {
    unawaited(sender.run(reason).then(runResults.add));
    settle();
  }

  /// The wake-up the last finished run asked for.
  DateTime? get lastWakeUpAt => switch (runResults.lastOrNull) {
    OutboxRunEnded(:final nextWakeUpAt) => nextWakeUpAt,
    _ => null,
  };

  /// Does what the app's scheduler does while the app stays open: after each run, waits until its
  /// wake-up and starts the next, [runs] times at most or until nothing waits.
  void followWakeUps({int runs = 10}) {
    for (var run = 0; run < runs; run++) {
      final wakeUpAt = lastWakeUpAt;
      if (wakeUpAt == null) return;
      final delay = wakeUpAt.difference(clock.now());
      wait(delay.isNegative ? Duration.zero : delay);
      startRun(OutboxRunReason.wakeUp);
    }
  }

  /// What the outbox holds on disk now.
  OutboxIndex get index => switch (OutboxIndexFile(folder).read()) {
    OutboxIndexRead(:final index) => index,
    OutboxIndexMissing() => OutboxIndex.empty,
    OutboxIndexUnreadable() => throw StateError('The outbox index cannot be read.'),
  };

  List<OutboxItem> get items => index.items;

  /// Answers the next choice request with [status] after [delay]: 204 with no body, anything else
  /// with the API's error envelope for [code].
  void answerChoice(
    int status, {
    String? code,
    String? retryAfter,
    Duration delay = Duration.zero,
    void Function()? whileAnswering,
  }) {
    adapter.answerWith((request, cancelFuture) async {
      sentChoices.add(SentChoice(request, fakeAsync.elapsed));
      whileAnswering?.call();
      if (delay > Duration.zero) await Future<void>.delayed(delay);
      final headers = <String, List<String>>{
        'x-request-id': [request.header('X-Request-Id')!],
        if (retryAfter != null) 'retry-after': [retryAfter],
      };
      if (status == 204) return ResponseBody.fromString('', 204, headers: headers);
      return ResponseBody.fromString(
        jsonEncode({
          'error': {
            'code': code ?? 'INTERNAL',
            'message': 'An API message the app never shows.',
            'request_id': apiRequestId,
          },
        }),
        status,
        headers: {
          ...headers,
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );
    });
  }

  /// Gives the next choice request no answer at all, as with no signal.
  void answerChoiceWithNothing() {
    adapter.answerWith((request, cancelFuture) async {
      sentChoices.add(SentChoice(request, fakeAsync.elapsed));
      throw DioException(
        requestOptions: request.options,
        type: DioExceptionType.connectionError,
        message: 'fake: no signal',
      );
    });
  }

  /// Answers the next registration with a new token.
  void answerRegistration(String token) => adapter.answerJson(200, {
    'install_token': token,
    'expires_at': clock.now().add(const Duration(days: 30)).toIso8601String(),
  });

  void dispose() {
    settle();
    if (folder.existsSync()) folder.deleteSync(recursive: true);
  }
}

/// Runs [body] in fake time with a new harness.
void runSenderTest(
  void Function(OutboxSenderHarness harness) body, {
  Random? random,
  OutboxTimingRules timingRules = OutboxTimingRules.standard,
  String appVersion = AppVersion.current,
  DateTime? startsAt,
  bool hasStoredToken = true,
}) {
  fakeAsync((fakeAsync) {
    final harness = OutboxSenderHarness(
      fakeAsync,
      random: random,
      timingRules: timingRules,
      appVersion: appVersion,
      startsAt: startsAt,
      hasStoredToken: hasStoredToken,
    );
    try {
      body(harness);
    } finally {
      harness.dispose();
    }
  });
}

/// A random source whose draws the test writes: [doubles] for the backoff's factor and [integers]
/// for the waits, each used in turn and the last one repeated.
final class ScriptedRandom implements Random {
  ScriptedRandom({this.doubles = const [0.5], this.integers = const [0]});

  final List<double> doubles;
  final List<int> integers;
  int _doubleCount = 0;
  int _integerCount = 0;

  /// The upper bounds `nextInt` was asked for, in order: each run's wait and pause draws.
  final List<int> integerBounds = [];

  @override
  double nextDouble() => doubles[min(_doubleCount++, doubles.length - 1)];

  @override
  int nextInt(int max) {
    integerBounds.add(max);
    return min(integers[min(_integerCount++, integers.length - 1)], max - 1);
  }

  @override
  bool nextBool() => false;
}
