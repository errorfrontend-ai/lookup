import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'capture_settings.dart';

/// One capture session = one folder: the clips plus `manifest.part.csv` (paths relative to
/// the folder). Copy the folder into spike/corpus/ and run `python -m bench.import_captures`.
class SessionStore {
  SessionStore._(this.directory);

  final Directory directory;

  static String get _pathSeparator => Platform.pathSeparator;

  /// Android's app-specific external folder
  /// (Android/data/zm.lookup.lookup_capture/files/sessions/…). It survives app restarts;
  /// newer Android hides it from file managers, so the app itself must play and send clips.
  static Future<Directory> _findStorageDirectory() async =>
      await getExternalStorageDirectory() ?? await getApplicationDocumentsDirectory();

  static Future<SessionStore> create(DateTime startedAt) async =>
      createInDirectory(await _findStorageDirectory(), startedAt);

  static Future<SessionStore> createInDirectory(Directory baseDirectory, DateTime startedAt) async {
    final sessionDirectory = Directory(
        '${baseDirectory.path}${_pathSeparator}sessions${_pathSeparator}session_${formatTimestamp(startedAt)}');
    await sessionDirectory.create(recursive: true);
    return SessionStore._(sessionDirectory);
  }

  /// Every session on the phone, newest first.
  static Future<List<SessionStore>> listAll() async => listInDirectory(await _findStorageDirectory());

  static Future<List<SessionStore>> listInDirectory(Directory baseDirectory) async {
    final sessionsDirectory = Directory('${baseDirectory.path}${_pathSeparator}sessions');
    if (!await sessionsDirectory.exists()) return [];
    final sessionDirectories = await sessionsDirectory
        .list()
        .where((entity) =>
            entity is Directory &&
            entity.uri.pathSegments.where((segment) => segment.isNotEmpty).last.startsWith('session_'))
        .cast<Directory>()
        .toList();
    sessionDirectories.sort((first, second) => second.path.compareTo(first.path));
    return sessionDirectories.map(SessionStore._).toList();
  }

  String get name => directory.uri.pathSegments.where((segment) => segment.isNotEmpty).last;

  /// When the session was started, from its folder name (session_YYYYMMDDTHHMMSS).
  DateTime? get startedAt {
    final match = RegExp(r'(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})').firstMatch(name);
    if (match == null) return null;
    final dateParts = [for (var i = 1; i <= 6; i++) int.parse(match.group(i)!)];
    return DateTime(dateParts[0], dateParts[1], dateParts[2], dateParts[3], dateParts[4], dateParts[5]);
  }

  File get manifest => File('${directory.path}${_pathSeparator}manifest.part.csv');

  String buildClipPath(String fileStem) => '${directory.path}$_pathSeparator$fileStem.m4a';

  Future<void> appendManifestRow(List<String> row) async {
    final isNewFile = !await manifest.exists();
    final sink = manifest.openWrite(mode: FileMode.append);
    if (isNewFile) sink.writeln(formatCsvLine(manifestHeader));
    sink.writeln(formatCsvLine(row));
    await sink.close();
  }

  /// Clips in the order they were recorded (oldest first). File names start with the phone and
  /// ad labels, so sorting by name would group by ad instead — sort by the recording time and
  /// take number written at the end of each name (…_YYYYMMDDTHHMMSS_tN.m4a).
  Future<List<File>> listClipFiles() async {
    if (!await directory.exists()) return [];
    final clipFiles = await directory
        .list()
        .where((entity) => entity is File && entity.path.endsWith('.m4a'))
        .cast<File>()
        .toList();
    clipFiles.sort((first, second) => _recordingOrderKey(first).compareTo(_recordingOrderKey(second)));
    return clipFiles;
  }

  static final _recordedAtAndTakePattern = RegExp(r'_(\d{8}T\d{6})_t(\d+)\.m4a$');

  static String _recordingOrderKey(File clipFile) {
    final match = _recordedAtAndTakePattern.firstMatch(clipFile.path);
    return match == null ? '0_${clipFile.path}' : '${match.group(1)}_${match.group(2)!.padLeft(3, '0')}';
  }

  /// The manifest's column names, with names from before the rename mapped to the current ones.
  static List<String> _readManifestHeader(String headerLine) =>
      [for (final column in parseCsvLine(headerLine)) legacyManifestColumnNames[column] ?? column];

  /// Clips that exist on disk, newest first, with the labels from the manifest.
  Future<List<LabelledClip>> listLabelledClips() async {
    final manifestRowsByPath = <String, Map<String, String>>{};
    if (await manifest.exists()) {
      final lines = (await manifest.readAsLines()).where((line) => line.trim().isNotEmpty).toList();
      if (lines.isNotEmpty) {
        final header = _readManifestHeader(lines.first);
        for (final line in lines.skip(1)) {
          final cells = parseCsvLine(line);
          final row = {for (var i = 0; i < header.length && i < cells.length; i++) header[i]: cells[i]};
          manifestRowsByPath[row['path'] ?? ''] = row;
        }
      }
    }
    final labelledClips = [
      for (final clipFile in await listClipFiles())
        LabelledClip(clipFile, manifestRowsByPath[clipFile.uri.pathSegments.last] ?? const {}),
    ];
    return labelledClips.reversed.toList();
  }

  /// Delete a clip and its manifest row, so the two never disagree.
  Future<void> deleteClip(File clipFile) async {
    final fileName = clipFile.uri.pathSegments.last;
    if (await clipFile.exists()) await clipFile.delete();
    if (!await manifest.exists()) return;
    final lines = (await manifest.readAsLines()).where((line) => line.trim().isNotEmpty).toList();
    if (lines.isEmpty) return;
    final pathColumnIndex = _readManifestHeader(lines.first).indexOf('path');
    final keptLines = [
      lines.first,
      for (final line in lines.skip(1))
        if (pathColumnIndex < 0 || parseCsvLine(line).elementAtOrNull(pathColumnIndex) != fileName) line,
    ];
    await manifest.writeAsString('${keptLines.join('\n')}\n');
  }
}

/// A saved clip plus the labels written for it in the manifest.
class LabelledClip {
  const LabelledClip(this.file, this.manifestRow);

  final File file;
  final Map<String, String> manifestRow;

  bool get isNegative => manifestRow['role'] == 'negative';
  String get title {
    final adLabel =
        isNegative ? 'Not an ad' : ((manifestRow['ad_id'] ?? '').isEmpty ? 'Unlabelled' : manifestRow['ad_id']!);
    final clipSeconds = manifestRow['clip_seconds'];
    return clipSeconds == null || clipSeconds.isEmpty ? adLabel : '$adLabel · $clipSeconds s';
  }

  String get details {
    final sizeKilobytes = file.existsSync() ? (file.lengthSync() / 1024).toStringAsFixed(1) : '?';
    return [manifestRow['scene'], manifestRow['microphone_settings'], '$sizeKilobytes KB']
        .where((part) => part != null && part.isNotEmpty)
        .join(' · ');
  }
}

/// Minimal CSV line parser for the files this app writes (handles quoted cells).
List<String> parseCsvLine(String line) {
  final cells = <String>[];
  final currentCell = StringBuffer();
  var isInsideQuotes = false;
  for (var i = 0; i < line.length; i++) {
    final character = line[i];
    if (isInsideQuotes) {
      if (character == '"' && i + 1 < line.length && line[i + 1] == '"') {
        currentCell.write('"');
        i++;
      } else if (character == '"') {
        isInsideQuotes = false;
      } else {
        currentCell.write(character);
      }
    } else if (character == '"') {
      isInsideQuotes = true;
    } else if (character == ',') {
      cells.add(currentCell.toString());
      currentCell.clear();
    } else {
      currentCell.write(character);
    }
  }
  cells.add(currentCell.toString());
  return cells;
}
