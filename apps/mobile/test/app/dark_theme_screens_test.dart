import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/configuration_problem.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/set_up_problem_screen.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/presentation/busy_screen.dart';
import 'package:lookup_listener/features/identify/presentation/error_screen.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/identifying_screen.dart';
import 'package:lookup_listener/features/identify/presentation/listening_screen.dart';
import 'package:lookup_listener/features/identify/presentation/no_match_screen.dart';
import 'package:lookup_listener/features/identify/presentation/permission_screen.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';

import '../features/identify/presentation/identify_screen_harness.dart';
import '../features/result/support/result_screen_harness.dart';
import '../support/english_words.dart';
import '../support/example_app_configurations.dart';
import '../support/phone_screen.dart';

/// Every Step 4 screen in the dark theme the app shows when the phone is set to dark (design
/// §3.18; P6-THEME-01, P6-ACCESSIBILITY-03): it builds, it is dark, and its text meets the contrast
/// guideline there too. The light theme's checks stay in each screen's own test.
void main() {
  final darkTheme = LookUpTheme.dark();

  Future<void> expectDarkAndReadable(WidgetTester tester, Finder screen) async {
    expect(tester.takeException(), isNull);
    final theme = Theme.of(tester.element(screen));
    expect(theme.brightness, Brightness.dark);
    expect(theme.extension<LookUpTokens>(), LookUpTokens.dark);
    await expectLater(tester, meetsGuideline(textContrastGuideline));
  }

  final identifyScreens = <String, Widget>{
    'Home': HomeScreen(onOpenSettings: () {}),
    'Permission, never asked': const PermissionScreen(
      microphoneAccess: MicrophoneAccess.notAskedYet,
    ),
    'Permission, refused once': const PermissionScreen(
      microphoneAccess: MicrophoneAccess.refusedOnce,
    ),
    'Permission, refused for good': const PermissionScreen(
      microphoneAccess: MicrophoneAccess.refusedForGood,
    ),
    'Listening': const ListeningScreen(levelFraction: 0.6, secondsLeft: 5),
    'Identifying': const IdentifyingScreen(),
    'Busy': const BusyScreen(retryDelaySeconds: 10, secondsUntilRetry: 6),
    'No match': const NoMatchScreen(),
    'Error, server failure with its code': const ErrorScreen(
      failure: ServerFailure(requestId: '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f'),
    ),
    'Error, recording unusable': const ErrorScreen(
      failure: RecordingUnusableFailure(requestId: '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f'),
    ),
    'Error, no connection': const ErrorScreen(failure: ConnectionFailure()),
    'Error, too many tries': const ErrorScreen(failure: TooManyTriesFailure(isShortWait: true)),
    'Error, newer app': const ErrorScreen(failure: NewerAppNeededFailure()),
  };

  for (final MapEntry(key: name, value: screen) in identifyScreens.entries) {
    testWidgets('$name is dark and readable', (tester) async {
      final semantics = tester.ensureSemantics();
      await IdentifyScreenHarness(
        configuration: ExampleAppConfigurations.development(),
      ).pump(tester, screen, theme: darkTheme);
      await tester.pump();

      await expectDarkAndReadable(tester, find.byWidget(screen));
      semantics.dispose();
    });
  }

  testWidgets('Result, a campaign card, is dark and readable', (tester) async {
    final semantics = tester.ensureSemantics();
    await ResultScreenHarness().pumpResultScreen(tester, resultWith(), theme: darkTheme);

    await expectDarkAndReadable(tester, find.text(englishWords.resultFoundIt));
    semantics.dispose();
  });

  testWidgets("Result, the advertiser's usual card, is dark and readable", (tester) async {
    final semantics = tester.ensureSemantics();
    await ResultScreenHarness().pumpResultScreen(
      tester,
      resultWith(
        kind: RecognitionResultKind.clientDefault,
        card: fixtureCard('action-card/valid/six-actions.json'),
      ),
      theme: darkTheme,
    );

    await expectDarkAndReadable(tester, find.text(englishWords.resultFoundIt));
    expect(find.text(englishWords.defaultCardNote('Brand A')), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('the copy sheet is dark and readable', (tester) async {
    final semantics = tester.ensureSemantics();
    final harness = ResultScreenHarness(launcherOpens: false);
    await harness.pumpResultScreen(tester, resultWith(), theme: darkTheme);
    await tester.tap(find.text('Call us'));
    await tester.pumpAndSettle();

    await expectDarkAndReadable(tester, find.text(englishWords.launchFailureHeading));
    semantics.dispose();
  });

  testWidgets('the set-up problem screen is dark and readable', (tester) async {
    final semantics = tester.ensureSemantics();
    const screen = SetUpProblemScreen(
      problems: [ConfigurationProblem.apiBaseUrlMissing],
      showsProblems: true,
    );
    await PhoneScreen.standard.pump(tester, screen, theme: darkTheme);

    await expectDarkAndReadable(tester, find.byWidget(screen));
    expect(find.text(englishWords.configurationProblemApiBaseUrlMissing), findsOneWidget);
    semantics.dispose();
  });
}
