import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/core/widgets/state_icon_circle.dart';

import '../../support/phone_screen.dart';

const LookUpColours _colours = LookUpColours.light;

Widget _screenWithCircle() {
  return ScreenFrame(
    body: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        StateIconCircle(
          icon: Icons.search,
          iconColour: _colours.muted,
          circleColour: _colours.lineSoft,
        ),
        const Text('We couldn\'t recognise that'),
      ],
    ),
  );
}

void main() {
  testWidgets('is an 88 dp circle in the soft colour with a 40 dp icon in the strong colour', (
    tester,
  ) async {
    await PhoneScreen.standard.pump(tester, _screenWithCircle());

    final circle = find.descendant(
      of: find.byType(StateIconCircle),
      matching: find.byType(DecoratedBox),
    );
    expect(tester.getSize(circle), const Size(88, 88));
    final decoration = tester.widget<DecoratedBox>(circle).decoration as BoxDecoration;
    expect(decoration.shape, BoxShape.circle);
    expect(decoration.color, _colours.lineSoft);

    final icon = tester.widget<Icon>(find.byIcon(Icons.search));
    expect(icon.size, 40);
    expect(icon.color, _colours.muted);
    expect(tester.getCenter(find.byIcon(Icons.search)), tester.getCenter(circle));
  });

  testWidgets('sits at the start of the line, as the wireframes draw it', (tester) async {
    await PhoneScreen.standard.pump(tester, _screenWithCircle());
    final circle = find.descendant(
      of: find.byType(StateIconCircle),
      matching: find.byType(DecoratedBox),
    );
    expect(tester.getTopLeft(circle).dx, 24);
  });

  testWidgets('is hidden from screen readers (the heading says the same)', (tester) async {
    await PhoneScreen.standard.pump(tester, _screenWithCircle());
    // The outermost widget the circle builds hides everything inside it.
    final outermostExclusion = find
        .descendant(of: find.byType(StateIconCircle), matching: find.byType(ExcludeSemantics))
        .first;
    expect(tester.widget<ExcludeSemantics>(outermostExclusion).excluding, isTrue);
    expect(
      find.descendant(of: outermostExclusion, matching: find.byIcon(Icons.search)),
      findsOneWidget,
    );
  });

  for (final screen in PhoneScreen.layoutChecks) {
    testWidgets('fits on $screen', (tester) async {
      await screen.pump(tester, _screenWithCircle());
      expect(tester.takeException(), isNull);
      final circle = find.descendant(
        of: find.byType(StateIconCircle),
        matching: find.byType(DecoratedBox),
      );
      expect(tester.getSize(circle), const Size(88, 88));
    });
  }
}
