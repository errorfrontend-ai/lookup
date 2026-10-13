import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart' show visibleForTesting;

import '../time/clock.dart';

/// Who holds a lock file: one Dart engine of one process (P6 design §3.8, fact 9). Two engines can
/// run in one app process (the app's, and from piece 3 a background job's), and Dart's own file
/// locks belong to the process, so they cannot keep two engines apart; a lock file that names its
/// owner can.
final class LockFileOwner {
  const LockFileOwner({required this.processId, required this.engineId});

  /// The operating system's id of the process, from `dart:io`'s `pid`.
  final int processId;

  /// This engine's id: a version-4 UUID made when the engine started.
  final String engineId;

  @override
  bool operator ==(Object other) =>
      other is LockFileOwner && other.processId == processId && other.engineId == engineId;

  @override
  int get hashCode => Object.hash(processId, engineId);

  @override
  String toString() => 'LockFileOwner(process $processId, engine $engineId)';
}

/// A lock that is a file, created exclusively, holding one line of JSON that names its owner:
/// `{"process_id": …, "engine_id": "…", "taken_at": "…"}` (P6 design §3.8). The outbox's
/// `index.lock` and `sending.lock` are these; History's and the data-use count's will be too.
///
/// **A lock is never judged by its age** (P6-D36): a live engine can be slow (garbage collection,
/// slow flash, a long 2G send), and file times follow a wall clock the listener can move. A lock
/// that exists is judged by its owner:
/// - another process id: that process has ended (an app process keeps one id for its life, and
///   only this app writes in its private folder), so the lock is taken over;
/// - this process and an engine that is still attached: a live engine holds it, however long it
///   takes; it is never taken over, and the caller waits or gives up;
/// - this process and an engine that is no longer attached (its engine was destroyed mid-run), or
///   this very engine (a lock it failed to remove): taken over.
///
/// Whether another engine of this process is attached only the platform can say once a second
/// engine exists (the background job), so that judgement and its take-over are [LockTakeOver]'s:
/// on Android the `device_services` plugin makes them one step for the whole process; with one
/// engine, [LocalLockTakeOver] decides in Dart.
///
/// `taken_at` is written for people reading the folder; nothing ever decides by it.
///
/// **A take-over** reads the lock again and goes on only if it still holds exactly what was judged
/// dead; it then renames it to a unique name and deletes that, and only then creates its own lock
/// exclusively. A lock someone else took in the meantime is never removed, and a take-over is never
/// delete-and-create.
///
/// A lock whose content cannot be read (left by a crash between creating it and writing its line)
/// is judged dead only when it still holds the same content one attempt later, so an owner in the
/// middle of writing it is never mistaken for a dead one; and, carried over from the review of
/// piece 1, never while another engine of this process is attached, as that engine may be the one
/// writing it.
///
/// Synchronous file calls, all of them small: one engine runs its own calls one after the other.
final class OwnedLockFile {
  /// [lockTakeOver] judges and takes over a lock another engine of this process may hold.
  /// [beforeTakeOver] is for tests: it runs after a lock was judged dead and before it is taken
  /// over, so a test can let another engine act in between.
  OwnedLockFile({
    required this.file,
    required this.owner,
    required LockTakeOver lockTakeOver,
    required Clock clock,
    Random? random,
    @visibleForTesting Future<void> Function()? beforeTakeOver,
  }) : _lockTakeOver = lockTakeOver,
       _clock = clock,
       _random = random ?? Random.secure(),
       _beforeTakeOver = beforeTakeOver;

  /// How long [take] waits between two attempts.
  static const Duration retryInterval = Duration(milliseconds: 50);

  /// The lock file, e.g. `<outbox>/index.lock`.
  final File file;

  /// This engine, which the lock names while it holds it.
  final LockFileOwner owner;

  final LockTakeOver _lockTakeOver;
  final Clock _clock;
  final Random _random;
  final Future<void> Function()? _beforeTakeOver;

  /// The exact line this engine wrote when it took the lock; null while it does not hold it.
  String? _heldContent;

  /// Unreadable content seen at the last attempt, so the next attempt can tell a dead lock from
  /// one being written.
  String? _unreadableContentSeen;

  /// Whether this engine holds the lock now.
  bool get isHeld => _heldContent != null;

  /// Takes the lock if it can, now: creates it, or takes over a dead one. False when a live owner
  /// holds it (or another engine took it first). Never waits for a live owner, never throws.
  Future<bool> tryTake() async {
    if (isHeld) return true;
    try {
      if (_create()) return true;
      final existing = _readOrNull();
      if (existing == null) return _create();
      final judgement = _judge(existing);
      switch (judgement) {
        case _Alive():
          return false;
        case _DeadHere():
          await _beforeTakeOver?.call();
          if (!removeIfStillHolding(file, existing, random: _random)) return false;
        case _AskTheProcess(:final ownerEngineId):
          await _beforeTakeOver?.call();
          final isTakenOver = await _lockTakeOver.takeOverDeadLock(
            file: file,
            expectedContent: existing,
            askingEngineId: owner.engineId,
            ownerEngineId: ownerEngineId,
          );
          if (!isTakenOver) return false;
      }
      return _create();
    } on FileSystemException {
      return false;
    }
  }

  /// Takes the lock, trying every [retryInterval] until [patience] has passed. False when a live
  /// owner still holds it then: the caller's write counts as failed, and nothing is taken over.
  Future<bool> take({required Duration patience}) async {
    final attempts = patience.inMicroseconds ~/ retryInterval.inMicroseconds;
    for (var attempt = 0; attempt <= attempts; attempt++) {
      if (await tryTake()) return true;
      if (attempt < attempts) await Future<void>.delayed(retryInterval);
    }
    return false;
  }

  /// Lets go of the lock: deletes the file only while it still holds this engine's own line, so a
  /// lock another engine holds is never removed. Never throws.
  void release() {
    final heldContent = _heldContent;
    _heldContent = null;
    if (heldContent == null) return;
    try {
      if (_readOrNull() == heldContent) file.deleteSync();
    } on FileSystemException {
      // Already gone; the next taker judges whatever is left by its owner.
    }
  }

  /// Creates the lock with this engine's line; false when a lock already exists.
  bool _create() {
    final content = jsonEncode({
      'process_id': owner.processId,
      'engine_id': owner.engineId,
      'taken_at': _clock.now().toUtc().toIso8601String(),
    });
    try {
      file.createSync(exclusive: true);
    } on FileSystemException {
      return false;
    }
    file.writeAsStringSync(content, flush: true);
    _heldContent = content;
    _unreadableContentSeen = null;
    return true;
  }

  String? _readOrNull() {
    try {
      return file.readAsStringSync();
    } on FileSystemException {
      return null;
    }
  }

  /// What the rules above say of the owner [content] names: alive, gone (decided here), or for
  /// another engine of this process (and an unreadable lock seen twice) the process's to say.
  _Judgement _judge(String content) {
    final named = _ownerIn(content);
    if (named == null) {
      final isSecondLook = _unreadableContentSeen == content;
      _unreadableContentSeen = content;
      return isSecondLook ? const _AskTheProcess(ownerEngineId: null) : const _Alive();
    }
    _unreadableContentSeen = null;
    if (named.processId != owner.processId) return const _DeadHere();
    if (named.engineId == owner.engineId) return const _DeadHere();
    return _AskTheProcess(ownerEngineId: named.engineId);
  }

  /// The owner a lock's line names, or null when it names none.
  static LockFileOwner? _ownerIn(String content) {
    try {
      if (jsonDecode(content) case {
        'process_id': final int processId,
        'engine_id': final String engineId,
      } when engineId.isNotEmpty) {
        return LockFileOwner(processId: processId, engineId: engineId);
      }
    } on FormatException {
      return null;
    }
    return null;
  }

  /// Renames the lock [file] away and deletes it, only if it still holds exactly [judgedDead]:
  /// never delete-and-create, so a lock taken in between is never removed.
  static bool removeIfStillHolding(File file, String judgedDead, {required Random random}) {
    try {
      if (file.readAsStringSync() != judgedDead) return false;
    } on FileSystemException {
      return false;
    }
    final suffix = List.generate(8, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'));
    try {
      file.renameSync('${file.path}.taken-over-${suffix.join()}').deleteSync();
    } on FileSystemException {
      return false;
    }
    return true;
  }
}

/// What [OwnedLockFile] judged of an existing lock.
sealed class _Judgement {
  const _Judgement();
}

/// A live owner holds it.
final class _Alive extends _Judgement {
  const _Alive();
}

/// Its owner is gone, which this engine can tell alone: another process, or this very engine.
final class _DeadHere extends _Judgement {
  const _DeadHere();
}

/// Another engine of this process named it ([ownerEngineId]), or nobody can be read from it: the
/// process decides, as one step with the take-over.
final class _AskTheProcess extends _Judgement {
  const _AskTheProcess({required this.ownerEngineId});

  final String? ownerEngineId;
}

/// Judges and takes over a lock another engine of this process may hold (P6 design §3.8), as one
/// step for the whole process, so a lock an attached engine holds is never removed.
abstract interface class LockTakeOver {
  /// Removes [file] when it still holds exactly [expectedContent] and its owner is gone: the engine
  /// [ownerEngineId] of this process is not attached, or, for a lock that names no owner, no engine
  /// of this process but [askingEngineId] is. Answers whether it removed it. Never throws.
  Future<bool> takeOverDeadLock({
    required File file,
    required String expectedContent,
    required String askingEngineId,
    required String? ownerEngineId,
  });
}

/// [LockTakeOver] decided in Dart from a known set of attached engines: right when this engine is
/// the only one in its process (iOS, a platform without the plugin), and for tests, which set the
/// engines they pretend are attached.
final class LocalLockTakeOver implements LockTakeOver {
  /// [attachedEngineIds] are the engines of this process that run; null means every one does.
  LocalLockTakeOver({required Set<String>? attachedEngineIds, Random? random})
    : _attachedEngineIds = attachedEngineIds,
      _random = random ?? Random.secure();

  /// Every engine counts as attached, so no lock of this process is ever taken over.
  LocalLockTakeOver.everyEngineAttached() : this(attachedEngineIds: null);

  final Set<String>? _attachedEngineIds;
  final Random _random;

  bool _isAttached(String engineId) => _attachedEngineIds?.contains(engineId) ?? true;

  @override
  Future<bool> takeOverDeadLock({
    required File file,
    required String expectedContent,
    required String askingEngineId,
    required String? ownerEngineId,
  }) async {
    final attached = _attachedEngineIds;
    final isOwnerGone = ownerEngineId != null
        ? !_isAttached(ownerEngineId)
        : attached != null && attached.every((engineId) => engineId == askingEngineId);
    if (!isOwnerGone) return false;
    return OwnedLockFile.removeIfStillHolding(file, expectedContent, random: _random);
  }
}
