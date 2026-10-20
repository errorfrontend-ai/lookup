import 'package:lookup_listener/features/identify/domain/recognition_state.dart';

/// The app's routes (design §3.6; P6 design §3.7): the three tabs, the pages opened from Settings,
/// a saved result, and one route per flow screen, each shown for the recognition states listed. No
/// route lists or browses ads (S4-SCOPE-06).
enum AppRoute {
  /// Home, the Identify tab, for `idle`.
  home('/', isFlowRoute: false),

  /// The History tab.
  history('/history', isFlowRoute: false),

  /// The Settings tab.
  settings('/settings', isFlowRoute: false),

  /// The "My station" picker, over the tabs (P6 design §2.12).
  myStation('/settings/my-station', isFlowRoute: false),

  /// Privacy, over the tabs (P6 design §2.13).
  privacy('/settings/privacy', isFlowRoute: false),

  /// About Look Up, over the tabs (P6 design §2.13).
  about('/settings/about', isFlowRoute: false),

  /// Settings → Account, over the tabs (ADR-005): the account of this phone, and creating or signing in to one
  /// without a result waiting.
  settingsAccount('/settings/account', isFlowRoute: false),

  /// A result saved in History, opened again with no request (P6 design §2.10): an internal route,
  /// not a link anyone can open from outside the app (P6-D13).
  savedResult('/r/:recognitionId', isFlowRoute: false),

  /// Permission, for `permissionNeeded`.
  permission('/permission', isFlowRoute: true),

  /// Listening, for `recording`.
  listening('/listening', isFlowRoute: true),

  /// Identifying, for `uploading`.
  identifying('/identifying', isFlowRoute: true),

  /// "Which station?", for `chooseStation` (P6 design §2.6).
  chooseStation('/choose-station', isFlowRoute: true),

  /// The account gate, for `accountRequired` (ADR-005): "One more step to see your result", and the steps
  /// of creating or signing in to an account, all on this one route.
  accountRequired('/account', isFlowRoute: true),

  /// Saved offline, for `savedOffline` (P6 design §2.8).
  savedOffline('/saved-offline', isFlowRoute: true),

  /// Result, for `matched` and `fallback`.
  result('/result', isFlowRoute: true),

  /// No match, for `noMatch`.
  noMatch('/no-match', isFlowRoute: true),

  /// Busy, for `busy`.
  busy('/busy', isFlowRoute: true),

  /// Error, for `error`.
  error('/error', isFlowRoute: true);

  const AppRoute(this.path, {required this.isFlowRoute});

  /// The location, e.g. `/no-match`, or the pattern `/r/:recognitionId`.
  final String path;

  /// Whether the route shows a state of an identify under way: shown only while the flow is in
  /// that state, never chosen by the listener (S4-D5).
  final bool isFlowRoute;

  /// The flow's routes, one per screen of an identify.
  static List<AppRoute> get flowRoutes => [
    for (final route in values)
      if (route.isFlowRoute) route,
  ];

  /// The saved result's path parameter: the recognition id.
  static String get recognitionIdParameter => savedResult.path.split(':').last;

  /// The location of the saved result of [recognitionId], e.g. `/r/0199b2c4-…`.
  static String savedResultLocation(String recognitionId) =>
      savedResult.path.replaceFirst(':$recognitionIdParameter', Uri.encodeComponent(recognitionId));

  /// A page's path below its tab, as go_router names a nested route: `my-station` for
  /// `/settings/my-station`.
  String get pathBelowTab => path.split('/').last;

  /// The route a location [path] shows, or null for a path the app does not know. Any one segment
  /// after `/r/` is a saved result's: the page itself finds whether History holds it.
  static AppRoute? forLocation(String path) {
    for (final route in values) {
      if (route != savedResult && route.path == path) return route;
    }
    final savedResultPrefix = savedResult.path.substring(0, savedResult.path.indexOf(':'));
    if (path.startsWith(savedResultPrefix)) {
      final recognitionId = path.substring(savedResultPrefix.length);
      if (recognitionId.isNotEmpty && !recognitionId.contains('/')) return savedResult;
    }
    return null;
  }

  /// The one route [state] is shown at (S4-D5). An exhaustive switch with no default branch, so a
  /// new state cannot compile without its route (S4-STATE-09).
  static AppRoute forState(RecognitionState state) => switch (state) {
    IdleState() => home,
    PermissionNeededState() => permission,
    RecordingState() => listening,
    UploadingState() => identifying,
    ChooseStationState() => chooseStation,
    AccountRequiredState() => accountRequired,
    SavedOfflineState() => savedOffline,
    MatchedState() || FallbackState() => result,
    NoMatchState() => noMatch,
    BusyState() => busy,
    ErrorState() => error,
  };
}
