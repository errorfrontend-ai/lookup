import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/result/domain/engagement_recording.dart';

/// The app's [EngagementRecording]. `lib/app` provides it through `appServiceOverrides`; reading it
/// without that override is a mistake in the app's set-up.
final Provider<EngagementRecording> engagementRecordingProvider = Provider<EngagementRecording>(
  (ref) => throw UnimplementedError(
    'Override engagementRecordingProvider at start-up with the app EngagementRecording.',
  ),
  retry: (retryCount, error) => null,
);
