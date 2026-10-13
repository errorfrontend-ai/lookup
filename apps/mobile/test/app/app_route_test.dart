import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/features/identify/domain/chooser_origin.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/domain/saved_clip_reason.dart';

import '../features/result/support/result_screen_harness.dart'
    show fixtureRecognitionId, resultWith;

void main() {
  test('the routes of design §3.6 and P6 §3.7, and no route for ads (S4-SCOPE-06)', () {
    expect(
      {for (final route in AppRoute.values) route.name: route.path},
      {
        'home': '/',
        'history': '/history',
        'settings': '/settings',
        'myStation': '/settings/my-station',
        'privacy': '/settings/privacy',
        'about': '/settings/about',
        'savedResult': '/r/:recognitionId',
        'permission': '/permission',
        'listening': '/listening',
        'identifying': '/identifying',
        'chooseStation': '/choose-station',
        'result': '/result',
        'noMatch': '/no-match',
        'busy': '/busy',
        'error': '/error',
        'savedOffline': '/saved-offline',
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
      const SavedOfflineState(reason: SavedClipReason.noConnection, wasOldestClipDeleted: false):
          AppRoute.savedOffline,
      const ErrorState(failure: AppUpdateRequiredFailure()): AppRoute.error,
    };
    for (final MapEntry(key: state, value: route) in routes.entries) {
      expect(AppRoute.forState(state), route, reason: '$state');
    }
    expect(routes.values.toSet(), {
      AppRoute.home,
      ...AppRoute.flowRoutes,
    }, reason: 'every flow route shows a state, and idle shows Home');
  });

  test(
    'flow routes are only the screens of an identify; tabs and pages are not (P6 design §3.7)',
    () {
      expect(AppRoute.flowRoutes, [
        AppRoute.permission,
        AppRoute.listening,
        AppRoute.identifying,
        AppRoute.chooseStation,
        AppRoute.savedOffline,
        AppRoute.result,
        AppRoute.noMatch,
        AppRoute.busy,
        AppRoute.error,
      ]);
    },
  );

  test('a location names its route; any one segment after /r/ is a saved result', () {
    expect(AppRoute.forLocation('/'), AppRoute.home);
    expect(AppRoute.forLocation('/history'), AppRoute.history);
    expect(AppRoute.forLocation('/settings/my-station'), AppRoute.myStation);
    expect(AppRoute.forLocation('/no-match'), AppRoute.noMatch);
    expect(AppRoute.forLocation('/r/$fixtureRecognitionId'), AppRoute.savedResult);
    expect(AppRoute.forLocation('/r/not-a-recognition'), AppRoute.savedResult);
    for (final unknown in ['/ads', '/r/', '/r/one/two', '/settings/ads', '']) {
      expect(AppRoute.forLocation(unknown), isNull, reason: unknown);
    }
  });

  test('a saved result\'s location and the path below its tab are made from the patterns', () {
    expect(AppRoute.savedResultLocation(fixtureRecognitionId), '/r/$fixtureRecognitionId');
    expect(AppRoute.recognitionIdParameter, 'recognitionId');
    expect(AppRoute.myStation.pathBelowTab, 'my-station');
    expect(AppRoute.privacy.pathBelowTab, 'privacy');
    expect(AppRoute.about.pathBelowTab, 'about');
  });
}
