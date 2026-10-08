import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/listening_screen.dart';
import 'package:lookup_listener/features/identify/presentation/permission_screen.dart';

import '../../../app/listener_app_harness.dart';
import 'identify_screen_harness.dart';

const List<MicrophoneAccess> _variants = [
  MicrophoneAccess.notAskedYet,
  MicrophoneAccess.refusedOnce,
  MicrophoneAccess.refusedForGood,
];

IdentifyScreenHarness _harnessFor(MicrophoneAccess access) =>
    IdentifyScreenHarness(state: PermissionNeededState(microphoneAccess: access));

void main() {
  group('wording (design §2.3)', () {
    testWidgets('as drawn when the app has never asked', (tester) async {
      await _harnessFor(
        MicrophoneAccess.notAskedYet,
      ).pump(tester, const PermissionScreen(microphoneAccess: MicrophoneAccess.notAskedYet));

      expect(find.text('Look Up needs your microphone'), findsOneWidget);
      expect(
        find.text(
          "We listen for a few seconds to recognise the ad on the radio. We don't keep the "
          'recording.',
        ),
        findsOneWidget,
      );
      expect(find.text('Only when you tap Identify — never in the background.'), findsOneWidget);
      expect(
        find.text('Radio stations see how many people used their buttons — never who you are.'),
        findsOneWidget,
      );
      // The offline promise would be false before Phase 6 (S4-D1).
      expect(find.textContaining('No signal?'), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Allow microphone'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Not now'), findsOneWidget);
      expect(find.text('Said no before?'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Open phone settings'), findsOneWidget);
      expect(find.text(PermissionScreen.refusedOnceNote), findsNothing);
      expect(find.text(PermissionScreen.refusedForGoodNote), findsNothing);
    });

    testWidgets('refused once: says so, and "Allow microphone" asks again', (tester) async {
      await _harnessFor(
        MicrophoneAccess.refusedOnce,
      ).pump(tester, const PermissionScreen(microphoneAccess: MicrophoneAccess.refusedOnce));

      expect(
        find.text(
          "You chose not to allow the microphone. Look Up can't identify an ad without it.",
        ),
        findsOneWidget,
      );
      expect(find.widgetWithText(FilledButton, 'Allow microphone'), findsOneWidget);
      expect(find.text('Said no before?'), findsOneWidget);
    });

    testWidgets('refused for good: points to the settings, which the main button opens', (
      tester,
    ) async {
      await _harnessFor(
        MicrophoneAccess.refusedForGood,
      ).pump(tester, const PermissionScreen(microphoneAccess: MicrophoneAccess.refusedForGood));

      expect(
        find.text(
          "The microphone is turned off for Look Up. You can turn it on in your phone's settings.",
        ),
        findsOneWidget,
      );
      expect(find.widgetWithText(FilledButton, 'Open phone settings'), findsOneWidget);
      expect(find.text('Allow microphone'), findsNothing);
      // The "Said no before?" line would repeat the main button.
      expect(find.text('Said no before?'), findsNothing);
      expect(find.text('Open phone settings'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Not now'), findsOneWidget);
    });

    testWidgets('the variant note is announced when it appears', (tester) async {
      final semantics = tester.ensureSemantics();
      await _harnessFor(
        MicrophoneAccess.refusedOnce,
      ).pump(tester, const PermissionScreen(microphoneAccess: MicrophoneAccess.refusedOnce));
      final note = tester.getSemantics(find.text(PermissionScreen.refusedOnceNote));
      expect(note.getSemanticsData().flagsCollection.isLiveRegion, isTrue);
      final heading = tester.getSemantics(find.text(PermissionScreen.heading));
      expect(heading.getSemanticsData().flagsCollection.isHeader, isTrue);
      semantics.dispose();
    });

    testWidgets('the ticks are hidden from screen readers', (tester) async {
      await _harnessFor(
        MicrophoneAccess.notAskedYet,
      ).pump(tester, const PermissionScreen(microphoneAccess: MicrophoneAccess.notAskedYet));
      expect(find.byIcon(Icons.check), findsNWidgets(2));
      expect(
        find.descendant(of: find.byType(ExcludeSemantics), matching: find.byIcon(Icons.check)),
        findsNWidgets(2),
      );
      // The microphone circle is decoration too.
      expect(
        find.descendant(of: find.byType(ExcludeSemantics), matching: find.byIcon(Icons.mic_none)),
        findsOneWidget,
      );
    });
  });

  group('each control calls the flow', () {
    testWidgets('"Allow microphone" asks through allowMicrophone()', (tester) async {
      final harness = _harnessFor(MicrophoneAccess.notAskedYet);
      await harness.pump(
        tester,
        const PermissionScreen(microphoneAccess: MicrophoneAccess.notAskedYet),
      );
      await tester.tap(find.text('Allow microphone'));
      expect(harness.flow.calls, ['allowMicrophone']);
    });

    testWidgets('refused for good, the main button opens the settings (T6)', (tester) async {
      final harness = _harnessFor(MicrophoneAccess.refusedForGood);
      await harness.pump(
        tester,
        const PermissionScreen(microphoneAccess: MicrophoneAccess.refusedForGood),
      );
      await scrollToAndTap(tester, find.widgetWithText(FilledButton, 'Open phone settings'));
      expect(harness.flow.calls, ['openPhoneSettings']);
    });

    testWidgets('"Open phone settings" in the footer line opens the settings (T6)', (tester) async {
      final harness = _harnessFor(MicrophoneAccess.refusedOnce);
      await harness.pump(
        tester,
        const PermissionScreen(microphoneAccess: MicrophoneAccess.refusedOnce),
      );
      await scrollToAndTap(tester, find.text('Open phone settings'));
      expect(harness.flow.calls, ['openPhoneSettings']);
    });

    testWidgets('Back, "Not now" and system Back go Home (T8)', (tester) async {
      final harness = _harnessFor(MicrophoneAccess.notAskedYet);
      await harness.pump(
        tester,
        const PermissionScreen(microphoneAccess: MicrophoneAccess.notAskedYet),
      );
      await tester.tap(find.byType(ScreenExitButton));
      await tester.tap(find.text('Not now'));
      await pressSystemBack(tester);
      expect(harness.flow.calls, ['backToHome', 'backToHome', 'backToHome']);
    });

    testWidgets('the Back arrow is labelled "Back"', (tester) async {
      final semantics = tester.ensureSemantics();
      await _harnessFor(
        MicrophoneAccess.notAskedYet,
      ).pump(tester, const PermissionScreen(microphoneAccess: MicrophoneAccess.notAskedYet));
      expect(find.bySemanticsLabel('Back'), findsOneWidget);
      semantics.dispose();
    });
  });

  group('with the real flow (S4-PERMISSION-01, -02)', () {
    testWidgets('no system prompt before "Allow microphone"; Back and "Not now" make none', (
      tester,
    ) async {
      final harness = ListenerAppHarness(microphoneAccess: MicrophoneAccess.notAskedYet);
      await harness.pumpApp(tester);

      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      expect(find.text(PermissionScreen.heading), findsOneWidget);
      await tester.tap(find.byType(ScreenExitButton));
      await harness.pumpTransition(tester);
      expect(find.text(HomeScreen.heading), findsOneWidget);

      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await tester.tap(find.text('Not now'));
      await harness.pumpTransition(tester);
      expect(find.text(HomeScreen.heading), findsOneWidget);
      expect(harness.permission.promptCount, 0);
      expect(harness.recorder.startedIdempotencyKeys, isEmpty);
    });

    testWidgets('allowed in the prompt → Listening (T3)', (tester) async {
      final harness = ListenerAppHarness(microphoneAccess: MicrophoneAccess.notAskedYet);
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await tester.tap(find.text('Allow microphone'));
      await harness.pumpTransition(tester);
      expect(harness.permission.promptCount, 1);
      expect(find.text(ListeningScreen.heading), findsOneWidget);
      harness.flow(tester).backToHome();
      await harness.pumpTransition(tester);
    });

    testWidgets('refused in the prompt → the refused-once variant (T4)', (tester) async {
      final harness = ListenerAppHarness(
        microphoneAccess: MicrophoneAccess.notAskedYet,
        answerToPrompt: MicrophoneAccess.refusedOnce,
      );
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await tester.tap(find.text('Allow microphone'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/permission');
      expect(find.text(PermissionScreen.refusedOnceNote), findsOneWidget);
    });

    testWidgets('refused for good → its variant, whose button opens the settings (T5, T6)', (
      tester,
    ) async {
      final harness = ListenerAppHarness(
        microphoneAccess: MicrophoneAccess.notAskedYet,
        answerToPrompt: MicrophoneAccess.refusedForGood,
      );
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await tester.tap(find.text('Allow microphone'));
      await harness.pumpTransition(tester);
      expect(find.text(PermissionScreen.refusedForGoodNote), findsOneWidget);

      await scrollToAndTap(tester, find.widgetWithText(FilledButton, 'Open phone settings'));
      expect(harness.permission.settingsOpenCount, 1);
      expect(harness.permission.promptCount, 1);
      expect(harness.location(tester), '/permission');
    });
  });

  group('layout and accessibility (design §2.1, §4.3)', () {
    for (final access in _variants) {
      testWidgets('${access.name}: fits at 360 and 320 dp, text scale 1.0 and 2.0', (tester) async {
        await _harnessFor(
          access,
        ).expectFitsEveryPhone(tester, PermissionScreen(microphoneAccess: access));
      });

      testWidgets('${access.name}: meets the tap target, label and contrast guidelines', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await _harnessFor(access).pump(tester, PermissionScreen(microphoneAccess: access));
        await expectMeetsTapGuidelines(tester);
        semantics.dispose();
      });
    }
  });
}
