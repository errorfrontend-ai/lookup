import 'dart:async';
import 'dart:io';

import '../error_reporting/client_error_reporter.dart';
import '../files/owned_lock_file.dart';
import '../identifiers/random_uuid.dart';
import '../time/clock.dart';
import 'outbox_index.dart';
import 'outbox_index_file.dart';
import 'outbox_item.dart';
import 'outbox_item_group.dart';
import 'outbox_item_kind.dart';
import 'outbox_timing_rules.dart';

export 'outbox_index.dart';
export 'outbox_item.dart';
export 'outbox_item_group.dart';
export 'outbox_item_kind.dart';

/// The outbox on disk (P6 design §3.8): `<app support>/outbox/`, the app's private files folder,
/// outside the cache the system may clear and outside the clip sweep of Step 4 (P6-OFFLINE-03).
///
/// ```
/// outbox/
///   index.json          the queue (OutboxIndex)
///   index.json.writing  the next index while it is written, then renamed over index.json
///   index.lock          held while the index is read, changed and written
///   sending.lock        held by the engine that runs the sender
/// ```
///
/// - Every change is a read-modify-write of `index.json` under `index.lock`, a lock file that names
///   its owner and is never taken over by its age (`OwnedLockFile`, P6-D36). When a live owner
///   keeps it for 10 seconds the change fails with [OutboxLockUnavailable], and nothing is taken
///   over. One engine's own calls also run one after the other, never interleaved.
/// - An index that cannot be read is moved aside, any clip files deleted, and a crash report sent:
///   a waiting item is lost, but the app keeps working. An item in it that cannot be read is left
///   out and reported.
/// - Every write tells [itemsQueued] when it added an item, which starts a run (§3.9 point 1).
///
/// Items survive closing the app and opening it again: they are only ever in `index.json`
/// (P6-OUTBOX-01).
class OutboxStore {
  /// [locateFolder] gives the outbox folder (the app's support folder plus `outbox`; tests give a
  /// temporary one). [lockOwner] is this engine; [isEngineAttached] says whether another engine of
  /// this process still runs (§3.8).
  OutboxStore({
    required Future<Directory> Function() locateFolder,
    required LockFileOwner lockOwner,
    required bool Function(String engineId) isEngineAttached,
    required Clock clock,
    required RandomUuid randomUuid,
    required ClientErrorReporter clientErrorReporter,
  }) : _locateFolder = locateFolder,
       _lockOwner = lockOwner,
       _isEngineAttached = isEngineAttached,
       _clock = clock,
       _randomUuid = randomUuid,
       _clientErrorReporter = clientErrorReporter;

  /// The outbox folder inside [appSupportFolder] (`getApplicationSupportDirectory()`): the app's
  /// private files, outside the cache the system may clear and outside the clip sweep (§3.8,
  /// P6-OFFLINE-03).
  static Directory folderIn(Directory appSupportFolder) =>
      Directory('${appSupportFolder.path}/$folderName');

  /// The outbox folder's name.
  static const String folderName = 'outbox';

  /// How long a change waits for `index.lock` held by a live owner before it counts as failed.
  static const Duration indexLockPatience = Duration(seconds: 10);

  final Future<Directory> Function() _locateFolder;
  final LockFileOwner _lockOwner;
  final bool Function(String engineId) _isEngineAttached;
  final Clock _clock;
  final RandomUuid _randomUuid;
  final ClientErrorReporter _clientErrorReporter;

  final StreamController<void> _itemsQueued = StreamController<void>.broadcast(sync: true);

  Future<_OutboxFolder>? _folder;

  /// The last call this engine started, which the next one waits for.
  Future<void> _lastCall = Future<void>.value();

  /// An event each time an item was added (after it is on disk).
  Stream<void> get itemsQueued => _itemsQueued.stream;

  /// The queue as it is on disk now; empty when there is none or it cannot be read (the next
  /// change sets an unreadable one aside).
  Future<OutboxIndex> read() => _oneAtATime(() async {
    final folder = await _openFolder();
    return switch (folder.indexFile.read()) {
      OutboxIndexRead(:final index) => index,
      OutboxIndexMissing() || OutboxIndexUnreadable() => OutboxIndex.empty,
    };
  });

  /// Reads the queue, applies [change] and writes the result, all under `index.lock`; returns what
  /// was written. Throws [OutboxLockUnavailable] when a live owner keeps the lock, and the file
  /// system's own exception when the folder cannot be written.
  Future<OutboxIndex> modify(OutboxIndex Function(OutboxIndex index) change) =>
      _oneAtATime(() => _modifyUnderLock(change));

  /// Queues the listener's choice of [stationId] for [recognitionId] (T44, P6-CHOOSER-10). The first
  /// choice wins: when a choice for that recognition already waits, nothing changes and the result
  /// is false (the server keeps the first one too, contract §1.3). With 200 follow-ups waiting, the
  /// oldest follow-up is deleted first (P6-D44).
  Future<bool> queueStationChoice({
    required String recognitionId,
    required String stationId,
  }) async {
    var isQueued = false;
    await modify((index) {
      final isAlreadyChosen = index.items.any(
        (item) => item is StationChoiceItem && item.recognitionId == recognitionId,
      );
      if (isAlreadyChosen) return index;
      isQueued = true;
      final withRoom = _withRoomForFollowUp(index);
      return withRoom.withItemAdded(
        StationChoiceItem(
          itemId: _randomUuid.generate(),
          queuedAt: _clock.now().toUtc(),
          recognitionId: recognitionId,
          stationId: stationId,
        ),
      );
    });
    if (isQueued) _itemsQueued.add(null);
    return isQueued;
  }

  /// The lock the sender holds while it runs, so two engines never send at once (§3.9 point 2).
  Future<OwnedLockFile> sendingLock() async => (await _openFolder()).sendingLock;

  Future<OutboxIndex> _modifyUnderLock(OutboxIndex Function(OutboxIndex index) change) async {
    final folder = await _openFolder();
    if (!await folder.indexLock.take(patience: indexLockPatience)) {
      throw const OutboxLockUnavailable();
    }
    try {
      final current = switch (folder.indexFile.read()) {
        OutboxIndexRead(:final index, :final unreadableItemCount) => _reportUnreadableItems(
          index,
          unreadableItemCount,
        ),
        OutboxIndexMissing() => OutboxIndex.empty,
        OutboxIndexUnreadable() => _setAsideUnreadableIndex(folder),
      };
      final changed = change(current);
      folder.indexFile.write(changed);
      return changed;
    } finally {
      folder.indexLock.release();
    }
  }

  /// [index] with room for one more follow-up: at the limit, the oldest tap goes first, then the
  /// oldest report, then the oldest choice (P6-D44). Only choices exist so far.
  OutboxIndex _withRoomForFollowUp(OutboxIndex index) {
    final followUps = [
      for (final item in index.items)
        if (item.kind.group == OutboxItemGroup.followUps) item,
    ];
    if (followUps.length < OutboxTimingRules.maximumFollowUpItems) return index;
    for (final kind in _followUpEvictionOrder) {
      final ofKind = followUps.where((item) => item.kind == kind).toList()
        ..sort((first, second) => first.queuedAt.compareTo(second.queuedAt));
      if (ofKind.isNotEmpty) return index.withItemRemoved(ofKind.first.itemId);
    }
    return index;
  }

  static const List<OutboxItemKind> _followUpEvictionOrder = [
    OutboxItemKind.engagement,
    OutboxItemKind.recognitionReport,
    OutboxItemKind.stationChoice,
  ];

  OutboxIndex _reportUnreadableItems(OutboxIndex index, int unreadableItemCount) {
    if (unreadableItemCount > 0) {
      _reportQuietly(
        'The outbox index held $unreadableItemCount items this version cannot read; they were '
        'left out',
      );
    }
    return index;
  }

  OutboxIndex _setAsideUnreadableIndex(_OutboxFolder folder) {
    folder.indexFile.moveAside(_clock.now());
    final clipsFolder = Directory('${folder.directory.path}/clips');
    if (clipsFolder.existsSync()) clipsFolder.deleteSync(recursive: true);
    _reportQuietly('The outbox index could not be read; it was set aside and the outbox emptied');
    return OutboxIndex.empty;
  }

  void _reportQuietly(String description) {
    unawaited(
      _clientErrorReporter
          .report(kind: ClientErrorKind.reported, error: description)
          .then<void>((_) {}, onError: (Object error) {}),
    );
  }

  Future<_OutboxFolder> _openFolder() => _folder ??= _locateFolder().then((directory) {
    directory.createSync(recursive: true);
    return _OutboxFolder(
      directory: directory,
      indexFile: OutboxIndexFile(directory),
      indexLock: _lockFile(directory, 'index.lock'),
      sendingLock: _lockFile(directory, 'sending.lock'),
    );
  });

  OwnedLockFile _lockFile(Directory directory, String name) => OwnedLockFile(
    file: File('${directory.path}/$name'),
    owner: _lockOwner,
    isEngineAttached: _isEngineAttached,
    clock: _clock,
  );

  Future<T> _oneAtATime<T>(Future<T> Function() call) {
    final result = _lastCall.then((_) => call());
    _lastCall = result.then<void>((_) {}, onError: (Object error) {});
    return result;
  }
}

/// The outbox folder and what lives in it, made once.
final class _OutboxFolder {
  const _OutboxFolder({
    required this.directory,
    required this.indexFile,
    required this.indexLock,
    required this.sendingLock,
  });

  final Directory directory;
  final OutboxIndexFile indexFile;
  final OwnedLockFile indexLock;
  final OwnedLockFile sendingLock;
}

/// A live engine kept `index.lock` for longer than [OutboxStore.indexLockPatience]: the change was
/// not made, and nothing was taken over (P6-D36).
final class OutboxLockUnavailable implements Exception {
  const OutboxLockUnavailable();

  @override
  String toString() => 'OutboxLockUnavailable: a live engine kept the outbox index locked';
}
