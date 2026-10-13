import 'dart:async';

import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';

/// One call to [RecordingClientErrorReporter.report], as made.
final class RecordedClientErrorReport {
  const RecordedClientErrorReport({
    required this.kind,
    required this.error,
    this.stackTrace,
    this.description,
    this.location,
    this.relatedRequestId,
    this.reportRequestId,
  });

  final ClientErrorKind kind;
  final Object error;
  final StackTrace? stackTrace;
  final String? description;
  final String? location;
  final String? relatedRequestId;
  final String? reportRequestId;
}

/// A crash reporter that sends nothing and remembers every report (design §4.1), so tests of the
/// handlers and the flow can check what would have been reported.
class RecordingClientErrorReporter implements ClientErrorReporter {
  /// Every report, in order.
  final List<RecordedClientErrorReport> reports = [];

  /// What every report resolves to.
  ClientErrorReportOutcome outcome = const ClientErrorReportNotAccepted();

  final List<Completer<RecordedClientErrorReport>> _waiting = [];

  /// The next report made after this call, for reports that arrive asynchronously.
  Future<RecordedClientErrorReport> nextReport() {
    final waiting = Completer<RecordedClientErrorReport>();
    _waiting.add(waiting);
    return waiting.future;
  }

  /// The outbox's queue, when the code under test attaches one; a recorded report never uses it.
  UnsentClientErrorReportQueue? attachedQueue;

  @override
  void attachUnsentReportQueue(UnsentClientErrorReportQueue queue) => attachedQueue = queue;

  @override
  Future<ClientErrorReportOutcome> report({
    required ClientErrorKind kind,
    required Object error,
    StackTrace? stackTrace,
    String? description,
    String? location,
    String? relatedRequestId,
    String? reportRequestId,
  }) async {
    final recorded = RecordedClientErrorReport(
      kind: kind,
      error: error,
      stackTrace: stackTrace,
      description: description,
      location: location,
      relatedRequestId: relatedRequestId,
      reportRequestId: reportRequestId,
    );
    reports.add(recorded);
    for (final waiting in _waiting) {
      waiting.complete(recorded);
    }
    _waiting.clear();
    return outcome;
  }
}
