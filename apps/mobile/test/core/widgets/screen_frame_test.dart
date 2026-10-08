import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';

import '../../support/phone_screen.dart';

const String _longBody =
    'We listen for a few seconds to recognise the ad on the radio. We don\'t keep the recording. '
    'Only when you tap Identify — never in the background. Radio stations see how many people '
    'used their buttons — never who you are. Keep your phone near the radio while the ad plays, '
    'and turn the radio up if it is quiet.';

/// A screen shaped like Error and No match: Close, a body, a primary and a secondary action.
Widget _errorShapedScreen({VoidCallback? onClose, String bodyText = 'Please try again.'}) {
  return ScreenFrame(
    exitButton: ScreenExitButton.close(label: 'Close', onPressed: onClose ?? () {}),
    body: Text(bodyText),
    footer: [
      FilledButton(onPressed: () {}, child: const Text('Try again')),
      TextButton(onPressed: () {}, child: const Text('Back to home')),
    ],
  );
}

void main() {
  for (final screen in PhoneScreen.layoutChecks) {
    testWidgets('fits on $screen with a long body, and scrolls to the footer', (tester) async {
      await screen.pump(tester, _errorShapedScreen(bodyText: _longBody));
      expect(tester.takeException(), isNull);

      await tester.ensureVisible(find.byType(TextButton));
      await tester.pump();
      expect(tester.takeException(), isNull);
      final secondary = tester.getRect(find.byType(TextButton));
      expect(secondary.bottom, lessThanOrEqualTo(screen.height));
      expect(secondary.width, screen.width - 2 * 24);
    });
  }

  testWidgets('the exit button sits at the top left, 48 × 48 dp, 8 dp in and 12 dp down', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    var closes = 0;
    await PhoneScreen.standard.pump(tester, _errorShapedScreen(onClose: () => closes++));
    final exitButton = tester.getRect(find.byType(IconButton));
    expect(exitButton, const Rect.fromLTWH(8, 12, 48, 48));
    expect(find.bySemanticsLabel('Close'), findsOneWidget);
    await tester.tap(find.byType(IconButton));
    expect(closes, 1);
    semantics.dispose();
  });

  testWidgets(
    'on a tall screen the footer sits at the bottom: full width, 52 and 48 dp, 8 dp apart',
    (tester) async {
      await PhoneScreen.standard.pump(tester, _errorShapedScreen());

      final primary = tester.getRect(find.byType(FilledButton));
      final secondary = tester.getRect(find.byType(TextButton));
      expect(primary.left, 24);
      expect(primary.width, 360 - 48);
      expect(secondary.width, 360 - 48);
      expect(primary.height, greaterThanOrEqualTo(52));
      expect(secondary.height, greaterThanOrEqualTo(48));
      expect(secondary.top - primary.bottom, 8);
      expect(secondary.bottom, 800 - 24);

      final body = tester.getRect(find.text('Please try again.'));
      expect(body.topLeft, const Offset(24, 12 + 48 + 24));
    },
  );

  testWidgets('meets the tap target, label and contrast guidelines', (tester) async {
    await PhoneScreen.standard.pump(tester, _errorShapedScreen());
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(textContrastGuideline));
  });

  testWidgets('keeps every control inside the safe area of a notched phone with a gesture bar', (
    tester,
  ) async {
    PhoneScreen.standard.applyTo(tester);
    tester.view.padding = const FakeViewPadding(top: 32 * 3, bottom: 24 * 3);
    await PhoneScreen.standard.pump(tester, _errorShapedScreen());

    expect(tester.getRect(find.byType(IconButton)).top, 32 + 12);
    expect(tester.getRect(find.byType(TextButton)).bottom, 800 - 24 - 24);
  });

  testWidgets('a title beside the exit button, as on Result', (tester) async {
    await PhoneScreen.standard.pump(
      tester,
      ScreenFrame(
        exitButton: ScreenExitButton.back(label: 'Back to home', onPressed: () {}),
        title: const Text('Found it'),
        body: const SizedBox.shrink(),
      ),
    );
    final title = tester.getRect(find.text('Found it'));
    expect(title.left, 8 + 48 + 4);
    expect(title.center.dy, closeTo(12 + 24, 1));
  });

  testWidgets('a title on its own sits 20 dp in, as "Look Up" on Home', (tester) async {
    await PhoneScreen.standard.pump(
      tester,
      const ScreenFrame(title: Text('Look Up'), body: SizedBox.shrink()),
    );
    expect(tester.getTopLeft(find.text('Look Up')), const Offset(20, 20));
    expect(find.byType(IconButton), findsNothing);
  });

  testWidgets('the body can sit at the bottom, in the thumb zone, as on Home', (tester) async {
    const body = SizedBox(key: Key('body'), height: 100);
    await PhoneScreen.standard.pump(
      tester,
      const ScreenFrame(
        isBodyAtBottom: true,
        bodyPadding: EdgeInsets.fromLTRB(24, 0, 24, 48),
        body: body,
      ),
    );
    expect(tester.getRect(find.byKey(const Key('body'))).bottom, 800 - 48);
  });

  testWidgets('without a header or footer, the body starts 24 dp in', (tester) async {
    await PhoneScreen.standard.pump(tester, const ScreenFrame(body: Text('Only a body')));
    expect(tester.getTopLeft(find.text('Only a body')), const Offset(24, 24));
  });
}
