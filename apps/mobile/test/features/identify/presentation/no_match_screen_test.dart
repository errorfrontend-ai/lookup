import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/listening_screen.dart';
import 'package:lookup_listener/features/identify/presentation/no_match_screen.dart';

import '../../../app/listener_app_harness.dart';
import 'identify_screen_harness.dart';

IdentifyScreenHarness _harness() => IdentifyScreenHarness(state: const NoMatchState());

const List<String> _tips = [
  'Turn the radio up, or move your phone closer.',
  'Tap while the ad is playing — not during music or talk.',
  'Step away from traffic or other noise if you can.',
];

void main() {
  group('wording (design §2.8)', () {
    testWidgets('the heading, the explanation, "Try this", the three tips and the buttons', (
      tester,
    ) async {
      await _harness().pump(tester, const NoMatchScreen());
      expect(find.text("We couldn't recognise that"), findsOneWidget);
      expect(
        find.text('It may not be an ad we know yet, or it was too noisy to hear clearly.'),
        findsOneWidget,
      );
      expect(find.text('Try this'), findsOneWidget);
      final tipTops = [for (final tip in _tips) tester.getTopLeft(find.text(tip)).dy];
      expect(tipTops[0], lessThan(tipTops[1]));
      expect(tipTops[1], lessThan(tipTops[2]));
      expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Back to home'), findsOneWidget);
      expect(find.byIcon(Icons.search), findsOneWidget);
    });

    testWidgets('the heading is announced as a status', (tester) async {
      final semantics = tester.ensureSemantics();
      await _harness().pump(tester, const NoMatchScreen());
      expectStateHeading(tester, "We couldn't recognise that", SemanticsRole.status);
      expect(
        tester.getSemantics(find.text('Try this')).getSemanticsData().flagsCollection.isHeader,
        isTrue,
      );
      semantics.dispose();
    });

    testWidgets('the tips are a list of three items, read without the drawn numbers', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await _harness().pump(tester, const NoMatchScreen());
      for (final tip in _tips) {
        final item = tester.getSemantics(find.text(tip));
        expect(item.getSemanticsData().role, SemanticsRole.listItem);
        expect(item.getSemanticsData().label, tip);
        expect(item.parent!.getSemanticsData().role, SemanticsRole.list);
      }
      expect(find.bySemanticsLabel(RegExp(r'^[123]$')), findsNothing);
      for (final number in ['1', '2', '3']) {
        expect(
          find.descendant(of: find.byType(ExcludeSemantics), matching: find.text(number)),
          findsOneWidget,
        );
      }
      semantics.dispose();
    });
  });

  group('each control calls the flow', () {
    testWidgets('"Try again" calls tryAgain() (T36)', (tester) async {
      final harness = _harness();
      await harness.pump(tester, const NoMatchScreen());
      await scrollToAndTap(tester, find.text('Try again'));
      expect(harness.flow.calls, ['tryAgain']);
    });

    testWidgets('"Back to home", Close × and system Back call backToHome() (T38)', (tester) async {
      final harness = _harness();
      await harness.pump(tester, const NoMatchScreen());
      await scrollToAndTap(tester, find.text('Back to home'));
      await scrollToAndTap(tester, find.byType(ScreenExitButton));
      await pressSystemBack(tester);
      expect(harness.flow.calls, ['backToHome', 'backToHome', 'backToHome']);
    });

    testWidgets('with the real flow, no match → "Try again" → Listening, with a new key', (
      tester,
    ) async {
      final harness = ListenerAppHarness()..answerWithResponseFixture('valid/no-match');
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await harness.recordWholeClip(tester);
      expect(harness.location(tester), '/no-match');
      expect(find.text(NoMatchScreen.heading), findsOneWidget);

      await scrollToAndTap(tester, find.text('Try again'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/listening');
      expect(find.text(ListeningScreen.heading), findsOneWidget);
      final keys = harness.recorder.startedIdempotencyKeys;
      expect(keys, hasLength(2));
      expect(keys[1], isNot(keys[0]));
      harness.flow(tester).backToHome();
      await harness.pumpTransition(tester);
    });
  });

  group('layout and accessibility (design §2.1, §4.3)', () {
    testWidgets('fits at 360 and 320 dp, text scale 1.0 and 2.0, with no technical text', (
      tester,
    ) async {
      await _harness().expectFitsEveryPhone(tester, const NoMatchScreen());
    });

    testWidgets('meets the tap target, label and contrast guidelines', (tester) async {
      final semantics = tester.ensureSemantics();
      await _harness().pump(tester, const NoMatchScreen());
      await expectMeetsTapGuidelines(tester);
      semantics.dispose();
    });
  });
}
