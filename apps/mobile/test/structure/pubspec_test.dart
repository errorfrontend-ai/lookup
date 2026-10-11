import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../support/repository_file_locator.dart';
import 'support/pubspec_checks.dart';
import 'support/simple_yaml_reader.dart';
import 'support/version_constraint.dart';

/// The dependencies of design §3.3 (S4-D3, S4-D33; S4-STACK-01 to -09; S4-COMPATIBILITY-01): the
/// exact pins and nothing else, no BLoC, no fonts, nothing that needs a newer Flutter than the
/// installed 3.41.9, and nothing that needs Google Play services.
void main() {
  final pubspecText = RepositoryFileLocator.mobileAppFile('pubspec.yaml').readAsStringSync();
  final lockText = RepositoryFileLocator.mobileAppFile('pubspec.lock').readAsStringSync();
  final pubspec = SimpleYamlReader.read(pubspecText);
  final lock = SimpleYamlReader.read(lockText);

  test('both files are read', () {
    expect(pubspec['name'], 'lookup_listener');
    expect(pubspec['dependencies'], isA<Map<String, Object?>>());
    expect((lock['packages']! as Map<String, Object?>).length, greaterThan(40));
  });

  test('every dependency is pinned exactly as §3.3 says, and nothing else is listed', () {
    expect(PubspecChecks.problemsWithPins(pubspec), isEmpty);
    expect(PubspecChecks.pinnedDependencies['permission_handler'], '12.0.3');
    expect(PubspecChecks.pinnedDependencies['intl'], '0.20.2');
    expect(PubspecChecks.sdkDependencies, {'flutter', 'flutter_localizations'});
  });

  test('gen-l10n runs on every pub get and build (P6-LOCALISATION-01)', () {
    expect(PubspecChecks.problemsWithGeneration(pubspec), isEmpty);
  });

  test('the lock file resolved each pin to exactly that version', () {
    expect(PubspecChecks.problemsWithLock(lock), isEmpty);
  });

  test('the Flutter and Dart constraints admit the installed 3.41.9 and 3.11.5', () {
    expect(PubspecChecks.problemsWithSdkConstraints(pubspec, lock), isEmpty);
  });

  test('no BLoC and no Google Play services package, listed or resolved', () {
    expect(PubspecChecks.problemsWithForbiddenPackages(pubspec, lock), isEmpty);
  });

  test('no font is declared', () {
    expect(PubspecChecks.problemsWithFonts(pubspec, pubspecText), isEmpty);
  });

  test("no Android plugin's build pulls in Google Play services", () {
    final scan = PubspecChecks.scanAndroidPlugins(
      RepositoryFileLocator.mobileAppFile('.flutter-plugins-dependencies').readAsStringSync(),
    );

    expect(
      scan.readPluginNames,
      containsAll([
        'permission_handler_android',
        'record_android',
        'shared_preferences_android',
        'url_launcher_android',
      ]),
    );
    expect(scan.problems, isEmpty);
  });

  test('version constraints are read as pub reads them', () {
    expect(VersionConstraint.parse('>=3.41.0').allows(PubspecChecks.installedFlutter), isTrue);
    expect(VersionConstraint.parse('>=3.44.0').allows(PubspecChecks.installedFlutter), isFalse);
    expect(VersionConstraint.parse('^3.11.5').allows(PubspecChecks.installedDart), isTrue);
    expect(VersionConstraint.parse('^3.11.5').allows(SemanticVersion.parse('4.0.0')), isFalse);
    expect(VersionConstraint.parse('^0.13.0').allows(SemanticVersion.parse('0.14.0')), isFalse);
    expect(
      VersionConstraint.parse('>=3.11.5 <4.0.0').allows(SemanticVersion.parse('3.12.0-1.0.dev')),
      isTrue,
    );
    expect(VersionConstraint.parse('3.3.2').allows(SemanticVersion.parse('3.3.3')), isFalse);
  });

  group('the checks fail on a planted copy with', () {
    List<String> pinProblems(String from, String to) =>
        PubspecChecks.problemsWithPins(SimpleYamlReader.read(_planted(pubspecText, from, to)));

    test('a caret instead of an exact pin', () {
      expect(pinProblems('dio: 5.11.1', 'dio: ^5.11.1'), [contains('dio is ^5.11.1')]);
    });

    test('an intl other than the one the SDK pins', () {
      expect(pinProblems('intl: 0.20.2', 'intl: ^0.20.2'), [contains('intl is ^0.20.2')]);
    });

    test('flutter_localizations left out', () {
      expect(pinProblems('  flutter_localizations:\n    sdk: flutter\n', ''), [
        contains('flutter_localizations must come from the Flutter SDK'),
      ]);
    });

    test('gen-l10n switched off', () {
      final planted = SimpleYamlReader.read(
        _planted(pubspecText, '  generate: true\n', '  generate: false\n'),
      );

      expect(PubspecChecks.problemsWithGeneration(planted), [contains('generate: true')]);
    });

    test("the plan's permission_handler 13.0.2", () {
      expect(pinProblems('permission_handler: 12.0.3', 'permission_handler: 13.0.2'), [
        contains('permission_handler is 13.0.2'),
      ]);
    });

    test('a package the design does not list', () {
      expect(pinProblems('  path_provider: 2.1.6\n', '  path_provider: 2.1.6\n  uuid: 4.5.1\n'), [
        contains('uuid is not one of the pinned packages'),
      ]);
    });

    test('a dependency override', () {
      expect(
        pinProblems(
          'dev_dependencies:',
          'dependency_overrides:\n  dio: 5.11.1\n\ndev_dependencies:',
        ),
        [contains('dependency_overrides')],
      );
    });

    test('BLoC', () {
      final planted = SimpleYamlReader.read(
        _planted(pubspecText, '  dio: 5.11.1\n', '  dio: 5.11.1\n  flutter_bloc: 9.1.1\n'),
      );

      expect(PubspecChecks.problemsWithForbiddenPackages(planted, lock), [
        contains('flutter_bloc'),
      ]);
    });

    test('a Google Play services package in the lock file', () {
      final planted = SimpleYamlReader.read(
        _planted(
          lockText,
          'packages:\n',
          'packages:\n  google_mobile_ads:\n    version: "5.0.0"\n',
        ),
      );

      expect(PubspecChecks.problemsWithForbiddenPackages(pubspec, planted), [
        contains('google_mobile_ads'),
      ]);
    });

    test('a font family', () {
      final plantedText = _planted(
        pubspecText,
        '  uses-material-design: true\n',
        '  uses-material-design: true\n  fonts:\n    - family: Roboto\n      fonts:\n'
            '        - asset: fonts/Roboto-Regular.ttf\n',
      );

      expect(
        PubspecChecks.problemsWithFonts(SimpleYamlReader.read(plantedText), plantedText),
        hasLength(2),
      );
    });

    test('a Flutter constraint the installed 3.41.9 does not meet', () {
      final planted = SimpleYamlReader.read(
        _planted(pubspecText, 'flutter: ">=3.41.0"', 'flutter: ">=3.44.0"'),
      );

      expect(PubspecChecks.problemsWithSdkConstraints(planted, lock), [
        contains('does not admit 3.41.9'),
      ]);
    });

    test('a lock file that needs a newer Flutter', () {
      final planted = SimpleYamlReader.read(
        _planted(lockText, '  flutter: ">=3.41.0"', '  flutter: ">=3.44.0"'),
      );

      expect(PubspecChecks.problemsWithSdkConstraints(pubspec, planted), [
        contains('pubspec.lock: the flutter constraint'),
      ]);
    });

    test('a lock file that takes flutter_localizations from pub.dev', () {
      final planted = SimpleYamlReader.read(
        _planted(
          lockText,
          '  flutter_localizations:\n    dependency: "direct main"\n    description: flutter\n'
              '    source: sdk\n',
          '  flutter_localizations:\n    dependency: "direct main"\n    description: flutter\n'
              '    source: hosted\n',
        ),
      );

      expect(PubspecChecks.problemsWithLock(planted), [contains('flutter_localizations')]);
    });

    test('a lock file that resolved another version', () {
      final planted = SimpleYamlReader.read(
        _planted(lockText, 'version: "5.11.1"', 'version: "5.12.0"'),
      );

      expect(PubspecChecks.problemsWithLock(planted), [contains('dio to 5.12.0')]);
    });

    test('a plugin that pulls in Google Play services', () {
      final pluginFolder = Directory.systemTemp.createTempSync('lookup_plugin_');
      addTearDown(() => pluginFolder.deleteSync(recursive: true));
      File('${pluginFolder.path}/android/build.gradle')
        ..createSync(recursive: true)
        ..writeAsStringSync(
          "dependencies { implementation 'com.google.android.gms:play-services-location:21.3.0' }",
        );
      final pluginsJson =
          '{"plugins": {"android": [{"name": "planted_location", '
          '"path": "${pluginFolder.path.replaceAll(r'\', r'\\')}"}]}}';

      final scan = PubspecChecks.scanAndroidPlugins(pluginsJson);

      expect(scan.readPluginNames, ['planted_location']);
      expect(scan.problems, [contains('planted_location uses Google Play services')]);
    });
  });
}

/// [text] with its one [from] replaced by [to]; fails when [from] is missing, so a planted copy
/// can never silently equal the original.
String _planted(String text, String from, String to) {
  if (!text.contains(from)) throw StateError('The file no longer contains "$from"');
  return text.replaceFirst(from, to);
}
