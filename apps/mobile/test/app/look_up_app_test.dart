import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';
import 'package:lookup_listener/l10n/fallback_localizations.dart';

import '../support/english_words.dart';
import 'listener_app_harness.dart';

void main() {
  testWidgets('"Look Up", both themes from the tokens, the phone\'s theme mode, no debug banner '
      '(P6-THEME-01)', (tester) async {
    await ListenerAppHarness().pumpApp(tester);
    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    final homeContext = tester.element(find.byType(HomeScreen));
    expect(app.onGenerateTitle!(homeContext), 'Look Up');
    expect(app.themeMode, ThemeMode.system);
    expect(app.debugShowCheckedModeBanner, isFalse);
    expect(app.theme, LookUpTheme.light());
    expect(app.theme!.extension<LookUpTokens>(), LookUpTokens.light);
    expect(app.darkTheme, LookUpTheme.dark());
    expect(app.darkTheme!.extension<LookUpTokens>(), LookUpTokens.dark);
    expect(app.routerConfig, isNotNull);
  });

  testWidgets('the words come from the ARB files, with the fallbacks for other languages '
      '(P6-LOCALISATION-01, -03)', (tester) async {
    await ListenerAppHarness().pumpApp(tester);
    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.localizationsDelegates, FallbackLocalizations.delegates);
    expect(app.supportedLocales, AppLocalizations.supportedLocales);
    expect(find.text(englishWords.homeHeading), findsOneWidget);
    expect(find.text(englishWords.identifyButtonLabel), findsOneWidget);
  });

  testWidgets('follows the phone: dark when it is set to dark, light again when it is not', (
    tester,
  ) async {
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    await ListenerAppHarness().pumpApp(tester);
    Color homeBackground() =>
        tester.widget<Scaffold>(find.byType(Scaffold)).backgroundColor ??
        Theme.of(tester.element(find.byType(HomeScreen))).scaffoldBackgroundColor;

    var theme = Theme.of(tester.element(find.byType(HomeScreen)));
    expect(theme.brightness, Brightness.dark);
    expect(theme.extension<LookUpTokens>(), LookUpTokens.dark);
    expect(homeBackground(), LookUpColours.dark.ground);

    tester.platformDispatcher.platformBrightnessTestValue = Brightness.light;
    await tester.pumpAndSettle();

    theme = Theme.of(tester.element(find.byType(HomeScreen)));
    expect(theme.brightness, Brightness.light);
    expect(theme.extension<LookUpTokens>(), LookUpTokens.light);
    expect(homeBackground(), LookUpColours.light.ground);
  });

  testWidgets('starts at Home', (tester) async {
    final harness = ListenerAppHarness();
    await harness.pumpApp(tester);
    expect(harness.location(tester), '/');
    expect(find.byType(HomeScreen), findsOneWidget);
  });
}
