import 'package:flutter/services.dart' show appFlavor;

import 'app_configuration_result.dart';
import 'app_flavour.dart';
import 'configuration_problem.dart';

export 'app_configuration_result.dart';
export 'app_flavour.dart';
export 'configuration_problem.dart';

/// The build's settings, checked once at start-up (design §3.7, S4-D25). They come from
/// `--dart-define-from-file=config/<file>.json`, never from the network, and hold no secret
/// (S4-SECURITY-01). Built only through [check], which fails closed: a build that is set up wrongly
/// shows the set-up screen instead of running with a guess.
class AppConfiguration {
  /// Use [check] in app code; this constructor is for tests, and asserts the rules [check] enforces.
  AppConfiguration({
    required this.flavour,
    required this.apiBaseUrl,
    this.showsErrorDetails = false,
    this.showsDeveloperTools = false,
    this.writesVerboseLogs = false,
    this.supportWhatsAppNumber,
  }) : assert(
         flavour == AppFlavour.development ||
             (apiBaseUrl.scheme == 'https' &&
                 !showsErrorDetails &&
                 !showsDeveloperTools &&
                 !writesVerboseLogs &&
                 supportWhatsAppNumber != null),
         'Plain http and the development flags exist only in development, and staging and '
         'production always have a support number',
       );

  /// The define names, exactly as the config files write them.
  static const String flavourDefine = 'LOOKUP_FLAVOUR';
  static const String apiBaseUrlDefine = 'LOOKUP_API_BASE_URL';
  static const String showErrorDetailsDefine = 'LOOKUP_SHOW_ERROR_DETAILS';
  static const String showDeveloperToolsDefine = 'LOOKUP_SHOW_DEVELOPER_TOOLS';
  static const String verboseLogsDefine = 'LOOKUP_VERBOSE_LOGS';
  static const String supportWhatsAppNumberDefine = 'LOOKUP_SUPPORT_WHATSAPP_NUMBER';

  /// Every define the app reads; a config file key outside this list would be ignored silently.
  static const List<String> defineNames = [
    flavourDefine,
    apiBaseUrlDefine,
    showErrorDetailsDefine,
    showDeveloperToolsDefine,
    verboseLogsDefine,
    supportWhatsAppNumberDefine,
  ];

  /// The path every API address ends with; requests use paths relative to it.
  static const String apiPathEnding = '/api/v1';

  /// Which build this is.
  final AppFlavour flavour;

  /// The API address, ending `/api/v1`; `https` unless [flavour] is development.
  final Uri apiBaseUrl;

  /// Development only: the error screen and the plain fallback show the failure's text.
  final bool showsErrorDetails;

  /// Development only: the "Send a test error" control on Home.
  final bool showsDeveloperTools;

  /// Development only: request lines in the device log.
  final bool writesVerboseLogs;

  /// The support WhatsApp number in E.164 (S4-D32). Staging and production always have one, so the
  /// Error screen's "share this code with support" is always backed by a way to reach support; only
  /// a development build may leave it out, and the support link is then hidden.
  final String? supportWhatsAppNumber;

  /// Plain `http` is refused in Dart outside development, because Dart's HTTP client cannot be
  /// relied on to obey Android's network-security settings (design fact 4).
  bool get allowsPlainHttp => flavour == AppFlavour.development;

  /// Reads the defines this build was compiled with and checks them against Flutter's `appFlavor`
  /// (the Gradle flavour; null on iOS, which has no flavours in the MVP, so only the define counts).
  static AppConfigurationResult fromEnvironment() {
    // Each read is const: String.fromEnvironment is only reliable when evaluated at compile time.
    const defines = {
      flavourDefine: String.fromEnvironment(flavourDefine),
      apiBaseUrlDefine: String.fromEnvironment(apiBaseUrlDefine),
      showErrorDetailsDefine: String.fromEnvironment(showErrorDetailsDefine),
      showDeveloperToolsDefine: String.fromEnvironment(showDeveloperToolsDefine),
      verboseLogsDefine: String.fromEnvironment(verboseLogsDefine),
      supportWhatsAppNumberDefine: String.fromEnvironment(supportWhatsAppNumberDefine),
    };
    return check(defines, gradleFlavour: appFlavor);
  }

  /// Checks raw define values (name → text, as a config file holds them; a missing or empty value
  /// means "not set") and the Gradle flavour. Pure, so every rule is unit-tested. Collects every
  /// problem rather than stopping at the first, so one look fixes a build.
  static AppConfigurationResult check(
    Map<String, String> defines, {
    required String? gradleFlavour,
  }) {
    final problems = <ConfigurationProblem>[];
    String valueOf(String define) => defines[define] ?? '';

    final flavourName = valueOf(flavourDefine);
    final flavour = AppFlavour.fromName(flavourName);
    if (flavour == null) problems.add(ConfigurationProblem.flavourNotRecognised);
    if (gradleFlavour != null && gradleFlavour != flavourName) {
      problems.add(ConfigurationProblem.gradleFlavourDiffers);
    }
    // An unknown flavour is treated like production: nothing loosened.
    final isDevelopment = flavour == AppFlavour.development;

    final apiBaseUrl = _checkApiBaseUrl(
      valueOf(apiBaseUrlDefine),
      isDevelopment: isDevelopment,
      problems: problems,
    );

    bool checkDevelopmentFlag(
      String define, {
      required ConfigurationProblem whenNotTrueOrFalse,
      required ConfigurationProblem whenOutsideDevelopment,
    }) {
      final isOn = switch (valueOf(define)) {
        '' || 'false' => false,
        'true' => true,
        _ => null,
      };
      if (isOn == null) {
        problems.add(whenNotTrueOrFalse);
        return false;
      }
      if (isOn && !isDevelopment) {
        problems.add(whenOutsideDevelopment);
        return false;
      }
      return isOn;
    }

    final showsErrorDetails = checkDevelopmentFlag(
      showErrorDetailsDefine,
      whenNotTrueOrFalse: ConfigurationProblem.errorDetailsFlagNotTrueOrFalse,
      whenOutsideDevelopment: ConfigurationProblem.errorDetailsOutsideDevelopment,
    );
    final showsDeveloperTools = checkDevelopmentFlag(
      showDeveloperToolsDefine,
      whenNotTrueOrFalse: ConfigurationProblem.developerToolsFlagNotTrueOrFalse,
      whenOutsideDevelopment: ConfigurationProblem.developerToolsOutsideDevelopment,
    );
    final writesVerboseLogs = checkDevelopmentFlag(
      verboseLogsDefine,
      whenNotTrueOrFalse: ConfigurationProblem.verboseLogsFlagNotTrueOrFalse,
      whenOutsideDevelopment: ConfigurationProblem.verboseLogsOutsideDevelopment,
    );

    final supportWhatsAppNumber = valueOf(supportWhatsAppNumberDefine);
    if (supportWhatsAppNumber.isEmpty) {
      // The Error screen asks the listener to share a code with support (S4-USABILITY-02): a
      // build for listeners must say how to reach support, like it must say where the API is.
      if (flavour != null && !isDevelopment) {
        problems.add(ConfigurationProblem.supportWhatsAppNumberMissing);
      }
    } else if (!_isPhoneNumberE164(supportWhatsAppNumber)) {
      problems.add(ConfigurationProblem.supportWhatsAppNumberNotE164);
    }

    if (problems.isNotEmpty || flavour == null || apiBaseUrl == null) {
      return AppConfigurationRefused(
        problems: List.unmodifiable(problems),
        isDevelopmentBuild:
            isDevelopment && (gradleFlavour == null || gradleFlavour == flavourName),
      );
    }
    return AppConfigurationAccepted(
      AppConfiguration(
        flavour: flavour,
        apiBaseUrl: apiBaseUrl,
        showsErrorDetails: showsErrorDetails,
        showsDeveloperTools: showsDeveloperTools,
        writesVerboseLogs: writesVerboseLogs,
        supportWhatsAppNumber: supportWhatsAppNumber.isEmpty ? null : supportWhatsAppNumber,
      ),
    );
  }

  /// The address if it is usable, else null with the reasons added to [problems].
  static Uri? _checkApiBaseUrl(
    String value, {
    required bool isDevelopment,
    required List<ConfigurationProblem> problems,
  }) {
    if (value.isEmpty) {
      problems.add(ConfigurationProblem.apiBaseUrlMissing);
      return null;
    }
    final address = _hasWhitespace.hasMatch(value) ? null : Uri.tryParse(value);
    if (address == null ||
        !(address.scheme == 'http' || address.scheme == 'https') ||
        address.host.isEmpty ||
        address.userInfo.isNotEmpty ||
        address.hasQuery ||
        address.hasFragment) {
      problems.add(ConfigurationProblem.apiBaseUrlMalformed);
      return null;
    }
    final problemCountBefore = problems.length;
    if (!address.path.endsWith(apiPathEnding)) {
      problems.add(ConfigurationProblem.apiBaseUrlNotEndingApiVersion1);
    }
    if (address.scheme != 'https' && !isDevelopment) {
      problems.add(ConfigurationProblem.apiBaseUrlNotHttps);
    }
    return problems.length == problemCountBefore ? address : null;
  }

  static final RegExp _hasWhitespace = RegExp(r'\s');

  /// The same E.164 rule as the shared action-card schema (packages/contracts), so the support
  /// number passes the WhatsApp address builder the card buttons use: "+", a country code, 7 to 15
  /// digits in all; a Zambian (+260) number has exactly 9 digits after the code.
  static bool _isPhoneNumberE164(String value) {
    if (!_phoneNumberE164.hasMatch(value)) return false;
    return !value.startsWith('+260') || _zambianPhoneNumberE164.hasMatch(value);
  }

  static final RegExp _phoneNumberE164 = RegExp(r'^\+[1-9][0-9]{6,14}$');
  static final RegExp _zambianPhoneNumberE164 = RegExp(r'^\+260[1-9][0-9]{8}$');
}
