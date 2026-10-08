import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';
import 'package:lookup_listener/features/result/presentation/action_button.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/phone_screen.dart';

const String _ellipsis = '…';

Widget _buttonOnScreen(ActionButton button) {
  return Scaffold(
    body: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [button]),
    ),
  );
}

String _labelOfFixture(String relativePath) {
  final fixture = ContractFixtures.readFile(relativePath) as Map<String, Object?>;
  final card = fixture['card'] as Map<String, Object?>;
  final action = (card['actions'] as List<Object?>).single as Map<String, Object?>;
  return action['label'] as String;
}

void main() {
  group('the 32-character rule (S4-D20), counted in code points', () {
    test('a label of up to 32 is shown whole', () {
      expect(ActionButton.shownLabelFor('Call Brand A'), 'Call Brand A');
      final exactly32 = _labelOfFixture('action-card/valid/label-exactly-32-characters.json');
      expect(exactly32.runes, hasLength(32));
      expect(ActionButton.shownLabelFor(exactly32), exactly32);
    });

    test('32 emoji are 32 code points (64 UTF-16 units), so they are shown whole', () {
      final emojiLabel = _labelOfFixture('action-card/valid/label-32-emoji-code-points.json');
      expect(emojiLabel.length, 64);
      expect(ActionButton.shownLabelFor(emojiLabel), emojiLabel);
    });

    test('a label of 33 shows its first 31 and "…"', () {
      final label = 'A' * 33;
      expect(ActionButton.shownLabelFor(label), '${'A' * 31}$_ellipsis');
    });

    test('the over-long reader fixture shows 31 and "…"', () {
      final label = _labelOfFixture('action-card/reader/over-long-label-still-shown.json');
      final shown = ActionButton.shownLabelFor(label);
      expect(shown.runes, hasLength(32));
      expect(shown, '${label.substring(0, 31)}$_ellipsis');
    });

    test('33 emoji show 31 whole emoji and "…", never half of one', () {
      final emoji = String.fromCharCode(0x1F4DE);
      final shown = ActionButton.shownLabelFor(emoji * 33);
      expect(shown, '${emoji * 31}$_ellipsis');
      expect(shown.runes.where((codePoint) => codePoint >= 0xD800 && codePoint <= 0xDFFF), isEmpty);
    });
  });

  testWidgets('a long label is shown shortened, and screen readers get the whole label', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final label = 'Call our shop on Cairo Road before six in the evening';
    await PhoneScreen.standard.pump(
      tester,
      _buttonOnScreen(ActionButton(label: label, style: ActionStyle.primary, onPressed: () {})),
    );

    expect(find.text('${String.fromCharCodes(label.runes.take(31))}$_ellipsis'), findsOneWidget);
    expect(find.text(label), findsNothing);
    expect(
      tester.getSemantics(find.byType(FilledButton)),
      isSemantics(label: label, isButton: true),
    );
    semantics.dispose();
  });

  testWidgets('each style is its Material variant, in the token colours', (tester) async {
    final colours = LookUpTokens.light.colours;
    await PhoneScreen.standard.pump(
      tester,
      Scaffold(
        body: Column(
          children: [
            ActionButton(label: 'Primary', style: ActionStyle.primary, onPressed: () {}),
            ActionButton(label: 'Secondary', style: ActionStyle.secondary, onPressed: () {}),
            ActionButton(label: 'Outline', style: ActionStyle.outline, onPressed: () {}),
          ],
        ),
      ),
    );

    Material materialOf(String label) => tester.widget<Material>(
      find.ancestor(of: find.text(label), matching: find.byType(Material)).first,
    );

    expect(find.ancestor(of: find.text('Primary'), matching: find.byType(FilledButton)), findsOne);
    expect(materialOf('Primary').color, colours.accent);
    expect(
      find.ancestor(of: find.text('Secondary'), matching: find.byType(FilledButton)),
      findsOne,
    );
    expect(materialOf('Secondary').color, colours.accentSoft);
    expect(
      find.ancestor(of: find.text('Outline'), matching: find.byType(OutlinedButton)),
      findsOne,
    );
    expect(materialOf('Outline').color, colours.surface);
  });

  testWidgets('with an icon: a 20 dp icon before the label, hidden from screen readers', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await PhoneScreen.standard.pump(
      tester,
      _buttonOnScreen(
        ActionButton(
          label: 'Call us',
          style: ActionStyle.primary,
          icon: Icons.call_outlined,
          onPressed: () {},
        ),
      ),
    );

    final icon = tester.getRect(find.byIcon(Icons.call_outlined));
    expect(icon.size, const Size(20, 20));
    expect(icon.right, lessThan(tester.getRect(find.text('Call us')).left));
    expect(tester.getSemantics(find.byType(FilledButton)).label, 'Call us');
    semantics.dispose();
  });

  testWidgets('full width, at least 52 dp tall, and a tap calls back once', (tester) async {
    var presses = 0;
    await PhoneScreen.standard.pump(
      tester,
      _buttonOnScreen(
        ActionButton(label: 'Call us', style: ActionStyle.outline, onPressed: () => presses++),
      ),
    );

    final button = tester.getRect(find.byType(OutlinedButton));
    expect(button.width, 360 - 2 * 16);
    expect(button.height, greaterThanOrEqualTo(52));
    await tester.tap(find.byType(OutlinedButton));
    expect(presses, 1);
  });

  for (final screen in PhoneScreen.layoutChecks) {
    testWidgets('a 32-character label never overflows on $screen; it may wrap', (tester) async {
      await screen.pump(
        tester,
        _buttonOnScreen(
          ActionButton(
            label: 'W' * 32,
            style: ActionStyle.primary,
            icon: Icons.call_outlined,
            onPressed: () {},
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      expect(find.text('W' * 32), findsOneWidget);
    });
  }
}
