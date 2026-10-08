import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/reference_code_panel.dart';

import '../../../support/phone_screen.dart';
import 'identify_screen_harness.dart';

Widget _panel() => const Scaffold(
  body: Padding(
    padding: EdgeInsets.all(24),
    child: ReferenceCodePanel(referenceCode: '6F1C-2D3E'),
  ),
);

void main() {
  testWidgets('"Reference code" over the code in the monospace font, and "Copy"', (tester) async {
    await IdentifyScreenHarness().pump(tester, _panel());
    expect(find.text('Reference code'), findsOneWidget);
    final code = tester.widget<Text>(find.text('6F1C-2D3E'));
    expect(code.style!.fontFamily, 'monospace');
    expect(code.style!.fontFamilyFallback, ReferenceCodePanel.monospaceFontFallbacks);
    expect(code.style!.letterSpacing, 1);
    expect(find.widgetWithText(OutlinedButton, 'Copy'), findsOneWidget);
    expect(tester.getSize(find.byType(OutlinedButton)).height, greaterThanOrEqualTo(48));
  });

  testWidgets('"Copy" copies the code as shown and says "Code copied"', (tester) async {
    final harness = IdentifyScreenHarness();
    await harness.pump(tester, _panel());
    await tester.tap(find.text('Copy'));
    await tester.pump();
    expect(harness.clipboard.copiedTexts, ['6F1C-2D3E']);
    expect(find.text('Code copied'), findsOneWidget);
  });

  testWidgets('with "Remove animations", "Code copied" is in place on the first frame', (
    tester,
  ) async {
    disableAnimations(tester);
    final harness = IdentifyScreenHarness();
    await harness.pump(tester, _panel());
    await tester.tap(find.text('Copy'));
    // The copy finishes, then one frame.
    await tester.pump();
    await tester.pump();

    expect(harness.clipboard.copiedTexts, ['6F1C-2D3E']);
    expect(
      tester.widget<SnackBar>(find.byType(SnackBar)).animation!.status,
      AnimationStatus.completed,
    );
  });

  testWidgets('with animations on, "Code copied" slides in', (tester) async {
    final harness = IdentifyScreenHarness();
    await harness.pump(tester, _panel());
    await tester.tap(find.text('Copy'));
    await tester.pump();
    await tester.pump();

    expect(
      tester.widget<SnackBar>(find.byType(SnackBar)).animation!.status,
      AnimationStatus.forward,
    );
    await tester.pumpAndSettle();
  });

  testWidgets(
    'with animations on, "Code copied" slides in and out over motion.base (S4-ACCESSIBILITY-04)',
    (tester) async {
      const motion = LookUpMotion.standard;
      await IdentifyScreenHarness().pump(tester, _panel());
      await tester.tap(find.text('Copy'));
      await tester.pump();
      await tester.pump();

      final snackBarMotion =
          tester.widget<SnackBar>(find.byType(SnackBar)).animation! as AnimationController;
      expect(snackBarMotion.duration, motion.base);
      expect(snackBarMotion.reverseDuration, motion.base);
      // Still sliding half-way through, in place once motion.base is over.
      await tester.pump(motion.base ~/ 2);
      expect(snackBarMotion.status, AnimationStatus.forward);
      await tester.pump(motion.base);
      expect(snackBarMotion.status, AnimationStatus.completed);
      await tester.pumpAndSettle();
    },
  );

  for (final phoneScreen in PhoneScreen.layoutChecks) {
    testWidgets('fits on $phoneScreen, "Copy" moving under the code when needed', (tester) async {
      await IdentifyScreenHarness().pump(tester, _panel(), phoneScreen: phoneScreen);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('meets the tap target and label guidelines', (tester) async {
    final semantics = tester.ensureSemantics();
    await IdentifyScreenHarness().pump(tester, _panel());
    await expectMeetsTapGuidelines(tester);
    semantics.dispose();
  });
}
