import 'dart:convert';
import 'dart:io';

import 'package:lookup_listener/features/settings/domain/station_list.dart';

/// The station list kept on the phone (P6 design §3.13, §3.22): `station-list.json` in the
/// `stations` folder of the app's support folder, app-private and never backed up, holding the
/// stations exactly as `GET /api/v1/stations` gave them, when they were fetched, and the answer's
/// entity tag for `If-None-Match`.
///
/// ```json
/// {"format_version": 1, "fetched_at": "2026-10-13T07:12:00.000Z", "entity_tag": "\"abc\"",
///  "stations": [{"id": "…", "name": "Station A", "frequency_label": "98.1 FM", "city": "Lusaka",
///                "logo": null}]}
/// ```
///
/// - A write goes to `station-list.json.writing`, is flushed, then renamed over the file, so a power
///   cut leaves the old list or the new one, never half of one. Only the foreground engine ever
///   fetches the list, so no lock file is needed (§3.12).
/// - What is read back is checked by the same rules as an answer ([StationList.read]); a file that
///   fails them, or is not this format, reads as no list and is deleted, so the next open fetches.
/// - Synchronous file calls: the file is a few kilobytes at most.
final class StationListCache {
  /// [locateFolder] gives the cache's folder (the app's support folder plus `stations`; tests give
  /// a temporary one).
  StationListCache({required Future<Directory> Function() locateFolder})
    : _locateFolder = locateFolder;

  /// The cache's folder inside [appSupportFolder] (`getApplicationSupportDirectory()`).
  static Directory folderIn(Directory appSupportFolder) =>
      Directory('${appSupportFolder.path}/$folderName');

  /// The cache's folder name.
  static const String folderName = 'stations';

  /// The file's name in that folder.
  static const String fileName = 'station-list.json';

  /// The format this version writes and reads.
  static const int formatVersion = 1;

  final Future<Directory> Function() _locateFolder;

  /// The list kept on the phone, or null when there is none, or none this version can read.
  Future<CachedStationList?> read() async {
    final file = File('${(await _locateFolder()).path}/$fileName');
    final String text;
    try {
      text = file.readAsStringSync();
    } on PathNotFoundException {
      return null;
    }
    final cached = _readCached(text);
    if (cached == null) _deleteQuietly(file);
    return cached;
  }

  /// Keeps [stations] (the answer's `stations`, exactly as received) as fetched at [fetchedAt],
  /// with the answer's [entityTag] when it had one. Throws the file system's own exception when the
  /// folder cannot be written.
  Future<void> write({
    required Object? stations,
    required DateTime fetchedAt,
    String? entityTag,
  }) async {
    final folder = await _locateFolder();
    folder.createSync(recursive: true);
    final writing = File('${folder.path}/$fileName.writing');
    writing.writeAsStringSync(
      jsonEncode({
        'format_version': formatVersion,
        'fetched_at': fetchedAt.toUtc().toIso8601String(),
        'entity_tag': entityTag,
        'stations': stations,
      }),
      flush: true,
    );
    writing.renameSync('${folder.path}/$fileName');
  }

  static CachedStationList? _readCached(String text) {
    final Object? json;
    try {
      json = jsonDecode(text);
    } on FormatException {
      return null;
    }
    if (json is! Map<String, Object?> || json['format_version'] != formatVersion) return null;
    final fetchedAtText = json['fetched_at'];
    final entityTag = json['entity_tag'];
    final stations = json['stations'];
    final fetchedAt = fetchedAtText is String ? DateTime.tryParse(fetchedAtText) : null;
    final list = StationList.read({'stations': stations});
    if (fetchedAt == null || list == null || (entityTag != null && entityTag is! String)) {
      return null;
    }
    return CachedStationList(
      list: list,
      stations: stations,
      fetchedAt: fetchedAt.toUtc(),
      entityTag: entityTag as String?,
    );
  }

  static void _deleteQuietly(File file) {
    try {
      file.deleteSync();
    } on FileSystemException {
      // Already gone, or not deletable now: the next write replaces it.
    }
  }
}

/// The station list as the phone keeps it.
final class CachedStationList {
  const CachedStationList({
    required this.list,
    required this.stations,
    required this.fetchedAt,
    this.entityTag,
  });

  /// The stations, read by the answer's rules.
  final StationList list;

  /// The same stations exactly as the answer carried them, written back unchanged when a 304 says
  /// they still hold.
  final Object? stations;

  /// When the API last gave or confirmed them, in UTC.
  final DateTime fetchedAt;

  /// The answer's `ETag`, sent back as `If-None-Match`; null when it had none.
  final String? entityTag;
}
