import 'dart:ui' show SemanticsRole, Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsAction;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/main_navigation_bar.dart';
import 'package:lookup_listener/app/main_navigation_item.dart';
import 'package:lookup_listener/app/main_navigation_rail.dart';
import 'package:lookup_listener/app/main_tab.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

import '../features/identify/presentation/identify_screen_harness.dart'
    show expectEveryControlShowsText;
import '../features/result/support/result_screen_harness.dart' show expectNoClippedText;
import '../support/phone_screen.dart';

/// The tab bar and the rail (P6 design §2.2; wireframes Main, History and Settings;
/// P6-NAVIGATION-01, -02, P6-ACCESSIBILITY-06).
void main() {
  final selected = <MainTab>[];

  Future<void> showBar(
    WidgetTester tester, {
    MainTab currentTab = MainTab.identify,
    PhoneScreen phoneScreen = PhoneScreen.standard,
    ThemeData? theme,
  }) async {
    selected.clear();
    await phoneScreen.pump(
      tester,
      Scaffold(
        body: const SizedBox.expand(),
        bottomNavigationBar: MainNavigationBar(currentTab: currentTab, onSelected: selected.add),
      ),
      theme: theme,
    );
  }

  Finder item(String label) =>
      find.ancestor(of: find.text(label), matching: find.byType(MainNavigationItem));

  group('the bar (P6-NAVIGATION-01, -02)', () {
    testWidgets(
      'exactly three destinations, in this order: Identify, History and Settings (P6-NAVIGATION-01)',
      (tester) async {
        await showBar(tester);
        expect(find.byType(MainNavigationItem), findsNWidgets(3));
        final lefts = [
          for (final label in ['Identify', 'History', 'Settings'])
            tester.getTopLeft(item(label)).dx,
        ];
        expect(lefts, [...lefts]..sort());
        expect(MainTab.values, [MainTab.identify, MainTab.history, MainTab.settings]);
      },
    );

    testWidgets(
      'a microphone, a clock and sliders, each with its label under it, in three equal columns (P6-NAVIGATION-02)',
      (tester) async {
        await showBar(tester);
        for (final (label, icon) in [
          ('Identify', Icons.mic_none),
          ('History', Icons.schedule),
          ('Settings', Icons.tune),
        ]) {
          final iconFinder = find.descendant(of: item(label), matching: find.byIcon(icon));
          expect(iconFinder, findsOneWidget, reason: label);
          expect(
            tester.getBottomLeft(iconFinder).dy,
            lessThanOrEqualTo(tester.getTopLeft(find.text(label)).dy),
            reason: '$label under its icon',
          );
        }
        final widths = [
          for (final label in ['Identify', 'History', 'Settings'])
            tester.getSize(item(label)).width,
        ];
        expect(widths.toSet(), hasLength(1), reason: 'equal columns: $widths');
        expect(widths.first * 3, moreOrLessEquals(360, epsilon: 0.01));
      },
    );

    testWidgets('on the surface colour with a 1 dp line on top, at least 64 dp tall', (
      tester,
    ) async {
      await showBar(tester);
      final bar = find.byType(MainNavigationBar);
      expect(tester.getSize(bar).height, greaterThanOrEqualTo(64));
      final decoration =
          tester
                  .widget<DecoratedBox>(
                    find.descendant(of: bar, matching: find.byType(DecoratedBox)).first,
                  )
                  .decoration
              as BoxDecoration;
      expect(decoration.color, LookUpTokens.light.colours.surface);
      expect((decoration.border! as Border).top.color, LookUpTokens.light.colours.line);
      expect((decoration.border! as Border).top.width, 1);
    });

    testWidgets('a tap on a tab asks for that tab', (tester) async {
      await showBar(tester);
      await tester.tap(find.text('History'));
      await tester.tap(find.text('Settings'));
      await tester.tap(find.text('Identify'));
      expect(selected, [MainTab.history, MainTab.settings, MainTab.identify]);
    });

    testWidgets('grows with the text: no label is cut at text scale 2.0, on the narrowest phone', (
      tester,
    ) async {
      for (final phoneScreen in PhoneScreen.layoutChecks) {
        await showBar(tester, phoneScreen: phoneScreen);
        expect(tester.takeException(), isNull, reason: '$phoneScreen');
        expectNoClippedText(tester);
      }
    });
  });

  group('the current tab (P6-ACCESSIBILITY-06)', () {
    testWidgets(
      'screen readers meet one navigation region named "Main", each tab a button with its label, the current one selected (P6-ACCESSIBILITY-06)',
      (tester) async {
        final semantics = tester.ensureSemantics();
        await showBar(tester, currentTab: MainTab.history);
        final region = tester.getSemantics(find.byType(MainNavigationBar));
        expect(region.label, 'Main');
        expect(region.getSemanticsData().role, SemanticsRole.navigation);
        for (final (label, isCurrent) in [
          ('Identify', false),
          ('History', true),
          ('Settings', false),
        ]) {
          final data = tester.getSemantics(item(label)).getSemanticsData();
          expect(data.label, label);
          expect(data.flagsCollection.isButton, isTrue, reason: label);
          expect(
            data.flagsCollection.isSelected,
            isCurrent ? Tristate.isTrue : Tristate.isFalse,
            reason: label,
          );
          expect(data.hasAction(SemanticsAction.tap), isTrue, reason: label);
        }
        semantics.dispose();
      },
    );

    testWidgets(
      'marked by the accent, a bold label and an accent-soft pill, never by colour alone (P6-ACCESSIBILITY-06)',
      (tester) async {
        await showBar(tester, currentTab: MainTab.settings);
        final colours = LookUpTokens.light.colours;
        Text label(String text) => tester.widget<Text>(find.text(text));
        BoxDecoration pill(String text) =>
            tester
                    .widget<DecoratedBox>(
                      find.descendant(of: item(text), matching: find.byType(DecoratedBox)).first,
                    )
                    .decoration
                as BoxDecoration;
        Icon icon(String text) =>
            tester.widget<Icon>(find.descendant(of: item(text), matching: find.byType(Icon)));

        expect(label('Settings').style!.fontWeight, FontWeight.w700);
        expect(label('Settings').style!.color, colours.accent);
        expect(icon('Settings').color, colours.accent);
        expect(pill('Settings').color, colours.accentSoft);
        expect(pill('Settings').borderRadius, BorderRadius.circular(LookUpTokens.light.radii.pill));
        for (final other in ['Identify', 'History']) {
          expect(label(other).style!.fontWeight, FontWeight.w600, reason: other);
          expect(label(other).style!.color, colours.muted, reason: other);
          expect(pill(other).color, isNull, reason: other);
        }
      },
    );

    for (final (name, theme) in [('light', LookUpTheme.light()), ('dark', LookUpTheme.dark())]) {
      testWidgets('meets the tap target, label and contrast guidelines in the $name theme', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await showBar(tester, currentTab: MainTab.history, theme: theme);
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        expectEveryControlShowsText(tester);
        semantics.dispose();
      });
    }
  });

  group('the rail, from medium width (P6 design §3.19)', () {
    Future<void> showRail(WidgetTester tester, {PhoneScreen? phoneScreen}) async {
      selected.clear();
      await (phoneScreen ?? const PhoneScreen(width: 800, height: 360, textScale: 1)).pump(
        tester,
        Scaffold(
          body: Row(
            children: [
              MainNavigationRail(currentTab: MainTab.identify, onSelected: selected.add),
              const Expanded(child: SizedBox.expand()),
            ],
          ),
        ),
      );
    }

    testWidgets('the same three tabs, one under the other, the current one selected', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await showRail(tester);
      final tops = [
        for (final label in ['Identify', 'History', 'Settings']) tester.getTopLeft(item(label)).dy,
      ];
      expect(tops, [...tops]..sort());
      expect(tester.getSemantics(find.byType(MainNavigationRail)).label, 'Main');
      expect(
        tester.getSemantics(item('Identify')).getSemanticsData().flagsCollection.isSelected,
        Tristate.isTrue,
      );
      await tester.tap(find.text('Settings'));
      expect(selected, [MainTab.settings]);
      semantics.dispose();
    });

    testWidgets('fits a phone on its side, even at text scale 2.0', (tester) async {
      for (final phoneScreen in [
        const PhoneScreen(width: 800, height: 360, textScale: 1),
        const PhoneScreen(width: 800, height: 360, textScale: 2),
      ]) {
        await showRail(tester, phoneScreen: phoneScreen);
        expect(tester.takeException(), isNull, reason: '$phoneScreen');
      }
    });
  });
}
