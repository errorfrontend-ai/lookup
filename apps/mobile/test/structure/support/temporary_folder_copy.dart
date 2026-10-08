import 'dart:io';

/// A throw-away copy of a folder of the app, in the system's temporary folder, so a test can plant a
/// violation and prove a scan finds it without ever touching `lib/` (design §4.5).
final class TemporaryFolderCopy {
  TemporaryFolderCopy._(this.folder);

  /// Copies everything under [source] into a new temporary folder.
  factory TemporaryFolderCopy.of(Directory source) {
    final folder = Directory.systemTemp.createTempSync('lookup_structure_');
    _copyFolder(source, folder);
    return TemporaryFolderCopy._(folder);
  }

  /// The copy.
  final Directory folder;

  /// Writes [contents] to [pathInCopy] (a `/`-separated path), creating folders as needed.
  void writeFile(String pathInCopy, String contents) {
    File.fromUri(folder.uri.resolve(pathInCopy))
      ..parent.createSync(recursive: true)
      ..writeAsStringSync(contents);
  }

  /// Creates the folder [pathInCopy] (a `/`-separated path).
  void createFolder(String pathInCopy) {
    Directory.fromUri(folder.uri.resolve(pathInCopy)).createSync(recursive: true);
  }

  /// Deletes the folder [pathInCopy] and everything in it.
  void deleteFolder(String pathInCopy) {
    Directory.fromUri(folder.uri.resolve(pathInCopy)).deleteSync(recursive: true);
  }

  /// Removes the copy.
  void delete() {
    if (folder.existsSync()) folder.deleteSync(recursive: true);
  }

  static void _copyFolder(Directory source, Directory destination) {
    for (final entity in source.listSync(followLinks: false)) {
      final name = entity.path.split(RegExp(r'[\\/]')).last;
      final copyPath = '${destination.path}${Platform.pathSeparator}$name';
      if (entity is Directory) {
        _copyFolder(entity, Directory(copyPath)..createSync());
      } else if (entity is File) {
        entity.copySync(copyPath);
      }
    }
  }
}
