import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/app/app_shell.dart';
import 'package:lookup_listener/app/main_tab.dart';
import 'package:lookup_listener/app/pending_destination.dart';
import 'package:lookup_listener/app/recognition_state_page.dart';
import 'package:lookup_listener/app/saved_result_page.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/history/presentation/history_screen.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/settings/presentation/about_screen.dart';
import 'package:lookup_listener/features/settings/presentation/my_station_picker_screen.dart';
import 'package:lookup_listener/features/settings/presentation/privacy_screen.dart';
import 'package:lookup_listener/features/settings/presentation/settings_screen.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The app's routes on go_router 17.5.0 (design §3.6; P6 design §3.7, P6-D14).
///
/// - **The tab shell** is a `StatefulShellRoute.indexedStack` around Home (`/`), History
///   (`/history`) and Settings (`/settings`), so each tab keeps its place and scroll position. The
///   pages opened from Settings (`/settings/my-station`, `/settings/privacy`, `/settings/about`)
///   sit over the shell, on the root navigator, and Back returns to Settings as it was.
/// - **A saved result** (`/r/<recognition id>`) is a page of its own over whatever opened it:
///   History pushes it, so Back returns to History as it was.
/// - **The flow's screens** (`/permission` to `/error`) are full screen, outside the shell. Every
///   move between them replaces the page, so Back always leads Home (each sends system Back to the
///   flow).
/// - **The redirect** (P6-D14) keeps navigation following the state: (1) while an identify is under
///   way (the state is not `idle`), every location goes to the state's route, exactly as Step 4's
///   (S4-D5); (2) while `idle`, a flow screen's location goes to the [PendingDestination] if one is
///   kept (taken once), else Home; (3) while `idle`, the tabs, the Settings pages and saved results
///   are free; (4) a path the app does not know goes Home. go_router's error page is replaced by a
///   move Home.
/// - It re-runs whenever the state's route changes, through [currentFlowRoute]; a new level while
///   listening does not.
/// - Pages fade in over motion.base (200 ms), and change at once when the phone asks for less
///   motion; switching tabs shows the tab at once.
abstract final class AppRouter {
  /// A router that follows [currentFlowRoute] and lands on [pendingDestination] when it is kept.
  /// [clock] is the one the "My station" picker reads its "Today" against; [openSavedChooser] opens
  /// "Which station?" for a saved clip waiting for its station (T51).
  static GoRouter create({
    required ValueListenable<AppRoute> currentFlowRoute,
    required PendingDestination pendingDestination,
    required Clock clock,
    required ValueChanged<HistoryAwaitingChoiceEntry> openSavedChooser,
  }) {
    final rootNavigatorKey = GlobalKey<NavigatorState>();
    return GoRouter(
      navigatorKey: rootNavigatorKey,
      initialLocation: currentFlowRoute.value.path,
      refreshListenable: currentFlowRoute,
      redirect: (context, routerState) => redirectFor(
        routerState.uri.path,
        currentFlowRoute: currentFlowRoute.value,
        pendingDestination: pendingDestination,
      ),
      onException: (context, routerState, router) => router.go(AppRoute.home.path),
      routes: [
        StatefulShellRoute.indexedStack(
          pageBuilder: (context, routerState, navigationShell) =>
              _fadingPage(context, routerState, AppShell(navigationShell: navigationShell)),
          branches: [
            StatefulShellBranch(
              routes: [
                _tabRoute(
                  AppRoute.home,
                  (context, routerState) => HomeScreen(
                    onOpenSettings: () =>
                        StatefulNavigationShell.of(context).goBranch(MainTab.settings.index),
                  ),
                ),
              ],
            ),
            StatefulShellBranch(
              routes: [
                _tabRoute(
                  AppRoute.history,
                  (context, routerState) => HistoryScreen(
                    onOpenResult: (recognitionId) =>
                        context.push(AppRoute.savedResultLocation(recognitionId)),
                    // T51: the chooser from the saved answer; the redirect follows the flow there.
                    onOpenSavedChooser: openSavedChooser,
                  ),
                ),
              ],
            ),
            StatefulShellBranch(
              routes: [
                _tabRoute(
                  AppRoute.settings,
                  (context, routerState) => SettingsScreen(
                    onOpenMyStation: () => context.go(AppRoute.myStation.path),
                    onOpenPrivacy: () => context.go(AppRoute.privacy.path),
                    onOpenAbout: () => context.go(AppRoute.about.path),
                  ),
                  pages: [
                    _pageOverTabs(
                      AppRoute.myStation,
                      rootNavigatorKey,
                      (context, routerState) =>
                          MyStationPickerScreen(onDone: () => _back(context), now: clock.now),
                    ),
                    _pageOverTabs(
                      AppRoute.privacy,
                      rootNavigatorKey,
                      (context, routerState) => PrivacyScreen(onBack: () => _back(context)),
                    ),
                    _pageOverTabs(
                      AppRoute.about,
                      rootNavigatorKey,
                      (context, routerState) => AboutScreen(onBack: () => _back(context)),
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
        GoRoute(
          path: AppRoute.savedResult.path,
          name: AppRoute.savedResult.name,
          parentNavigatorKey: rootNavigatorKey,
          pageBuilder: (context, routerState) => _fadingPage(
            context,
            routerState,
            SavedResultPage(
              recognitionId: routerState.pathParameters[AppRoute.recognitionIdParameter] ?? '',
              onBack: () => _back(context, orTo: AppRoute.history),
              onMissing: () => _showSavedResultMissing(context),
            ),
          ),
        ),
        for (final route in AppRoute.flowRoutes)
          GoRoute(
            path: route.path,
            name: route.name,
            parentNavigatorKey: rootNavigatorKey,
            pageBuilder: (context, routerState) =>
                _fadingPage(context, routerState, RecognitionStatePage(route: route)),
          ),
      ],
    );
  }

  /// Where [location] goes, by the rules of P6-D14 (see [AppRouter]); null when it stays.
  @visibleForTesting
  static String? redirectFor(
    String location, {
    required AppRoute currentFlowRoute,
    required PendingDestination pendingDestination,
  }) {
    // (1) An identify is under way: only its own screen.
    if (currentFlowRoute != AppRoute.home) {
      return location == currentFlowRoute.path ? null : currentFlowRoute.path;
    }
    final route = AppRoute.forLocation(location);
    // (4) A path the app does not know.
    if (route == null) return AppRoute.home.path;
    // (2) A flow screen that has ended: where it asked to land, or Home.
    if (route.isFlowRoute) return pendingDestination.take() ?? AppRoute.home.path;
    // (3) A tab, a Settings page or a saved result.
    return null;
  }

  static GoRoute _tabRoute(
    AppRoute route,
    Widget Function(BuildContext context, GoRouterState routerState) build, {
    List<RouteBase> pages = const [],
  }) => GoRoute(
    path: route.path,
    name: route.name,
    pageBuilder: (context, routerState) =>
        NoTransitionPage<void>(key: routerState.pageKey, child: build(context, routerState)),
    routes: pages,
  );

  static GoRoute _pageOverTabs(
    AppRoute route,
    GlobalKey<NavigatorState> rootNavigatorKey,
    Widget Function(BuildContext context, GoRouterState routerState) build,
  ) => GoRoute(
    path: route.pathBelowTab,
    name: route.name,
    parentNavigatorKey: rootNavigatorKey,
    pageBuilder: (context, routerState) =>
        _fadingPage(context, routerState, build(context, routerState)),
  );

  /// Back from a page over the tabs: to the page under it, or to [orTo] (Settings by default) when
  /// it was opened with nothing under it.
  static void _back(BuildContext context, {AppRoute orTo = AppRoute.settings}) {
    if (context.canPop()) {
      context.pop();
    } else {
      context.go(orTo.path);
    }
  }

  /// A saved result History does not hold: the History tab, and a short message saying so.
  static void _showSavedResultMissing(BuildContext context) {
    final messenger = ScaffoldMessenger.of(context);
    final motion = context.lookUpTokens.motion;
    final words = AppLocalizations.of(context);
    final disablesAnimations = MediaQuery.disableAnimationsOf(context);
    context.go(AppRoute.history.path);
    messenger.showSnackBar(
      SnackBar(content: Text(words.savedResultMissing)),
      // In and out over motion.base (S4-ACCESSIBILITY-04); no slide when the phone asks for less
      // motion ("Remove animations").
      snackBarAnimationStyle: disablesAnimations
          ? AnimationStyle.noAnimation
          : AnimationStyle(duration: motion.base, reverseDuration: motion.base),
    );
  }

  static Page<void> _fadingPage(BuildContext context, GoRouterState routerState, Widget child) {
    final duration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : context.lookUpTokens.motion.base;
    return CustomTransitionPage<void>(
      key: routerState.pageKey,
      name: routerState.name,
      transitionDuration: duration,
      reverseTransitionDuration: duration,
      transitionsBuilder: (context, animation, secondaryAnimation, child) =>
          FadeTransition(opacity: animation, child: child),
      child: child,
    );
  }
}

/// The app's router, following [recognitionFlowProvider] (design §3.5; P6 design §3.7).
final Provider<GoRouter> appRouterProvider = Provider<GoRouter>((ref) {
  final currentFlowRoute = ValueNotifier<AppRoute>(AppRoute.home);
  // Only a change of route re-runs the redirect; a new level while listening does not.
  ref.listen<RecognitionState>(
    recognitionFlowProvider,
    (previous, next) => currentFlowRoute.value = AppRoute.forState(next),
    fireImmediately: true,
  );
  final router = AppRouter.create(
    currentFlowRoute: currentFlowRoute,
    pendingDestination: ref.watch(pendingDestinationProvider),
    clock: ref.watch(clockProvider),
    openSavedChooser: (entry) => ref
        .read(recognitionFlowProvider.notifier)
        .openSavedChooser(
          recognitionId: entry.entryId,
          candidates: entry.candidates,
          answer: entry.answerBody,
          capturedAtOnPhone: entry.capturedAtOnPhone,
        ),
  );
  ref.onDispose(() {
    router.dispose();
    currentFlowRoute.dispose();
  });
  return router;
}, retry: (retryCount, error) => null);
