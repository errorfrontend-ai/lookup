import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/main_navigation_bar.dart';
import 'package:lookup_listener/app/main_navigation_rail.dart';
import 'package:lookup_listener/app/result_beside_home.dart';
import 'package:lookup_listener/core/layout/window_size_class.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/features/history/presentation/history_screen.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/listening_screen.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';
import 'package:lookup_listener/features/settings/presentation/privacy_screen.dart';
import 'package:lookup_listener/features/settings/presentation/settings_screen.dart';

import '../support/english_words.dart';
import '../support/phone_screen.dart';
import 'listener_app_harness.dart';

const PhoneScreen _mediumTablet = PhoneScreen(width: 700, height: 1000, textScale: 1);
const PhoneScreen _smallTabletUpright = PhoneScreen(width: 800, height: 1280, textScale: 1);
const PhoneScreen _tabletOnItsSide = PhoneScreen(width: 1280, height: 800, textScale: 1);
const PhoneScreen _phoneOnItsSide = PhoneScreen(width: 800, height: 360, textScale: 1);

/// The app on windows wider than a phone held upright (P6 design §3.19; P6-RESULT-02,
/// P6-RESPONSIVE-03 to -05, -07; T52).
void main() {
  Future<ListenerAppHarness> showAResult(WidgetTester tester, PhoneScreen screen) async {
    final harness = ListenerAppHarness();
    await harness.pumpApp(tester, phoneScreen: screen);
    harness.answerWithResponseFixture('valid/match-campaign');
    await tester.ensureVisible(find.text(englishWords.identifyButtonLabel));
    await tester.pump();
    await tester.tap(find.text(englishWords.identifyButtonLabel));
    await harness.pumpTransition(tester);
    await harness.recordWholeClip(tester);
    await harness.pumpTransition(tester);
    expect(harness.location(tester), '/result');
    return harness;
  }

  testWidgets(
    'at 700 dp (medium) the Result sits in a side panel beside Home, with the rail at the '
    'left (P6-RESPONSIVE-04, P6-RESULT-02)',
    (tester) async {
      await showAResult(tester, _mediumTablet);
      expect(find.byType(MainNavigationRail), findsOneWidget);
      expect(find.byType(MainNavigationBar), findsNothing);
      expect(find.byType(HomeScreen), findsOneWidget);
      expect(find.byType(ResultScreen), findsOneWidget);
      final home = tester.getRect(find.byType(HomeScreen));
      final result = tester.getRect(find.byType(ResultScreen));
      expect(result.width, greaterThanOrEqualTo(ResultBesideHome.minimumPanelWidth));
      expect(result.right, _mediumTablet.width);
      expect(home.right, lessThanOrEqualTo(result.left));
      expect(find.text(englishWords.identifyButtonLabel), findsOneWidget, reason: 'Home is live');
      expect(find.text('Call us'), findsOneWidget);
    },
  );

  testWidgets('T52: "Tap to identify" beside the Result starts a new capture', (tester) async {
    final harness = await showAResult(tester, _mediumTablet);
    await tester.tap(find.text(englishWords.identifyButtonLabel));
    await harness.pumpTransition(tester);
    expect(harness.state(tester), isA<RecordingState>());
    expect(harness.location(tester), '/listening');
    expect(find.byType(ListeningScreen), findsOneWidget);
  });

  testWidgets('a rail tab beside the Result leaves the Result for that tab', (tester) async {
    final harness = await showAResult(tester, _mediumTablet);
    await tester.tap(
      find.descendant(
        of: find.byType(MainNavigationRail),
        matching: find.text(englishWords.tabHistory),
      ),
    );
    await harness.pumpTransition(tester);
    expect(harness.state(tester), isA<IdleState>());
    expect(harness.location(tester), '/history');
    expect(find.byType(HistoryScreen), findsOneWidget);
  });

  testWidgets(
    'from 600 dp until Home has room beside a 360 dp panel, the Result stays full screen',
    (tester) async {
      const justMedium = PhoneScreen(width: 620, height: 1000, textScale: 1);
      expect(WindowSizeClass.forWidth(justMedium.width), WindowSizeClass.medium);
      expect(
        ResultBesideHome.panelWidthIn(justMedium.width, sizeClass: WindowSizeClass.medium),
        isNull,
      );
      await showAResult(tester, justMedium);
      expect(find.byType(HomeScreen), findsNothing);
      expect(tester.getRect(find.byType(ResultScreen)).width, justMedium.width);
    },
  );

  testWidgets('at 800 × 1280 the Result panel is 360 dp, and Home keeps the rest (P6-RESULT-02)', (
    tester,
  ) async {
    await showAResult(tester, _smallTabletUpright);
    expect(tester.getRect(find.byType(ResultScreen)).width, ResultBesideHome.minimumPanelWidth);
    expect(tester.getRect(find.byType(HomeScreen)).width, greaterThan(300));
  });

  testWidgets('at 1280 × 800 (expanded) Home and History are side by side; a Result takes '
      "History's place (P6-RESPONSIVE-05)", (tester) async {
    final harness = ListenerAppHarness();
    await harness.pumpApp(tester, phoneScreen: _tabletOnItsSide);
    expect(find.byType(HomeScreen), findsOneWidget);
    expect(find.byType(HistoryScreen), findsOneWidget);
    expect(
      tester.getRect(find.byType(HomeScreen)).right,
      lessThanOrEqualTo(tester.getRect(find.byType(HistoryScreen)).left),
    );

    harness.answerWithResponseFixture('valid/match-campaign');
    await tester.tap(find.text(englishWords.identifyButtonLabel));
    await harness.pumpTransition(tester);
    await harness.recordWholeClip(tester);
    await harness.pumpTransition(tester);
    expect(find.byType(HomeScreen), findsOneWidget);
    expect(find.byType(ResultScreen), findsOneWidget);
    expect(find.byType(HistoryScreen), findsNothing);
    expect(
      tester.getRect(find.byType(ResultScreen)).width,
      closeTo(_tabletOnItsSide.width * ResultBesideHome.panelShare, 1),
    );
  });

  testWidgets('at 1280 × 800 a row of History opens its saved result beside the list; Back '
      'closes it and the list stays', (tester) async {
    final harness = await showAResult(tester, _tabletOnItsSide);
    await tester.tap(find.byType(ScreenExitButton));
    await harness.pumpTransition(tester);
    await tester.tap(
      find.descendant(
        of: find.byType(MainNavigationRail),
        matching: find.text(englishWords.tabHistory),
      ),
    );
    await harness.pumpTransition(tester);
    expect(find.text(englishWords.historyPaneNote), findsOneWidget);

    await tester.tap(find.text('Brand A — Summer service offer').last);
    await harness.pumpTransition(tester);
    expect(harness.location(tester), '/history', reason: 'no page over the tabs');
    expect(find.byType(HistoryScreen), findsOneWidget);
    expect(find.byType(ResultScreen), findsOneWidget);
    expect(find.text(englishWords.savedResultHeading), findsOneWidget);

    await tester.tap(
      find.descendant(of: find.byType(ResultScreen), matching: find.byType(ScreenExitButton)),
    );
    await harness.pumpTransition(tester);
    expect(find.byType(ResultScreen), findsNothing);
    expect(find.text(englishWords.historyPaneNote), findsOneWidget);
  });

  testWidgets('at 1280 × 800 Settings opens Privacy beside the list', (tester) async {
    final harness = ListenerAppHarness();
    await harness.pumpApp(tester, phoneScreen: _tabletOnItsSide);
    await tester.tap(
      find.descendant(
        of: find.byType(MainNavigationRail),
        matching: find.text(englishWords.tabSettings),
      ),
    );
    await harness.pumpTransition(tester);
    expect(find.text(englishWords.settingsPaneNote), findsOneWidget);
    await tester.tap(find.text(englishWords.settingsPrivacy));
    await harness.pumpTransition(tester);
    expect(harness.location(tester), '/settings');
    expect(find.byType(SettingsScreen), findsOneWidget);
    expect(find.byType(PrivacyScreen), findsOneWidget);
  });

  testWidgets('at 1280 × 800 a flow screen is one centred column at most 600 dp wide', (
    tester,
  ) async {
    final harness = ListenerAppHarness();
    await harness.pumpApp(tester, phoneScreen: _tabletOnItsSide);
    await tester.tap(find.text(englishWords.identifyButtonLabel));
    await harness.pumpTransition(tester);
    expect(harness.location(tester), '/listening');
    final heading = tester.getRect(find.text(englishWords.listeningHeading));
    expect(heading.left, greaterThanOrEqualTo((_tabletOnItsSide.width - 600) / 2));
    expect(heading.right, lessThanOrEqualTo((_tabletOnItsSide.width + 600) / 2));
  });

  testWidgets('a phone on its side (800 × 360) is medium: Home, Listening, the Result beside Home '
      'and History reflow with nothing cut (P6-RESPONSIVE-07)', (tester) async {
    final harness = await showAResult(tester, _phoneOnItsSide);
    expect(find.byType(ResultScreen), findsOneWidget);
    expect(find.byType(HomeScreen), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byType(MainNavigationRail),
        matching: find.text(englishWords.tabHistory),
      ),
    );
    await harness.pumpTransition(tester);
    expect(find.byType(HistoryScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
