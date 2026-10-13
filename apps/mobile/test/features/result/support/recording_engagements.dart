import 'package:lookup_listener/features/result/domain/engagement_recording.dart';

/// Records each tap the Result hands over (T54), as (recognition, station, button), in order.
final class RecordingEngagements implements EngagementRecording {
  final List<(String, String, String)> taps = [];

  @override
  Future<void> record({
    required String recognitionId,
    required String stationId,
    required String actionId,
  }) async {
    taps.add((recognitionId, stationId, actionId));
  }
}
