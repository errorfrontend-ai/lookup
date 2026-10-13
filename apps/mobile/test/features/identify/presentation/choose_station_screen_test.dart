import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'dart:ui' show CheckedState;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/data/recognize_response_parser.dart';
import 'package:lookup_listener/features/identify/domain/recognition_outcome.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/domain/send_policy.dart';
import 'package:lookup_listener/features/identify/presentation/choose_station_screen.dart';
import 'package:lookup_listener/features/identify/presentation/station_choice_row.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/english_words.dart';
import '../../../support/expect_no_technical_text.dart';
import '../../../support/phone_screen.dart';
import 'identify_screen_harness.dart';

const String _stationAId = '0192a6c4-1111-4000-8000-000000000001';
const String _stationBId = '0192a6c4-1111-4000-8000-000000000002';

/// The chooser state the app shows for a shared answer fixture, read and decided as the flow does.
ChooseStationState _chooserFrom(String fixtureName) {
  final content =
      ContractFixtures.readFile('recognition/recognize-response/valid/$fixtureName.json')!
          as Map<String, Object?>;
  final answer = const RecognizeResponseParser().read(httpStatus: 200, body: content['response']);
  final outcome = const SendPolicy().decide(answer, reportRequestId: 'unused');
  return (outcome as FinishedOutcome).nextState as ChooseStationState;
}

Future<IdentifyScreenHarness> _show(
  WidgetTester tester,
  ChooseStationState state, {
  PhoneScreen phoneScreen = PhoneScreen.standard,
  ThemeData? theme,
}) async {
  final harness = IdentifyScreenHarness(state: state);
  await harness.pump(
    tester,
    ChooseStationScreen(state: state),
    phoneScreen: phoneScreen,
    theme: theme,
  );
  await tester.pumpAndSettle();
  return harness;
}

Finder get _rows => find.byType(StationChoiceRow);

/// "Which station?" (P6 design §2.6; wireframe Chooser; P6-CHOOSER-01 to -14, P6-ACCESSIBILITY-07).
void main() {
  final chooser = _chooserFrom('choose-station');

  group('what the sheet says (P6-CHOOSER-01, -13)', () {
    testWidgets('its title in a bottom sheet, and the sentence for an ad on air at both', (
      tester,
    ) async {
      await _show(tester, chooser);
      expect(find.byType(BottomSheet), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('Which station are you listening to?'),
        ),
        findsOneWidget,
      );
      expect(find.text('This ad is on more than one station right now.'), findsOneWidget);
      expect(find.text('This ad is played on more than one station.'), findsNothing);
      expectNoTechnicalText(tester);
    });

    testWidgets(
      'all default cards (out of slots, at limits or paused): "played on more than one station"',
      (tester) async {
        final allDefault = _chooserFrom('choose-station-out-of-window');
        expect(allDefault.areAllCandidatesDefaultCards, isTrue);
        await _show(tester, allDefault);
        expect(find.text('This ad is played on more than one station.'), findsOneWidget);
        expect(find.text('This ad is on more than one station right now.'), findsNothing);
      },
    );

    testWidgets('one default card among campaigns keeps "right now"', (tester) async {
      await _show(tester, _chooserFrom('choose-station-four-candidates'));
      expect(find.text('This ad is on more than one station right now.'), findsOneWidget);
    });
  });

  group('the rows (P6-CHOOSER-02, -03, -04)', () {
    testWidgets("one row per candidate, 2 to 4, in the answer's order (P6-CHOOSER-02)", (
      tester,
    ) async {
      for (final (fixture, names) in [
        ('choose-station', ['Station A', 'Station B']),
        ('choose-station-three-candidates', ['Station A', 'Station B', 'Station C']),
        ('choose-station-four-candidates', ['Station A', 'Station B', 'Station C', 'Station D']),
      ]) {
        await tester.pumpWidget(const SizedBox());
        await _show(tester, _chooserFrom(fixture));
        expect(_rows, findsNWidgets(names.length), reason: fixture);
        final rowTops = [
          for (final name in names)
            tester.getTopLeft(find.ancestor(of: find.text(name), matching: _rows)).dy,
        ];
        expect(
          rowTops,
          [...rowTops]..sort(),
          reason: "$fixture: top to bottom in the answer's order",
        );
      }
    });

    testWidgets(
      'each row: first letter, name, "98.1 FM · Lusaka", chevron; no city, just the frequency',
      (tester) async {
        await _show(tester, _chooserFrom('choose-station-four-candidates'));
        Finder inRow(String stationName, Finder finder) => find.descendant(
          of: find.ancestor(of: find.text(stationName), matching: _rows),
          matching: finder,
        );
        // The station's first letter: "S" for "Station A".
        expect(inRow('Station A', find.text('S')), findsOneWidget);
        expect(inRow('Station A', find.text('98.1 FM · Lusaka')), findsOneWidget);
        expect(inRow('Station A', find.byIcon(Icons.chevron_right)), findsOneWidget);
        expect(inRow('Station B', find.text('104.3 FM · Kitwe')), findsOneWidget);
        expect(inRow('Station D', find.text('95.7 FM')), findsOneWidget);
        expect(find.textContaining('95.7 FM ·'), findsNothing);
      },
    );

    testWidgets('the letter\'s square is ink, muted, then accent by the row\'s place', (
      tester,
    ) async {
      await _show(tester, _chooserFrom('choose-station-four-candidates'));
      final colours = LookUpTokens.light.colours;
      final fills = [
        for (final name in ['Station A', 'Station B', 'Station C', 'Station D'])
          tester
              .widget<ColoredBox>(
                find
                    .descendant(
                      of: find.ancestor(of: find.text(name), matching: _rows),
                      matching: find.byType(ColoredBox),
                    )
                    .first,
              )
              .color,
      ];
      expect(fills, [colours.ink, colours.muted, colours.accent, colours.ink]);
    });

    testWidgets('every row is at least 64 dp tall, so at least 56 (P6-CHOOSER-04)', (tester) async {
      await _show(tester, _chooserFrom('choose-station-four-candidates'));
      for (var index = 0; index < 4; index++) {
        expect(tester.getSize(_rows.at(index)).height, greaterThanOrEqualTo(64));
      }
    });

    testWidgets('a row is one button read as "Station A, 98.1 FM, Lusaka"; without a city, '
        '"Station D, 95.7 FM"', (tester) async {
      final semantics = tester.ensureSemantics();
      await _show(tester, _chooserFrom('choose-station-four-candidates'));
      final stationA = tester.getSemantics(_rows.first);
      expect(stationA.label, 'Station A, 98.1 FM, Lusaka');
      expect(stationA.getSemanticsData().flagsCollection.isButton, isTrue);
      expect(stationA.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
      expect(tester.getSemantics(_rows.last).label, 'Station D, 95.7 FM');
      semantics.dispose();
    });
  });

  group('a tap on a row (T44; P6-CHOOSER-01, -06)', () {
    testWidgets('chooses that station with "Remember" ticked, once', (tester) async {
      final harness = await _show(tester, chooser);
      await tester.tap(find.text('Station B'));
      await tester.tap(find.text('Station A'));
      await tester.pump();
      expect(harness.flow.calls, ['chooseStation($_stationBId, remembered)']);
    });

    testWidgets('"Remember" is ticked at open, and its whole row toggles it (P6-CHOOSER-05, -06)', (
      tester,
    ) async {
      final harness = await _show(tester, chooser);
      final checkbox = find.byType(Checkbox);
      expect(checkbox, findsOneWidget);
      expect(tester.widget<Checkbox>(checkbox).value, isTrue);
      expect(find.text('Remember my station — skip this next time'), findsOneWidget);

      await tester.tap(find.text('Remember my station — skip this next time'));
      await tester.pump();
      expect(tester.widget<Checkbox>(checkbox).value, isFalse);
      await tester.tap(find.text('Remember my station — skip this next time'));
      await tester.pump();
      expect(tester.widget<Checkbox>(checkbox).value, isTrue);
      await tester.tap(find.text('Remember my station — skip this next time'));
      await tester.pump();

      await tester.tap(find.text('Station A'));
      await tester.pump();
      expect(harness.flow.calls, ['chooseStation($_stationAId, not remembered)']);
    });

    testWidgets('the checkbox row is read as a checkbox with its label and its state', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await _show(tester, chooser);
      final node = tester.getSemantics(find.byType(CheckboxListTile));
      final data = node.getSemanticsData();
      expect(data.label, contains('Remember my station — skip this next time'));
      expect(data.flagsCollection.isChecked, CheckedState.isTrue);
      expect(tester.getSize(find.byType(CheckboxListTile)).height, greaterThanOrEqualTo(48));
      semantics.dispose();
    });
  });

  group('leaving without a choice (T46; P6-CHOOSER-14)', () {
    testWidgets('"Cancel" goes Home and chooses nothing', (tester) async {
      final harness = await _show(tester, chooser);
      await scrollToAndTap(tester, find.widgetWithText(TextButton, englishWords.cancelButton));
      expect(harness.flow.calls, ['backToHome']);
    });

    testWidgets('system Back is Cancel', (tester) async {
      final harness = await _show(tester, chooser);
      await pressSystemBack(tester);
      expect(harness.flow.calls, contains('backToHome'));
      expect(harness.flow.calls.where((call) => call.startsWith('choose')), isEmpty);
    });

    testWidgets('dragging the sheet down is Cancel', (tester) async {
      final harness = await _show(tester, chooser);
      await tester.drag(find.text('Which station are you listening to?'), const Offset(0, 500));
      await tester.pumpAndSettle();
      expect(harness.flow.calls, ['backToHome']);
    });

    testWidgets('a downward fling is Cancel', (tester) async {
      final harness = await _show(tester, chooser);
      await tester.fling(
        find.text('Which station are you listening to?'),
        const Offset(0, 200),
        2000,
      );
      await tester.pumpAndSettle();
      expect(harness.flow.calls, ['backToHome']);
    });

    testWidgets('a small drag lets the sheet settle back, and nothing happens', (tester) async {
      final harness = await _show(tester, chooser);
      final top = tester.getTopLeft(find.byType(BottomSheet)).dy;
      await tester.drag(find.text('Which station are you listening to?'), const Offset(0, 40));
      await tester.pumpAndSettle();
      expect(harness.flow.calls, isEmpty);
      expect(tester.getTopLeft(find.byType(BottomSheet)).dy, top);
    });

    testWidgets('a tap on the dimmed screen behind does nothing (P6-CHOOSER-11)', (tester) async {
      final harness = await _show(tester, chooser);
      await tester.tapAt(const Offset(180, 40));
      await tester.tapAt(const Offset(30, 30));
      await tester.pump();
      expect(harness.flow.calls, isEmpty);
    });
  });

  group('the sheet as drawn (P6-CHOOSER-11, -12)', () {
    testWidgets('over the Identifying layout under a scrim of ink at 55%', (tester) async {
      await _show(tester, chooser);
      expect(find.text('Identifying…', skipOffstage: false), findsWidgets);
      final scrimColour = LookUpTokens.light.colours.ink.withValues(alpha: 0.55);
      final scrim = find.byWidgetPredicate(
        (widget) => widget is ColoredBox && widget.color == scrimColour,
      );
      expect(scrim, findsOneWidget);
      expect(tester.getSize(scrim), const Size(360, 800));
      expect(find.ancestor(of: scrim, matching: find.byType(AbsorbPointer)), findsWidgets);
    });

    testWidgets('a 40 × 4 dp handle in the line colour at the top centre of the sheet', (
      tester,
    ) async {
      await _show(tester, chooser);
      final handle = find.byWidgetPredicate(
        (widget) =>
            widget is Container &&
            widget.constraints?.maxWidth == 40 &&
            widget.constraints?.maxHeight == 4,
      );
      expect(handle, findsOneWidget);
      final decoration = tester.widget<Container>(handle).decoration! as BoxDecoration;
      expect(decoration.color, LookUpTokens.light.colours.line);
      expect(decoration.borderRadius, BorderRadius.circular(2));
      final sheet = tester.getRect(find.byType(BottomSheet));
      final handleRect = tester.getRect(handle);
      expect(handleRect.center.dx, closeTo(sheet.center.dx, 0.01));
      expect(handleRect.top - sheet.top, 8);
    });

    testWidgets('the sheet: surface colour, 24 dp top corners, at most 90% of the height', (
      tester,
    ) async {
      await _show(tester, _chooserFrom('choose-station-four-candidates'));
      final sheet = tester.widget<BottomSheet>(find.byType(BottomSheet));
      expect(sheet.backgroundColor, LookUpTokens.light.colours.surface);
      expect(
        (sheet.shape! as RoundedRectangleBorder).borderRadius,
        const BorderRadius.vertical(top: Radius.circular(24)),
      );
      expect(tester.getSize(find.byType(BottomSheet)).height, lessThanOrEqualTo(800 * 0.9));
    });

    testWidgets('on a wide screen the sheet is at most 640 dp wide and centred', (tester) async {
      await _show(
        tester,
        chooser,
        phoneScreen: const PhoneScreen(width: 1280, height: 800, textScale: 1),
      );
      final sheet = tester.getRect(find.byType(BottomSheet));
      expect(sheet.width, 640);
      expect(sheet.center.dx, 640);
    });

    testWidgets('it slides up over motion.base, and is simply there with less motion', (
      tester,
    ) async {
      final harness = IdentifyScreenHarness(state: chooser);
      await harness.pump(tester, ChooseStationScreen(state: chooser));
      final settledTop = 800 - tester.getSize(find.byType(BottomSheet)).height;
      expect(tester.getTopLeft(find.byType(BottomSheet)).dy, greaterThan(settledTop));
      await tester.pump(LookUpTokens.light.motion.base);
      expect(tester.getTopLeft(find.byType(BottomSheet)).dy, closeTo(settledTop, 0.01));

      disableAnimations(tester);
      await tester.pumpWidget(const SizedBox());
      await IdentifyScreenHarness(state: chooser).pump(tester, ChooseStationScreen(state: chooser));
      expect(tester.getTopLeft(find.byType(BottomSheet)).dy, closeTo(settledTop, 0.01));
    });
  });

  group('screen readers (P6-CHOOSER-11, P6-ACCESSIBILITY-07)', () {
    testWidgets('the sheet scopes a route named by its title: a modal dialog', (tester) async {
      final semantics = tester.ensureSemantics();
      await _show(tester, chooser);
      final routeNode = find.semantics.byPredicate(
        (node) =>
            node.getSemanticsData().flagsCollection.scopesRoute &&
            node.getSemanticsData().flagsCollection.namesRoute,
      );
      expect(routeNode, findsOne);
      expect(routeNode.evaluate().single.label, 'Which station are you listening to?');
      semantics.dispose();
    });

    testWidgets('only the sheet is reachable: nothing of Identifying behind it is read', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await _show(tester, chooser);
      for (final behind in [
        'Identifying…',
        'This usually takes a few seconds.',
        englishWords.cancelIdentifyingLabel,
      ]) {
        expect(find.semantics.byLabel(behind), findsNothing, reason: behind);
      }
      expect(find.semantics.byLabel('Which station are you listening to?'), findsWidgets);
      expect(find.semantics.byLabel('Station B, 104.3 FM, Kitwe'), findsOne);
      semantics.dispose();
    });

    testWidgets('the title is a heading; the handle is not read', (tester) async {
      final semantics = tester.ensureSemantics();
      await _show(tester, chooser);
      final title = tester.getSemantics(find.text('Which station are you listening to?'));
      expect(title.getSemanticsData().flagsCollection.isHeader, isTrue);
      final handle = find.byWidgetPredicate(
        (widget) =>
            widget is Container &&
            widget.constraints?.maxWidth == 40 &&
            widget.constraints?.maxHeight == 4,
      );
      final hiding = find.ancestor(of: handle, matching: find.byType(ExcludeSemantics));
      expect(
        hiding.evaluate().any((element) => (element.widget as ExcludeSemantics).excluding),
        isTrue,
      );
      semantics.dispose();
    });
  });

  group('fits and reads well everywhere (P6 design §4.1)', () {
    for (final (name, theme) in [('light', LookUpTheme.light()), ('dark', LookUpTheme.dark())]) {
      testWidgets('meets the tap target, label and contrast guidelines in the $name theme', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await _show(tester, _chooserFrom('choose-station-four-candidates'), theme: theme);
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        expectEveryControlShowsText(tester);
        semantics.dispose();
      });
    }

    for (final phoneScreen in [
      ...PhoneScreen.layoutChecks,
      const PhoneScreen(width: 411, height: 891, textScale: 1),
      const PhoneScreen(width: 411, height: 891, textScale: 2),
    ]) {
      testWidgets('four stations fit at $phoneScreen with no overflow and no technical text', (
        tester,
      ) async {
        await _show(
          tester,
          _chooserFrom('choose-station-four-candidates'),
          phoneScreen: phoneScreen,
        );
        expect(tester.takeException(), isNull);
        expectNoTechnicalText(tester);
        // At large text the sheet scrolls inside, so Cancel can always be reached.
        await tester.ensureVisible(find.widgetWithText(TextButton, englishWords.cancelButton));
        await tester.pump();
        expect(find.widgetWithText(TextButton, englishWords.cancelButton).hitTestable(), findsOne);
      });
    }
  });
}
