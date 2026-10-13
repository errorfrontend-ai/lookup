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
///   clips/<idempotency key>.m4a   the recording of each waiting clip
/// ```
///
/// - Every change is a read-modify-write of `index.json` under `index.lock`, a lock file that names
///   its owner and is never taken over by its age (`OwnedLockFile`, P6-D36). When a live owner
///   keeps it for 10 seconds the change fails with [OutboxLockUnavailable], and nothing is taken
///   over. One engine's own calls also run one after the other, never interleaved.
/// - An index that cannot be read is moved aside, any clip files deleted, and a crash report sent:
///   a waiting item is lost, but the app keeps working. An item in it that cannot be read is left
///   out and reported.
/// - Every write tells [itemsQueued] when it added an item, which starts a run (§3.9 point 1), and
///   [changed] after any write, which History's waiting rows follow.
/// - A clip's file is written and flushed under `index.lock`, before its item is added; a clip's
///   file is deleted after the index that no longer names it is written. A crash in between leaves
///   a file with no item, which [sweepClipFiles] deletes at the next start (§3.8).
///
/// Items survive closing the app and opening it again: they are only ever in `index.json`
/// (P6-OUTBOX-01).
class OutboxStore {
  /// [locateFolder] gives the outbox folder (the app's support folder plus `outbox`; tests give a
  /// temporary one). [lockOwner] is this engine; [lockTakeOver] judges a lock another engine of
  /// this process may hold (§3.8).
  OutboxStore({
    required Future<Directory> Function() locateFolder,
    required LockFileOwner lockOwner,
    required LockTakeOver lockTakeOver,
    required Clock clock,
    required RandomUuid randomUuid,
    required ClientErrorReporter clientErrorReporter,
  }) : _locateFolder = locateFolder,
       _lockOwner = lockOwner,
       _lockTakeOver = lockTakeOver,
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
  final LockTakeOver _lockTakeOver;
  final Clock _clock;
  final RandomUuid _randomUuid;
  final ClientErrorReporter _clientErrorReporter;

  final StreamController<void> _itemsQueued = StreamController<void>.broadcast(sync: true);
  final StreamController<void> _changed = StreamController<void>.broadcast();

  /// The outbox folder, once made or while it is being made; null before that, and again after an
  /// attempt that failed.
  Future<_OutboxFolder>? _folder;

  /// The last call this engine started, which the next one waits for.
  Future<void> _lastCall = Future<void>.value();

  /// An event each time an item was added (after it is on disk).
  Stream<void> get itemsQueued => _itemsQueued.stream;

  /// An event after every write of the index, by this engine.
  Stream<void> get changed => _changed.stream;

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

  /// Keeps a clip the live send could not settle (T21′, T24′, T27′, T31′; contract R1): its
  /// recording is written to `clips/<idempotency key>.m4a` and flushed, then its item added, under
  /// `index.lock`, so "Saved" is true once this returns. With 5 clips already waiting, the oldest
  /// (by capture time) is deleted first (P6-OFFLINE-04, P6-D6). A clip whose key already waits is
  /// not queued twice. Throws when the folder cannot be written, which the live flow shows as a
  /// failure on the phone (§2.17).
  Future<QueuedDeferredClip> queueDeferredClip({
    required String idempotencyKey,
    required DateTime capturedAt,
    required int clipDurationMilliseconds,
    required String codec,
    required String? stationHintId,
    required List<int> audioBytes,
    required DeferredClipSavedReason savedReason,
  }) async {
    final key = idempotencyKey.toLowerCase();
    if (!_uuid.hasMatch(key)) {
      throw ArgumentError.value(idempotencyKey, 'idempotencyKey', 'not a UUID');
    }
    var wasOldestClipDeleted = false;
    var isQueued = false;
    await _oneAtATime(
      () => _modifyInFolder((folder, index) {
        if (index.clips.any((clip) => clip.idempotencyKey == key)) return index;
        final fileName = '$key.m4a';
        folder.clipsFolder.createSync(recursive: true);
        File('${folder.clipsFolder.path}/$fileName').writeAsBytesSync(audioBytes, flush: true);
        var withRoom = index;
        final waiting = index.clips;
        if (waiting.length >= OutboxTimingRules.maximumStoredClips) {
          withRoom = index.withItemRemoved(waiting.first.itemId);
          wasOldestClipDeleted = true;
        }
        isQueued = true;
        return withRoom.withItemAdded(
          DeferredClipItem(
            itemId: _randomUuid.generate(),
            queuedAt: _clock.now().toUtc(),
            idempotencyKey: key,
            capturedAt: capturedAt.toUtc(),
            clipDurationMilliseconds: clipDurationMilliseconds,
            codec: codec,
            stationHintId: stationHintId,
            audioFileName: fileName,
            audioSizeBytes: audioBytes.length,
            savedReason: savedReason,
          ),
        );
      }),
    );
    if (isQueued) _itemsQueued.add(null);
    return QueuedDeferredClip(isQueued: isQueued, wasOldestClipDeleted: wasOldestClipDeleted);
  }

  /// Queues a crash report that got no answer (P6 design §3.20): [fields] as the reporter built and
  /// scrubbed them, [occurredAt] the phone's time of the error, [reportId] its `X-Request-Id` on
  /// every send. With 20 waiting, the oldest goes first.
  Future<void> queueClientErrorReport({
    required String reportId,
    required DateTime occurredAt,
    required Map<String, String> fields,
  }) async {
    await modify((index) {
      final waiting = [
        for (final item in index.items)
          if (item is ClientErrorReportItem) item,
      ]..sort((first, second) => first.queuedAt.compareTo(second.queuedAt));
      final withRoom = waiting.length >= OutboxTimingRules.maximumQueuedClientErrorReports
          ? index.withItemRemoved(waiting.first.itemId)
          : index;
      return withRoom.withItemAdded(
        ClientErrorReportItem(
          itemId: _randomUuid.generate(),
          queuedAt: _clock.now().toUtc(),
          reportId: reportId,
          occurredAt: occurredAt.toUtc(),
          fields: fields,
        ),
      );
    });
    _itemsQueued.add(null);
  }

  /// The recording of [clip], or null when its file is gone (the sweep then removes the item).
  Future<List<int>?> readClipAudio(DeferredClipItem clip) => _oneAtATime(() async {
    final folder = await _openFolder();
    final file = File('${folder.clipsFolder.path}/${clip.audioFileName}');
    try {
      return file.readAsBytesSync();
    } on FileSystemException {
      return null;
    }
  });

  /// At start (§3.8): deletes clip files no item names (a crash between a file and its item, or
  /// between an index and a deletion), and removes clip items whose file is gone, with a crash
  /// report. Under `index.lock`, so it never races a clip being written.
  Future<void> sweepClipFiles() async {
    var missingFileCount = 0;
    await _oneAtATime(
      () => _modifyInFolder((folder, index) {
        final named = {for (final clip in index.clips) clip.audioFileName};
        if (folder.clipsFolder.existsSync()) {
          for (final entry in folder.clipsFolder.listSync()) {
            final name = entry.uri.pathSegments.where((segment) => segment.isNotEmpty).last;
            if (!named.contains(name)) entry.deleteSync(recursive: true);
          }
        }
        final withoutFile = {
          for (final clip in index.clips)
            if (!File('${folder.clipsFolder.path}/${clip.audioFileName}').existsSync()) clip.itemId,
        };
        missingFileCount = withoutFile.length;
        return index.withItemsRemoved(withoutFile);
      }),
    );
    if (missingFileCount > 0) {
      _reportQuietly('$missingFileCount waiting clips had lost their recording; they were removed');
    }
  }

  /// The lock the sender holds while it runs, so two engines never send at once (§3.9 point 2).
  Future<OwnedLockFile> sendingLock() async => (await _openFolder()).sendingLock;

  Future<OutboxIndex> _modifyUnderLock(OutboxIndex Function(OutboxIndex index) change) =>
      _modifyInFolder((folder, index) => change(index));

  /// Reads the index under `index.lock`, applies [change] (which may write a clip's file in the
  /// folder) and writes what it returns; then deletes the files of clips it removed. Nothing is
  /// written when [change] returns the very index it was given.
  Future<OutboxIndex> _modifyInFolder(
    OutboxIndex Function(_OutboxFolder folder, OutboxIndex index) change,
  ) async {
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
      final changed = change(folder, current);
      if (identical(changed, current)) return current;
      folder.indexFile.write(changed);
      _deleteFilesOfRemovedClips(folder, before: current, after: changed);
      _changed.add(null);
      return changed;
    } finally {
      folder.indexLock.release();
    }
  }

  /// Deletes the recordings of the clips [before] held and [after] no longer does. A file that
  /// cannot be deleted now is left for the next start's sweep.
  void _deleteFilesOfRemovedClips(
    _OutboxFolder folder, {
    required OutboxIndex before,
    required OutboxIndex after,
  }) {
    final kept = {for (final clip in after.clips) clip.audioFileName};
    for (final clip in before.clips) {
      if (kept.contains(clip.audioFileName)) continue;
      try {
        File('${folder.clipsFolder.path}/${clip.audioFileName}').deleteSync();
      } on FileSystemException {
        // Gone already, or held: the sweep at the next start deletes it.
      }
    }
  }

  static final RegExp _uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  );

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
    if (folder.clipsFolder.existsSync()) folder.clipsFolder.deleteSync(recursive: true);
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

  /// The outbox folder, made the first time it is needed and kept, so every call shares one set of
  /// lock files. A folder that could not be made (the storage full at start-up) is not kept: the
  /// next call tries again, rather than every call failing until the app restarts.
  Future<_OutboxFolder> _openFolder() {
    final opened = _folder;
    if (opened != null) return opened;
    final opening = _locateFolder().then((directory) {
      directory.createSync(recursive: true);
      return _OutboxFolder(
        directory: directory,
        clipsFolder: Directory('${directory.path}/clips'),
        indexFile: OutboxIndexFile(directory),
        indexLock: _lockFile(directory, 'index.lock'),
        sendingLock: _lockFile(directory, 'sending.lock'),
      );
    });
    _folder = opening;
    // Runs before the caller hears of the failure, so its next call already tries again.
    opening.then<void>(
      (_) {},
      onError: (Object error) {
        if (identical(_folder, opening)) _folder = null;
      },
    );
    return opening;
  }

  OwnedLockFile _lockFile(Directory directory, String name) => OwnedLockFile(
    file: File('${directory.path}/$name'),
    owner: _lockOwner,
    lockTakeOver: _lockTakeOver,
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
    required this.clipsFolder,
    required this.indexFile,
    required this.indexLock,
    required this.sendingLock,
  });

  final Directory directory;
  final Directory clipsFolder;
  final OutboxIndexFile indexFile;
  final OwnedLockFile indexLock;
  final OwnedLockFile sendingLock;
}

/// What [OutboxStore.queueDeferredClip] did: whether the clip was queued (false when its key already
/// waited), and whether the oldest waiting clip was deleted to make room (the Saved screen says so).
final class QueuedDeferredClip {
  const QueuedDeferredClip({required this.isQueued, required this.wasOldestClipDeleted});

  final bool isQueued;
  final bool wasOldestClipDeleted;
}

/// A live engine kept `index.lock` for longer than [OutboxStore.indexLockPatience]: the change was
/// not made, and nothing was taken over (P6-D36).
final class OutboxLockUnavailable implements Exception {
  const OutboxLockUnavailable();

  @override
  String toString() => 'OutboxLockUnavailable: a live engine kept the outbox index locked';
}
