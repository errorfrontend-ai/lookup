import 'package:flutter_test/flutter_test.dart';

import '../support/repository_file_locator.dart';
import 'support/feature_folder_scan.dart';
import 'support/temporary_folder_copy.dart';

/// Feature-first folders (design §3.1; S4-STRUCTURE-01, -02, -04; P6 design §3.1): `identify` and
/// `result`, each with exactly `presentation`, `domain` and `data`, and `settings` with its `domain`
/// and `data` (its screens come in piece 2).
void main() {
  final libraryFolder = RepositoryFileLocator.mobileAppFolder('lib');

  test('lib/features holds exactly identify, result and settings, each with its layers', () {
    final scan = FeatureFolderScan.of(libraryFolder);

    expect(scan.featureNames, FeatureFolderScan.expectedFeatures);
    expect(scan.dartFileCountsByLayerFolder.keys.toSet(), {
      'identify/presentation',
      'identify/domain',
      'identify/data',
      'result/presentation',
      'result/domain',
      'result/data',
      'settings/domain',
      'settings/data',
    });
    for (final entry in scan.dartFileCountsByLayerFolder.entries) {
      expect(entry.value, greaterThan(0), reason: '${entry.key} holds no Dart file');
    }
    expect(scan.violations, isEmpty);
  });

  group('the folder scan fails on a copy of lib/ with', () {
    late TemporaryFolderCopy copy;

    setUp(() => copy = TemporaryFolderCopy.of(libraryFolder));
    tearDown(() => copy.delete());

    test('a fourth feature', () {
      copy.writeFile('features/history/presentation/history_screen.dart', 'class HistoryScreen {}');

      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains(startsWith('lib/features/history:')),
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
      copy.deleteFolder('features/settings/data');

      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains('lib/features/settings/data/ is missing (S4-STRUCTURE-02)'),
      );
    });

    test('settings screens before piece 2 adds them to the rule', () {
      copy.writeFile(
        'features/settings/presentation/settings_screen.dart',
        'class SettingsScreen {}',
      );

      expect(
        FeatureFolderScan.of(copy.folder).violations,
        contains(startsWith('lib/features/settings/presentation:')),
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
