import 'dart:convert';
import 'dart:io';

import 'outbox_index.dart';

/// `index.json` in the outbox folder, written so a power cut leaves the old index or the new one,
/// never half of one (P6 design §3.8): the new index goes to `index.json.writing`, is flushed, and
/// is renamed over `index.json`. The caller holds `index.lock` around a read-modify-write.
///
/// Synchronous file calls: the index is a few kilobytes at most, and one engine runs its own calls
/// one after the other.
final class OutboxIndexFile {
  OutboxIndexFile(this.folder);

  /// The outbox folder: `<app support>/outbox`.
  final Directory folder;

  File get _indexFile => File('${folder.path}/index.json');

  File get _writingFile => File('${folder.path}/index.json.writing');

  /// What `index.json` holds now.
  OutboxIndexReading read() {
    final String text;
    try {
      text = _indexFile.readAsStringSync();
    } on PathNotFoundException {
      return const OutboxIndexMissing();
    }
    try {
      final reading = OutboxIndex.fromJson(jsonDecode(text));
      return OutboxIndexRead(
        index: reading.index,
        unreadableItemCount: reading.unreadableItemCount,
      );
    } on FormatException {
      return const OutboxIndexUnreadable();
    }
  }

  /// Writes [index] in full, atomically.
  void write(OutboxIndex index) {
    _writingFile.writeAsStringSync(jsonEncode(index.toJson()), flush: true);
    _writingFile.renameSync(_indexFile.path);
  }

  /// Moves an index that cannot be read out of the way, under a name that says so, so the outbox
  /// starts again empty and nothing is read from it again (§3.8).
  void moveAside(DateTime now) {
    try {
      _indexFile.renameSync('${_indexFile.path}.unreadable-${now.toUtc().millisecondsSinceEpoch}');
    } on PathNotFoundException {
      // Already gone: nothing to move.
    }
  }
}

/// What reading `index.json` found.
sealed class OutboxIndexReading {
  const OutboxIndexReading();
}

/// The index, read; [unreadableItemCount] items in it could not be read and were left out.
final class OutboxIndexRead extends OutboxIndexReading {
  const OutboxIndexRead({required this.index, required this.unreadableItemCount});

  final OutboxIndex index;
  final int unreadableItemCount;
}

/// No index yet: nothing was ever queued, or the folder is new.
final class OutboxIndexMissing extends OutboxIndexReading {
  const OutboxIndexMissing();
}

/// An index that is not JSON or not an outbox index of this format.
final class OutboxIndexUnreadable extends OutboxIndexReading {
  const OutboxIndexUnreadable();
}
