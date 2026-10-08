import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/level_bars.dart';
import 'package:lookup_listener/features/identify/presentation/level_ring.dart';
import 'package:lookup_listener/features/identify/presentation/listening_screen.dart';
import 'package:lookup_listener/features/identify/presentation/progress_track.dart';

import '../../../app/listener_app_harness.dart';
import 'identify_screen_harness.dart';

const RecognitionState _recording = RecordingState(levelFraction: 0.5, secondsLeft: 3);

IdentifyScreenHarness _harness() => IdentifyScreenHarness(state: _recording);

ListeningScreen _screen({double levelFraction = 0.5, int secondsLeft = 3}) =>
    ListeningScreen(levelFraction: levelFraction, secondsLeft: secondsLeft);

/// The ring's scale as drawn now.
double _ringScale(WidgetTester tester) => tester
    .widget<AnimatedScale>(
      find.descendant(of: find.byType(LevelRing), matching: find.byType(AnimatedScale)),
    )
    .scale;

/// The fraction of the progress track that is filled.
double _progressFraction(WidgetTester tester) => tester
    .widget<FractionallySizedBox>(
      find.descendant(of: find.byType(ProgressTrack), matching: find.byType(FractionallySizedBox)),
    )
    .widthFactor!;

void main() {
  group('wording (design §2.4)', () {
    testWidgets('"Listening…", the instruction, the countdown, "Cancel" and "Cancel listening"', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await _harness().pump(tester, _screen());
      expect(find.text('Listening…'), findsOneWidget);
      expect(find.text('Keep your phone near the radio'), findsOneWidget);
      expect(find.text('3 seconds left'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Cancel'), findsOneWidget);
      expect(find.byIcon(Icons.close), findsOneWidget);
      expect(find.bySemanticsLabel('Cancel listening'), findsOneWidget);
      semantics.dispose();
    });

    test('the countdown counts seconds, with "1 second left" in the singular', () {
      expect(ListeningScreen.countdownText(8), '8 seconds left');
      expect(ListeningScreen.countdownText(3), '3 seconds left');
      expect(ListeningScreen.countdownText(1), '1 second left');
      expect(ListeningScreen.countdownText(0), '0 seconds left');
    });

    testWidgets('"Listening…" is a heading announced as a status', (tester) async {
      final semantics = tester.ensureSemantics();
      await _harness().pump(tester, _screen());
      expectStateHeading(tester, 'Listening…', SemanticsRole.status);
      semantics.dispose();
    });
  });

  group('the ring, the bars and the bar of time', () {
    testWidgets('a louder level gives a larger ring: scale = 1 + 0.15 × level', (tester) async {
      final harness = _harness();
      await harness.pump(tester, _screen(levelFraction: 0.2));
      expect(_ringScale(tester), closeTo(1.03, 0.0001));
      await harness.pump(tester, _screen(levelFraction: 0.8));
      expect(_ringScale(tester), closeTo(1.12, 0.0001));
      await tester.pump(const Duration(milliseconds: 150));
    });

    testWidgets('16 bars, the first round(level × 16) of them lit', (tester) async {
      await _harness().pump(tester, _screen(levelFraction: 0.5));
      expect(LevelBars.litBarCount(0.5), 8);
      final bars = tester.widgetList<DecoratedBox>(
        find.descendant(of: find.byType(LevelBars), matching: find.byType(DecoratedBox)),
      );
      expect(bars, hasLength(16));
    });

    testWidgets('the bar is 0.625 full with 3 of 8 seconds left', (tester) async {
      await _harness().pump(tester, _screen(secondsLeft: 3));
      expect(_progressFraction(tester), closeTo(0.625, 0.0001));
    });

    testWidgets('the bars, the ring and the bar of time are hidden from screen readers', (
      tester,
    ) async {
      await _harness().pump(tester, _screen());
      for (final type in [LevelBars, LevelRing, ProgressTrack]) {
        expect(
          find.descendant(of: find.byType(type), matching: find.byType(ExcludeSemantics)),
          findsWidgets,
          reason: '$type',
        );
      }
    });

    testWidgets('with animations off the ring changes at once and nothing is left to draw', (
      tester,
    ) async {
      disableAnimations(tester);
      final harness = _harness();
      await harness.pump(tester, _screen(levelFraction: 0.1));
      await harness.pump(tester, _screen(levelFraction: 0.9));
      final ring = tester.widget<AnimatedScale>(
        find.descendant(of: find.byType(LevelRing), matching: find.byType(AnimatedScale)),
      );
      expect(ring.duration, Duration.zero);
      await tester.pump();
      expect(tester.binding.hasScheduledFrame, isFalse);
    });

    testWidgets('with animations on the ring moves over motion.fast (150 ms)', (tester) async {
      await _harness().pump(tester, _screen());
      final ring = tester.widget<AnimatedScale>(
        find.descendant(of: find.byType(LevelRing), matching: find.byType(AnimatedScale)),
      );
      expect(ring.duration, const Duration(milliseconds: 150));
    });
  });

  group('every way out calls backToHome() (T12)', () {
    testWidgets('Close ×, "Cancel" and system Back', (tester) async {
      final harness = _harness();
      await harness.pump(tester, _screen());
      await tester.tap(find.byType(ScreenExitButton));
      await scrollToAndTap(tester, find.text('Cancel'));
      await pressSystemBack(tester);
      expect(harness.flow.calls, ['backToHome', 'backToHome', 'backToHome']);
    });
  });

  group('with the real flow', () {
    testWidgets(
      '"8 seconds left", then "3 seconds left" five seconds later, then "1 second left"',
      (tester) async {
        disableAnimations(tester);
        final harness = ListenerAppHarness();
        await harness.pumpApp(tester);
        await tester.tap(find.text('Tap to identify'));
        await harness.pumpTransition(tester);
        expect(find.text('8 seconds left'), findsOneWidget);

        await tester.pump(const Duration(seconds: 5));
        expect(find.text('3 seconds left'), findsOneWidget);
        expect(_progressFraction(tester), closeTo(0.625, 0.0001));

        await tester.pump(const Duration(seconds: 2));
        expect(find.text('1 second left'), findsOneWidget);
        // The levels the fake microphone gave reached the ring.
        expect(_ringScale(tester), greaterThan(1));
        harness.flow(tester).backToHome();
        await harness.pumpTransition(tester);
      },
    );

    for (final (wayOut, tap) in <(String, Future<void> Function(WidgetTester))>[
      ('Close ×', (tester) => tester.tap(find.byType(ScreenExitButton))),
      ('"Cancel"', (tester) => scrollToAndTap(tester, find.text('Cancel'))),
      ('system Back', pressSystemBack),
    ]) {
      testWidgets('$wayOut stops the recorder, sends nothing and shows Home', (tester) async {
        final harness = ListenerAppHarness();
        await harness.pumpApp(tester);
        await tester.tap(find.text('Tap to identify'));
        await harness.pumpTransition(tester);
        expect(harness.recorder.isRecording, isTrue);

        await tap(tester);
        await harness.pumpTransition(tester);
        expect(harness.location(tester), '/');
        expect(find.text(HomeScreen.heading), findsOneWidget);
        expect(harness.recorder.isRecording, isFalse);
        expect(harness.recorder.cancelCount, 1);
        expect(harness.recorder.clipFileNames, isEmpty);

        // The 8 seconds pass with nothing sent.
        await tester.pump(const Duration(seconds: 9));
        expect(harness.adapter.requests, isEmpty);
      });
    }
  });

  group('layout and accessibility (design §2.1, §4.3)', () {
    testWidgets('fits at 360 and 320 dp, text scale 1.0 and 2.0, with no technical text', (
      tester,
    ) async {
      await _harness().expectFitsEveryPhone(tester, _screen());
    });

    testWidgets('meets the tap target, label and contrast guidelines', (tester) async {
      final semantics = tester.ensureSemantics();
      await _harness().pump(tester, _screen());
      await expectMeetsTapGuidelines(tester);
      semantics.dispose();
    });
  });
}
