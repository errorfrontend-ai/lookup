import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/app/app_router.dart';
import 'package:lookup_listener/app/app_shell.dart';
import 'package:lookup_listener/app/main_navigation_bar.dart';
import 'package:lookup_listener/app/main_navigation_item.dart';
import 'package:lookup_listener/app/pending_destination.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/busy_screen.dart';
import 'package:lookup_listener/features/identify/presentation/error_screen.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/identifying_screen.dart';
import 'package:lookup_listener/features/identify/presentation/listening_screen.dart';
import 'package:lookup_listener/features/identify/presentation/no_match_screen.dart';
import 'package:lookup_listener/features/identify/presentation/permission_screen.dart';
import 'package:lookup_listener/features/history/presentation/history_entry_row.dart';
import 'package:lookup_listener/features/history/presentation/history_screen.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/result/presentation/action_button.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';
import 'package:lookup_listener/features/settings/presentation/about_screen.dart';
import 'package:lookup_listener/features/settings/presentation/my_station_picker_screen.dart';
import 'package:lookup_listener/features/settings/presentation/privacy_screen.dart';
import 'package:lookup_listener/features/settings/presentation/settings_screen.dart';
import 'package:lookup_listener/features/settings/presentation/station_picker_row.dart';
import 'package:lookup_listener/features/identify/domain/saved_clip_reason.dart';
import 'package:lookup_listener/features/identify/presentation/saved_offline_screen.dart';

import '../features/identify/presentation/identify_screen_harness.dart'
    show disableAnimations, pressSystemBack;
import '../features/identify/presentation/recording_recognition_flow.dart';
import '../features/result/support/result_screen_harness.dart' show resultWith;
import '../support/contract_fixtures.dart';
import '../support/history_fixtures.dart';
import 'listener_app_harness.dart';

/// Every state, with the route and the screen it must show.
List<(RecognitionState, AppRoute, Type)> _statesRoutesAndScreens() {
  final result = resultWith();
  return [
    (const IdleState(), AppRoute.home, HomeScreen),
    (
      const PermissionNeededState(microphoneAccess: MicrophoneAccess.refusedOnce),
      AppRoute.permission,
      PermissionScreen,
    ),
    (const RecordingState(levelFraction: 0.5, secondsLeft: 3), AppRoute.listening, ListeningScreen),
    (const UploadingState(), AppRoute.identifying, IdentifyingScreen),
    (MatchedState(result: result), AppRoute.result, ResultScreen),
    (FallbackState(result: result), AppRoute.result, ResultScreen),
    (const NoMatchState(), AppRoute.noMatch, NoMatchScreen),
    (const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 7), AppRoute.busy, BusyScreen),
    (
      const SavedOfflineState(reason: SavedClipReason.busy, wasOldestClipDeleted: false),
      AppRoute.savedOffline,
      SavedOfflineScreen,
    ),
    (const ErrorState(failure: AppUpdateRequiredFailure()), AppRoute.error, ErrorScreen),
  ];
}

/// Starts the whole app with a flow that only shows the states the test gives it.
Future<(ListenerAppHarness, RecordingRecognitionFlow)> _appShowing(
  WidgetTester tester,
  RecognitionState firstState,
) async {
  final flow = RecordingRecognitionFlow(firstState);
  final harness = ListenerAppHarness();
  await harness.pumpApp(tester, extraOverrides: [recognitionFlowProvider.overrideWith(() => flow)]);
  return (harness, flow);
}

void main() {
  group('navigation follows the state (S4-D5)', () {
    testWidgets('each state is shown at its route, by its screen', (tester) async {
      final (harness, flow) = await _appShowing(tester, const IdleState());
      for (final (state, route, screen) in _statesRoutesAndScreens()) {
        flow.show(state);
        await harness.pumpTransition(tester);
        expect(harness.location(tester), route.path, reason: '$state');
        expect(find.byType(screen), findsOneWidget, reason: '$state');
      }
      expect(flow.calls, isEmpty, reason: 'Screens never move the flow on their own.');
    });

    testWidgets('the app opens at the route of the state it starts in', (tester) async {
      final (harness, _) = await _appShowing(tester, const NoMatchState());
      expect(harness.location(tester), '/no-match');
      expect(find.byType(NoMatchScreen), findsOneWidget);
    });

    testWidgets('every move replaces the page, so there is never a page to go back to', (
      tester,
    ) async {
      final (harness, flow) = await _appShowing(tester, const IdleState());
      for (final (state, _, screen) in _statesRoutesAndScreens()) {
        flow.show(state);
        await harness.pumpTransition(tester);
        expect(Navigator.of(tester.element(find.byType(screen))).canPop(), isFalse);
        expect(harness.router(tester).routerDelegate.currentConfiguration.matches, hasLength(1));
      }
    });

    testWidgets('an unknown path is sent to the state\'s route, never an error page', (
      tester,
    ) async {
      final (harness, _) = await _appShowing(tester, const IdleState());
      harness.router(tester).go('/ads');
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/');
      expect(find.byType(HomeScreen), findsOneWidget);
    });

    testWidgets('a stale /result while idle goes Home', (tester) async {
      final (harness, _) = await _appShowing(tester, const IdleState());
      harness.router(tester).go('/result');
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/');
    });

    testWidgets('a location that does not match the state is sent to the state\'s route', (
      tester,
    ) async {
      final (harness, _) = await _appShowing(tester, const NoMatchState());
      harness.router(tester).go('/busy');
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/no-match');
    });
  });

  group('system Back', () {
    testWidgets('on every screen but Home, does what its Back or Close does: backToHome()', (
      tester,
    ) async {
      final (harness, flow) = await _appShowing(tester, const IdleState());
      final states = [
        for (final (state, _, _) in _statesRoutesAndScreens())
          if (state is! IdleState) state,
      ];
      for (final state in states) {
        flow.calls.clear();
        flow.show(state);
        await harness.pumpTransition(tester);
        await pressSystemBack(tester);
        expect(flow.calls, ['backToHome'], reason: '$state');
      }
    });

    testWidgets('with the real flow, leads Home from Permission, Busy and Error', (tester) async {
      final harness = ListenerAppHarness(microphoneAccess: MicrophoneAccess.notAskedYet);
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/permission');
      await pressSystemBack(tester);
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/');

      harness.permission.access = MicrophoneAccess.granted;
      harness.answerWithEnvelopeFixture('recognition-busy');
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await harness.recordWholeClip(tester);
      expect(harness.location(tester), '/busy');
      await pressSystemBack(tester);
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/');
      expect(harness.flow(tester).hasKeptClip, isFalse);

      harness.answerWithEnvelopeFixture('internal');
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await harness.recordWholeClip(tester);
      expect(harness.location(tester), '/error');
      await pressSystemBack(tester);
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/');
      expect(find.byType(HomeScreen), findsOneWidget);
    });
  });

  group('the tab shell (P6 design §2.2, §3.7; P6-NAVIGATION-01, -05, -06)', () {
    Finder barItem(String label) => find.descendant(
      of: find.byType(MainNavigationBar),
      matching: find.ancestor(of: find.text(label), matching: find.byType(MainNavigationItem)),
    );

    testWidgets('Home, History and Settings show the tab bar; a tab opens its screen', (
      tester,
    ) async {
      final harness = ListenerAppHarness();
      await harness.pumpApp(tester);
      expect(find.byType(MainNavigationBar), findsOneWidget);

      await tester.tap(barItem('History'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/history');
      expect(find.byType(HistoryScreen), findsOneWidget);
      expect(find.byType(MainNavigationBar), findsOneWidget);

      await tester.tap(barItem('Settings'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/settings');
      expect(find.byType(SettingsScreen), findsOneWidget);

      await tester.tap(barItem('Identify'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/');
      expect(find.byType(HomeScreen), findsOneWidget);
    });

    testWidgets(
      'History shows the bar with History as the current tab, for screen readers and in bold (P6-NAVIGATION-05)',
      (tester) async {
        final semantics = tester.ensureSemantics();
        final harness = ListenerAppHarness();
        await harness.pumpApp(tester);
        await tester.tap(barItem('History'));
        await harness.pumpTransition(tester);
        for (final (label, isCurrent) in [
          ('Identify', false),
          ('History', true),
          ('Settings', false),
        ]) {
          expect(
            tester.getSemantics(barItem(label)).getSemanticsData().flagsCollection.isSelected,
            isCurrent ? Tristate.isTrue : Tristate.isFalse,
            reason: label,
          );
        }
        final label = tester.widget<Text>(
          find.descendant(of: barItem('History'), matching: find.text('History')),
        );
        expect(label.style!.fontWeight, FontWeight.w700);
        semantics.dispose();
      },
    );

    testWidgets(
      'Settings shows the bar with Settings as the current tab, for screen readers and in bold (P6-NAVIGATION-06)',
      (tester) async {
        final semantics = tester.ensureSemantics();
        final harness = ListenerAppHarness();
        await harness.pumpApp(tester);
        await tester.tap(barItem('Settings'));
        await harness.pumpTransition(tester);
        for (final (label, isCurrent) in [
          ('Identify', false),
          ('History', false),
          ('Settings', true),
        ]) {
          expect(
            tester.getSemantics(barItem(label)).getSemanticsData().flagsCollection.isSelected,
            isCurrent ? Tristate.isTrue : Tristate.isFalse,
            reason: label,
          );
        }
        final label = tester.widget<Text>(
          find.descendant(of: barItem('Settings'), matching: find.text('Settings')),
        );
        expect(label.style!.fontWeight, FontWeight.w700);
        semantics.dispose();
      },
    );

    testWidgets('no flow screen shows the tab bar', (tester) async {
      final (harness, flow) = await _appShowing(tester, const IdleState());
      for (final (state, _, screen) in _statesRoutesAndScreens()) {
        if (state is IdleState) continue;
        flow.show(state);
        await harness.pumpTransition(tester);
        expect(find.byType(screen), findsOneWidget, reason: '$state');
        expect(find.byType(MainNavigationBar), findsNothing, reason: '$state');
      }
    });

    testWidgets(
      'each tab keeps its place: History\'s scroll position survives a visit to Settings (P6-NAVIGATION-01)',
      (tester) async {
        final harness = ListenerAppHarness();
        HistoryFixtures.writeIndex(harness.historyFolder, [
          for (var number = 1; number <= 12; number++)
            HistoryFixtures.storedResult(
              recognitionId: HistoryFixtures.recognitionIdNumbered(number),
              capturedAtOnPhone: DateTime.now().subtract(Duration(minutes: number)),
            ),
        ]);
        await harness.pumpApp(tester);
        await tester.tap(barItem('History'));
        await harness.pumpTransition(tester);
        expect(find.byType(HistoryEntryRow), findsWidgets);

        ScrollPosition historyScroll() => tester
            .state<ScrollableState>(
              find.descendant(of: find.byType(HistoryScreen), matching: find.byType(Scrollable)),
            )
            .position;
        historyScroll().jumpTo(400);
        await tester.pump();
        expect(historyScroll().pixels, 400);

        await tester.tap(barItem('Settings'));
        await harness.pumpTransition(tester);
        expect(find.byType(SettingsScreen), findsOneWidget);
        await tester.tap(barItem('History'));
        await harness.pumpTransition(tester);
        expect(historyScroll().pixels, 400, reason: 'History is where it was left');
      },
    );

    testWidgets(
      'system Back on History or Settings goes to the Identify tab; on Identify it leaves the app',
      (tester) async {
        final platformCalls = <MethodCall>[];
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (
          call,
        ) async {
          platformCalls.add(call);
          return null;
        });
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            SystemChannels.platform,
            null,
          ),
        );
        final harness = ListenerAppHarness();
        await harness.pumpApp(tester);
        for (final tab in ['History', 'Settings']) {
          await tester.tap(barItem(tab));
          await harness.pumpTransition(tester);
          await pressSystemBack(tester);
          await harness.pumpTransition(tester);
          expect(harness.location(tester), '/', reason: 'Back from $tab');
          expect(find.byType(HomeScreen), findsOneWidget);
        }
        expect(platformCalls.where((call) => call.method == 'SystemNavigator.pop'), isEmpty);
        await pressSystemBack(tester);
        await tester.pump();
        expect(
          platformCalls.where((call) => call.method == 'SystemNavigator.pop'),
          hasLength(1),
          reason: 'Back on Identify leaves the app',
        );
      },
    );

    testWidgets(
      'the Settings pages sit over the tabs, full screen, and Back returns to Settings as it was',
      (tester) async {
        final harness = ListenerAppHarness();
        await harness.pumpApp(tester);
        await tester.tap(barItem('Settings'));
        await harness.pumpTransition(tester);
        for (final (rowTitle, location, screen) in [
          ('Privacy', '/settings/privacy', PrivacyScreen),
          ('About Look Up', '/settings/about', AboutScreen),
        ]) {
          await tester.tap(find.text(rowTitle));
          await harness.pumpTransition(tester);
          expect(harness.location(tester), location);
          expect(find.byType(screen), findsOneWidget);
          expect(find.byType(MainNavigationBar), findsNothing, reason: 'full screen');
          await tester.tap(find.bySemanticsLabel('Back'));
          await harness.pumpTransition(tester);
          expect(harness.location(tester), '/settings');
          expect(find.byType(SettingsScreen), findsOneWidget);
        }
      },
    );
  });

  group('the "My station" picker in the app (P6-MYSTATION-01, -02, -04)', () {
    void answerWithStations(ListenerAppHarness harness) {
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
    }

    List<String> stationRequestPaths(ListenerAppHarness harness) => [
      for (final request in harness.adapter.requests)
        if (request.address.path == '/api/v1/stations') request.address.path,
    ];

    testWidgets(
      'the "My station" row opens the list of stations the API gave; a tap keeps one, which Settings and Home then show (P6-MYSTATION-01, -02)',
      (tester) async {
        final harness = ListenerAppHarness();
        answerWithStations(harness);
        await harness.pumpApp(tester);
        await tester.tap(find.text('My station: Not set'));
        await harness.pumpTransition(tester);
        expect(harness.location(tester), '/settings');

        await tester.tap(find.text('Not set — used when an ad is on more than one station'));
        await harness.pumpTransition(tester);
        await harness.pumpTransition(tester);
        expect(harness.location(tester), '/settings/my-station');
        expect(find.byType(MyStationPickerScreen), findsOneWidget);
        expect(find.byType(StationPickerRow), findsNWidgets(3));
        expect(find.text('Station A'), findsOneWidget);
        expect(find.text('Station B'), findsOneWidget);
        expect(stationRequestPaths(harness), ['/api/v1/stations']);

        await tester.tap(find.text('Station A'));
        await harness.pumpTransition(tester);
        await harness.pumpTransition(tester);
        expect(harness.location(tester), '/settings');
        expect(
          find.text('Station A · 98.1 FM — used when an ad is on more than one station'),
          findsOneWidget,
        );
        await tester.tap(find.text('Identify'));
        await harness.pumpTransition(tester);
        expect(find.text('My station: Station A'), findsOneWidget);
      },
    );

    testWidgets('opened again within 24 hours: no second request (P6-MYSTATION-04)', (
      tester,
    ) async {
      final harness = ListenerAppHarness();
      answerWithStations(harness);
      await harness.pumpApp(tester);
      await tester.tap(find.text('Settings'));
      await harness.pumpTransition(tester);
      for (var opening = 0; opening < 2; opening++) {
        await tester.tap(find.text('My station'));
        await harness.pumpTransition(tester);
        await harness.pumpTransition(tester);
        expect(find.byType(StationPickerRow), findsNWidgets(3), reason: 'opening $opening');
        await tester.tap(find.bySemanticsLabel('Back'));
        await harness.pumpTransition(tester);
      }
      expect(stationRequestPaths(harness), ['/api/v1/stations']);
    });
  });

  group('the narrowed redirect (P6 design §3.7, P6-D14)', () {
    const recognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';

    test('the four rules, location by location', () {
      final destination = PendingDestination();
      String? redirect(String location, AppRoute flowRoute) => AppRouter.redirectFor(
        location,
        currentFlowRoute: flowRoute,
        pendingDestination: destination,
      );
      // (1) An identify under way: only its own screen.
      for (final location in [
        '/',
        '/history',
        '/settings/privacy',
        '/r/$recognitionId',
        '/result',
      ]) {
        expect(redirect(location, AppRoute.listening), '/listening', reason: location);
      }
      expect(redirect('/listening', AppRoute.listening), isNull);
      // (3) Idle: the tabs, the Settings pages and saved results are free.
      for (final location in [
        '/',
        '/history',
        '/settings',
        '/settings/my-station',
        '/settings/privacy',
        '/settings/about',
        '/r/$recognitionId',
      ]) {
        expect(redirect(location, AppRoute.home), isNull, reason: location);
      }
      // (2) Idle on a flow screen: Home, or the kept destination, once.
      expect(redirect('/result', AppRoute.home), '/');
      destination.keep('/history');
      expect(redirect('/saved-offline-or-any-flow', AppRoute.home), '/', reason: 'unknown first');
      expect(redirect('/no-match', AppRoute.home), '/history');
      expect(redirect('/no-match', AppRoute.home), '/', reason: 'taken once');
      // (4) A path the app does not know.
      expect(redirect('/ads', AppRoute.home), '/');
    });

    testWidgets(
      'while an identify is under way, a tab, a page or a saved result goes to its screen',
      (tester) async {
        final (harness, _) = await _appShowing(
          tester,
          const RecordingState(levelFraction: 0, secondsLeft: 5),
        );
        for (final location in ['/history', '/settings/about', '/r/$recognitionId']) {
          harness.router(tester).go(location);
          await harness.pumpTransition(tester);
          expect(harness.location(tester), '/listening', reason: location);
        }
      },
    );

    testWidgets('while idle, the tabs, the Settings pages and saved results stay where they are', (
      tester,
    ) async {
      final (harness, _) = await _appShowing(tester, const IdleState());
      for (final location in ['/history', '/settings', '/settings/privacy']) {
        harness.router(tester).go(location);
        await harness.pumpTransition(tester);
        expect(harness.location(tester), location);
      }
    });

    testWidgets(
      'a kept destination is where the flow lands when it ends, in one step, with no frame of Home ("See it in History")',
      (tester) async {
        final (harness, flow) = await _appShowing(tester, const NoMatchState());
        expect(harness.location(tester), '/no-match');
        harness.container(tester).read(pendingDestinationProvider).keep('/history');
        flow.show(const IdleState());

        await tester.pump();
        expect(harness.location(tester), '/history');
        for (var frame = 0; frame < 6; frame++) {
          expect(find.byType(HomeScreen), findsNothing, reason: 'frame $frame');
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(find.byType(HistoryScreen), findsOneWidget);
        expect(harness.container(tester).read(pendingDestinationProvider).value, isNull);
      },
    );

    testWidgets('a destination kept during an identify waits until it ends; the identify goes on', (
      tester,
    ) async {
      final (harness, flow) = await _appShowing(
        tester,
        const RecordingState(levelFraction: 0, secondsLeft: 5),
      );
      harness.container(tester).read(pendingDestinationProvider).keep('/settings');
      flow.show(const RecordingState(levelFraction: 0.5, secondsLeft: 4));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/listening');
      flow.show(const UploadingState());
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/identifying');
      flow.show(const IdleState());
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/settings');
    });

    testWidgets('a kept destination is taken once: the next flow ends at Home', (tester) async {
      final (harness, flow) = await _appShowing(tester, const NoMatchState());
      harness.container(tester).read(pendingDestinationProvider).keep('/history');
      flow.show(const IdleState());
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/history');
      flow.show(const NoMatchState());
      await harness.pumpTransition(tester);
      flow.show(const IdleState());
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/');
    });
  });

  group('a saved result at /r/ and its recognition id (P6 design §2.10; P6-STRUCTURE-02)', () {
    const recognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';

    ListenerAppHarness withOneSavedResult() {
      final harness = ListenerAppHarness();
      HistoryFixtures.writeIndex(harness.historyFolder, [
        HistoryFixtures.storedResult(
          recognitionId: recognitionId,
          capturedAtOnPhone: DateTime.now().subtract(const Duration(minutes: 5)),
        ),
      ]);
      return harness;
    }

    testWidgets(
      'opening /r/ with the id of a result in History shows that result\'s card, with no request (P6-STRUCTURE-02)',
      (tester) async {
        final harness = withOneSavedResult();
        await harness.pumpApp(tester);
        harness.router(tester).go(AppRoute.savedResultLocation(recognitionId));
        await harness.pumpTransition(tester);
        await harness.pumpTransition(tester);
        expect(harness.location(tester), '/r/$recognitionId');
        expect(find.byType(ResultScreen), findsOneWidget);
        expect(find.text('Saved result'), findsOneWidget);
        expect(find.text('Brand A'), findsOneWidget);
        expect(find.text('Summer service offer'), findsOneWidget);
        expect(find.text('via Station A · 98.1 FM'), findsOneWidget);
        expect(find.byType(ActionButton), findsNWidgets(4));
        expect(harness.adapter.requests, isEmpty, reason: 'filled from History alone');
        // Opened with nothing under it, Back goes to History.
        await tester.tap(find.bySemanticsLabel('Back'));
        await harness.pumpTransition(tester);
        expect(harness.location(tester), '/history');
      },
    );

    testWidgets(
      'from History, a row opens it, and Back returns to History as it was (P6-HISTORY-11)',
      (tester) async {
        final harness = withOneSavedResult();
        await harness.pumpApp(tester);
        await tester.tap(find.text('History'));
        await harness.pumpTransition(tester);
        await tester.tap(find.byType(HistoryEntryRow));
        await harness.pumpTransition(tester);
        await harness.pumpTransition(tester);
        expect(harness.location(tester), '/r/$recognitionId');
        expect(find.text('Saved result'), findsOneWidget);
        expect(find.byType(MainNavigationBar), findsNothing, reason: 'full screen');
        await pressSystemBack(tester);
        await harness.pumpTransition(tester);
        expect(harness.location(tester), '/history');
        expect(find.byType(HistoryEntryRow), findsOneWidget);
      },
    );

    for (final (name, id) in [
      ('no longer in History', '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f99'),
      ('not a recognition id at all', 'not-a-recognition'),
    ]) {
      testWidgets(
        'an id $name goes to History with "That result is no longer saved on this phone."',
        (tester) async {
          final harness = withOneSavedResult();
          await harness.pumpApp(tester);
          harness.router(tester).go('/r/$id');
          await harness.pumpTransition(tester);
          await harness.pumpTransition(tester);
          expect(harness.location(tester), '/history');
          expect(find.byType(HistoryScreen), findsOneWidget);
          expect(find.text('That result is no longer saved on this phone.'), findsOneWidget);
          expect(find.byType(ResultScreen), findsNothing);
        },
      );
    }
  });

  group('page transitions', () {
    testWidgets('fade over motion.base (200 ms)', (tester) async {
      final (harness, flow) = await _appShowing(tester, const IdleState());
      // The tab shell's page, around Home.
      final shellRoute = ModalRoute.of(tester.element(find.byType(AppShell)))!;
      expect(shellRoute.transitionDuration, const Duration(milliseconds: 200));
      flow.show(const NoMatchState());
      await harness.pumpTransition(tester);
      final flowRoute = ModalRoute.of(tester.element(find.byType(NoMatchScreen)))!;
      expect(flowRoute.transitionDuration, const Duration(milliseconds: 200));
    });

    testWidgets('change at once when the phone asks for less motion', (tester) async {
      disableAnimations(tester);
      final (harness, flow) = await _appShowing(tester, const IdleState());
      expect(
        ModalRoute.of(tester.element(find.byType(AppShell)))!.transitionDuration,
        Duration.zero,
      );
      flow.show(const NoMatchState());
      await tester.pump();
      await tester.pump();
      expect(find.byType(NoMatchScreen), findsOneWidget);
      expect(find.byType(HomeScreen), findsNothing);
      expect(harness.location(tester), '/no-match');
    });
  });
}
