import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_version.dart';

import '../../support/repository_file_locator.dart';

/// Reads one JSON object out of [parent] by [key], failing the test if it is not there.
Map<String, Object?> _objectAt(Map<String, Object?> parent, String key) {
  final value = parent[key];
  expect(value, isA<Map<String, Object?>>(), reason: key);
  return value! as Map<String, Object?>;
}

Map<String, Object?> _schemaProperty(String schemaFile, String definition, String property) {
  final schema =
      jsonDecode(
            RepositoryFileLocator.file('packages/contracts/schemas/$schemaFile').readAsStringSync(),
          )
          as Map<String, Object?>;
  final properties = _objectAt(_objectAt(_objectAt(schema, r'$defs'), definition), 'properties');
  return _objectAt(properties, property);
}

void main() {
  test('equals the version in pubspec.yaml', () {
    final versionLine = RepositoryFileLocator.mobileAppFile(
      'pubspec.yaml',
    ).readAsLinesSync().singleWhere((line) => line.startsWith('version:'));
    expect(AppVersion.current, versionLine.substring('version:'.length).trim());
  });

  test('passes the install registration contract (app_version pattern)', () {
    final property = _schemaProperty(
      'register-install-input.schema.json',
      'RegisterInstallInput',
      'app_version',
    );
    final pattern = property['pattern'];
    expect(pattern, isA<String>());
    expect(RegExp(pattern! as String).hasMatch(AppVersion.current), isTrue);
  });

  test('fits the crash report contract (appVersion length)', () {
    final property = _schemaProperty(
      'client-error-report.schema.json',
      'ClientErrorReport',
      'appVersion',
    );
    final maximumLength = property['maxLength'];
    expect(maximumLength, isA<int>());
    expect(AppVersion.current.length, lessThanOrEqualTo(maximumLength! as int));
  });
}
