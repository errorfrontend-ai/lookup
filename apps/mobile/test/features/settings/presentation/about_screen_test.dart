import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_version.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/features/identify/presentation/support_chat_button.dart';
import 'package:lookup_listener/features/settings/presentation/about_screen.dart';

import '../../../support/english_words.dart';
import '../../../support/example_app_configurations.dart';
import '../../../support/expect_no_technical_text.dart';
import '../../../support/phone_screen.dart';
import '../../../support/tab_screen_harness.dart';
import '../../identify/presentation/identify_screen_harness.dart' show expectMeetsTapGuidelines;
import '../../result/support/result_screen_harness.dart' show expectNoClippedText;

/// About Look Up (P6 design §2.13, Q9 as answered on 11 October 2026; P6-SETTINGS-07).
void main() {
  var backCount = 0;

  Future<TabScreenHarness> show(
    WidgetTester tester, {
    TabScreenHarness? harness,
    PhoneScreen phoneScreen = PhoneScreen.standard,
    ThemeData? theme,
  }) async {
    backCount = 0;
    final shown = harness ?? TabScreenHarness();
    await shown.pump(
      tester,
      AboutScreen(onBack: () => backCount++),
      phoneScreen: phoneScreen,
      theme: theme,
    );
    return shown;
  }

  testWidgets('Back and "About Look Up", "Look Up", the version and what the app does', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await show(tester);
    expect(find.text('About Look Up'), findsOneWidget);
    expect(
      tester.getSemantics(find.text('About Look Up')).getSemanticsData().flagsCollection.isHeader,
      isTrue,
    );
    expect(find.text('Look Up'), findsOneWidget);
    expect(find.text('Version 0.1.0 (build 1)'), findsOneWidget);
    expect(
      find.text(
        'Heard an ad on the radio? Tap Identify while it plays, and Look Up shows the '
        'advertiser\'s buttons: call, chat, directions or website.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.bySemanticsLabel('Back'));
    expect(backCount, 1);
    semantics.dispose();
  });

  test('the version is the one the app reports to the API (AppVersion.current)', () {
    expect(AppVersion.current, '0.1.0+1');
    expect(AboutScreen.versionLineOf(englishWords), 'Version 0.1.0 (build 1)');
    expect(
      AboutScreen.versionLineOf(englishWords, appVersion: '1.2.3+45'),
      'Version 1.2.3 (build 45)',
    );
  });

  testWidgets(
    'with the support number: "Message support on WhatsApp", opening a chat that says hello (S4-D32)',
    (tester) async {
      final harness = await show(tester);
      expect(find.byType(SupportChatButton), findsOneWidget);
      await tester.tap(find.text('Message support on WhatsApp'));
      await tester.pump();
      final number = ExampleAppConfigurations.supportWhatsAppNumber.substring(1);
      expect(harness.launcher.openedAddresses, [
        'https://wa.me/$number?text=Hello%20Look%20Up%20support.',
      ]);
    },
  );

  testWidgets('without the support number: no support link at all', (tester) async {
    await show(
      tester,
      harness: TabScreenHarness(configuration: ExampleAppConfigurations.development()),
    );
    expect(find.byType(SupportChatButton), findsNothing);
    expect(find.textContaining('WhatsApp'), findsNothing);
  });

  group('fits and reads well everywhere (P6 design §4.1)', () {
    for (final (name, theme) in [('light', LookUpTheme.light()), ('dark', LookUpTheme.dark())]) {
      testWidgets('meets the tap target, label and contrast guidelines in the $name theme', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await show(tester, theme: theme);
        await expectMeetsTapGuidelines(tester);
        semantics.dispose();
      });
    }

    for (final phoneScreen in PhoneScreen.layoutChecks) {
      testWidgets('fits on $phoneScreen with no overflow and no clipped text', (tester) async {
        await show(tester, phoneScreen: phoneScreen);
        expect(tester.takeException(), isNull);
        expectNoClippedText(tester);
        expectNoTechnicalText(tester);
      });
    }
  });
}
