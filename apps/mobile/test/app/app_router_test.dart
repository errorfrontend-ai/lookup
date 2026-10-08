import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_route.dart';
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
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';

import '../features/identify/presentation/identify_screen_harness.dart'
    show disableAnimations, pressSystemBack;
import '../features/identify/presentation/recording_recognition_flow.dart';
import '../features/result/support/result_screen_harness.dart' show resultWith;
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
      const ErrorState(failure: TooManyTriesFailure(isShortWait: true)),
      AppRoute.error,
      ErrorScreen,
    ),
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

  group('page transitions', () {
    testWidgets('fade over motion.base (200 ms)', (tester) async {
      final (_, _) = await _appShowing(tester, const IdleState());
      final route = ModalRoute.of(tester.element(find.byType(HomeScreen)))!;
      expect(route.transitionDuration, const Duration(milliseconds: 200));
    });

    testWidgets('change at once when the phone asks for less motion', (tester) async {
      disableAnimations(tester);
      final (harness, flow) = await _appShowing(tester, const IdleState());
      expect(
        ModalRoute.of(tester.element(find.byType(HomeScreen)))!.transitionDuration,
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
