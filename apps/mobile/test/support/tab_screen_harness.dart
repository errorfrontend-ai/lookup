import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/history_answer_reader.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/configuration/app_version.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/listener_install/listener_install_registration.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/listener_install/listener_install_store.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/features/history/data/history_providers.dart';
import 'package:lookup_listener/features/history/data/history_repository.dart';
import 'package:lookup_listener/features/history/data/history_store.dart';
import 'package:lookup_listener/features/result/data/action_launcher.dart';
import 'package:lookup_listener/features/result/data/clipboard_writer.dart';
import 'package:lookup_listener/features/settings/data/settings_providers.dart';
import 'package:lookup_listener/features/settings/data/station_list_cache.dart';
import 'package:lookup_listener/features/settings/data/station_list_repository.dart';
import 'package:lookup_listener/l10n/fallback_localizations.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:lookup_listener/features/history/domain/history_waiting_clip.dart';

import '../features/result/support/fake_action_launcher.dart';
import '../features/result/support/fake_clipboard_writer.dart';
import 'contract_fixtures.dart';
import 'example_app_configurations.dart';
import 'fake_clock.dart';
import 'fake_http_client_adapter.dart';
import 'history_fixtures.dart';
import 'phone_screen.dart';
import 'recording_client_error_reporter.dart';

/// Shows one tab screen, or a page over the tabs, the way the app does (P6 design §4.1, §4.3): in
/// the app's theme and words, under a `ProviderScope` with the real History and station list over
/// a temporary support folder, `shared_preferences` holding an installed app (and anything the test
/// adds, e.g. "My station"), a fake clock, a fake HTTP transport, a recording crash reporter and a
/// fake launcher and clipboard.
final class TabScreenHarness {
  /// The clock starts at [now] (by default Tuesday 13 October 2026, 15:00 on the phone).
  TabScreenHarness({
    DateTime? now,
    this.preferences = const {},
    AppConfiguration? configuration,
    bool launcherOpens = true,
    this.extraOverrides = const [],
  }) : clock = FakeClock(startsAt: (now ?? DateTime(2026, 10, 13, 15)).toUtc()),
       configuration = configuration ?? ExampleAppConfigurations.production(),
       launcher = FakeActionLauncher(opens: launcherOpens);

  /// What `shared_preferences` holds besides the installed app's id and token.
  final Map<String, Object> preferences;

  /// More providers a test replaces, e.g. the data-use count.
  final List<Override> extraOverrides;

  final FakeClock clock;
  final AppConfiguration configuration;
  final FakeActionLauncher launcher;
  final FakeClipboardWriter clipboard = FakeClipboardWriter();
  final FakeHttpClientAdapter adapter = FakeHttpClientAdapter();
  final RecordingClientErrorReporter reporter = RecordingClientErrorReporter();

  /// The clips waiting in the outbox, as History reads them.
  List<HistoryWaitingClip> waitingClips = const [];

  /// The app's support folder in this test, made on first use and deleted when the test ends.
  late final Directory supportFolder = () {
    final folder = Directory.systemTemp.createTempSync('tab_screen_support_');
    addTearDown(() {
      if (folder.existsSync()) folder.deleteSync(recursive: true);
    });
    return folder;
  }();

  Directory get historyFolder => HistoryStore.folderIn(supportFolder);

  Directory get stationListFolder => StationListCache.folderIn(supportFolder);

  late final HistoryRepository history = HistoryRepository(
    store: HistoryStore(
      locateFolder: () async => historyFolder,
      lockOwner: const LockFileOwner(
        processId: 4242,
        engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      ),
      lockTakeOver: LocalLockTakeOver.everyEngineAttached(),
      clock: clock,
      clientErrorReporter: reporter,
    ),
    answerReader: const HistoryAnswerReader(),
    clientErrorReporter: reporter,
    clock: clock,
    readWaitingClips: () async => waitingClips,
  );

  late final StationListRepository stationList = () {
    final randomUuid = RandomUuid();
    final apiClient = ApiClient(
      configuration: configuration,
      randomUuid: randomUuid,
      clock: clock,
      httpClientAdapter: adapter,
    );
    return StationListRepository(
      apiClient: apiClient,
      listenerInstallRepository: ListenerInstallRepository(
        store: ListenerInstallStore(randomUuid: randomUuid),
        registration: ListenerInstallRegistration(apiClient: apiClient),
        randomUuid: randomUuid,
        clock: clock,
      ),
      cache: StationListCache(locateFolder: () async => stationListFolder),
      clientErrorReporter: reporter,
      clock: clock,
    );
  }();

  List<Override> get overrides => [
    appConfigurationProvider.overrideWithValue(configuration),
    historyRepositoryProvider.overrideWithValue(history),
    historyClockProvider.overrideWithValue(clock),
    stationListRepositoryProvider.overrideWithValue(stationList),
    actionLauncherProvider.overrideWithValue(launcher),
    clipboardWriterProvider.overrideWithValue(clipboard),
    ...extraOverrides,
  ];

  /// Answers the next station list request with a shared fixture, e.g. `valid/two-stations`, and
  /// an entity tag.
  void answerWithStationList(String name) {
    final content =
        ContractFixtures.readFile('recognition/listener-station-list/$name.json')!
            as Map<String, Object?>;
    adapter.answerJson(
      200,
      content['response'],
      headers: {
        'etag': ['"stations-1"'],
      },
    );
  }

  /// Puts these results in History before the screen is shown, with [outcomes] of saved clips
  /// (a chooser to answer, or a clip not identified) as the store keeps them.
  void keepInHistory(
    List<StoredHistoryEntryData> results, {
    List<StoredHistoryEntry> outcomes = const [],
  }) {
    HistoryFixtures.writeIndex(historyFolder, [
      for (final result in results)
        HistoryFixtures.storedResult(
          recognitionId: result.recognitionId,
          capturedAtOnPhone: result.capturedAtOnPhone,
          fixture: result.fixture,
          chosenStationId: result.chosenStationId,
        ),
      ...outcomes,
    ]);
  }

  /// Shows [screen] on [phoneScreen] in the light theme unless [theme] is given, in English unless
  /// [locale] and [localizationsDelegates] say otherwise, and lets what it reads arrive.
  Future<void> pump(
    WidgetTester tester,
    Widget screen, {
    PhoneScreen phoneScreen = PhoneScreen.standard,
    ThemeData? theme,
    Locale? locale,
    List<LocalizationsDelegate<Object?>>? localizationsDelegates,
    List<Locale>? supportedLocales,
  }) async {
    SharedPreferences.setMockInitialValues({
      'listener_install_id': '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f',
      'listener_install_token': 'stored.install.token',
      'listener_install_token_expires_at': clock
          .now()
          .add(const Duration(days: 30))
          .toIso8601String(),
      'listener_install_registered_app_version': AppVersion.current,
      ...preferences,
    });
    phoneScreen.applyTo(tester);
    await tester.pumpWidget(
      ProviderScope(
        overrides: overrides,
        retry: (retryCount, error) => null,
        child: MaterialApp(
          theme: theme ?? LookUpTheme.light(),
          locale: locale,
          localizationsDelegates: localizationsDelegates ?? FallbackLocalizations.delegates,
          supportedLocales: supportedLocales ?? FallbackLocalizations.supportedLocales,
          home: screen,
        ),
      ),
    );
    await settle(tester);
  }

  /// Lets reads of History, "My station" and the station list arrive: a few frames, 20 ms of the
  /// test's own time apart, as the HTTP client's answer passes through its timers. The harness's
  /// clock, which the screens read, does not move.
  static Future<void> settle(WidgetTester tester) async {
    for (var frame = 0; frame < 5; frame++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
  }
}

/// One result to put in History: which answer fixture, under which recognition id, recorded when,
/// and the station chosen when the answer offered several.
final class StoredHistoryEntryData {
  const StoredHistoryEntryData({
    required this.recognitionId,
    required this.capturedAtOnPhone,
    this.fixture = 'valid/match-campaign',
    this.chosenStationId,
  });

  final String recognitionId;
  final DateTime capturedAtOnPhone;
  final String fixture;
  final String? chosenStationId;
}
