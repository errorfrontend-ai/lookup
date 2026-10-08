import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/progress_track.dart';

import '../../../support/phone_screen.dart';
import 'identify_screen_harness.dart' show disableAnimations;

const LookUpColours _colours = LookUpColours.light;

Future<void> _pumpTrack(WidgetTester tester, {double? fraction}) {
  return PhoneScreen.standard.pump(
    tester,
    Scaffold(
      body: Center(
        child: SizedBox(
          width: 220,
          child: ProgressTrack(fraction: fraction, fillColour: _colours.accent),
        ),
      ),
    ),
  );
}

/// The breathing of an unknown wait, if any, inside the track.
final Finder _breathing = find.descendant(
  of: find.byType(ProgressTrack),
  matching: find.byType(FadeTransition),
);

FractionallySizedBox _fill(WidgetTester tester) =>
    tester.widget<FractionallySizedBox>(find.byType(FractionallySizedBox));

void main() {
  testWidgets('a 6 dp track in line-soft, as wide as its parent, filled from the start', (
    tester,
  ) async {
    await _pumpTrack(tester, fraction: 0.25);
    expect(tester.getSize(find.byType(ProgressTrack)), const Size(220, 6));
    expect(_fill(tester).widthFactor, 0.25);
    final track = tester.widget<ColoredBox>(
      find.descendant(of: find.byType(ClipRRect), matching: find.byType(ColoredBox)).first,
    );
    expect(track.color, _colours.lineSoft);
    expect(tester.getTopLeft(find.byType(FractionallySizedBox)).dx, (360 - 220) / 2);
    expect(_breathing, findsNothing);
  });

  testWidgets('keeps the fraction between empty and full', (tester) async {
    await _pumpTrack(tester, fraction: 1.4);
    expect(_fill(tester).widthFactor, 1);
  });

  testWidgets('an unknown wait breathes while animations are on', (tester) async {
    await _pumpTrack(tester);
    expect(_fill(tester).widthFactor, ProgressTrack.unknownWaitBarFraction);
    expect(_breathing, findsOneWidget);
    await tester.pump(LookUpTokens.light.motion.slow);
    expect(tester.binding.hasScheduledFrame, isTrue);
  });

  testWidgets('an unknown wait stands still when the phone asks for less motion', (tester) async {
    disableAnimations(tester);
    await _pumpTrack(tester);
    await tester.pump();
    expect(_breathing, findsNothing);
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('is hidden from screen readers', (tester) async {
    await _pumpTrack(tester, fraction: 0.5);
    expect(tester.widget<ExcludeSemantics>(find.byType(ExcludeSemantics).first).excluding, isTrue);
  });
}
