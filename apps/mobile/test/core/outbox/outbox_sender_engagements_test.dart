import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/outbox/outbox_sender.dart';

import 'outbox_sender_harness.dart';

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

const String _callId = '0192a6c4-0000-4000-8000-000000000001';

/// A queued button tap through the outbox sender (T54; P6-OUTBOX-06; contract §1.5, R12).
void main() {
  late DateTime tappedAt;

  void queueTap(OutboxSenderHarness harness) {
    tappedAt = harness.clock.now().subtract(const Duration(seconds: 30));
    unawaited(
      harness.store.queueEngagement(
        recognitionId: recognitionOne,
        stationId: stationB,
        actionId: _callId,
        occurredAt: tappedAt,
      ),
    );
    harness.settle();
  }

  String contractTime(DateTime time) {
    final text = time.toUtc().toIso8601String();
    return '${text.substring(0, 23)}Z';
  }

  test('goes to /engagements with exactly the recognition, station, button, tap time and send '
      'time, and the install token; 204 settles it', () {
    _runSenderTest((harness) {
      queueTap(harness);
      late DateTime answeredAt;
      harness.answerChoice(204, whileAnswering: () => answeredAt = harness.clock.now());
      harness.startRun(OutboxRunReason.wakeUp);

      final request = harness.adapter.requests.single;
      expect(request.address.path, '/api/v1/engagements');
      expect(request.jsonBody, {
        'recognition_id': recognitionOne,
        'station_id': stationB,
        'action_id': _callId,
        'occurred_at': contractTime(tappedAt),
        'sent_at': contractTime(answeredAt),
      });
      expect(request.header('Authorization'), 'Bearer stored.install.token');
      expect(harness.items, isEmpty);
    });
  });

  test('no answer keeps it; it goes again later with the same tap time and a new send time', () {
    _runSenderTest((harness) {
      queueTap(harness);
      harness.answerChoiceWithNothing();
      harness.answerChoice(204);
      harness.startRun(OutboxRunReason.wakeUp);
      expect(harness.items, hasLength(1));
      harness.followWakeUps();
      final bodies = [for (final request in harness.adapter.requests) request.jsonBody as Map];
      expect(bodies, hasLength(2));
      expect(bodies.map((body) => body['occurred_at']).toSet(), {contractTime(tappedAt)});
      expect(bodies.first['sent_at'], isNot(bodies.last['sent_at']));
      expect(harness.items, isEmpty);
    });
  });

  for (final code in ['ACTION_NOT_ON_CARD', 'STATION_NOT_A_CANDIDATE', 'STATION_ALREADY_CHOSEN']) {
    test('422 $code deletes it and reports why (the acknowledgement table)', () {
      _runSenderTest((harness) {
        queueTap(harness);
        harness.answerChoice(422, code: code);
        harness.startRun(OutboxRunReason.wakeUp);
        expect(harness.items, isEmpty);
        expect(harness.reporter.reports, hasLength(1));
      });
    });
  }
}
