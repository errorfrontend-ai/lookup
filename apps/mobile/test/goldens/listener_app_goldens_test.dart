import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/features/identify/domain/chooser_origin.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/domain/saved_clip_reason.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/settings/data/my_station_store.dart';

import '../app/listener_app_harness.dart';
import '../features/identify/presentation/recording_recognition_flow.dart';
import '../features/result/support/result_screen_harness.dart';
import '../support/contract_fixtures.dart';
import '../support/history_fixtures.dart';
import '../support/phone_screen.dart';

/// The golden images (P6 design §4.6; P6-TESTS-01 to -04): every designed state, at 320 × 640,
/// 360 × 800, 411 × 891 and 800 × 1280, at text scale 1.0 and 2.0, in the light and the dark theme —
/// 16 images per state, drawn with the real fonts (`flutter_test_config.dart`) at one pixel per dp.
/// Each image also fails on any overflow (P6-ACCESSIBILITY-05, P6-RESPONSIVE-01, -03, -06). The
/// 800 × 1280 images show the medium layout: the Result in a side panel (P6-RESULT-02); 360 × 800 the
/// full-height Result (P6-RESULT-01).
///
///     flutter test test/goldens                       (compares)
///     flutter test test/goldens --update-goldens      (draws them again, after a change of design)
void main() {
  for (final state in goldenStates) {
    for (final screen in goldenScreens) {
      for (final brightness in Brightness.values) {
        final themeName = brightness == Brightness.light ? 'light' : 'dark';
        final fileName =
            '${screen.width.round()}x${screen.height.round()}-text-${screen.textScale}-$themeName';
        testWidgets('${state.name}, ${screen.width.round()} × ${screen.height.round()}, text '
            '${screen.textScale}, $themeName', (tester) async {
          tester.platformDispatcher.platformBrightnessTestValue = brightness;
          addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
          await state.show(tester, screen);
          await expectLater(
            find.byType(MaterialApp),
            matchesGoldenFile('images/${state.name}/$fileName.png'),
          );
        });
      }
    }
  }
}

/// The four sizes at the two text scales, one pixel per dp (P6-TESTS-02, -03).
final List<PhoneScreen> goldenScreens = [
  for (final (width, height) in const [
    (320.0, 640.0),
    (360.0, 800.0),
    (411.0, 891.0),
    (800.0, 1280.0),
  ])
    for (final textScale in const [1.0, 2.0])
      PhoneScreen(width: width, height: height, textScale: textScale, devicePixelRatio: 1),
];

/// A designed state: its name (the images' folder) and how the app is brought to it.
final class GoldenState {
  const GoldenState(this.name, this.show);

  final String name;
  final Future<void> Function(WidgetTester tester, PhoneScreen screen) show;
}

/// Every designed state (P6-TESTS-01): one for each state of the flow, plus History, Settings and
/// its pages, and the report sheet.
final List<GoldenState> goldenStates = [
  GoldenState('home', (tester, screen) => _showFlow(tester, screen, const IdleState())),
  GoldenState(
    'home-with-my-station',
    (tester, screen) => _showFlow(
      tester,
      screen,
      const IdleState(),
      harness: ListenerAppHarness(storedPreferences: {MyStationStore.myStationKey: _stationAKept}),
    ),
  ),
  GoldenState(
    'home-first-open',
    (tester, screen) => _showFlow(
      tester,
      screen,
      const IdleState(),
      harness: ListenerAppHarness(isFirstLaunch: true),
    ),
  ),
  for (final access in [
    MicrophoneAccess.notAskedYet,
    MicrophoneAccess.refusedOnce,
    MicrophoneAccess.refusedForGood,
  ])
    GoldenState(
      'permission-${access.name}',
      (tester, screen) =>
          _showFlow(tester, screen, PermissionNeededState(microphoneAccess: access)),
    ),
  GoldenState(
    'listening',
    (tester, screen) =>
        _showFlow(tester, screen, const RecordingState(levelFraction: 0.5, secondsLeft: 5)),
  ),
  GoldenState('identifying', (tester, screen) => _showFlow(tester, screen, const UploadingState())),
  GoldenState(
    'identifying-slow',
    (tester, screen) =>
        _showFlow(tester, screen, const UploadingState(isSlow: true, sentPercent: 40)),
  ),
  GoldenState(
    'which-station-two',
    (tester, screen) => _showFlow(tester, screen, _chooser(stationCount: 2)),
  ),
  GoldenState(
    'which-station-four',
    (tester, screen) => _showFlow(tester, screen, _chooser(stationCount: 4)),
  ),
  GoldenState(
    'which-station-off-air',
    (tester, screen) => _showFlow(tester, screen, _chooser(stationCount: 2, isOffAir: true)),
  ),
  GoldenState(
    'result',
    (tester, screen) => _showFlow(tester, screen, MatchedState(result: _result())),
  ),
  GoldenState(
    'result-usual-buttons',
    (tester, screen) => _showFlow(
      tester,
      screen,
      FallbackState(result: _result(kind: RecognitionResultKind.clientDefault)),
    ),
  ),
  GoldenState(
    'result-more-options',
    (tester, screen) => _showFlow(
      tester,
      screen,
      MatchedState(result: _result(card: fixtureCard('action-card/valid/six-actions.json'))),
    ),
  ),
  GoldenState('result-reported', (tester, screen) {
    final harness = ListenerAppHarness();
    HistoryFixtures.writeIndex(harness.historyFolder, [
      HistoryFixtures.storedResult(
        recognitionId: fixtureRecognitionId,
        capturedAtOnPhone: DateTime.utc(2026, 10, 14, 7),
      ).markedReported(),
    ]);
    return _showFlow(tester, screen, MatchedState(result: _result()), harness: harness);
  }),
  GoldenState('report-sheet', (tester, screen) async {
    await _showFlow(tester, screen, MatchedState(result: _result()));
    final link = find.text('Report this');
    await tester.ensureVisible(link);
    await tester.pump();
    await tester.tap(link);
    await _settle(tester);
  }),
  GoldenState('no-match', (tester, screen) => _showFlow(tester, screen, const NoMatchState())),
  GoldenState(
    'busy',
    (tester, screen) =>
        _showFlow(tester, screen, const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 7)),
  ),
  for (final (name, failure) in <(String, RecognitionFailure)>[
    ('server', const ServerFailure(requestId: '3bb31b22-d79a-4411-ae99-3ea4774924d3')),
    (
      'phone',
      const PhoneFailure(
        reportRequestId: '4ea02e15-20f0-4817-9596-85c05d306ddc',
        reportDelivery: ReportDelivery.accepted,
      ),
    ),
    (
      'recording-unusable',
      const RecordingUnusableFailure(requestId: '5046e7b1-a655-4805-b22a-dec7b9391d72'),
    ),
    ('newer-app-needed', const NewerAppNeededFailure()),
    ('please-update', const AppUpdateRequiredFailure()),
  ])
    GoldenState(
      'error-$name',
      (tester, screen) => _showFlow(tester, screen, ErrorState(failure: failure)),
    ),
  for (final reason in SavedClipReason.values)
    GoldenState(
      'saved-offline-${reason.name}',
      (tester, screen) =>
          _showFlow(tester, screen, SavedOfflineState(reason: reason, wasOldestClipDeleted: false)),
    ),
  GoldenState('history-results', (tester, screen) {
    final harness = ListenerAppHarness();
    HistoryFixtures.writeIndex(harness.historyFolder, [
      for (var number = 1; number <= 3; number++)
        HistoryFixtures.storedResult(
          recognitionId: HistoryFixtures.recognitionIdNumbered(number),
          capturedAtOnPhone: DateTime.utc(2026, 10, 14, 7, number),
        ),
    ]);
    return _showTab(tester, screen, AppRoute.history, harness: harness);
  }),
  GoldenState('history-empty', (tester, screen) => _showTab(tester, screen, AppRoute.history)),
  GoldenState('settings', (tester, screen) => _showTab(tester, screen, AppRoute.settings)),
  GoldenState('my-station-picker', (tester, screen) {
    final harness = ListenerAppHarness();
    final fixture =
        ContractFixtures.readFile('recognition/listener-station-list/valid/two-stations.json')!
            as Map<String, Object?>;
    harness.adapter.answerJson(
      200,
      fixture['response'],
      headers: {
        'etag': ['"stations-1"'],
      },
    );
    return _showTab(tester, screen, AppRoute.myStation, harness: harness);
  }),
  GoldenState('privacy', (tester, screen) => _showTab(tester, screen, AppRoute.privacy)),
  GoldenState('about', (tester, screen) => _showTab(tester, screen, AppRoute.about)),
];

final String _stationAKept = jsonEncode({
  'id': '0192a6c4-1111-4000-8000-000000000001',
  'name': 'Station A',
  'frequency_label': '98.1 FM',
  'city': 'Lusaka',
});

/// The shared four-button card, as most results show it.
RecognitionResult _result({
  RecognitionResultKind kind = RecognitionResultKind.campaign,
  Object? card,
}) => resultWith(kind: kind, card: card ?? fourActionCard);

/// "Which station?" with [stationCount] of the stand-in's stations, all off air when [isOffAir].
ChooseStationState _chooser({required int stationCount, bool isOffAir = false}) {
  const stations = [
    ('0192a6c4-1111-4000-8000-000000000001', 'Station A', '98.1 FM', 'Lusaka'),
    ('0192a6c4-1111-4000-8000-000000000002', 'Station B', '104.3 FM', 'Kitwe'),
    ('0192a6c4-1111-4000-8000-000000000003', 'Station C', '89.5 FM', 'Ndola'),
    ('0192a6c4-1111-4000-8000-000000000004', 'Station D', '101.7 FM', 'Livingstone'),
  ];
  return ChooseStationState(
    recognitionId: fixtureRecognitionId,
    candidates: [
      for (final (id, name, frequency, city) in stations.take(stationCount))
        resultWith(
          kind: isOffAir ? RecognitionResultKind.clientDefault : RecognitionResultKind.campaign,
          stationId: id,
          stationName: name,
          stationFrequencyLabel: frequency,
          stationCity: city,
          card: fourActionCard,
        ),
    ],
    origin: ChooserOrigin.liveIdentify,
  );
}

/// The whole app, showing [state] through a flow that only shows the states it is given.
Future<void> _showFlow(
  WidgetTester tester,
  PhoneScreen screen,
  RecognitionState state, {
  ListenerAppHarness? harness,
}) async {
  final app = harness ?? ListenerAppHarness();
  await app.pumpApp(
    tester,
    phoneScreen: screen,
    extraOverrides: [recognitionFlowProvider.overrideWith(() => RecordingRecognitionFlow(state))],
  );
  await _settle(tester);
}

/// The whole app at [route]: a tab, or a page over the tabs.
Future<void> _showTab(
  WidgetTester tester,
  PhoneScreen screen,
  AppRoute route, {
  ListenerAppHarness? harness,
}) async {
  final app = harness ?? ListenerAppHarness();
  await app.pumpApp(tester, phoneScreen: screen);
  app.router(tester).go(route.path);
  await _settle(tester);
}

/// Lets files be read and transitions end, without waiting on animations that never stop (the
/// listening ring).
Future<void> _settle(WidgetTester tester) async {
  for (var frame = 0; frame < 3; frame++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump(const Duration(milliseconds: 300));
  }
}
