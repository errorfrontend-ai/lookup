import 'dart:io';

/// Finds files of the Look Up repository from a test, so tests read the shared fixtures, schemas and
/// tokens where they live, never copies (S4-TESTS-03).
///
/// `flutter test` runs with apps/mobile as the current folder, and Flutter gives a test no reliable
/// path to its own file, so the search starts there and walks up to the folder that holds both
/// apps/mobile and packages/contracts. It therefore also works when the tests are started from
/// another folder inside the repository.
abstract final class RepositoryFileLocator {
  /// The repository's top folder.
  static Directory get repositoryFolder {
    var folder = Directory.current.absolute;
    while (true) {
      if (_isRepositoryFolder(folder)) return folder;
      final parent = folder.parent;
      if (parent.path == folder.path) {
        throw StateError(
          'No Look Up repository above ${Directory.current.path}: run the tests from apps/mobile.',
        );
      }
      folder = parent;
    }
  }

  /// A file by its path from the repository's top folder, e.g.
  /// `packages/contracts/fixtures/errors/reference-codes.json`. Fails the test at once when the file
  /// is missing, so a moved fixture can never make a test pass by testing nothing.
  static File file(String pathFromRepositoryFolder) {
    final file = File.fromUri(repositoryFolder.uri.resolve(pathFromRepositoryFolder));
    if (!file.existsSync()) {
      throw StateError('Missing repository file: $pathFromRepositoryFolder');
    }
    return file;
  }

  /// A file by its path from apps/mobile, e.g. `pubspec.yaml`.
  static File mobileAppFile(String pathFromMobileApp) => file('apps/mobile/$pathFromMobileApp');

  /// A folder by its path from apps/mobile, e.g. `config`.
  static Directory mobileAppFolder(String pathFromMobileApp) {
    final folder = Directory.fromUri(
      repositoryFolder.uri.resolve('apps/mobile/$pathFromMobileApp/'),
    );
    if (!folder.existsSync()) {
      throw StateError('Missing repository folder: apps/mobile/$pathFromMobileApp');
    }
    return folder;
  }

  static bool _isRepositoryFolder(Directory folder) =>
      File.fromUri(folder.uri.resolve('apps/mobile/pubspec.yaml')).existsSync() &&
      Directory.fromUri(folder.uri.resolve('packages/contracts/')).existsSync();
}
