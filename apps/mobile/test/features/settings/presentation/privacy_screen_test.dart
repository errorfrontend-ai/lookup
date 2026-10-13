import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/features/settings/presentation/privacy_screen.dart';

import '../../../support/expect_no_technical_text.dart';
import '../../../support/phone_screen.dart';
import '../../../support/tab_screen_harness.dart';
import '../../identify/presentation/identify_screen_harness.dart' show expectMeetsTapGuidelines;
import '../../result/support/result_screen_harness.dart' show expectNoClippedText;

/// Privacy, the interim summary (P6 design §2.13, Q9 as answered on 11 October 2026;
/// P6-SETTINGS-06).
void main() {
  var backCount = 0;

  Future<void> show(
    WidgetTester tester, {
    PhoneScreen phoneScreen = PhoneScreen.standard,
    ThemeData? theme,
  }) async {
    backCount = 0;
    await TabScreenHarness().pump(
      tester,
      PrivacyScreen(onBack: () => backCount++),
      phoneScreen: phoneScreen,
      theme: theme,
    );
  }

  testWidgets(
    'Back and "Privacy", then the points of this version, in order, each after a tick screen readers skip',
    (tester) async {
      final semantics = tester.ensureSemantics();
      await show(tester);
      expect(find.text('Privacy'), findsOneWidget);
      expect(
        tester.getSemantics(find.text('Privacy')).getSemanticsData().flagsCollection.isHeader,
        isTrue,
      );
      const points = [
        'Look Up listens only when you tap Identify, for about 8 seconds.',
        'The clip is sent to Look Up to find the ad, and is not kept after it has been checked.',
        'Radio stations see how many people used their buttons — never who you are.',
        'Your History stays on this phone. You can clear it in Settings.',
      ];
      final tops = [for (final point in points) tester.getTopLeft(find.text(point)).dy];
      expect(tops, [...tops]..sort());
      expect(find.byIcon(Icons.check), findsNWidgets(points.length));
      expect(
        find.descendant(of: find.byType(ExcludeSemantics), matching: find.byIcon(Icons.check)),
        findsNWidgets(points.length),
        reason: 'the ticks are decoration',
      );
      expect(
        find.text(
          'This is a short summary. The full privacy notice comes before Look Up\'s public release.',
        ),
        findsOneWidget,
      );
      semantics.dispose();
    },
  );

  testWidgets('says nothing this version does not do yet: no clips kept offline, no reports', (
    tester,
  ) async {
    await show(tester);
    expect(find.textContaining('24 hours'), findsNothing);
    expect(find.textContaining('report'), findsNothing);
  });

  testWidgets('Back returns to Settings', (tester) async {
    final semantics = tester.ensureSemantics();
    await show(tester);
    await tester.tap(find.bySemanticsLabel('Back'));
    expect(backCount, 1);
    semantics.dispose();
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
