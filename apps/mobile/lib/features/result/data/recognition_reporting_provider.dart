import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/result/domain/recognition_reporting.dart';

/// The app's [RecognitionReporting]. `lib/app` provides it through `appServiceOverrides`; reading it
/// without that override is a mistake in the app's set-up.
final Provider<RecognitionReporting> recognitionReportingProvider = Provider<RecognitionReporting>(
  (ref) => throw UnimplementedError(
    'Override recognitionReportingProvider at start-up with the app RecognitionReporting.',
  ),
  retry: (retryCount, error) => null,
);
