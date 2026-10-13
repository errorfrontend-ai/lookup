import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/outbox_engagement_recording.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';

import '../support/fake_clock.dart';
import '../support/recording_client_error_reporter.dart';

const LockFileOwner _engine = LockFileOwner(
  processId: 4242,
  engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
);
const String _recognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';
const String _stationA = '0192a6c4-1111-4000-8000-000000000001';
const String _callId = '0192a6c4-0000-4000-8000-000000000001';

/// A button tap as the app keeps it (T54; P6-OUTBOX-06): into the outbox with the phone's time.
void main() {
  late Directory folder;
  late RecordingClientErrorReporter reporter;
  late FakeClock clock;

  setUp(() {
    folder = Directory.systemTemp.createTempSync('outbox_engagement_recording_test_');
    addTearDown(() => folder.deleteSync(recursive: true));
    reporter = RecordingClientErrorReporter();
    clock = FakeClock();
  });

  OutboxStore storeAt(Directory outboxFolder) => OutboxStore(
    locateFolder: () async => outboxFolder,
    lockOwner: _engine,
    lockTakeOver: LocalLockTakeOver.everyEngineAttached(),
    clock: clock,
    randomUuid: RandomUuid(),
    clientErrorReporter: reporter,
  );

  test('queues the tap with its recognition, station, button and the time of the tap', () async {
    final store = storeAt(Directory('${folder.path}/outbox'));
    await OutboxEngagementRecording(
      outboxStore: store,
      clientErrorReporter: reporter,
      clock: clock,
    ).record(recognitionId: _recognitionId, stationId: _stationA, actionId: _callId);

    final item = (await store.read()).items.single as EngagementItem;
    expect(
      (item.recognitionId, item.stationId, item.actionId, item.occurredAt),
      (_recognitionId, _stationA, _callId, clock.now().toUtc()),
    );
    expect(reporter.reports, isEmpty);
  });

  test('a tap the phone cannot keep never throws, and is reported', () async {
    final inTheWay = File('${folder.path}/in-the-way')..writeAsStringSync('');
    await OutboxEngagementRecording(
      outboxStore: storeAt(Directory('${inTheWay.path}/outbox')),
      clientErrorReporter: reporter,
      clock: clock,
    ).record(recognitionId: _recognitionId, stationId: _stationA, actionId: _callId);
    expect(reporter.reports.single.description, 'Queueing a tap failed');
  });
}
