import 'dart:io';

/// The folder rules of design §3.1 (S4-STRUCTURE-01, -02, -04), checked over a `lib/` folder:
/// `features/` holds exactly `identify` and `result`; each holds exactly `presentation`, `domain`
/// and `data` and no loose files; each layer holds Dart code; and `lib/` itself holds only `app/`,
/// `core/`, `features/`, `l10n/` (the language files, P6 design §3.1, §3.17) and `main.dart`.
final class FeatureFolderScan {
  FeatureFolderScan._(this.featureNames, this.dartFileCountsByLayerFolder, this.violations);

  /// Checks the folders under [libraryFolder].
  factory FeatureFolderScan.of(Directory libraryFolder) {
    final violations = <String>[];
    final dartFileCounts = <String, int>{};

    final topLevel = _children(libraryFolder);
    for (final entry in topLevel.entries) {
      final isAllowedFolder =
          entry.value is Directory && allowedTopLevelFolders.contains(entry.key);
      final isAllowedFile = entry.value is File && allowedTopLevelFiles.contains(entry.key);
      if (!isAllowedFolder && !isAllowedFile) {
        violations.add(
          'lib/${entry.key}: lib/ holds only ${allowedTopLevelFolders.join('/, ')}/ and '
          '${allowedTopLevelFiles.join(', ')} (§3.1)',
        );
      }
    }

    final featuresFolder = topLevel['features'];
    if (featuresFolder is! Directory) {
      violations.add('lib/features/ is missing (S4-STRUCTURE-01)');
      return FeatureFolderScan._(const [], const {}, violations);
    }
    final features = _children(featuresFolder);
    final featureNames = features.keys.toList()..sort();
    for (final expected in expectedFeatures) {
      if (features[expected] is! Directory) {
        violations.add('lib/features/$expected/ is missing (S4-STRUCTURE-04)');
      }
    }
    for (final entry in features.entries) {
      if (!expectedFeatures.contains(entry.key) || entry.value is! Directory) {
        violations.add(
          'lib/features/${entry.key}: Step 4 has only the features '
          '${expectedFeatures.join(' and ')} (S4-STRUCTURE-04)',
        );
        continue;
      }
      final layers = _children(entry.value as Directory);
      for (final layerName in expectedLayers) {
        final layerFolder = layers[layerName];
        if (layerFolder is! Directory) {
          violations.add('lib/features/${entry.key}/$layerName/ is missing (S4-STRUCTURE-02)');
          continue;
        }
        final dartFileCount = layerFolder
            .listSync(recursive: true)
            .whereType<File>()
            .where((file) => file.path.endsWith('.dart'))
            .length;
        dartFileCounts['${entry.key}/$layerName'] = dartFileCount;
        if (dartFileCount == 0) {
          violations.add('lib/features/${entry.key}/$layerName/ holds no Dart file');
        }
      }
      for (final layerName in layers.keys) {
        if (!expectedLayers.contains(layerName) || layers[layerName] is! Directory) {
          violations.add(
            'lib/features/${entry.key}/$layerName: a feature holds exactly '
            '${expectedLayers.join(', ')} (S4-STRUCTURE-02)',
          );
        }
      }
    }
    return FeatureFolderScan._(featureNames, dartFileCounts, violations);
  }

  /// The features Step 4 has (S4-STRUCTURE-04).
  static const List<String> expectedFeatures = ['identify', 'result'];

  /// The layers every feature has (S4-STRUCTURE-02).
  static const List<String> expectedLayers = ['presentation', 'domain', 'data'];

  /// What `lib/` may hold at its top (§3.1; `l10n` from the P6 design's §3.1).
  static const List<String> allowedTopLevelFolders = ['app', 'core', 'features', 'l10n'];
  static const List<String> allowedTopLevelFiles = ['main.dart'];

  /// The folders found under `lib/features/`.
  final List<String> featureNames;

  /// How many Dart files each `feature/layer` folder holds.
  final Map<String, int> dartFileCountsByLayerFolder;

  /// One line per broken rule.
  final List<String> violations;

  static Map<String, FileSystemEntity> _children(Directory folder) => {
    for (final entity in folder.listSync(followLinks: false))
      entity.path.split(RegExp(r'[\\/]')).last: entity,
  };
}
