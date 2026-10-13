import 'dart:io';
import 'dart:math';

import 'package:dio/dio.dart' show DioExceptionType, ResponseBody;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/outbox/outbox_sender.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/outbox/outbox_timing_rules.dart';

import '../../support/contract_fixtures.dart';
import 'outbox_sender_harness.dart';

/// The outbox sender with the station choice, its first kind (P6 design §3.9; contract §3;
/// P6-CHOOSER-10, P6-OUTBOX-03, -04, P6-OFFLINE-10, -12).
void main() {
  group('a run (§3.9 points 1 to 5)', () {
    test(
      'waits once, the drawn second from 0 to 120, then sends every due item (P6-OFFLINE-12)',
      () {
        final expectedWaitSeconds = Random(42).nextInt(121);
        runSenderTest(random: Random(42), (harness) {
          harness.queueChoice(recognitionOne, stationA);
          harness.queueChoice(recognitionTwo, stationB);
          harness.queueChoice(recognitionThree, stationA);
          for (var answer = 0; answer < 3; answer++) {
            harness.answerChoice(204);
          }
          harness.startRun(OutboxRunReason.appStarted);
          harness.wait(const Duration(seconds: 121));

          expect(expectedWaitSeconds, inInclusiveRange(0, 120));
          expect(harness.sentChoices.map((sent) => sent.at), [
            for (var send = 0; send < 3; send++) Duration(seconds: expectedWaitSeconds),
          ]);
          expect(harness.items, isEmpty);
        });
      },
    );

    test('every reason but a wake-up draws its wait from 0 to 120 s; an item queued after the '
        'last run emptied the queue from 0 to 10 s; a wake-up draws none', () {
      final random = ScriptedRandom(integers: [0]);
      runSenderTest(random: random, (harness) {
        harness.startRun(OutboxRunReason.appStarted);
        expect(random.integerBounds, isEmpty, reason: 'nothing waits, so no wait is drawn');
        harness.queueChoice(recognitionOne, stationA);
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.itemQueued);
        expect(random.integerBounds, [11], reason: 'the queue was empty: 0 to 10 s');

        harness.queueChoice(recognitionTwo, stationA);
        harness.answerChoice(500, code: 'INTERNAL');
        harness.startRun(OutboxRunReason.appResumed);
        expect(random.integerBounds, [11, 121]);
        expect(harness.items, hasLength(1));

        harness.queueChoice(recognitionThree, stationB);
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.itemQueued);
        expect(random.integerBounds, [11, 121, 121], reason: 'an item already waited');

        harness.answerChoice(204);
        harness.followWakeUps(runs: 1);
        expect(random.integerBounds, [11, 121, 121], reason: 'a wake-up draws no wait');
        expect(harness.items, isEmpty);
      });
    });

    test('a development build waits at most its own maximum', () {
      final random = ScriptedRandom(integers: [99]);
      runSenderTest(
        random: random,
        timingRules: const OutboxTimingRules(
          sendingDelayMaximumSeconds: 5,
          backoffFirstWaitSeconds: 5,
        ),
        (harness) {
          harness.queueChoice(recognitionOne, stationA);
          harness.answerChoice(204);
          harness.startRun(OutboxRunReason.appStarted);
          harness.wait(const Duration(seconds: 10));
          expect(random.integerBounds, [6]);
          expect(harness.sentChoices.single.at, const Duration(seconds: 5));
        },
      );
    });

    test('one request at a time, oldest first, even on a slow network (P6-OFFLINE-10)', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        var inFlight = 0;
        var mostInFlight = 0;
        harness.queueChoice(recognitionOne, stationA);
        harness.wait(const Duration(seconds: 1));
        harness.queueChoice(recognitionTwo, stationB);
        harness.wait(const Duration(seconds: 1));
        harness.queueChoice(recognitionThree, stationA);
        for (var answer = 0; answer < 3; answer++) {
          harness.adapter.answerWith((request, cancelFuture) async {
            harness.sentChoices.add(SentChoice(request, harness.fakeAsync.elapsed));
            inFlight++;
            mostInFlight = max(mostInFlight, inFlight);
            // A slow network: each answer takes 5 seconds.
            await Future<void>.delayed(const Duration(seconds: 5));
            inFlight--;
            return ResponseBody.fromString('', 204);
          });
        }
        harness.startRun(OutboxRunReason.appStarted);
        // A run started while one is under way is not a second run beside it.
        harness.startRun(OutboxRunReason.appResumed);
        expect(harness.runResults.single, isA<OutboxRunAlreadyUnderWay>());
        harness.wait(const Duration(seconds: 20));

        expect(mostInFlight, 1);
        expect(harness.sentChoices.map((sent) => sent.path.split('/')[4]), [
          recognitionOne,
          recognitionTwo,
          recognitionThree,
        ]);
        expect(harness.sentChoices.map((sent) => sent.at.inSeconds), [2, 7, 12]);
        expect(harness.items, isEmpty);
      });
    });

    test('no send starts while the listener\'s own identify is under way', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.answerChoice(204);
        harness.isLiveIdentifyUnderWay = true;
        harness.startRun(OutboxRunReason.itemQueued);
        harness.wait(const Duration(seconds: 30));
        expect(harness.sentChoices, isEmpty);
        harness.isLiveIdentifyUnderWay = false;
        harness.wait(OutboxTimingRules.liveIdentifyCheckInterval);
        expect(harness.sentChoices, hasLength(1));
        expect(harness.items, isEmpty);
      });
    });

    test('an item queued while a run waits is picked up by that run', () {
      runSenderTest(random: ScriptedRandom(integers: [30]), (harness) {
        harness.queueChoice(recognitionOne, stationA);
        harness.answerChoice(204);
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.appStarted);
        harness.wait(const Duration(seconds: 10));
        harness.queueChoice(recognitionTwo, stationB);
        harness.startRun(OutboxRunReason.itemQueued);
        harness.wait(const Duration(seconds: 25));
        expect(harness.sentChoices.map((sent) => sent.at), [
          const Duration(seconds: 30),
          const Duration(seconds: 30),
        ]);
        expect(harness.runResults.first, isA<OutboxRunAlreadyUnderWay>());
        expect(harness.items, isEmpty);
      });
    });

    test('another engine running the sender (sending.lock held by it) means no send here', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        const otherEngine = LockFileOwner(
          processId: 4242,
          engineId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
        );
        harness.attachedEngines.add(otherEngine.engineId);
        harness.queueChoice(recognitionOne, stationA);
        final otherLock = OwnedLockFile(
          file: File('${harness.folder.path}/sending.lock'),
          owner: otherEngine,
          isEngineAttached: harness.attachedEngines.contains,
          clock: harness.clock,
        );
        expect(otherLock.tryTake(), isTrue);
        harness.startRun(OutboxRunReason.appStarted);
        expect(harness.sentChoices, isEmpty);
        expect(harness.items, hasLength(1));
        expect((harness.runResults.single as OutboxRunEnded).nextWakeUpAt, isNull);
      });
    });

    test('a follow-up item queued 7 days ago is deleted unsent', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationA);
        harness.wait(const Duration(seconds: OutboxTimingRules.followUpItemLifetimeSeconds));
        harness.startRun(OutboxRunReason.appStarted);
        expect(harness.sentChoices, isEmpty);
        expect(harness.items, isEmpty);
      });
    });
  });

  group('a choice sent (contract §1.3; P6-CHOOSER-10)', () {
    test('goes once to recognitions/{id}/choice with exactly {station_id}; cleared on 204', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.itemQueued);

        final sent = harness.sentChoices.single;
        expect(sent.request.method, 'POST');
        expect(
          sent.request.address.toString(),
          'https://api.lookup.invalid/api/v1/recognitions/$recognitionOne/choice',
        );
        final validBody =
            (ContractFixtures.readFile(
                  'recognition/station-choice-input/valid/choose-station-b.json',
                )!
                as Map<String, Object?>)['body'];
        expect(sent.body, validBody);
        expect(sent.request.header('Authorization'), 'Bearer stored.install.token');
        expect(harness.items, isEmpty);
        expect(harness.reporter.reports, isEmpty);
      });
    });

    test('three failed sends of one item carry the same recognition and station; two items carry '
        'two; every attempt has a new request id (P6-OUTBOX-03)', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        for (var attempt = 0; attempt < 3; attempt++) {
          harness.answerChoiceWithNothing();
        }
        harness.startRun(OutboxRunReason.itemQueued);
        harness.followWakeUps(runs: 2);
        expect(harness.sentChoices, hasLength(3));
        expect(harness.sentChoices.map((sent) => sent.path).toSet(), {
          '/api/v1/recognitions/$recognitionOne/choice',
        });
        for (final sent in harness.sentChoices) {
          expect(sent.body, {'station_id': stationB});
        }
        expect(harness.sentChoices.map((sent) => sent.requestId).toSet(), hasLength(3));
        expect(harness.items.single.attemptCount, 3);

        harness.queueChoice(recognitionTwo, stationA);
        final keys = harness.items.map((item) => item.idempotencyKey).toList();
        expect(keys, [recognitionOne, recognitionTwo]);
      });
    });
  });

  group('waits (§3.9 point 9; contract R8, amendment A1)', () {
    test(
      'no answer: the item waits its backoff, each wait longer than the last (P6-OUTBOX-04)',
      () {
        // The largest factor each time, so the waits are exactly 30, 60, 120 and 240 seconds.
        runSenderTest(random: ScriptedRandom(doubles: [0.999999]), (harness) {
          harness.queueChoice(recognitionOne, stationB);
          harness.queueChoice(recognitionTwo, stationA);
          for (var attempt = 0; attempt < 4; attempt++) {
            harness.answerChoiceWithNothing();
          }
          harness.answerChoice(204);
          harness.answerChoice(204);
          harness.startRun(OutboxRunReason.itemQueued);
          expect(harness.sentChoices, hasLength(1), reason: 'the run ended on no answer');
          harness.followWakeUps(runs: 4);

          final times = harness.sentChoices.map((sent) => sent.at.inMilliseconds / 1000).toList();
          final gaps = [for (var index = 1; index < 5; index++) times[index] - times[index - 1]];
          expect(gaps.map((gap) => gap.round()), [30, 60, 120, 240]);
          for (var index = 1; index < gaps.length; index++) {
            expect(gaps[index], greaterThan(gaps[index - 1]));
          }
          expect(harness.sentChoices.last.path, contains(recognitionTwo));
          expect(harness.items, isEmpty);
        });
      },
    );

    test('the other items wait too after no answer: the next run is not before the failed item\'s '
        'own wait', () {
      runSenderTest(random: ScriptedRandom(doubles: [0]), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.queueChoice(recognitionTwo, stationA);
        harness.answerChoiceWithNothing();
        harness.startRun(OutboxRunReason.itemQueued);
        expect(
          harness.lastWakeUpAt,
          harness.clock.now().add(const Duration(seconds: 15)),
          reason: 'the second item is due now, but the network just gave no answer',
        );
      });
    });

    test('a Retry-After of 120 s on a 503 is honoured: no send before it ends', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.answerChoice(503, code: 'SERVICE_UNAVAILABLE', retryAfter: '120');
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.itemQueued);
        harness.wait(const Duration(seconds: 119));
        harness.startRun(OutboxRunReason.appResumed);
        harness.wait(const Duration(seconds: 0));
        expect(harness.sentChoices, hasLength(1), reason: 'the follow-ups are paused');
        harness.followWakeUps(runs: 2);
        expect(harness.sentChoices, hasLength(2));
        expect(harness.sentChoices.last.at, const Duration(seconds: 120));
        expect(harness.items, isEmpty);
      });
    });

    test('a 409 with nothing else queued is sent again after its Retry-After of 3 s', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.answerChoice(409, code: 'RECOGNITION_IN_PROGRESS', retryAfter: '3');
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.itemQueued);
        harness.followWakeUps(runs: 2);
        expect(harness.sentChoices.map((sent) => sent.at), [
          Duration.zero,
          const Duration(seconds: 3),
        ]);
        expect(harness.items, isEmpty);
      });
    });

    test('a 500 holds only its own item, which goes again after its backoff', () {
      runSenderTest(random: ScriptedRandom(doubles: [0]), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.queueChoice(recognitionTwo, stationA);
        harness.answerChoice(500, code: 'INTERNAL');
        harness.answerChoice(204);
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.itemQueued);
        expect(harness.sentChoices.map((sent) => sent.path.split('/')[4]), [
          recognitionOne,
          recognitionTwo,
        ]);
        harness.followWakeUps(runs: 2);
        expect(harness.sentChoices.last.at, const Duration(seconds: 15));
        expect(harness.items, isEmpty);
      });
    });

    test('a 429 pauses the follow-ups for its Retry-After; nothing of the group goes before it '
        'ends (P6-D38)', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.queueChoice(recognitionTwo, stationA);
        harness.answerChoice(429, code: 'RATE_LIMITED', retryAfter: '45');
        harness.answerChoice(204);
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.itemQueued);
        expect(harness.sentChoices, hasLength(1));
        expect(
          harness.index.groupPausedUntil[OutboxItemGroup.followUps],
          harness.clock.now().add(const Duration(seconds: 45)),
        );
        expect(harness.items.first.lastProblem, OutboxItemProblem.limited);
        harness.followWakeUps(runs: 2);
        expect(harness.sentChoices.skip(1).map((sent) => sent.at), [
          const Duration(seconds: 45),
          const Duration(seconds: 45),
        ]);
        expect(harness.items, isEmpty);
      });
    });

    test('a wait stored more than an hour away (the clock went back) is cut to an hour, and the '
        'item goes then', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        final waiting = harness.items.single;
        // Set while the phone's clock was 3 days ahead; the clock has since been put right.
        harness.store.modify(
          (index) => index.withItemReplaced(
            waiting.retried(
              nextAttemptAt: harness.clock.now().add(const Duration(days: 3)),
              lastProblem: OutboxItemProblem.busy,
            ),
          ),
        );
        harness.settle();
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.appResumed);
        expect(harness.lastWakeUpAt, harness.clock.now().add(const Duration(hours: 1)));

        harness.followWakeUps(runs: 3);
        expect(harness.sentChoices.map((sent) => sent.at), [const Duration(hours: 1)]);
        expect(harness.items, isEmpty);
      });
    });

    test('a group pause stored more than an hour away (the clock went back) is cut to an hour, and '
        'the group goes on then', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.store.modify(
          (index) => index.withGroupPausedUntil(
            OutboxItemGroup.followUps,
            harness.clock.now().add(const Duration(days: 3)),
          ),
        );
        harness.settle();
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.appResumed);
        expect(harness.sentChoices, isEmpty, reason: 'the follow-ups are paused');

        harness.followWakeUps(runs: 3);
        expect(harness.sentChoices.map((sent) => sent.at), [const Duration(hours: 1)]);
        expect(harness.items, isEmpty);
      });
    });

    test('the cuts are written to the outbox, so a restart keeps them: an item\'s wait and a '
        'group\'s pause an hour away, a probe 6 hours away, and no attempt counted', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        final waiting = harness.items.single;
        final threeDaysAhead = harness.clock.now().add(const Duration(days: 3));
        harness.store.modify(
          (index) => index
              .withItemReplaced(
                waiting.retried(nextAttemptAt: threeDaysAhead, lastProblem: OutboxItemProblem.busy),
              )
              .withGroupPausedUntil(OutboxItemGroup.followUps, threeDaysAhead)
              .withUpdatePause(
                OutboxUpdatePause(
                  appVersion: harness.appVersion,
                  pausedAt: harness.clock.now(),
                  nextProbeAt: threeDaysAhead,
                ),
              ),
        );
        harness.settle();
        harness.startRun(OutboxRunReason.appResumed);

        final now = harness.clock.now();
        expect(harness.sentChoices, isEmpty);
        final stored = harness.items.single;
        expect(stored.nextAttemptAt, now.add(const Duration(hours: 1)));
        expect(stored.attemptCount, 1, reason: 'a cut is not an attempt');
        expect(stored.lastProblem, OutboxItemProblem.busy);
        expect(
          harness.index.groupPausedUntil[OutboxItemGroup.followUps],
          now.add(const Duration(hours: 1)),
        );
        expect(harness.index.updatePause?.nextProbeAt, now.add(const Duration(hours: 6)));
      });
    });
    test('the cut starts just past an hour: a wait an hour and a second away is cut to an hour, '
        'and a wait 45 minutes away is kept as it is', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.queueChoice(recognitionTwo, stationA);
        final now = harness.clock.now();
        final [first, second] = harness.items;
        harness.store.modify(
          (index) => index
              .withItemReplaced(
                first.retried(
                  nextAttemptAt: now.add(const Duration(hours: 1, seconds: 1)),
                  lastProblem: OutboxItemProblem.busy,
                ),
              )
              .withItemReplaced(
                second.retried(
                  nextAttemptAt: now.add(const Duration(minutes: 45)),
                  lastProblem: OutboxItemProblem.busy,
                ),
              ),
        );
        harness.settle();
        harness.startRun(OutboxRunReason.appResumed);

        expect(harness.sentChoices, isEmpty);
        final storedWaits = {
          for (final item in harness.items)
            (item as StationChoiceItem).recognitionId: item.nextAttemptAt,
        };
        expect(storedWaits, {
          recognitionOne: now.add(const Duration(hours: 1)),
          recognitionTwo: now.add(const Duration(minutes: 45)),
        });
      });
    });

    test('a group pause an hour and a second away is cut to an hour', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        final now = harness.clock.now();
        harness.store.modify(
          (index) => index.withGroupPausedUntil(
            OutboxItemGroup.followUps,
            now.add(const Duration(hours: 1, seconds: 1)),
          ),
        );
        harness.settle();
        harness.startRun(OutboxRunReason.appResumed);
        expect(harness.sentChoices, isEmpty);
        expect(
          harness.index.groupPausedUntil[OutboxItemGroup.followUps],
          now.add(const Duration(hours: 1)),
        );
      });
    });
  });

  group('the token (contract R10)', () {
    test('401, then 204: one registration with the same install id, and one resend', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.answerChoice(401, code: 'INSTALL_TOKEN_INVALID');
        harness.answerRegistration('new.install.token');
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.itemQueued);

        expect(harness.registrations, hasLength(1));
        expect(
          (harness.registrations.single.jsonBody! as Map<String, Object?>)['install_id'],
          '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f',
        );
        expect(harness.sentChoices.map((sent) => sent.request.header('Authorization')), [
          'Bearer stored.install.token',
          'Bearer new.install.token',
        ]);
        expect(harness.items, isEmpty);
      });
    });

    test('a second 401 in one run keeps the item and ends the run', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.queueChoice(recognitionTwo, stationA);
        harness.answerChoice(401, code: 'INSTALL_TOKEN_INVALID');
        harness.answerRegistration('new.install.token');
        harness.answerChoice(401, code: 'INSTALL_TOKEN_INVALID');
        harness.startRun(OutboxRunReason.itemQueued);

        expect(harness.registrations, hasLength(1));
        expect(harness.sentChoices, hasLength(2));
        expect(harness.items, hasLength(2));
        expect(harness.items.first.attemptCount, 1);
        expect(harness.items.first.nextAttemptAt, isNotNull);
      });
    });

    test('a registration with no answer counts as no answer for the item, and the run ends', () {
      runSenderTest(random: ScriptedRandom(doubles: [0]), hasStoredToken: false, (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.adapter.failWithDioType(DioExceptionType.connectionError);
        harness.startRun(OutboxRunReason.itemQueued);
        expect(harness.sentChoices, isEmpty);
        expect(harness.items.single.lastProblem, OutboxItemProblem.noAnswer);
        expect(harness.lastWakeUpAt, harness.clock.now().add(const Duration(seconds: 15)));
      });
    });
  });

  group('the 426 pause (contract R11, amendment A2)', () {
    test('a 426 keeps the item and holds everything; nothing more goes in that run or later '
        'until a probe', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.queueChoice(recognitionTwo, stationA);
        harness.answerChoice(426, code: 'APP_UPDATE_REQUIRED');
        harness.startRun(OutboxRunReason.itemQueued);
        expect(harness.sentChoices, hasLength(1));
        expect(harness.index.updatePause?.appVersion, harness.appVersion);
        expect(harness.items.first.lastProblem, OutboxItemProblem.updateRequired);

        harness.startRun(OutboxRunReason.appResumed);
        harness.wait(const Duration(seconds: 121));
        expect(harness.sentChoices, hasLength(1), reason: 'a resume is not a probe');
        expect(
          harness.lastWakeUpAt,
          harness.clock.now().subtract(const Duration(seconds: 121)).add(const Duration(hours: 6)),
        );
      });
    });

    test('a probe at the next start answered 204 ends the pause, and the rest goes', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.queueChoice(recognitionTwo, stationA);
        harness.answerChoice(426, code: 'APP_UPDATE_REQUIRED');
        harness.startRun(OutboxRunReason.itemQueued);

        harness.answerChoice(204);
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.appStarted);
        expect(harness.sentChoices, hasLength(3));
        expect(harness.index.updatePause, isNull);
        expect(harness.items, isEmpty);
      });
    });

    test('a probe answered 426 keeps the pause, and the next probe is 6 hours later', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.answerChoice(426, code: 'APP_UPDATE_REQUIRED');
        harness.startRun(OutboxRunReason.itemQueued);
        harness.answerChoice(426, code: 'APP_UPDATE_REQUIRED');
        harness.startRun(OutboxRunReason.appStarted);
        expect(harness.sentChoices, hasLength(2));
        expect(harness.index.updatePause, isNotNull);
        expect(harness.lastWakeUpAt, harness.clock.now().add(const Duration(hours: 6)));

        harness.answerChoice(204);
        harness.followWakeUps(runs: 1);
        expect(harness.sentChoices.last.at, const Duration(hours: 6));
        expect(harness.index.updatePause, isNull);
        expect(harness.items, isEmpty);
      });
    });

    test('a new app version ends the pause at once: the outbox paused under another version '
        'sends again', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.store.modify(
          (index) => index.withUpdatePause(
            OutboxUpdatePause(
              appVersion: '0.0.9+1',
              pausedAt: harness.clock.now(),
              nextProbeAt: harness.clock.now().add(const Duration(hours: 6)),
            ),
          ),
        );
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.appResumed);
        expect(harness.sentChoices, hasLength(1));
        expect(harness.index.updatePause, isNull);
        expect(harness.items, isEmpty);
      });
    });

    test('a probe with no answer keeps the pause, and the next probe is 6 hours later', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.queueChoice(recognitionTwo, stationA);
        harness.answerChoice(426, code: 'APP_UPDATE_REQUIRED');
        harness.startRun(OutboxRunReason.itemQueued);
        // The app is closed past the time of the next probe, and starts again with no signal.
        harness.wait(const Duration(hours: 7));
        harness.answerChoiceWithNothing();
        harness.startRun(OutboxRunReason.appStarted);
        expect(harness.sentChoices, hasLength(2));
        expect(harness.index.updatePause, isNotNull, reason: 'no answer says nothing of the gate');
        expect(harness.items.first.lastProblem, OutboxItemProblem.noAnswer);
        expect(harness.lastWakeUpAt, harness.clock.now().add(const Duration(hours: 6)));

        harness.answerChoice(204);
        harness.answerChoice(204);
        harness.followWakeUps(runs: 1);
        expect(harness.sentChoices.map((sent) => sent.at), [
          Duration.zero,
          const Duration(hours: 7),
          const Duration(hours: 13),
          const Duration(hours: 13),
        ]);
        expect(harness.index.updatePause, isNull);
        expect(harness.items, isEmpty);
      });
    });

    test('a probe stopped by a fault on the phone keeps the pause: that item is deleted and '
        'reported, and the others wait for the next probe, 6 hours later', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.queueChoice(recognitionTwo, stationA);
        harness.answerChoice(426, code: 'APP_UPDATE_REQUIRED');
        harness.startRun(OutboxRunReason.itemQueued);
        harness.answerChoiceWithPhoneFault();
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.appStarted);
        expect(harness.index.updatePause, isNotNull, reason: 'the server never answered');
        expect(harness.sentChoices, hasLength(2));
        expect(harness.items.map((item) => (item as StationChoiceItem).recognitionId), [
          recognitionTwo,
        ]);
        expect('${harness.reporter.reports.single.error}', contains('STATION_CHOICE'));
        expect(harness.lastWakeUpAt, harness.clock.now().add(const Duration(hours: 6)));

        harness.followWakeUps(runs: 1);
        expect(harness.sentChoices.last.at, const Duration(hours: 6));
        expect(harness.index.updatePause, isNull);
        expect(harness.items, isEmpty);
      });
    });

    test('a probe time stored more than 6 hours away (the clock went back) is cut to 6 hours, and '
        'the probe goes then', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.store.modify(
          (index) => index.withUpdatePause(
            OutboxUpdatePause(
              appVersion: harness.appVersion,
              pausedAt: harness.clock.now(),
              nextProbeAt: harness.clock.now().add(const Duration(days: 3)),
            ),
          ),
        );
        harness.settle();
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.appResumed);
        expect(harness.sentChoices, isEmpty, reason: 'a resume is not a probe');

        harness.followWakeUps(runs: 3);
        expect(harness.sentChoices.map((sent) => sent.at), [const Duration(hours: 6)]);
        expect(harness.index.updatePause, isNull);
        expect(harness.items, isEmpty);
      });
    });
    test(
      'a probe time 6 hours and a second away is cut to 6 hours, and one 5 hours away is kept',
      () {
        runSenderTest(random: ScriptedRandom(), (harness) {
          harness.queueChoice(recognitionOne, stationB);
          final now = harness.clock.now();
          OutboxUpdatePause pauseProbingAt(Duration away) => OutboxUpdatePause(
            appVersion: harness.appVersion,
            pausedAt: now,
            nextProbeAt: now.add(away),
          );
          harness.store.modify(
            (index) => index.withUpdatePause(pauseProbingAt(const Duration(hours: 6, seconds: 1))),
          );
          harness.settle();
          harness.startRun(OutboxRunReason.appResumed);
          expect(harness.index.updatePause?.nextProbeAt, now.add(const Duration(hours: 6)));

          harness.store.modify(
            (index) => index.withUpdatePause(pauseProbingAt(const Duration(hours: 5))),
          );
          harness.settle();
          harness.startRun(OutboxRunReason.appResumed);
          expect(harness.index.updatePause?.nextProbeAt, now.add(const Duration(hours: 5)));
          expect(harness.sentChoices, isEmpty, reason: 'a resume is not a probe');
        });
      },
    );

    test('a probe answered 500 ends the pause: that item backs off, and the next one goes', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.queueChoice(recognitionTwo, stationA);
        harness.answerChoice(426, code: 'APP_UPDATE_REQUIRED');
        harness.startRun(OutboxRunReason.itemQueued);

        harness.answerChoice(500, code: 'INTERNAL');
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.appStarted);
        expect(harness.index.updatePause, isNull, reason: 'the server answered, and not with 426');
        expect(harness.sentChoices, hasLength(3));
        final waiting = harness.items.single as StationChoiceItem;
        expect(waiting.recognitionId, recognitionOne);
        expect(waiting.lastProblem, OutboxItemProblem.busy);
        expect(waiting.nextAttemptAt, isNotNull);
      });
    });

    test('a probe answered 429 with a Retry-After ends the pause and pauses its group for that '
        'time', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.queueChoice(recognitionTwo, stationA);
        harness.answerChoice(426, code: 'APP_UPDATE_REQUIRED');
        harness.startRun(OutboxRunReason.itemQueued);

        harness.answerChoice(429, code: 'RATE_LIMITED', retryAfter: '120');
        harness.startRun(OutboxRunReason.appStarted);
        final now = harness.clock.now();
        expect(harness.index.updatePause, isNull);
        expect(
          harness.sentChoices,
          hasLength(2),
          reason: 'the follow-ups wait for the Retry-After',
        );
        expect(
          harness.index.groupPausedUntil[OutboxItemGroup.followUps],
          now.add(const Duration(seconds: 120)),
        );
        expect(harness.lastWakeUpAt, now.add(const Duration(seconds: 120)));

        harness.answerChoice(204);
        harness.answerChoice(204);
        harness.followWakeUps(runs: 1);
        expect(harness.sentChoices.skip(2).map((sent) => sent.at), [
          const Duration(seconds: 120),
          const Duration(seconds: 120),
        ]);
        expect(harness.items, isEmpty);
      });
    });

    test('a probe whose token is refused twice keeps the pause: the server checks the token before '
        'the version, so a refused token says nothing of the gate', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.answerChoice(426, code: 'APP_UPDATE_REQUIRED');
        harness.startRun(OutboxRunReason.itemQueued);

        harness.answerChoice(401, code: 'INSTALL_TOKEN_INVALID');
        harness.answerRegistration('new.install.token');
        harness.answerChoice(401, code: 'INSTALL_TOKEN_INVALID');
        harness.startRun(OutboxRunReason.appStarted);
        expect(harness.registrations, hasLength(1));
        expect(harness.sentChoices, hasLength(3));
        expect(harness.index.updatePause, isNotNull);
        expect(harness.lastWakeUpAt, harness.clock.now().add(const Duration(hours: 6)));
      });
    });

    test('a probe whose registration gets no answer keeps the pause, and the next probe is 6 hours '
        'later', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.answerChoice(426, code: 'APP_UPDATE_REQUIRED');
        harness.startRun(OutboxRunReason.itemQueued);
        // By the next start the token has gone, so the probe must register first, and the phone
        // starts with no signal.
        harness.forgetStoredToken();
        harness.wait(const Duration(hours: 7));
        harness.adapter.failWithDioType(DioExceptionType.connectionError);
        harness.startRun(OutboxRunReason.appStarted);
        expect(harness.registrations, hasLength(1));
        expect(harness.sentChoices, hasLength(1), reason: 'only the send that got the 426');
        expect(harness.index.updatePause, isNotNull, reason: 'no answer says nothing of the gate');
        expect(harness.items.single.lastProblem, OutboxItemProblem.noAnswer);
        expect(harness.lastWakeUpAt, harness.clock.now().add(const Duration(hours: 6)));

        harness.answerRegistration('new.install.token');
        harness.answerChoice(204);
        harness.followWakeUps(runs: 1);
        expect(harness.sentChoices.last.at, const Duration(hours: 13));
        expect(harness.index.updatePause, isNull);
        expect(harness.items, isEmpty);
      });
    });
  });

  group('a failure on the phone: the storage full', () {
    test('runs that fail one after another wait longer each time: 30, 60, then 120 s; a run that '
        'does not fail starts the count again', () {
      // The largest factor each time, so the waits are exactly 30, 60 and 120 seconds.
      runSenderTest(random: ScriptedRandom(doubles: [0.999999]), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.fillStorage();
        for (var answer = 0; answer < 4; answer++) {
          harness.answerChoice(500, code: 'INTERNAL');
        }
        harness.startRun(OutboxRunReason.itemQueued);
        harness.followWakeUps(runs: 3);
        // No 500 could be written down, so each run sent the choice again.
        final times = [for (final sent in harness.sentChoices) sent.at.inMilliseconds / 1000];
        expect(
          [
            for (var index = 1; index < times.length; index++)
              (times[index] - times[index - 1]).round(),
          ],
          [30, 60, 120],
        );

        harness.freeStorage();
        harness.answerChoice(204);
        harness.followWakeUps(runs: 1);
        expect(harness.items, isEmpty);
        expect(harness.lastWakeUpAt, isNull);

        harness.queueChoice(recognitionTwo, stationA);
        harness.fillStorage();
        harness.answerChoice(500, code: 'INTERNAL');
        harness.startRun(OutboxRunReason.itemQueued);
        expect(harness.lastWakeUpAt, harness.clock.now().add(const Duration(seconds: 30)));
      });
    });

    test('a development build\'s failed runs wait from its own first wait: 5, then 10 s', () {
      runSenderTest(
        random: ScriptedRandom(doubles: [0.999999]),
        timingRules: const OutboxTimingRules(
          sendingDelayMaximumSeconds: 5,
          backoffFirstWaitSeconds: 5,
        ),
        (harness) {
          harness.queueChoice(recognitionOne, stationB);
          harness.fillStorage();
          for (var answer = 0; answer < 3; answer++) {
            harness.answerChoice(500, code: 'INTERNAL');
          }
          harness.startRun(OutboxRunReason.itemQueued);
          harness.followWakeUps(runs: 2);
          final times = [for (final sent in harness.sentChoices) sent.at.inMilliseconds / 1000];
          expect(
            [
              for (var index = 1; index < times.length; index++)
                (times[index] - times[index - 1]).round(),
            ],
            [5, 10],
          );
        },
      );
    });

    test('failed runs in a row never wait longer than 30 minutes', () {
      runSenderTest(random: ScriptedRandom(doubles: [0.999999]), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.fillStorage();
        for (var answer = 0; answer < 9; answer++) {
          harness.answerChoice(500, code: 'INTERNAL');
        }
        harness.startRun(OutboxRunReason.itemQueued);
        harness.followWakeUps(runs: 8);
        final times = [for (final sent in harness.sentChoices) sent.at.inMilliseconds / 1000];
        expect(
          [
            for (var index = 1; index < times.length; index++)
              (times[index] - times[index - 1]).round(),
          ],
          [30, 60, 120, 240, 480, 960, 1800, 1800],
        );
      });
    });

    test('a choice the server took whose deletion cannot be written is not sent again; the next '
        'write that succeeds deletes it', () {
      runSenderTest(random: ScriptedRandom(doubles: [0.999999]), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.answerChoice(204, whileAnswering: harness.fillStorage);
        // What a second send would get. None may go: the server already has the choice.
        harness.answerChoice(204);
        harness.startRun(OutboxRunReason.itemQueued);
        expect(harness.items, hasLength(1), reason: 'its deletion could not be written');

        harness.followWakeUps(runs: 3);
        expect(harness.sentChoices, hasLength(1));
        expect(harness.items, hasLength(1));

        harness.freeStorage();
        harness.followWakeUps(runs: 1);
        expect(harness.sentChoices, hasLength(1));
        expect(harness.items, isEmpty);
        expect(harness.lastWakeUpAt, isNull);
      });
    });

    test('a refused choice whose deletion cannot be written is reported once, and not sent '
        'again', () {
      runSenderTest(random: ScriptedRandom(doubles: [0.999999]), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.answerChoice(
          422,
          code: 'STATION_ALREADY_CHOSEN',
          whileAnswering: harness.fillStorage,
        );
        // What a second send would get. None may go: the server refused the choice for good.
        harness.answerChoice(422, code: 'STATION_ALREADY_CHOSEN');
        harness.startRun(OutboxRunReason.itemQueued);
        harness.freeStorage();
        harness.followWakeUps(runs: 2);

        expect(harness.sentChoices, hasLength(1));
        expect(harness.items, isEmpty);
        expect([
          for (final report in harness.reporter.reports)
            if ('${report.error}'.contains('422 STATION_ALREADY_CHOSEN')) report,
        ], hasLength(1));
      });
    });
  });

  group('acknowledgement, item by item (contract §1.3; acknowledgement-rules.json)', () {
    test('a refusal the app caused deletes the item and reports it with the API\'s id, never its '
        'message', () {
      runSenderTest(random: ScriptedRandom(), (harness) {
        harness.queueChoice(recognitionOne, stationB);
        harness.answerChoice(422, code: 'STATION_ALREADY_CHOSEN');
        harness.startRun(OutboxRunReason.itemQueued);
        expect(harness.items, isEmpty);
        final report = harness.reporter.reports.single;
        // The API's id for the answer: it echoed the request id the app sent.
        expect(report.relatedRequestId, harness.sentChoices.single.requestId);
        expect('${report.error}', contains('STATION_CHOICE'));
        expect('${report.error}', contains('422 STATION_ALREADY_CHOSEN'));
        expect('${report.error}', isNot(contains('An API message')));
      });
    });

    final rows =
        [
          for (final row
              in (ContractFixtures.readFile('listener-outbox/acknowledgement-rules.json')!
                      as Map<String, Object?>)['rows']!
                  as List<Object?>)
            row! as Map<String, Object?>,
        ].where(
          (row) =>
              row['item_kind'] == 'STATION_CHOICE' &&
              row['answer'] == 'HTTP' &&
              row['http_status'] != null,
        );

    for (final row in rows) {
      final status = row['http_status']! as int;
      final code = row['error_code'] as String?;
      final retryAfter = row['retry_after_seconds'] as int?;
      final action = row['action']! as String;
      test(
        '$status ${code ?? ''} ${retryAfter == null ? '' : 'Retry-After $retryAfter '}→ $action: '
        'the item on disk afterwards',
        () {
          runSenderTest(random: ScriptedRandom(doubles: [0]), (harness) {
            harness.queueChoice(recognitionOne, stationB);
            harness.answerChoice(status, code: code, retryAfter: retryAfter?.toString());
            if (action == 'REGISTER_AGAIN_AND_RESEND') {
              harness.answerRegistration('new.install.token');
              harness.answerChoice(204);
            }
            harness.startRun(OutboxRunReason.itemQueued);
            final now = harness.clock.now();
            final item = harness.items.firstOrNull;
            switch (action) {
              case 'DELETE' || 'REGISTER_AGAIN_AND_RESEND':
                expect(item, isNull);
                expect(harness.reporter.reports, isEmpty);
              case 'DELETE_AND_REPORT':
                expect(item, isNull);
                expect(harness.reporter.reports, hasLength(1));
              case 'ITEM_WAITS':
                final seconds = (row['wait']! as Map<String, Object?>)['seconds']! as int;
                expect(item!.nextAttemptAt, now.add(Duration(seconds: seconds)));
              case 'ITEM_BACKS_OFF':
                expect(item!.nextAttemptAt, now.add(const Duration(seconds: 15)));
                expect(item.attemptCount, 1);
              case 'PAUSE_GROUP':
                final seconds = (row['wait']! as Map<String, Object?>)['seconds']! as int;
                expect(item, isNotNull);
                expect(
                  harness.index.groupPausedUntil[OutboxItemGroup.followUps],
                  now.add(Duration(seconds: seconds)),
                );
              case 'PAUSE_ALL_UNTIL_APP_VERSION_CHANGES':
                expect(item, isNotNull);
                expect(harness.index.updatePause, isNotNull);
              default:
                fail('An action this test does not know: $action');
            }
          });
        },
      );
    }
  });
}
