import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';
import 'package:lookup_listener/app/main_navigation_item.dart';
import 'package:lookup_listener/app/main_tab.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The same three tabs in a rail at the left, on windows of medium width and wider: small tablets
/// and phones on their side (P6 design §2.2, §3.19). Each tab as in the tab bar, one under the
/// other from the top, on the surface colour with a 1 dp line at the right; it scrolls when a short
/// window and large text leave no room. Screen readers meet it as the bar: one navigation region
/// named "Main", the current tab selected.
///
/// The panes beside it at medium and expanded widths (the result beside Home, two panes per tab)
/// come with the tablet layouts (piece 6).
class MainNavigationRail extends StatelessWidget {
  const MainNavigationRail({super.key, required this.currentTab, required this.onSelected});

  /// The rail is at least this wide.
  static const double minimumWidth = 80;

  /// The tab on screen.
  final MainTab currentTab;

  /// A tab's tap.
  final ValueChanged<MainTab> onSelected;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    return Semantics(
      container: true,
      role: SemanticsRole.navigation,
      label: AppLocalizations.of(context).mainNavigationLabel,
      explicitChildNodes: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colours.surface,
          border: Border(right: BorderSide(color: colours.line)),
        ),
        child: SafeArea(
          right: false,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minWidth: minimumWidth),
            child: SingleChildScrollView(
              padding: EdgeInsets.symmetric(vertical: tokens.spacing.space2),
              child: IntrinsicWidth(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final (index, tab) in MainTab.values.indexed) ...[
                      if (index > 0) SizedBox(height: tokens.spacing.space2),
                      MainNavigationItem(
                        tab: tab,
                        isCurrent: tab == currentTab,
                        onTap: () => onSelected(tab),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
