import 'dart:math';

import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/outbox_run_scheduler.dart';
import 'package:lookup_listener/core/outbox/outbox_timing_rules.dart';

import '../core/outbox/outbox_sender_harness.dart';

/// Moves the app through the lifecycle, one allowed step at a time, to [target].
void _moveAppTo(OutboxSenderHarness harness, AppLifecycleState target) {
  const order = [
    AppLifecycleState.resumed,
    AppLifecycleState.inactive,
    AppLifecycleState.hidden,
    AppLifecycleState.paused,
  ];
  final binding = TestWidgetsFlutterBinding.instance;
  var index = order.indexOf(binding.lifecycleState ?? AppLifecycleState.resumed);
  final targetIndex = order.indexOf(target);
  while (index != targetIndex) {
    index += index < targetIndex ? 1 : -1;
    binding.handleAppLifecycleStateChanged(order[index]);
  }
  harness.settle();
}

/// When the outbox's runs start (P6 design §3.9 point 1; P6-OFFLINE-07 for start, resume and a new
/// item; amendment A1 for the wake-up after a wait).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    TestWidgetsFlutterBinding.instance.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  });

  OutboxRunScheduler startScheduler(OutboxSenderHarness harness) {
    final scheduler = OutboxRunScheduler(
      sender: harness.sender,
      itemsQueued: harness.store.itemsQueued,
      clock: harness.clock,
    )..start();
    addTearDown(scheduler.dispose);
    harness.settle();
    return scheduler;
  }

  test('the app start starts a run: a waiting choice goes after the drawn wait', () {
    runSenderTest(random: ScriptedRandom(integers: [42]), (harness) {
      harness.queueChoice(recognitionOne, stationB);
      harness.answerChoice(204);
      startScheduler(harness);
      harness.wait(const Duration(seconds: 41));
      expect(harness.sentChoices, isEmpty);
      harness.wait(const Duration(seconds: 1));
      expect(harness.sentChoices.single.at, const Duration(seconds: 42));
      expect(harness.items, isEmpty);
    });
  });

  test('a new item starts a run at once, with the short wait of an emptied queue', () {
    runSenderTest(random: ScriptedRandom(integers: [7]), (harness) {
      startScheduler(harness);
      harness.wait(const Duration(minutes: 5));
      harness.answerChoice(204);
      harness.queueChoice(recognitionOne, stationB);
      harness.wait(const Duration(seconds: 7));
      expect(harness.sentChoices.single.at, const Duration(minutes: 5, seconds: 7));
    });
  });

  test('coming back to the foreground starts a run; hiding the app cancels the wake-up', () {
    runSenderTest(random: ScriptedRandom(doubles: [0], integers: [0]), (harness) {
      final scheduler = startScheduler(harness);
      harness.answerChoiceWithNothing();
      harness.queueChoice(recognitionOne, stationB);
      expect(harness.sentChoices, hasLength(1));
      expect(scheduler.isWakeUpSet, isTrue);
      expect(scheduler.wakeUpAt, harness.clock.now().add(const Duration(seconds: 15)));

      _moveAppTo(harness, AppLifecycleState.hidden);
      expect(scheduler.isWakeUpSet, isFalse);
      harness.wait(const Duration(minutes: 10));
      expect(harness.sentChoices, hasLength(1), reason: 'no wake-up while hidden');

      harness.answerChoice(204);
      _moveAppTo(harness, AppLifecycleState.resumed);
      expect(harness.sentChoices, hasLength(2));
      expect(harness.items, isEmpty);
      expect(scheduler.isWakeUpSet, isFalse, reason: 'nothing waits');
    });
  });

  test('A1: no answer at 10:00:00 with the app left open and nothing else happening; the next '
      'send comes by itself at the drawn second inside [10:00:15, 10:00:30]', () {
    // The draws the sender makes, in order, from the same seeded source: the new item's wait, then
    // the backoff's factor after the failure.
    final draws = Random(3);
    final firstWaitSeconds = draws.nextInt(11);
    final factor = draws.nextDouble();
    final expectedGap = Duration(milliseconds: (30000 * (0.5 + factor * 0.5)).round());
    final startsAt = DateTime.utc(2026, 10, 8, 10).subtract(Duration(seconds: firstWaitSeconds));
    runSenderTest(random: Random(3), startsAt: startsAt, (harness) {
      startScheduler(harness);
      harness.answerChoiceWithNothing();
      harness.answerChoice(204);
      harness.queueChoice(recognitionOne, stationB);
      harness.wait(const Duration(seconds: 60));

      expect(harness.sentChoices, hasLength(2));
      expect(startsAt.add(harness.sentChoices[0].at), DateTime.utc(2026, 10, 8, 10));
      final secondSendAt = startsAt.add(harness.sentChoices[1].at);
      expect(secondSendAt, DateTime.utc(2026, 10, 8, 10).add(expectedGap));
      expect(
        secondSendAt.isBefore(DateTime.utc(2026, 10, 8, 10, 0, 15)) ||
            secondSendAt.isAfter(DateTime.utc(2026, 10, 8, 10, 0, 30)),
        isFalse,
        reason: 'inside [10:00:15, 10:00:30]',
      );
      expect(harness.items, isEmpty);
    });
  });

  test('the walkthrough\'s development build: with "No signal" on, the retries come by themselves '
      'at most 5, 10, then 20 seconds apart, and the choice goes once the signal returns', () {
    runSenderTest(
      random: ScriptedRandom(doubles: [0.999999], integers: [5]),
      timingRules: const OutboxTimingRules(
        sendingDelayMaximumSeconds: 5,
        backoffFirstWaitSeconds: 5,
      ),
      (harness) {
        startScheduler(harness);
        for (var attempt = 0; attempt < 3; attempt++) {
          harness.answerChoiceWithNothing();
        }
        harness.answerChoice(204);
        harness.queueChoice(recognitionOne, stationB);
        harness.wait(const Duration(seconds: 60));

        final times = [for (final sent in harness.sentChoices) sent.at.inMilliseconds / 1000];
        expect(times, hasLength(4));
        expect(times.first, 5, reason: 'the new item waited at most 5 s');
        expect(
          [
            for (var index = 1; index < times.length; index++)
              (times[index] - times[index - 1]).round(),
          ],
          [5, 10, 20],
        );
        expect(harness.items, isEmpty);
      },
    );
  });

  test('disposed, it starts nothing more', () {
    runSenderTest(random: ScriptedRandom(), (harness) {
      final scheduler = startScheduler(harness);
      scheduler.dispose();
      harness.queueChoice(recognitionOne, stationB);
      harness.wait(const Duration(minutes: 5));
      expect(harness.sentChoices, isEmpty);
    });
  });
}
