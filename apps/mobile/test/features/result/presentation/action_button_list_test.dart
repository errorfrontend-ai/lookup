import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/domain/action_card_reader.dart';
import 'package:lookup_listener/features/result/presentation/action_button.dart';
import 'package:lookup_listener/features/result/presentation/action_button_list.dart';
import 'package:lookup_listener/features/result/presentation/more_options_button.dart';

import '../../../support/phone_screen.dart';
import '../support/result_screen_harness.dart';

/// A card of [count] call buttons labelled "Button 1", "Button 2", … in that order.
Map<String, Object?> _cardOfNumberedButtons(int count) {
  return cardOf([
    for (var number = 1; number <= count; number++)
      callAction('0192a6c4-0000-4000-8000-00000000000$number', 'Button $number'),
  ]);
}

Future<void> _pumpList(
  WidgetTester tester,
  Map<String, Object?> card, {
  ResultScreenHarness? harness,
  PhoneScreen phoneScreen = PhoneScreen.standard,
}) {
  return (harness ?? ResultScreenHarness()).pump(
    tester,
    Scaffold(
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: ActionButtonList(card: readActionCard(card), showsIcons: true),
      ),
    ),
    phoneScreen: phoneScreen,
  );
}

/// The labels of the station's buttons, top to bottom.
List<String> _shownLabels(WidgetTester tester) {
  final buttons = tester.widgetList<ActionButton>(find.byType(ActionButton)).toList();
  return [for (final button in buttons) button.label];
}

void main() {
  testWidgets('four buttons show at once, in card order, with no "More options"', (tester) async {
    await _pumpList(tester, _cardOfNumberedButtons(4));
    expect(_shownLabels(tester), ['Button 1', 'Button 2', 'Button 3', 'Button 4']);
    expect(find.byType(MoreOptionsButton), findsNothing);
  });

  for (final count in [5, 6]) {
    testWidgets('$count buttons: four, then "More options", which reveals the rest in place', (
      tester,
    ) async {
      await _pumpList(tester, _cardOfNumberedButtons(count));

      expect(_shownLabels(tester), ['Button 1', 'Button 2', 'Button 3', 'Button 4']);
      expect(find.text('More options'), findsOneWidget);
      expect(find.byIcon(Icons.expand_more), findsOneWidget);
      final moreOptions = tester.getRect(find.byType(MoreOptionsButton));
      final fourthButton = tester.getRect(find.byType(ActionButton).at(3));
      expect(moreOptions.top - fourthButton.bottom, 8);
      expect(moreOptions.width, fourthButton.width);
      expect(moreOptions.height, greaterThanOrEqualTo(48));

      await tester.tap(find.text('More options'));
      await tester.pump();

      expect(_shownLabels(tester), [
        for (var number = 1; number <= count; number++) 'Button $number',
      ]);
      expect(find.byType(MoreOptionsButton), findsNothing);
      expect(tester.getRect(find.byType(ActionButton).at(4)).top - fourthButton.bottom, 8);
    });
  }

  testWidgets('the six-action fixture splits at four, as the shared reader does', (tester) async {
    await _pumpList(tester, fixtureCard('action-card/valid/six-actions.json'));
    expect(find.byType(ActionButton), findsNWidgets(4));
    await tester.tap(find.byType(MoreOptionsButton));
    await tester.pump();
    expect(find.byType(ActionButton), findsNWidgets(6));
  });

  testWidgets('"More options" is a labelled button for screen readers', (tester) async {
    final semantics = tester.ensureSemantics();
    await _pumpList(tester, _cardOfNumberedButtons(5));
    expect(
      tester.getSemantics(find.byType(MoreOptionsButton)),
      isSemantics(label: 'More options', isButton: true, hasTapAction: true),
    );
    semantics.dispose();
  });

  testWidgets('buttons are full width, at least 52 dp tall and 8 dp apart', (tester) async {
    await _pumpList(tester, fourActionCard);
    final buttons = find.byType(ActionButton);
    for (var index = 0; index < 4; index++) {
      final button = tester.getRect(buttons.at(index));
      expect(button.width, 360 - 2 * 16);
      expect(button.height, greaterThanOrEqualTo(52));
      if (index > 0) expect(button.top - tester.getRect(buttons.at(index - 1)).bottom, 8);
    }
  });

  testWidgets('a second tap while the phone is still opening the first opens nothing more', (
    tester,
  ) async {
    final harness = ResultScreenHarness();
    final heldAnswer = Completer<bool>();
    harness.launcher.heldAnswer = heldAnswer;
    await _pumpList(tester, fourActionCard, harness: harness);

    await tester.tap(find.text('Call us'));
    await tester.tap(find.text('Call us'));
    await tester.pump();
    expect(harness.launcher.openedAddresses, ['tel:+260977123456']);

    heldAnswer.complete(true);
    await tester.pump();
    await tester.tap(find.text('Call us'));
    await tester.pump();
    expect(harness.launcher.openedAddresses, ['tel:+260977123456', 'tel:+260977123456']);
  });
}
