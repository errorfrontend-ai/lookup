import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/app/app_router.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';

/// The listener app (design §3.1): the light theme from the design tokens and the router that
/// follows the recognition state. Light only in Step 4; the dark tokens wait for Phase 6
/// (P6-THEME-01).
class LookUpApp extends ConsumerWidget {
  const LookUpApp({super.key});

  /// The app's name, which the system shows in the list of recent apps.
  static const String title = 'Look Up';

  static final ThemeData _theme = LookUpTheme.light();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: title,
      theme: _theme,
      themeMode: ThemeMode.light,
      debugShowCheckedModeBanner: false,
      routerConfig: ref.watch(appRouterProvider),
    );
  }
}
