import 'app_configuration.dart';

/// The answer of [AppConfiguration.check]: a usable configuration, or the problems that stop the app
/// from starting. Sealed, so start-up has to handle both.
sealed class AppConfigurationResult {
  const AppConfigurationResult();
}

/// Every setting passed its check.
final class AppConfigurationAccepted extends AppConfigurationResult {
  const AppConfigurationAccepted(this.configuration);

  final AppConfiguration configuration;
}

/// At least one setting failed its check: the app shows the set-up screen, makes no request and
/// reports nothing (design §2.11), because none of its settings can be trusted.
final class AppConfigurationRefused extends AppConfigurationResult {
  const AppConfigurationRefused({required this.problems, required this.isDevelopmentBuild});

  /// Every problem found, in a fixed order; never empty.
  final List<ConfigurationProblem> problems;

  /// True only when `LOOKUP_FLAVOUR` and the Gradle flavour (where there is one) both say
  /// development: the one case where the set-up screen may list [problems] for the developer.
  final bool isDevelopmentBuild;
}
