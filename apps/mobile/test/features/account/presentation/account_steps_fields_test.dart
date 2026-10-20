import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../support/expect_no_technical_text.dart';
import '../support/open_account_step.dart';

/// What each field of the sign-up steps asks of the phone's keyboard, the consent sheet, and the app's accessibility
/// guidelines over the gate and every step in both themes (ADR-005; LA-APP-03 to -05, -13; LA-PRIVACY-03).
void main() {
  TextField onlyTextField(WidgetTester tester) => tester.widget<TextField>(find.byType(TextField));

  testWidgets('the email box asks for the email keyboard and the phone\'s saved addresses, with no autocorrect', (tester) async {
    await openAccountStep(tester, step: AccountStepNumber.email);
    final field = onlyTextField(tester);
    expect(field.keyboardType, TextInputType.emailAddress);
    expect(field.autofillHints, [AutofillHints.email]);
    expect(field.autocorrect, isFalse);
    expect(field.enableSuggestions, isFalse);
  });

  testWidgets('the code box asks for the number keyboard and the code from the text message or email, and takes six digits only', (tester) async {
    await openAccountStep(tester, step: AccountStepNumber.code);
    final field = onlyTextField(tester);
    expect(field.keyboardType, TextInputType.number);
    expect(field.autofillHints, [AutofillHints.oneTimeCode]);
    await tester.enterText(find.byType(TextField), '12ab34 5678');
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, '123456');
  });

  testWidgets('the age box takes two digits only', (tester) async {
    await openAccountStep(tester, step: AccountStepNumber.aboutYou);
    await tester.enterText(find.widgetWithText(TextField, 'Your age'), '4x25');
    expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Your age')).controller!.text, '42');
  });

  group('the consent sheet', () {
    testWidgets('"How we use this" opens it with what is kept and who sees what, and closing it leaves the form as it was', (tester) async {
      await openAccountStep(tester, step: AccountStepNumber.aboutYou);
      await tester.tap(find.text('Female'));
      await tester.enterText(find.widgetWithText(TextField, 'Your age'), '34');
      await tester.ensureVisible(find.byType(Checkbox));
      await tester.pump();
      await tester.tap(find.byType(Checkbox));
      await tester.pump();
      await tester.ensureVisible(find.text('How we use this'));
      await tester.pump();
      await tester.tap(find.text('How we use this'));
      await tester.pumpAndSettle();
      expect(find.text('How we use your details'), findsOneWidget);
      expect(find.textContaining('never shown to a station or an advertiser'), findsOneWidget, reason: 'the sheet says who sees the email');
      expect(find.textContaining('at least 10 listeners'), findsOneWidget, reason: 'and the smallest group a station sees');
      expect(find.textContaining('delete your account in Settings'), findsOneWidget, reason: 'and where to leave');
      expectNoTechnicalText(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Close'));
      await tester.pumpAndSettle();
      expect(tester.widget<Checkbox>(find.byType(Checkbox)).value, isTrue);
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Your age')).controller!.text, '34');
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Create account')).onPressed, isNotNull);
    });

    testWidgets('with no gender, no age or no tick the button stays off, and nothing is sent', (tester) async {
      final harness = await openAccountStep(tester, step: AccountStepNumber.aboutYou);
      final requestsBefore = harness.adapter.requests.length;
      Finder button() => find.widgetWithText(FilledButton, 'Create account');
      expect(tester.widget<FilledButton>(button()).onPressed, isNull);
      await tester.tap(find.text('Male'));
      await tester.enterText(find.widgetWithText(TextField, 'Your age'), '34');
      await tester.pump();
      expect(tester.widget<FilledButton>(button()).onPressed, isNull, reason: 'gender and age, but no tick');
      await tester.tap(button(), warnIfMissed: false);
      await tester.pump();
      expect(harness.adapter.requests.length, requestsBefore);
    });
  });

  group('the app\'s accessibility guidelines', () {
    for (final brightness in Brightness.values) {
      for (final step in AccountStepNumber.values) {
        testWidgets('hold on the ${step.name} step in the ${brightness.name} theme', (tester) async {
          final semantics = tester.ensureSemantics();
          await openAccountStep(tester, step: step, brightness: brightness);
          await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
          await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
          await expectLater(tester, meetsGuideline(textContrastGuideline));
          semantics.dispose();
        });
      }
    }
  });
}
