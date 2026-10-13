import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../support/repository_file_locator.dart';
import 'support/android_project_checks.dart';

/// The Android project of design §3.7, §3.14 and §3.20 (S4-D6, S4-D14, S4-D25, S4-D33;
/// S4-SECURITY-02, S4-LINKS-13): read as text, each rule proven able to fail on a planted copy.
void main() {
  String read(String path) => RepositoryFileLocator.mobileAppFile(path).readAsStringSync();

  final buildFile = read('android/app/build.gradle.kts');
  final mainManifest = read('android/app/src/main/AndroidManifest.xml');
  final devicePluginManifest = read(
    'packages/device_services/android/src/main/AndroidManifest.xml',
  );
  final dataExtractionRules = read('android/app/src/main/res/xml/data_extraction_rules.xml');
  final mainNetworkSecurity = read('android/app/src/main/res/xml/network_security_config.xml');
  final developmentNetworkSecurity = read(
    'android/app/src/development/res/xml/network_security_config.xml',
  );
  final settingsFile = read('android/settings.gradle.kts');
  final gradleProperties = read('android/gradle.properties');
  final gradleWrapper = read('android/gradle/wrapper/gradle-wrapper.properties');

  test('minimum SDK 24, and the three flavours with their ids and labels', () {
    expect(AndroidProjectChecks.problemsWithAppBuildFile(buildFile), isEmpty);
  });

  test('native libraries are stored compressed, so each APK split per ABI stays below 15 MB '
      '(P6-PERFORMANCE-02, Q10)', () {
    expect(
      AndroidProjectChecks.problemsWithAppBuildFile(
        buildFile,
      ).where((problem) => problem.contains('native libraries')),
      isEmpty,
    );
  });

  test('the main manifest: exactly INTERNET, RECORD_AUDIO and POST_NOTIFICATIONS, backup and '
      'cleartext off, the button queries, no service', () {
    expect(AndroidProjectChecks.problemsWithMainManifest(mainManifest), isEmpty);
  });

  test('the device_services plugin adds only ACCESS_NETWORK_STATE, and no component', () {
    expect(AndroidProjectChecks.problemsWithDevicePluginManifest(devicePluginManifest), isEmpty);
  });

  test('backup and device transfer exclude everything', () {
    expect(AndroidProjectChecks.problemsWithDataExtractionRules(dataExtractionRules), isEmpty);
  });

  test('cleartext is off in main, with system certificate authorities only', () {
    expect(AndroidProjectChecks.problemsWithMainNetworkSecurity(mainNetworkSecurity), isEmpty);
  });

  test('the development source set allows cleartext only to 10.0.2.2, 127.0.0.1 and localhost', () {
    expect(
      AndroidProjectChecks.problemsWithDevelopmentNetworkSecurity(developmentNetworkSecurity),
      isEmpty,
    );
  });

  test('no other source set adds a permission or allows cleartext', () {
    final sourceFolder = RepositoryFileLocator.mobileAppFolder('android/app/src');
    final sourceSets = <String>[];
    var checkedFileCount = 0;
    final problems = <String>[];
    for (final folder in sourceFolder.listSync().whereType<Directory>()) {
      final sourceSet = folder.path.split(RegExp(r'[\\/]')).last;
      if (sourceSet == 'main') continue;
      sourceSets.add(sourceSet);
      final manifest = File('${folder.path}/AndroidManifest.xml');
      if (manifest.existsSync()) {
        checkedFileCount++;
        problems.addAll(
          AndroidProjectChecks.problemsWithSourceSetManifest(
            sourceSet,
            manifest.readAsStringSync(),
          ),
        );
      }
      final networkSecurity = File('${folder.path}/res/xml/network_security_config.xml');
      if (networkSecurity.existsSync() && sourceSet != 'development') {
        checkedFileCount++;
        problems.addAll(
          AndroidProjectChecks.problemsWithOtherNetworkSecurity(
            sourceSet,
            networkSecurity.readAsStringSync(),
          ),
        );
      }
    }

    expect(sourceSets, containsAll(['debug', 'development', 'profile']));
    expect(checkedFileCount, greaterThanOrEqualTo(2));
    expect(problems, isEmpty);
  });

  test("settings.gradle.kts points the plugins' build scripts at the cached AGP and Kotlin", () {
    expect(AndroidProjectChecks.problemsWithSettingsFile(settingsFile), isEmpty);
  });

  test('gradle.properties caps the memory: 3 GB, two workers, Kotlin in process', () {
    expect(AndroidProjectChecks.problemsWithGradleProperties(gradleProperties), isEmpty);
  });

  test('the Gradle wrapper uses the cached Gradle 8.14', () {
    expect(AndroidProjectChecks.problemsWithGradleWrapper(gradleWrapper), isEmpty);
  });

  group('the checks fail on a planted copy with', () {
    test('minimum SDK 23', () {
      expect(
        AndroidProjectChecks.problemsWithAppBuildFile(
          _planted(buildFile, 'minSdk = 24', 'minSdk = 23'),
        ),
        [contains('minSdk is 23')],
      );
    });

    test('native libraries stored uncompressed', () {
      expect(
        AndroidProjectChecks.problemsWithAppBuildFile(
          _planted(buildFile, 'useLegacyPackaging = true', 'useLegacyPackaging = false'),
        ),
        [contains('native libraries are not stored compressed')],
      );
    });

    test('a missing flavour', () {
      expect(
        AndroidProjectChecks.problemsWithAppBuildFile(
          _planted(buildFile, 'create("staging")', 'create("testing")'),
        ),
        contains(contains('the flavours are development, testing, production')),
      );
    });

    test('a wrong application id or label', () {
      final planted = _planted(
        _planted(buildFile, '".development"', '".dev"'),
        '"Look Up (staging)"',
        '"Look Up staging"',
      );

      expect(AndroidProjectChecks.problemsWithAppBuildFile(planted), [
        contains('development has the id zm.lookup.listener.dev,'),
        contains('staging is labelled Look Up staging'),
      ]);
    });

    test('a Google Play services library in the app build', () {
      expect(
        AndroidProjectChecks.problemsWithAppBuildFile(
          '$buildFile\ndependencies { implementation("com.google.android.gms:play-services-'
          'location:21.3.0") }\n',
        ),
        [contains('Google Play services')],
      );
    });

    test('a third permission, or RECORD_AUDIO missing', () {
      const recordAudio = '<uses-permission android:name="android.permission.RECORD_AUDIO"/>';

      expect(
        AndroidProjectChecks.problemsWithMainManifest(
          _planted(
            mainManifest,
            recordAudio,
            '$recordAudio<uses-permission android:name="android.permission.CAMERA"/>',
          ),
        ),
        [contains('CAMERA')],
      );
      expect(
        AndroidProjectChecks.problemsWithMainManifest(_planted(mainManifest, recordAudio, '')),
        [contains('not exactly INTERNET, RECORD_AUDIO and POST_NOTIFICATIONS')],
      );
    });

    test('a device_services permission other than ACCESS_NETWORK_STATE, or a receiver', () {
      const networkState =
          '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>';

      expect(
        AndroidProjectChecks.problemsWithDevicePluginManifest(
          _planted(
            devicePluginManifest,
            networkState,
            '$networkState<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>',
          ),
        ),
        [contains('ACCESS_FINE_LOCATION')],
      );
      expect(
        AndroidProjectChecks.problemsWithDevicePluginManifest(
          _planted(
            devicePluginManifest,
            '</manifest>',
            '<application><receiver android:name=".Boot"/></application></manifest>',
          ),
        ),
        [contains('declares a receiver')],
      );
    });

    test('backup on, or cleartext on in main', () {
      expect(
        AndroidProjectChecks.problemsWithMainManifest(
          _planted(mainManifest, 'android:allowBackup="false"', 'android:allowBackup="true"'),
        ),
        [contains('android:allowBackup is true')],
      );
      expect(
        AndroidProjectChecks.problemsWithMainManifest(
          _planted(
            mainManifest,
            'android:usesCleartextTraffic="false"',
            'android:usesCleartextTraffic="true"',
          ),
        ),
        [contains('android:usesCleartextTraffic is true')],
      );
    });

    test('a button query missing, or a query no button needs', () {
      expect(
        AndroidProjectChecks.problemsWithMainManifest(
          _planted(mainManifest, 'android.intent.action.DIAL', 'android.intent.action.CALL'),
        ),
        [contains('lacks DIAL tel'), contains('holds CALL tel')],
      );
    });

    test("WorkManager's foreground service or one of its permissions kept", () {
      expect(
        AndroidProjectChecks.problemsWithMainManifest(
          _planted(
            mainManifest,
            '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" '
                'tools:node="remove"/>',
            '',
          ),
        ),
        [contains('does not remove android.permission.FOREGROUND_SERVICE,')],
      );
      expect(
        AndroidProjectChecks.problemsWithMainManifest(
          _planted(
            mainManifest,
            'tools:node="remove"/>\n    </application>',
            '/>\n    </application>',
          ),
        ),
        [
          contains('declares a service'),
          contains('does not remove androidx.work.impl.foreground.SystemForegroundService'),
        ],
      );
    });

    test('a service', () {
      expect(
        AndroidProjectChecks.problemsWithMainManifest(
          _planted(
            mainManifest,
            '</application>',
            '<service android:name=".Recorder"/></application>',
          ),
        ),
        [contains('declares a service')],
      );
    });

    test('another source set that adds a permission or allows cleartext', () {
      expect(
        AndroidProjectChecks.problemsWithSourceSetManifest(
          'staging',
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android">'
              '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>'
              '<application android:usesCleartextTraffic="true"/></manifest>',
        ),
        [contains('adds android.permission.ACCESS_FINE_LOCATION'), contains('allows cleartext')],
      );
      expect(
        AndroidProjectChecks.problemsWithOtherNetworkSecurity(
          'production',
          _planted(
            mainNetworkSecurity,
            'cleartextTrafficPermitted="false"',
            'cleartextTrafficPermitted="true"',
          ),
        ),
        [contains('production network-security configuration allows cleartext')],
      );
    });

    test('a backup domain no longer excluded', () {
      expect(
        AndroidProjectChecks.problemsWithDataExtractionRules(
          _planted(dataExtractionRules, '<exclude domain="sharedpref"/>', ''),
        ),
        [contains('<cloud-backup> does not exclude sharedpref')],
      );
    });

    test('cleartext or user certificates in main', () {
      expect(
        AndroidProjectChecks.problemsWithMainNetworkSecurity(
          _planted(
            mainNetworkSecurity,
            'cleartextTrafficPermitted="false"',
            'cleartextTrafficPermitted="true"',
          ),
        ),
        contains(contains('does not turn cleartext off')),
      );
      expect(
        AndroidProjectChecks.problemsWithMainNetworkSecurity(
          _planted(
            mainNetworkSecurity,
            '<certificates src="system"/>',
            '<certificates src="system"/><certificates src="user"/>',
          ),
        ),
        [contains('trusts system, user')],
      );
    });

    test('cleartext in development to another host, or with its subdomains', () {
      expect(
        AndroidProjectChecks.problemsWithDevelopmentNetworkSecurity(
          _planted(
            developmentNetworkSecurity,
            '<domain includeSubdomains="false">localhost</domain>',
            '<domain includeSubdomains="false">localhost</domain>'
                '<domain includeSubdomains="false">api.example.com</domain>',
          ),
        ),
        [contains('not exactly')],
      );
      expect(
        AndroidProjectChecks.problemsWithDevelopmentNetworkSecurity(
          _planted(
            developmentNetworkSecurity,
            '<domain includeSubdomains="false">10.0.2.2',
            '<domain includeSubdomains="true">10.0.2.2',
          ),
        ),
        [contains('must not include its subdomains')],
      );
    });

    test('a plugin build script not pointed at the cached Android Gradle Plugin', () {
      expect(
        AndroidProjectChecks.problemsWithSettingsFile(
          _planted(settingsFile, 'useVersion("8.11.1")', 'useVersion("8.12.0")'),
        ),
        [contains('com.android.tools.build:gradle is pointed at 8.12.0')],
      );
      expect(
        AndroidProjectChecks.problemsWithSettingsFile(
          _planted(settingsFile, 'gradle.beforeProject', 'gradle.afterProject'),
        ),
        [contains('does not point')],
      );
    });

    test("the template's 8 GB heap, more workers or a Kotlin daemon", () {
      final planted = _planted(
        _planted(
          _planted(gradleProperties, '-Xmx3g', '-Xmx8g'),
          'org.gradle.workers.max=2',
          'org.gradle.workers.max=4',
        ),
        'kotlin.compiler.execution.strategy=in-process',
        'kotlin.compiler.execution.strategy=daemon',
      );

      expect(AndroidProjectChecks.problemsWithGradleProperties(planted), hasLength(3));
    });

    test('another Gradle', () {
      expect(
        AndroidProjectChecks.problemsWithGradleWrapper(
          _planted(gradleWrapper, 'gradle-8.14-', 'gradle-8.13-'),
        ),
        hasLength(1),
      );
    });
  });
}

/// [text] with its one [from] replaced by [to]; fails when [from] is missing, so a planted copy
/// can never silently equal the original.
String _planted(String text, String from, String to) {
  if (!text.contains(from)) throw StateError('The file no longer contains "$from"');
  return text.replaceFirst(from, to);
}
