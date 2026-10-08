import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/level_bars.dart';

import '../../../support/phone_screen.dart';

List<DecoratedBox> _bars(WidgetTester tester) => tester
    .widgetList<DecoratedBox>(
      find.descendant(of: find.byType(LevelBars), matching: find.byType(DecoratedBox)),
    )
    .toList();

void main() {
  test('round(level × 16) bars are lit', () {
    expect(LevelBars.litBarCount(0), 0);
    expect(LevelBars.litBarCount(0.5), 8);
    expect(LevelBars.litBarCount(0.53), 8);
    expect(LevelBars.litBarCount(0.54), 9);
    expect(LevelBars.litBarCount(1), 16);
    expect(LevelBars.litBarCount(2), 16);
    expect(LevelBars.litBarCount(double.nan), 0);
  });

  testWidgets('16 bars, 6 dp wide, 4 dp apart, the wireframe heights, in a 48 dp row', (
    tester,
  ) async {
    await PhoneScreen.standard.pump(
      tester,
      const Scaffold(body: Center(child: LevelBars(levelFraction: 0))),
    );
    final bars = find.descendant(of: find.byType(LevelBars), matching: find.byType(DecoratedBox));
    expect(bars, findsNWidgets(16));
    final sizes = [
      for (final element in bars.evaluate()) tester.getSize(find.byWidget(element.widget)),
    ];
    expect(sizes.map((size) => size.width).toSet(), {6});
    expect(sizes.map((size) => size.height), [
      10, 18, 26, 14, 32, 42, 22, 30, 46, 36, 20, 28, 16, 24, 12, 8, //
    ]);
    final first = tester.getTopRight(bars.at(0));
    final second = tester.getTopLeft(bars.at(1));
    expect(second.dx - first.dx, 4);
    expect(tester.getSize(find.byType(LevelBars)).height, 48);
  });

  testWidgets('the lit bars are the accent, the rest the line colour', (tester) async {
    await PhoneScreen.standard.pump(
      tester,
      const Scaffold(body: Center(child: LevelBars(levelFraction: 0.25))),
    );
    const colours = LookUpColours.light;
    final colourOfBars = [for (final bar in _bars(tester)) (bar.decoration as BoxDecoration).color];
    expect(colourOfBars.take(4), everyElement(colours.accent));
    expect(colourOfBars.skip(4), everyElement(colours.line));
  });

  testWidgets('is hidden from screen readers', (tester) async {
    await PhoneScreen.standard.pump(
      tester,
      const Scaffold(body: Center(child: LevelBars(levelFraction: 0.5))),
    );
    final hidden = tester.widget<ExcludeSemantics>(
      find.descendant(of: find.byType(LevelBars), matching: find.byType(ExcludeSemantics)).first,
    );
    expect(hidden.excluding, isTrue);
  });
}
