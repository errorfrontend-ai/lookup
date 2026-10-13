import 'package:flutter/material.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/app/two_panes.dart';
import 'package:lookup_listener/core/layout/window_size_class.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/settings/presentation/about_screen.dart';
import 'package:lookup_listener/features/settings/presentation/my_station_picker_screen.dart';
import 'package:lookup_listener/features/settings/presentation/privacy_screen.dart';
import 'package:lookup_listener/features/settings/presentation/settings_screen.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The Settings tab (P6 design §3.19): the list on a phone and at medium width, where "My station",
/// Privacy and About open as pages of their own; at expanded width the list and, beside it, the page
/// last opened, or a line saying where it will show.
class SettingsTabPage extends StatefulWidget {
  const SettingsTabPage({super.key, required this.onOpenPage, required this.clock});

  /// A page's row below expanded width: the page over the tabs.
  final ValueChanged<AppRoute> onOpenPage;

  /// The clock the "My station" picker reads "Today" against.
  final Clock clock;

  @override
  State<SettingsTabPage> createState() => _SettingsTabPageState();
}

class _SettingsTabPageState extends State<SettingsTabPage> {
  /// The page shown beside the list at expanded width.
  AppRoute? _openedPage;

  @override
  Widget build(BuildContext context) {
    final isExpanded = WindowSizeClass.of(context) == WindowSizeClass.expanded;
    void open(AppRoute page) =>
        isExpanded ? setState(() => _openedPage = page) : widget.onOpenPage(page);
    final list = SettingsScreen(
      onOpenMyStation: () => open(AppRoute.myStation),
      onOpenPrivacy: () => open(AppRoute.privacy),
      onOpenAbout: () => open(AppRoute.about),
    );
    if (!isExpanded) return list;
    return TwoPanes(start: list, end: _paneFor(_openedPage, AppLocalizations.of(context)));
  }

  Widget _paneFor(AppRoute? page, AppLocalizations words) => switch (page) {
    AppRoute.myStation => MyStationPickerScreen(onDone: _close, now: widget.clock.now),
    AppRoute.privacy => PrivacyScreen(onBack: _close),
    AppRoute.about => AboutScreen(onBack: _close),
    _ => PaneNote(text: words.settingsPaneNote),
  };

  void _close() {
    if (mounted) setState(() => _openedPage = null);
  }
}
