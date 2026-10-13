import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsAction;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/station_choice_row.dart';
import 'package:lookup_listener/features/settings/data/my_station_store.dart';
import 'package:lookup_listener/features/settings/presentation/settings_row.dart';
import 'package:lookup_listener/features/settings/presentation/settings_screen.dart';
import 'package:lookup_listener/features/settings/presentation/station_picker_row.dart';

import '../../../support/expect_no_technical_text.dart';
import '../../../support/history_fixtures.dart';
import '../../../support/phone_screen.dart';
import '../../../support/tab_screen_harness.dart';
import '../../identify/presentation/identify_screen_harness.dart' show expectEveryControlShowsText;
import '../../result/support/result_screen_harness.dart' show expectNoClippedText;

/// "My station" as `shared_preferences` keeps it: Station A on 98.1 FM in Lusaka.
final Map<String, Object> _stationAKept = {
  MyStationStore.myStationKey: jsonEncode({
    'id': '0192a6c4-1111-4000-8000-000000000001',
    'name': 'Station A',
    'frequency_label': '98.1 FM',
    'city': 'Lusaka',
  }),
};

Finder _row(String title) =>
    find.ancestor(of: find.text(title), matching: find.byType(SettingsRow)).first;

/// The Settings tab (P6 design §2.11; wireframe Settings; P6-SETTINGS-01 to -07).
void main() {
  final opened = <String>[];

  Future<TabScreenHarness> show(
    WidgetTester tester, {
    Map<String, Object> preferences = const {},
    PhoneScreen phoneScreen = PhoneScreen.standard,
    ThemeData? theme,
  }) async {
    opened.clear();
    final harness = TabScreenHarness(preferences: preferences);
    await harness.pump(
      tester,
      SettingsScreen(
        onOpenMyStation: () => opened.add('my station'),
        onOpenPrivacy: () => opened.add('privacy'),
        onOpenAbout: () => opened.add('about'),
      ),
      phoneScreen: phoneScreen,
      theme: theme,
    );
    return harness;
  }

  testWidgets('the heading reads "Settings", as a heading (P6-SETTINGS-01)', (tester) async {
    final semantics = tester.ensureSemantics();
    await show(tester);
    expect(find.text('Settings'), findsOneWidget);
    expect(
      tester.getSemantics(find.text('Settings')).getSemanticsData().flagsCollection.isHeader,
      isTrue,
    );
    semantics.dispose();
  });

  group('Listening: My station (P6-SETTINGS-02 to -04)', () {
    testWidgets('a "Listening" section holds the "My station" row (P6-SETTINGS-02)', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await show(tester);
      expect(find.text('LISTENING'), findsOneWidget, reason: 'drawn in capitals');
      expect(find.bySemanticsLabel('Listening'), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('LISTENING')).dy,
        lessThan(tester.getTopLeft(_row('My station')).dy),
      );
      expect(
        tester.getTopLeft(_row('My station')).dy,
        lessThan(tester.getTopLeft(find.text('APP')).dy),
      );
      semantics.dispose();
    });

    testWidgets(
      'with Station A kept: "Station A · 98.1 FM — used when an ad is on more than one station" and a chevron (P6-SETTINGS-03)',
      (tester) async {
        await show(tester, preferences: _stationAKept);
        final row = _row('My station');
        expect(
          find.descendant(
            of: row,
            matching: find.text(
              'Station A · 98.1 FM — used when an ad is on more than one station',
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: row, matching: find.byIcon(Icons.chevron_right)),
          findsOneWidget,
        );
      },
    );

    testWidgets('with none: "Not set — used when an ad is on more than one station"', (
      tester,
    ) async {
      await show(tester);
      expect(
        find.descendant(
          of: _row('My station'),
          matching: find.text('Not set — used when an ad is on more than one station'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('the row is at least 64 dp tall and opens the picker (P6-SETTINGS-04)', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      for (final phoneScreen in [PhoneScreen.standard, PhoneScreen.layoutChecks.last]) {
        await show(tester, preferences: _stationAKept, phoneScreen: phoneScreen);
        expect(tester.getSize(_row('My station')).height, greaterThanOrEqualTo(64));
      }
      await show(tester, preferences: _stationAKept);
      final data = tester.getSemantics(_row('My station')).getSemanticsData();
      expect(data.flagsCollection.isButton, isTrue);
      expect(
        data.label,
        'My station\nStation A · 98.1 FM — used when an ad is on more than one station',
      );
      await tester.tap(_row('My station'));
      expect(opened, ['my station']);
      semantics.dispose();
    });
  });

  group('App (P6-SETTINGS-05 to -07)', () {
    testWidgets('"Language" shows "English", and is not a control (P6-SETTINGS-05)', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await show(tester);
      expect(find.text('APP'), findsOneWidget);
      final row = _row('Language');
      expect(find.descendant(of: row, matching: find.text('English')), findsOneWidget);
      final data = tester.getSemantics(row).getSemanticsData();
      expect(data.label, 'Language\nEnglish');
      expect(data.flagsCollection.isButton, isFalse);
      expect(data.hasAction(SemanticsAction.tap), isFalse);
      semantics.dispose();
    });

    testWidgets('"Privacy" opens the privacy page (P6-SETTINGS-06)', (tester) async {
      await show(tester);
      expect(
        find.descendant(of: _row('Privacy'), matching: find.byIcon(Icons.chevron_right)),
        findsOneWidget,
      );
      await tester.tap(_row('Privacy'));
      expect(opened, ['privacy']);
    });

    testWidgets('"About Look Up" opens the about page (P6-SETTINGS-07)', (tester) async {
      await show(tester);
      await tester.tap(_row('About Look Up'));
      expect(opened, ['about']);
    });

    testWidgets('no Data section before its switch works (piece 4)', (tester) async {
      await show(tester);
      expect(find.text('DATA'), findsNothing);
      expect(find.byType(Switch), findsNothing);
    });
  });

  group('"Clear history" (Q7)', () {
    testWidgets('is in the danger colour, and asks first', (tester) async {
      await show(tester);
      final title = tester.widget<Text>(find.text('Clear history'));
      expect(title.style!.color, LookUpTokens.light.colours.danger);
      await tester.tap(_row('Clear history'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text('Clear history?'), findsOneWidget);
      expect(
        find.text('Saved results and any clips waiting to be sent are deleted from this phone.'),
        findsOneWidget,
      );
      expect(find.widgetWithText(TextButton, 'Cancel'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Clear'), findsOneWidget);
    });

    testWidgets('"Cancel" keeps History as it was', (tester) async {
      final harness = TabScreenHarness();
      harness.keepInHistory([
        StoredHistoryEntryData(
          recognitionId: HistoryFixtures.fixtureRecognitionId,
          capturedAtOnPhone: DateTime(2026, 10, 13, 9, 12),
        ),
      ]);
      await harness.pump(
        tester,
        SettingsScreen(onOpenMyStation: () {}, onOpenPrivacy: () {}, onOpenAbout: () {}),
      );
      await tester.tap(_row('Clear history'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(HistoryFixtures.readIndexEntries(harness.historyFolder), hasLength(1));
      expect(find.text('History cleared'), findsNothing);
    });

    testWidgets('"Clear" deletes what History keeps, then says "History cleared"', (tester) async {
      final harness = TabScreenHarness();
      harness.keepInHistory([
        StoredHistoryEntryData(
          recognitionId: HistoryFixtures.fixtureRecognitionId,
          capturedAtOnPhone: DateTime(2026, 10, 13, 9, 12),
        ),
      ]);
      await harness.pump(
        tester,
        Scaffold(
          body: SettingsScreen(onOpenMyStation: () {}, onOpenPrivacy: () {}, onOpenAbout: () {}),
        ),
      );
      await tester.tap(_row('Clear history'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Clear'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(HistoryFixtures.readIndexEntries(harness.historyFolder), isEmpty);
      expect((await harness.history.readView()).isEmpty, isTrue);
      expect(find.text('History cleared'), findsOneWidget);
    });
  });

  testWidgets('Settings lists no stations: only the picker does (P6-MYSTATION-06)', (tester) async {
    await show(tester, preferences: _stationAKept);
    expect(find.byType(StationChoiceRow), findsNothing);
    expect(find.byType(StationPickerRow), findsNothing);
  });

  group('fits and reads well everywhere (P6 design §4.1)', () {
    for (final (name, theme) in [('light', LookUpTheme.light()), ('dark', LookUpTheme.dark())]) {
      testWidgets('meets the tap target, label and contrast guidelines in the $name theme', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await show(tester, preferences: _stationAKept, theme: theme);
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        expectEveryControlShowsText(tester);
        semantics.dispose();
      });

      testWidgets('the "Clear history?" question meets the guidelines in the $name theme', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await show(tester, theme: theme);
        await tester.tap(_row('Clear history'));
        await tester.pumpAndSettle();
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        semantics.dispose();
      });
    }

    for (final phoneScreen in [
      ...PhoneScreen.layoutChecks,
      const PhoneScreen(width: 411, height: 891, textScale: 1),
      const PhoneScreen(width: 411, height: 891, textScale: 2),
    ]) {
      testWidgets('fits on $phoneScreen with no overflow and no clipped text', (tester) async {
        await show(tester, preferences: _stationAKept, phoneScreen: phoneScreen);
        expect(tester.takeException(), isNull);
        expectNoClippedText(tester);
        expectNoTechnicalText(tester);
      });
    }
  });
}
