import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app_configuration.dart';

/// The build's checked settings (design §3.5): the flavour, the API address and the development
/// flags the screens read (error details, the "Send a test error" control, the support number).
///
/// `bootstrap()` provides it with `appConfigurationProvider.overrideWithValue(...)` once the
/// configuration check has accepted the build, because a configuration is only ever made by that
/// check; tests override it the same way. Reading it without that override is a mistake in the
/// app's set-up, not something a listener can cause.
final Provider<AppConfiguration> appConfigurationProvider = Provider<AppConfiguration>(
  (ref) => throw UnimplementedError(
    'Override appConfigurationProvider at start-up with the checked AppConfiguration.',
  ),
  // A failing provider is never rebuilt on its own (S4-D4).
  retry: (retryCount, error) => null,
);
