import 'dart:io';

import 'dart_source_file.dart';

/// Every Dart file under one folder, read as text (design §4.5). The scans take a tree rather than a
/// path, so the same scan runs on the app's `lib/` and on a temporary copy with a planted
/// violation.
final class DartSourceTree {
  DartSourceTree._(this.rootFolder, this.files);

  /// Reads every `.dart` file under [rootFolder], sorted by path.
  factory DartSourceTree.read(Directory rootFolder) {
    final rootPath = _withForwardSlashes(rootFolder.absolute.path);
    final files = <DartSourceFile>[
      for (final entity in rootFolder.listSync(recursive: true, followLinks: false))
        if (entity is File && entity.path.endsWith('.dart'))
          DartSourceFile.parse(
            _withForwardSlashes(entity.absolute.path).substring(rootPath.length + 1),
            entity.readAsStringSync(),
          ),
    ]..sort((first, second) => first.path.compareTo(second.path));
    return DartSourceTree._(rootFolder, List.unmodifiable(files));
  }

  /// The folder that was read.
  final Directory rootFolder;

  /// The files, with paths relative to [rootFolder].
  final List<DartSourceFile> files;

  late final Map<String, DartSourceFile> _filesByPath = {for (final file in files) file.path: file};

  /// The file at [path] (relative to [rootFolder]), or null when there is none.
  DartSourceFile? fileAt(String path) => _filesByPath[path];

  static String _withForwardSlashes(String path) {
    final forward = path.replaceAll(r'\', '/');
    return forward.endsWith('/') ? forward.substring(0, forward.length - 1) : forward;
  }
}
