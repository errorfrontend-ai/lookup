import 'dart:async';

import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/result/domain/engagement_recording.dart';

/// A button tap as the app keeps it (P6 design §3.8, T54; P6-OUTBOX-06): queued in the outbox with the
/// phone's time of the tap, so a tap made with no signal is counted later. Lives in `lib/app`, where
/// the result feature meets the outbox.
final class OutboxEngagementRecording implements EngagementRecording {
  OutboxEngagementRecording({
    required OutboxStore outboxStore,
    required ClientErrorReporter clientErrorReporter,
    Clock? clock,
  }) : _outboxStore = outboxStore,
       _clientErrorReporter = clientErrorReporter,
       _clock = clock ?? Clock();

  final OutboxStore _outboxStore;
  final ClientErrorReporter _clientErrorReporter;
  final Clock _clock;

  @override
  Future<void> record({
    required String recognitionId,
    required String stationId,
    required String actionId,
  }) async {
    try {
      await _outboxStore.queueEngagement(
        recognitionId: recognitionId,
        stationId: stationId,
        actionId: actionId,
        occurredAt: _clock.now(),
      );
    } on Object catch (error, stackTrace) {
      // The button still opened its address; only the count is lost, which the listener never sees.
      unawaited(
        _clientErrorReporter
            .report(
              kind: ClientErrorKind.reported,
              error: error,
              stackTrace: stackTrace,
              description: 'Queueing a tap failed',
            )
            .then<void>((_) {}, onError: (Object error) {}),
      );
    }
  }
}
