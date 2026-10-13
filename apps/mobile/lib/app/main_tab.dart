import 'package:flutter/material.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The app's three tabs, in their order (P6 design §2.2; wireframes Main, History and Settings;
/// P6-NAVIGATION-01, -02): Identify with a microphone, History with a clock, Settings with sliders.
/// A tab's index is its branch of the tab shell.
enum MainTab {
  /// Home: identify an ad.
  identify(Icons.mic_none, AppRoute.home),

  /// The results identified before.
  history(Icons.schedule, AppRoute.history),

  /// My station, the language, privacy and the app's details.
  settings(Icons.tune, AppRoute.settings);

  const MainTab(this.icon, this.route);

  /// The icon above the label.
  final IconData icon;

  /// Where the tab's own screen is.
  final AppRoute route;

  /// The label under the icon: "Identify", "History", "Settings".
  String labelOf(AppLocalizations words) => switch (this) {
    identify => words.tabIdentify,
    history => words.tabHistory,
    settings => words.tabSettings,
  };
}
