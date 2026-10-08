/// The app's version as it reports itself to the API: in the install registration (`app_version`)
/// and in crash reports (`appVersion`). A constant rather than a plugin call, so no plugin is
/// needed; a test keeps it equal to pubspec.yaml's `version` and to the contract's pattern
/// (design §3.9).
abstract final class AppVersion {
  /// The same text as `version:` in pubspec.yaml.
  static const String current = '0.1.0+1';
}
