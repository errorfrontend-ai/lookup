import 'dart:convert';
import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart' show DioExceptionType, Headers, ResponseBody;
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/outbox/outbox_index.dart';
import 'package:lookup_listener/core/outbox/outbox_item.dart';
import 'package:lookup_listener/core/outbox/outbox_item_group.dart';
import 'package:lookup_listener/core/outbox/outbox_sender.dart';
import 'package:lookup_listener/core/outbox/outbox_timing_rules.dart';
import 'package:lookup_listener/features/identify/data/recognize_request_builder.dart';
import 'package:lookup_listener/features/identify/domain/deferred_result_sink.dart';

import '../../support/contract_fixtures.dart';
import '../../support/received_multipart_form.dart';
import 'outbox_sender_harness.dart';

const String _keyOne = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c21';
const String _keyTwo = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c22';

/// The recognition ids of the shared answers.
const String _matchRecognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';

void _runSenderTest(void Function(OutboxSenderHarness harness) body) {
  fakeAsync((fakeAsync) {
    final harness = OutboxSenderHarness(fakeAsync);
    try {
      body(harness);
    } finally {
      harness.dispose();
    }
  });
}

/// Saved clips and queued crash reports through the outbox sender (P6 design §3.8, §3.9, §3.11,
/// §3.20; contract R1 to R5, R9; P6-OFFLINE-01, -02, -05, -07, -09; P6-OUTBOX-07): what is sent, what
/// each answer does with the clip, and where its outcome goes.
void main() {
  group('a saved clip is sent', () {
    test('as the same clip: its key, capture time, hint and recording, marked deferred, with the '
        'send time of this attempt (P6-OUTBOX-07)', () {
      _runSenderTest((harness) {
        final capturedAt = harness.clock.now().subtract(const Duration(minutes: 5));
        final audio = [0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32, 1, 2, 3];
        harness.queueClip(_keyOne, capturedAt: capturedAt, audioBytes: audio);
        harness.answerWithResponseFixture('valid/match-campaign');
        harness.startRun(OutboxRunReason.wakeUp);

        final form = ReceivedMultipartForm.of(harness.recognizeRequests.single);
        expect(form.fieldValues['idempotency_key'], _keyOne);
        expect(form.fieldValues['is_deferred'], 'true');
        expect(
          form.fieldValues['captured_at'],
          RecognizeRequestBuilder.formatUtcTimestamp(capturedAt),
        );
        expect(
          form.fieldValues['sent_at'],
          RecognizeRequestBuilder.formatUtcTimestamp(harness.clock.now()),
        );
        expect(form.fieldValues['station_hint'], stationA);
        expect(form.fileParts.single.bytes, audio);
      });
    });

    test('a match goes to History with its answer, and the clip and its recording are deleted', () {
      _runSenderTest((harness) {
        final capturedAt = harness.clock.now().subtract(const Duration(minutes: 5));
        harness.queueClip(_keyOne, capturedAt: capturedAt);
        harness.answerWithResponseFixture('valid/match-campaign');
        harness.startRun(OutboxRunReason.wakeUp);

        final outcome = harness.resultSink.outcomes.single as DeferredClipMatched;
        expect(outcome.idempotencyKey, _keyOne);
        expect(outcome.capturedAtOnPhone, capturedAt);
        expect(outcome.recognitionId, _matchRecognitionId);
        expect(outcome.answerBody['status'], 'MATCH');
        expect(harness.items, isEmpty);
        expect(File('${harness.folder.path}/clips/$_keyOne.m4a').existsSync(), isFalse);
        expect(harness.reporter.reports, isEmpty);
      });
    });

    test('ACCOUNT_REQUIRED goes to History as a scan waiting for an account, and the clip is deleted (LA-APP-09)', () {
      _runSenderTest((harness) {
        final capturedAt = harness.clock.now();
        harness.queueClip(_keyOne, capturedAt: capturedAt);
        harness.answerWithResponseFixture('valid/account-required-deferred');
        harness.startRun(OutboxRunReason.wakeUp);

        final outcome = harness.resultSink.outcomes.single as DeferredClipAwaitingAccount;
        expect(outcome.idempotencyKey, _keyOne);
        expect(outcome.capturedAtOnPhone, capturedAt);
        expect(outcome.recognitionId, _matchRecognitionId);
        expect(outcome.answerBody['status'], 'ACCOUNT_REQUIRED');
        expect(harness.items, isEmpty, reason: 'a 200 is final: the clip is not sent again');
        expect(File('${harness.folder.path}/clips/$_keyOne.m4a').existsSync(), isFalse);
        expect(harness.reporter.reports, isEmpty);
      });
    });

    test('"Which station?" goes to History as a chooser to answer later', () {
      _runSenderTest((harness) {
        harness.queueClip(_keyOne, capturedAt: harness.clock.now());
        harness.answerWithResponseFixture('valid/choose-station');
        harness.startRun(OutboxRunReason.wakeUp);

        final outcome = harness.resultSink.outcomes.single as DeferredClipAwaitingChoice;
        expect(outcome.recognitionId, _matchRecognitionId);
        expect(outcome.answerBody['status'], 'CHOOSE_STATION');
        expect(harness.items, isEmpty);
      });
    });

    for (final (name, fixture, reason) in [
      ('no match', null, DeferredClipNotIdentifiedReason.notRecognised),
      ('400 INVALID_AUDIO', 'invalid-audio', DeferredClipNotIdentifiedReason.notRecognised),
      (
        '422 CAPTURE_EXPIRED',
        'capture-expired',
        DeferredClipNotIdentifiedReason.notSentWithin24Hours,
      ),
      (
        '422 CAPTURE_TIME_INVALID',
        'capture-time-invalid',
        DeferredClipNotIdentifiedReason.couldNotBeChecked,
      ),
    ]) {
      test('$name: History keeps "${reason.storedName}", and the clip is deleted', () {
        _runSenderTest((harness) {
          harness.queueClip(_keyOne, capturedAt: harness.clock.now());
          if (fixture == null) {
            harness.answerWithResponseFixture('valid/no-match');
          } else {
            harness.answerWithEnvelopeFixture(fixture);
          }
          harness.startRun(OutboxRunReason.wakeUp);

          final outcome = harness.resultSink.outcomes.single as DeferredClipNotIdentified;
          expect(outcome.reason, reason);
          expect(outcome.idempotencyKey, _keyOne);
          expect(harness.items, isEmpty);
          expect(harness.reporter.reports, isEmpty);
        });
      });
    }

    test(
      'busy: the clip waits, the clips pause as the server asked, and History hears nothing',
      () {
        _runSenderTest((harness) {
          harness.queueClip(_keyOne, capturedAt: harness.clock.now());
          harness.answerWithEnvelopeFixture('recognition-busy', retryAfter: '187');
          harness.startRun(OutboxRunReason.wakeUp);

          expect(harness.items, hasLength(1));
          expect(
            harness.index.groupPausedUntil[OutboxItemGroup.clips],
            harness.clock.now().add(const Duration(seconds: 187)),
          );
          expect(harness.resultSink.outcomes, isEmpty);
          expect(File('${harness.folder.path}/clips/$_keyOne.m4a').existsSync(), isTrue);
        });
      },
    );

    test('an answer History cannot keep deletes the clip with a report, as a phone fault does '
        '(contract R9)', () {
      _runSenderTest((harness) {
        harness.queueClip(_keyOne, capturedAt: harness.clock.now());
        harness.resultSink.failure = const FileSystemException('The phone is full');
        harness.answerWithResponseFixture('valid/match-campaign');
        harness.startRun(OutboxRunReason.wakeUp);

        expect(harness.items, isEmpty);
        expect(harness.reporter.reports, hasLength(1));
        expect(harness.reporter.reports.single.error.toString(), isNot(contains('phone is full')));
      });
    });

    test('a clip whose recording is gone is not sent: deleted, with a report', () {
      _runSenderTest((harness) {
        harness.queueClip(_keyOne, capturedAt: harness.clock.now());
        File('${harness.folder.path}/clips/$_keyOne.m4a').deleteSync();
        harness.startRun(OutboxRunReason.wakeUp);

        expect(harness.recognizeRequests, isEmpty);
        expect(harness.items, isEmpty);
        expect(harness.reporter.reports, hasLength(1));
      });
    });

    test('two clips go one at a time, oldest capture first (contract R7)', () {
      _runSenderTest((harness) {
        harness.queueClip(_keyTwo, capturedAt: harness.clock.now());
        harness.queueClip(
          _keyOne,
          capturedAt: harness.clock.now().subtract(const Duration(minutes: 3)),
        );
        harness.answerWithResponseFixture('valid/no-match');
        harness.answerWithResponseFixture('valid/no-match');
        harness.startRun(OutboxRunReason.wakeUp);
        harness.followWakeUps();

        expect(
          harness.recognizeRequests.map(
            (request) => ReceivedMultipartForm.of(request).fieldValues['idempotency_key'],
          ),
          [_keyOne, _keyTwo],
        );
      });
    });
  });

  group('the network (P6 design §3.9 points 1, 7 and 9; P6-OFFLINE-07)', () {
    test('with none, nothing is tried, and the run asks for no wake-up: the network coming back '
        'starts the next', () {
      _runSenderTest((harness) {
        harness.isNetworkUp = false;
        harness.queueClip(_keyOne, capturedAt: harness.clock.now());
        harness.startRun(OutboxRunReason.wakeUp);

        expect(harness.adapter.requests, isEmpty);
        expect(harness.lastWakeUpAt, isNull);
        expect(harness.items, hasLength(1));
      });
    });

    test('back: a wait that came from no answer is cleared, and the clip goes after the sending '
        'delay rather than at the end of its backoff', () {
      _runSenderTest((harness) {
        harness.queueClip(_keyOne, capturedAt: harness.clock.now());
        harness.adapter.failWithDioType(DioExceptionType.connectionError);
        harness.startRun(OutboxRunReason.wakeUp);
        final waiting = harness.items.single;
        expect(waiting.lastProblem, OutboxItemProblem.noAnswer);
        expect(waiting.nextAttemptAt, isNotNull);

        harness.answerWithResponseFixture('valid/no-match');
        harness.startRun(OutboxRunReason.networkBack);
        expect(harness.items.single.nextAttemptAt, isNull, reason: 'cleared before the delay');
        harness.wait(Duration(seconds: harness.timingRules.sendingDelayMaximumSeconds));

        expect(harness.recognizeRequests, hasLength(2));
        expect(harness.items, isEmpty);
      });
    });

    test('back: a wait the server asked for stays', () {
      _runSenderTest((harness) {
        harness.queueClip(_keyOne, capturedAt: harness.clock.now());
        harness.answerWithEnvelopeFixture('recognition-busy', retryAfter: '187');
        harness.startRun(OutboxRunReason.wakeUp);
        final pausedUntil = harness.index.groupPausedUntil[OutboxItemGroup.clips];

        harness.startRun(OutboxRunReason.networkBack);
        harness.wait(const Duration(seconds: 120));
        expect(harness.recognizeRequests, hasLength(1));
        expect(harness.index.groupPausedUntil[OutboxItemGroup.clips], pausedUntil);
      });
    });
  });

  group('a clip that runs out (P6-OFFLINE-05, P6-D37)', () {
    test('23 hours 58 minutes after its capture it is deleted unsent, its recording too, and '
        'History is told why', () {
      _runSenderTest((harness) {
        harness.queueClip(
          _keyOne,
          capturedAt: harness.clock.now().subtract(OutboxTimingRules.clipKeptFor),
        );
        harness.startRun(OutboxRunReason.wakeUp);

        expect(harness.recognizeRequests, isEmpty);
        expect(harness.items, isEmpty);
        expect(File('${harness.folder.path}/clips/$_keyOne.m4a').existsSync(), isFalse);
        expect(harness.expiredClips.single.item.idempotencyKey, _keyOne);
        expect(harness.expiredClips.single.reason, OutboxClipExpiry.notSentWithin24Hours);
      });
    });

    test('a capture time more than 2 minutes ahead of the clock is deleted at once', () {
      _runSenderTest((harness) {
        harness.queueClip(_keyOne, capturedAt: harness.clock.now().add(const Duration(minutes: 3)));
        harness.startRun(OutboxRunReason.wakeUp);

        expect(harness.recognizeRequests, isEmpty);
        expect(harness.expiredClips.single.reason, OutboxClipExpiry.captureTimeAheadOfTheClock);
      });
    });
  });

  test('at start, a recording no item names is deleted (P6 design §3.8)', () {
    _runSenderTest((harness) {
      harness.queueClip(_keyOne, capturedAt: harness.clock.now());
      final orphan = File('${harness.folder.path}/clips/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f.m4a')
        ..writeAsBytesSync([1, 2, 3]);
      harness.isNetworkUp = false;
      harness.startRun(OutboxRunReason.appStarted);

      expect(orphan.existsSync(), isFalse);
      expect(File('${harness.folder.path}/clips/$_keyOne.m4a').existsSync(), isTrue);
    });
  });

  group('a crash report that got no answer (P6 design §3.20)', () {
    const reportId = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';

    test('is sent later with its own id and the time it happened, then deleted', () {
      _runSenderTest((harness) {
        final occurredAt = harness.clock.now().subtract(const Duration(minutes: 40));
        harness.queueCrashReport(reportId, occurredAt: occurredAt);
        harness.adapter.answerText(202, '');
        harness.startRun(OutboxRunReason.wakeUp);

        final request = harness.clientErrorRequests.single;
        expect(request.header('X-Request-Id'), reportId);
        expect(request.jsonBody, {
          'kind': 'reported',
          'message': 'Saving the result to History failed',
          'occurredAt': occurredAt.toUtc().toIso8601String(),
        });
        expect(harness.items, isEmpty);
      });
    });

    test('a 429 pauses only the crash reports: a clip still goes', () {
      _runSenderTest((harness) {
        harness.queueCrashReport(reportId, occurredAt: harness.clock.now());
        harness.queueClip(_keyOne, capturedAt: harness.clock.now());
        harness.answerWithEnvelopeFixture('rate-limited', retryAfter: '30');
        harness.answerWithResponseFixture('valid/no-match');
        harness.startRun(OutboxRunReason.wakeUp);
        harness.settle();

        expect(harness.index.groupPausedUntil.keys, [OutboxItemGroup.crashReports]);
        expect(harness.recognizeRequests, hasLength(1));
        expect(harness.items.single, isA<ClientErrorReportItem>());
      });
    });
  });

  group('in the background job (P6 design §3.10)', () {
    const keyThree = '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c23';

    /// Answers the next request with "no match" after [delay].
    void answerNoMatchAfter(OutboxSenderHarness harness, Duration delay) {
      final content =
          ContractFixtures.readFile('recognition/recognize-response/valid/no-match.json')!
              as Map<String, Object?>;
      harness.adapter.answerWith((request, cancelFuture) async {
        await Future<void>.delayed(delay);
        return ResponseBody.fromString(
          jsonEncode(content['response']),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });
    }

    OutboxRunEnded runInBackground(OutboxSenderHarness harness, {Duration? limit}) {
      OutboxRunResult? result;
      unawaited(
        harness.sender
            .run(OutboxRunReason.backgroundJob, sendingTimeLimit: limit)
            .then((ended) => result = ended),
      );
      harness.wait(const Duration(minutes: 5));
      return result! as OutboxRunEnded;
    }

    test('no send starts once the time limit has passed; the run says items are still due', () {
      runSenderTest(random: ScriptedRandom(integers: [0]), (harness) {
        for (final (minutes, key) in [(3, _keyOne), (2, _keyTwo), (1, keyThree)]) {
          harness.queueClip(
            key,
            capturedAt: harness.clock.now().subtract(Duration(minutes: minutes)),
          );
        }
        for (var answer = 0; answer < 3; answer++) {
          answerNoMatchAfter(harness, const Duration(seconds: 5));
        }
        final ended = runInBackground(harness, limit: const Duration(seconds: 10));

        expect(harness.recognizeRequests, hasLength(2), reason: 'at 0 s and 5 s; not at 10 s');
        expect(harness.items.single.idempotencyKey, keyThree);
        expect(ended.hasStoppedAtTimeLimit, isTrue);
        expect(ended.hasEndedForNoNetwork, isFalse);
      });
    });

    test('reaching the limit with nothing left due is a finished run', () {
      runSenderTest(random: ScriptedRandom(integers: [0]), (harness) {
        harness.queueClip(_keyOne, capturedAt: harness.clock.now());
        harness.queueClip(
          _keyTwo,
          capturedAt: harness.clock.now().subtract(const Duration(minutes: 1)),
        );
        answerNoMatchAfter(harness, const Duration(seconds: 5));
        answerNoMatchAfter(harness, const Duration(seconds: 5));
        final ended = runInBackground(harness, limit: const Duration(seconds: 10));

        expect(harness.items, isEmpty);
        expect(ended.hasStoppedAtTimeLimit, isFalse);
      });
    });

    test('with no network the run ends at once, says so, and draws no wait', () {
      runSenderTest(random: ScriptedRandom(integers: [120]), (harness) {
        harness.isNetworkUp = false;
        harness.queueClip(_keyOne, capturedAt: harness.clock.now());
        OutboxRunResult? result;
        unawaited(
          harness.sender
              .run(OutboxRunReason.backgroundJob, sendingTimeLimit: const Duration(minutes: 8))
              .then((ended) => result = ended),
        );
        harness.settle();

        final ended = result! as OutboxRunEnded;
        expect(ended.hasEndedForNoNetwork, isTrue);
        expect(ended.nextWakeUpAt, isNull);
        expect(harness.adapter.requests, isEmpty);
      });
    });

    test('a run of the foreground with no limit never stops for time', () {
      runSenderTest(random: ScriptedRandom(integers: [0]), (harness) {
        for (final (minutes, key) in [(3, _keyOne), (2, _keyTwo), (1, keyThree)]) {
          harness.queueClip(
            key,
            capturedAt: harness.clock.now().subtract(Duration(minutes: minutes)),
          );
        }
        for (var answer = 0; answer < 3; answer++) {
          answerNoMatchAfter(harness, const Duration(seconds: 5));
        }
        final ended = runInBackground(harness);
        expect(harness.recognizeRequests, hasLength(3));
        expect(ended.hasStoppedAtTimeLimit, isFalse);
      });
    });
  });

  group(
    'the acknowledgement rules for a saved clip (contract R9; P6-OFFLINE-10, -16 to -18, P6-OUTBOX-07)',
    () {
      test(
        'a clip that got no answer goes again with the same key, capture time and recording, still deferred, '
        'with the send time of the new attempt (P6-OUTBOX-07)',
        () {
          runSenderTest(random: ScriptedRandom(integers: [0], doubles: [0]), (harness) {
            final capturedAt = DateTime.utc(2026, 10, 8, 10);
            harness.queueClip(
              _keyOne,
              capturedAt: capturedAt,
              audioBytes: [0, 0, 0, 24, 102, 116, 121, 112, 7],
            );
            harness.adapter.failWithDioType(DioExceptionType.connectionError);
            harness.answerWithResponseFixture('valid/no-match');
            harness.startRun(OutboxRunReason.wakeUp);
            harness.followWakeUps();

            final sends = [
              for (final request in harness.recognizeRequests) ReceivedMultipartForm.of(request),
            ];
            expect(sends, hasLength(2));
            for (final send in sends) {
              expect(send.fieldValues['idempotency_key'], _keyOne);
              expect(send.fieldValues['captured_at'], '2026-10-08T10:00:00.000Z');
              expect(send.fieldValues['is_deferred'], 'true');
              expect(send.fileParts.single.bytes, [0, 0, 0, 24, 102, 116, 121, 112, 7]);
            }
            expect(sends.first.fieldValues['sent_at'], '2026-10-08T12:00:00.000Z');
            expect(
              sends.last.fieldValues['sent_at'],
              '2026-10-08T12:00:15.000Z',
              reason: 'after the 15 s backoff',
            );
            expect(
              harness.recognizeRequests.first.header('X-Request-Id'),
              isNot(harness.recognizeRequests.last.header('X-Request-Id')),
              reason: 'a new request id per attempt',
            );
          });
        },
      );

      test('one clip is in flight at a time, oldest first (P6-OFFLINE-10, -11)', () {
        runSenderTest(random: ScriptedRandom(integers: [0]), (harness) {
          for (final (minutes, key) in [
            (10, _keyOne),
            (5, _keyTwo),
            (0, '6a0d1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c23'),
          ]) {
            harness.queueClip(
              key,
              capturedAt: DateTime.utc(2026, 10, 8, 10).add(Duration(minutes: minutes)),
            );
          }
          final content =
              ContractFixtures.readFile('recognition/recognize-response/valid/no-match.json')!
                  as Map<String, Object?>;
          var inFlight = 0;
          var mostInFlight = 0;
          for (var answer = 0; answer < 3; answer++) {
            harness.adapter.answerWith((request, cancelFuture) async {
              inFlight++;
              mostInFlight = inFlight > mostInFlight ? inFlight : mostInFlight;
              await Future<void>.delayed(const Duration(seconds: 3));
              inFlight--;
              return ResponseBody.fromString(
                jsonEncode(content['response']),
                200,
                headers: {
                  Headers.contentTypeHeader: [Headers.jsonContentType],
                },
              );
            });
          }
          harness.startRun(OutboxRunReason.wakeUp);
          harness.wait(const Duration(seconds: 30));

          expect(mostInFlight, 1);
          expect(
            harness.recognizeRequests.map(
              (request) => ReceivedMultipartForm.of(request).fieldValues['captured_at'],
            ),
            ['2026-10-08T10:00:00.000Z', '2026-10-08T10:05:00.000Z', '2026-10-08T10:10:00.000Z'],
          );
        });
      });

      test('409: the clip is kept and sent again later with the same key (P6-OFFLINE-16)', () {
        runSenderTest(random: ScriptedRandom(integers: [0]), (harness) {
          harness.queueClip(_keyOne, capturedAt: harness.clock.now());
          harness.answerWithEnvelopeFixture('recognition-in-progress', retryAfter: '3');
          harness.answerWithResponseFixture('valid/no-match');
          harness.startRun(OutboxRunReason.wakeUp);
          expect(harness.items.single.idempotencyKey, _keyOne);
          expect(File('${harness.folder.path}/clips/$_keyOne.m4a').existsSync(), isTrue);
          harness.followWakeUps();

          expect(
            harness.recognizeRequests.map(
              (request) => ReceivedMultipartForm.of(request).fieldValues['idempotency_key'],
            ),
            [_keyOne, _keyOne],
          );
          expect(harness.items, isEmpty);
        });
      });

      test(
        '429: the clip is kept, the clips wait as asked, and it goes again after (P6-OFFLINE-17)',
        () {
          runSenderTest(random: ScriptedRandom(integers: [0]), (harness) {
            harness.queueClip(_keyOne, capturedAt: harness.clock.now());
            harness.answerWithEnvelopeFixture('rate-limited', retryAfter: '90');
            harness.answerWithResponseFixture('valid/no-match');
            harness.startRun(OutboxRunReason.wakeUp);
            expect(harness.items, hasLength(1));
            expect(File('${harness.folder.path}/clips/$_keyOne.m4a').existsSync(), isTrue);
            expect(
              harness.index.groupPausedUntil[OutboxItemGroup.clips],
              harness.clock.now().add(const Duration(seconds: 90)),
            );
            harness.followWakeUps();
            expect(harness.recognizeRequests, hasLength(2));
            expect(harness.items, isEmpty);
          });
        },
      );

      test('503 with Retry-After 120: the clip is kept, and nothing is sent before 120 seconds '
          '(P6-OFFLINE-18)', () {
        runSenderTest(random: ScriptedRandom(integers: [0]), (harness) {
          harness.queueClip(_keyOne, capturedAt: harness.clock.now());
          harness.answerWithEnvelopeFixture('recognition-busy', retryAfter: '120');
          harness.answerWithResponseFixture('valid/no-match');
          harness.startRun(OutboxRunReason.wakeUp);
          final pausedAt = harness.clock.now();
          expect(File('${harness.folder.path}/clips/$_keyOne.m4a').existsSync(), isTrue);

          // Every way a run starts, short of the wait's end, sends nothing.
          harness.wait(const Duration(seconds: 60));
          harness.startRun(OutboxRunReason.wakeUp);
          harness.startRun(OutboxRunReason.networkBack);
          harness.wait(const Duration(seconds: 59));
          expect(harness.recognizeRequests, hasLength(1));

          harness.followWakeUps();
          expect(harness.recognizeRequests, hasLength(2));
          expect(
            harness.clock.now().difference(pausedAt),
            greaterThanOrEqualTo(const Duration(seconds: 120)),
          );
        });
      });
    },
  );
}
