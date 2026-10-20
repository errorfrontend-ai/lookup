import 'package:flutter_test/flutter_test.dart';

import '../support/repository_file_locator.dart';
import 'support/feature_folder_scan.dart';
import 'support/temporary_folder_copy.dart';

/// Feature-first folders (design §3.1; S4-STRUCTURE-01, -02, -04; P6 design §3.1, P6-STRUCTURE-01):
/// `identify`, `result`, `history`, `settings` and, from the listener accounts (ADR-005), `account`, each with
/// exactly `presentation`, `domain` and `data`.
void main() {
  final libraryFolder = RepositoryFileLocator.mobileAppFolder('lib');

  test(
    'lib/features holds exactly account, identify, result, history and settings, each with its three layers (P6-STRUCTURE-01)',
    () {
      final scan = FeatureFolderScan.of(libraryFolder);

      expect(scan.featureNames, FeatureFolderScan.expectedFeatures);
      expect(scan.featureNames, containsAll(['account', 'history', 'settings']));
      expect(scan.dartFileCountsByLayerFolder.keys.toSet(), {
        'account/presentation',
        'account/domain',
        'account/data',
        'history/presentation',
        'history/domain',
        'history/data',
        'identify/presentation',
        'identify/domain',
        'identify/data',
        'result/presentation',
        'result/domain',
        'result/data',
        'settings/presentation',
        'settings/domain',
        'settings/data',
      });
      for (final entry in scan.dartFileCountsByLayerFolder.entries) {
        expect(entry.value, greaterThan(0), reason: '${entry.key} holds no Dart file');
      }
      expect(scan.violations, isEmpty);
    },
  );

  group('the folder scan fails on a copy of lib/ with', () {
    late TemporaryFolderCopy copy;

    setUp(() => copy = TemporaryFolderCopy.of(libraryFolder));
    tearDown(() => copy.delete());

    test('a fifth feature', () {
      copy.writeFile('features/library/presentation/library_screen.dart', 'class LibraryScreen {}');

      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains(startsWith('lib/features/library:')),
      );
    });

    test('a fourth folder inside a feature', () {
      copy.writeFile('features/identify/widgets/level_ring.dart', 'class LevelRing {}');

      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains(startsWith('lib/features/identify/widgets:')),
      );
    });

    test('a loose file inside a feature', () {
      copy.writeFile('features/result/result_helpers.dart', 'class ResultHelpers {}');

      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains(startsWith('lib/features/result/result_helpers.dart:')),
      );
    });

    test('a missing layer', () {
      copy.deleteFolder('features/result/data');

      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains('lib/features/result/data/ is missing (S4-STRUCTURE-02)'),
      );
    });

    test('a missing feature', () {
      copy.deleteFolder('features/identify');

      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains('lib/features/identify/ is missing (S4-STRUCTURE-04)'),
      );
    });

    test('a missing settings layer', () {
      copy.deleteFolder('features/settings/presentation');

      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains('lib/features/settings/presentation/ is missing (S4-STRUCTURE-02)'),
      );
    });

    test('a missing history layer, or no history feature at all (P6-STRUCTURE-01)', () {
      copy.deleteFolder('features/history/domain');
      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains('lib/features/history/domain/ is missing (S4-STRUCTURE-02)'),
      );

      copy.deleteFolder('features/history');
      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains('lib/features/history/ is missing (S4-STRUCTURE-04)'),
      );
    });

    test('an empty layer', () {
      copy
        ..deleteFolder('features/result/domain')
        ..createFolder('features/result/domain');

      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains('lib/features/result/domain/ holds no Dart file'),
      );
    });

    test('a folder at the top of lib/ besides app, core, features and l10n', () {
      copy.writeFile('utils/string_helpers.dart', 'class StringHelpers {}');

      expect(FeatureFolderScan.of(copy.folder).violations, contains(startsWith('lib/utils:')));
      expect(
        FeatureFolderScan.of(
          copy.folder,
        ).violations.where((violation) => violation.startsWith('lib/l10n')),
        isEmpty,
      );
    });
  });
}
