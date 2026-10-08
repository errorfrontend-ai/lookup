import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/identify_button.dart';

import '../../../support/phone_screen.dart';

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
    final label = tester.widget<Text>(find.text(IdentifyButton.label));
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
    tester.semantics.tap(find.semantics.byLabel(IdentifyButton.semanticsLabel));
    await tester.pump();
    expect(presses, 1);
    semantics.dispose();
  });

  for (final phoneScreen in PhoneScreen.layoutChecks) {
    testWidgets('keeps its size, and its words inside it, on $phoneScreen', (tester) async {
      await phoneScreen.pump(
        tester,
        Scaffold(
          body: Center(child: IdentifyButton(onPressed: () {})),
        ),
      );
      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.byType(InkWell)), const Size(200, 200));
      final disc = tester.getRect(find.byType(InkWell));
      final words = tester.getRect(find.text(IdentifyButton.label));
      expect(disc.contains(words.topLeft) && disc.contains(words.bottomRight), isTrue);
    });
  }
}
