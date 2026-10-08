import 'package:flutter_test/flutter_test.dart';

import '../support/repository_file_locator.dart';
import 'support/dart_source_tree.dart';
import 'support/file_and_type_name_scan.dart';
import 'support/naming_rules.dart';
import 'support/temporary_folder_copy.dart';

/// File and type names (docs/conventions.md; design §3.1, §4.5; S4-NAMING-01, -04): whole words,
/// and each file named after its one main type.
void main() {
  final libraryFolder = RepositoryFileLocator.mobileAppFolder('lib');

  test('lib/ file and type names are whole words, each file named after its main type', () {
    final scan = FileAndTypeNameScan.of(
      DartSourceTree.read(libraryFolder),
      checksMainType: true,
      mainTypeExemptPaths: _mainTypeExemptPaths,
    );

    expect(scan.fileCount, greaterThanOrEqualTo(40));
    expect(scan.typeCount, greaterThanOrEqualTo(40));
    expect(scan.mainTypeFileCount, greaterThanOrEqualTo(30));
    expect(scan.violations, isEmpty);
  });

  test('test/ file and type names are whole words', () {
    final scan = FileAndTypeNameScan.of(
      DartSourceTree.read(RepositoryFileLocator.mobileAppFolder('test')),
      checksMainType: false,
    );

    expect(scan.fileCount, greaterThanOrEqualTo(30));
    expect(scan.typeCount, greaterThan(0));
    expect(scan.violations, isEmpty);
  });

  test('words are split the way the rules read them', () {
    expect(NamingRules.wordsOf('HTTPRequestId'), ['http', 'request', 'id']);
    expect(NamingRules.wordsOf('clip_recorder_provider'), ['clip', 'recorder', 'provider']);
    expect(NamingRules.wordsOf('retryDelaySeconds'), ['retry', 'delay', 'seconds']);
    expect(NamingRules.bannedShortWordsIn('errMsg'), ['err', 'msg']);
    expect(NamingRules.bannedShortWordsIn('error'), isEmpty);
    expect(NamingRules.bannedShortWordsIn('bitRate'), isEmpty);
    expect(NamingRules.typeNameForFile('look_up_tokens.dart'), 'LookUpTokens');
  });

  group('the name scan fails on a copy of lib/ with', () {
    late TemporaryFolderCopy copy;
    late FileAndTypeNameScan scan;

    setUpAll(() {
      copy = TemporaryFolderCopy.of(libraryFolder)
        ..writeFile('core/planted_cfg_reader.dart', 'final class PlantedCfgReader {}\n')
        ..writeFile('core/planted_holder.dart', 'final class SomethingElse {}\n')
        ..writeFile('core/planted_private_only.dart', 'final class _PlantedHidden {}\n');
      scan = FileAndTypeNameScan.of(
        DartSourceTree.read(copy.folder),
        checksMainType: true,
        mainTypeExemptPaths: _mainTypeExemptPaths,
      );
    });
    tearDownAll(() => copy.delete());

    test('an abbreviation in a file name', () {
      expect(scan.violations, contains(startsWith('core/planted_cfg_reader.dart: the file name')));
    });

    test('an abbreviation in a type name', () {
      expect(scan.violations, contains(startsWith('core/planted_cfg_reader.dart:1 PlantedCfg')));
    });

    test('a file whose type is not named after it', () {
      expect(scan.violations, contains(startsWith('core/planted_holder.dart: declares')));
    });

    test('but not a file with only private types', () {
      expect(
        scan.violations.where((violation) => violation.contains('planted_private_only')),
        isEmpty,
      );
    });
  });
}

/// `main.dart` holds the entry point, not a type.
const Set<String> _mainTypeExemptPaths = {'main.dart'};
