import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/app/recognition_state_page.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/busy_screen.dart';
import 'package:lookup_listener/features/identify/presentation/error_screen.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';

import '../features/identify/presentation/identify_screen_harness.dart';
import '../features/result/support/result_screen_harness.dart' show resultWith;

void main() {
  testWidgets('shows the screen for the newest state of its route', (tester) async {
    final harness = IdentifyScreenHarness(
      state: const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 12),
    );
    await harness.pump(tester, const RecognitionStatePage(route: AppRoute.busy));
    expect(find.text('12 s'), findsOneWidget);

    harness.flow.show(const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 11));
    await tester.pump();
    expect(find.text('11 s'), findsOneWidget);
  });

  testWidgets('keeps showing its last state while the flow moves on and the page fades out', (
    tester,
  ) async {
    final harness = IdentifyScreenHarness(
      state: const ErrorState(failure: AppUpdateRequiredFailure()),
    );
    await harness.pump(tester, const RecognitionStatePage(route: AppRoute.error));
    expect(find.text('Please update the app'), findsOneWidget);

    harness.flow.show(const UploadingState());
    await tester.pump();
    expect(find.byType(ErrorScreen), findsOneWidget);
    expect(find.text('Please update the app'), findsOneWidget);
  });

  testWidgets('the Result page gives its screen the flow\'s backToHome()', (tester) async {
    final harness = IdentifyScreenHarness(state: MatchedState(result: resultWith()));
    await harness.pump(tester, const RecognitionStatePage(route: AppRoute.result));
    expect(find.byType(ResultScreen), findsOneWidget);
    tester.widget<ResultScreen>(find.byType(ResultScreen)).onBack();
    expect(harness.flow.calls, ['backToHome']);
  });

  testWidgets('a page built only after its state has passed shows an empty screen', (tester) async {
    final harness = IdentifyScreenHarness(state: const IdleState());
    await harness.pump(tester, const RecognitionStatePage(route: AppRoute.busy));
    expect(find.byType(BusyScreen), findsNothing);
    expect(find.byType(Scaffold), findsOneWidget);
    expect(find.byType(Text), findsNothing);
  });
}
