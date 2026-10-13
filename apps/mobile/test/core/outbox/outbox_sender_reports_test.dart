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

/// A queued "Report this" through the outbox sender (P6 design §2.14; contract §1.6, R9).
void main() {
  void queueReport(OutboxSenderHarness harness, {String reason = 'LOOKS_LIKE_A_SCAM'}) {
    unawaited(
      harness.store.queueRecognitionReport(
        recognitionId: recognitionOne,
        stationId: stationB,
        reason: reason,
      ),
    );
    harness.settle();
  }

  test('goes to the recognition\'s report route with exactly its station and reason, and the '
      'install token; 204 settles it', () {
    _runSenderTest((harness) {
      queueReport(harness);
      harness.adapter.answerText(204, '');
      harness.startRun(OutboxRunReason.wakeUp);

      final request = harness.adapter.requests.single;
      expect(request.address.path, '/api/v1/recognitions/$recognitionOne/report');
      expect(request.jsonBody, {'station_id': stationB, 'reason': 'LOOKS_LIKE_A_SCAM'});
      expect(request.header('Authorization'), 'Bearer stored.install.token');
      expect(harness.items, isEmpty);
    });
  });

  test('no answer keeps it, and it goes again later', () {
    _runSenderTest((harness) {
      queueReport(harness);
      harness.answerChoiceWithNothing();
      harness.adapter.answerText(204, '');
      harness.startRun(OutboxRunReason.wakeUp);
      expect(harness.items, hasLength(1));
      harness.followWakeUps();
      expect(harness.adapter.requests, hasLength(2));
      expect(harness.items, isEmpty);
    });
  });

  test('422 STATION_ALREADY_CHOSEN deletes it and reports why, as for a tap (amendment A4)', () {
    _runSenderTest((harness) {
      queueReport(harness);
      harness.answerChoice(422, code: 'STATION_ALREADY_CHOSEN');
      harness.startRun(OutboxRunReason.wakeUp);
      expect(harness.items, isEmpty);
      expect(harness.reporter.reports, hasLength(1));
    });
  });
}
