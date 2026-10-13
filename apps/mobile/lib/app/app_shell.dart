import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lookup_listener/app/main_navigation_bar.dart';
import 'package:lookup_listener/app/main_navigation_rail.dart';
import 'package:lookup_listener/app/main_tab.dart';
import 'package:lookup_listener/core/layout/window_size_class.dart';

/// The tab shell around Home, History and Settings (P6 design §2.2, §3.7, §3.19): the tab bar at
/// the bottom on a phone, the rail at the left from medium width, and the three tabs' screens kept
/// side by side in an indexed stack by go_router's `StatefulShellRoute`, so each tab keeps its
/// place and its scroll position while another is shown (P6-NAVIGATION-01).
///
/// System Back on History or Settings goes to the Identify tab; on Identify it leaves the app, as on
/// any first screen. Flow screens (Listening to Error) and the pages opened from a tab are full
/// screen, outside it, as the wireframes draw them.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.navigationShell});

  /// go_router's shell: which tab is current, and how to change it.
  final StatefulNavigationShell navigationShell;

  MainTab get _currentTab => MainTab.values[navigationShell.currentIndex];

  void _select(MainTab tab) => navigationShell.goBranch(tab.index);

  @override
  Widget build(BuildContext context) {
    final currentTab = _currentTab;
    final isCompact = WindowSizeClass.of(context) == WindowSizeClass.compact;
    return PopScope<Object?>(
      canPop: currentTab == MainTab.identify,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _select(MainTab.identify);
      },
      child: isCompact
          ? Scaffold(
              body: navigationShell,
              bottomNavigationBar: MainNavigationBar(currentTab: currentTab, onSelected: _select),
            )
          : Scaffold(
              body: Row(
                children: [
                  MainNavigationRail(currentTab: currentTab, onSelected: _select),
                  Expanded(
                    child: MediaQuery.removePadding(
                      context: context,
                      removeLeft: true,
                      child: navigationShell,
                    ),
                  ),
                ],
              ),
            ),
    );
  }
}
