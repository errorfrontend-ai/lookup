import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/identify_button.dart';

import '../../../support/phone_screen.dart';
import '../../../support/english_words.dart';

void main() {
  testWidgets('an accent disc 200 dp across with "Tap to identify" in the on-accent colour', (
    tester,
  ) async {
    await PhoneScreen.standard.pump(
      tester,
      Scaffold(
        body: Center(child: IdentifyButton(onPressed: () {})),
      ),
    );
    const colours = LookUpColours.light;
    final material = tester.widget<Material>(
      find.descendant(of: find.byType(IdentifyButton), matching: find.byType(Material)),
    );
    expect(material.color, colours.accent);
    expect(material.shape, isA<CircleBorder>());
    expect(tester.getSize(find.byType(InkWell)), const Size(200, 200));
    final label = tester.widget<Text>(find.text(englishWords.identifyButtonLabel));
    expect(label.style!.color, colours.onAccent);
    expect(label.style!.fontWeight, FontWeight.w700);
    expect(tester.widget<Icon>(find.byIcon(Icons.mic_none)).size, 56);
  });

  testWidgets('a tap anywhere on the disc calls onPressed', (tester) async {
    var presses = 0;
    await PhoneScreen.standard.pump(
      tester,
      Scaffold(
        body: Center(child: IdentifyButton(onPressed: () => presses++)),
      ),
    );
    await tester.tap(find.byType(IdentifyButton));
    await tester.tap(find.byIcon(Icons.mic_none));
    expect(presses, 2);
  });

  testWidgets('a screen reader\'s tap calls onPressed too', (tester) async {
    final semantics = tester.ensureSemantics();
    var presses = 0;
    await PhoneScreen.standard.pump(
      tester,
      Scaffold(
        body: Center(child: IdentifyButton(onPressed: () => presses++)),
      ),
    );
    tester.semantics.tap(find.semantics.byLabel(englishWords.identifyButtonSpokenLabel));
    await tester.pump();
    expect(presses, 1);
    semantics.dispose();
  });

  for (final phoneScreen in PhoneScreen.layoutChecks) {
    // 200 dp at normal text; 200 dp times the scale at larger text, but never wider than the screen
    // less a 28 dp ring on each side.
    final expectedDiameter = phoneScreen.textScale == 1 ? 200.0 : phoneScreen.width - 56;
    testWidgets(
      '${expectedDiameter.round()} dp across with its words whole inside it, larger at larger text, on $phoneScreen (S4-RESPONSIVE-03)',
      (tester) async {
        await _showButton(tester, phoneScreen);
        expect(tester.takeException(), isNull);
        expect(tester.getSize(find.byType(InkWell)), Size.square(expectedDiameter));
        _expectWordsWholeInsideTheDisc(tester);
        // The test font draws each letter a square as wide as the text is tall, so "identify" at
        // 36 dp is 288 dp long, wider than any disc that fits a phone: at 2.0 the words grow, and
        // shrink only as far as the widest disc needs.
        final drawnSize = _drawnFontSizeOfLabel(tester);
        if (phoneScreen.textScale == 1) {
          expect(drawnSize, 18);
        } else {
          expect(drawnSize, greaterThan(18 * 1.5));
          expect(drawnSize, lessThan(18 * phoneScreen.textScale));
        }
      },
    );
  }

  for (final (width, height, diameter) in [(360.0, 800.0, 300.0), (320.0, 640.0, 264.0)]) {
    final phoneScreen = PhoneScreen(width: width, height: height, textScale: 1.5);
    testWidgets(
      'on $phoneScreen the words are drawn at the listener\'s size, 27 dp, on a ${diameter.round()} dp disc',
      (tester) async {
        await _showButton(tester, phoneScreen);
        expect(tester.takeException(), isNull);
        expect(tester.getSize(find.byType(InkWell)), Size.square(diameter));
        expect(_drawnFontSizeOfLabel(tester), 27);
        _expectWordsWholeInsideTheDisc(tester);
      },
    );
  }

  testWidgets(
    'at text scale 3.0 on 320 × 640 dp the disc is as wide as it can be and the words shrink, whole, to fit inside it',
    (tester) async {
      await _showButton(tester, const PhoneScreen(width: 320, height: 640, textScale: 3));
      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.byType(InkWell)), const Size.square(264));
      _expectWordsWholeInsideTheDisc(tester);
      expect(_drawnFontSizeOfLabel(tester), lessThan(18 * 3));
    },
  );
}

Future<void> _showButton(WidgetTester tester, PhoneScreen phoneScreen) => phoneScreen.pump(
  tester,
  Scaffold(
    body: Center(child: IdentifyButton(onPressed: () {})),
  ),
);

/// The size the label's letters are drawn at on screen: its font size at the listener's text
/// scale, times any shrinking to fit the disc.
double _drawnFontSizeOfLabel(WidgetTester tester) {
  final label = find.text(englishWords.identifyButtonLabel);
  final shrinking = tester.getRect(label).height / tester.getSize(label).height;
  final scaled = MediaQuery.textScalerOf(tester.element(label)).scale(18);
  return double.parse((scaled * shrinking).toStringAsFixed(3));
}

/// "Tap to identify" sits inside the disc on two lines, "Tap to" and "identify": no word is broken.
void _expectWordsWholeInsideTheDisc(WidgetTester tester) {
  final disc = tester.getRect(find.byType(InkWell));
  final words = tester.getRect(find.text(englishWords.identifyButtonLabel));
  expect(disc.contains(words.topLeft) && disc.contains(words.bottomRight), isTrue);
  final paragraph = tester.renderObject<RenderParagraph>(
    find.descendant(
      of: find.text(englishWords.identifyButtonLabel),
      matching: find.byType(RichText),
    ),
  );
  // What is left of the label from the first letter of each line on.
  final lines = <String>[];
  double? previousTop;
  for (final (index, letter) in englishWords.identifyButtonLabel.split('').indexed) {
    if (letter == ' ') continue;
    final top = paragraph
        .getBoxesForSelection(TextSelection(baseOffset: index, extentOffset: index + 1))
        .first
        .top;
    if (top != previousTop) lines.add(englishWords.identifyButtonLabel.substring(index));
    previousTop = top;
  }
  expect(lines, ['Tap to identify', 'identify'], reason: 'a word was broken across lines');
}
