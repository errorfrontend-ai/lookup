import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/presentation/action_button.dart';

import '../../../support/phone_screen.dart';
import '../support/result_screen_harness.dart';

/// Result320's own placeholder label (32 characters), and two of the same length, one for each
/// button style.
const List<String> _placeholderLabels = [
  '[A 32-character button label...]',
  '[B 32-character button label...]',
  '[C 32-character button label...]',
];

/// How many lines [label]'s text takes on screen.
int _lineCountOf(WidgetTester tester, String label) {
  final paragraph = tester.renderObject<RenderParagraph>(
    find.descendant(of: find.text(label), matching: find.byType(RichText)),
  );
  final boxes = paragraph.getBoxesForSelection(
    TextSelection(baseOffset: 0, extentOffset: label.length),
  );
  return boxes.map((box) => box.top.round()).toSet().length;
}

/// Shows a primary, a secondary and an outline button with [labels], at 320 dp with no icons, as
/// Result320 draws them.
Future<void> _showButtonsLabelled(WidgetTester tester, List<String> labels) async {
  const styles = ['PRIMARY', 'SECONDARY', 'OUTLINE'];
  await ResultScreenHarness().pumpResultScreen(
    tester,
    resultWith(
      card: cardOf([
        for (final (index, label) in labels.indexed)
          callAction(
            '0192a6c4-0000-4000-8000-00000000000${index + 1}',
            label,
            style: styles[index],
          ),
      ]),
    ),
    phoneScreen: const PhoneScreen(width: 320, height: 640, textScale: 1),
    theme: themeWithRobotoButtonLabels(),
  );
}

/// The test font draws every letter a full square wide, so these tests load Roboto, the font an
/// Android phone draws the labels in. They have a file of their own because a loaded font stays
/// loaded for every later test in the same file.
void main() {
  testWidgets('a 32-character label fits on one line at 320 × 640 dp and text scale 1.0, in '
      'every button style (S4-RESULT-14)', (tester) async {
    await loadRobotoBold(tester);
    await _showButtonsLabelled(tester, _placeholderLabels);

    expect(tester.takeException(), isNull);
    for (final label in _placeholderLabels) {
      expect(label.runes, hasLength(ActionButton.longestWholeLabelCodePoints));
      expect(find.text(label), findsOneWidget);
      expect(_lineCountOf(tester, label), 1, reason: '"$label" wrapped');
    }
  });

  testWidgets(
    'the check sees wrapping: 32 wide letters take two lines (gap 14), with no overflow',
    (tester) async {
      await loadRobotoBold(tester);
      final wideLabels = ['W' * 32, 'M' * 32, 'Q' * 32];
      await _showButtonsLabelled(tester, wideLabels);

      expect(tester.takeException(), isNull);
      for (final label in wideLabels) {
        expect(_lineCountOf(tester, label), 2, reason: '"$label" did not wrap');
      }
      expectNoClippedText(tester);
    },
  );
}
