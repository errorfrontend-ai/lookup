import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';

import '../features/result/support/result_screen_harness.dart' show resultWith;

void main() {
  test('the route list of design §3.6, and no route for ads (S4-SCOPE-06)', () {
    expect(
      {for (final route in AppRoute.values) route.name: route.path},
      {
        'home': '/',
        'permission': '/permission',
        'listening': '/listening',
        'identifying': '/identifying',
        'result': '/result',
        'noMatch': '/no-match',
        'busy': '/busy',
        'error': '/error',
      },
    );
    expect(AppRoute.values.where((route) => route.path.contains('ad')), isEmpty);
  });

  test('each of the nine states has its one route (S4-D5)', () {
    final result = resultWith();
    final routes = {
      const IdleState(): AppRoute.home,
      const PermissionNeededState(microphoneAccess: MicrophoneAccess.notAskedYet):
          AppRoute.permission,
      const RecordingState(levelFraction: 0, secondsLeft: 8): AppRoute.listening,
      const UploadingState(): AppRoute.identifying,
      MatchedState(result: result): AppRoute.result,
      FallbackState(result: result): AppRoute.result,
      const NoMatchState(): AppRoute.noMatch,
      const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 12): AppRoute.busy,
      const ErrorState(failure: ConnectionFailure()): AppRoute.error,
    };
    for (final MapEntry(key: state, value: route) in routes.entries) {
      expect(AppRoute.forState(state), route, reason: '$state');
    }
  });
}
