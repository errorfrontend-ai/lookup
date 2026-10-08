import 'dart:convert';
import 'dart:io';

/// One fixture file from a folder: its name without `.json`, and its decoded JSON.
final class NamedFixture {
  const NamedFixture(this.name, this.content);

  final String name;
  final Object? content;
}

/// Reads the shared fixtures in `packages/contracts/fixtures` at test time, so the app is tested
/// against the same files as the TypeScript contracts and never against a copy (S4-TESTS-03).
///
/// The folder is found from this file's own location, not the working directory: `flutter test` can
/// be started from anywhere, and `Platform.script` points at a generated entry file instead.
abstract final class ContractFixtures {
  /// `packages/contracts/fixtures`, four folders up from `apps/mobile/test/support`.
  static final Directory directory = _findDirectory();

  /// The decoded JSON of one file, e.g. `action-card/action-uris.json`.
  static Object? readFile(String relativePath) => jsonDecode(readText(relativePath));

  /// One file as written, for checks on the text itself (`1.0` must stay `1.0` in the file).
  static String readText(String relativePath) => _file(relativePath).readAsStringSync();

  /// Every `.json` file in a folder, sorted by name, e.g. `action-card/reader`.
  static List<NamedFixture> readFolder(String relativeFolder) {
    final folder = Directory.fromUri(directory.uri.resolve('$relativeFolder/'));
    if (!folder.existsSync()) throw StateError('No fixture folder at ${folder.path}.');
    final files =
        folder.listSync().whereType<File>().where((file) => file.path.endsWith('.json')).toList()
          ..sort((first, second) => first.path.compareTo(second.path));
    return [
      for (final file in files)
        NamedFixture(
          file.uri.pathSegments.last.replaceFirst(RegExp(r'\.json$'), ''),
          jsonDecode(file.readAsStringSync()),
        ),
    ];
  }

  static File _file(String relativePath) {
    final file = File.fromUri(directory.uri.resolve(relativePath));
    if (!file.existsSync()) throw StateError('No fixture file at ${file.path}.');
    return file;
  }

  /// This file's own address comes from the stack trace, the one place `flutter test` gives it.
  static Directory _findDirectory() {
    final ownAddress = RegExp(
      r'file:///[^\s)]*?/test/support/contract_fixtures\.dart',
    ).firstMatch(StackTrace.current.toString());
    if (ownAddress == null) {
      throw StateError('Could not find test/support/contract_fixtures.dart from the stack trace.');
    }
    final fixturesDirectory = Directory.fromUri(
      Uri.parse(ownAddress.group(0)!).resolve('../../../../packages/contracts/fixtures/'),
    );
    if (!fixturesDirectory.existsSync()) {
      throw StateError('No contract fixtures at ${fixturesDirectory.path}.');
    }
    return fixturesDirectory;
  }
}
