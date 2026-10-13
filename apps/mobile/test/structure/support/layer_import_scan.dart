import 'dart_source_file.dart';
import 'dart_source_tree.dart';

/// The import rules of design §3.2 (S4-D2, S4-STRUCTURE-03), checked over a tree of `lib/` files.
///
/// - `presentation` never imports Dio, the local store, the recorder, the permission or launcher
///   packages, `path_provider` or `dart:io`. It may import a feature's `data/` file only to use a
///   provider or a repository: the identify feature keeps those in `*_provider.dart` and
///   `*_repository.dart` files, and the result feature keeps each provider in its adapter file, so
///   from such an adapter file presentation may name only its `…Provider` and `…Repository` names.
///   It never imports another feature's screen (`*_screen.dart`): the screens of two features are
///   composed only in `lib/app` (P6 design §3.2).
/// - `domain` imports only `dart:core`, `dart:convert`, `dart:math`, `package:meta` and other
///   `domain/` files.
/// - `data` never imports `presentation/` (nor `app/`, the composition root above it), nor another
///   feature's `data/`: where one feature's data must reach another's, the first declares an
///   interface in its domain and `lib/app` implements it (P6 design §3.2).
/// - `core/` imports no feature: the outbox and the other shared parts take each feature's part
///   from `lib/app`, which wires them (P6 design §3.1, P6-D4).
final class LayerImportScan {
  LayerImportScan._(this.filesByLayer, this.directiveCount, this.violations);

  /// Checks every file under `features/<feature>/<layer>/` in [tree].
  factory LayerImportScan.of(DartSourceTree tree) {
    final filesByLayer = {for (final layer in CodeLayer.values) layer: 0};
    var directiveCount = 0;
    final violations = <String>[];
    for (final file in tree.files) {
      if (file.path.startsWith('core/')) {
        for (final directive in file.directives) {
          if (directive.keyword == 'part') continue;
          directiveCount++;
          final libraryPath = _libraryPathOf(file.path, directive.uri);
          if (libraryPath != null && libraryPath.startsWith('features/')) {
            violations.add(
              '${file.path}:${directive.lineNumber} ${directive.uri}: core must never import a '
              'feature; lib/app wires the features into it (P6 design §3.1, P6-D4)',
            );
          }
        }
        continue;
      }
      final layer = layerOf(file.path);
      if (layer == null) continue;
      filesByLayer[layer] = filesByLayer[layer]! + 1;
      for (final directive in file.directives) {
        if (directive.keyword == 'part') continue;
        directiveCount++;
        final problem = _problemWith(tree, file, layer, directive);
        if (problem != null) {
          violations.add('${file.path}:${directive.lineNumber} ${directive.uri}: $problem');
        }
      }
    }
    return LayerImportScan._(Map.unmodifiable(filesByLayer), directiveCount, violations);
  }

  /// How many files of each layer were read.
  final Map<CodeLayer, int> filesByLayer;

  /// How many `import` and `export` directives were checked.
  final int directiveCount;

  /// One line per broken rule: the file, the line, the import and the rule.
  final List<String> violations;

  /// The packages presentation must reach only through a feature's data layer (§3.2; P6 design
  /// §3.2: the device plugin and WorkManager too).
  static const Set<String> packagesPresentationMustNotImport = {
    'dio',
    'shared_preferences',
    'record',
    'permission_handler',
    'url_launcher',
    'path_provider',
    'device_services',
    'workmanager',
  };

  /// The libraries domain may import besides other domain files (§3.2).
  static const Set<String> librariesDomainMayImport = {'dart:core', 'dart:convert', 'dart:math'};

  /// The layer of a `lib/` path such as `features/identify/data/clip_recorder.dart`.
  static CodeLayer? layerOf(String libraryPath) {
    final segments = libraryPath.split('/');
    if (segments.length < 4 || segments.first != 'features') return null;
    for (final layer in CodeLayer.values) {
      if (segments[2] == layer.name) return layer;
    }
    return null;
  }

  static String? _problemWith(
    DartSourceTree tree,
    DartSourceFile file,
    CodeLayer layer,
    DartDirective directive,
  ) {
    final uri = directive.uri;
    final libraryPath = _libraryPathOf(file.path, uri);
    final targetLayer = libraryPath == null ? null : layerOf(libraryPath);
    switch (layer) {
      case CodeLayer.presentation:
        if (uri == 'dart:io') return 'presentation must not use dart:io (§3.2)';
        final packageName = _packageNameOf(uri);
        if (packagesPresentationMustNotImport.contains(packageName)) {
          return 'presentation must not use package:$packageName; go through a repository or '
              'provider in data/ (§3.2)';
        }
        if (libraryPath != null && targetLayer == CodeLayer.data) {
          return _problemWithDataImport(tree, file, directive, libraryPath);
        }
        if (libraryPath != null &&
            targetLayer == CodeLayer.presentation &&
            _featureOf(libraryPath) != _featureOf(file.path) &&
            libraryPath.endsWith('_screen.dart')) {
          return "presentation never imports another feature's screen; screens of two features "
              'are composed only in lib/app (P6 design §3.2)';
        }
        return null;
      case CodeLayer.domain:
        if (librariesDomainMayImport.contains(uri) || uri.startsWith('package:meta/')) return null;
        if (libraryPath != null && targetLayer == CodeLayer.domain) return null;
        return 'domain may import only dart:core, dart:convert, dart:math, package:meta and other '
            'domain files (§3.2)';
      case CodeLayer.data:
        if (libraryPath != null &&
            (targetLayer == CodeLayer.presentation || libraryPath.startsWith('app/'))) {
          return 'data must never import presentation (§3.2)';
        }
        if (libraryPath != null &&
            targetLayer == CodeLayer.data &&
            _featureOf(libraryPath) != _featureOf(file.path)) {
          return "a feature's data never imports another feature's data; declare an interface in "
              'its domain for lib/app to implement (P6 design §3.2)';
        }
        return null;
    }
  }

  static String? _problemWithDataImport(
    DartSourceTree tree,
    DartSourceFile importer,
    DartDirective directive,
    String dataPath,
  ) {
    final dataFileName = dataPath.split('/').last;
    if (dataFileName.endsWith('_provider.dart') || dataFileName.endsWith('_repository.dart')) {
      return null;
    }
    final dataFile = tree.fileAt(dataPath);
    if (dataFile == null) return 'imports a data file that does not exist';
    final providerNames = dataFile.topLevelNames.where(_isProviderOrRepositoryName);
    if (providerNames.isEmpty) {
      return 'presentation may import a data file only for its provider or repository, and '
          '$dataFileName declares neither (§3.2)';
    }
    final usedNames = {
      ...directive.shownNames,
      ...dataFile.topLevelNames.where(
        (name) => !name.startsWith('_') && importer.usesIdentifier(name),
      ),
    };
    final otherNames = usedNames.where((name) => !_isProviderOrRepositoryName(name)).toList()
      ..sort();
    if (otherNames.isEmpty) return null;
    return 'presentation may use only the providers and repositories of $dataFileName, but uses '
        '${otherNames.join(', ')} (§3.2)';
  }

  /// The feature of a `features/<feature>/…` path.
  static String _featureOf(String libraryPath) => libraryPath.split('/')[1];

  static bool _isProviderOrRepositoryName(String name) =>
      name.endsWith('Provider') || name.endsWith('Repository');

  static String? _packageNameOf(String uri) {
    if (!uri.startsWith('package:')) return null;
    final slash = uri.indexOf('/');
    return slash < 0 ? uri.substring('package:'.length) : uri.substring('package:'.length, slash);
  }

  /// The `lib/` path an import of this app points at, or null for `dart:` and other packages.
  static String? _libraryPathOf(String importerPath, String uri) {
    const ownPackage = 'package:lookup_listener/';
    if (uri.startsWith(ownPackage)) return uri.substring(ownPackage.length);
    if (uri.startsWith('package:') || uri.startsWith('dart:')) return null;
    final resolved = Uri.parse('file:///lib/$importerPath').resolve(uri).path;
    return resolved.startsWith('/lib/') ? resolved.substring('/lib/'.length) : resolved;
  }
}

/// The three layers every feature has (S4-STRUCTURE-02).
enum CodeLayer { presentation, domain, data }
