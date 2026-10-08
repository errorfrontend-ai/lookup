import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/app/recognition_state_page.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';

/// The app's routes on go_router 17.5.0 (design §3.6, S4-D5): navigation follows the recognition
/// state, never the other way round.
///
/// - The `redirect` sends every location to the route of the current state ([AppRoute.forState]),
///   so a screen and its state can never disagree: an unknown path or a stale `/result` goes where
///   the state is. go_router's error page is replaced by a move to `/`, which the redirect then
///   corrects.
/// - It re-runs whenever the state's route changes, through [currentRoute]. Every move replaces the
///   page, so the stack is flat and Back always leads Home (each screen sends system Back to the
///   flow).
/// - Pages fade in over motion.base (200 ms), and change at once when the phone asks for less
///   motion.
abstract final class AppRouter {
  /// A router that keeps the location on [currentRoute].
  static GoRouter create({required ValueListenable<AppRoute> currentRoute}) {
    return GoRouter(
      initialLocation: currentRoute.value.path,
      refreshListenable: currentRoute,
      redirect: (context, routerState) {
        final target = currentRoute.value.path;
        return routerState.uri.path == target ? null : target;
      },
      onException: (context, routerState, router) => router.go(AppRoute.home.path),
      routes: [
        for (final route in AppRoute.values)
          GoRoute(
            path: route.path,
            name: route.name,
            pageBuilder: (context, routerState) => _pageFor(context, routerState, route),
          ),
      ],
    );
  }

  static Page<void> _pageFor(BuildContext context, GoRouterState routerState, AppRoute route) {
    final duration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : context.lookUpTokens.motion.base;
    return CustomTransitionPage<void>(
      key: routerState.pageKey,
      name: route.name,
      transitionDuration: duration,
      reverseTransitionDuration: duration,
      transitionsBuilder: (context, animation, secondaryAnimation, child) =>
          FadeTransition(opacity: animation, child: child),
      child: RecognitionStatePage(route: route),
    );
  }
}

/// The app's router, following [recognitionFlowProvider] (design §3.5).
final Provider<GoRouter> appRouterProvider = Provider<GoRouter>((ref) {
  final currentRoute = ValueNotifier<AppRoute>(AppRoute.home);
  // Only a change of route re-runs the redirect; a new level while listening does not.
  ref.listen<RecognitionState>(
    recognitionFlowProvider,
    (previous, next) => currentRoute.value = AppRoute.forState(next),
    fireImmediately: true,
  );
  final router = AppRouter.create(currentRoute: currentRoute);
  ref.onDispose(() {
    router.dispose();
    currentRoute.dispose();
  });
  return router;
}, retry: (retryCount, error) => null);
