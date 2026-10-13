import 'package:lookup_listener/features/identify/domain/recognition_state.dart';

/// The app's routes (design §3.6; P6 design §3.7): one per screen, each shown for the recognition
/// states listed. No route lists or browses ads (S4-SCOPE-06).
enum AppRoute {
  /// Home, for `idle`.
  home('/'),

  /// Permission, for `permissionNeeded`.
  permission('/permission'),

  /// Listening, for `recording`.
  listening('/listening'),

  /// Identifying, for `uploading`.
  identifying('/identifying'),

  /// "Which station?", for `chooseStation` (P6 design §2.6).
  chooseStation('/choose-station'),

  /// Result, for `matched` and `fallback`.
  result('/result'),

  /// No match, for `noMatch`.
  noMatch('/no-match'),

  /// Busy, for `busy`.
  busy('/busy'),

  /// Error, for `error`.
  error('/error');

  const AppRoute(this.path);

  /// The location, e.g. `/no-match`.
  final String path;

  /// The one route [state] is shown at (S4-D5). An exhaustive switch with no default branch, so a
  /// new state cannot compile without its route (S4-STATE-09).
  static AppRoute forState(RecognitionState state) => switch (state) {
    IdleState() => home,
    PermissionNeededState() => permission,
    RecordingState() => listening,
    UploadingState() => identifying,
    ChooseStationState() => chooseStation,
    MatchedState() || FallbackState() => result,
    NoMatchState() => noMatch,
    BusyState() => busy,
    ErrorState() => error,
  };
}
