import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/identify_button.dart';
import 'package:lookup_listener/features/identify/presentation/listening_screen.dart';
import 'package:lookup_listener/features/identify/presentation/permission_screen.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/send_test_error_button.dart';

import '../../../app/listener_app_harness.dart';
import 'identify_screen_harness.dart';

/// A development build with the developer tools on, as config/development-fake.json makes it.
AppConfiguration _developmentWithTools() => AppConfiguration(
  flavour: AppFlavour.development,
  apiBaseUrl: Uri.parse('http://10.0.2.2:3999/api/v1'),
  showsDeveloperTools: true,
);

void main() {
  group('wording (design §2.2)', () {
    testWidgets('"Look Up", the heading as a heading, the instruction and the data note', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await IdentifyScreenHarness().pump(tester, const HomeScreen());

      expect(find.text('Look Up'), findsOneWidget);
      expect(find.text('Heard an ad on the radio?'), findsOneWidget);
      final headingData = tester
          .getSemantics(find.text('Heard an ad on the radio?'))
          .getSemanticsData();
      expect(headingData.flagsCollection.isHeader, isTrue);
      expect(
        find.text('Tap the button and hold your phone near the radio while the ad plays.'),
        findsOneWidget,
      );
      expect(find.text('About 8 seconds of listening · about 25 KB of data'), findsOneWidget);
      semantics.dispose();
    });

    test('the "8" in the data note comes from the clip settings (S4-LISTENING-03)', () {
      final seconds = RecognitionFlow.clipSettings.clipDurationSeconds;
      expect(seconds, 8);
      expect(HomeScreen.dataNote, startsWith('About $seconds seconds of listening'));
    });

    testWidgets('no station chip, no bottom navigation, no History or Settings (S4-D1)', (
      tester,
    ) async {
      await IdentifyScreenHarness().pump(tester, const HomeScreen());
      expect(find.textContaining('My station'), findsNothing);
      expect(find.text('History'), findsNothing);
      expect(find.text('Settings'), findsNothing);
      expect(find.byType(NavigationBar), findsNothing);
      expect(find.byType(BottomNavigationBar), findsNothing);
    });
  });

  group('the identify control', () {
    testWidgets('one primary control, "Tap to identify", with the microphone and two rings', (
      tester,
    ) async {
      await IdentifyScreenHarness().pump(tester, const HomeScreen());

      expect(find.byType(IdentifyButton), findsOneWidget);
      expect(find.text('Tap to identify'), findsOneWidget);
      expect(
        find.descendant(of: find.byType(IdentifyButton), matching: find.byIcon(Icons.mic_none)),
        findsOneWidget,
      );
      final halo = tester.widget<DecoratedBox>(
        find.descendant(of: find.byType(IdentifyButton), matching: find.byType(DecoratedBox)).first,
      );
      expect((halo.decoration as BoxDecoration).boxShadow, hasLength(2));
      // 200 dp across, the wireframe's disc.
      final disc = find.descendant(of: find.byType(IdentifyButton), matching: find.byType(InkWell));
      expect(tester.getSize(disc), const Size(200, 200));
      // Nothing else on Home is a filled or outlined button.
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byType(OutlinedButton), findsNothing);
    });

    testWidgets('sits below the middle of a 360 × 800 screen, in the thumb zone', (tester) async {
      await IdentifyScreenHarness().pump(tester, const HomeScreen());
      expect(tester.getCenter(find.byType(IdentifyButton)).dy, greaterThan(800 / 2));
    });

    testWidgets('screen readers hear "Identify the ad playing now", a button with a tap', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await IdentifyScreenHarness().pump(tester, const HomeScreen());
      expect(
        tester.getSemantics(find.byType(IdentifyButton)),
        isSemantics(label: 'Identify the ad playing now', isButton: true, hasTapAction: true),
      );
      expect(find.bySemanticsLabel('Tap to identify'), findsNothing);
      semantics.dispose();
    });

    testWidgets('a tap calls identify() on the flow', (tester) async {
      final harness = IdentifyScreenHarness();
      await harness.pump(tester, const HomeScreen());
      await tester.tap(find.text('Tap to identify'));
      expect(harness.flow.calls, ['identify']);
    });

    testWidgets('with the microphone allowed, a tap starts Listening (T1)', (tester) async {
      final harness = ListenerAppHarness();
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/listening');
      expect(find.text(ListeningScreen.heading), findsOneWidget);
      expect(harness.permission.promptCount, 0);
      harness.flow(tester).backToHome();
      await harness.pumpTransition(tester);
    });

    testWidgets('without the microphone, a tap shows Permission and no system prompt (T2)', (
      tester,
    ) async {
      final harness = ListenerAppHarness(microphoneAccess: MicrophoneAccess.notAskedYet);
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/permission');
      expect(find.text(PermissionScreen.heading), findsOneWidget);
      expect(harness.permission.promptCount, 0);
      expect(harness.recorder.startedIdempotencyKeys, isEmpty);
    });
  });

  group('"Send a test error" (S4-D26)', () {
    testWidgets('is not on Home in a production build', (tester) async {
      await IdentifyScreenHarness().pump(tester, const HomeScreen());
      expect(find.text(SendTestErrorButton.label), findsNothing);
    });

    testWidgets('is on Home in a development build with the developer tools, and throws', (
      tester,
    ) async {
      final harness = IdentifyScreenHarness(configuration: _developmentWithTools());
      await harness.pump(tester, const HomeScreen());
      expect(find.text(SendTestErrorButton.label), findsOneWidget);

      await tester.tap(find.text(SendTestErrorButton.label));
      final thrown = tester.takeException();
      expect(thrown, isA<StateError>());
      expect((thrown as StateError).message, SendTestErrorButton.errorDescription);
      expect(harness.flow.calls, isEmpty);
    });
  });

  group('layout and accessibility (design §2.1, §4.3)', () {
    testWidgets('fits at 360 and 320 dp, text scale 1.0 and 2.0, with no technical text', (
      tester,
    ) async {
      await IdentifyScreenHarness().expectFitsEveryPhone(tester, const HomeScreen());
    });

    testWidgets('fits with the developer control too', (tester) async {
      final harness = IdentifyScreenHarness(configuration: _developmentWithTools());
      await harness.expectFitsEveryPhone(tester, const HomeScreen());
    });

    testWidgets('meets the tap target, label and contrast guidelines', (tester) async {
      final semantics = tester.ensureSemantics();
      await IdentifyScreenHarness(
        configuration: _developmentWithTools(),
      ).pump(tester, const HomeScreen());
      await expectMeetsTapGuidelines(tester);
      semantics.dispose();
    });

    testWidgets('an accent disc 200 dp across, the 56 dp microphone and "Tap to identify" in '
        'on-accent, inside two soft rings 12 and 28 dp wide (S4-HOME-06, -07)', (tester) async {
      await IdentifyScreenHarness().pump(tester, const HomeScreen());
      const colours = LookUpColours.light;
      final control = find.byType(IdentifyButton);

      final disc = tester.widget<Material>(
        find.descendant(of: control, matching: find.byType(Material)).first,
      );
      expect(disc.color, colours.accent);
      expect(disc.shape, isA<CircleBorder>());
      expect(
        tester.getSize(find.descendant(of: control, matching: find.byType(InkWell))),
        const Size.square(200),
      );
      final microphone = tester.widget<Icon>(
        find.descendant(of: control, matching: find.byIcon(Icons.mic_none)),
      );
      expect(microphone.size, 56);
      expect(microphone.color, colours.onAccent);
      expect(tester.widget<Text>(find.text('Tap to identify')).style!.color, colours.onAccent);

      final rings = tester.widget<DecoratedBox>(
        find.descendant(of: control, matching: find.byType(DecoratedBox)).first,
      );
      final ringDecoration = rings.decoration as BoxDecoration;
      expect(ringDecoration.shape, BoxShape.circle);
      expect(ringDecoration.boxShadow!.map((ring) => ring.spreadRadius), [28, 12]);
      expect(ringDecoration.boxShadow!.map((ring) => ring.color), [
        colours.accentSoft.withValues(alpha: 0.5),
        colours.accentSoft,
      ]);
      expect(ringDecoration.boxShadow!.map((ring) => ring.blurRadius), [0, 0]);
    });

    testWidgets('the halo colours come from the tokens', (tester) async {
      await IdentifyScreenHarness().pump(tester, const HomeScreen());
      final halo = tester.widget<DecoratedBox>(
        find.descendant(of: find.byType(IdentifyButton), matching: find.byType(DecoratedBox)).first,
      );
      final shadows = (halo.decoration as BoxDecoration).boxShadow!;
      const colours = LookUpColours.light;
      expect(shadows.last.color, colours.accentSoft);
      expect(shadows.first.color, colours.accentSoft.withValues(alpha: 0.5));
    });
  });
}
