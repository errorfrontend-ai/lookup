import 'dart:convert';
import 'dart:io';

import 'package:lookup_listener/features/history/data/history_store.dart';

import 'contract_fixtures.dart';

/// History's test data, made from the shared recognize-response fixtures (S4-TESTS-03): the answers
/// exactly as the API sends them, with a recognition id of the test's choosing, and History's
/// `index.json` written as `HistoryStore` writes it.
abstract final class HistoryFixtures {
  /// The recognition id the answer fixtures carry.
  static const String fixtureRecognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';

  /// A lower-case UUID version 7 numbered [number] (0 to 255), e.g. `…-2b3c4d5e6f0c` for 12.
  static String recognitionIdNumbered(int number) =>
      '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f${number.toRadixString(16).padLeft(2, '0')}';

  /// The `response` of a recognize-response fixture, e.g. `valid/match-campaign`, with its
  /// recognition id replaced by [recognitionId] when given.
  static Map<String, Object?> answer(String name, {String? recognitionId}) {
    final content =
        ContractFixtures.readFile('recognition/recognize-response/$name.json')!
            as Map<String, Object?>;
    final response = Map<String, Object?>.of(content['response']! as Map<String, Object?>);
    if (recognitionId != null) response['recognition_id'] = recognitionId;
    return response;
  }

  /// A result as History keeps it: the [fixture] answer for [recognitionId], recorded at
  /// [capturedAtOnPhone], with the station chosen in "Which station?" when [chosenStationId].
  static StoredHistoryEntry storedResult({
    required String recognitionId,
    required DateTime capturedAtOnPhone,
    String fixture = 'valid/match-campaign',
    String? chosenStationId,
  }) => StoredHistoryEntry(
    entryId: recognitionId,
    kind: StoredHistoryEntry.resultKind,
    capturedAtOnPhone: capturedAtOnPhone.toUtc(),
    savedAt: capturedAtOnPhone.toUtc().add(const Duration(seconds: 9)),
    answer: answer(fixture, recognitionId: recognitionId),
    chosenStationId: chosenStationId,
  );

  /// A scan whose ad result waits for the listener's account (ADR-005), as History keeps it: the withheld answer, and
  /// no card.
  static StoredHistoryEntry storedAwaitingAccount({
    required String recognitionId,
    required DateTime capturedAtOnPhone,
    String? deferredIdempotencyKey,
    bool wasNotified = false,
  }) => StoredHistoryEntry(
    entryId: recognitionId,
    kind: StoredHistoryEntry.awaitingAccountKind,
    capturedAtOnPhone: capturedAtOnPhone.toUtc(),
    savedAt: capturedAtOnPhone.toUtc().add(const Duration(seconds: 9)),
    answer: answer('valid/account-required', recognitionId: recognitionId),
    wasDeferred: deferredIdempotencyKey != null,
    deferredIdempotencyKey: deferredIdempotencyKey,
    wasNotified: wasNotified,
  );

  /// Writes History's `index.json` in [historyFolder] holding [entries], as `HistoryStore` writes it.
  static void writeIndex(Directory historyFolder, List<StoredHistoryEntry> entries) {
    historyFolder.createSync(recursive: true);
    File('${historyFolder.path}/index.json').writeAsStringSync(
      jsonEncode({
        'format_version': HistoryStore.formatVersion,
        'entries': [for (final entry in entries) entry.toJson()],
      }),
    );
  }

  /// The entries History's `index.json` in [historyFolder] holds, as JSON; empty when there is none.
  static List<Map<String, Object?>> readIndexEntries(Directory historyFolder) {
    final file = File('${historyFolder.path}/index.json');
    if (!file.existsSync()) return const [];
    final index = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
    return (index['entries']! as List<Object?>).cast<Map<String, Object?>>();
  }
}
