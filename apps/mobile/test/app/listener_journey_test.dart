import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/presentation/busy_screen.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/identify_button.dart';
import 'package:lookup_listener/features/identify/presentation/identifying_screen.dart';
import 'package:lookup_listener/features/identify/presentation/listening_screen.dart';
import 'package:lookup_listener/features/identify/presentation/permission_screen.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';

import '../features/identify/presentation/identify_screen_harness.dart' show disableAnimations;
import '../support/expect_no_technical_text.dart';
import 'listener_app_harness.dart';

/// The listener's journeys through the whole app with the flow's fakes (design §4.3, §4.7 step 3
/// on the PC): every screen is reached by tapping, and every move follows the state.
void main() {
  testWidgets(
    'Home → Permission → "Allow microphone" → Listening → Identifying → Result → Back → Home',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final harness = ListenerAppHarness(microphoneAccess: MicrophoneAccess.notAskedYet);
      await harness.pumpApp(tester);
      expect(harness.location(tester), '/');
      expect(find.text(HomeScreen.heading), findsOneWidget);

      await tester.tap(find.text(IdentifyButton.label));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/permission');
      expect(find.text(PermissionScreen.heading), findsOneWidget);
      // The explainer comes first: no system prompt yet (S4-PERMISSION-02).
      expect(harness.permission.promptCount, 0);

      await tester.tap(find.text(PermissionScreen.allowMicrophoneLabel));
      await harness.pumpTransition(tester);
      expect(harness.permission.promptCount, 1);
      expect(harness.location(tester), '/listening');
      expect(find.text(ListeningScreen.heading), findsOneWidget);
      expect(find.text('8 seconds left'), findsOneWidget);

      final answerArrives = Completer<void>();
      harness.answerWithResponseFixture('valid/match-campaign', release: answerArrives.future);
      await harness.recordWholeClip(tester);
      expect(harness.location(tester), '/identifying');
      expect(find.text(IdentifyingScreen.heading), findsOneWidget);

      answerArrives.complete();
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/result');
      expect(find.byType(ResultScreen), findsOneWidget);
      expect(find.text('Found it'), findsOneWidget);
      expect(find.text('Brand A'), findsOneWidget);
      expect(find.text('Summer service offer'), findsOneWidget);
      expect(find.text('Call us'), findsOneWidget);
      expectNoTechnicalText(tester);

      await tester.tap(find.bySemanticsLabel('Back to home'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/');
      expect(find.text(HomeScreen.heading), findsOneWidget);
      expect(harness.recognizeRequests, hasLength(1));
      expect(harness.recorder.clipFileNames, isEmpty);
      semantics.dispose();
    },
  );

  testWidgets('busy, then the automatic retry sends the same clip and shows the Result', (
    tester,
  ) async {
    // Pages change at once, so the fake clock moves only when the test says so.
    disableAnimations(tester);
    final harness = ListenerAppHarness()
      ..answerWithEnvelopeFixture('recognition-busy', retryAfter: '2')
      ..answerWithResponseFixture('valid/match-campaign');
    await harness.pumpApp(tester);

    await tester.tap(find.text(IdentifyButton.label));
    await harness.pumpTransition(tester);
    await harness.recordWholeClip(tester);
    expect(harness.location(tester), '/busy');
    expect(find.text(BusyScreen.heading), findsOneWidget);
    expect(find.text('2 s'), findsOneWidget);
    expect(find.text(ListenerAppHarness.envelopeMessage('recognition-busy')), findsNothing);

    await tester.pump(const Duration(seconds: 1));
    expect(find.text('1 s'), findsOneWidget);
    expect(harness.recognizeRequests, hasLength(1));

    await tester.pump(const Duration(seconds: 1));
    await harness.pumpTransition(tester);
    expect(harness.location(tester), '/result');
    expect(find.text('Call us'), findsOneWidget);
    expect(harness.recognizeRequests, hasLength(2));
    final keys = harness.sentIdempotencyKeys;
    expect(keys[0], isNotNull);
    expect(keys[1], keys[0]);
  });

  testWidgets('no connection, then "Send again" sends the kept clip and shows the Result', (
    tester,
  ) async {
    final harness = ListenerAppHarness();
    harness.adapter.failWithDioType(DioExceptionType.connectionError);
    harness.answerWithResponseFixture('valid/match-campaign');
    await harness.pumpApp(tester);

    await tester.tap(find.text(IdentifyButton.label));
    await harness.pumpTransition(tester);
    await harness.recordWholeClip(tester);
    expect(harness.location(tester), '/error');
    expect(find.text('No connection'), findsOneWidget);
    expect(find.text('Reference code'), findsNothing);
    expectNoTechnicalText(tester);

    await tester.tap(find.text('Send again'));
    await harness.pumpTransition(tester);
    expect(harness.location(tester), '/result');
    expect(find.text('Brand A'), findsOneWidget);
    expect(harness.recognizeRequests, hasLength(2));
    expect(harness.sentIdempotencyKeys[1], harness.sentIdempotencyKeys[0]);
  });
}
