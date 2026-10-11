import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/widgets/set_up_problem_screen.dart';

import '../../support/repository_file_locator.dart';
import '../../support/english_words.dart';

/// A development build for the emulator, as config/development.json sets it up.
const Map<String, String> _developmentDefines = {
  'LOOKUP_FLAVOUR': 'development',
  'LOOKUP_API_BASE_URL': 'http://10.0.2.2:3100/api/v1',
  'LOOKUP_SHOW_ERROR_DETAILS': 'true',
  'LOOKUP_SHOW_DEVELOPER_TOOLS': 'true',
  'LOOKUP_VERBOSE_LOGS': 'true',
};

const Map<String, String> _productionDefines = {
  'LOOKUP_FLAVOUR': 'production',
  'LOOKUP_API_BASE_URL': 'https://api.lookup.invalid/api/v1',
  'LOOKUP_SUPPORT_WHATSAPP_NUMBER': '+260966000001',
};

AppConfiguration _expectAccepted(AppConfigurationResult result) {
  return switch (result) {
    AppConfigurationAccepted(:final configuration) => configuration,
    AppConfigurationRefused(:final problems) => fail(
      'Expected the configuration to be accepted, but it was refused: $problems',
    ),
  };
}

AppConfigurationRefused _expectRefused(AppConfigurationResult result) {
  return switch (result) {
    final AppConfigurationRefused refused => refused,
    AppConfigurationAccepted() => fail(
      'Expected the configuration to be refused, but it was accepted',
    ),
  };
}

List<ConfigurationProblem> _problemsOf(Map<String, String> defines, {String? gradleFlavour}) =>
    _expectRefused(AppConfiguration.check(defines, gradleFlavour: gradleFlavour)).problems;

Map<String, String> _with(Map<String, String> defines, Map<String, String> changes) => {
  ...defines,
  ...changes,
};

void main() {
  group('AppFlavour.fromName', () {
    test('knows exactly the three flavour names', () {
      expect(AppFlavour.fromName('development'), AppFlavour.development);
      expect(AppFlavour.fromName('staging'), AppFlavour.staging);
      expect(AppFlavour.fromName('production'), AppFlavour.production);
      for (final name in ['', 'dev', 'Production', ' production', 'prod']) {
        expect(AppFlavour.fromName(name), isNull, reason: name);
      }
    });
  });

  group('AppConfiguration.check accepts', () {
    test('a development build on plain http with every development flag on', () {
      final configuration = _expectAccepted(
        AppConfiguration.check(_developmentDefines, gradleFlavour: 'development'),
      );
      expect(configuration.flavour, AppFlavour.development);
      expect(configuration.apiBaseUrl, Uri.parse('http://10.0.2.2:3100/api/v1'));
      expect(configuration.showsErrorDetails, isTrue);
      expect(configuration.showsDeveloperTools, isTrue);
      expect(configuration.writesVerboseLogs, isTrue);
      expect(configuration.supportWhatsAppNumber, isNull);
      expect(configuration.allowsPlainHttp, isTrue);
    });

    test('a development build on https (the phone through the tunnel)', () {
      final configuration = _expectAccepted(
        AppConfiguration.check(
          _with(_developmentDefines, {'LOOKUP_API_BASE_URL': 'https://example.ngrok.app/api/v1'}),
          gradleFlavour: 'development',
        ),
      );
      expect(configuration.apiBaseUrl.scheme, 'https');
    });

    test('staging and production on https with a support number and no development flag', () {
      for (final flavour in ['staging', 'production']) {
        final configuration = _expectAccepted(
          AppConfiguration.check(
            _with(_productionDefines, {'LOOKUP_FLAVOUR': flavour}),
            gradleFlavour: flavour,
          ),
        );
        expect(configuration.flavour.name, flavour);
        expect(configuration.supportWhatsAppNumber, '+260966000001');
        expect(configuration.showsErrorDetails, isFalse);
        expect(configuration.showsDeveloperTools, isFalse);
        expect(configuration.writesVerboseLogs, isFalse);
        expect(configuration.allowsPlainHttp, isFalse);
      }
    });

    test('development flags written "false" outside development', () {
      _expectAccepted(
        AppConfiguration.check(
          _with(_productionDefines, {
            'LOOKUP_SHOW_ERROR_DETAILS': 'false',
            'LOOKUP_SHOW_DEVELOPER_TOOLS': 'false',
            'LOOKUP_VERBOSE_LOGS': 'false',
          }),
          gradleFlavour: 'production',
        ),
      );
    });

    test('no Gradle flavour (iOS has none in the MVP): the define alone counts', () {
      _expectAccepted(AppConfiguration.check(_productionDefines, gradleFlavour: null));
    });

    test('an API address on a path below the host, with a port', () {
      final configuration = _expectAccepted(
        AppConfiguration.check(
          _with(_productionDefines, {
            'LOOKUP_API_BASE_URL': 'https://example.com:8443/look-up/api/v1',
          }),
          gradleFlavour: 'production',
        ),
      );
      expect(configuration.apiBaseUrl.port, 8443);
    });

    test('a support WhatsApp number in E.164, Zambian or foreign', () {
      for (final number in ['+260966000001', '+260211123456', '+447911123456']) {
        final configuration = _expectAccepted(
          AppConfiguration.check(
            _with(_productionDefines, {'LOOKUP_SUPPORT_WHATSAPP_NUMBER': number}),
            gradleFlavour: 'production',
          ),
        );
        expect(configuration.supportWhatsAppNumber, number);
      }
    });
  });

  group('AppConfiguration.check refuses (fails closed)', () {
    test('a missing or unknown flavour', () {
      for (final flavour in ['', 'dev', 'Production', 'prod']) {
        expect(
          _problemsOf(_with(_productionDefines, {'LOOKUP_FLAVOUR': flavour})),
          contains(ConfigurationProblem.flavourNotRecognised),
          reason: '"$flavour"',
        );
      }
      expect(_problemsOf({'LOOKUP_API_BASE_URL': 'https://api.lookup.invalid/api/v1'}), [
        ConfigurationProblem.flavourNotRecognised,
      ]);
    });

    test('a Gradle flavour that differs from LOOKUP_FLAVOUR', () {
      expect(_problemsOf(_productionDefines, gradleFlavour: 'development'), [
        ConfigurationProblem.gradleFlavourDiffers,
      ]);
      expect(
        _problemsOf(_developmentDefines, gradleFlavour: 'production'),
        contains(ConfigurationProblem.gradleFlavourDiffers),
      );
    });

    test('a missing API address', () {
      expect(_problemsOf(_with(_productionDefines, {'LOOKUP_API_BASE_URL': ''})), [
        ConfigurationProblem.apiBaseUrlMissing,
      ]);
      expect(_problemsOf({'LOOKUP_FLAVOUR': 'production'}), [
        ConfigurationProblem.apiBaseUrlMissing,
        ConfigurationProblem.supportWhatsAppNumberMissing,
      ]);
    });

    test('a malformed API address', () {
      for (final address in [
        'api.lookup.invalid/api/v1',
        'not an address',
        ' https://api.lookup.invalid/api/v1',
        'https://api.lookup.invalid/api/v1 ',
        'https://api lookup.invalid/api/v1',
        'ftp://api.lookup.invalid/api/v1',
        'https:///api/v1',
        'https://user:password@api.lookup.invalid/api/v1',
        'https://api.lookup.invalid/api/v1?key=value',
        'https://api.lookup.invalid/api/v1?',
        'https://api.lookup.invalid/api/v1#part',
        'https://api.lookup.invalid:port/api/v1',
      ]) {
        expect(_problemsOf(_with(_productionDefines, {'LOOKUP_API_BASE_URL': address})), [
          ConfigurationProblem.apiBaseUrlMalformed,
        ], reason: '"$address"');
      }
    });

    test('an API address that does not end with /api/v1', () {
      for (final address in [
        'https://api.lookup.invalid',
        'https://api.lookup.invalid/',
        'https://api.lookup.invalid/api',
        'https://api.lookup.invalid/api/v1/',
        'https://api.lookup.invalid/api/v2',
        'https://api.lookup.invalid/api/v1/recognize',
      ]) {
        expect(_problemsOf(_with(_productionDefines, {'LOOKUP_API_BASE_URL': address})), [
          ConfigurationProblem.apiBaseUrlNotEndingApiVersion1,
        ], reason: '"$address"');
      }
    });

    test('plain http outside development', () {
      for (final flavour in ['staging', 'production']) {
        expect(
          _problemsOf(
            _with(_productionDefines, {
              'LOOKUP_FLAVOUR': flavour,
              'LOOKUP_API_BASE_URL': 'http://api.lookup.invalid/api/v1',
            }),
            gradleFlavour: flavour,
          ),
          [ConfigurationProblem.apiBaseUrlNotHttps],
          reason: flavour,
        );
      }
    });

    test('plain http when the flavour is unknown (treated like production)', () {
      expect(
        _problemsOf({
          'LOOKUP_FLAVOUR': 'devlopment',
          'LOOKUP_API_BASE_URL': 'http://10.0.2.2:3100/api/v1',
        }),
        [ConfigurationProblem.flavourNotRecognised, ConfigurationProblem.apiBaseUrlNotHttps],
      );
    });

    test('each development-only flag set outside development', () {
      const flags = {
        'LOOKUP_SHOW_ERROR_DETAILS': ConfigurationProblem.errorDetailsOutsideDevelopment,
        'LOOKUP_SHOW_DEVELOPER_TOOLS': ConfigurationProblem.developerToolsOutsideDevelopment,
        'LOOKUP_VERBOSE_LOGS': ConfigurationProblem.verboseLogsOutsideDevelopment,
      };
      for (final flavour in ['staging', 'production']) {
        flags.forEach((define, problem) {
          expect(
            _problemsOf(
              _with(_productionDefines, {'LOOKUP_FLAVOUR': flavour, define: 'true'}),
              gradleFlavour: flavour,
            ),
            [problem],
            reason: '$define in $flavour',
          );
        });
      }
    });

    test('a development flag that is neither true nor false', () {
      const flags = {
        'LOOKUP_SHOW_ERROR_DETAILS': ConfigurationProblem.errorDetailsFlagNotTrueOrFalse,
        'LOOKUP_SHOW_DEVELOPER_TOOLS': ConfigurationProblem.developerToolsFlagNotTrueOrFalse,
        'LOOKUP_VERBOSE_LOGS': ConfigurationProblem.verboseLogsFlagNotTrueOrFalse,
      };
      flags.forEach((define, problem) {
        for (final value in ['yes', 'True', '1', ' true']) {
          expect(
            _problemsOf(_with(_developmentDefines, {define: value}), gradleFlavour: 'development'),
            [problem],
            reason: '$define=$value',
          );
        }
      });
    });

    test('staging or production with no support number, so a code is never shown with a promise '
        'of support that cannot be reached (S4-D32)', () {
      for (final flavour in ['staging', 'production']) {
        for (final number in [null, '']) {
          final defines = _with(_productionDefines, {'LOOKUP_FLAVOUR': flavour});
          if (number == null) {
            defines.remove('LOOKUP_SUPPORT_WHATSAPP_NUMBER');
          } else {
            defines['LOOKUP_SUPPORT_WHATSAPP_NUMBER'] = number;
          }
          expect(
            _problemsOf(defines, gradleFlavour: flavour),
            [ConfigurationProblem.supportWhatsAppNumberMissing],
            reason: '$flavour with ${number == null ? 'no' : 'an empty'} number',
          );
        }
      }
    });

    test('a support number that is not E.164', () {
      for (final number in [
        '0966000001',
        '260966000001',
        '+260 96 600 0001',
        '+26096600000',
        '+2609660000011',
        '+260066000001',
        '+0123456789',
        '+12345',
        '+1234567890123456',
        'support',
      ]) {
        expect(
          _problemsOf(
            _with(_productionDefines, {'LOOKUP_SUPPORT_WHATSAPP_NUMBER': number}),
            gradleFlavour: 'production',
          ),
          [ConfigurationProblem.supportWhatsAppNumberNotE164],
          reason: '"$number"',
        );
      }
    });

    test('collects every problem at once, so one look fixes a build', () {
      expect(
        _problemsOf({
          'LOOKUP_FLAVOUR': 'production',
          'LOOKUP_API_BASE_URL': 'http://10.0.2.2:3100/api',
          'LOOKUP_SHOW_ERROR_DETAILS': 'true',
          'LOOKUP_VERBOSE_LOGS': 'maybe',
          'LOOKUP_SUPPORT_WHATSAPP_NUMBER': '0966000001',
        }, gradleFlavour: 'staging'),
        [
          ConfigurationProblem.gradleFlavourDiffers,
          ConfigurationProblem.apiBaseUrlNotEndingApiVersion1,
          ConfigurationProblem.apiBaseUrlNotHttps,
          ConfigurationProblem.errorDetailsOutsideDevelopment,
          ConfigurationProblem.verboseLogsFlagNotTrueOrFalse,
          ConfigurationProblem.supportWhatsAppNumberNotE164,
        ],
      );
    });

    test('says it is a development build only when both flavours say so', () {
      final brokenAddress = {'LOOKUP_API_BASE_URL': 'not an address'};
      bool isDevelopmentBuild(Map<String, String> defines, String? gradleFlavour) => _expectRefused(
        AppConfiguration.check(defines, gradleFlavour: gradleFlavour),
      ).isDevelopmentBuild;

      expect(isDevelopmentBuild(_with(_developmentDefines, brokenAddress), 'development'), isTrue);
      expect(isDevelopmentBuild(_with(_developmentDefines, brokenAddress), null), isTrue);
      expect(
        isDevelopmentBuild(_developmentDefines, 'production'),
        isFalse,
        reason: 'a production build given development settings',
      );
      expect(isDevelopmentBuild(_with(_productionDefines, brokenAddress), 'production'), isFalse);
    });

    test('the problem list cannot be changed by whoever receives it', () {
      final problems = _problemsOf({});
      expect(() => problems.add(ConfigurationProblem.apiBaseUrlMissing), throwsUnsupportedError);
    });
  });

  test('every problem has a developer description that names no value', () {
    for (final problem in ConfigurationProblem.values) {
      expect(SetUpProblemScreen.describe(problem, englishWords), isNotEmpty);
      expect(SetUpProblemScreen.describe(problem, englishWords), isNot(contains('10.0.2.2')));
    }
  });

  test('a test run, built with no defines, refuses to start', () {
    // `flutter test` passes no --dart-define, so this proves fromEnvironment reads the defines
    // (and Flutter's appFlavor, null here) and checks them, rather than starting with defaults.
    final refused = _expectRefused(AppConfiguration.fromEnvironment());
    expect(refused.problems, [
      ConfigurationProblem.flavourNotRecognised,
      ConfigurationProblem.apiBaseUrlMissing,
    ]);
    expect(refused.isDevelopmentBuild, isFalse);
  });

  group('the config files in apps/mobile/config', () {
    final configFiles =
        RepositoryFileLocator.mobileAppFolder(
            'config',
          ).listSync().whereType<File>().where((file) => file.path.endsWith('.json')).toList()
          ..sort((first, second) => first.path.compareTo(second.path));

    test('exist for every flavour', () {
      final names = configFiles.map((file) => file.uri.pathSegments.last).toList();
      expect(
        names,
        containsAll([
          'development.json',
          'development-fake.json',
          'development-phone.example.json',
          'staging.json',
          'production.json',
        ]),
      );
    });

    for (final file in configFiles) {
      final fileName = file.uri.pathSegments.last;
      final isPlaceholder = !fileName.startsWith('development');
      test(
        isPlaceholder
            ? '$fileName holds only known defines, as text, and cannot start until deployment '
                  'gives it a support number'
            : '$fileName holds only known defines, as text, and passes the check',
        () {
          final decoded = jsonDecode(file.readAsStringSync());
          expect(decoded, isA<Map<String, Object?>>());
          final defines = <String, String>{};
          (decoded as Map<String, Object?>).forEach((name, value) {
            expect(
              AppConfiguration.defineNames,
              contains(name),
              reason: '$fileName: an unknown define is ignored by the app',
            );
            expect(value, isA<String>(), reason: '$fileName: $name');
            defines[name] = value! as String;
          });

          final flavour = defines['LOOKUP_FLAVOUR'];
          expect(
            fileName.startsWith('$flavour'),
            isTrue,
            reason: '$fileName must be named after its flavour',
          );
          // Built with --flavor <flavour>, as the README tells the developer to.
          final result = AppConfiguration.check(defines, gradleFlavour: flavour);
          if (!isPlaceholder) {
            _expectAccepted(result);
            return;
          }
          // Staging and production wait for deployment (P8): the support number is the one thing
          // missing, so such a build shows the set-up screen rather than a promise of support.
          expect(defines['LOOKUP_SUPPORT_WHATSAPP_NUMBER'], isEmpty);
          expect(_expectRefused(result).problems, [
            ConfigurationProblem.supportWhatsAppNumberMissing,
          ]);
          _expectAccepted(
            AppConfiguration.check({
              ...defines,
              'LOOKUP_SUPPORT_WHATSAPP_NUMBER': '+260966000001',
            }, gradleFlavour: flavour),
          );
        },
      );
    }
  });
}
