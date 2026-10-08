import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';

import 'listener_app_harness.dart';

void main() {
  testWidgets('"Look Up", the light theme from the tokens only, and no debug banner', (
    tester,
  ) async {
    await ListenerAppHarness().pumpApp(tester);
    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.title, 'Look Up');
    expect(app.themeMode, ThemeMode.light);
    expect(app.darkTheme, isNull);
    expect(app.debugShowCheckedModeBanner, isFalse);
    expect(app.theme, LookUpTheme.light());
    expect(app.theme!.extension<LookUpTokens>(), LookUpTokens.light);
    expect(app.routerConfig, isNotNull);
  });

  testWidgets('starts at Home', (tester) async {
    final harness = ListenerAppHarness();
    await harness.pumpApp(tester);
    expect(harness.location(tester), '/');
    expect(find.byType(HomeScreen), findsOneWidget);
  });
}
