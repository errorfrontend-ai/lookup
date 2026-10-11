import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/busy_screen.dart';
import 'package:lookup_listener/features/identify/presentation/progress_track.dart';

import '../../../app/listener_app_harness.dart';
import 'identify_screen_harness.dart';
import '../../../support/english_words.dart';

IdentifyScreenHarness _harness() =>
    IdentifyScreenHarness(state: const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 12));

BusyScreen _screen({int secondsUntilRetry = 12}) =>
    BusyScreen(retryDelaySeconds: 12, secondsUntilRetry: secondsUntilRetry);

double _waitedFraction(WidgetTester tester) => tester
    .widget<FractionallySizedBox>(
      find.descendant(of: find.byType(ProgressTrack), matching: find.byType(FractionallySizedBox)),
    )
    .widthFactor!;

/// Starts the app and gets a 503 with `Retry-After: 12` for the first clip, so Busy shows "12 s".
/// Animations are off, so the fake clock moves only when the test says.
Future<ListenerAppHarness> _showBusy(WidgetTester tester) async {
  disableAnimations(tester);
  final harness = ListenerAppHarness()
    ..answerWithEnvelopeFixture('recognition-busy', retryAfter: '12');
  await harness.pumpApp(tester);
  await tester.tap(find.text('Tap to identify'));
  await harness.pumpTransition(tester);
  await harness.recordWholeClip(tester);
  expect(harness.location(tester), '/busy');
  return harness;
}

void main() {
  group('wording (design §2.9)', () {
    testWidgets('the heading, the explanation, "Trying again in 12 s" and the buttons', (
      tester,
    ) async {
      await _harness().pump(tester, _screen());
      expect(find.text('Lots of people are listening right now'), findsOneWidget);
      expect(
        find.text(
          "We kept your clip and will try again automatically. You don't need to record again.",
        ),
        findsOneWidget,
      );
      expect(find.text('Trying again in'), findsOneWidget);
      expect(find.text('12 s'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Try now'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Cancel'), findsOneWidget);
      expect(find.byIcon(Icons.refresh), findsOneWidget);
    });

    testWidgets('a refresh icon in the warning colour, in a warning-soft circle (S4-BUSY-03)', (
      tester,
    ) async {
      await _harness().pump(tester, _screen());
      const colours = LookUpColours.light;
      expectStateIcon(
        tester,
        icon: Icons.refresh,
        iconColour: colours.warning,
        circleColour: colours.warningSoft,
      );
    });

    testWidgets('the countdown uses tabular figures, and screen readers hear "12 seconds"', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await _harness().pump(tester, _screen());
      final countdown = tester.widget<Text>(find.text('12 s'));
      expect(countdown.style!.fontFeatures, contains(const FontFeature.tabularFigures()));
      expect(countdown.semanticsLabel, '12 seconds');
      expect(englishWords.busyCountdownSpoken(1), '1 second');
      semantics.dispose();
    });

    testWidgets('the heading is a status, and the countdown panel a polite live region', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await _harness().pump(tester, _screen());
      expectStateHeading(tester, 'Lots of people are listening right now', SemanticsRole.status);
      final panel = tester.getSemantics(find.text('Trying again in'));
      expect(panel.getSemanticsData().flagsCollection.isLiveRegion, isTrue);
      expect(panel.getSemanticsData().label, contains('12 seconds'));
      semantics.dispose();
    });

    testWidgets('the bar shows how much of the wait has passed', (tester) async {
      final harness = _harness();
      await harness.pump(tester, _screen(secondsUntilRetry: 12));
      expect(_waitedFraction(tester), 0);
      await harness.pump(tester, _screen(secondsUntilRetry: 6));
      expect(_waitedFraction(tester), closeTo(0.5, 0.0001));
      await harness.pump(tester, _screen(secondsUntilRetry: 0));
      expect(_waitedFraction(tester), 1);
    });
  });

  group('each control calls the flow', () {
    testWidgets('"Try now" calls tryNow() (T32)', (tester) async {
      final harness = _harness();
      await harness.pump(tester, _screen());
      await scrollToAndTap(tester, find.text('Try now'));
      expect(harness.flow.calls, ['tryNow']);
    });

    testWidgets('"Cancel", the × labelled "Close" and system Back call backToHome() (T33, '
        'S4-ACCESSIBILITY-11)', (tester) async {
      final semantics = tester.ensureSemantics();
      final harness = _harness();
      await harness.pump(tester, _screen());
      await scrollToAndTap(tester, find.text('Cancel'));
      // Found by what a screen reader announces, so the label is proven to be "Close".
      expect(find.bySemanticsLabel('Close'), findsOneWidget);
      await scrollToAndTap(tester, find.bySemanticsLabel('Close'));
      await pressSystemBack(tester);
      expect(harness.flow.calls, ['backToHome', 'backToHome', 'backToHome']);
      semantics.dispose();
    });
  });

  group('with the real flow', () {
    testWidgets('"12 s", then "11 s" a second later, the bar growing; at zero the clip is resent', (
      tester,
    ) async {
      final harness = await _showBusy(tester);
      expect(find.text('12 s'), findsOneWidget);
      expect(_waitedFraction(tester), 0);
      expect(find.text(ListenerAppHarness.envelopeMessage('recognition-busy')), findsNothing);

      await tester.pump(const Duration(seconds: 1));
      expect(find.text('11 s'), findsOneWidget);
      expect(_waitedFraction(tester), closeTo(1 / 12, 0.0001));
      expect(harness.recognizeRequests, hasLength(1));

      harness.answerWithResponseFixture('valid/no-match');
      await tester.pump(const Duration(seconds: 11));
      await harness.pumpTransition(tester);
      expect(harness.recognizeRequests, hasLength(2));
      expect(harness.sentIdempotencyKeys[1], harness.sentIdempotencyKeys[0]);
      expect(harness.location(tester), '/no-match');
    });

    testWidgets('"Try now" sends at once, and no second send follows', (tester) async {
      final harness = await _showBusy(tester);
      harness.answerWithResponseFixture('valid/no-match');
      await scrollToAndTap(tester, find.text('Try now'));
      await harness.pumpTransition(tester);
      expect(harness.recognizeRequests, hasLength(2));
      expect(harness.location(tester), '/no-match');

      await tester.pump(const Duration(seconds: 13));
      expect(harness.recognizeRequests, hasLength(2));
    });

    testWidgets('"Cancel" sends nothing more and keeps no clip', (tester) async {
      final harness = await _showBusy(tester);
      await scrollToAndTap(tester, find.text('Cancel'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/');
      expect(find.text(englishWords.homeHeading), findsOneWidget);
      expect(harness.flow(tester).hasKeptClip, isFalse);
      expect(harness.recorder.clipFileNames, isEmpty);

      await tester.pump(const Duration(seconds: 13));
      expect(harness.recognizeRequests, hasLength(1));
    });
  });

  group('layout and accessibility (design §2.1, §4.3)', () {
    testWidgets('fits at 360 and 320 dp, text scale 1.0 and 2.0, with no technical text', (
      tester,
    ) async {
      await _harness().expectFitsEveryPhone(tester, _screen());
    });

    testWidgets('a 60-second wait fits too', (tester) async {
      await _harness().expectFitsEveryPhone(
        tester,
        const BusyScreen(retryDelaySeconds: 60, secondsUntilRetry: 60),
      );
    });

    testWidgets('meets the tap target, label and contrast guidelines', (tester) async {
      final semantics = tester.ensureSemantics();
      await _harness().pump(tester, _screen());
      await expectMeetsTapGuidelines(tester);
      semantics.dispose();
    });
  });
}
