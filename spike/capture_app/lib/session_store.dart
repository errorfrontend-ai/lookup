import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'capture_settings.dart';

/// One capture session = one folder: the clips plus `manifest.part.csv` (paths relative to
/// the folder). Copy the folder into spike/corpus/ and run `python -m bench.import_captures`.
class SessionStore {
  SessionStore._(this.dir);

  final Directory dir;

  static String get _sep => Platform.pathSeparator;

  /// Android's app-specific external folder
  /// (Android/data/zm.lookup.lookup_capture/files/sessions/…). It survives app restarts;
  /// newer Android hides it from file managers, so the app itself must play and send clips.
  static Future<Directory> _base() async =>
      await getExternalStorageDirectory() ?? await getApplicationDocumentsDirectory();

  static Future<SessionStore> create(DateTime now) async => inDirectory(await _base(), now);

  static Future<SessionStore> inDirectory(Directory base, DateTime now) async {
    final dir = Directory('${base.path}${_sep}sessions${_sep}session_${stamp(now)}');
    await dir.create(recursive: true);
    return SessionStore._(dir);
  }

  /// Every session on the phone, newest first.
  static Future<List<SessionStore>> all() async => listIn(await _base());

  static Future<List<SessionStore>> listIn(Directory base) async {
    final root = Directory('${base.path}${_sep}sessions');
    if (!await root.exists()) return [];
    final dirs = await root
        .list()
        .where((e) => e is Directory && e.uri.pathSegments.where((s) => s.isNotEmpty).last.startsWith('session_'))
        .cast<Directory>()
        .toList();
    dirs.sort((a, b) => b.path.compareTo(a.path));
    return dirs.map(SessionStore._).toList();
  }

  String get name => dir.uri.pathSegments.where((s) => s.isNotEmpty).last;

  /// When the session was started, from its folder name (session_YYYYMMDDTHHMMSS).
  DateTime? get startedAt {
    final m = RegExp(r'(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})').firstMatch(name);
    if (m == null) return null;
    final p = [for (var i = 1; i <= 6; i++) int.parse(m.group(i)!)];
    return DateTime(p[0], p[1], p[2], p[3], p[4], p[5]);
  }

  File get manifest => File('${dir.path}${_sep}manifest.part.csv');

  String pathFor(String stem) => '${dir.path}$_sep$stem.m4a';

  Future<void> addRow(List<String> row) async {
    final isNew = !await manifest.exists();
    final sink = manifest.openWrite(mode: FileMode.append);
    if (isNew) sink.writeln(csvLine(manifestHeader));
    sink.writeln(csvLine(row));
    await sink.close();
  }

  /// Clips in the order they were recorded (oldest first). File names start with the phone and
  /// ad labels, so sorting by name would group by ad instead — sort by the recording time and
  /// take number written at the end of each name (…_YYYYMMDDTHHMMSS_tN.m4a).
  Future<List<File>> clips() async {
    if (!await dir.exists()) return [];
    final files = await dir.list().where((e) => e is File && e.path.endsWith('.m4a')).cast<File>().toList();
    files.sort((a, b) => _recordedKey(a).compareTo(_recordedKey(b)));
    return files;
  }

  static final _recordedAt = RegExp(r'_(\d{8}T\d{6})_t(\d+)\.m4a$');

  static String _recordedKey(File f) {
    final m = _recordedAt.firstMatch(f.path);
    return m == null ? '0_${f.path}' : '${m.group(1)}_${m.group(2)!.padLeft(3, '0')}';
  }

  /// Clips that exist on disk, newest first, with the labels from the manifest.
  Future<List<ClipInfo>> clipInfos() async {
    final rows = <String, Map<String, String>>{};
    if (await manifest.exists()) {
      final lines = (await manifest.readAsLines()).where((l) => l.trim().isNotEmpty).toList();
      if (lines.isNotEmpty) {
        final header = parseCsvLine(lines.first);
        for (final line in lines.skip(1)) {
          final cells = parseCsvLine(line);
          final row = {for (var i = 0; i < header.length && i < cells.length; i++) header[i]: cells[i]};
          rows[row['path'] ?? ''] = row;
        }
      }
    }
    final infos = [
      for (final f in await clips()) ClipInfo(f, rows[f.uri.pathSegments.last] ?? const {}),
    ];
    return infos.reversed.toList();
  }

  /// Delete a clip and its manifest row, so the two never disagree.
  Future<void> deleteClip(File clip) async {
    final fileName = clip.uri.pathSegments.last;
    if (await clip.exists()) await clip.delete();
    if (!await manifest.exists()) return;
    final lines = (await manifest.readAsLines()).where((l) => l.trim().isNotEmpty).toList();
    if (lines.isEmpty) return;
    final header = parseCsvLine(lines.first);
    final pathAt = header.indexOf('path');
    final kept = [
      lines.first,
      for (final line in lines.skip(1))
        if (pathAt < 0 || parseCsvLine(line).elementAtOrNull(pathAt) != fileName) line,
    ];
    await manifest.writeAsString('${kept.join('\n')}\n');
  }
}

/// A saved clip plus the labels written for it in the manifest.
class ClipInfo {
  const ClipInfo(this.file, this.row);

  final File file;
  final Map<String, String> row;

  bool get negative => row['role'] == 'negative';
  String get title {
    final what = negative ? 'Not an ad' : ((row['ad_id'] ?? '').isEmpty ? 'Unlabelled' : row['ad_id']!);
    final secs = row['clip_s'];
    return secs == null || secs.isEmpty ? what : '$what · $secs s';
  }

  String get details {
    final kb = file.existsSync() ? (file.lengthSync() / 1024).toStringAsFixed(1) : '?';
    return [row['scene'], row['mic'], '$kb KB'].where((s) => s != null && s.isNotEmpty).join(' · ');
  }
}

/// Minimal CSV line parser for the files this app writes (handles quoted cells).
List<String> parseCsvLine(String line) {
  final cells = <String>[];
  final cell = StringBuffer();
  var quoted = false;
  for (var i = 0; i < line.length; i++) {
    final c = line[i];
    if (quoted) {
      if (c == '"' && i + 1 < line.length && line[i + 1] == '"') {
        cell.write('"');
        i++;
      } else if (c == '"') {
        quoted = false;
      } else {
        cell.write(c);
      }
    } else if (c == '"') {
      quoted = true;
    } else if (c == ',') {
      cells.add(cell.toString());
      cell.clear();
    } else {
      cell.write(c);
    }
  }
  cells.add(cell.toString());
  return cells;
}
