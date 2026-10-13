import 'dart:async';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/app/notification_launch_handler.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';

import '../features/identify/presentation/identify_screen_harness.dart' show disableAnimations;
import '../support/expect_no_technical_text.dart';
import '../support/received_multipart_form.dart';
import 'listener_app_harness.dart';
import 'test_time_clock.dart';
import '../support/english_words.dart';

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
      expect(find.text(englishWords.homeHeading), findsOneWidget);

      await tester.tap(find.text(englishWords.identifyButtonLabel));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/permission');
      expect(find.text(englishWords.permissionHeading), findsOneWidget);
      // The explainer comes first: no system prompt yet (S4-PERMISSION-02).
      expect(harness.permission.promptCount, 0);

      await tester.tap(find.text(englishWords.allowMicrophoneButton));
      await harness.pumpTransition(tester);
      expect(harness.permission.promptCount, 1);
      expect(harness.location(tester), '/listening');
      expect(find.text(englishWords.listeningHeading), findsOneWidget);
      expect(find.text('8 seconds left'), findsOneWidget);

      final answerArrives = Completer<void>();
      harness.answerWithResponseFixture('valid/match-campaign', release: answerArrives.future);
      await harness.recordWholeClip(tester);
      expect(harness.location(tester), '/identifying');
      expect(find.text(englishWords.identifyingHeading), findsOneWidget);

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
      expect(find.text(englishWords.homeHeading), findsOneWidget);
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

    await tester.tap(find.text(englishWords.identifyButtonLabel));
    await harness.pumpTransition(tester);
    await harness.recordWholeClip(tester);
    expect(harness.location(tester), '/busy');
    expect(find.text(englishWords.busyHeading), findsOneWidget);
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

  testWidgets(
    'airplane mode: Saved, Pending in History, nothing sent until the network is back; then the '
    'clip goes once as deferred, its result is in History, and the notification opens it '
    '(P6-TESTS-08 in widget form; P6-OFFLINE-01, -02, -21)',
    (tester) async {
      final harness = ListenerAppHarness();
      harness.deviceServices.setNetwork(isUp: false);
      harness.adapter.failWithDioType(DioExceptionType.connectionError);
      await harness.pumpApp(
        tester,
        extraOverrides: [
          // The outbox's waits are wall-clock times: the clock follows the test's fake time.
          clockProvider.overrideWithValue(TestTimeClock(tester)),
          outboxRandomProvider.overrideWithValue(Random(3)),
        ],
      );
      // What bootstrap() starts after the first frame.
      final container = harness.container(tester);
      container.read(networkWatcherProvider).start();
      container.read(outboxRunSchedulerProvider).start();
      unawaited(container.read(notificationLaunchHandlerProvider).start());
      await tester.pump();

      await tester.tap(find.text(englishWords.identifyButtonLabel));
      await harness.pumpTransition(tester);
      await harness.recordWholeClip(tester);
      expect(harness.location(tester), '/saved-offline');
      expect(find.text(englishWords.savedOfflineHeadingNoConnection), findsOneWidget);
      expect(find.text(englishWords.savedOfflineBodyNoConnection), findsOneWidget);
      expectNoTechnicalText(tester);

      await tester.tap(find.text(englishWords.savedOfflineSeeInHistoryButton));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/history');
      expect(find.text(englishWords.historyWaitingHeading.toUpperCase()), findsOneWidget);
      expect(find.text(englishWords.historyWaitingForSignal), findsOneWidget);
      expect(find.text(englishWords.historyPendingBadge), findsOneWidget);

      // With no network the outbox does not even try.
      await tester.pump(const Duration(minutes: 10));
      expect(harness.recognizeRequests, hasLength(1));

      // The network comes back while the app is open: a run starts, and after the sending delay
      // the clip goes, once.
      harness.answerWithResponseFixture('valid/match-campaign');
      harness.deviceServices.setNetwork(isUp: true);
      await tester.pump(const Duration(seconds: 121));
      await tester.pump();
      expect(harness.recognizeRequests, hasLength(2));
      final liveSend = ReceivedMultipartForm.of(harness.recognizeRequests.first).fieldValues;
      final laterSend = ReceivedMultipartForm.of(harness.recognizeRequests.last).fieldValues;
      expect(laterSend['is_deferred'], 'true');
      expect(laterSend['idempotency_key'], liveSend['idempotency_key']);
      expect(laterSend['captured_at'], liveSend['captured_at']);
      expect(
        DateTime.parse(laterSend['sent_at']!).isAfter(DateTime.parse(liveSend['sent_at']!)),
        isTrue,
      );

      // History has the result; the Pending row is gone.
      await tester.pump();
      expect(find.text(englishWords.historyPendingBadge), findsNothing);
      expect(find.text('Brand A — Summer service offer'), findsOneWidget);

      // The notification says nothing of the ad (amendment A6), and its tap opens the result.
      final notification = harness.deviceServices.posted.single;
      expect(notification.title, englishWords.savedClipNotificationTitle);
      expect(notification.text, englishWords.savedClipNotificationText);
      expect(notification.recognitionId, _matchRecognitionId);
      harness.deviceServices.tapNotification(_matchRecognitionId);
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/r/$_matchRecognitionId');
      expect(find.text('Call us'), findsOneWidget);

      await tester.pump(const Duration(minutes: 30));
      expect(harness.recognizeRequests, hasLength(2), reason: 'answered, so never sent again');
      expect(harness.reporter.reports, isEmpty);
    },
  );
}

/// The recognition id of `valid/match-campaign.json`.
const String _matchRecognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';
