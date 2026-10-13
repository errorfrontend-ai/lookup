import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/history_answer_reader.dart';
import 'package:lookup_listener/app/outbox_recognition_reporting.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/features/history/data/history_repository.dart';
import 'package:lookup_listener/features/history/data/history_store.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/result/domain/recognition_reporting.dart';

import '../support/fake_clock.dart';
import '../support/history_fixtures.dart';
import '../support/recording_client_error_reporter.dart';

const LockFileOwner _engine = LockFileOwner(
  processId: 4242,
  engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
);
const String _stationA = '0192a6c4-1111-4000-8000-000000000001';

/// "Send report" as the app does it (P6 design §2.14): into the outbox, then History marks the result.
void main() {
  late Directory folder;
  late RecordingClientErrorReporter reporter;
  late HistoryRepository history;

  setUp(() {
    folder = Directory.systemTemp.createTempSync('outbox_recognition_reporting_test_');
    addTearDown(() => folder.deleteSync(recursive: true));
    reporter = RecordingClientErrorReporter();
    history = HistoryRepository(
      store: HistoryStore(
        locateFolder: () async => Directory('${folder.path}/history'),
        lockOwner: _engine,
        lockTakeOver: LocalLockTakeOver.everyEngineAttached(),
        clock: FakeClock(),
        clientErrorReporter: reporter,
      ),
      answerReader: const HistoryAnswerReader(),
      clientErrorReporter: reporter,
      clock: FakeClock(),
    );
  });

  OutboxStore storeAt(Directory outboxFolder) => OutboxStore(
    locateFolder: () async => outboxFolder,
    lockOwner: _engine,
    lockTakeOver: LocalLockTakeOver.everyEngineAttached(),
    clock: FakeClock(),
    randomUuid: RandomUuid(),
    clientErrorReporter: reporter,
  );

  test(
    'queues the report with its station and reason, and History marks the result reported',
    () async {
      final store = storeAt(Directory('${folder.path}/outbox'));
      await history.saveResult(
        recognitionId: HistoryFixtures.fixtureRecognitionId,
        answer: HistoryFixtures.answer('valid/match-campaign'),
        capturedAtOnPhone: DateTime.utc(2026, 10, 13, 12),
      );
      final isKept =
          await OutboxRecognitionReporting(
            outboxStore: store,
            history: history,
            clientErrorReporter: reporter,
          ).report(
            recognitionId: HistoryFixtures.fixtureRecognitionId,
            stationId: _stationA,
            reason: RecognitionReportReason.wrongOrMisleadingButtons,
          );

      expect(isKept, isTrue);
      final item = (await store.read()).items.single as RecognitionReportItem;
      expect(item.reason, 'WRONG_OR_MISLEADING_BUTTONS');
      expect(item.stationId, _stationA);
      expect(((await history.readView()).entries.single as HistoryResultEntry).isReported, isTrue);
      expect(reporter.reports, isEmpty);
    },
  );

  test(
    'a report the phone cannot keep answers false, with a crash report, and nothing is marked',
    () async {
      final inTheWay = File('${folder.path}/in-the-way')..writeAsStringSync('');
      final isKept =
          await OutboxRecognitionReporting(
            outboxStore: storeAt(Directory('${inTheWay.path}/outbox')),
            history: history,
            clientErrorReporter: reporter,
          ).report(
            recognitionId: HistoryFixtures.fixtureRecognitionId,
            stationId: _stationA,
            reason: RecognitionReportReason.looksLikeAScam,
          );
      expect(isKept, isFalse);
      expect(reporter.reports.single.description, 'Queueing the report failed');
    },
  );
}
