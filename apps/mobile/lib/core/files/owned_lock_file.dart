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
/// `taken_at` is written for people reading the folder; nothing ever decides by it.
///
/// **A take-over** reads the lock again and goes on only if it still holds exactly what was judged
/// dead; it then renames it to a unique name and deletes that, and only then creates its own lock
/// exclusively. A lock someone else took in the meantime is never removed, and a take-over is never
/// delete-and-create. From piece 3 the plugin that knows which engines are attached also makes this
/// check-and-rename one step for the whole process.
///
/// A lock whose content cannot be read (left by a crash between creating it and writing its line)
/// is judged dead only when it still holds the same content one attempt later, so an owner in the
/// middle of writing it is never mistaken for a dead one.
///
/// Synchronous file calls, all of them small: one engine runs its own calls one after the other.
final class OwnedLockFile {
  /// [isEngineAttached] says whether an engine of this process, by its id, is still running.
  /// [beforeTakeOver] is for tests: it runs after a lock was judged dead and before it is taken
  /// over, so a test can let another engine act in between.
  OwnedLockFile({
    required this.file,
    required this.owner,
    required bool Function(String engineId) isEngineAttached,
    required Clock clock,
    Random? random,
    @visibleForTesting void Function()? beforeTakeOver,
  }) : _isEngineAttached = isEngineAttached,
       _clock = clock,
       _random = random ?? Random.secure(),
       _beforeTakeOver = beforeTakeOver;

  /// How long [take] waits between two attempts.
  static const Duration retryInterval = Duration(milliseconds: 50);

  /// The lock file, e.g. `<outbox>/index.lock`.
  final File file;

  /// This engine, which the lock names while it holds it.
  final LockFileOwner owner;

  final bool Function(String engineId) _isEngineAttached;
  final Clock _clock;
  final Random _random;
  final void Function()? _beforeTakeOver;

  /// The exact line this engine wrote when it took the lock; null while it does not hold it.
  String? _heldContent;

  /// Unreadable content seen at the last attempt, so the next attempt can tell a dead lock from
  /// one being written.
  String? _unreadableContentSeen;

  /// Whether this engine holds the lock now.
  bool get isHeld => _heldContent != null;

  /// Takes the lock if it can, now: creates it, or takes over a dead one. False when a live owner
  /// holds it (or another engine took it first). Never waits, never throws.
  bool tryTake() {
    if (isHeld) return true;
    try {
      if (_create()) return true;
      final existing = _readOrNull();
      if (existing == null) return _create();
      if (!_isDead(existing)) return false;
      _beforeTakeOver?.call();
      if (!_removeIfStillHolding(existing)) return false;
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
      if (tryTake()) return true;
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

  /// Whether the owner [content] names is gone, by the rules above.
  bool _isDead(String content) {
    final named = _ownerIn(content);
    if (named == null) {
      final isSecondLook = _unreadableContentSeen == content;
      _unreadableContentSeen = content;
      return isSecondLook;
    }
    _unreadableContentSeen = null;
    if (named.processId != owner.processId) return true;
    if (named.engineId == owner.engineId) return true;
    return !_isEngineAttached(named.engineId);
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

  /// Renames the lock away and deletes it, only if it still holds exactly [judgedDead].
  bool _removeIfStillHolding(String judgedDead) {
    if (_readOrNull() != judgedDead) return false;
    final suffix = List.generate(8, (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0'));
    try {
      file.renameSync('${file.path}.taken-over-${suffix.join()}').deleteSync();
    } on FileSystemException {
      return false;
    }
    return true;
  }
}
