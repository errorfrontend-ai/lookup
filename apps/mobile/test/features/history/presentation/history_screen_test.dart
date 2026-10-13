import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsAction;
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/state_icon_circle.dart';
import 'package:lookup_listener/features/history/presentation/history_empty_state.dart';
import 'package:lookup_listener/features/history/presentation/history_entry_row.dart';
import 'package:lookup_listener/features/history/presentation/history_screen.dart';
import 'package:lookup_listener/features/identify/presentation/station_choice_row.dart';
import 'package:lookup_listener/features/settings/presentation/station_picker_row.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';
import 'package:lookup_listener/l10n/app_localizations_en.dart';
import 'package:lookup_listener/l10n/fallback_localizations.dart';

import '../../../support/english_words.dart';
import '../../../support/expect_no_technical_text.dart';
import '../../../support/history_fixtures.dart';
import '../../../support/phone_screen.dart';
import '../../../support/tab_screen_harness.dart';
import '../../identify/presentation/identify_screen_harness.dart'
    show expectEveryControlShowsText, expectMeetsTapGuidelines;
import '../../result/support/result_screen_harness.dart' show expectNoClippedText;

Finder get _rows => find.byType(HistoryEntryRow);

/// The History tab (P6 design §2.9; wireframe History; P6-HISTORY-03, -07 to -13).
void main() {
  // Tuesday 13 October 2026, 15:00 on the phone.
  final now = DateTime(2026, 10, 13, 15);
  final opened = <String>[];

  /// Three results: Station A this morning, Station B (chosen) yesterday evening, and the
  /// advertiser's usual card on Sunday — saved in a mixed order.
  List<StoredHistoryEntryData> threeResults() => [
    StoredHistoryEntryData(
      recognitionId: HistoryFixtures.recognitionIdNumbered(2),
      capturedAtOnPhone: DateTime(2026, 10, 12, 18, 40),
      fixture: 'valid/choose-station',
      chosenStationId: '0192a6c4-1111-4000-8000-000000000002',
    ),
    StoredHistoryEntryData(
      recognitionId: HistoryFixtures.recognitionIdNumbered(1),
      capturedAtOnPhone: DateTime(2026, 10, 13, 9, 12),
    ),
    StoredHistoryEntryData(
      recognitionId: HistoryFixtures.recognitionIdNumbered(3),
      capturedAtOnPhone: DateTime(2026, 10, 11, 7, 55),
      fixture: 'valid/match-client-default',
    ),
  ];

  Future<TabScreenHarness> show(
    WidgetTester tester, {
    List<StoredHistoryEntryData> results = const [],
    PhoneScreen phoneScreen = PhoneScreen.standard,
    ThemeData? theme,
  }) async {
    opened.clear();
    final harness = TabScreenHarness(now: now)..keepInHistory(results);
    await harness.pump(
      tester,
      HistoryScreen(onOpenResult: opened.add),
      phoneScreen: phoneScreen,
      theme: theme,
    );
    return harness;
  }

  testWidgets('the heading reads "History", as a heading (P6-HISTORY-03)', (tester) async {
    final semantics = tester.ensureSemantics();
    await show(tester, results: threeResults());
    expect(find.text('History'), findsOneWidget);
    expect(
      tester.getSemantics(find.text('History')).getSemanticsData().flagsCollection.isHeader,
      isTrue,
    );
    semantics.dispose();
  });

  group('results under "Earlier" (P6-HISTORY-07, -08)', () {
    testWidgets('three results of different times, newest first, under "Earlier" (P6-HISTORY-07)', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await show(tester, results: threeResults());

      expect(find.text('EARLIER'), findsOneWidget, reason: 'drawn in capitals, as the wireframe');
      expect(find.bySemanticsLabel('Earlier'), findsOneWidget, reason: 'read in its own case');
      expect(_rows, findsNWidgets(3));
      final details = [
        for (final element in _rows.evaluate())
          tester
              .widget<Text>(
                find
                    .descendant(of: find.byWidget(element.widget), matching: find.byType(Text))
                    .at(2),
              )
              .data,
      ];
      expect(details, [
        'via Station A · Today, 09:12',
        'via Station B · Yesterday, 18:40',
        'via Station A · Sun, 07:55',
      ]);
      expect(
        tester.getTopLeft(find.text('EARLIER')).dy,
        lessThan(tester.getTopLeft(_rows.first).dy),
      );
      semantics.dispose();
    });

    testWidgets(
      'a row: the first letter, "Brand A — Summer service offer", "via Station A · Today, 09:12" and a chevron (P6-HISTORY-08)',
      (tester) async {
        await show(tester, results: threeResults());
        final firstRow = _rows.first;
        Finder inRow(Finder finder) => find.descendant(of: firstRow, matching: finder);
        expect(inRow(find.text('B')), findsOneWidget, reason: 'the first letter of Brand A');
        expect(inRow(find.text('Brand A — Summer service offer')), findsOneWidget);
        expect(inRow(find.text('via Station A · Today, 09:12')), findsOneWidget);
        expect(inRow(find.byIcon(Icons.chevron_right)), findsOneWidget);
        expectNoTechnicalText(tester, alsoForbidden: ['0199b2c4', '0192a6c4', '+447700900']);
      },
    );

    testWidgets('the letter\'s circle is ink, muted, then accent by the row\'s place', (
      tester,
    ) async {
      await show(tester, results: threeResults());
      final colours = LookUpTokens.light.colours;
      final fills = [
        for (var index = 0; index < 3; index++)
          tester
              .widget<ColoredBox>(
                find.descendant(of: _rows.at(index), matching: find.byType(ColoredBox)).first,
              )
              .color,
      ];
      expect(fills, [colours.ink, colours.muted, colours.accent]);
    });

    testWidgets('every row is at least 72 dp tall (P6-HISTORY-10)', (tester) async {
      for (final phoneScreen in [PhoneScreen.standard, PhoneScreen.layoutChecks.last]) {
        await show(tester, results: threeResults(), phoneScreen: phoneScreen);
        for (var index = 0; index < 3; index++) {
          expect(
            tester.getSize(_rows.at(index)).height,
            greaterThanOrEqualTo(72),
            reason: 'row $index on $phoneScreen',
          );
        }
      }
    });

    testWidgets('a tap on a row opens that saved result (P6-HISTORY-11)', (tester) async {
      await show(tester, results: threeResults());
      await tester.tap(find.text('via Station B · Yesterday, 18:40'));
      await tester.pump();
      expect(opened, [HistoryFixtures.recognitionIdNumbered(2)]);
    });

    testWidgets('a row is one button, read as its two lines', (tester) async {
      final semantics = tester.ensureSemantics();
      await show(tester, results: threeResults());
      final data = tester.getSemantics(_rows.first).getSemanticsData();
      expect(data.label, 'Brand A — Summer service offer\nvia Station A · Today, 09:12');
      expect(data.flagsCollection.isButton, isTrue);
      expect(data.hasAction(SemanticsAction.tap), isTrue);
      semantics.dispose();
    });

    testWidgets(
      'under the list: "Saved results keep working without data — call, chat or get directions any time." (P6-HISTORY-12)',
      (tester) async {
        await show(tester, results: threeResults());
        final note = find.text(
          'Saved results keep working without data — call, chat or get directions any time.',
        );
        expect(note, findsOneWidget);
        expect(tester.getTopLeft(note).dy, greaterThan(tester.getBottomLeft(_rows.last).dy));
      },
    );
  });

  group('nothing saved yet (P6-HISTORY-13)', () {
    testWidgets(
      'a designed empty state: a clock in a circle, "No results yet" and what History is for, with no empty section (P6-HISTORY-13)',
      (tester) async {
        final semantics = tester.ensureSemantics();
        await show(tester);
        expect(find.byType(HistoryEmptyState), findsOneWidget);
        expect(find.byType(StateIconCircle), findsOneWidget);
        expect(
          find.descendant(of: find.byType(StateIconCircle), matching: find.byIcon(Icons.schedule)),
          findsOneWidget,
        );
        expect(find.text('No results yet'), findsOneWidget);
        expect(
          tester
              .getSemantics(find.text('No results yet'))
              .getSemanticsData()
              .flagsCollection
              .isHeader,
          isTrue,
        );
        expect(
          find.text('Ads you identify are saved here, so their buttons work even without data.'),
          findsOneWidget,
        );
        expect(find.text('EARLIER'), findsNothing);
        expect(_rows, findsNothing);
        expect(find.textContaining('Saved results keep working'), findsNothing);
        semantics.dispose();
      },
    );
  });

  testWidgets('a result saved while History is open appears at once', (tester) async {
    final harness = await show(tester);
    expect(find.byType(HistoryEmptyState), findsOneWidget);
    await harness.history.saveResult(
      recognitionId: HistoryFixtures.fixtureRecognitionId,
      answer: HistoryFixtures.answer('valid/match-campaign'),
      capturedAtOnPhone: DateTime(2026, 10, 13, 14, 59),
    );
    await TabScreenHarness.settle(tester);
    expect(find.byType(HistoryEmptyState), findsNothing);
    expect(find.text('via Station A · Today, 14:59'), findsOneWidget);
  });

  testWidgets(
    'History lists no stations: a station appears only as a result\'s (P6-MYSTATION-06)',
    (tester) async {
      await show(tester, results: threeResults());
      expect(find.byType(StationChoiceRow), findsNothing);
      expect(find.byType(StationPickerRow), findsNothing);
    },
  );

  group('fits and reads well everywhere (P6 design §4.1)', () {
    for (final (name, theme) in [('light', LookUpTheme.light()), ('dark', LookUpTheme.dark())]) {
      testWidgets('meets the tap target, label and contrast guidelines in the $name theme', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await show(tester, results: threeResults(), theme: theme);
        await expectMeetsTapGuidelines(tester);
        semantics.dispose();
      });

      testWidgets('the empty state meets the contrast guideline in the $name theme', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await show(tester, theme: theme);
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
        await show(tester, results: threeResults(), phoneScreen: phoneScreen);
        expect(tester.takeException(), isNull);
        expectNoClippedText(tester);
        expectNoTechnicalText(tester);
        await show(tester, phoneScreen: phoneScreen);
        expect(tester.takeException(), isNull);
        expectNoClippedText(tester);
      });
    }

    testWidgets('every control shows words', (tester) async {
      final semantics = tester.ensureSemantics();
      await show(tester, results: threeResults());
      expectEveryControlShowsText(tester);
      semantics.dispose();
    });
  });

  testWidgets(
    'opens in a language Flutter and intl have no names for (a stub Bemba, P6-D47, P6-LOCALISATION-03), with entries of every age',
    (tester) async {
      const bemba = Locale('bem');
      final harness = TabScreenHarness(now: now)
        ..keepInHistory([
          ...threeResults(),
          StoredHistoryEntryData(
            recognitionId: HistoryFixtures.recognitionIdNumbered(4),
            capturedAtOnPhone: DateTime(2026, 10, 3, 14, 32),
          ),
        ]);
      await harness.pump(
        tester,
        HistoryScreen(onOpenResult: (_) {}),
        locale: bemba,
        supportedLocales: const [bemba],
        localizationsDelegates: const [
          _StubBembaWordsDelegate(),
          GlobalWidgetsLocalizations.delegate,
          FallbackMaterialLocalizationsDelegate(),
          FallbackCupertinoLocalizationsDelegate(),
        ],
      );
      expect(tester.takeException(), isNull);
      expect(_rows, findsNWidgets(4));
      expect(find.text('via Station A · Sun, 07:55'), findsOneWidget);
      expect(find.text('via Station A · 3 Oct, 14:32'), findsOneWidget);
      expect(englishWords.historyHeading, 'History');
    },
  );
}

/// A stand-in for `app_bem.arb`: the English words, offered for Bemba, as an ARB file with no
/// translations yet would give them.
final class _StubBembaWordsDelegate extends LocalizationsDelegate<AppLocalizations> {
  const _StubBembaWordsDelegate();

  @override
  bool isSupported(Locale locale) => locale.languageCode == 'bem';

  @override
  Future<AppLocalizations> load(Locale locale) async => AppLocalizationsEn('bem');

  @override
  bool shouldReload(_StubBembaWordsDelegate old) => false;
}
