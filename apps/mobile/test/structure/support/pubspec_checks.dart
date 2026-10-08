import 'dart:convert';
import 'dart:io';

import 'version_constraint.dart';

/// The dependency rules of design §3.3 (S4-D3, S4-D33; S4-STACK-01 to -09; S4-COMPATIBILITY-01),
/// each a function from the files' contents to a list of problems, so a test can run it on the
/// real files and on a planted copy.
abstract final class PubspecChecks {
  /// The runtime dependencies and their exact pins (§3.3). Nothing else may be listed.
  static const Map<String, String> pinnedDependencies = {
    'flutter_riverpod': '3.3.2',
    'go_router': '17.5.0',
    'dio': '5.11.1',
    'record': '6.2.1',
    'url_launcher': '6.3.3',
    'permission_handler': '12.0.3',
    'shared_preferences': '2.5.5',
    'path_provider': '2.1.6',
  };

  /// The development dependencies and their exact pins (§3.3).
  static const Map<String, String> pinnedDevelopmentDependencies = {
    'flutter_lints': '6.0.0',
    'fake_async': '1.3.3',
  };

  /// The SDK packages each section may also list.
  static const Set<String> sdkDependencies = {'flutter'};
  static const Set<String> sdkDevelopmentDependencies = {'flutter_test'};

  /// The Flutter and Dart installed on the build machine, never upgraded for this app (S4-STACK-01).
  static const SemanticVersion installedFlutter = SemanticVersion(3, 41, 9);
  static const SemanticVersion installedDart = SemanticVersion(3, 11, 5);

  /// Packages that need Google Play services, or are BLoC (§3.3; ALL rules; S4-COMPATIBILITY-01).
  static final RegExp forbiddenPackageName = RegExp(
    r'^(?:bloc|flutter_bloc|hydrated_bloc|firebase_\w*|cloud_firestore|google_mobile_ads|'
    r'google_sign_in\w*|google_maps_flutter\w*|google_api_availability\w*|geolocator\w*|'
    r'location|in_app_review|in_app_update|play_integrity\w*|\w*play_install_referrer\w*|'
    r'huawei_\w*)$',
  );

  /// Text in a plugin's Android build files that means it pulls in Google Play services.
  static final RegExp playServicesReference = RegExp(
    r'com\.google\.android\.gms|com\.google\.firebase|play-services|com\.google\.android\.play',
  );

  /// The exact pins, and nothing listed besides them (S4-STACK-02 to -08).
  static List<String> problemsWithPins(Map<String, Object?> pubspec) => [
    ..._problemsWithSection(pubspec, 'dependencies', pinnedDependencies, sdkDependencies),
    ..._problemsWithSection(
      pubspec,
      'dev_dependencies',
      pinnedDevelopmentDependencies,
      sdkDevelopmentDependencies,
    ),
    if (pubspec.containsKey('dependency_overrides'))
      'pubspec.yaml has dependency_overrides; pub get must succeed without one (S4-STACK-09)',
  ];

  /// The lock file resolved every pin to exactly its version, as a direct dependency.
  static List<String> problemsWithLock(Map<String, Object?> lock) {
    final packages = lock['packages'];
    if (packages is! Map<String, Object?>) return ['pubspec.lock has no packages section'];
    final problems = <String>[];
    final expected = {
      for (final entry in pinnedDependencies.entries) entry.key: (entry.value, 'direct main'),
      for (final entry in pinnedDevelopmentDependencies.entries)
        entry.key: (entry.value, 'direct dev'),
    };
    for (final entry in expected.entries) {
      final package = packages[entry.key];
      if (package is! Map<String, Object?>) {
        problems.add('pubspec.lock does not hold ${entry.key}');
        continue;
      }
      if (package['version'] != entry.value.$1) {
        problems.add(
          'pubspec.lock resolved ${entry.key} to ${package['version']}, not ${entry.value.$1}',
        );
      }
      if (package['dependency'] != entry.value.$2) {
        problems.add('pubspec.lock lists ${entry.key} as ${package['dependency']}');
      }
    }
    return problems;
  }

  /// The pubspec's and the lock file's Flutter and Dart constraints admit the installed 3.41.9 and
  /// 3.11.5, so no dependency needs a newer toolchain (S4-STACK-01, S4-D33).
  static List<String> problemsWithSdkConstraints(
    Map<String, Object?> pubspec,
    Map<String, Object?> lock,
  ) {
    final problems = <String>[];
    void check(Object? section, String fileName) {
      if (section is! Map<String, Object?>) {
        problems.add('$fileName has no SDK constraints');
        return;
      }
      for (final (name, installed) in [('flutter', installedFlutter), ('dart', installedDart)]) {
        final key = fileName == 'pubspec.yaml' && name == 'dart' ? 'sdk' : name;
        final constraintText = section[key];
        if (constraintText is! String) {
          problems.add('$fileName has no $name constraint');
        } else if (!VersionConstraint.parse(constraintText).allows(installed)) {
          problems.add('$fileName: the $name constraint $constraintText does not admit $installed');
        }
      }
    }

    check(pubspec['environment'], 'pubspec.yaml');
    check(lock['sdks'], 'pubspec.lock');
    return problems;
  }

  /// No BLoC and no package that needs Google Play services, listed or resolved.
  static List<String> problemsWithForbiddenPackages(
    Map<String, Object?> pubspec,
    Map<String, Object?> lock,
  ) {
    final names = <String>{
      for (final section in ['dependencies', 'dev_dependencies', 'dependency_overrides'])
        if (pubspec[section] is Map<String, Object?>)
          ...(pubspec[section]! as Map<String, Object?>).keys,
      if (lock['packages'] is Map<String, Object?>)
        ...(lock['packages']! as Map<String, Object?>).keys,
    };
    return [
      for (final name in names.toList()..sort())
        if (forbiddenPackageName.hasMatch(name))
          '$name is a BLoC or Google Play services package (§3.3, S4-COMPATIBILITY-01)',
    ];
  }

  /// No font files: the system font only (§3.18, S4-THEME-04).
  static List<String> problemsWithFonts(Map<String, Object?> pubspec, String pubspecText) => [
    if (pubspec['flutter'] is Map<String, Object?> &&
        (pubspec['flutter']! as Map<String, Object?>).containsKey('fonts'))
      'pubspec.yaml declares fonts; the app uses the system font (§3.18)',
    if (RegExp(r'\.(?:ttf|otf|woff2?)\b', caseSensitive: false).hasMatch(pubspecText))
      'pubspec.yaml names a font file (§3.18)',
  ];

  /// Reads the Android plugins Flutter lists in `.flutter-plugins-dependencies` and checks each
  /// one's Android build files for Google Play services (S4-COMPATIBILITY-01).
  static AndroidPluginScan scanAndroidPlugins(String pluginsDependenciesJson) {
    final decoded = jsonDecode(pluginsDependenciesJson);
    final plugins = decoded is Map<String, Object?> && decoded['plugins'] is Map<String, Object?>
        ? (decoded['plugins']! as Map<String, Object?>)['android']
        : null;
    if (plugins is! List<Object?>) {
      return const AndroidPluginScan([], ['.flutter-plugins-dependencies lists no Android plugin']);
    }
    final readPluginNames = <String>[];
    final problems = <String>[];
    for (final plugin in plugins) {
      if (plugin is! Map<String, Object?> ||
          plugin['name'] is! String ||
          plugin['path'] is! String) {
        problems.add('.flutter-plugins-dependencies has an unreadable Android plugin entry');
        continue;
      }
      final name = plugin['name']! as String;
      final folder = Directory(plugin['path']! as String);
      final buildFiles = [
        for (final relativePath in [
          'android/build.gradle',
          'android/build.gradle.kts',
          'android/src/main/AndroidManifest.xml',
        ])
          File('${folder.path}${Platform.pathSeparator}$relativePath'),
      ].where((file) => file.existsSync()).toList();
      if (buildFiles.isEmpty) continue;
      readPluginNames.add(name);
      for (final file in buildFiles) {
        final match = playServicesReference.firstMatch(file.readAsStringSync());
        if (match != null) {
          problems.add('$name uses Google Play services (${match.group(0)} in ${file.path})');
        }
      }
    }
    return AndroidPluginScan(readPluginNames, problems);
  }

  static List<String> _problemsWithSection(
    Map<String, Object?> pubspec,
    String sectionName,
    Map<String, String> pins,
    Set<String> sdkPackages,
  ) {
    final section = pubspec[sectionName];
    if (section is! Map<String, Object?>) return ['pubspec.yaml has no $sectionName'];
    final problems = <String>[];
    for (final entry in pins.entries) {
      final listed = section[entry.key];
      if (listed != entry.value) {
        problems.add(
          '$sectionName: ${entry.key} is ${listed ?? 'missing'}, not exactly ${entry.value}',
        );
      }
    }
    for (final name in sdkPackages) {
      final listed = section[name];
      if (listed is! Map<String, Object?> || listed['sdk'] != 'flutter') {
        problems.add('$sectionName: $name must come from the Flutter SDK');
      }
    }
    for (final name in section.keys) {
      if (!pins.containsKey(name) && !sdkPackages.contains(name)) {
        problems.add('$sectionName: $name is not one of the pinned packages of §3.3');
      }
    }
    return problems;
  }
}

/// Which Android plugins had build files to read, and what was found in them.
final class AndroidPluginScan {
  const AndroidPluginScan(this.readPluginNames, this.problems);

  final List<String> readPluginNames;
  final List<String> problems;
}
