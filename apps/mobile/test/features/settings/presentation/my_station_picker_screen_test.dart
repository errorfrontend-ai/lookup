import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' show CheckedState;

import 'package:dio/dio.dart' show DioExceptionType, Headers, ResponseBody;
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsAction;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/features/settings/data/my_station_store.dart';
import 'package:lookup_listener/features/settings/data/settings_providers.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';
import 'package:lookup_listener/features/settings/presentation/my_station_picker_screen.dart';
import 'package:lookup_listener/features/settings/presentation/station_picker_row.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/expect_no_technical_text.dart';
import '../../../support/phone_screen.dart';
import '../../../support/tab_screen_harness.dart';
import '../../identify/presentation/identify_screen_harness.dart' show expectEveryControlShowsText;
import '../../result/support/result_screen_harness.dart' show expectNoClippedText;

String _kept(ListenerStation station) => jsonEncode({
  'id': station.id,
  'name': station.name,
  'frequency_label': station.frequencyLabel,
  'city': station.city,
});

const ListenerStation _stationB = ListenerStation(
  id: '0192a6c4-1111-4000-8000-000000000002',
  name: 'Station B',
  frequencyLabel: '104.3 FM',
  city: 'Kitwe',
);

Finder get _rows => find.byType(StationPickerRow);

Finder _rowOf(String title) => find.ancestor(of: find.text(title), matching: _rows);

/// The "My station" picker (P6 design §2.12; P6-MYSTATION-01, -02): exactly the stations the API
/// gave, "No station" first, the kept station even when the list lacks it, and each state of the
/// list.
void main() {
  var doneCount = 0;

  Future<TabScreenHarness> show(
    WidgetTester tester, {
    TabScreenHarness? harness,
    String? stationList = 'valid/two-stations',
    Map<String, Object> preferences = const {},
    PhoneScreen phoneScreen = PhoneScreen.standard,
    ThemeData? theme,
  }) async {
    doneCount = 0;
    final shown = harness ?? TabScreenHarness(preferences: preferences);
    if (stationList != null) shown.answerWithStationList(stationList);
    await shown.pump(
      tester,
      MyStationPickerScreen(onDone: () => doneCount++, now: shown.clock.now),
      phoneScreen: phoneScreen,
      theme: theme,
    );
    return shown;
  }

  List<String> rowTitles(WidgetTester tester) => [
    for (final element in _rows.evaluate())
      tester
          .widget<Text>(
            find
                .descendant(of: find.byWidget(element.widget), matching: find.byType(Text))
                .at((element.widget as StationPickerRow).station == null ? 0 : 1),
          )
          .data!,
  ];

  testWidgets('Back, "My station", and what it is for', (tester) async {
    final semantics = tester.ensureSemantics();
    await show(tester);
    expect(find.bySemanticsLabel('Back'), findsOneWidget);
    expect(find.text('My station'), findsOneWidget);
    expect(find.text('Used when an ad is on more than one station.'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Back'));
    expect(doneCount, 1);
    semantics.dispose();
  });

  group('the list (P6-MYSTATION-02)', () {
    testWidgets(
      'exactly the stations GET /api/v1/stations returned, in its order, after "No station" (P6-MYSTATION-02)',
      (tester) async {
        final harness = await show(tester);
        expect(rowTitles(tester), ['No station', 'Station A', 'Station B']);
        expect(find.text('98.1 FM · Lusaka'), findsOneWidget);
        expect(find.text('104.3 FM · Kitwe'), findsOneWidget);
        final request = harness.adapter.requests.single;
        expect(request.address.path, '/api/v1/stations');
        expect(request.method, 'GET');
      },
    );

    testWidgets('a station with no city shows its frequency alone', (tester) async {
      await show(tester, stationList: 'valid/station-without-city');
      expect(rowTitles(tester), ['No station', 'Station A', 'Station D']);
      expect(find.text('95.7 FM'), findsOneWidget);
    });

    testWidgets('"No station" — "Look Up will ask each time" — is chosen while none is kept', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await show(tester);
      expect(find.text('Look Up will ask each time'), findsOneWidget);
      final noStation = tester.getSemantics(_rowOf('No station')).getSemanticsData();
      expect(noStation.flagsCollection.isChecked, CheckedState.isTrue);
      expect(noStation.flagsCollection.isInMutuallyExclusiveGroup, isTrue);
      expect(noStation.label, 'No station\nLook Up will ask each time');
      final stationA = tester.getSemantics(_rowOf('Station A')).getSemanticsData();
      expect(stationA.flagsCollection.isChecked, CheckedState.isFalse);
      expect(stationA.label, 'Station A, 98.1 FM, Lusaka');
      expect(stationA.hasAction(SemanticsAction.tap), isTrue);
      semantics.dispose();
    });

    testWidgets('the kept station is the chosen one, its radio filled', (tester) async {
      await show(tester, preferences: {MyStationStore.myStationKey: _kept(_stationB)});
      expect(
        find.descendant(of: _rowOf('Station B'), matching: find.byIcon(Icons.radio_button_checked)),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: _rowOf('No station'),
          matching: find.byIcon(Icons.radio_button_unchecked),
        ),
        findsOneWidget,
      );
    });

    testWidgets('every row is at least 56 dp tall', (tester) async {
      await show(tester);
      for (var index = 0; index < 3; index++) {
        expect(tester.getSize(_rows.at(index)).height, greaterThanOrEqualTo(56));
      }
    });
  });

  group('choosing', () {
    testWidgets('a tap on a station keeps it as My station and returns to Settings', (
      tester,
    ) async {
      await show(tester);
      await tester.tap(_rowOf('Station B'));
      await TabScreenHarness.settle(tester);
      expect(doneCount, 1);
      expect(await MyStationStore().read(), _stationB);
      final container = ProviderScope.containerOf(
        tester.element(find.byType(MyStationPickerScreen)),
      );
      expect(container.read(myStationProvider).value, _stationB);
    });

    testWidgets('"No station" clears My station and returns to Settings', (tester) async {
      await show(tester, preferences: {MyStationStore.myStationKey: _kept(_stationB)});
      await tester.tap(_rowOf('No station'));
      await TabScreenHarness.settle(tester);
      expect(doneCount, 1);
      expect(await MyStationStore().read(), isNull);
    });
  });

  testWidgets(
    'a kept station the list no longer has: at the top, chosen, "Not in the current list"; the app never clears it',
    (tester) async {
      const unlisted = ListenerStation(
        id: '0192a6c4-1111-4000-8000-000000000007',
        name: 'Station G',
        frequencyLabel: '92.1 FM',
        city: 'Ndola',
      );
      await show(tester, preferences: {MyStationStore.myStationKey: _kept(unlisted)});
      expect(rowTitles(tester), ['No station', 'Station G', 'Station A', 'Station B']);
      final keptRow = _rowOf('Station G');
      expect(
        find.descendant(of: keptRow, matching: find.text('Not in the current list')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: keptRow, matching: find.byIcon(Icons.radio_button_checked)),
        findsOneWidget,
      );
      expect(await MyStationStore().read(), unlisted);
    },
  );

  group('search, only above 10 stations (gap 33)', () {
    Map<String, Object?> listOf(int count) => {
      'stations': [
        for (var index = 1; index <= count; index++)
          {
            'id': '0192a6c4-1111-4000-8000-${index.toString().padLeft(12, '0')}',
            'name': index == 7 ? 'Radio Phoenix' : 'Station $index',
            'frequency_label': '${80 + index}.1 FM',
            'city': index == 3 ? 'Ndola' : 'Lusaka',
            'logo': null,
          },
      ],
    };

    testWidgets('10 stations: no search field', (tester) async {
      final harness = TabScreenHarness();
      harness.adapter.answerJson(200, listOf(10));
      await show(tester, harness: harness, stationList: null);
      expect(find.byType(TextField), findsNothing);
      expect(_rows, findsNWidgets(11));
    });

    testWidgets(
      '11 stations: "Search stations", "Name, frequency or city", filtering on the phone',
      (tester) async {
        final harness = TabScreenHarness();
        harness.adapter.answerJson(200, listOf(11));
        await show(tester, harness: harness, stationList: null);
        expect(find.byType(TextField), findsOneWidget);
        expect(find.text('Search stations'), findsOneWidget);
        await tester.enterText(find.byType(TextField), 'phoenix');
        await tester.pump();
        expect(rowTitles(tester), ['No station', 'Radio Phoenix']);
        await tester.enterText(find.byType(TextField), 'ndola');
        await tester.pump();
        expect(rowTitles(tester), ['No station', 'Station 3']);
        await tester.enterText(find.byType(TextField), '88.1');
        await tester.pump();
        expect(rowTitles(tester), ['No station', 'Station 8']);
        expect(harness.adapter.requests, hasLength(1), reason: 'no request while searching');
      },
    );
  });

  group('the states of the list (P6 design §2.12)', () {
    testWidgets('loading, nothing kept: a spinner and "Loading stations…"', (tester) async {
      final harness = TabScreenHarness();
      final release = Completer<void>();
      harness.adapter.answerWith((request, cancelFuture) async {
        await release.future;
        final fixture =
            ContractFixtures.readFile('recognition/listener-station-list/valid/two-stations.json')!
                as Map<String, Object?>;
        return ResponseBody.fromString(
          jsonEncode(fixture['response']),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });
      await show(tester, harness: harness, stationList: null);
      expect(find.text('Loading stations…'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(_rows, findsNothing);
      release.complete();
      await TabScreenHarness.settle(tester);
      expect(find.text('Loading stations…'), findsNothing);
      expect(_rows, findsNWidgets(3));
    });

    testWidgets(
      'failed, nothing kept: "Couldn\'t load the stations." and "Try again", which asks again',
      (tester) async {
        final harness = TabScreenHarness();
        harness.adapter.failWithDioType(DioExceptionType.connectionError);
        await show(tester, harness: harness, stationList: null);
        expect(find.text('Couldn\'t load the stations.'), findsOneWidget);
        expect(_rows, findsNothing);
        expectNoTechnicalText(tester);

        harness.answerWithStationList('valid/two-stations');
        await tester.tap(find.widgetWithText(OutlinedButton, 'Try again'));
        await TabScreenHarness.settle(tester);
        expect(find.text('Couldn\'t load the stations.'), findsNothing);
        expect(rowTitles(tester), ['No station', 'Station A', 'Station B']);
        expect(harness.adapter.requests, hasLength(2));
      },
    );

    testWidgets(
      'refresh failed, list kept: "Couldn\'t refresh the list. These are the stations saved on Yesterday, 09:12." over the kept list',
      (tester) async {
        // Kept yesterday at 09:12; seen today at 15:00 the list is old, and the API is busy.
        final harness = TabScreenHarness(now: DateTime(2026, 10, 14, 15));
        final twoStations =
            (ContractFixtures.readFile('recognition/listener-station-list/valid/two-stations.json')!
                    as Map<String, Object?>)['response']!
                as Map<String, Object?>;
        harness.stationListFolder.createSync(recursive: true);
        File('${harness.stationListFolder.path}/station-list.json').writeAsStringSync(
          jsonEncode({
            'format_version': 1,
            'fetched_at': DateTime(2026, 10, 13, 9, 12).toUtc().toIso8601String(),
            'entity_tag': '"stations-1"',
            'stations': twoStations['stations'],
          }),
        );
        harness.adapter.answerJson(503, {
          'error': {'code': 'SERVICE_UNAVAILABLE', 'message': 'Busy.'},
        });
        await show(tester, harness: harness, stationList: null);
        expect(
          find.text(
            'Couldn\'t refresh the list. These are the stations saved on Yesterday, 09:12.',
          ),
          findsOneWidget,
        );
        expect(rowTitles(tester), ['No station', 'Station A', 'Station B']);
        expect(harness.adapter.requests.single.header('If-None-Match'), '"stations-1"');
        expectNoTechnicalText(tester, alsoForbidden: ['Busy.']);
      },
    );

    testWidgets('an empty list: "No stations are listed in Look Up yet."', (tester) async {
      await show(tester, stationList: 'valid/no-stations');
      expect(find.text('No stations are listed in Look Up yet.'), findsOneWidget);
      expect(rowTitles(tester), ['No station']);
    });
  });

  testWidgets('the picker is one of the two places that list stations (P6-MYSTATION-06)', (
    tester,
  ) async {
    await show(tester);
    expect(_rows, findsNWidgets(3));
  });

  group('fits and reads well everywhere (P6 design §4.1)', () {
    for (final (name, theme) in [('light', LookUpTheme.light()), ('dark', LookUpTheme.dark())]) {
      testWidgets('meets the tap target, label and contrast guidelines in the $name theme', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await show(
          tester,
          preferences: {MyStationStore.myStationKey: _kept(_stationB)},
          theme: theme,
        );
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
      testWidgets('fits on $phoneScreen with no overflow and no clipped text', (tester) async {
        await show(tester, phoneScreen: phoneScreen);
        expect(tester.takeException(), isNull);
        expectNoClippedText(tester);
        expectNoTechnicalText(tester);
      });
    }
  });
}
