import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';

import '../../support/phone_screen.dart';

void main() {
  testWidgets('Back shows an arrow, is 48 × 48 dp and is announced by its label', (tester) async {
    final semantics = tester.ensureSemantics();
    var presses = 0;
    await PhoneScreen.standard.pump(
      tester,
      Scaffold(
        body: Center(
          child: ScreenExitButton.back(label: 'Back to home', onPressed: () => presses++),
        ),
      ),
    );

    expect(find.byIcon(Icons.arrow_back), findsOneWidget);
    expect(tester.getSize(find.byType(IconButton)), const Size(48, 48));
    expect(find.bySemanticsLabel('Back to home'), findsOneWidget);

    await tester.tap(find.byType(ScreenExitButton));
    expect(presses, 1);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    semantics.dispose();
  });

  testWidgets('Close shows a cross with its own label', (tester) async {
    final semantics = tester.ensureSemantics();
    var presses = 0;
    await PhoneScreen.standard.pump(
      tester,
      Scaffold(
        body: Center(
          child: ScreenExitButton.close(label: 'Cancel listening', onPressed: () => presses++),
        ),
      ),
    );

    expect(find.byIcon(Icons.close), findsOneWidget);
    expect(find.bySemanticsLabel('Cancel listening'), findsOneWidget);
    await tester.tap(find.byType(ScreenExitButton));
    expect(presses, 1);
    semantics.dispose();
  });
}
