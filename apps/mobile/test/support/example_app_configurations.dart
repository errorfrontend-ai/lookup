import 'package:lookup_listener/core/configuration/app_configuration.dart';

/// Configurations for tests of code that talks to the API, matching the shapes of config/*.json
/// (staging and production as deployment fills them in).
abstract final class ExampleAppConfigurations {
  /// The emulator against the local API, over plain http.
  static AppConfiguration development({bool writesVerboseLogs = false}) => AppConfiguration(
    flavour: AppFlavour.development,
    apiBaseUrl: Uri.parse('http://10.0.2.2:3100/api/v1'),
    writesVerboseLogs: writesVerboseLogs,
  );

  /// A development build over https (the phone through the tunnel).
  static AppConfiguration developmentOverHttps() => AppConfiguration(
    flavour: AppFlavour.development,
    apiBaseUrl: Uri.parse('https://lookup-dev.example.invalid/api/v1'),
  );

  /// Staging and production always name a support number: the start-up check refuses them without
  /// one (S4-D32).
  static AppConfiguration staging() => AppConfiguration(
    flavour: AppFlavour.staging,
    apiBaseUrl: Uri.parse('https://api.staging.lookup.invalid/api/v1'),
    supportWhatsAppNumber: supportWhatsAppNumber,
  );

  static AppConfiguration production() => AppConfiguration(
    flavour: AppFlavour.production,
    apiBaseUrl: Uri.parse('https://api.lookup.invalid/api/v1'),
    supportWhatsAppNumber: supportWhatsAppNumber,
  );

  /// The support number of the staging and production examples.
  static const String supportWhatsAppNumber = '+260971234567';
}

/// A configuration the start-up check would refuse (production or staging over plain http), which
/// [AppConfiguration]'s own constructor cannot make: it stands for a mis-built app, to prove the API
/// client refuses plain http on its own (S4-D25).
class MisbuiltAppConfiguration implements AppConfiguration {
  MisbuiltAppConfiguration({required this.flavour, required String apiBaseUrl})
    : apiBaseUrl = Uri.parse(apiBaseUrl);

  @override
  final AppFlavour flavour;

  @override
  final Uri apiBaseUrl;

  @override
  bool get allowsPlainHttp => false;

  @override
  bool get showsErrorDetails => false;

  @override
  bool get showsDeveloperTools => false;

  /// On, to prove the log still stays silent outside development.
  @override
  bool get writesVerboseLogs => true;

  @override
  String? get supportWhatsAppNumber => null;
}
