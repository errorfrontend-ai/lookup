import 'dart:convert';
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';

import '../../support/fake_clock.dart';

const LockFileOwner _thisEngine = LockFileOwner(
  processId: 4242,
  engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
);
const String _otherEngineId = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';

/// The line a lock holds, as an owner writes it.
String _lockLine({required int processId, required String engineId, String? takenAt}) =>
    jsonEncode({
      'process_id': processId,
      'engine_id': engineId,
      'taken_at': takenAt ?? '2026-10-08T12:00:00.000Z',
    });

/// The owned lock files of P6 design §3.8 (P6-D36): judged by their owner, never by their age.
void main() {
  late Directory folder;
  late File lockPath;
  late Set<String> attachedEngines;
  late FakeClock clock;

  Map<String, Object?> lockContent() =>
      jsonDecode(lockPath.readAsStringSync()) as Map<String, Object?>;

  OwnedLockFile lockFor(LockFileOwner owner, {Future<void> Function()? beforeTakeOver}) =>
      OwnedLockFile(
        file: lockPath,
        owner: owner,
        lockTakeOver: LocalLockTakeOver(attachedEngineIds: attachedEngines),
        clock: clock,
        beforeTakeOver: beforeTakeOver,
      );

  setUp(() {
    folder = Directory.systemTemp.createTempSync('owned_lock_file_test_');
    lockPath = File('${folder.path}/index.lock');
    attachedEngines = {_thisEngine.engineId};
    clock = FakeClock();
  });
  tearDown(() => folder.deleteSync(recursive: true));

  test('a free lock is created holding one line that names this process and engine', () async {
    final lock = lockFor(_thisEngine);
    expect(await lock.tryTake(), isTrue);
    expect(lock.isHeld, isTrue);
    expect(jsonDecode(lockPath.readAsStringSync()), {
      'process_id': 4242,
      'engine_id': _thisEngine.engineId,
      'taken_at': '2026-10-08T12:00:00.000Z',
    });
    lock.release();
    expect(lockPath.existsSync(), isFalse);
    expect(lock.isHeld, isFalse);
  });

  test('a lock naming another process id is taken over: that process has ended', () async {
    lockPath.writeAsStringSync(_lockLine(processId: 1111, engineId: _otherEngineId));
    final lock = lockFor(_thisEngine);
    expect(await lock.tryTake(), isTrue);
    expect(lockContent()['process_id'], 4242);
    expect(folder.listSync(), hasLength(1), reason: 'the dead lock was renamed and deleted');
  });

  test(
    'a lock of this process held by an attached engine is never taken over, however old',
    () async {
      attachedEngines.add(_otherEngineId);
      final heldLine = _lockLine(
        processId: 4242,
        engineId: _otherEngineId,
        takenAt: '2020-01-01T00:00:00.000Z',
      );
      lockPath.writeAsStringSync(heldLine);
      // A file time years in the past changes nothing: age is never a reason.
      lockPath.setLastModifiedSync(DateTime.utc(2020));
      clock.advance(const Duration(days: 365));

      final lock = lockFor(_thisEngine);
      expect(await lock.tryTake(), isFalse);
      expect(lockPath.readAsStringSync(), heldLine);
    },
  );

  test('waiting for a live engine\'s lock: no take-over after 40 seconds, and the lock is taken '
      'as soon as its owner lets go', () {
    fakeAsync((fakeAsync) {
      attachedEngines.add(_otherEngineId);
      final heldLine = _lockLine(processId: 4242, engineId: _otherEngineId);
      lockPath.writeAsStringSync(heldLine);
      final lock = lockFor(_thisEngine);
      bool? isTaken;
      lock.take(patience: const Duration(seconds: 60)).then((taken) => isTaken = taken);

      fakeAsync.elapse(const Duration(seconds: 40));
      expect(isTaken, isNull, reason: 'still waiting');
      expect(lockPath.readAsStringSync(), heldLine);

      lockPath.deleteSync();
      fakeAsync.elapse(OwnedLockFile.retryInterval);
      expect(isTaken, isTrue);
      expect(lock.isHeld, isTrue);
    });
  });

  test('a live engine that keeps its lock past the patience leaves the caller without it', () {
    fakeAsync((fakeAsync) {
      attachedEngines.add(_otherEngineId);
      final heldLine = _lockLine(processId: 4242, engineId: _otherEngineId);
      lockPath.writeAsStringSync(heldLine);
      bool? isTaken;
      lockFor(_thisEngine).take(patience: const Duration(seconds: 10)).then((taken) {
        isTaken = taken;
      });
      fakeAsync.elapse(const Duration(seconds: 11));
      expect(isTaken, isFalse);
      expect(lockPath.readAsStringSync(), heldLine, reason: 'nothing was taken over');
    });
  });

  test('a lock of this process naming an engine no longer attached is taken over', () async {
    lockPath.writeAsStringSync(_lockLine(processId: 4242, engineId: _otherEngineId));
    expect(await lockFor(_thisEngine).tryTake(), isTrue);
    expect(lockContent()['engine_id'], _thisEngine.engineId);
  });

  test('a lock this engine left behind (a release that never happened) is taken back', () async {
    lockPath.writeAsStringSync(
      _lockLine(processId: 4242, engineId: _thisEngine.engineId, takenAt: '2026-10-08T11:00:00Z'),
    );
    expect(await lockFor(_thisEngine).tryTake(), isTrue);
  });

  test('two engines judging the same dead lock: only one takes it, and the lock taken in between '
      'is never removed', () async {
    const otherEngine = LockFileOwner(processId: 4242, engineId: _otherEngineId);
    attachedEngines.add(_otherEngineId);
    lockPath.writeAsStringSync(_lockLine(processId: 1111, engineId: 'a-process-that-ended'));
    final otherLock = lockFor(otherEngine);
    var hasOtherTaken = false;
    // This engine judges the lock dead; before it acts, the other engine takes it over.
    final lock = lockFor(
      _thisEngine,
      beforeTakeOver: () async => hasOtherTaken = await otherLock.tryTake(),
    );

    expect(await lock.tryTake(), isFalse);
    expect(hasOtherTaken, isTrue);
    expect(otherLock.isHeld, isTrue);
    expect(lockContent()['engine_id'], _otherEngineId);
  });

  test('release never removes a lock another engine holds', () async {
    final lock = lockFor(_thisEngine);
    await lock.tryTake();
    final otherLine = _lockLine(processId: 1111, engineId: _otherEngineId);
    // Something replaced this engine's lock while it held it.
    lockPath.writeAsStringSync(otherLine);
    lock.release();
    expect(lockPath.readAsStringSync(), otherLine);
  });

  test(
    'an unreadable lock is judged dead only when it is still the same at the next look',
    () async {
      lockPath.writeAsStringSync('');
      final lock = lockFor(_thisEngine);
      expect(await lock.tryTake(), isFalse, reason: 'its owner may be writing it right now');
      expect(await lock.tryTake(), isTrue, reason: 'still unreadable: left by a crash');
    },
  );
}
