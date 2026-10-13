import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/app/app_router.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/widgets/pictures_allowed.dart';
import 'package:lookup_listener/features/settings/data/settings_providers.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';
import 'package:lookup_listener/l10n/fallback_localizations.dart';

/// The listener app (design §3.1, §3.17, §3.18): the light and dark themes from the design tokens,
/// following the phone's setting (P6-THEME-01), the words from the ARB files with English Material
/// texts for a language Flutter has none for (P6-LOCALISATION-01 to -03), and the router that
/// follows the recognition state.
class LookUpApp extends ConsumerWidget {
  const LookUpApp({super.key});

  static final ThemeData _lightTheme = LookUpTheme.light();
  static final ThemeData _darkTheme = LookUpTheme.dark();

  /// The app's name in the listener's language, which the system shows in the list of recent
  /// apps.
  static String titleOf(BuildContext context) => AppLocalizations.of(context).appTitle;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      onGenerateTitle: titleOf,
      theme: _lightTheme,
      darkTheme: _darkTheme,
      themeMode: ThemeMode.system,
      localizationsDelegates: FallbackLocalizations.delegates,
      supportedLocales: FallbackLocalizations.supportedLocales,
      debugShowCheckedModeBanner: false,
      routerConfig: ref.watch(appRouterProvider),
      // The data saver, above every screen: a picture asks it before it is requested (P6 design
      // §3.16).
      builder: (context, child) => PicturesAllowed(
        mayLoad: ref.watch(mayLoadPicturesProvider),
        child: child ?? const SizedBox.shrink(),
      ),
    );
  }
}
