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
        await ResultScreenHarness().pumpResultScreen(tester, resultWith(card: content['card']));

        expect(tester.takeException(), isNull);
        expect(_shownButtons(tester), hasLength(visibleIds.length));
        expect(find.byType(MoreOptionsButton), moreOptionsIds.isEmpty ? findsNothing : findsOne);
        expect(
          find.text(_updateHint),
          expected['shows_update_app_hint'] == true ? findsOne : findsNothing,
        );

        await _revealAllButtons(tester);
        final buttons = _shownButtons(tester);
        expect(buttons, hasLength(visibleIds.length + moreOptionsIds.length));
        expect([for (final button in buttons) button.style.wireName], styles);
        expectNoTechnicalText(tester);
      });
    }
  });
}
