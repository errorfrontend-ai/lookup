import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/level_ring.dart';

import '../../../support/phone_screen.dart';

Future<void> _pumpRing(WidgetTester tester, double levelFraction, {double width = 360}) {
  return PhoneScreen(width: width, height: 800, textScale: 1).pump(
    tester,
    Scaffold(
      body: Center(child: LevelRing(levelFraction: levelFraction)),
    ),
  );
}

void main() {
  test('the rings grow by 15 % at the loudest level, and never past it', () {
    expect(LevelRing.ringScaleFor(0), 1);
    expect(LevelRing.ringScaleFor(0.5), closeTo(1.075, 0.0001));
    expect(LevelRing.ringScaleFor(1), closeTo(1.15, 0.0001));
    expect(LevelRing.ringScaleFor(3), closeTo(1.15, 0.0001));
    expect(LevelRing.ringScaleFor(-1), 1);
    expect(LevelRing.ringScaleFor(double.nan), 1);
  });

  testWidgets('a 164 dp accent disc with a 52 dp microphone, inside three rings', (tester) async {
    await _pumpRing(tester, 0);
    const colours = LookUpColours.light;
    final disc = tester.widgetList<DecoratedBox>(
      find.descendant(of: find.byType(LevelRing), matching: find.byType(DecoratedBox)),
    );
    final rings = disc.first.decoration as BoxDecoration;
    final face = disc.last.decoration as BoxDecoration;
    expect(face.color, colours.accent);
    expect(rings.boxShadow, hasLength(3));
    expect(rings.boxShadow!.map((shadow) => shadow.spreadRadius), [60, 40, 20]);
    expect(
      tester.getSize(find.descendant(of: find.byType(LevelRing), matching: find.byType(Stack))),
      const Size(164, 164),
    );
    final icon = tester.widget<Icon>(find.byIcon(Icons.mic_none));
    expect(icon.size, 52);
    expect(icon.color, colours.onAccent);
  });

  testWidgets('its box holds the outer ring: 284 dp, or the width it is given', (tester) async {
    await _pumpRing(tester, 0);
    expect(tester.getSize(find.byType(LevelRing)), const Size(284, 284));
  });

  testWidgets('is hidden from screen readers and cannot be tapped', (tester) async {
    final semantics = tester.ensureSemantics();
    await _pumpRing(tester, 0.4);
    expect(find.byType(GestureDetector), findsNothing);
    expect(find.byType(InkWell), findsNothing);
    expect(
      find.descendant(of: find.byType(LevelRing), matching: find.byType(ExcludeSemantics)),
      findsWidgets,
    );
    semantics.dispose();
  });

  testWidgets('only the rings scale; the disc keeps its size', (tester) async {
    await _pumpRing(tester, 1);
    await tester.pump(LookUpTokens.light.motion.fast);
    final scale = tester.widget<AnimatedScale>(find.byType(AnimatedScale));
    expect(scale.scale, closeTo(1.15, 0.0001));
    expect(
      find.descendant(of: find.byType(AnimatedScale), matching: find.byIcon(Icons.mic_none)),
      findsNothing,
    );
  });
}
