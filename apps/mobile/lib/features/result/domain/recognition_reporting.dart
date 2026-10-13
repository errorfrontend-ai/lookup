/// Why the listener reports an ad (P6 design §2.14): the contract's four reasons, and nothing typed.
enum RecognitionReportReason {
  wrongOrMisleadingButtons('WRONG_OR_MISLEADING_BUTTONS'),
  numberOrLinkDoesNotWork('NUMBER_OR_LINK_DOES_NOT_WORK'),
  looksLikeAScam('LOOKS_LIKE_A_SCAM'),
  somethingElse('SOMETHING_ELSE');

  const RecognitionReportReason(this.wireName);

  /// The contract's name (`RECOGNITION_REPORT_REASONS`).
  final String wireName;
}

/// Where "Send report" goes: the outbox, which sends it when it can, with no signal too; History
/// then remembers the result as reported, so its footer says "Reported". Resolves to whether the
/// report was kept; never throws (a failure is reported by the implementation).
abstract interface class RecognitionReporting {
  Future<bool> report({
    required String recognitionId,
    required String stationId,
    required RecognitionReportReason reason,
  });
}
