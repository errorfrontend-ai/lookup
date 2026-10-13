import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../error_reporting/client_error_reporter.dart';
import '../files/owned_lock_file.dart';
import '../time/clock.dart';

/// "Used this month" on the Settings page (P6 design §3.16; P6-DATASAVER-03, Q11, P6-D45): the bytes
/// of every request body and answer body the app's own client sends or receives, and of every
/// picture it downloads, counted per calendar month of the phone and starting again at 0 on the
/// 1st. Headers and the connection's own overhead are not counted.
///
/// Kept in `<app support>/data_use/data-use.json` under `data-use.lock` (the lock-file rules of the
/// outbox, §3.8), not in `shared_preferences`, because the foreground and background engines both
/// add to it and each engine's cached preferences would lose the other's bytes.
///
/// Counting never fails what is counted: [add] never throws, and a failure is reported once.
class DataUseMeter {
  DataUseMeter({
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

  /// The meter's folder inside [appSupportFolder].
  static Directory folderIn(Directory appSupportFolder) =>
      Directory('${appSupportFolder.path}/$folderName');

  static const String folderName = 'data_use';

  static const int formatVersion = 1;

  /// How long an addition waits for a live owner's lock before it is given up.
  static const Duration lockPatience = Duration(seconds: 10);

  final Future<Directory> Function() _locateFolder;
  final LockFileOwner _lockOwner;
  final LockTakeOver _lockTakeOver;
  final Clock _clock;
  final ClientErrorReporter _clientErrorReporter;
  final StreamController<void> _changed = StreamController<void>.broadcast();

  Future<_DataUseFolder>? _folder;
  Future<void> _lastCall = Future<void>.value();
  bool _hasReportedAFailure = false;

  /// An event after each addition this engine wrote.
  Stream<void> get changed => _changed.stream;

  /// Adds [bytes] to this month's count. Never throws.
  Future<void> add(int bytes) async {
    if (bytes <= 0) return;
    try {
      await _oneAtATime(() async {
        final folder = await _openFolder();
        if (!await folder.lock.take(patience: lockPatience)) {
          throw const FileSystemException('The data use lock is held');
        }
        try {
          final month = monthOf(_clock.now());
          final stored = _read(folder);
          final bytesBefore = stored != null && stored.month == month ? stored.bytes : 0;
          final writing = File('${folder.directory.path}/data-use.json.writing');
          writing.writeAsStringSync(
            jsonEncode({
              'format_version': formatVersion,
              'month': month,
              'bytes': bytesBefore + bytes,
            }),
            flush: true,
          );
          writing.renameSync(folder.file.path);
        } finally {
          folder.lock.release();
        }
      });
      _changed.add(null);
    } on Object catch (error, stackTrace) {
      _reportOnce(error, stackTrace);
    }
  }

  /// The bytes counted in the phone's current month; 0 in a new month, or when nothing can be read.
  Future<int> bytesThisMonth() async {
    try {
      return await _oneAtATime(() async {
        final stored = _read(await _openFolder());
        return stored != null && stored.month == monthOf(_clock.now()) ? stored.bytes : 0;
      });
    } on Object {
      return 0;
    }
  }

  /// The phone's calendar month of [moment], e.g. `2026-10`.
  static String monthOf(DateTime moment) {
    final local = moment.toLocal();
    return '${local.year.toString().padLeft(4, '0')}-${local.month.toString().padLeft(2, '0')}';
  }

  ({String month, int bytes})? _read(_DataUseFolder folder) {
    try {
      final json = jsonDecode(folder.file.readAsStringSync());
      if (json case {
        'format_version': formatVersion,
        'month': final String month,
        'bytes': final int bytes,
      } when bytes >= 0) {
        return (month: month, bytes: bytes);
      }
    } on PathNotFoundException {
      return null;
    } on FormatException {
      // Unreadable: the next addition starts the month again.
    }
    return null;
  }

  void _reportOnce(Object error, StackTrace stackTrace) {
    if (_hasReportedAFailure) return;
    _hasReportedAFailure = true;
    unawaited(
      _clientErrorReporter
          .report(
            kind: ClientErrorKind.reported,
            error: error,
            stackTrace: stackTrace,
            description: 'Counting the data used failed',
          )
          .then<void>((_) {}, onError: (Object error) {}),
    );
  }

  Future<_DataUseFolder> _openFolder() {
    final opened = _folder;
    if (opened != null) return opened;
    final opening = _locateFolder().then((directory) {
      directory.createSync(recursive: true);
      return _DataUseFolder(
        directory: directory,
        file: File('${directory.path}/data-use.json'),
        lock: OwnedLockFile(
          file: File('${directory.path}/data-use.lock'),
          owner: _lockOwner,
          lockTakeOver: _lockTakeOver,
          clock: _clock,
        ),
      );
    });
    _folder = opening;
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

final class _DataUseFolder {
  const _DataUseFolder({required this.directory, required this.file, required this.lock});

  final Directory directory;
  final File file;
  final OwnedLockFile lock;
}
