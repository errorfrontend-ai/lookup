import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/presentation/launch_failure_sheet.dart';

import '../../../support/expect_no_technical_text.dart';
import '../../../support/phone_screen.dart';
import '../../identify/presentation/identify_screen_harness.dart' show disableAnimations;
import '../support/result_screen_harness.dart';

const String _mapAddress =
    'https://www.google.com/maps/dir/?api=1&destination=-15.416700%2C28.283300';

/// A screen with one button that opens the sheet, as a failed launch does.
Widget _screenThatOpens(CopyOffer offer) {
  return Scaffold(
    body: Builder(
      builder: (context) => Center(
        child: TextButton(
          onPressed: () => LaunchFailureSheet.show(context, offer),
          child: const Text('Open the sheet'),
        ),
      ),
    ),
  );
}

Future<void> _openSheet(
  WidgetTester tester,
  ResultScreenHarness harness,
  CopyOffer offer, {
  PhoneScreen phoneScreen = PhoneScreen.standard,
}) async {
  await harness.pump(tester, _screenThatOpens(offer), phoneScreen: phoneScreen);
  await tester.tap(find.text('Open the sheet'));
  await tester.pumpAndSettle();
}

void main() {
  group('a call or WhatsApp number', () {
    const offer = PhoneNumberCopyOffer(phoneNumberE164: '+260977123456');

    testWidgets('shows the wording and the number in its +260 display form', (tester) async {
      await _openSheet(tester, ResultScreenHarness(), offer);

      expect(find.text("Couldn't open this"), findsOneWidget);
      expect(
        find.text("Your phone couldn't open it. You can copy the number instead."),
        findsOneWidget,
      );
      expect(find.text('+260 97 712 3456'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Copy number'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Close'), findsOneWidget);
      expect(find.text('Copy link'), findsNothing);
      expectNoTechnicalText(tester);
    });

    testWidgets('"Copy number" copies the E.164 form, closes, and says "Number copied"', (
      tester,
    ) async {
      final harness = ResultScreenHarness();
      await _openSheet(tester, harness, offer);

      await tester.tap(find.text('Copy number'));
      await tester.pumpAndSettle();

      expect(harness.clipboard.copiedTexts, ['+260977123456']);
      expect(find.byType(LaunchFailureSheet), findsNothing);
      expect(find.widgetWithText(SnackBar, 'Number copied'), findsOneWidget);
    });

    testWidgets('a number from another country is shown as stored', (tester) async {
      await _openSheet(
        tester,
        ResultScreenHarness(),
        const PhoneNumberCopyOffer(phoneNumberE164: '+27821234567'),
      );
      expect(find.text('+27821234567'), findsOneWidget);
    });

    testWidgets('a clipboard that refuses: no false "copied", and the sheet stays', (tester) async {
      final harness = ResultScreenHarness(clipboardAccepts: false);
      await _openSheet(tester, harness, offer);

      await tester.tap(find.text('Copy number'));
      await tester.pumpAndSettle();

      expect(find.text('Number copied'), findsNothing);
      expect(find.byType(LaunchFailureSheet), findsOneWidget);
    });
  });

  group('a map or link address', () {
    const offer = LinkCopyOffer(address: _mapAddress);

    testWidgets('shows the link wording, and no number', (tester) async {
      await _openSheet(tester, ResultScreenHarness(), offer);

      expect(find.text("Couldn't open this"), findsOneWidget);
      expect(
        find.text("Your phone couldn't open it. You can copy the link instead."),
        findsOneWidget,
      );
      expect(find.widgetWithText(FilledButton, 'Copy link'), findsOneWidget);
      expect(find.text('Copy number'), findsNothing);
      expect(find.textContaining('+260'), findsNothing);
    });

    testWidgets('"Copy link" copies the built address and says "Link copied"', (tester) async {
      final harness = ResultScreenHarness();
      await _openSheet(tester, harness, offer);

      await tester.tap(find.text('Copy link'));
      await tester.pumpAndSettle();

      expect(harness.clipboard.copiedTexts, [_mapAddress]);
      expect(find.widgetWithText(SnackBar, 'Link copied'), findsOneWidget);
    });
  });

  testWidgets('"Close" closes the sheet and copies nothing', (tester) async {
    final harness = ResultScreenHarness();
    await _openSheet(tester, harness, const PhoneNumberCopyOffer(phoneNumberE164: '+260977123456'));

    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();

    expect(find.byType(LaunchFailureSheet), findsNothing);
    expect(harness.clipboard.copiedTexts, isEmpty);
    expect(find.byType(SnackBar), findsNothing);
  });

  testWidgets('the heading is a heading; the buttons meet the tap and label guidelines', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await _openSheet(
      tester,
      ResultScreenHarness(),
      const PhoneNumberCopyOffer(phoneNumberE164: '+260977123456'),
    );

    expect(tester.getSemantics(find.text("Couldn't open this")), isSemantics(isHeader: true));
    final copy = tester.getRect(find.widgetWithText(FilledButton, 'Copy number'));
    final close = tester.getRect(find.widgetWithText(TextButton, 'Close'));
    expect(copy.height, greaterThanOrEqualTo(52));
    expect(close.height, greaterThanOrEqualTo(48));
    expect(close.top - copy.bottom, 8);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    semantics.dispose();
  });

  for (final screen in PhoneScreen.layoutChecks) {
    testWidgets('fits on $screen, scrolling when the text is large', (tester) async {
      await _openSheet(
        tester,
        ResultScreenHarness(),
        const PhoneNumberCopyOffer(phoneNumberE164: '+260977123456'),
        phoneScreen: screen,
      );
      expect(tester.takeException(), isNull);

      await tester.ensureVisible(find.text('Close'));
      await tester.pumpAndSettle();
      expect(tester.getRect(find.text('Close')).bottom, lessThanOrEqualTo(screen.height));
      expectNoClippedText(tester);
    });
  }

  group('"Remove animations" (design §4.3)', () {
    const offer = PhoneNumberCopyOffer(phoneNumberE164: '+260977123456');

    testWidgets('the sheet is in place on the first frame, with no slide', (tester) async {
      disableAnimations(tester);
      await ResultScreenHarness().pump(tester, _screenThatOpens(offer));
      await tester.tap(find.text('Open the sheet'));
      await tester.pump();

      final sheetRoute = ModalRoute.of(tester.element(find.byType(LaunchFailureSheet)))!;
      expect(sheetRoute.animation!.status, AnimationStatus.completed);
    });

    testWidgets('"Number copied" is in place on the first frame, and the sheet is gone', (
      tester,
    ) async {
      disableAnimations(tester);
      final harness = ResultScreenHarness();
      await harness.pump(tester, _screenThatOpens(offer));
      await tester.tap(find.text('Open the sheet'));
      await tester.pump();
      await tester.tap(find.text('Copy number'));
      // The copy finishes, then one frame.
      await tester.pump();
      await tester.pump();

      expect(harness.clipboard.copiedTexts, ['+260977123456']);
      expect(find.byType(LaunchFailureSheet), findsNothing);
      final snackBar = tester.widget<SnackBar>(find.byType(SnackBar));
      expect(snackBar.animation!.status, AnimationStatus.completed);
    });

    testWidgets('with animations on, the sheet and the snackbar still slide', (tester) async {
      final harness = ResultScreenHarness();
      await harness.pump(tester, _screenThatOpens(offer));
      await tester.tap(find.text('Open the sheet'));
      await tester.pump();
      final sheetRoute = ModalRoute.of(tester.element(find.byType(LaunchFailureSheet)))!;
      expect(sheetRoute.animation!.status, AnimationStatus.forward);

      await tester.pumpAndSettle();
      await tester.tap(find.text('Copy number'));
      await tester.pump();
      await tester.pump();
      expect(
        tester.widget<SnackBar>(find.byType(SnackBar)).animation!.status,
        AnimationStatus.forward,
      );
      await tester.pumpAndSettle();
    });
  });
}
