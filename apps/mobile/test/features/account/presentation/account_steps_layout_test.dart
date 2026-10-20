import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../support/phone_screen.dart';
import '../support/open_account_step.dart';

/// The sign-up steps on a small phone with the keyboard open and large text (ADR-005; LA-APP-05, -13): nothing
/// overflows, each step's main button stays above the keyboard, and the form scrolls to what the listener must reach.
void main() {
  /// The gate, taken to [lastStep] by tapping and typing, on a 320 × 568 dp phone at 1.5 times text size with a 270 dp
  /// keyboard.
  Future<void> openStep(WidgetTester tester, {required int lastStep}) => openAccountStep(
    tester,
    step: AccountStepNumber.values[lastStep],
    phoneScreen: const PhoneScreen(width: 320, height: 568, textScale: 1.5, devicePixelRatio: 1),
    keyboardHeight: 270,
  );

  void expectAboveKeyboard(WidgetTester tester, Finder button) {
    final rect = tester.getRect(button);
    expect(rect.bottom, lessThanOrEqualTo(568 - 270), reason: 'the main button is above the keyboard');
    expect(rect.top, greaterThanOrEqualTo(0));
  }

  for (final (step, name, buttonText) in [
    (1, 'your email', 'Send me a code'),
    (2, 'the code', 'Check the code'),
    (3, 'about you', 'Create account'),
  ]) {
    testWidgets('$name: no overflow, and "$buttonText" is above the keyboard', (tester) async {
      await openStep(tester, lastStep: step);
      expect(tester.takeException(), isNull);
      expectAboveKeyboard(tester, find.widgetWithText(FilledButton, buttonText));
      await tester.tap(find.widgetWithText(FilledButton, buttonText), warnIfMissed: true);
    });
  }

  testWidgets('about you: scrolled to the end, the last control sits above the pinned button, which sits above the keyboard', (
    tester,
  ) async {
    await openStep(tester, lastStep: 3);
    // The first scroll view is the body; the second holds the footer.
    await tester.drag(find.byType(SingleChildScrollView).first, const Offset(0, -3000));
    await tester.pump();
    final consent = tester.getRect(find.byType(CheckboxListTile));
    final button = tester.getRect(find.widgetWithText(FilledButton, 'Create account'));
    expect(consent.bottom, lessThanOrEqualTo(button.top), reason: 'nothing the listener must tick hides behind the button');
    expect(button.bottom, lessThanOrEqualTo(568 - 270));
    expect(tester.takeException(), isNull);
  });

  for (final (lastStep, heading) in [(2, 'Enter the code'), (3, 'About you')]) {
    testWidgets('"$heading" opens at its top, with its heading in view, whatever the step before was scrolled to', (tester) async {
      await openStep(tester, lastStep: lastStep);
      expect(tester.getRect(find.text(heading)).top, inInclusiveRange(0, 568 - 270));
    });
  }

  testWidgets('about you: the age box can be scrolled to and typed in with the keyboard open', (tester) async {
    await openStep(tester, lastStep: 3);
    final age = find.widgetWithText(TextField, 'Your age');
    await tester.ensureVisible(age);
    await tester.pump();
    final top = tester.getRect(age).top;
    expect(top, inInclusiveRange(0, 568 - 270), reason: 'the age box starts above the keyboard');
    await tester.enterText(age, '34');
    expect(find.text('34'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
