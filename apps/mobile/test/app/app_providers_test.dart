import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/app/outbox_run_scheduler.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/outbox/outbox_providers.dart';
import 'package:lookup_listener/core/outbox/outbox_sender.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/outbox/outbox_timing_rules.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/identify/data/recognition_repository.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:lookup_listener/features/history/domain/history_waiting_clip.dart';

import '../support/example_app_configurations.dart';
import '../support/fake_clock.dart';
import '../support/fake_http_client_adapter.dart';

ProviderContainer _appContainer() {
  final container = ProviderContainer(
    overrides: [
      appConfigurationProvider.overrideWithValue(ExampleAppConfigurations.production()),
      ...appServiceOverrides,
    ],
    retry: (retryCount, error) => null,
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('the real services are made from the checked configuration', () {
    final container = _appContainer();
    expect(container.read(apiClientProvider), isA<ApiClient>());
    expect(container.read(listenerInstallRepositoryProvider), isA<ListenerInstallRepository>());
    expect(container.read(clientErrorReporterProvider), isA<ClientErrorReporter>());
    expect(container.read(recognitionRepositoryProvider), isA<RecognitionRepository>());
    expect(container.read(developmentLogProvider).isOn, isFalse);
  });

  test('one of each: the same client, reporter and clock wherever they are read', () {
    final container = _appContainer();
    expect(container.read(apiClientProvider), same(container.read(apiClientProvider)));
    expect(
      container.read(clientErrorReporterProvider),
      same(container.read(clientErrorReporterProvider)),
    );
    expect(container.read(recognitionClockProvider), same(container.read(clockProvider)));
    expect(container.read(recognitionRandomUuidProvider), same(container.read(randomUuidProvider)));
  });

  test('the outbox is wired once from the app services: its store, its sender with the station '
      'choice sender, its scheduler, and the waits of the configuration (P6 design §3.6)', () {
    final container = _appContainer();
    final store = container.read(outboxStoreProvider);
    expect(store, isA<OutboxStore>());
    expect(container.read(outboxStoreProvider), same(store));
    expect(container.read(outboxSenderProvider), isA<OutboxSender>());
    expect(container.read(outboxRunSchedulerProvider), isA<OutboxRunScheduler>());
    expect(container.read(outboxTimingRulesProvider), OutboxTimingRules.standard);
    expect(container.read(lockTakeOverProvider), isA<LockTakeOver>());
  });

  test("a development build's lowered waits reach the outbox's rules", () {
    final container = ProviderContainer(
      overrides: [
        appConfigurationProvider.overrideWithValue(
          AppConfiguration(
            flavour: AppFlavour.development,
            apiBaseUrl: Uri.parse('http://10.0.2.2:3999/api/v1'),
            outboxSendingDelayMaximumSeconds: 5,
            outboxBackoffFirstWaitSeconds: 5,
          ),
        ),
        ...appServiceOverrides,
      ],
      retry: (retryCount, error) => null,
    );
    addTearDown(container.dispose);
    expect(
      container.read(outboxTimingRulesProvider),
      const OutboxTimingRules(sendingDelayMaximumSeconds: 5, backoffFirstWaitSeconds: 5),
    );
  });

  test('without the configuration nothing can be made: it comes only from the check', () {
    final container = ProviderContainer(retry: (retryCount, error) => null);
    addTearDown(container.dispose);
    expect(() => container.read(apiClientProvider), throwsA(anything));
  });

  test('the recognize repository sends through the app\'s one API client', () async {
    final adapter = FakeHttpClientAdapter()
      ..answerJson(200, {
        'install_token': 'fake.install.token',
        'expires_at': '2026-11-07T12:00:00Z',
      });
    final clock = FakeClock();
    final container = ProviderContainer(
      overrides: [
        appConfigurationProvider.overrideWithValue(ExampleAppConfigurations.production()),
        clockProvider.overrideWithValue(clock),
        apiClientProvider.overrideWith(
          (ref) => ApiClient(
            configuration: ExampleAppConfigurations.production(),
            randomUuid: ref.watch(randomUuidProvider),
            clock: ref.watch(clockProvider),
            httpClientAdapter: adapter,
          ),
        ),
        ...appServiceOverrides,
      ],
      retry: (retryCount, error) => null,
    );
    addTearDown(container.dispose);
    expect(container.read(recognitionClockProvider), same(clock));
    expect(container.read(clockProvider), isA<Clock>());

    final registration = await container.read(listenerInstallRepositoryProvider).ensureRegistered();
    expect(registration, isA<ListenerInstallRegistered>());
    expect(
      adapter.requests.single.address.toString(),
      'https://api.lookup.invalid/api/v1/installs',
    );
  });

  group('History\'s waiting rows say why each clip waits (P6 design §2.9; P6-HISTORY-05)', () {
    DeferredClipItem clip({
      required DeferredClipSavedReason savedReason,
      OutboxItemProblem? lastProblem,
      int minutesAgo = 1,
    }) => DeferredClipItem(
      itemId: 'item-$minutesAgo',
      queuedAt: DateTime.utc(2026, 10, 13, 12),
      idempotencyKey: '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2$minutesAgo',
      capturedAt: DateTime.utc(2026, 10, 13, 12).subtract(Duration(minutes: minutesAgo)),
      clipDurationMilliseconds: 8000,
      codec: 'aac',
      audioFileName: '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2$minutesAgo.m4a',
      audioSizeBytes: 10,
      savedReason: savedReason,
      attemptCount: lastProblem == null ? 0 : 1,
      lastProblem: lastProblem,
    );

    HistoryWaitingClipStatus statusOf(DeferredClipItem item, {bool isUpdatePaused = false}) =>
        waitingClipsIn(
          OutboxIndex(
            items: [item],
            updatePause: isUpdatePaused
                ? OutboxUpdatePause(
                    appVersion: '0.3.0',
                    pausedAt: DateTime.utc(2026, 10, 13, 11),
                    nextProbeAt: DateTime.utc(2026, 10, 13, 17),
                  )
                : null,
          ),
        ).single.status;

    test('before the outbox has tried it, the live answer it was saved after', () {
      expect(
        statusOf(clip(savedReason: DeferredClipSavedReason.noConnection)),
        HistoryWaitingClipStatus.waitingForSignal,
      );
      for (final reason in [DeferredClipSavedReason.busy, DeferredClipSavedReason.tooManyTries]) {
        expect(
          statusOf(clip(savedReason: reason)),
          HistoryWaitingClipStatus.busy,
          reason: '$reason',
        );
      }
    });

    test('after a try, the outbox\'s last answer, whatever the clip was saved after', () {
      for (final (problem, status) in [
        (OutboxItemProblem.noAnswer, HistoryWaitingClipStatus.waitingForSignal),
        (OutboxItemProblem.busy, HistoryWaitingClipStatus.busy),
        (OutboxItemProblem.limited, HistoryWaitingClipStatus.busy),
        (OutboxItemProblem.updateRequired, HistoryWaitingClipStatus.waitingForUpdate),
      ]) {
        expect(
          statusOf(clip(savedReason: DeferredClipSavedReason.busy, lastProblem: problem)),
          status,
          reason: '$problem',
        );
      }
    });

    test('while the update gate holds the sender, every clip waits for a newer version', () {
      expect(
        statusOf(
          clip(
            savedReason: DeferredClipSavedReason.noConnection,
            lastProblem: OutboxItemProblem.noAnswer,
          ),
          isUpdatePaused: true,
        ),
        HistoryWaitingClipStatus.waitingForUpdate,
      );
    });

    test('each row keeps its clip\'s key and capture time, oldest first', () {
      final rows = waitingClipsIn(
        OutboxIndex(
          items: [
            clip(savedReason: DeferredClipSavedReason.noConnection, minutesAgo: 1),
            clip(savedReason: DeferredClipSavedReason.noConnection, minutesAgo: 7),
          ],
        ),
      );
      expect(rows.map((row) => row.capturedAtOnPhone), [
        DateTime.utc(2026, 10, 13, 11, 53),
        DateTime.utc(2026, 10, 13, 11, 59),
      ]);
      expect(rows.first.idempotencyKey, '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c27');
    });
  });
}
