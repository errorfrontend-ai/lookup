import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';
import 'package:lookup_listener/app/main_navigation_item.dart';
import 'package:lookup_listener/app/main_tab.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The tab bar at the bottom of Home, History and Settings on a phone (P6 design §2.2; wireframes
/// Main, History and Settings, `nav aria-label="Main"`; P6-NAVIGATION-01, -02, -05, -06;
/// P6-ACCESSIBILITY-06): Identify, History and Settings in three equal columns, on the surface
/// colour with a 1 dp line on top, at least [minimumHeight] tall and taller as the text grows.
///
/// The app's own widget, not Material's `NavigationBar`, whose fixed 80 dp height cuts labels at
/// large text and does not match the wireframe's 64 dp. Screen readers meet it as one navigation
/// region named "Main", each tab a button with its label, the current one selected.
class MainNavigationBar extends StatelessWidget {
  const MainNavigationBar({super.key, required this.currentTab, required this.onSelected});

  /// The bar is at least this tall: the wireframe's 64 dp.
  static const double minimumHeight = 64;

  /// The tab on screen.
  final MainTab currentTab;

  /// A tab's tap.
  final ValueChanged<MainTab> onSelected;

  @override
  Widget build(BuildContext context) {
    final colours = context.lookUpTokens.colours;
    return Semantics(
      container: true,
      role: SemanticsRole.navigation,
      label: AppLocalizations.of(context).mainNavigationLabel,
      explicitChildNodes: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colours.surface,
          border: Border(top: BorderSide(color: colours.line)),
        ),
        child: SafeArea(
          top: false,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: minimumHeight),
            child: IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final tab in MainTab.values)
                    Expanded(
                      child: MainNavigationItem(
                        tab: tab,
                        isCurrent: tab == currentTab,
                        onTap: () => onSelected(tab),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
