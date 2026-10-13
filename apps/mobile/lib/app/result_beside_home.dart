import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lookup_listener/app/main_navigation_rail.dart';
import 'package:lookup_listener/app/main_tab.dart';
import 'package:lookup_listener/core/layout/window_size_class.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';

/// A Result on a tablet (P6 design §3.19; P6-RESULT-02, P6-RESPONSIVE-04, -05): the rail at the
/// left, Home as the identify pane, and the Result in a side panel at the right, 45% of the window
/// and at least [minimumPanelWidth] wide. "Tap to identify" beside it starts a new identify (T52).
///
/// Where the window leaves Home less than [minimumHomeWidth] beside such a panel (600 to about 680
/// dp), the Result stays full screen, as on a phone: a squeezed Home would cut its words.
class ResultBesideHome extends StatelessWidget {
  const ResultBesideHome({super.key, required this.result, required this.onSelectTab});

  /// The side panel's narrowest width.
  static const double minimumPanelWidth = 360;

  /// The panel's share of the window's width.
  static const double panelShare = 0.45;

  /// Home's narrowest width beside the panel.
  static const double minimumHomeWidth = 200;

  /// The Result screen, live or saved.
  final Widget result;

  /// A tab of the rail: the Result is left first.
  final ValueChanged<MainTab> onSelectTab;

  /// The panel's width in a window [windowWidth] wide, or null when the Result stays full screen.
  static double? panelWidthIn(double windowWidth, {required WindowSizeClass sizeClass}) {
    if (sizeClass == WindowSizeClass.compact) return null;
    final panelWidth = math.max(minimumPanelWidth, windowWidth * panelShare);
    final homeWidth = windowWidth - MainNavigationRail.minimumWidth - 1 - panelWidth;
    return homeWidth < minimumHomeWidth ? null : panelWidth;
  }

  @override
  Widget build(BuildContext context) {
    final windowWidth = MediaQuery.sizeOf(context).width;
    final panelWidth = panelWidthIn(windowWidth, sizeClass: WindowSizeClass.of(context));
    if (panelWidth == null) return result;
    final colours = context.lookUpTokens.colours;
    return Scaffold(
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          MainNavigationRail(currentTab: MainTab.identify, onSelected: onSelectTab),
          Expanded(
            child: MediaQuery.removePadding(
              context: context,
              removeLeft: true,
              removeRight: true,
              child: HomeScreen(
                isBesideResult: true,
                onOpenSettings: () => onSelectTab(MainTab.settings),
              ),
            ),
          ),
          ColoredBox(color: colours.line, child: const SizedBox(width: 1)),
          SizedBox(
            width: panelWidth,
            child: MediaQuery.removePadding(context: context, removeLeft: true, child: result),
          ),
        ],
      ),
    );
  }
}
