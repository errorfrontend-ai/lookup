import 'dart:async';

import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/features/history/data/history_repository.dart';
import 'package:lookup_listener/features/result/domain/recognition_reporting.dart';

/// "Send report" (P6 design §2.14): the report goes to the outbox, which sends it when it can, with
/// no signal too; then History remembers the result as reported. A report the phone cannot keep is
/// reported to the developers and answers false; History failing to remember it changes nothing
/// about the report.
final class OutboxRecognitionReporting implements RecognitionReporting {
  const OutboxRecognitionReporting({
    required OutboxStore outboxStore,
    required HistoryRepository history,
    required ClientErrorReporter clientErrorReporter,
  }) : _outboxStore = outboxStore,
       _history = history,
       _clientErrorReporter = clientErrorReporter;

  final OutboxStore _outboxStore;
  final HistoryRepository _history;
  final ClientErrorReporter _clientErrorReporter;

  @override
  Future<bool> report({
    required String recognitionId,
    required String stationId,
    required RecognitionReportReason reason,
  }) async {
    try {
      await _outboxStore.queueRecognitionReport(
        recognitionId: recognitionId,
        stationId: stationId,
        reason: reason.wireName,
      );
    } on Object catch (error, stackTrace) {
      unawaited(
        _clientErrorReporter
            .report(
              kind: ClientErrorKind.reported,
              error: error,
              stackTrace: stackTrace,
              description: 'Queueing the report failed',
            )
            .then<void>((_) {}, onError: (Object error) {}),
      );
      return false;
    }
    try {
      await _history.markReported(recognitionId);
    } on Object {
      // The report is queued; only the footer of a result opened later would not say "Reported".
    }
    return true;
  }
}
