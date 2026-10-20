import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/history/presentation/history_screen.dart';
import 'package:lookup_listener/features/identify/presentation/choose_station_screen.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/station_choice_row.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';
import 'package:lookup_listener/features/settings/presentation/my_station_picker_screen.dart';
import 'package:lookup_listener/features/settings/presentation/settings_screen.dart';
import 'package:lookup_listener/features/settings/presentation/station_picker_row.dart';

import '../app/listener_app_harness.dart';
import '../support/contract_fixtures.dart';
import '../support/history_fixtures.dart';
import '../support/repository_file_locator.dart';
import 'support/dart_source_tree.dart';
import 'support/temporary_folder_copy.dart';

/// The two places the app lists stations: the chooser sheet and the "My station" picker (D8; P6
/// design §2.1; P6-MYSTATION-06). Elsewhere a station appears only as the station of a result or a
/// History entry.
void main() {
  final libraryFolder = RepositoryFileLocator.mobileAppFolder('lib');

  test('station lists are built only in the chooser and the picker (P6-MYSTATION-06)', () {
    final findings = _stationListsIn(DartSourceTree.read(libraryFolder));
    expect(findings.keys.toSet(), _placesThatListStations);
  });

  group('the scan finds a station list on a copy of lib/ where', () {
    late TemporaryFolderCopy copy;
    late Map<String, List<String>> findings;

    setUpAll(() {
      copy = TemporaryFolderCopy.of(libraryFolder)
        ..writeFile('features/history/presentation/planted_station_loop.dart', '''
import 'package:flutter/widgets.dart';

List<Widget> plantedRows(dynamic list) => [for (final station in list.stations) Text(station.name)];
''')
        ..writeFile('features/settings/presentation/planted_station_map.dart', '''
import 'package:flutter/widgets.dart';

List<Widget> plantedRows(dynamic answer) => answer.candidates.map((candidate) => const SizedBox()).toList();
''')
        ..writeFile('app/planted_picker_row.dart', '''
import 'package:lookup_listener/features/settings/presentation/station_picker_row.dart';

const Type plantedRow = StationPickerRow;
''');
      findings = _stationListsIn(DartSourceTree.read(copy.folder));
    });
    tearDownAll(() => copy.delete());

    test('a screen loops over stations', () {
      expect(findings.keys, contains('features/history/presentation/planted_station_loop.dart'));
    });

    test('a screen maps a chooser\'s candidates', () {
      expect(findings.keys, contains('features/settings/presentation/planted_station_map.dart'));
    });

    test('a screen uses a station row', () {
      expect(findings.keys, contains('app/planted_picker_row.dart'));
    });
  });

  testWidgets(
    'no other screen lists stations: Home, History with two stations\' results, Settings, its pages and a Result (P6-MYSTATION-06)',
    (tester) async {
      final harness = ListenerAppHarness(storedPreferences: {'how_it_works_note_shown': true});
      HistoryFixtures.writeIndex(harness.historyFolder, [
        HistoryFixtures.storedResult(
          recognitionId: HistoryFixtures.recognitionIdNumbered(1),
          capturedAtOnPhone: DateTime.now().subtract(const Duration(minutes: 3)),
        ),
        HistoryFixtures.storedResult(
          recognitionId: HistoryFixtures.recognitionIdNumbered(2),
          capturedAtOnPhone: DateTime.now().subtract(const Duration(minutes: 9)),
          fixture: 'valid/match-campaign-station-b',
        ),
      ]);
      await harness.pumpApp(tester);

      void expectNoStationList(String where) {
        expect(find.byType(StationChoiceRow), findsNothing, reason: where);
        expect(find.byType(StationPickerRow), findsNothing, reason: where);
      }

      expect(find.byType(HomeScreen), findsOneWidget);
      expectNoStationList('Home');

      await tester.tap(find.text('History'));
      await harness.pumpTransition(tester);
      expect(find.byType(HistoryScreen), findsOneWidget);
      expect(find.textContaining('via Station B'), findsOneWidget, reason: 'a result\'s station');
      expectNoStationList('History');

      await tester.tap(find.text('Settings'));
      await harness.pumpTransition(tester);
      expect(find.byType(SettingsScreen), findsOneWidget);
      expectNoStationList('Settings');
      for (final page in ['Privacy', 'About Look Up']) {
        await tester.ensureVisible(find.text(page));
        await tester.pump();
        await tester.tap(find.text(page));
        await harness.pumpTransition(tester);
        expectNoStationList(page);
        await tester.tap(find.bySemanticsLabel('Back'));
        await harness.pumpTransition(tester);
      }

      await tester.tap(find.text('Identify'));
      await harness.pumpTransition(tester);
      harness.answerWithResponseFixture('valid/match-campaign');
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await harness.recordWholeClip(tester);
      expect(find.byType(ResultScreen), findsOneWidget);
      expectNoStationList('the Result');
    },
  );

  testWidgets('the chooser and the picker do list them', (tester) async {
    final harness = ListenerAppHarness();
    harness.answerWithResponseFixture('valid/choose-station');
    await harness.pumpApp(tester);
    await tester.tap(find.text('Tap to identify'));
    await harness.pumpTransition(tester);
    await harness.recordWholeClip(tester);
    expect(find.byType(ChooseStationScreen), findsOneWidget);
    expect(find.byType(StationChoiceRow), findsNWidgets(2));
    await tester.tap(find.descendant(of: find.byType(BottomSheet), matching: find.text('Cancel')));
    await harness.pumpTransition(tester);

    final stationList =
        ContractFixtures.readFile('recognition/listener-station-list/valid/two-stations.json')!
            as Map<String, Object?>;
    harness.adapter.answerJson(200, stationList['response']);
    await tester.tap(find.text('Settings'));
    await harness.pumpTransition(tester);
    await tester.tap(find.text('My station'));
    await harness.pumpTransition(tester);
    await harness.pumpTransition(tester);
    expect(find.byType(MyStationPickerScreen), findsOneWidget);
    expect(find.byType(StationPickerRow), findsNWidgets(3));
  });
}

/// The two files that may list stations (§2.1).
const Set<String> _placesThatListStations = {
  'features/identify/presentation/choose_station_screen.dart',
  'features/settings/presentation/my_station_picker_screen.dart',
};

/// The station rows' own files, which declare them and list nothing.
const Set<String> _stationRowFiles = {
  'features/identify/presentation/station_choice_row.dart',
  'features/settings/presentation/station_picker_row.dart',
};

/// What builds a list of stations in widget code: a loop or a map over `stations` or `candidates`,
/// or a station row.
final List<RegExp> _stationListPatterns = [
  RegExp(r'\bfor\s*\([^;)]*\bin\b[^)]*\b(?:stations|candidates|shownStations)\b'),
  RegExp(r'\b(?:stations|candidates|shownStations)\s*\.\s*(?:map|indexed|expand|forEach)\b'),
  RegExp(r'(?<![\w$])(?:StationChoiceRow|StationPickerRow)\b'),
];

/// The widget-code files of [tree] that build a station list, with what was found in each.
Map<String, List<String>> _stationListsIn(DartSourceTree tree) {
  final widgetCode = RegExp(r'^(?:app/|core/widgets/|features/\w+/presentation/)');
  return {
    for (final file in tree.files)
      if (widgetCode.hasMatch(file.path) && !_stationRowFiles.contains(file.path))
        if ([
              for (final pattern in _stationListPatterns)
                for (final match in pattern.allMatches(file.code)) match.group(0)!,
            ]
            case final found when found.isNotEmpty)
          file.path: found,
  };
}
