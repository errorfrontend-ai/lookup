import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/identifying_screen.dart';
import 'package:lookup_listener/features/identify/presentation/level_bars.dart';
import 'package:lookup_listener/features/identify/presentation/level_ring.dart';
import 'package:lookup_listener/features/identify/presentation/listening_screen.dart';
import 'package:lookup_listener/features/identify/presentation/progress_track.dart';

import '../../../app/listener_app_harness.dart';
import '../../../support/phone_screen.dart';
import 'identify_screen_harness.dart';

IdentifyScreenHarness _harness() => IdentifyScreenHarness(state: const UploadingState());

void main() {
  group('wording (design §2.5, S4-D28)', () {
    testWidgets('"Identifying…", the explanation, "Cancel" and "Cancel identifying"', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await _harness().pump(tester, const IdentifyingScreen());
      expect(find.text('Identifying…'), findsOneWidget);
      expect(find.text('This usually takes a few seconds.'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Cancel'), findsOneWidget);
      expect(find.bySemanticsLabel('Cancel identifying'), findsOneWidget);
      expectStateHeading(tester, 'Identifying…', SemanticsRole.status);
      semantics.dispose();
    });

    testWidgets('the Listening layout with the ring still and no level bars', (tester) async {
      await _harness().pump(tester, const IdentifyingScreen());
      expect(find.byType(LevelRing), findsOneWidget);
      expect(tester.widget<LevelRing>(find.byType(LevelRing)).levelFraction, 0);
      expect(find.byType(LevelBars), findsNothing);
      // The length of the wait is unknown.
      expect(tester.widget<ProgressTrack>(find.byType(ProgressTrack)).fraction, isNull);
    });
  });

  group('the ring stays where Listening had it (design §2.5)', () {
    // At 320 × 640 dp the column is taller than the screen, which scrolls, so the ring is at the top
    // of both; a taller 320 dp phone centres it, where the screens could differ.
    for (final phoneScreen in [
      ...PhoneScreen.layoutChecks,
      const PhoneScreen(width: 320, height: 800, textScale: 1),
    ]) {
      testWidgets(
        'on $phoneScreen the ring\'s centre is where it was on Listening, and nothing hidden is read out',
        (tester) async {
          final semantics = tester.ensureSemantics();
          // Listening at the end of the clip, the moment it becomes Identifying.
          await IdentifyScreenHarness(
            state: const RecordingState(levelFraction: 0.5, secondsLeft: 0),
          ).pump(
            tester,
            const ListeningScreen(levelFraction: 0.5, secondsLeft: 0),
            phoneScreen: phoneScreen,
          );
          final ringOnListening = tester.getCenter(find.byType(LevelRing));
          await tester.pumpWidget(const SizedBox());

          await _harness().pump(tester, const IdentifyingScreen(), phoneScreen: phoneScreen);
          expect(tester.takeException(), isNull);
          expect(tester.getCenter(find.byType(LevelRing)), ringOnListening);
          // The room kept for Listening's words is never drawn or announced.
          expect(find.bySemanticsLabel(ListeningScreen.heading), findsNothing);
          expect(find.bySemanticsLabel(ListeningScreen.instruction), findsNothing);
          expect(find.bySemanticsLabel(ListeningScreen.countdownText(8)), findsNothing);
          expect(find.bySemanticsLabel(IdentifyingScreen.heading), findsOneWidget);
          semantics.dispose();
        },
      );
    }
  });

  group('the bar of an unknown wait', () {
    testWidgets('breathes by opacity while animations are on', (tester) async {
      await _harness().pump(tester, const IdentifyingScreen());
      expect(
        find.descendant(of: find.byType(ProgressTrack), matching: find.byType(FadeTransition)),
        findsOneWidget,
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isTrue);
    });

    testWidgets('stands still when the phone asks for less motion: nothing left to draw', (
      tester,
    ) async {
      disableAnimations(tester);
      await _harness().pump(tester, const IdentifyingScreen());
      await tester.pump();
      expect(
        find.descendant(of: find.byType(ProgressTrack), matching: find.byType(FadeTransition)),
        findsNothing,
      );
      expect(tester.binding.hasScheduledFrame, isFalse);
    });
  });

  group('every way out calls backToHome() (T28)', () {
    testWidgets('"Cancel", Close × and system Back', (tester) async {
      final harness = _harness();
      await harness.pump(tester, const IdentifyingScreen());
      await scrollToAndTap(tester, find.text('Cancel'));
      await tester.tap(find.byType(ScreenExitButton));
      await pressSystemBack(tester);
      expect(harness.flow.calls, ['backToHome', 'backToHome', 'backToHome']);
    });

    testWidgets('with the real flow, "Cancel" cancels the request and shows Home', (tester) async {
      final harness = ListenerAppHarness();
      harness.adapter.waitUntilCancelled();
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await harness.recordWholeClip(tester);
      expect(harness.location(tester), '/identifying');
      expect(harness.recognizeRequests, hasLength(1));

      await scrollToAndTap(tester, find.text('Cancel'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/');
      expect(find.text(HomeScreen.heading), findsOneWidget);
      expect(harness.flow(tester).hasKeptClip, isFalse);
      expect(harness.adapter.requests, hasLength(1));
    });
  });

  group('layout and accessibility (design §2.1, §4.3)', () {
    testWidgets('fits at 360 and 320 dp, text scale 1.0 and 2.0, with no technical text', (
      tester,
    ) async {
      await _harness().expectFitsEveryPhone(tester, const IdentifyingScreen());
    });

    testWidgets('meets the tap target, label and contrast guidelines', (tester) async {
      final semantics = tester.ensureSemantics();
      await _harness().pump(tester, const IdentifyingScreen());
      await expectMeetsTapGuidelines(tester);
      semantics.dispose();
    });
  });
}
