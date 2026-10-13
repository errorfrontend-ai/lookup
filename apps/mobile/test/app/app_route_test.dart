import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/features/identify/domain/chooser_origin.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';

import '../features/result/support/result_screen_harness.dart'
    show fixtureRecognitionId, resultWith;

void main() {
  test('the routes of design §3.6 and P6 §3.7, and no route for ads (S4-SCOPE-06)', () {
    expect(
      {for (final route in AppRoute.values) route.name: route.path},
      {
        'home': '/',
        'permission': '/permission',
        'listening': '/listening',
        'identifying': '/identifying',
        'chooseStation': '/choose-station',
        'result': '/result',
        'noMatch': '/no-match',
        'busy': '/busy',
        'error': '/error',
      },
    );
    expect(AppRoute.values.where((route) => route.path.contains('ad')), isEmpty);
  });

  test('each of the ten states has its one route (S4-D5; P6 design §3.7)', () {
    final result = resultWith();
    final stationB = resultWith(
      stationId: '0192a6c4-1111-4000-8000-000000000002',
      stationName: 'Station B',
    );
    final routes = {
      const IdleState(): AppRoute.home,
      const PermissionNeededState(microphoneAccess: MicrophoneAccess.notAskedYet):
          AppRoute.permission,
      const RecordingState(levelFraction: 0, secondsLeft: 8): AppRoute.listening,
      const UploadingState(): AppRoute.identifying,
      ChooseStationState(
        recognitionId: fixtureRecognitionId,
        candidates: [result, stationB],
        origin: ChooserOrigin.liveIdentify,
      ): AppRoute.chooseStation,
      MatchedState(result: result): AppRoute.result,
      FallbackState(result: result): AppRoute.result,
      const NoMatchState(): AppRoute.noMatch,
      const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 12): AppRoute.busy,
      const ErrorState(failure: ConnectionFailure()): AppRoute.error,
    };
    for (final MapEntry(key: state, value: route) in routes.entries) {
      expect(AppRoute.forState(state), route, reason: '$state');
    }
    expect(routes.values.toSet(), AppRoute.values.toSet(), reason: 'every route shows a state');
  });
}
