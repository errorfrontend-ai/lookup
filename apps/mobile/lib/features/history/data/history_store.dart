import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/time/clock.dart';

/// History on disk (P6 design §3.14): `<app support>/history/`, the app's private files folder,
/// never backed up and never shared (§3.22).
///
/// ```
/// history/
///   index.json          the entries ({"format_version": 1, "entries": [StoredHistoryEntry…]})
///   index.json.writing  the next index while it is written, then renamed over index.json
///   index.lock          held while the index is read, changed and written
/// ```
///
/// Written like the outbox's index (§3.8), because from piece 3 the background engine saves the
/// results of clips sent with no app open too:
/// - every change is a read-modify-write of `index.json` under `index.lock`, a lock file that names
///   its owner and is never taken over by its age (`OwnedLockFile`, P6-D36). When a live owner
///   keeps it for [lockPatience] the change fails with [HistoryLockUnavailable], and nothing is
///   taken over; one engine's own calls also run one after the other, never interleaved;
/// - the new index is written to `index.json.writing`, flushed, then renamed over `index.json`, so a
///   power cut leaves the old index or the new one, never half of one;
/// - an index that cannot be read is moved aside and reported, and History starts again empty: the
///   app keeps working. An entry in it that cannot be read is left out and reported.
///
/// Synchronous file calls inside: the index is a few hundred kilobytes at most (50 entries).
class HistoryStore {
  /// [locateFolder] gives the History folder (the app's support folder plus `history`; tests give a
  /// temporary one). [lockOwner] is this engine; [lockTakeOver] judges a lock another engine of
  /// this process may hold (§3.8).
  HistoryStore({
    required Future<Directory> Function() locateFolder,
    required LockFileOwner lockOwner,
    required LockTakeOver lockTakeOver,
    required Clock clock,
    required ClientErrorReporter clientErrorReporter,
  }) : _locateFolder = locateFolder,
       _lockOwner = lockOwner,
       _lockTakeOver = lockTakeOver,
       _clock = clock,
       _clientErrorReporter = clientErrorReporter;

  /// The History folder inside [appSupportFolder] (`getApplicationSupportDirectory()`).
  static Directory folderIn(Directory appSupportFolder) =>
      Directory('${appSupportFolder.path}/$folderName');

  /// The History folder's name.
  static const String folderName = 'history';

  /// The index format this version writes and reads.
  static const int formatVersion = 1;

  /// How long a change waits for `index.lock` held by a live owner before it counts as failed.
  static const Duration lockPatience = Duration(seconds: 10);

  final Future<Directory> Function() _locateFolder;
  final LockFileOwner _lockOwner;
  final LockTakeOver _lockTakeOver;
  final Clock _clock;
  final ClientErrorReporter _clientErrorReporter;

  /// The History folder, once made or while it is being made; null before that, and again after
  /// an attempt that failed.
  Future<_HistoryFolder>? _folder;

  /// The last call this engine started, which the next one waits for.
  Future<void> _lastCall = Future<void>.value();

  /// The entries as they are on disk now; none when there is no index or it cannot be read (the
  /// next change sets an unreadable one aside).
  Future<List<StoredHistoryEntry>> read() => _oneAtATime(() async {
    final folder = await _openFolder();
    return switch (_readIndex(folder)) {
      _IndexRead(:final entries) => entries,
      _IndexMissing() || _IndexUnreadable() => const <StoredHistoryEntry>[],
    };
  });

  /// Reads the entries, applies [change] and writes what it returns, all under `index.lock`;
  /// returns what was written. Nothing is written when [change] returns the very list it was given.
  /// Throws [HistoryLockUnavailable] when a live owner keeps the lock, and the file system's own
  /// exception when the folder cannot be written.
  Future<List<StoredHistoryEntry>> modify(
    List<StoredHistoryEntry> Function(List<StoredHistoryEntry> entries) change,
  ) => _oneAtATime(() async {
    final folder = await _openFolder();
    if (!await folder.indexLock.take(patience: lockPatience)) {
      throw const HistoryLockUnavailable();
    }
    try {
      final current = switch (_readIndex(folder)) {
        _IndexRead(:final entries, :final unreadableEntryCount) => _reportUnreadableEntries(
          entries,
          unreadableEntryCount,
        ),
        _IndexMissing() => const <StoredHistoryEntry>[],
        _IndexUnreadable() => _setAsideUnreadableIndex(folder),
      };
      final changed = change(current);
      if (identical(changed, current)) return current;
      final writing = File('${folder.directory.path}/index.json.writing');
      writing.writeAsStringSync(
        jsonEncode({
          'format_version': formatVersion,
          'entries': [for (final entry in changed) entry.toJson()],
        }),
        flush: true,
      );
      writing.renameSync(folder.indexFile.path);
      return changed;
    } finally {
      folder.indexLock.release();
    }
  });

  _IndexReading _readIndex(_HistoryFolder folder) {
    final String text;
    try {
      text = folder.indexFile.readAsStringSync();
    } on PathNotFoundException {
      return const _IndexMissing();
    }
    final Object? json;
    try {
      json = jsonDecode(text);
    } on FormatException {
      return const _IndexUnreadable();
    }
    if (json is! Map<String, Object?> ||
        json['format_version'] != formatVersion ||
        json['entries'] is! List<Object?>) {
      return const _IndexUnreadable();
    }
    final entries = <StoredHistoryEntry>[];
    var unreadableEntryCount = 0;
    for (final entry in json['entries']! as List<Object?>) {
      final stored = StoredHistoryEntry.fromJson(entry);
      if (stored == null) {
        unreadableEntryCount++;
      } else {
        entries.add(stored);
      }
    }
    return _IndexRead(entries: entries, unreadableEntryCount: unreadableEntryCount);
  }

  List<StoredHistoryEntry> _reportUnreadableEntries(
    List<StoredHistoryEntry> entries,
    int unreadableEntryCount,
  ) {
    if (unreadableEntryCount > 0) {
      _reportQuietly(
        'The History index held $unreadableEntryCount entries this version cannot read; they were '
        'left out',
      );
    }
    return entries;
  }

  List<StoredHistoryEntry> _setAsideUnreadableIndex(_HistoryFolder folder) {
    try {
      folder.indexFile.renameSync(
        '${folder.indexFile.path}.unreadable-${_clock.now().toUtc().millisecondsSinceEpoch}',
      );
    } on PathNotFoundException {
      // Already gone: nothing to move.
    }
    _reportQuietly('The History index could not be read; it was set aside and History emptied');
    return const <StoredHistoryEntry>[];
  }

  void _reportQuietly(String description) {
    unawaited(
      _clientErrorReporter
          .report(kind: ClientErrorKind.reported, error: description)
          .then<void>((_) {}, onError: (Object error) {}),
    );
  }

  /// The History folder, made the first time it is needed and kept, so every call shares one lock
  /// file. A folder that could not be made (the storage full at start-up) is not kept: the next
  /// call tries again, rather than every save failing until the app restarts.
  Future<_HistoryFolder> _openFolder() {
    final opened = _folder;
    if (opened != null) return opened;
    final opening = _locateFolder().then((directory) {
      directory.createSync(recursive: true);
      return _HistoryFolder(
        directory: directory,
        indexFile: File('${directory.path}/index.json'),
        indexLock: OwnedLockFile(
          file: File('${directory.path}/index.lock'),
          owner: _lockOwner,
          lockTakeOver: _lockTakeOver,
          clock: _clock,
        ),
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

  Future<T> _oneAtATime<T>(Future<T> Function() call) {
    final result = _lastCall.then((_) => call());
    _lastCall = result.then<void>((_) {}, onError: (Object error) {});
    return result;
  }
}

/// One entry as `history/index.json` keeps it (P6 design §3.14). Every field of the design's entry
/// is written, so the entries of piece 3 (clips saved with no signal) need no new format:
///
/// `entry_id` (the recognition id), `kind` (`RESULT`), `not_identified_reason`,
/// `captured_at_on_phone`, `saved_at`, `was_deferred`, `deferred_idempotency_key`, `was_notified`,
/// `answer` (the API's answer exactly as it came), `chosen_station_id`, `is_reported`.
final class StoredHistoryEntry {
  const StoredHistoryEntry({
    required this.entryId,
    required this.kind,
    required this.capturedAtOnPhone,
    required this.savedAt,
    required this.answer,
    this.chosenStationId,
    this.notIdentifiedReason,
    this.wasDeferred = false,
    this.deferredIdempotencyKey,
    this.wasNotified = false,
    this.isReported = false,
  });

  /// The kind of a result the listener saw.
  static const String resultKind = 'RESULT';

  /// The kind of a saved clip answered `CHOOSE_STATION`, waiting for the listener's choice.
  static const String awaitingChoiceKind = 'AWAITING_CHOICE';

  /// The kind of a scan whose ad result waits for the listener's account (ADR-005).
  static const String awaitingAccountKind = 'AWAITING_ACCOUNT';

  /// The kind of a saved clip that will never be identified.
  static const String notIdentifiedKind = 'NOT_IDENTIFIED';

  /// The recognition id.
  final String entryId;

  /// `RESULT`, `AWAITING_CHOICE`, `AWAITING_ACCOUNT` or `NOT_IDENTIFIED`.
  final String kind;

  /// When the phone recorded the clip, by its own clock, in UTC.
  final DateTime capturedAtOnPhone;

  /// When the entry was written, in UTC.
  final DateTime savedAt;

  /// The API's 200 answer exactly as it came: what the reader reads again each time it is shown.
  final Object? answer;

  /// The station the listener chose in "Which station?"; null for a match.
  final String? chosenStationId;

  /// Why a clip was not identified (piece 3); null for a result.
  final String? notIdentifiedReason;

  /// Whether the clip was sent from the outbox (piece 3).
  final bool wasDeferred;

  /// The saved clip's idempotency key (piece 3), so its waiting row can be hidden.
  final String? deferredIdempotencyKey;

  /// Whether a notification was posted for it (piece 3).
  final bool wasNotified;

  /// Whether the listener reported it (piece 4).
  final bool isReported;

  /// This entry, reported by the listener.
  StoredHistoryEntry markedReported() => StoredHistoryEntry(
    entryId: entryId,
    kind: kind,
    capturedAtOnPhone: capturedAtOnPhone,
    savedAt: savedAt,
    answer: answer,
    chosenStationId: chosenStationId,
    notIdentifiedReason: notIdentifiedReason,
    wasDeferred: wasDeferred,
    deferredIdempotencyKey: deferredIdempotencyKey,
    wasNotified: wasNotified,
    isReported: true,
  );

  Map<String, Object?> toJson() => {
    'entry_id': entryId,
    'kind': kind,
    'not_identified_reason': notIdentifiedReason,
    'captured_at_on_phone': capturedAtOnPhone.toUtc().toIso8601String(),
    'saved_at': savedAt.toUtc().toIso8601String(),
    'was_deferred': wasDeferred,
    'deferred_idempotency_key': deferredIdempotencyKey,
    'was_notified': wasNotified,
    'answer': answer,
    'chosen_station_id': chosenStationId,
    'is_reported': isReported,
  };

  /// [json] as an entry, or null when it is not one this version can read.
  static StoredHistoryEntry? fromJson(Object? json) {
    if (json case {
      'entry_id': final String entryId,
      'kind': final String kind,
      'captured_at_on_phone': final String capturedAtText,
      'saved_at': final String savedAtText,
      'was_deferred': final bool wasDeferred,
      'was_notified': final bool wasNotified,
      'is_reported': final bool isReported,
    } when entryId.isNotEmpty) {
      final capturedAtOnPhone = DateTime.tryParse(capturedAtText);
      final savedAt = DateTime.tryParse(savedAtText);
      final object = json;
      final chosenStationId = object['chosen_station_id'];
      final notIdentifiedReason = object['not_identified_reason'];
      final deferredIdempotencyKey = object['deferred_idempotency_key'];
      if (capturedAtOnPhone == null ||
          savedAt == null ||
          !object.containsKey('answer') ||
          (chosenStationId != null && chosenStationId is! String) ||
          (notIdentifiedReason != null && notIdentifiedReason is! String) ||
          (deferredIdempotencyKey != null && deferredIdempotencyKey is! String)) {
        return null;
      }
      return StoredHistoryEntry(
        entryId: entryId,
        kind: kind,
        capturedAtOnPhone: capturedAtOnPhone.toUtc(),
        savedAt: savedAt.toUtc(),
        answer: object['answer'],
        chosenStationId: chosenStationId as String?,
        notIdentifiedReason: notIdentifiedReason as String?,
        wasDeferred: wasDeferred,
        deferredIdempotencyKey: deferredIdempotencyKey as String?,
        wasNotified: wasNotified,
        isReported: isReported,
      );
    }
    return null;
  }
}

/// A live engine kept History's `index.lock` for longer than [HistoryStore.lockPatience]: the
/// change was not made, and nothing was taken over (P6-D36).
final class HistoryLockUnavailable implements Exception {
  const HistoryLockUnavailable();

  @override
  String toString() => 'HistoryLockUnavailable: a live engine kept the History index locked';
}

/// The History folder and what lives in it, made once.
final class _HistoryFolder {
  const _HistoryFolder({required this.directory, required this.indexFile, required this.indexLock});

  final Directory directory;
  final File indexFile;
  final OwnedLockFile indexLock;
}

/// What reading `index.json` found.
sealed class _IndexReading {
  const _IndexReading();
}

final class _IndexRead extends _IndexReading {
  const _IndexRead({required this.entries, required this.unreadableEntryCount});

  final List<StoredHistoryEntry> entries;
  final int unreadableEntryCount;
}

final class _IndexMissing extends _IndexReading {
  const _IndexMissing();
}

final class _IndexUnreadable extends _IndexReading {
  const _IndexUnreadable();
}
