/// Where a button tap goes besides opening its address (P6 design §3.8, T54): the outbox, which
/// sends it when it can, with no signal too. One per recognition and button. Never throws, and never
/// holds up opening the address: a failure is reported by the implementation.
abstract interface class EngagementRecording {
  Future<void> record({
    required String recognitionId,
    required String stationId,
    required String actionId,
  });
}
