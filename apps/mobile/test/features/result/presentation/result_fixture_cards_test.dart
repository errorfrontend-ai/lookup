import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/presentation/action_button.dart';
import 'package:lookup_listener/features/result/presentation/more_options_button.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/expect_no_technical_text.dart';
import '../../../support/phone_screen.dart';
import '../support/result_screen_harness.dart';

const String _updateHint = 'Some buttons need a newer version of Look Up.';

/// Shows every button of the card on screen, pressing "More options" when it is there.
Future<void> _revealAllButtons(WidgetTester tester) async {
  if (find.byType(MoreOptionsButton).evaluate().isEmpty) return;
  await tester.ensureVisible(find.byType(MoreOptionsButton));
  await tester.pump();
  await tester.tap(find.byType(MoreOptionsButton));
  await tester.pump();
}

/// The station's buttons, top to bottom.
List<ActionButton> _shownButtons(WidgetTester tester) =>
    tester.widgetList<ActionButton>(find.byType(ActionButton)).toList();

/// The words drawn on the station's buttons, ordered by where they sit, top to bottom.
List<String> _drawnLabels(WidgetTester tester) {
  final buttons = find.byType(ActionButton);
  final drawn = [
    for (var index = 0; index < buttons.evaluate().length; index++)
      (
        top: tester.getRect(buttons.at(index)).top,
        text: tester
            .widget<Text>(find.descendant(of: buttons.at(index), matching: find.byType(Text)))
            .data!,
      ),
  ]..sort((first, second) => first.top.compareTo(second.top));
  return [for (final button in drawn) button.text];
}

/// The label of each action id on a card fixture, the first action with an id winning, as the
/// reader keeps the first of two actions that share one (R10).
Map<String, String> _labelsByIdOf(Object? card) {
  final labelsById = <String, String>{};
  final actions = card is Map<String, Object?> ? card['actions'] : null;
  if (actions is! List<Object?>) return labelsById;
  for (final action in actions) {
    if (action is! Map<String, Object?>) continue;
    final id = action['id'];
    final label = action['label'];
    if (id is String && label is String) labelsById.putIfAbsent(id, () => label);
  }
  return labelsById;
}

void main() {
  group('every valid shared card renders, with every action and nothing skipped (§4.4)', () {
    final fixtures = ContractFixtures.readFolder('action-card/valid');

    test('the loader finds all 13 valid cards', () => expect(fixtures, hasLength(13)));

    for (final fixture in fixtures) {
      for (final phoneScreen in [
        PhoneScreen.standard,
        const PhoneScreen(width: 320, height: 640, textScale: 2),
      ]) {
        testWidgets('${fixture.name} on $phoneScreen', (tester) async {
          final card = (fixture.content as Map<String, Object?>)['card'] as Map<String, Object?>;
          final actions = (card['actions'] as List<Object?>).cast<Map<String, Object?>>();
          await ResultScreenHarness().pumpResultScreen(
            tester,
            resultWith(card: card),
            phoneScreen: phoneScreen,
          );
          await _revealAllButtons(tester);

          expect(tester.takeException(), isNull);
          final buttons = _shownButtons(tester);
          expect(buttons, hasLength(actions.length));
          expect(buttons.length, lessThanOrEqualTo(6));
          final labels = [for (final action in actions) action['label'] as String];
          expect([for (final button in buttons) button.label], labels, reason: 'card order');
          for (final label in labels.toSet()) {
            final timesOnCard = labels.where((other) => other == label).length;
            expect(find.text(ActionButton.shownLabelFor(label)), findsNWidgets(timesOnCard));
          }
          expect(find.text(_updateHint), findsNothing);
          expect(find.text('This ad has no buttons right now.'), findsNothing);
          expectNoTechnicalText(tester);
        });
      }
    }
  });

  group('the shared reader fixtures show exactly the buttons and hint the reader gives (§4.4)', () {
    final fixtures = ContractFixtures.readFolder('action-card/reader');

    test('the loader finds all 18 reader fixtures', () => expect(fixtures, hasLength(18)));

    for (final fixture in fixtures) {
      testWidgets(fixture.name, (tester) async {
        final content = fixture.content as Map<String, Object?>;
        final expected = content['expected'] as Map<String, Object?>;
        final visibleIds = expected['visible_action_ids'] as List<Object?>;
        final moreOptionsIds = expected['more_options_action_ids'] as List<Object?>;
        final styles = (expected['styles'] as List<Object?>).cast<String>();
        final labelsById = _labelsByIdOf(content['card']);
        final visibleLabels = [for (final id in visibleIds) labelsById[id]!];
        final moreOptionsLabels = [for (final id in moreOptionsIds) labelsById[id]!];
        await ResultScreenHarness().pumpResultScreen(tester, resultWith(card: content['card']));

        expect(tester.takeException(), isNull);
        expect(
          _drawnLabels(tester),
          [for (final label in visibleLabels) ActionButton.shownLabelFor(label)],
          reason: 'the buttons shown first: exactly visible_action_ids, in order',
        );
        expect(find.byType(MoreOptionsButton), moreOptionsIds.isEmpty ? findsNothing : findsOne);
        expect(
          find.text(_updateHint),
          expected['shows_update_app_hint'] == true ? findsOne : findsNothing,
        );

        await _revealAllButtons(tester);
        final buttons = _shownButtons(tester);
        expect(
          _drawnLabels(tester),
          [
            for (final label in [...visibleLabels, ...moreOptionsLabels])
              ActionButton.shownLabelFor(label),
          ],
          reason:
              'after "More options": visible_action_ids, then more_options_action_ids, in order',
        );
        expect(
          [for (final button in buttons) button.label],
          [...visibleLabels, ...moreOptionsLabels],
        );
        expect([for (final button in buttons) button.style.wireName], styles);
        expectNoTechnicalText(tester);
      });
    }
  });
}
