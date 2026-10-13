import 'dart:convert';
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/outbox/outbox_index_file.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/outbox/outbox_timing_rules.dart';

import '../../support/fake_clock.dart';
import '../../support/recording_client_error_reporter.dart';

const LockFileOwner _engineA = LockFileOwner(
  processId: 4242,
  engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
);
const LockFileOwner _engineB = LockFileOwner(
  processId: 4242,
  engineId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
);

const String _recognitionOne = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';
const String _recognitionTwo = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f71';
const String _stationA = '0192a6c4-1111-4000-8000-000000000001';
const String _stationB = '0192a6c4-1111-4000-8000-000000000002';

/// The outbox on disk (P6 design §3.8; P6-OUTBOX-01, -02, -03 for station choices; P6-D36, -D44).
void main() {
  late Directory folder;
  late FakeClock clock;
  late RecordingClientErrorReporter reporter;

  OutboxStore storeFor(LockFileOwner owner, {Directory? outboxFolder}) => OutboxStore(
    locateFolder: () async => outboxFolder ?? folder,
    lockOwner: owner,
    isEngineAttached: {_engineA.engineId, _engineB.engineId}.contains,
    clock: clock,
    randomUuid: RandomUuid(),
    clientErrorReporter: reporter,
  );

  setUp(() {
    folder = Directory.systemTemp.createTempSync('outbox_store_test_');
    clock = FakeClock();
    reporter = RecordingClientErrorReporter();
  });
  tearDown(() {
    if (folder.existsSync()) folder.deleteSync(recursive: true);
  });

  test('a choice is queued and read back with its recognition, station and queued time '
      '(P6-OUTBOX-02, the STATION_CHOICE kind)', () async {
    final store = storeFor(_engineA);
    expect(
      await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB),
      isTrue,
    );

    final item = (await store.read()).items.single as StationChoiceItem;
    expect(item.kind, OutboxItemKind.stationChoice);
    expect(item.kind.group, OutboxItemGroup.followUps);
    expect(item.recognitionId, _recognitionOne);
    expect(item.stationId, _stationB);
    expect(item.queuedAt, DateTime.utc(2026, 10, 8, 12));
    expect(item.attemptCount, 0);
    expect(item.nextAttemptAt, isNull);
    expect(item.lastProblem, isNull);
    expect(
      item.itemId,
      matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')),
    );
  });

  test('items survive closing the app and opening it again: a new store reads them from disk '
      '(P6-OUTBOX-01)', () async {
    await storeFor(
      _engineA,
    ).queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB);
    final waiting = (await storeFor(_engineA).read()).items.single as StationChoiceItem;
    await storeFor(_engineA).modify(
      (index) => index.withItemReplaced(
        waiting.retried(
          nextAttemptAt: DateTime.utc(2026, 10, 8, 12, 0, 30),
          lastProblem: OutboxItemProblem.noAnswer,
        ),
      ),
    );

    // A new store is what the next launch makes: nothing is kept in memory between them.
    final reopened = (await storeFor(_engineA).read()).items.single as StationChoiceItem;
    expect(reopened.itemId, waiting.itemId);
    expect(reopened.recognitionId, _recognitionOne);
    expect(reopened.stationId, _stationB);
    expect(reopened.attemptCount, 1);
    expect(reopened.nextAttemptAt, DateTime.utc(2026, 10, 8, 12, 0, 30));
    expect(reopened.lastProblem, OutboxItemProblem.noAnswer);
  });

  test(
    'the first choice of a recognition wins: a second is not queued, and the first stays',
    () async {
      final store = storeFor(_engineA);
      await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB);
      expect(
        await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationA),
        isFalse,
      );
      expect(
        await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB),
        isFalse,
      );

      final items = (await store.read()).items;
      expect(items, hasLength(1));
      expect((items.single as StationChoiceItem).stationId, _stationB);
    },
  );

  test('two choices are two items with two keys; one item keeps its key on every retry '
      '(P6-OUTBOX-03)', () async {
    final store = storeFor(_engineA);
    await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB);
    await store.queueStationChoice(recognitionId: _recognitionTwo, stationId: _stationA);
    final items = (await store.read()).items;
    expect(items.map((item) => item.idempotencyKey), [_recognitionOne, _recognitionTwo]);

    var item = items.first;
    for (var failure = 1; failure <= 3; failure++) {
      item = item.retried(nextAttemptAt: null, lastProblem: OutboxItemProblem.noAnswer);
      expect(item.idempotencyKey, _recognitionOne);
      expect(item.itemId, items.first.itemId);
      expect(item.attemptCount, failure);
    }
  });

  test('each queued item is announced once it is on disk; a repeated choice is not', () async {
    final store = storeFor(_engineA);
    var announced = 0;
    store.itemsQueued.listen((_) => announced++);
    await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB);
    expect(announced, 1);
    await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB);
    expect(announced, 1);
    await store.queueStationChoice(recognitionId: _recognitionTwo, stationId: _stationB);
    expect(announced, 2);
  });

  test('a folder that could not be made (the storage full at start-up) is tried again at the next '
      'call, not only after a restart', () async {
    final outboxFolder = Directory('${folder.path}/outbox');
    // A file where the folder should be: making the folder fails, as it does with no room left.
    final inTheWay = File(outboxFolder.path)..writeAsStringSync('');
    final store = storeFor(_engineA, outboxFolder: outboxFolder);
    await expectLater(
      store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB),
      throwsA(isA<FileSystemException>()),
    );

    inTheWay.deleteSync();
    expect(
      await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB),
      isTrue,
    );
    expect((await store.read()).items, hasLength(1));
  });

  test('the outbox is the outbox folder of the app\'s support folder, never the cache '
      '(P6 design §3.8)', () {
    final support = Directory('/data/user/0/zm.lookup.listener/files');
    expect(OutboxStore.folderIn(support).path, '/data/user/0/zm.lookup.listener/files/outbox');
  });

  test('a write is atomic: a crash between writing and renaming leaves the old index', () async {
    final store = storeFor(_engineA);
    await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB);
    // What a power cut leaves: the next index half written beside the old one.
    File('${folder.path}/index.json.writing').writeAsStringSync('{"format_version": 1, "ite');

    expect((await storeFor(_engineA).read()).items, hasLength(1));
    await storeFor(
      _engineA,
    ).queueStationChoice(recognitionId: _recognitionTwo, stationId: _stationA);
    expect((await storeFor(_engineA).read()).items, hasLength(2));
    expect(File('${folder.path}/index.json.writing').existsSync(), isFalse);
    expect(File('${folder.path}/index.lock').existsSync(), isFalse, reason: 'the lock is let go');
  });

  test('an index that cannot be read is set aside and reported, and the outbox starts again '
      'empty', () async {
    File('${folder.path}/index.json').writeAsStringSync('not an index');
    Directory('${folder.path}/clips').createSync();
    File('${folder.path}/clips/0f1e2d3c-4b5a-4968-8776-655443322110.m4a').writeAsBytesSync([1, 2]);
    final store = storeFor(_engineA);
    expect((await store.read()).items, isEmpty);

    await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB);
    expect((await store.read()).items, hasLength(1));
    expect(
      folder.listSync().map(
        (entity) => entity.uri.pathSegments.where((segment) => segment.isNotEmpty).last,
      ),
      containsAll(['index.json', startsWith('index.json.unreadable-')]),
    );
    expect(Directory('${folder.path}/clips').existsSync(), isFalse, reason: 'no recording lingers');
    expect(reporter.reports.single.error, contains('could not be read'));
  });

  test('an item this version cannot read is left out and reported; the others are kept', () async {
    final store = storeFor(_engineA);
    await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB);
    final index =
        jsonDecode(File('${folder.path}/index.json').readAsStringSync()) as Map<String, Object?>;
    (index['items']! as List<Object?>).add({
      'item_id': '0f1e2d3c-4b5a-4968-8776-655443322110',
      'kind': 'A_KIND_FROM_THE_FUTURE',
      'queued_at': '2026-10-08T12:00:00.000Z',
      'attempt_count': 0,
    });
    File('${folder.path}/index.json').writeAsStringSync(jsonEncode(index));

    expect((await store.read()).items, hasLength(1));
    await store.queueStationChoice(recognitionId: _recognitionTwo, stationId: _stationA);
    expect((await store.read()).items, hasLength(2));
    expect(reporter.reports.single.error, contains('cannot read'));
  });

  test('a follow-up item is deleted unsent 7 days after it was queued (P6 design §3.8)', () async {
    final store = storeFor(_engineA);
    await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB);
    final index = await store.read();
    final sevenDays = const Duration(seconds: OutboxTimingRules.followUpItemLifetimeSeconds);
    final queuedAt = DateTime.utc(2026, 10, 8, 12);
    expect(
      index
          .withoutExpired(
            now: queuedAt.add(sevenDays - const Duration(seconds: 1)),
            appVersion: '0.1.0+1',
          )
          .items,
      hasLength(1),
    );
    expect(
      index.withoutExpired(now: queuedAt.add(sevenDays), appVersion: '0.1.0+1').items,
      isEmpty,
    );
  });

  test(
    'with 200 follow-ups waiting, a new choice deletes the oldest choice first (P6-D44)',
    () async {
      final store = storeFor(_engineA);
      final first = StationChoiceItem(
        itemId: '00000000-0000-4000-8000-000000000000',
        queuedAt: DateTime.utc(2026, 10, 1),
        recognitionId: '0199b2c4-5a6e-7c3d-8f10-000000000000',
        stationId: _stationA,
      );
      await store.modify(
        (index) => OutboxIndex(
          items: [
            for (var number = 1; number < OutboxTimingRules.maximumFollowUpItems; number++)
              StationChoiceItem(
                itemId: '00000000-0000-4000-8000-${number.toString().padLeft(12, '0')}',
                queuedAt: DateTime.utc(2026, 10, 2).add(Duration(minutes: number)),
                recognitionId: '0199b2c4-5a6e-7c3d-8f10-${number.toString().padLeft(12, '0')}',
                stationId: _stationA,
              ),
            first,
          ],
        ),
      );
      expect((await store.read()).items, hasLength(200));

      await store.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB);
      final items = (await store.read()).items;
      expect(items, hasLength(200));
      expect(items.map((item) => item.itemId), isNot(contains(first.itemId)));
      expect((items.last as StationChoiceItem).recognitionId, _recognitionOne);
    },
  );

  test('two engines: one stalled for 40 s holding index.lock loses no item, and the other never '
      'takes the lock over; its own write fails after 10 s and succeeds once the lock is free '
      '(P6-D36)', () {
    fakeAsync((fakeAsync) {
      final storeOfA = storeFor(_engineA);
      // Engine B starts a read-modify-write and stalls with the lock held (garbage collection, a
      // slow flash, a long 2G send).
      final lockOfB = OwnedLockFile(
        file: File('${folder.path}/index.lock'),
        owner: _engineB,
        isEngineAttached: {_engineA.engineId, _engineB.engineId}.contains,
        clock: clock,
      );
      expect(lockOfB.tryTake(), isTrue);
      final lockLineOfB = File('${folder.path}/index.lock').readAsStringSync();

      Object? failureOfA;
      storeOfA
          .queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB)
          .then<void>((_) {}, onError: (Object error) => failureOfA = error);
      fakeAsync.elapse(const Duration(seconds: 11));
      expect(failureOfA, isA<OutboxLockUnavailable>());
      expect(File('${folder.path}/index.lock').readAsStringSync(), lockLineOfB);

      fakeAsync.elapse(const Duration(seconds: 29));
      // B wakes up after 40 s and writes what it was writing, then lets go.
      OutboxIndexFile(folder).write(
        OutboxIndex(
          items: [
            StationChoiceItem(
              itemId: '0f1e2d3c-4b5a-4968-8776-655443322110',
              queuedAt: DateTime.utc(2026, 10, 8, 12),
              recognitionId: _recognitionTwo,
              stationId: _stationA,
            ),
          ],
        ),
      );
      lockOfB.release();

      storeOfA.queueStationChoice(recognitionId: _recognitionOne, stationId: _stationB);
      fakeAsync.elapse(Duration.zero);
      final items = switch (OutboxIndexFile(folder).read()) {
        OutboxIndexRead(:final index) => index.items,
        _ => const <OutboxItem>[],
      };
      expect(items.map((item) => (item as StationChoiceItem).recognitionId), [
        _recognitionTwo,
        _recognitionOne,
      ]);
    });
  });
}
